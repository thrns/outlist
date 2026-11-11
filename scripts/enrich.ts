import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import { createGitHubClient, type GitHubClient } from "../src/lib/github/client";
import { GitHubApiError } from "../src/lib/github/errors";
import type { GitHubRepository } from "../src/lib/github/types";
import {
  githubFailureToResourceFailure,
  normalizeRepositoryEnrichment,
  repositoryVisibilitySignal,
  safeFailureSummary,
} from "../src/lib/enrichment/normalize";

const USAGE = `Usage:
  bun run enrich -- --dry-run
  bun run enrich -- --execute --max-candidates 5 --max-releases 20
  bun run enrich -- --execute --resume --max-candidates 5
  bun run enrich -- --execute --recover-candidate-id <uuid> [--recover-candidate-id <uuid> ...]

Execution is serial and bounded. Dry-run is the default; real database writes require --execute.`;
const MAX_CANDIDATES = 100;
const MAX_RELEASES = 100;
const TOPIC_PAGE_LIMIT = 5;
const TOPIC_ITEM_LIMIT = 500;
const LEASE_SECONDS = 900;

export interface EnrichmentArguments {
  mode: "dry-run" | "execute";
  resume: boolean;
  maxCandidates: number;
  maxReleases: number;
  recoveryCandidateIds: string[];
  help: boolean;
}

type DatabaseResult = { data: unknown; error: { message: string; code?: string; status?: number } | null };
type EnrichmentDatabase = {
  rpc(name: string, args: Record<string, unknown>): Promise<DatabaseResult>;
};
type EnrichmentGitHub = Pick<GitHubClient,
  "getRepositoryById" | "getRepositoryLanguages" | "getRepositoryTopics" | "iterateRepositoryReleasePages"
>;

export interface EnrichmentCliDependencies {
  supabase?: EnrichmentDatabase;
  github?: EnrichmentGitHub;
  pipelineRunId?: string;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

type ClaimedCandidate = {
  candidate_id: string;
  provider_repository_id: string;
  full_name: string;
  owner_login: string | null;
  enrichment_attempts: number;
  enrichment_max_attempts: number;
  lease_token: string;
  lease_expires_at: string;
};

class EnrichmentOperationalError extends Error {
  constructor(readonly stage: string, message: string, readonly code?: string) {
    super(message);
    this.name = "EnrichmentOperationalError";
  }
}

export function parseEnrichmentArguments(args: string[]): EnrichmentArguments {
  let mode: EnrichmentArguments["mode"] = "dry-run";
  let explicitMode: EnrichmentArguments["mode"] | undefined;
  let resume = false;
  let maxCandidates = 5;
  let maxReleases = 20;
  let maxCandidatesExplicit = false;
  let maxReleasesExplicit = false;
  const recoveryCandidateIds: string[] = [];
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--dry-run" || arg === "--execute") {
      const nextMode = arg === "--execute" ? "execute" : "dry-run";
      if (explicitMode && explicitMode !== nextMode) throw new TypeError("Choose either --dry-run or --execute, not both.");
      explicitMode = nextMode;
      mode = nextMode;
    } else if (arg === "--resume") resume = true;
    else if (arg === "--recover-candidate-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new TypeError("--recover-candidate-id requires a UUID.");
      }
      if (recoveryCandidateIds.includes(value.toLowerCase())) throw new TypeError("Recovery candidate IDs must be unique.");
      recoveryCandidateIds.push(value.toLowerCase());
      index += 1;
    }
    else if (arg === "--max-candidates" || arg === "--max-releases") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value.`);
      if (!/^\d+$/.test(value)) throw new TypeError(`${arg} must use a whole decimal number.`);
      const number = Number(value);
      const maximum = arg === "--max-candidates" ? MAX_CANDIDATES : MAX_RELEASES;
      if (!Number.isInteger(number) || number < 1 || number > maximum) {
        throw new TypeError(`${arg} must be an integer from 1 to ${maximum}.`);
      }
      if (arg === "--max-candidates") { maxCandidates = number; maxCandidatesExplicit = true; }
      else { maxReleases = number; maxReleasesExplicit = true; }
      index += 1;
    } else {
      throw new TypeError(`Unknown enrichment option: ${arg}.`);
    }
  }
  if (resume && mode !== "execute") throw new TypeError("--resume requires --execute.");
  if (recoveryCandidateIds.length > 5) throw new TypeError("At most five recovery candidate IDs are allowed.");
  if (recoveryCandidateIds.length > 0) {
    if (resume) throw new TypeError("--resume cannot be combined with --recover-candidate-id.");
    if (mode !== "execute") throw new TypeError("--recover-candidate-id requires --execute.");
    if (!maxCandidatesExplicit) maxCandidates = recoveryCandidateIds.length;
    if (maxCandidates > recoveryCandidateIds.length) throw new TypeError("--max-candidates cannot exceed the number of recovery candidate IDs.");
    if (!maxReleasesExplicit) maxReleases = 5;
  }
  return { mode, resume, maxCandidates, maxReleases, recoveryCandidateIds, help };
}

export async function runEnrichmentCli(args: string[], dependencies: EnrichmentCliDependencies = {}): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  let parsed: EnrichmentArguments;
  try {
    parsed = parseEnrichmentArguments(args);
  } catch {
    stderr(`${JSON.stringify({ event: "failure", stage: "arguments", message: "Invalid enrichment arguments." })}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) {
    stdout(`${USAGE}\n`);
    return 0;
  }
  if (parsed.mode === "dry-run") {
    stdout(`${JSON.stringify({
      event: "enrichment_plan",
      mode: "dry-run",
      limits: { max_candidates: parsed.maxCandidates, max_releases: parsed.maxReleases, concurrency: 1 },
      eligibility: "GitHub candidates with a valid numeric repository ID, not discarded or editorially rejected, and queued or due for retry.",
      cache_policy: "Conditional requests are disabled; every resource must return a complete validated response before replacement.",
    }, null, 2)}\n`);
    return 0;
  }

  const workerId = `enrich-${process.pid}-${randomUUID()}`;
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  let supabase: EnrichmentDatabase | undefined;
  let github: EnrichmentGitHub | undefined;
  let jobId: string | undefined;
  let stage = "database_configuration";
  let candidatesClaimed = 0;
  let enriched = 0;
  let retried = 0;
  let failed = 0;
  let skipped = 0;
  let operationalErrors = 0;
  let interrupted = false;
  const invoke = async (name: string, rpcArgs: Record<string, unknown>) => {
    try {
      const result = await supabase!.rpc(name, rpcArgs);
      if (result.error) throw databaseFailure(stage, result.error);
      return result.data;
    } catch (error) {
      if (error instanceof EnrichmentOperationalError) throw error;
      throw databaseFailure(stage, error);
    }
  };

  try {
    supabase = dependencies.supabase ?? createSupabaseAdminClient() as unknown as EnrichmentDatabase;
    stage = "github_configuration";
    github = dependencies.github ?? createGitHubClient();
    stage = "job_start";
    if (parsed.recoveryCandidateIds.length > 0) {
      const started = await invoke("begin_github_enrichment_recovery", {
        p_candidate_ids: parsed.recoveryCandidateIds,
        p_worker_id: workerId,
        p_max_releases: parsed.maxReleases,
      });
      jobId = readJobId(started);
      if (!jobId) throw databaseFailure(stage, new Error("invalid recovery job response"));
      failed += readInteger(started, "terminal_failures");
    } else {
      const started = await invoke("start_github_enrichment_job", {
        p_resume: parsed.resume,
        p_metadata: { max_releases: parsed.maxReleases, worker_id: workerId, cache_policy: "no_conditional_requests",
          ...(dependencies.pipelineRunId ? { pipeline_run_id: dependencies.pipelineRunId } : {}) },
      });
      if (typeof started !== "string") throw databaseFailure(stage, new Error("invalid response"));
      jobId = started;
    }
    if (dependencies.pipelineRunId && parsed.recoveryCandidateIds.length === 0) {
      stage = "job_run_tag";
      await invoke("tag_pipeline_ingestion_job", { p_job_id: jobId, p_run_id: dependencies.pipelineRunId });
    }
    stdout(`${JSON.stringify({ event: "job_started", job_id: jobId, worker_id: workerId, resume: parsed.resume,
      recovery_candidate_ids: parsed.recoveryCandidateIds })}\n`);

    while (!controller.signal.aborted && candidatesClaimed < parsed.maxCandidates) {
      stage = "candidate_claim";
      const rawClaims = await invoke(parsed.recoveryCandidateIds.length > 0
        ? "claim_github_enrichment_candidates_for_recovery" : "claim_github_enrichment_candidates", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_limit: 1,
        p_lease_seconds: LEASE_SECONDS,
      });
      const candidate = Array.isArray(rawClaims) ? rawClaims[0] as ClaimedCandidate | undefined : undefined;
      if (!candidate) break;
      candidatesClaimed += 1;

      try {
        stage = "github_repository";
        const repositoryResult = await github.getRepositoryById(parseCandidateId(candidate.provider_repository_id), {
          signal: controller.signal,
        });
        if (repositoryResult.kind !== "ok") throw new TypeError("A first-time enrichment cannot reuse a not-modified repository response.");
        const repository = repositoryResult.data;

        const visibilitySignal = repositoryVisibilitySignal(repository);
        if (visibilitySignal) {
          stage = "candidate_visibility_commit";
          const restrictedResult = await invoke("fail_github_repository_enrichment", {
            p_candidate_id: candidate.candidate_id,
            p_worker_id: workerId,
            p_lease_token: candidate.lease_token,
            p_error_summary: "source_access_restricted",
            p_retryable: false,
            p_retry_after_ms: null,
            p_failure_provenance: {
              source_url: `https://api.github.com/repositories/${candidate.provider_repository_id}`,
              fetched_at: repositoryResult.provenance.fetchedAt,
              http_status: repositoryResult.provenance.httpStatus,
              error_kind: "visibility_restricted",
              outcome: "access_restricted",
              visibility_signal: visibilitySignal,
            },
          });
          const restrictionStatus = readStatus(restrictedResult);
          if (restrictionStatus === "failed") failed += 1;
          else if (restrictionStatus === "skipped") skipped += 1;
          else throw databaseFailure(stage, new Error("invalid response"));
          operationalErrors += 1;
          stderr(`${JSON.stringify({
            event: `candidate_${restrictionStatus}`,
            candidate_id: candidate.candidate_id,
            provider_repository_id: candidate.provider_repository_id,
            message: "source_access_restricted",
          })}\n`);
          continue;
        }

        const resources = await fetchResources(github, repository, parsed.maxReleases, controller.signal);
        if (controller.signal.aborted) {
          throw new GitHubApiError("aborted", "Enrichment was interrupted while fetching source data.", { retryable: true });
        }
        stage = "normalization";
        const payload = normalizeRepositoryEnrichment({
          expectedRepositoryId: candidate.provider_repository_id,
          repository: repositoryResult,
          resources,
        });
        stage = "candidate_commit";
        let committed: unknown;
        try {
          committed = await invoke("commit_github_repository_enrichment", {
            p_candidate_id: candidate.candidate_id,
            p_worker_id: workerId,
            p_lease_token: candidate.lease_token,
            p_payload: payload,
          });
        } catch (error) {
          if (error instanceof EnrichmentOperationalError && error.code === "55000") {
            const skippedResult = await invoke("fail_github_repository_enrichment", {
              p_candidate_id: candidate.candidate_id,
              p_worker_id: workerId,
              p_lease_token: candidate.lease_token,
              p_error_summary: "Candidate became ineligible while its source metadata was being fetched.",
              p_retryable: false,
              p_retry_after_ms: null,
              p_failure_provenance: null,
            });
            if (readStatus(skippedResult) === "skipped") skipped += 1;
            continue;
          }
          throw error;
        }
        const commitStatus = readStatus(committed);
        if (commitStatus === "succeeded") enriched += 1;
        else if (commitStatus === "retry_wait") {
          retried += 1;
          operationalErrors += 1;
          stdout(`${JSON.stringify({ event: "candidate_partial", candidate_id: candidate.candidate_id, resources_incomplete: payload.missing_resources })}\n`);
        } else if (commitStatus === "failed") {
          failed += 1;
          operationalErrors += 1;
          stderr(`${JSON.stringify({ event: "candidate_failed", candidate_id: candidate.candidate_id, message: "One or more source resources failed permanently; validated data was committed for investigation." })}\n`);
        } else {
          throw databaseFailure("candidate_commit", new Error("invalid response"));
        }
        stdout(`${JSON.stringify({ event: "candidate_enriched", candidate_id: candidate.candidate_id, repository_id: readRepositoryId(committed), status: commitStatus })}\n`);
      } catch (error) {
        const databaseValidation = error instanceof EnrichmentOperationalError
          && /^(22|23)/.test(error.code ?? "");
        if (error instanceof EnrichmentOperationalError && error.stage.startsWith("database") && !databaseValidation) throw error;
        const retryable = !databaseValidation && (controller.signal.aborted || (error instanceof GitHubApiError
          ? error.retryable
          : error instanceof TypeError || error instanceof ZodError ? false : true));
        const summary = databaseValidation
          ? "database_payload_validation"
          : error instanceof TypeError || error instanceof ZodError
          ? "normalization_validation"
          : safeFailureSummary(error);
        const retryAfterMs = error instanceof GitHubApiError ? error.retryAfterMs ?? null : null;
        const sourceUrl = `https://api.github.com/repositories/${candidate.provider_repository_id}`;
        const failureProvenance = {
          source_url: sourceUrl,
          fetched_at: new Date().toISOString(),
          http_status: error instanceof GitHubApiError ? error.status ?? null : null,
          error_kind: error instanceof TypeError || error instanceof ZodError ? "validation" : safeFailureKind(error),
        };
        stage = "candidate_failure_commit";
        const failedResult = await invoke("fail_github_repository_enrichment", {
          p_candidate_id: candidate.candidate_id,
          p_worker_id: workerId,
          p_lease_token: candidate.lease_token,
          p_error_summary: summary,
          p_retryable: retryable,
          p_retry_after_ms: retryAfterMs,
          p_failure_provenance: failureProvenance,
        });
        const failureStatus = readStatus(failedResult);
        if (failureStatus === "retry_wait") retried += 1;
        else if (failureStatus === "failed") failed += 1;
        else if (failureStatus === "skipped") skipped += 1;
        else throw databaseFailure(stage, new Error("invalid response"));
        operationalErrors += 1;
        stderr(`${JSON.stringify({
          event: failureStatus === "retry_wait" ? "candidate_retry_scheduled" : `candidate_${failureStatus}`,
          candidate_id: candidate.candidate_id,
          provider_repository_id: candidate.provider_repository_id,
          message: summary,
        })}\n`);
      }
    }
    interrupted = controller.signal.aborted;
    stage = "job_finish";
    const jobStatus = interrupted ? "cancelled" : failed > 0 || retried > 0 || skipped > 0 ? "partial" : "succeeded";
    await invoke("finish_github_enrichment_job", {
      p_job_id: jobId,
      p_status: jobStatus,
      p_error_summary: operationalErrors ? `${operationalErrors} candidate enrichment issue(s) were persisted for retry or review.` : null,
    });
    stdout(`${JSON.stringify({
      event: "enrichment_summary",
      job_id: jobId,
      status: jobStatus,
      candidates_claimed: candidatesClaimed,
      enriched,
      retried,
      failed,
      skipped,
      interrupted,
    })}\n`);
    return interrupted ? 130 : operationalErrors > 0 ? 1 : 0;
  } catch (error) {
    const failure = error instanceof EnrichmentOperationalError
      ? { stage: error.stage, message: error.message }
      : stage === "database_configuration"
        ? { stage, message: "Supabase admin configuration is missing or invalid. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY." }
        : stage === "github_configuration"
          ? { stage, message: "GitHub client configuration is invalid." }
          : { stage: "execution", message: "Enrichment stopped after an operational error." };
    stderr(`${JSON.stringify({
      event: "failure",
      ...failure,
      job_id: jobId ?? null,
      candidates_claimed: candidatesClaimed,
      enriched,
      retried,
      failed,
      skipped,
    })}\n`);
    if (jobId && supabase && failure.stage !== "database_connection") {
      await supabase.rpc("finish_github_enrichment_job", {
        p_job_id: jobId,
        p_status: controller.signal.aborted ? "cancelled" : "failed",
        p_error_summary: "Enrichment stopped after an operational failure.",
      }).catch(() => undefined);
    }
    return 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

async function fetchResources(
  github: EnrichmentGitHub,
  repository: GitHubRepository,
  maxReleases: number,
  signal: AbortSignal,
): Promise<Parameters<typeof normalizeRepositoryEnrichment>[0]["resources"]> {
  const owner = repository.owner.login;
  const name = repository.name;
  const languagesUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/languages`;
  const topicsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/topics`;
  const releasesUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=${maxReleases}&page=1`;
  let languages: Parameters<typeof normalizeRepositoryEnrichment>[0]["resources"]["languages"];
  let topics: Parameters<typeof normalizeRepositoryEnrichment>[0]["resources"]["topics"];
  let releases: Parameters<typeof normalizeRepositoryEnrichment>[0]["resources"]["releases"];

  try {
    languages = await github.getRepositoryLanguages(owner, name, { signal });
  } catch (error) {
    languages = githubFailureToResourceFailure("languages", error, languagesUrl);
  }
  try {
    topics = await github.getRepositoryTopics(owner, name, {
      signal,
      perPage: 100,
      maxPages: TOPIC_PAGE_LIMIT,
      maxItems: TOPIC_ITEM_LIMIT,
    });
  } catch (error) {
    topics = githubFailureToResourceFailure("topics", error, topicsUrl);
  }
  try {
    const pages = github.iterateRepositoryReleasePages(owner, name, {
      signal,
      perPage: maxReleases,
      maxPages: 1,
      maxItems: maxReleases,
    });
    const first = await pages.next();
    await pages.return(undefined);
    if (first.done || first.value.kind !== "ok") {
      throw new TypeError("GitHub did not return a complete first release page.");
    }
    releases = {
      kind: "ok",
      data: first.value.data,
      provenance: first.value.provenance,
    };
  } catch (error) {
    releases = githubFailureToResourceFailure("releases", error, releasesUrl);
  }
  return { languages, topics, releases };
}

function parseCandidateId(value: string): number {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new TypeError("Claimed candidate has an invalid stable GitHub ID.");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new TypeError("Claimed candidate GitHub ID exceeds the safe numeric range.");
  return id;
}

function readStatus(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("status" in value)) return undefined;
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function readRepositoryId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("repository_id" in value)) return undefined;
  const id = (value as Record<string, unknown>).repository_id;
  return typeof id === "string" ? id : undefined;
}

function readJobId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("job_id" in value)) return undefined;
  const id = (value as Record<string, unknown>).job_id;
  return typeof id === "string" ? id : undefined;
}

function readInteger(value: unknown, key: string): number {
  if (typeof value !== "object" || value === null || !(key in value)) return 0;
  const number = (value as Record<string, unknown>)[key];
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function safeFailureKind(error: unknown): string {
  if (error instanceof GitHubApiError) return error.kind;
  if (error instanceof EnrichmentOperationalError && /^(22|23)/.test(error.code ?? "")) return "validation";
  if (error instanceof TypeError) return "validation";
  return "unexpected";
}

function databaseFailure(stage: string, error: unknown): EnrichmentOperationalError {
  const details = typeof error === "object" && error !== null
    ? error as { message?: unknown; code?: unknown; status?: unknown; name?: unknown }
    : {};
  const code = typeof details.code === "string" && /^[A-Z0-9]{5}$/.test(details.code) ? details.code : undefined;
  const message = typeof details.message === "string" ? details.message.toLowerCase() : "";
  const diagnostic = `${details.name ?? ""} ${message}`;
  if ((typeof details.status === "number" && details.status >= 500)
    || /fetch failed|failed to fetch|network error|econnrefused|enotfound|etimedout|econnreset|pgrst00[0-3]|connection refused|socket hang up/.test(diagnostic)) {
    return new EnrichmentOperationalError("database_connection",
      "Supabase PostgREST is unreachable. Check NEXT_PUBLIC_SUPABASE_URL and the configured local project; no hosted fallback was attempted.", code);
  }
  if (stage === "candidate_commit" && code === "40001") {
    return new EnrichmentOperationalError(stage, "The enrichment lease expired or was reclaimed before commit; this worker did not write results.", code);
  }
  const operation = stage.replaceAll("_", " ");
  return new EnrichmentOperationalError("database_operation",
    `Supabase request failed during ${operation}${code ? ` (database code ${code})` : ""}. Check the migrated enrichment schema and candidate state.`, code);
}

if (process.argv[1]?.endsWith("/scripts/enrich.ts")) {
  process.exitCode = await runEnrichmentCli(process.argv.slice(2));
}
