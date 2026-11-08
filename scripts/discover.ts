import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import { createGitHubClient, type GitHubClient } from "../src/lib/github/client";
import { GitHubApiError } from "../src/lib/github/errors";
import type { GitHubSearchRepository } from "../src/lib/github/types";
import {
  getDiscoveryPlan,
  INITIAL_PLAN_VERSION,
  needsPartitionSplit,
  splitSaturatedPartition,
  type DiscoveryPartition,
} from "../src/lib/discovery/plans";

const USAGE = `Usage:
  bun run discover -- --plan initial --dry-run
  bun run discover -- --plan initial --execute --max-queries 2 --max-pages 2 --max-candidates 200
  bun run discover -- --plan initial --execute --resume

Execution is serial and bounded. The default without --execute is a read-only dry run.`;

export interface DiscoveryArguments {
  plan: "initial";
  mode: "dry-run" | "execute";
  resume: boolean;
  maxQueries: number;
  maxPages: number;
  maxCandidates: number;
  help: boolean;
}

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string; status?: number } | null }>;
};

type DiscoveryDatabase = RpcClient & Pick<ReturnType<typeof createSupabaseAdminClient>, "from">;

export interface DiscoveryCliDependencies {
  /** In-process integration seam; the production CLI has no configurable GitHub host. */
  supabase?: DiscoveryDatabase;
  github?: Pick<GitHubClient, "searchRepositories">;
  pipelineRunId?: string;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

class DiscoveryOperationalError extends Error {
  constructor(readonly stage: string, message: string) {
    super(message);
    this.name = "DiscoveryOperationalError";
  }
}

type ClaimedPartition = {
  id: string;
  partition_key: string;
  query_text: string;
  query_parameters: { sort?: "stars" | "forks" | "help-wanted-issues" | "updated"; order?: "asc" | "desc"; per_page?: number };
  query_fingerprint: string;
  cursor: { next_page?: number } | null;
  total_count: number | null;
  incomplete_results: boolean;
  lease_token: string;
};

interface CandidatePayload {
  provider_repository_id: string;
  owner_login: string;
  full_name: string;
  canonical_url: string;
  description: string | null;
  primary_language: string | null;
  stars: number;
  forks: number;
  provider_created_at: string;
  provider_updated_at: string;
  provider_pushed_at: string | null;
  topics: string[];
  source_license_summary: { key: string; name: string; spdx_id: string | null } | null;
}

export function parseDiscoveryArguments(args: string[]): DiscoveryArguments {
  let plan = "initial";
  let mode: DiscoveryArguments["mode"] = "dry-run";
  let explicitMode: "dry-run" | "execute" | undefined;
  let resume = false;
  let maxQueries = 2;
  let maxPages = 2;
  let maxCandidates = 200;
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
    else if (["--plan", "--max-queries", "--max-pages", "--max-candidates"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value.`);
      index += 1;
      if (arg === "--plan") plan = value;
      else {
        const number = Number(value);
        const maximum = arg === "--max-queries" ? 20 : arg === "--max-pages" ? 10 : 1_000;
        if (!Number.isInteger(number) || number < 1 || number > maximum) {
          throw new TypeError(`${arg} must be an integer from 1 to ${maximum}.`);
        }
        if (arg === "--max-queries") maxQueries = number;
        if (arg === "--max-pages") maxPages = number;
        if (arg === "--max-candidates") maxCandidates = number;
      }
    } else {
      throw new TypeError(`Unknown discovery option: ${arg}.`);
    }
  }
  if (plan !== "initial") throw new TypeError("Only the approved --plan initial is available in M1-02.");
  if (resume && mode !== "execute") throw new TypeError("--resume requires --execute.");
  return { plan: "initial", mode, resume, maxQueries, maxPages, maxCandidates, help };
}

export function toCandidatePayload(repository: GitHubSearchRepository): CandidatePayload {
  const license = repository.license.state === "present"
    ? {
        key: repository.license.value.key,
        name: repository.license.value.name,
        spdx_id: repository.license.value.spdxId.state === "present"
          ? repository.license.value.spdxId.value
          : null,
      }
    : null;
  return {
    provider_repository_id: String(repository.id),
    owner_login: repository.owner.login,
    full_name: repository.fullName,
    canonical_url: repository.canonicalUrl,
    description: repository.description.state === "present" ? repository.description.value : null,
    primary_language: repository.primaryLanguage.state === "present" ? repository.primaryLanguage.value : null,
    stars: repository.starCount,
    forks: repository.forkCount,
    provider_created_at: repository.createdAt,
    provider_updated_at: repository.updatedAt,
    provider_pushed_at: repository.pushedAt.state === "present" ? repository.pushedAt.value : null,
    topics: repository.topics.state === "present" ? repository.topics.value : [],
    source_license_summary: license,
  };
}

export function formatSafeGitHubFailure(error: unknown): {
  summary: string;
  kind: string;
  retryable: boolean;
  retryAfterMs: number | null;
} {
  if (error instanceof GitHubApiError) {
    const retryAfterMs = error.retryAfterMs ?? null;
    const pieces = [error.kind, ...(error.status ? [`HTTP ${error.status}`] : [])];
    if (error.rateLimit?.resource) pieces.push(`resource ${error.rateLimit.resource}`);
    if (retryAfterMs !== null) pieces.push(`retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    return {
      summary: pieces.join("; ").slice(0, 500),
      kind: error.kind,
      retryable: error.retryable,
      retryAfterMs,
    };
  }
  return { summary: "unexpected GitHub search failure", kind: "unexpected", retryable: true, retryAfterMs: null };
}

export async function runDiscoveryCli(args: string[], dependencies: DiscoveryCliDependencies = {}): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  let parsed: DiscoveryArguments;
  try {
    parsed = parseDiscoveryArguments(args);
  } catch {
    stderr(`${JSON.stringify({ event: "failure", stage: "arguments", message: "Invalid discovery arguments." })}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) {
    stdout(`${USAGE}\n`);
    return 0;
  }

  const partitions = getDiscoveryPlan(parsed.plan);
  if (parsed.mode === "dry-run") {
    stdout(`${JSON.stringify({
      event: "discovery_plan",
      mode: "dry-run",
      plan: parsed.plan,
      plan_version: INITIAL_PLAN_VERSION,
      partitions: partitions.map((partition) => ({
        partition_key: partition.partitionKey,
        provider: partition.provider,
        query: partition.queryText,
        parameters: partition.parameters,
        date_range: partition.dateRange,
        intended_coverage: partition.intendedCoverage,
        fingerprint: partition.fingerprint,
      })),
      limits: { max_queries: parsed.maxQueries, max_pages: parsed.maxPages, max_candidates: parsed.maxCandidates },
      coverage_note: "A bounded topic and language sample only; GitHub Search indexing and its 1,000-result window prevent an exhaustive coverage claim.",
    }, null, 2)}\n`);
    return 0;
  }

  const workerId = `discover-${process.pid}-${randomUUID()}`;
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  let jobId: string | undefined;
  let supabase: DiscoveryDatabase | undefined;
  let github: Pick<GitHubClient, "searchRepositories"> | undefined;
  let stage = "database_configuration";
  let queriesClaimed = 0;
  let pagesCommitted = 0;
  let candidatesSeen = 0;
  let failures = 0;
  let retriesScheduled = 0;
  let needsReview = 0;
  let interrupted = false;
  let stopAfterGitHubBlock = false;
  const invoke = async (name: string, rpcArgs: Record<string, unknown>) => {
    try {
      const result = await supabase!.rpc(name, rpcArgs);
      if (result.error) throw databaseFailure(stage, result.error);
      return result;
    } catch (error) {
      if (error instanceof DiscoveryOperationalError) throw error;
      throw databaseFailure(stage, error);
    }
  };

  try {
    supabase = dependencies.supabase ?? createSupabaseAdminClient() as unknown as DiscoveryDatabase;
    stage = "github_configuration";
    github = dependencies.github ?? createGitHubClient();
    stage = "plan_registration";
    const registered = await invoke("start_discovery_job", {
      p_plan_name: parsed.plan,
      p_plan_version: INITIAL_PLAN_VERSION,
      p_partitions: partitions.map(toDatabasePartition),
    });
    if (typeof registered.data !== "string") throw databaseFailure(stage, new Error("invalid response"));
    jobId = registered.data;
    if (dependencies.pipelineRunId) {
      stage = "job_run_tag";
      await invoke("tag_pipeline_ingestion_job", { p_job_id: jobId, p_run_id: dependencies.pipelineRunId });
    }
    stdout(`${JSON.stringify({ event: "job_started", job_id: jobId, worker_id: workerId, resume: parsed.resume, plan: parsed.plan })}\n`);

    while (!controller.signal.aborted && queriesClaimed < parsed.maxQueries && pagesCommitted < parsed.maxPages && candidatesSeen < parsed.maxCandidates) {
      stage = "partition_claim";
      const claimResult = await invoke("claim_discovery_partitions", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_limit: 1,
        p_lease_seconds: 180,
      });
      const claimed = Array.isArray(claimResult.data) ? claimResult.data as ClaimedPartition[] : [];
      const partition = claimed[0];
      if (!partition) break;
      queriesClaimed += 1;
      const pageSize = partition.query_parameters.per_page ?? 100;
      let page = partition.cursor?.next_page ?? 1;
      let releasedAtCandidateLimit = false;
      let partitionSettled = false;

      while (!controller.signal.aborted && pagesCommitted < parsed.maxPages && candidatesSeen < parsed.maxCandidates) {
        let searchResult;
        try {
          stage = "github_search";
          searchResult = await github!.searchRepositories(partition.query_text, {
            page,
            perPage: pageSize,
            sort: partition.query_parameters.sort,
            order: partition.query_parameters.order,
            signal: controller.signal,
          });
        } catch (error) {
          const failure = formatSafeGitHubFailure(error);
          if (failure.kind === "aborted" || controller.signal.aborted) {
            stage = "lease_release";
            await invoke("release_discovery_partition", {
              p_query_id: partition.id,
              p_worker_id: workerId,
              p_lease_token: partition.lease_token,
            });
            partitionSettled = true;
            interrupted = true;
            break;
          }
          stage = "persist_github_failure";
          const failed = await invoke("fail_discovery_partition", {
            p_query_id: partition.id,
            p_worker_id: workerId,
            p_lease_token: partition.lease_token,
            p_error_summary: failure.summary,
            p_retryable: failure.retryable,
            p_retry_after_ms: failure.retryAfterMs,
          });
          const status = readJsonField(failed.data, "status");
          if (status === "retry_wait") retriesScheduled += 1;
          else failures += 1;
          partitionSettled = true;
          if (["rate_limit", "unauthorized", "forbidden"].includes(failure.kind)) stopAfterGitHubBlock = true;
          stderr(`${JSON.stringify({ event: "partition_failure", partition_key: partition.partition_key, error_kind: failure.kind, state: status ?? "failed" })}\n`);
          break;
        }

        const uniqueRepositories = [...new Map(searchResult.data.items
          .filter((item) => !item.isPrivate)
          .map((item) => [item.id, item])).values()];
        const remainingCandidateBudget = parsed.maxCandidates - candidatesSeen;
        if (uniqueRepositories.length > remainingCandidateBudget) {
          stage = "lease_release";
          await invoke("release_discovery_partition", {
            p_query_id: partition.id,
            p_worker_id: workerId,
            p_lease_token: partition.lease_token,
          });
          releasedAtCandidateLimit = true;
          partitionSettled = true;
          break;
        }

        const splitRequired = needsPartitionSplit(searchResult.data.totalCount, searchResult.data.incompleteResults);
        const unexpectedEmptyWindow = uniqueRepositories.length === 0
          && (page - 1) * pageSize < searchResult.data.totalCount;
        const children = splitRequired || unexpectedEmptyWindow
          ? splitSaturatedPartition(toPlanPartition(partition))
          : null;
        let nextState: "more" | "yield" | "exhausted" | "review";
        if (splitRequired || unexpectedEmptyWindow) nextState = "review";
        else if (page * pageSize >= searchResult.data.totalCount || uniqueRepositories.length === 0) nextState = "exhausted";
        else if (pagesCommitted + 1 >= parsed.maxPages || candidatesSeen + uniqueRepositories.length >= parsed.maxCandidates) nextState = "yield";
        else nextState = "more";

        const rateLimit = searchResult.provenance.rateLimit;
        stage = "page_commit";
        const committed = await invoke("commit_discovery_page", {
          p_query_id: partition.id,
          p_worker_id: workerId,
          p_lease_token: partition.lease_token,
          p_query_fingerprint: partition.query_fingerprint,
          p_page: page,
          p_fetched_at: searchResult.provenance.fetchedAt,
          p_source_url: searchResult.provenance.sourceApiUrl,
          p_http_status: searchResult.provenance.httpStatus,
          p_source_metadata: {
            api_version: searchResult.provenance.apiVersion,
            etag: searchResult.provenance.etag ?? null,
            resource_type: searchResult.provenance.resourceType,
            stable_resource_identity: searchResult.provenance.stableResourceIdentity,
            rate_limit: rateLimit ?? null,
            total_count: searchResult.data.totalCount,
            incomplete_results: searchResult.data.incompleteResults,
            page,
            per_page: pageSize,
            sort: partition.query_parameters.sort ?? null,
            order: partition.query_parameters.order ?? null,
          },
          p_total_count: searchResult.data.totalCount,
          p_incomplete_results: searchResult.data.incompleteResults,
          p_per_page: pageSize,
          p_candidates: uniqueRepositories.map(toCandidatePayload),
          p_next_state: nextState,
          p_children: (children ?? []).map(toDatabasePartition),
          p_lease_seconds: 180,
        });
        const commitInfo = typeof committed.data === "object" && committed.data !== null
          ? committed.data as Record<string, unknown>
          : {};
        if (commitInfo.committed !== true) {
          throw new DiscoveryOperationalError("page_commit", "Supabase did not confirm a transactional page commit; candidate counts were not advanced.");
        }
        pagesCommitted += 1;
        candidatesSeen += uniqueRepositories.length;
        partitionSettled = nextState !== "more";
        if (nextState === "review") needsReview += 1;
        stdout(`${JSON.stringify({
          event: "page_committed",
          partition_key: partition.partition_key,
          page,
          page_candidates: uniqueRepositories.length,
          candidates_created: commitInfo.candidates_created ?? null,
          total_count: searchResult.data.totalCount,
          incomplete_results: searchResult.data.incompleteResults,
          state: commitInfo.status ?? nextState,
          search_rate_limit_remaining: rateLimit?.remaining ?? null,
          search_rate_limit_reset: rateLimit?.resetAt ?? null,
        })}\n`);
        if (nextState !== "more") break;
        page += 1;
      }
      if (controller.signal.aborted && !partitionSettled) {
        stage = "lease_release";
        await invoke("release_discovery_partition", {
          p_query_id: partition.id,
          p_worker_id: workerId,
          p_lease_token: partition.lease_token,
        });
        interrupted = true;
      }
      if (releasedAtCandidateLimit) break;
      if (interrupted || stopAfterGitHubBlock) break;
    }

    stage = "progress_summary";
    const partitionStates = await supabase.from("discovery_queries")
      .select("status")
      .eq("plan_name", parsed.plan)
      .eq("plan_version", INITIAL_PLAN_VERSION);
    if (partitionStates.error) throw databaseFailure(stage, partitionStates.error);
    const statuses = partitionStates.data.map((row) => row.status as string);
    const complete = statuses.length > 0 && statuses.every((status) => status === "completed");
    const allTerminal = statuses.length > 0 && statuses.every((status) => ["completed", "failed", "needs_review"].includes(status));
    const jobStatus = interrupted ? "cancelled" : complete ? "succeeded" : allTerminal && failures > 0 && pagesCommitted === 0 ? "failed" : "partial";
    stage = "job_finish";
    await invoke("finish_discovery_job", {
      p_job_id: jobId,
      p_status: jobStatus,
      p_error_summary: failures ? `${failures} terminal partition failure(s); ${retriesScheduled} retry(s) scheduled.` : null,
    });
    stdout(`${JSON.stringify({
      event: "discovery_summary",
      job_id: jobId,
      status: jobStatus,
      queries_claimed: queriesClaimed,
      pages_committed: pagesCommitted,
      candidates_seen: candidatesSeen,
      retries_scheduled: retriesScheduled,
      failed_partitions: failures,
      partitions_needing_review: needsReview,
      interrupted,
    })}\n`);
    return interrupted ? 130 : failures > 0 ? 1 : 0;
  } catch (error) {
    const failure = error instanceof DiscoveryOperationalError
      ? { stage: error.stage, message: error.message }
      : stage === "database_configuration"
        ? { stage, message: "Supabase admin configuration is missing or invalid. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY." }
        : { stage: "execution", message: "Discovery stopped after an operational error." };
    stderr(`${JSON.stringify({ event: "failure", ...failure })}\n`);
    if (jobId && supabase && failure.stage !== "database_connection") {
      await supabase.rpc("finish_discovery_job", {
        p_job_id: jobId,
        p_status: controller.signal.aborted ? "cancelled" : "failed",
        p_error_summary: "Discovery stopped after an operational failure.",
      }).catch(() => undefined);
    }
    return 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

function toDatabasePartition(partition: DiscoveryPartition) {
  return {
    partition_key: partition.partitionKey,
    provider: partition.provider,
    query_text: partition.queryText,
    query_fingerprint: partition.fingerprint,
    query_parameters: {
      sort: partition.parameters.sort,
      order: partition.parameters.order,
      per_page: partition.parameters.perPage,
    },
    date_range: partition.dateRange,
    intended_coverage: partition.intendedCoverage,
  };
}

function toPlanPartition(partition: ClaimedPartition): DiscoveryPartition {
  const dateRange = partition.query_text.match(/created:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/);
  const range = dateRange
    ? { start: dateRange[1], end: dateRange[2] }
    : { start: "2026-11-05", end: "2026-11-05" };
  return {
    partitionKey: partition.partition_key,
    provider: "github",
    queryText: partition.query_text,
    parameters: {
      sort: partition.query_parameters.sort ?? "stars",
      order: partition.query_parameters.order ?? "desc",
      perPage: partition.query_parameters.per_page ?? 100,
    },
    dateRange: range,
    planVersion: INITIAL_PLAN_VERSION,
    intendedCoverage: "A narrower follow-up to an over-window initial partition.",
    fingerprint: partition.query_fingerprint,
  };
}

function readJsonField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" ? fieldValue : null;
}

function databaseFailure(stage: string, error: unknown): DiscoveryOperationalError {
  const details = typeof error === "object" && error !== null
    ? error as { message?: unknown; code?: unknown; status?: unknown; name?: unknown }
    : {};
  const message = typeof details.message === "string" ? details.message : "";
  const code = typeof details.code === "string" ? details.code : undefined;
  const status = typeof details.status === "number" ? details.status : undefined;
  const diagnostic = `${code ?? ""} ${details.name ?? ""} ${message}`.toLowerCase();
  if ((status !== undefined && status >= 500)
    || /fetch failed|failed to fetch|network error|econnrefused|enotfound|etimedout|econnreset|pgrst00[0-3]|connection refused|socket hang up/.test(diagnostic)) {
    return new DiscoveryOperationalError(
      "database_connection",
      "Supabase PostgREST is unreachable. Check NEXT_PUBLIC_SUPABASE_URL and confirm the configured project is running; for local Supabase, run `bun run supabase start`. No hosted fallback was attempted.",
    );
  }

  if (stage === "plan_registration" && code === "55000") {
    const active = message.match(/^active discovery lease prevents incompatible plan registration for partition ([A-Za-z0-9._-]{1,128})/);
    if (active) {
      return new DiscoveryOperationalError(stage, `Active discovery lease prevents changing partition ${active[1]}; the existing worker and checkpoint were preserved.`);
    }
    const incompatible = message.match(/^incompatible discovery definition for partition ([A-Za-z0-9._-]{1,128})/);
    if (incompatible) {
      return new DiscoveryOperationalError(stage, `Partition ${incompatible[1]} has a different definition in this plan version. Keep its checkpoint and use a new plan version or an explicit reset migration.`);
    }
  }

  const safeCode = code && /^[A-Z0-9]{5}$/.test(code) ? ` (database code ${code})` : "";
  const operation = stage.replaceAll("_", " ");
  return new DiscoveryOperationalError("database_operation", `Supabase request failed during ${operation}${safeCode}. Check the configured project and discovery database state.`);
}

if (process.argv[1]?.endsWith("/scripts/discover.ts")) {
  process.exitCode = await runDiscoveryCli(process.argv.slice(2));
}
