import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assessLicense, type LicenseObservation } from "../src/lib/assessment/license";
import { classifyRepository } from "../src/lib/assessment/classify";
import { assessRepositoryQuality } from "../src/lib/assessment/quality";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";

const USAGE = `Usage:
  bun run assess -- --dry-run
  bun run assess -- --execute --max-repositories 5
  bun run assess -- --execute --resume --max-repositories 5

Assessment is serial and bounded. Dry-run is the default; writes require --execute.`;
const MAX_REPOSITORIES = 100;
const LEASE_SECONDS = 900;
const DATABASE_TIMEOUT_MS = 30_000;
const POLICY_VERSION = "m1-04-assessment-v1";

export interface AssessmentArguments { mode: "dry-run" | "execute"; resume: boolean; maxRepositories: number; help: boolean }
type DbError = { message: string; code?: string; status?: number };
type DbResult = { data: unknown; error: DbError | null };
interface QueryBuilder extends PromiseLike<DbResult> {
  select(columns: string): QueryBuilder;
  eq(column: string, value: string | number | boolean): QueryBuilder;
  in(column: string, values: string[]): QueryBuilder;
  order(column: string, options?: { ascending?: boolean }): QueryBuilder;
  limit(count: number): QueryBuilder;
}
interface AssessmentDatabase {
  rpc(name: string, args: Record<string, unknown>): Promise<DbResult>;
  from(table: string): QueryBuilder;
}
export interface AssessmentCliDependencies {
  supabase?: AssessmentDatabase;
  pipelineRunId?: string;
  /** Set only by the guarded assessment recovery CLI. */
  recoveryJobId?: string;
  signal?: AbortSignal;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  now?: () => Date;
}
type Claim = { assessment_id: string; repository_id: string; provider_repository_id: string; lease_token: string };

const repositorySchema = z.object({
  id: z.string().uuid(), provider: z.literal("github"), provider_repository_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  owner_login: z.string().min(1).max(39), repository_name: z.string().min(1).max(100),
  full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/), canonical_url: z.url({ protocol: /^https$/ }),
  description: z.string().nullable(), primary_language: z.string().nullable(), stars: z.number().int().nonnegative(), forks: z.number().int().nonnegative(),
  is_archived: z.boolean(), is_fork: z.boolean(), is_disabled: z.boolean().nullable(), is_private: z.boolean().nullable(), visibility: z.string().nullable(),
  provider_created_at: z.iso.datetime({ offset: true }).nullable(), provider_updated_at: z.iso.datetime({ offset: true }).nullable(), provider_pushed_at: z.iso.datetime({ offset: true }).nullable(),
  availability_status: z.string(), source_observed_at: z.iso.datetime({ offset: true }).nullable(), last_successful_sync_at: z.iso.datetime({ offset: true }).nullable(),
  source_license_metadata: z.record(z.string(), z.unknown()).nullable(), source_field_states: z.record(z.string(), z.unknown()),
});
const topicSchema = z.object({ source_topic: z.string().min(1).max(100), source_record_id: z.string().uuid().nullable() });
const languageSchema = z.object({ language_name: z.string().min(1).max(100), bytes: z.number().int().nonnegative(), source_record_id: z.string().uuid().nullable() });
const releaseSchema = z.object({ id: z.string().uuid(), is_draft: z.boolean(), is_prerelease: z.boolean(), source_record_id: z.string().uuid().nullable() });
const sourceSchema = z.object({ id: z.string().uuid(), record_kind: z.enum(["repository", "languages", "topics", "releases"]), fetched_at: z.iso.datetime({ offset: true }), http_status: z.literal(200), source_metadata: z.record(z.string(), z.unknown()) });
const categorySchema = z.object({ id: z.string().uuid(), slug: z.string(), name: z.string(), is_active: z.boolean() });

function parseRow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.map((part) => String(part).replace(/[^a-zA-Z0-9_-]/g, "")).join(".") || "unknown";
    throw new AssessmentOperationalError("source_validation", message, `${path}:${issue?.code ?? "invalid"}`);
  }
  return result.data;
}

class AssessmentOperationalError extends Error {
  constructor(readonly stage: string, message: string, readonly code?: string) { super(message); this.name = "AssessmentOperationalError"; }
}

type AssessmentOutcomeClass = "completed" | "retryable_failure" | "expired_lease"
  | "stale_worker_ownership" | "interrupted_process" | "database_operation_failure" | "permanent_failure";

function safeDatabaseCode(code: unknown): string | undefined {
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

function databaseOutcome(code: string | undefined): AssessmentOutcomeClass {
  if (code === "40001") return "stale_worker_ownership";
  if (code === "55P03") return "retryable_failure";
  return "database_operation_failure";
}

export function parseAssessmentArguments(args: string[]): AssessmentArguments {
  let mode: AssessmentArguments["mode"] = "dry-run";
  let selectedMode: AssessmentArguments["mode"] | undefined;
  let resume = false; let maxRepositories = 5; let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--dry-run" || arg === "--execute") {
      const next = arg === "--execute" ? "execute" : "dry-run";
      if (selectedMode && selectedMode !== next) throw new TypeError("Choose either --dry-run or --execute.");
      selectedMode = next; mode = next;
    } else if (arg === "--resume") resume = true;
    else if (arg === "--max-repositories") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !/^\d+$/.test(value)) throw new TypeError("--max-repositories requires a whole number.");
      maxRepositories = Number(value);
      if (!Number.isInteger(maxRepositories) || maxRepositories < 1 || maxRepositories > MAX_REPOSITORIES) throw new TypeError(`--max-repositories must be from 1 to ${MAX_REPOSITORIES}.`);
      index += 1;
    } else throw new TypeError("Unknown assessment option.");
  }
  if (resume && mode !== "execute") throw new TypeError("--resume requires --execute.");
  return { mode, resume, maxRepositories, help };
}

export async function runAssessmentCli(args: string[], dependencies: AssessmentCliDependencies = {}): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((line: string) => process.stdout.write(line));
  const stderr = dependencies.writeStderr ?? ((line: string) => process.stderr.write(line));
  let parsed: AssessmentArguments;
  try { parsed = parseAssessmentArguments(args); }
  catch {
    stderr(`${JSON.stringify({ event: "failure", stage: "arguments", message: "Invalid assessment arguments." })}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) { stdout(`${USAGE}\n`); return 0; }
  if (parsed.mode === "dry-run") {
    stdout(`${JSON.stringify({ event: "assessment_plan", mode: "dry-run", limits: { max_repositories: parsed.maxRepositories, concurrency: 1 }, eligibility: "GitHub repository with current public canonical metadata, fully successful enrichment, and no rejected or discarded candidate.", partial_enrichment: "Excluded until a complete enrichment succeeds; unavailable resources are never treated as complete." }, null, 2)}\n`);
    return 0;
  }

  let supabase: AssessmentDatabase;
  try { supabase = dependencies.supabase ?? createSupabaseAdminClient({ requestTimeoutMs: DATABASE_TIMEOUT_MS }) as unknown as AssessmentDatabase; }
  catch { stderr(`${JSON.stringify({ event: "failure", stage: "database_configuration", message: "Server-only Supabase configuration is unavailable." })}\n`); return 1; }
  const workerId = `assess-${process.pid}-${randomUUID()}`;
  const counts = { assessed: 0, drafted: 0, queued_for_review: 0, skipped: 0, retried: 0, failed: 0 };
  const outcomeCounts: Record<AssessmentOutcomeClass, number> = {
    completed: 0, retryable_failure: 0, expired_lease: 0, stale_worker_ownership: 0,
    interrupted_process: 0, database_operation_failure: 0, permanent_failure: 0,
  };
  const failureClasses = new Set<AssessmentOutcomeClass>();
  let claimedCount = 0;
  let stage = "job_start";
  let jobId: string | null = null;
  let recoveryPreflight: Record<string, number> | null = null;
  let primaryFailure: { stage: string; outcome: AssessmentOutcomeClass; code?: string } | null = null;
  const finalization: { attempted: boolean; ok: boolean; status: string | null; openAssessments: number | null } = {
    attempted: false, ok: false, status: null, openAssessments: null,
  };
  const now = dependencies.now ?? (() => new Date());
  const invoke = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    let result: DbResult;
    try { result = await supabase.rpc(name, args); }
    catch { throw new AssessmentOperationalError(stage, "Database operation failed."); }
    if (result.error) throw new AssessmentOperationalError(stage, "Database operation failed.", safeDatabaseCode(result.error.code));
    return result.data;
  };
  try {
    if (parsed.mode !== "execute" || (dependencies.recoveryJobId && (!parsed.resume || parsed.maxRepositories > 4))) {
      throw new AssessmentOperationalError("arguments", "Assessment recovery requires execute, resume, and a four-item maximum.");
    }
    if (dependencies.signal?.aborted) throw new AssessmentOperationalError("interrupted", "Assessment worker was interrupted.");
    if (dependencies.recoveryJobId) {
      stage = "recovery_preflight";
      jobId = dependencies.recoveryJobId;
      const recovered = await invoke("begin_github_repository_assessment_recovery", {
        p_job_id: jobId, p_worker_id: workerId, p_max_assessments: 4,
      });
      const result = recovered as { job_id?: unknown; status?: unknown; open_assessments?: unknown; queued_assessments?: unknown; retry_wait_assessments?: unknown; expired_processing_assessments?: unknown } | null;
      if (!result || result.job_id !== jobId || result.status !== "running") {
        throw new AssessmentOperationalError(stage, "Database did not confirm the requested assessment job.");
      }
      recoveryPreflight = {
        open_assessments: Number(result.open_assessments ?? 0),
        queued_assessments: Number(result.queued_assessments ?? 0),
        retry_wait_assessments: Number(result.retry_wait_assessments ?? 0),
        expired_processing_assessments: Number(result.expired_processing_assessments ?? 0),
      };
    } else {
      const started = await invoke("start_github_repository_assessment_job", {
        p_resume: parsed.resume, p_metadata: { worker_id: workerId, policy_version: POLICY_VERSION,
          ...(dependencies.pipelineRunId ? { pipeline_run_id: dependencies.pipelineRunId } : {}) },
      });
      if (typeof started !== "string") throw new AssessmentOperationalError(stage, "Database returned an invalid job identifier.");
      jobId = started;
    }
    if (dependencies.pipelineRunId && !dependencies.recoveryJobId) {
      stage = "job_run_tag";
      await invoke("tag_pipeline_ingestion_job", { p_job_id: jobId, p_run_id: dependencies.pipelineRunId });
    }
    stdout(`${JSON.stringify({ event: dependencies.recoveryJobId ? "assessment_recovery_started" : "job_started", job_id: jobId, worker_id: workerId, resume: parsed.resume })}\n`);
    const categoryResult = await supabase.from("categories").select("id,slug,name,is_active").eq("is_active", true).limit(100);
    if (categoryResult.error || !Array.isArray(categoryResult.data)) throw new AssessmentOperationalError("category_load", "Could not load the approved category taxonomy.");
    const categories = categoryResult.data.map((row) => parseRow(categorySchema, row, "Category taxonomy did not validate."));

    while (claimedCount < parsed.maxRepositories) {
      if (dependencies.signal?.aborted) {
        primaryFailure = { stage: "interrupted", outcome: "interrupted_process" };
        failureClasses.add("interrupted_process");
        break;
      }
      stage = "claim";
      const rawClaims = await invoke(dependencies.recoveryJobId
        ? "claim_github_repository_assessments_for_recovery"
        : "claim_github_repository_assessments", { p_job_id: jobId, p_worker_id: workerId, p_limit: 1, p_lease_seconds: LEASE_SECONDS });
      const claim = Array.isArray(rawClaims) ? rawClaims[0] as Claim | undefined : undefined;
      if (dependencies.signal?.aborted && !claim) {
        primaryFailure = { stage: "interrupted", outcome: "interrupted_process" };
        failureClasses.add("interrupted_process");
        break;
      }
      if (!claim) break;
      claimedCount += 1;
      try {
        stage = "repository_load";
        const repositoryResult = await supabase.from("repositories").select("id,provider,provider_repository_id,owner_login,repository_name,full_name,canonical_url,description,primary_language,stars,forks,is_archived,is_fork,is_disabled,is_private,visibility,provider_created_at,provider_updated_at,provider_pushed_at,availability_status,source_observed_at,last_successful_sync_at,source_license_metadata,source_field_states").eq("id", claim.repository_id).limit(1);
        if (repositoryResult.error || !Array.isArray(repositoryResult.data) || repositoryResult.data.length !== 1) throw new AssessmentOperationalError(stage, "Canonical repository metadata is unavailable.");
        const repository = parseRow(repositorySchema, repositoryResult.data[0], "Canonical repository metadata did not validate.");
        if (repository.provider_repository_id !== claim.provider_repository_id || repository.full_name !== `${repository.owner_login}/${repository.repository_name}`) throw new AssessmentOperationalError(stage, "Canonical repository identity is inconsistent.");

        const [topicsResult, languagesResult, releasesResult, sourcesResult] = await Promise.all([
          supabase.from("repository_topics").select("source_topic,source_record_id").eq("repository_id", repository.id).order("source_topic").limit(100),
          supabase.from("repository_languages").select("language_name,bytes,source_record_id").eq("repository_id", repository.id).order("bytes", { ascending: false }).order("language_name").limit(100),
          supabase.from("releases").select("id,is_draft,is_prerelease,source_record_id").eq("repository_id", repository.id).limit(100),
          supabase.from("source_records").select("id,record_kind,fetched_at,http_status,source_metadata").eq("repository_id", repository.id).eq("http_status", 200).in("record_kind", ["repository", "languages", "topics", "releases"]).order("fetched_at", { ascending: false }).limit(32),
        ]);
        if ([topicsResult, languagesResult, releasesResult, sourcesResult].some((result) => result.error || !Array.isArray(result.data))) throw new AssessmentOperationalError("source_load", "Enrichment source observations could not be loaded.");
        const topics = (topicsResult.data as unknown[]).map((row) => parseRow(topicSchema, row, "Topic evidence did not validate."));
        const languages = (languagesResult.data as unknown[]).map((row) => parseRow(languageSchema, row, "Language evidence did not validate."));
        const releases = (releasesResult.data as unknown[]).map((row) => parseRow(releaseSchema, row, "Release evidence did not validate."));
        const sources = (sourcesResult.data as unknown[]).map((row) => parseRow(sourceSchema, row, "Source provenance did not validate."));
        const validatedSources = sources.filter((source) => source.source_metadata.validated === true);
        const sourceRecordIds = [...new Set([
          ...validatedSources.filter((source) => source.record_kind === "repository").slice(0, 1).map((source) => source.id),
          ...topics.map((row) => row.source_record_id), ...languages.map((row) => row.source_record_id),
          ...releases.map((row) => row.source_record_id),
          ...validatedSources.filter((source) => ["languages", "topics", "releases"].includes(source.record_kind)).slice(0, 8).map((source) => source.id),
        ].filter((id): id is string => Boolean(id)))].sort().slice(0, 32);
        if (!sourceRecordIds.length) throw new AssessmentOperationalError("source_load", "No successful source provenance was available.");

        const descriptionState = z.enum(["present", "null", "absent", "unavailable", "unsupported", "rejected"])
          .catch("unavailable").parse(repository.source_field_states.description);
        const classification = classifyRepository({
          name: repository.repository_name, description: repository.description, descriptionState,
          topics: topics.map((topic) => topic.source_topic), topicsComplete: true,
          primaryLanguage: repository.primary_language,
          languages: languages.map((language) => ({ name: language.language_name, bytes: language.bytes })), categories,
        });
        const licenseValue = repository.source_license_metadata?.spdx_id;
        const rawLicense = typeof licenseValue === "string" ? licenseValue : null;
        const licenseFieldState = typeof repository.source_field_states.license === "string" ? repository.source_field_states.license : "unavailable";
        const licenseState: LicenseObservation["state"] = rawLicense ? "present" : licenseFieldState === "null" ? "null" : licenseFieldState === "absent" ? "absent" : "unavailable";
        const coreSource = validatedSources.find((source) => source.record_kind === "repository");
        const license = assessLicense([{
          value: rawLicense, state: licenseState, method: "repository_metadata",
          observedAt: repository.source_observed_at, sourceRecordId: coreSource?.id ?? null,
        }]);
        const now = (dependencies.now ?? (() => new Date()))().toISOString();
        const quality = assessRepositoryQuality({
          provider: "github", providerRepositoryId: repository.provider_repository_id, fullName: repository.full_name,
          canonicalUrl: repository.canonical_url, availabilityStatus: repository.availability_status as "available",
          visibility: repository.visibility, isPrivate: repository.is_private, isDisabled: repository.is_disabled,
          isArchived: repository.is_archived, isFork: repository.is_fork, description: repository.description,
          descriptionState, providerCreatedAt: repository.provider_created_at, providerUpdatedAt: repository.provider_updated_at,
          providerPushedAt: repository.provider_pushed_at, observedAt: repository.source_observed_at,
          enrichedAt: repository.last_successful_sync_at, enrichmentComplete: true,
          releaseCount: releases.filter((release) => !release.is_draft && !release.is_prerelease).length,
          stars: repository.stars, forks: repository.forks, licenseStatus: license.status, now,
        });
        const result = {
          policyVersion: POLICY_VERSION, assessmentTimestamp: now,
          classification, license, quality,
          sourceFreshness: {
            repositoryObservedAt: repository.source_observed_at,
            enrichmentCompletedAt: repository.last_successful_sync_at,
            sourceRecordIds,
            spdxLicenseListVersion: license.spdxListVersion,
          },
        };
        if (dependencies.signal?.aborted) throw new AssessmentOperationalError("interrupted", "Assessment worker was interrupted.");
        stage = "complete";
        const completed = await invoke("complete_github_repository_assessment", {
          p_assessment_id: claim.assessment_id, p_worker_id: workerId, p_lease_token: claim.lease_token,
          p_result: result, p_source_record_ids: sourceRecordIds,
        });
        const outcome = completed as { status?: string; drafted?: boolean; review_queue_id?: string | null };
        if (outcome.status === "assessed" || outcome.status === "needs_review") { counts.assessed += 1; outcomeCounts.completed += 1; }
        if (outcome.review_queue_id) counts.queued_for_review += 1;
        else if (outcome.status === "skipped") counts.skipped += 1;
        if (outcome.drafted) counts.drafted += 1;
      } catch (error) {
        const operational = error instanceof AssessmentOperationalError ? error : new AssessmentOperationalError(stage, "Assessment failed.");
        let failureClass: AssessmentOutcomeClass = dependencies.signal?.aborted || operational.stage === "interrupted"
          ? "interrupted_process" : operational.code ? databaseOutcome(operational.code) : "retryable_failure";
        let disposition: "retry_wait" | "failed" | "unresolved" = "unresolved";
        let persistedStatus: string | null = null;
        if (operational.code === "40001") {
          const inspection = await inspectLeaseState(supabase, claim, workerId, now);
          failureClass = inspection.outcome;
          persistedStatus = inspection.status;
        }
        if (persistedStatus && failureClass !== "expired_lease" && failureClass !== "stale_worker_ownership"
          && failureClass !== "database_operation_failure") {
          applyPersistedStatus(persistedStatus, counts);
          outcomeCounts[failureClass] += 1;
          if (failureClass !== "completed") failureClasses.add(failureClass);
          disposition = persistedStatus === "retry_wait" ? "retry_wait" : persistedStatus === "failed" ? "failed" : "unresolved";
        } else if (failureClass === "expired_lease" || failureClass === "stale_worker_ownership") {
          outcomeCounts[failureClass] += 1;
          failureClasses.add(failureClass);
        } else {
          try {
            const failedResult = await invoke("fail_github_repository_assessment", {
              p_assessment_id: claim.assessment_id, p_worker_id: workerId, p_lease_token: claim.lease_token,
              p_error_summary: operational.stage === "interrupted" ? "worker_interrupted" : `${operational.stage}_failed`,
              p_retryable: operational.stage !== "source_validation", p_retry_after_ms: null,
            }) as { status?: string };
            if (failedResult.status === "retry_wait") { counts.retried += 1; disposition = "retry_wait"; }
            else { counts.failed += 1; disposition = "failed"; }
            failureClass = failedResult.status === "retry_wait" ? "retryable_failure" : "permanent_failure";
            outcomeCounts[failureClass] += 1;
            failureClasses.add(failureClass);
          } catch (failError) {
            const failOperational = failError instanceof AssessmentOperationalError
              ? failError : new AssessmentOperationalError("failure_record", "Database operation failed.");
            if (failOperational.code === "40001") {
              const inspection = await inspectLeaseState(supabase, claim, workerId, now);
              failureClass = inspection.outcome;
              persistedStatus = inspection.status;
            } else failureClass = databaseOutcome(failOperational.code);
            if (persistedStatus && failureClass !== "expired_lease" && failureClass !== "stale_worker_ownership"
              && failureClass !== "database_operation_failure") {
              applyPersistedStatus(persistedStatus, counts);
              disposition = persistedStatus === "retry_wait" ? "retry_wait" : persistedStatus === "failed" ? "failed" : "unresolved";
            }
            outcomeCounts[failureClass] += 1;
            if (failureClass !== "completed") failureClasses.add(failureClass);
          }
        }
        if (operational.code && !["40001", "55P03"].includes(operational.code)
          && failureClass !== "database_operation_failure" && failureClass !== "completed") {
          outcomeCounts.database_operation_failure += 1;
          failureClasses.add("database_operation_failure");
        }
        stderr(`${JSON.stringify({ event: failureClass === "completed" ? "assessment_item_recovered" : "assessment_item_failure", assessment_id: claim.assessment_id,
          stage: operational.stage, code: operational.code, failure_class: failureClass, disposition,
          message: failureClass === "completed"
            ? "Persisted completion was verified after the database response failed."
            : "Assessment could not be completed; source details were omitted." })}\n`);
        if (failureClass === "expired_lease" || failureClass === "stale_worker_ownership"
          || failureClass === "database_operation_failure" || failureClass === "interrupted_process") {
          primaryFailure ??= { stage: operational.stage, outcome: failureClass, ...(operational.code ? { code: operational.code } : {}) };
          if (failureClass === "interrupted_process") break;
        }
      }
    }
  } catch (error) {
    const operational = error instanceof AssessmentOperationalError ? error : new AssessmentOperationalError(stage, "Assessment job failed.");
    const outcome: AssessmentOutcomeClass = dependencies.signal?.aborted || operational.stage === "interrupted"
      ? "interrupted_process" : databaseOutcome(operational.code);
    primaryFailure = { stage: operational.stage, outcome, ...(operational.code ? { code: operational.code } : {}) };
    outcomeCounts[outcome] += 1;
    failureClasses.add(outcome);
  }

  if (jobId) {
    stage = "job_finish";
    finalization.attempted = true;
    try {
      const finished = await invoke(dependencies.recoveryJobId
        ? "finish_github_repository_assessment_recovery"
        : "finish_github_repository_assessment_job", dependencies.recoveryJobId
        ? { p_job_id: jobId, p_worker_id: workerId } : { p_job_id: jobId }) as { status?: string; job_status?: string; open_assessments?: number };
      finalization.status = finished.job_status ?? finished.status ?? null;
      finalization.openAssessments = typeof finished.open_assessments === "number" ? finished.open_assessments : null;
      finalization.ok = finalization.status === "succeeded" || finalization.status === "partial";
      if (finished.status === "lease_active") {
        primaryFailure ??= { stage: "job_finish", outcome: "retryable_failure" };
        failureClasses.add("retryable_failure");
      }
    } catch (error) {
      const operational = error instanceof AssessmentOperationalError ? error : new AssessmentOperationalError("job_finish", "Database operation failed.");
      const outcome: AssessmentOutcomeClass = databaseOutcome(operational.code);
      primaryFailure ??= { stage: "job_finish", outcome, ...(operational.code ? { code: operational.code } : {}) };
      outcomeCounts[outcome] += 1;
      failureClasses.add(outcome);
    }
  }

  const outcomeClass = primaryFailure?.outcome ?? (failureClasses.size
    ? priorityOutcome(failureClasses) : finalization.status === "succeeded" ? "completed" : "retryable_failure");
  const summary = {
    event: dependencies.recoveryJobId ? "assessment_recovery_summary" : "assessment_summary",
    job_id: jobId, outcome_class: outcomeClass, failure_classes: [...failureClasses],
    failure_stage: primaryFailure?.stage ?? null, failure_code: primaryFailure?.code ?? null,
    recovery_preflight: recoveryPreflight,
    job_status: finalization.status, finalization: { ...finalization },
    limits: { max_assessments: dependencies.recoveryJobId ? 4 : parsed.maxRepositories, concurrency: 1 },
    outcomes: outcomeCounts, ...counts, source_details_omitted: true,
    automatic_publication: false, automatic_logo_approval: false,
  };
  stdout(`${JSON.stringify(summary)}\n`);
  return outcomeClass === "completed" && finalization.ok && counts.failed === 0 && counts.retried === 0 ? 0 : 1;
}

async function inspectLeaseState(
  supabase: AssessmentDatabase,
  claim: Claim,
  workerId: string,
  now: () => Date,
): Promise<{ outcome: AssessmentOutcomeClass; status: string | null }> {
  let result: DbResult;
  try {
    result = await supabase.from("repository_assessments").select("status,lock_owner,lease_token,lease_expires_at")
      .eq("id", claim.assessment_id).limit(1);
  } catch { return { outcome: "database_operation_failure", status: null }; }
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1) return { outcome: "database_operation_failure", status: null };
  const row = result.data[0] as Record<string, unknown>;
  const status = typeof row.status === "string" ? row.status : null;
  if (status === "assessed" || status === "needs_review" || status === "skipped") return { outcome: "completed", status };
  if (status === "retry_wait") return { outcome: "retryable_failure", status };
  if (status === "failed") return { outcome: "permanent_failure", status };
  if (status === "processing" && typeof row.lease_expires_at === "string"
    && Date.parse(row.lease_expires_at) <= now().getTime()) return { outcome: "expired_lease", status };
  if (row.status !== "processing" || row.lock_owner !== workerId || row.lease_token !== claim.lease_token) {
    return { outcome: "stale_worker_ownership", status };
  }
  return { outcome: "database_operation_failure", status };
}

function applyPersistedStatus(
  status: string,
  counts: { assessed: number; drafted: number; queued_for_review: number; skipped: number; retried: number; failed: number },
) {
  if (status === "assessed" || status === "needs_review") counts.assessed += 1;
  else if (status === "skipped") counts.skipped += 1;
  else if (status === "retry_wait") counts.retried += 1;
  else if (status === "failed") counts.failed += 1;
}

function priorityOutcome(classes: Set<AssessmentOutcomeClass>): AssessmentOutcomeClass {
  for (const outcome of ["database_operation_failure", "expired_lease", "stale_worker_ownership", "interrupted_process", "retryable_failure", "permanent_failure"] as const) {
    if (classes.has(outcome)) return outcome;
  }
  return "completed";
}

export async function runAssessmentProcess(args: string[], dependencies: AssessmentCliDependencies = {}): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    return await runAssessmentCli(args, { ...dependencies, signal: controller.signal });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (import.meta.main) process.exitCode = await runAssessmentProcess(process.argv.slice(2));
