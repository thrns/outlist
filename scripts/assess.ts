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
  try { supabase = dependencies.supabase ?? createSupabaseAdminClient() as unknown as AssessmentDatabase; }
  catch { stderr(`${JSON.stringify({ event: "failure", stage: "database_configuration", message: "Server-only Supabase configuration is unavailable." })}\n`); return 1; }
  const workerId = `assess-${process.pid}-${randomUUID()}`;
  const counts = { assessed: 0, drafted: 0, queued_for_review: 0, skipped: 0, retried: 0, failed: 0 };
  let claimedCount = 0;
  let stage = "job_start";
  let jobId: string;
  const invoke = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    let result: DbResult;
    try { result = await supabase.rpc(name, args); } catch { throw new AssessmentOperationalError(stage, "Database operation failed."); }
    if (result.error) throw new AssessmentOperationalError(stage, "Database operation failed.", result.error.code);
    return result.data;
  };
  try {
    const started = await invoke("start_github_repository_assessment_job", {
      p_resume: parsed.resume, p_metadata: { worker_id: workerId, policy_version: POLICY_VERSION,
        ...(dependencies.pipelineRunId ? { pipeline_run_id: dependencies.pipelineRunId } : {}) },
    });
    if (typeof started !== "string") throw new AssessmentOperationalError(stage, "Database returned an invalid job identifier.");
    jobId = started;
    if (dependencies.pipelineRunId) {
      stage = "job_run_tag";
      await invoke("tag_pipeline_ingestion_job", { p_job_id: jobId, p_run_id: dependencies.pipelineRunId });
    }
    stdout(`${JSON.stringify({ event: "job_started", job_id: jobId, worker_id: workerId, resume: parsed.resume })}\n`);
    const categoryResult = await supabase.from("categories").select("id,slug,name,is_active").eq("is_active", true).limit(100);
    if (categoryResult.error || !Array.isArray(categoryResult.data)) throw new AssessmentOperationalError("category_load", "Could not load the approved category taxonomy.");
    const categories = categoryResult.data.map((row) => parseRow(categorySchema, row, "Category taxonomy did not validate."));

    while (claimedCount < parsed.maxRepositories) {
      stage = "claim";
      const rawClaims = await invoke("claim_github_repository_assessments", { p_job_id: jobId, p_worker_id: workerId, p_limit: 1, p_lease_seconds: LEASE_SECONDS });
      const claim = Array.isArray(rawClaims) ? rawClaims[0] as Claim | undefined : undefined;
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
        stage = "complete";
        const completed = await invoke("complete_github_repository_assessment", {
          p_assessment_id: claim.assessment_id, p_worker_id: workerId, p_lease_token: claim.lease_token,
          p_result: result, p_source_record_ids: sourceRecordIds,
        });
        const outcome = completed as { status?: string; drafted?: boolean; review_queue_id?: string | null };
        if (outcome.status === "assessed" || outcome.status === "needs_review") counts.assessed += 1;
        if (outcome.review_queue_id) counts.queued_for_review += 1;
        else if (outcome.status === "skipped") counts.skipped += 1;
        if (outcome.drafted) counts.drafted += 1;
      } catch (error) {
        const operational = error instanceof AssessmentOperationalError ? error : new AssessmentOperationalError(stage, "Assessment failed.");
        const failedResult = await invoke("fail_github_repository_assessment", {
          p_assessment_id: claim.assessment_id, p_worker_id: workerId, p_lease_token: claim.lease_token,
          p_error_summary: `${operational.stage}_failed`, p_retryable: operational.stage !== "source_validation",
          p_retry_after_ms: null,
        });
        if ((failedResult as { status?: string }).status === "retry_wait") counts.retried += 1;
        else counts.failed += 1;
        stderr(`${JSON.stringify({ event: "assessment_item_failure", assessment_id: claim.assessment_id, stage: operational.stage, code: operational.code, message: "Assessment could not be completed; source details were omitted." })}\n`);
      }
    }
    stage = "job_finish";
    await invoke("finish_github_repository_assessment_job", { p_job_id: jobId });
    stdout(`${JSON.stringify({ event: "assessment_summary", job_id: jobId, ...counts })}\n`);
    return counts.failed > 0 ? 1 : 0;
  } catch (error) {
    const operational = error instanceof AssessmentOperationalError ? error : new AssessmentOperationalError(stage, "Assessment job failed.");
    stderr(`${JSON.stringify({ event: "failure", stage: operational.stage, code: operational.code, message: "Assessment job stopped; source details were omitted." })}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runAssessmentCli(process.argv.slice(2));
