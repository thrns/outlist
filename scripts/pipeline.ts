import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import { validateSupabaseAdminEnv } from "../src/lib/env/admin";
import { createGitHubClient, type GitHubClient } from "../src/lib/github/client";
import { GitHubApiError } from "../src/lib/github/errors";
import type { GitHubRateLimitSnapshot } from "../src/lib/github/types";
import { runDiscoveryCli } from "./discover";
import { runEnrichmentCli } from "./enrich";
import { runAssessmentCli } from "./assess";
import { runLogoCli } from "./logos";

const USAGE = `Usage:
  bun run pipeline -- [--dry-run] [--max-queries 1] [--max-pages 1] [--max-candidates 10]
  bun run pipeline -- --execute [--max-queries 1] [--max-pages 1] [--max-candidates 10]
  bun run pipeline -- --resume --execute [--max-candidates 10]
  bun run pipeline -- --status
  bun run pipeline -- --audit
  bun run pipeline -- --live-smoke --execute

Writes require --execute. Remote Supabase writes require both --allow-hosted-writes
and --confirm-project-ref <ref>. Live smoke is capped at 1 query, 1 page,
10 discovered candidates, 5 enrichments, 5 assessments, and 5 logo projects.`;

const LIMITS = {
  queries: 20,
  pages: 10,
  candidates: 50,
  enrichments: 25,
  assessments: 25,
  logoProjects: 25,
} as const;

type Mode = "dry-run" | "execute" | "status" | "audit";
export interface PipelineArguments {
  mode: Mode;
  resume: boolean;
  liveSmoke: boolean;
  maxQueries: number;
  maxPages: number;
  maxCandidates: number;
  maxEnrichments: number;
  maxAssessments: number;
  maxLogoProjects: number;
  allowHostedWrites: boolean;
  confirmProjectRef?: string;
  help: boolean;
}

type DbError = { message?: string; code?: string; status?: number; details?: string };
type DbResult = { data: unknown; error: DbError | null; count?: number | null };
type PipelineDatabase = {
  rpc(name: string, args?: Record<string, unknown>): Promise<DbResult>;
  storage: { listBuckets(): Promise<{ data: unknown; error: DbError | null }> };
};

export interface PipelineCliDependencies {
  /** Used by deterministic local database integration tests. */
  supabase?: PipelineDatabase;
  /** An injected client is used only by tests; the operator CLI always creates the real adapter. */
  github?: GitHubClient;
  /** Marks injected HTTP fixture output so it cannot be described as live smoke data. */
  githubSource?: "live" | "fixture";
  /** Simulates a process stop at a durable stage boundary in local integration tests. */
  interruptAfterStage?: StageName;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  now?: () => Date;
}

type Target = { kind: "local" | "hosted" | "remote_unknown"; host: string; projectRef: string | null; environment: string };
type Report = {
  [key: string]: unknown;
  schema?: Record<string, unknown>;
  categories?: Record<string, unknown>;
  storage_bucket?: Record<string, unknown>;
  inventory?: Record<string, unknown>;
  last_successful_source_observations?: Record<string, unknown>;
  running_jobs?: Record<string, unknown>[];
  active_leases?: Record<string, unknown>;
  checkpoints?: Record<string, unknown>[];
  retry_schedule?: Record<string, unknown>[];
  integrity_findings?: Record<string, unknown>[];
};
type StageName = "discovery" | "enrichment" | "assessment" | "logo_candidates";
type StageResult = {
  stage: StageName;
  status: "planned" | "complete" | "partial" | "failed" | "skipped";
  exit_code: number | null;
  duration_ms: number;
  attempted: number;
  committed: number;
  deduplicated: number;
  skipped: number;
  retryable_failures: number;
  permanent_or_review_failures: number;
  worker_reported_committed: number;
  persisted_record_count: number | null;
  persisted_record_deltas: Record<string, number | null>;
  job_ids: string[];
  events: Record<string, unknown>[];
  error_events: Record<string, unknown>[];
  last_durable_checkpoint: Record<string, unknown> | null;
};

type GitHubMetrics = {
  requests: number;
  responses: number;
  failures: number;
  remainingByResource: Record<string, number>;
  resetByResource: Record<string, number>;
};

export function parsePipelineArguments(args: string[]): PipelineArguments {
  let selectedMode: Mode | undefined;
  let resume = false;
  let liveSmoke = false;
  let maxQueries = 1;
  let maxPages = 1;
  let maxCandidates = 10;
  let maxEnrichments = 5;
  let maxAssessments = 5;
  let maxLogoProjects = 5;
  let allowHostedWrites = false;
  let confirmProjectRef: string | undefined;
  let help = false;

  const setMode = (next: Mode) => {
    if (selectedMode && selectedMode !== next) throw new TypeError("Choose exactly one pipeline mode.");
    selectedMode = next;
  };
  const positiveInteger = (index: number, name: string, max: number) => {
    const value = args[index + 1];
    if (!value || !/^\d+$/.test(value)) throw new TypeError(`${name} requires a whole number.`);
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > max) throw new TypeError(`${name} must be from 1 to ${max}.`);
    return { value: number, nextIndex: index + 1 };
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--dry-run") setMode("dry-run");
    else if (arg === "--execute") setMode("execute");
    else if (arg === "--status") setMode("status");
    else if (arg === "--audit") setMode("audit");
    else if (arg === "--resume") resume = true;
    else if (arg === "--live-smoke") liveSmoke = true;
    else if (arg === "--allow-hosted-writes") allowHostedWrites = true;
    else if (arg === "--confirm-project-ref") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(value)) {
        throw new TypeError("--confirm-project-ref requires a Supabase project reference.");
      }
      confirmProjectRef = value;
      index += 1;
    } else if (arg === "--max-queries") {
      const parsed = positiveInteger(index, arg, LIMITS.queries); maxQueries = parsed.value; index = parsed.nextIndex;
    } else if (arg === "--max-pages") {
      const parsed = positiveInteger(index, arg, LIMITS.pages); maxPages = parsed.value; index = parsed.nextIndex;
    } else if (arg === "--max-candidates") {
      const parsed = positiveInteger(index, arg, LIMITS.candidates); maxCandidates = parsed.value; index = parsed.nextIndex;
    } else if (arg === "--max-enrichments") {
      const parsed = positiveInteger(index, arg, LIMITS.enrichments); maxEnrichments = parsed.value; index = parsed.nextIndex;
    } else if (arg === "--max-assessments") {
      const parsed = positiveInteger(index, arg, LIMITS.assessments); maxAssessments = parsed.value; index = parsed.nextIndex;
    } else if (arg === "--max-logo-projects") {
      const parsed = positiveInteger(index, arg, LIMITS.logoProjects); maxLogoProjects = parsed.value; index = parsed.nextIndex;
    } else throw new TypeError(`Unknown pipeline option: ${arg}.`);
  }

  const mode: Mode = selectedMode ?? "dry-run";
  if (resume && mode !== "execute") throw new TypeError("--resume requires --execute.");
  if (liveSmoke && mode !== "execute") throw new TypeError("--live-smoke requires --execute.");
  if (liveSmoke && (maxQueries > 1 || maxPages > 1 || maxCandidates > 10 || maxEnrichments > 5 || maxAssessments > 5 || maxLogoProjects > 5)) {
    throw new TypeError("Live smoke budgets cannot exceed 1 query, 1 page, 10 candidates, 5 enrichments, 5 assessments, or 5 logo projects.");
  }
  if (allowHostedWrites !== Boolean(confirmProjectRef)) {
    throw new TypeError("Remote writes require both --allow-hosted-writes and --confirm-project-ref.");
  }
  if (mode === "status" || mode === "audit") {
    if (resume || liveSmoke || allowHostedWrites || confirmProjectRef || args.some((arg) => arg.startsWith("--max-"))) {
      throw new TypeError("--status and --audit do not accept execution or budget options.");
    }
  }
  return {
    mode, resume, liveSmoke, maxQueries, maxPages, maxCandidates, maxEnrichments,
    maxAssessments, maxLogoProjects, allowHostedWrites, confirmProjectRef, help,
  };
}

export async function runPipelineCli(args: string[], dependencies: PipelineCliDependencies = {}): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((line: string) => process.stdout.write(line));
  const stderr = dependencies.writeStderr ?? ((line: string) => process.stderr.write(line));
  let parsed: PipelineArguments;
  try { parsed = parsePipelineArguments(args); }
  catch (error) {
    stderr(`${JSON.stringify({ event: "pipeline_failure", stage: "arguments", message: safeArgumentMessage(error) })}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) { stdout(`${USAGE}\n`); return 0; }

  const runId = randomUUID();
  const startedAt = Date.now();
  const metrics: GitHubMetrics = {
    requests: 0, responses: 0, failures: 0,
    remainingByResource: {}, resetByResource: {},
  };
  let database: PipelineDatabase;
  let github: GitHubClient;
  let target: Target;
  try {
    const env = validateSupabaseAdminEnv({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      secretKey: process.env.SUPABASE_SECRET_KEY,
    });
    target = classifyTarget(env.url);
    database = dependencies.supabase ?? createSupabaseAdminClient() as unknown as PipelineDatabase;
    github = dependencies.github ?? createTrackedGitHubClient(metrics);
  } catch {
    const report = {
      event: "pipeline_report", run_id: runId, mode: parsed.mode,
      complete: false,
      blockers: [{ code: "configuration_unavailable", message: "Valid server-only Supabase URL and secret key are required; credentials were not displayed." }],
      warnings: [], capabilities: { inventory: false, discovery: false, enrichment: false, assessment: false, logo_candidates: false },
    };
    stdout(`${JSON.stringify(report, null, 2)}\n`);
    return 1;
  }

  const reportResult = await database.rpc("pipeline_operator_report");
  const blockers: Array<{ code: string; message: string }> = [];
  const warnings: Array<{ code: string; message: string }> = [];
  const declaredEnvironment = process.env.OUTLIST_SUPABASE_ENVIRONMENT?.trim().toLowerCase();
  if (declaredEnvironment && !["local", "development", "staging", "production"].includes(declaredEnvironment)) {
    blockers.push({ code: "invalid_target_environment_label", message: "OUTLIST_SUPABASE_ENVIRONMENT must be local, development, staging, or production." });
  }
  if (target.kind === "local" && ["staging", "production"].includes(target.environment)) {
    blockers.push({ code: "target_environment_mismatch", message: "The configured environment label says hosted staging or production, but the Supabase URL points to localhost." });
  }
  if (target.kind !== "local" && target.environment === "local") {
    blockers.push({ code: "target_environment_mismatch", message: "The configured environment label says local, but the Supabase URL points to a remote host." });
  }
  let operatorReport: Report | null = null;
  if (reportResult.error || !reportResult.data || typeof reportResult.data !== "object") {
    blockers.push({
      code: "schema_preflight_unavailable",
      message: reportResult.error?.code === "PGRST202" || reportResult.error?.code === "42883"
        ? "M1-06 operator migration is missing. Apply the reviewed migration chain to this target, then retry."
        : "Could not read the service-only preflight report. Confirm database connectivity, migration state, and the server credential permissions.",
    });
  } else {
    operatorReport = reportResult.data as Report;
    addSchemaBlockers(operatorReport, blockers);
  }

  const writeRequested = parsed.mode === "execute";
  if (writeRequested && target.kind !== "local") {
    if (target.kind === "remote_unknown") {
      blockers.push({ code: "remote_target_unverifiable", message: "This remote Supabase host does not expose a verifiable project reference. Writes are blocked for custom or unclassified hosts." });
    } else if (!parsed.allowHostedWrites || !parsed.confirmProjectRef) {
      blockers.push({ code: "remote_write_confirmation_required", message: "This Supabase URL is remote. Writes are blocked unless the operator supplies --allow-hosted-writes and --confirm-project-ref for this target." });
    } else if (target.projectRef && parsed.confirmProjectRef !== target.projectRef) {
      blockers.push({ code: "project_ref_mismatch", message: "The confirmed project reference does not match the configured Supabase URL." });
    }
  }
  if (writeRequested && operatorReport?.active_leases && hasActiveLease(operatorReport.active_leases)) {
    blockers.push({ code: "active_ingestion_lease", message: "An unexpired ingestion lease is active. Wait for its owner to finish or expire before starting another pilot." });
  }
  if (writeRequested && operatorReport?.running_jobs?.length && !parsed.resume) {
    blockers.push({ code: "running_ingestion_job", message: "An ingestion job is already running. Use --resume only after confirming its previous worker stopped." });
  }

  let rateLimit: GitHubRateLimitSnapshot | null = null;
  let githubFailure: Record<string, unknown> | null = null;
  if (parsed.mode !== "audit") {
    try {
      const response = await github.getRateLimit();
      if (response.kind === "ok") rateLimit = response.data;
      else githubFailure = { kind: "unexpected_not_modified" };
    } catch (error) {
      githubFailure = safeGitHubDiagnostic(error);
    }
  }
  if (githubFailure) {
    const finding = { code: "github_api_unavailable", message: "GitHub API preflight failed; inspect the sanitized API diagnostic and check authentication or connectivity.", diagnostic: githubFailure };
    if (writeRequested || parsed.liveSmoke) blockers.push(finding);
    else warnings.push(finding);
  }
  const rateBudget = describeRateBudget(rateLimit, parsed);
  if (rateBudget.warning) warnings.push({ code: "github_rate_limit_budget_low", message: rateBudget.warning });
  if (parsed.mode !== "audit" && !process.env.GITHUB_TOKEN?.trim()) {
    warnings.push({ code: "github_token_absent", message: "No GitHub token is configured. Public API access remains possible with a smaller unauthenticated rate budget." });
  }
  if (dependencies.githubSource === "fixture" && parsed.liveSmoke) {
    blockers.push({ code: "fixture_is_not_live_smoke", message: "This invocation uses deterministic HTTP fixtures and cannot be reported as a live GitHub smoke test." });
  }

  const targetSummary = {
    kind: target.kind,
    host: target.host,
    project_ref: target.projectRef,
    environment: target.environment,
    writes_authorized: target.kind === "local" || (target.kind === "hosted" && parsed.allowHostedWrites
      && Boolean(parsed.confirmProjectRef) && parsed.confirmProjectRef === target.projectRef),
  };
  const sourceKinds = {
    github: dependencies.githubSource === "fixture" ? "deterministic_http_fixtures"
      : parsed.mode === "audit" ? "not_checked" : "live_github_api",
    supabase: target.kind === "local" ? "local_supabase" : target.kind === "hosted" ? "hosted_supabase" : "remote_supabase_unclassified",
  };

  if (parsed.mode === "status" || parsed.mode === "audit") {
    const report = {
      event: parsed.mode === "audit" ? "pipeline_integrity_audit" : "pipeline_status",
      generated_at: new Date().toISOString(),
      target: targetSummary,
      source_kinds: sourceKinds,
      preflight: { blockers, warnings, capabilities: capabilities(operatorReport) },
      inventory: operatorReport?.inventory ?? null,
      last_successful_source_observations: operatorReport?.last_successful_source_observations ?? {},
      running_jobs: operatorReport?.running_jobs ?? [],
      active_leases: operatorReport?.active_leases ?? null,
      checkpoints: operatorReport?.checkpoints ?? [],
      integrity_findings: operatorReport?.integrity_findings ?? [],
      audit_is_read_only: true,
      github_rate_limit: parsed.mode === "status" && rateLimit ? rateLimitSummary(rateLimit) : null,
      github_api_authentication: parsed.mode === "audit" ? null : githubAuthentication(rateLimit),
    };
    stdout(`${JSON.stringify(report, null, 2)}\n`);
    return blockers.length || !operatorReport ? 1 : 0;
  }

  const capabilitiesReport = capabilities(operatorReport);
  if (blockers.length) {
    stdout(`${JSON.stringify({
      event: "pipeline_preflight", run_id: runId, mode: parsed.mode, target: targetSummary,
      blockers, warnings, capabilities: capabilitiesReport,
      inventory: operatorReport?.inventory ?? null,
      integrity_findings: operatorReport?.integrity_findings ?? [],
      mutation_started: false,
    }, null, 2)}\n`);
    return 1;
  }

  const limits = {
    max_queries: parsed.maxQueries,
    max_pages: parsed.maxPages,
    max_candidates: parsed.maxCandidates,
    max_enrichments: Math.min(parsed.maxEnrichments, parsed.maxCandidates),
    max_assessments: parsed.maxAssessments,
    max_logo_projects: parsed.maxLogoProjects,
  };
  const stageResults: StageResult[] = [];
  let previousInventory = operatorReport?.inventory ?? null;
  const stages: Array<{ name: StageName; args: string[] }> = [
    { name: "discovery", args: ["--plan", "initial", "--max-queries", String(limits.max_queries), "--max-pages", String(limits.max_pages), "--max-candidates", String(limits.max_candidates)] },
    { name: "enrichment", args: ["--max-candidates", String(limits.max_enrichments), "--max-releases", "20"] },
    { name: "assessment", args: ["--max-repositories", String(limits.max_assessments)] },
    { name: "logo_candidates", args: ["--discover", "--max-projects", String(limits.max_logo_projects)] },
  ];
  for (const entry of stages) {
    const stageStarted = Date.now();
    if (parsed.mode === "execute") entry.args.push("--execute");
    else entry.args.push("--dry-run");
    if (parsed.resume && entry.name !== "logo_candidates") entry.args.push("--resume");
    const out: string[] = [];
    const err: string[] = [];
    let exitCode: number;
    try {
      if (entry.name === "discovery") {
        exitCode = await runDiscoveryCli(entry.args, {
          supabase: database as never, github,
          pipelineRunId: runId,
          writeStdout: (line) => out.push(line), writeStderr: (line) => err.push(line),
        });
      } else if (entry.name === "enrichment") {
        exitCode = await runEnrichmentCli(entry.args, {
          supabase: database as never, github,
          pipelineRunId: runId,
          writeStdout: (line) => out.push(line), writeStderr: (line) => err.push(line),
        });
      } else if (entry.name === "assessment") {
        exitCode = await runAssessmentCli(entry.args, {
          supabase: database as never,
          pipelineRunId: runId,
          writeStdout: (line) => out.push(line), writeStderr: (line) => err.push(line),
          ...(dependencies.now ? { now: dependencies.now } : {}),
        });
      } else {
        exitCode = await runLogoCli(entry.args, {
          supabase: database as never, github,
          pipelineRunId: runId,
          writeStdout: (line) => out.push(line), writeStderr: (line) => err.push(line),
          ...(dependencies.now ? { now: dependencies.now } : {}),
        });
      }
    } catch {
      exitCode = 1;
      err.push(`${JSON.stringify({ event: "failure", stage: entry.name, message: "Stage threw an unexpected operational error." })}\n`);
    }
    const events = parseEvents(out);
    const errorEvents = parseEvents(err);
    const result = summarizeStage(entry.name, events, errorEvents, parsed.mode, exitCode, Date.now() - stageStarted);
    result.worker_reported_committed = result.committed;
    const stageReportResult = await database.rpc("pipeline_operator_report");
    const stageReport = stageReportResult.data && typeof stageReportResult.data === "object"
      ? stageReportResult.data as Report : null;
    const currentInventory = stageReport?.inventory ?? null;
    result.persisted_record_deltas = inventoryDeltas(previousInventory ?? undefined, currentInventory ?? undefined);
    if (parsed.mode === "execute") {
      const verification = await database.rpc("pipeline_operator_verify_run", { p_run_id: runId });
      if (verification.error || !verification.data || typeof verification.data !== "object") {
        result.status = result.status === "failed" ? "failed" : "partial";
        result.error_events.push({ event: "persisted_record_inspection_failed", code: verification.error?.code ?? null });
      } else {
        result.persisted_record_count = persistedRecordCount(entry.name, verification.data as Record<string, unknown>);
        result.committed = result.persisted_record_count;
      }
    }
    if (entry.name === "discovery" && stageReport?.checkpoints?.[0]) {
      result.last_durable_checkpoint = stageReport.checkpoints[0];
    }
    previousInventory = currentInventory;
    stageResults.push(result);
    if (parsed.mode === "execute" && dependencies.interruptAfterStage === entry.name) {
      result.status = "partial";
      result.error_events.push({ event: "interrupted_after_durable_stage" });
      const stagePosition = stages.findIndex((stage) => stage.name === entry.name);
      for (const later of stages.slice(stagePosition + 1)) stageResults.push(skippedStage(later.name));
      break;
    }
    const rateLimited = isRateLimitOutcome(events, errorEvents);
    if (result.status === "failed" || rateLimited) {
      if (rateLimited) {
        const retry = filterRetrySchedule(stageReport?.retry_schedule, entry.name, events, errorEvents);
        result.last_durable_checkpoint = {
          ...(result.last_durable_checkpoint ?? {}),
          rate_limit_reason: firstRateLimitReason(events, errorEvents),
          next_eligible_retry_at: retry[0]?.next_attempt_at ?? null,
          retry_schedule: retry,
        };
      }
      const stagePosition = stages.findIndex((stage) => stage.name === entry.name);
      for (const later of stages.slice(stagePosition + 1)) {
        stageResults.push(skippedStage(later.name));
      }
      break;
    }
  }

  const finalReportResult = await database.rpc("pipeline_operator_report");
  const finalOperatorReport = finalReportResult.data && typeof finalReportResult.data === "object"
    ? finalReportResult.data as Report : null;
  let overallStatus = determineRunStatus(parsed.mode, stageResults, finalOperatorReport);
  let liveSmokeValidation: Record<string, unknown> | null = null;
  if (parsed.liveSmoke) {
    const verified = await database.rpc("pipeline_operator_verify_run", { p_run_id: runId });
    if (verified.error || !verified.data || typeof verified.data !== "object") {
      blockers.push({ code: "live_smoke_persisted_verification_failed", message: "Stage execution ended, but the service-only row and relationship inspection failed; the live smoke cannot be called successful." });
      liveSmokeValidation = { inspected: false, success: false, diagnostic: verified.error?.code ?? "verification_unavailable" };
      if (overallStatus === "complete") overallStatus = "partial";
    } else {
      liveSmokeValidation = summarizePersistedSmoke(verified.data as Record<string, unknown>);
      if (liveSmokeValidation.success !== true && overallStatus === "complete") overallStatus = "partial";
    }
  }
  const output = {
    event: "pipeline_report",
    run_id: runId,
    mode: parsed.mode,
    run_status: overallStatus,
    complete: overallStatus === "complete",
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    source_kinds: sourceKinds,
    target: targetSummary,
    limits,
    stages: stageResults,
    github: {
      authentication: githubAuthentication(rateLimit),
      rate_limit_before_run: rateLimit ? rateLimitSummary(rateLimit) : null,
      rate_limit_observed_during_run: {
        remaining_by_resource: metrics.remainingByResource,
        reset_by_resource: metrics.resetByResource,
      },
      request_statistics: { http_attempts: metrics.requests, responses: metrics.responses, failures: metrics.failures, retries: null },
    },
    initial_inventory: operatorReport?.inventory ?? null,
    final_inventory: finalOperatorReport?.inventory ?? null,
    inventory_deltas: inventoryDeltas(operatorReport?.inventory, finalOperatorReport?.inventory),
    last_successful_source_observations: finalOperatorReport?.last_successful_source_observations ?? {},
    last_durable_checkpoint: lastCheckpoint(finalOperatorReport, stageResults),
    integrity_findings: finalOperatorReport?.integrity_findings ?? operatorReport?.integrity_findings ?? [],
    blockers,
    warnings,
    publication_or_approval_performed: false,
    live_smoke_validation: liveSmokeValidation,
    data_ingestion_success: overallStatus === "complete" && stageResults.some((stage) => stage.persisted_record_count !== null && stage.persisted_record_count > 0),
  };
  stdout(`${JSON.stringify(output, null, 2)}\n`);
  return overallStatus === "complete" || overallStatus === "dry_run" ? 0 : 1;
}

function createTrackedGitHubClient(metrics: GitHubMetrics): GitHubClient {
  const baseFetch = globalThis.fetch.bind(globalThis);
  return createGitHubClient({
    token: process.env.GITHUB_TOKEN?.trim() || undefined,
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const isGitHubApi = new URL(url).hostname === "api.github.com";
      if (isGitHubApi) metrics.requests += 1;
      try {
        const response = await baseFetch(input, init);
        if (isGitHubApi) {
          metrics.responses += 1;
          if (response.status >= 400) metrics.failures += 1;
          const resource = response.headers.get("x-ratelimit-resource");
          const remaining = Number(response.headers.get("x-ratelimit-remaining"));
          const reset = Number(response.headers.get("x-ratelimit-reset"));
          if (resource && Number.isFinite(remaining)) metrics.remainingByResource[resource] = remaining;
          if (resource && Number.isFinite(reset)) metrics.resetByResource[resource] = reset;
        }
        return response;
      } catch (error) {
        if (isGitHubApi) metrics.failures += 1;
        throw error;
      }
    },
  });
}

function classifyTarget(rawUrl: string): Target {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  const kind = local ? "local" : host.endsWith(".supabase.co") ? "hosted" : "remote_unknown";
  const declaredEnvironment = process.env.OUTLIST_SUPABASE_ENVIRONMENT?.trim().toLowerCase();
  const environment = declaredEnvironment || (local ? "local" : "unclassified_remote");
  return { kind, host, projectRef: kind === "hosted" ? host.split(".")[0] ?? null : null, environment };
}

function addSchemaBlockers(report: Report, blockers: Array<{ code: string; message: string }>) {
  if (report.schema?.ready !== true) {
    const migrations = Array.isArray(report.schema?.missing_migrations) ? report.schema.missing_migrations.join(", ") : "unknown";
    const rpcs = Array.isArray(report.schema?.missing_rpcs) ? report.schema.missing_rpcs.length : 0;
    blockers.push({ code: "required_schema_missing", message: `Required migrations or worker RPCs are missing (migration versions: ${migrations}; missing RPCs: ${rpcs}).` });
  }
  if (report.categories?.ready !== true) {
    blockers.push({ code: "category_seed_mismatch", message: `Expected the complete 11-category taxonomy; found ${Number(report.categories?.active_count ?? 0)} active categories.` });
  }
  if (!isStorageBucketReady(report)) {
    blockers.push({ code: "logo_storage_bucket_unavailable", message: "The public project-logos Storage bucket is missing or is not configured as expected." });
  }
  if (Number(report.storage_bucket?.file_size_limit ?? 0) > 2_097_152) {
    blockers.push({ code: "logo_storage_limit_unexpected", message: "The project-logos bucket limit exceeds the repository's 2 MiB policy." });
  }
}

function githubAuthentication(rateLimit: GitHubRateLimitSnapshot | null) {
  const tokenConfigured = Boolean(process.env.GITHUB_TOKEN?.trim());
  return {
    token_configured: tokenConfigured,
    api_access_verified: rateLimit !== null,
    mode: tokenConfigured && rateLimit ? "authenticated" : rateLimit ? "unauthenticated_public" : "unverified",
  };
}

function capabilities(report: Report | null): Record<string, boolean> {
  const ready = report?.schema?.ready === true;
  const storageReady = report ? isStorageBucketReady(report) : false;
  return {
    database_connected: Boolean(report),
    schema_ready: ready,
    categories_ready: report?.categories?.ready === true,
    logo_storage_ready: storageReady,
    discovery: ready,
    enrichment: ready,
    assessment: ready,
    logo_candidates: ready && storageReady,
    inventory: ready,
    integrity_audit: ready,
  };
}

function isStorageBucketReady(report: Report): boolean {
  const mimeTypes = Array.isArray(report.storage_bucket?.mime_types) ? report.storage_bucket.mime_types : [];
  return report.storage_bucket?.exists === true && report.storage_bucket?.public === true
    && Number(report.storage_bucket.file_size_limit ?? 0) > 0
    && Number(report.storage_bucket.file_size_limit ?? 0) <= 2_097_152
    && ["image/png", "image/jpeg", "image/webp"].every((mime) => mimeTypes.includes(mime));
}

function hasActiveLease(leases: Record<string, unknown>): boolean {
  return Object.values(leases).some((value) => Number(value) > 0);
}

function describeRateBudget(snapshot: GitHubRateLimitSnapshot | null, args: PipelineArguments): { searchNeeded: number; coreNeeded: number; warning: string | null } {
  if (!snapshot) return { searchNeeded: args.maxQueries * args.maxPages, coreNeeded: 0, warning: null };
  const searchNeeded = args.maxQueries * args.maxPages;
  const coreNeeded = args.maxEnrichments * 5 + args.maxLogoProjects + 1;
  const search = snapshot.resources.search?.remaining ?? 0;
  const core = snapshot.rate.remaining;
  if (search < searchNeeded || core < coreNeeded) {
    return {
      searchNeeded, coreNeeded,
      warning: `Current GitHub budget is search=${search} (requested ceiling ${searchNeeded}) and core=${core} (estimated ceiling ${coreNeeded}); stage workers will stop and schedule retries if GitHub limits a request.`,
    };
  }
  return { searchNeeded, coreNeeded, warning: null };
}

function rateLimitSummary(snapshot: GitHubRateLimitSnapshot) {
  return {
    search: snapshot.resources.search ?? null,
    core: snapshot.rate,
  };
}

function safeGitHubDiagnostic(error: unknown): Record<string, unknown> {
  if (error instanceof GitHubApiError) {
    return {
      kind: error.kind, status: error.status ?? null,
      retryable: error.retryable, retry_after_ms: error.retryAfterMs ?? null,
      resource: error.rateLimit?.resource ?? null,
      remaining: error.rateLimit?.remaining ?? null,
      reset_at: error.rateLimit?.resetAt ?? null,
    };
  }
  return { kind: "network_or_adapter_error" };
}

function parseEvents(chunks: string[]): Record<string, unknown>[] {
  return chunks.join("").split("\n").filter(Boolean).map((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : { event: "unstructured_output" };
    } catch { return { event: "unstructured_output" }; }
  });
}

function summarizeStage(stage: StageName, events: Record<string, unknown>[], errors: Record<string, unknown>[], mode: Mode, exitCode: number, durationMs: number): StageResult {
  const eventOf = (event: string) => events.find((item) => item.event === event);
  const summaries = {
    discovery: eventOf("discovery_summary"),
    enrichment: eventOf("enrichment_summary"),
    assessment: eventOf("assessment_summary"),
    logo_candidates: eventOf("logo_discovery_summary"),
  };
  const summary = summaries[stage] ?? {};
  const attempted = numberField(summary, {
    discovery: "candidates_seen", enrichment: "candidates_claimed", assessment: "assessed", logo_candidates: "projects_examined",
  }[stage]);
  let committed = 0;
  let skipped = 0;
  let retryable = 0;
  let permanent = 0;
  let deduplicated = 0;
  if (stage === "discovery") {
    committed = events.filter((item) => item.event === "page_committed").reduce((sum, item) => sum + numberField(item, "candidates_created"), 0);
    deduplicated = Math.max(0, numberField(summary, "candidates_seen") - committed);
    retryable = numberField(summary, "retries_scheduled");
    permanent = numberField(summary, "failed_partitions") + numberField(summary, "partitions_needing_review");
  } else if (stage === "enrichment") {
    committed = numberField(summary, "enriched");
    skipped = numberField(summary, "skipped");
    retryable = numberField(summary, "retried");
    permanent = numberField(summary, "failed");
  } else if (stage === "assessment") {
    committed = numberField(summary, "drafted");
    skipped = numberField(summary, "skipped");
    retryable = numberField(summary, "retried");
    permanent = numberField(summary, "failed");
  } else {
    committed = events.filter((item) => item.event === "logo_candidate_registered").length;
    skipped = numberField(summary, "skipped");
    permanent = numberField(summary, "failures");
    deduplicated = Math.max(0, numberField(summary, "registration_attempts") - committed);
  }
  const fatal = errors.some((item) => item.event === "failure" || item.event === "pipeline_failure");
  const status = mode === "dry-run" ? "planned" : fatal ? "failed" : exitCode !== 0 ? "partial" : "complete";
  const jobIds = events.filter((item) => item.event === "job_started" && typeof item.job_id === "string").map((item) => String(item.job_id));
  const checkpoint = stage === "discovery" ? {
    queries_claimed: numberField(summary, "queries_claimed"),
    pages_committed: numberField(summary, "pages_committed"),
    last_page_commit: [...events].reverse().find((item) => item.event === "page_committed") ?? null,
  } : null;
  return {
    stage, status, exit_code: exitCode, duration_ms: durationMs, attempted,
    committed, deduplicated, skipped, retryable_failures: retryable,
    permanent_or_review_failures: permanent, worker_reported_committed: committed, persisted_record_count: null,
    persisted_record_deltas: {}, job_ids: jobIds,
    events, error_events: errors, last_durable_checkpoint: checkpoint,
  };
}

function skippedStage(stage: StageName): StageResult {
  return {
    stage, status: "skipped", exit_code: null, duration_ms: 0, attempted: 0, committed: 0,
    deduplicated: 0, skipped: 0, retryable_failures: 0, permanent_or_review_failures: 0,
    worker_reported_committed: 0, persisted_record_count: null, persisted_record_deltas: {},
    job_ids: [], events: [], error_events: [], last_durable_checkpoint: null,
  };
}

function numberField(value: Record<string, unknown>, key: string): number {
  const number = Number(value[key] ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function isRateLimitOutcome(events: Record<string, unknown>[], errors: Record<string, unknown>[]): boolean {
  return [...events, ...errors].some((event) => {
    const values = Object.values(event).map((value) => typeof value === "string" ? value : "").join(" ");
    return /rate[ _-]?limit|secondary limit|abuse detection/i.test(values);
  });
}

function firstRateLimitReason(events: Record<string, unknown>[], errors: Record<string, unknown>[]): string | null {
  for (const event of [...events, ...errors]) {
    const values = Object.values(event).filter((value): value is string => typeof value === "string");
    const reason = values.find((value) => /rate[ _-]?limit|secondary limit|abuse detection/i.test(value));
    if (reason) return reason.slice(0, 300);
  }
  return null;
}

function filterRetrySchedule(
  rawSchedule: unknown,
  stage: StageName,
  events: Record<string, unknown>[],
  errors: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (!Array.isArray(rawSchedule)) return [];
  const rows = rawSchedule.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && item.stage === stage);
  const eventRows = [...events, ...errors];
  const identifiers = new Set(eventRows.flatMap((event) => [
    event.partition_key, event.candidate_id, event.assessment_id,
  ]).filter((value): value is string => typeof value === "string"));
  if (!identifiers.size) return [];
  return rows.filter((row) => [row.partition_key, row.candidate_id, row.assessment_id]
    .some((value) => typeof value === "string" && identifiers.has(value)));
}

export function summarizePersistedSmoke(raw: Record<string, unknown>): Record<string, unknown> {
  const rows = (key: string): Record<string, unknown>[] => Array.isArray(raw[key])
    ? (raw[key] as unknown[]).filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
  const candidates = rows("discovered_candidates");
  const repositories = rows("enriched_repositories");
  const assessments = rows("assessments");
  const drafts = rows("project_drafts");
  const logos = rows("logo_candidates");
  const checks = {
    committed_candidate: candidates.some((row) => row.source_observation_valid === true),
    public_enriched_repository: repositories.some((row) => row.public_eligible === true && row.enrichment_succeeded === true),
    assessed_with_provenance_and_review: assessments.some((row) => row.assessment_complete === true
      && row.provenance_valid === true && row.review_relationship_valid === true),
    unpublished_classified_draft: drafts.some((row) => row.draft_valid === true && Number(row.category_evidence_count) > 0),
    pending_logo_with_review: logos.some((row) => row.logo_candidate_valid === true && row.review_relationship_valid === true),
  };
  return {
    inspected: true,
    pipeline_run_id: raw.pipeline_run_id ?? null,
    records: { discovered_candidates: candidates.length, enriched_repositories: repositories.length,
      assessments: assessments.length, project_drafts: drafts.length, logo_candidates: logos.length },
    checks,
    inspected_record_ids: {
      discovered_candidates: candidates.map((row) => row.id),
      repositories: repositories.map((row) => row.id),
      assessments: assessments.map((row) => row.id),
      projects: drafts.map((row) => row.id),
      logos: logos.map((row) => row.id),
    },
    success: Object.values(checks).every(Boolean),
    publication_or_approval_performed: false,
  };
}

function determineRunStatus(mode: Mode, stages: StageResult[], final: Report | null): "complete" | "partial" | "failed" | "empty" | "dry_run" {
  if (stages.some((stage) => stage.status === "failed")) return "failed";
  if (stages.some((stage) => stage.status === "partial" || stage.status === "skipped")) return "partial";
  if (mode === "dry-run") return "dry_run";
  const hasData = stages.some((stage) => stage.persisted_record_count !== null && stage.persisted_record_count > 0);
  if (!hasData) return "empty";
  if (!final) return "partial";
  return "complete";
}

function inventoryDeltas(initial: Record<string, unknown> | undefined, final: Record<string, unknown> | undefined): Record<string, number | null> {
  const output: Record<string, number | null> = {};
  if (!initial || !final) return output;
  for (const [key, value] of Object.entries(final)) {
    if (typeof value !== "number" && typeof value !== "string") continue;
    const before = Number(initial[key]);
    const after = Number(value);
    if (Number.isFinite(before) && Number.isFinite(after)) output[key] = after - before;
  }
  return output;
}

function persistedRecordCount(stage: StageName, report: Record<string, unknown>): number {
  const key = {
    discovery: "discovered_candidates",
    enrichment: "enriched_repositories",
    assessment: "assessments",
    logo_candidates: "logo_candidates",
  }[stage];
  if (!Array.isArray(report[key])) return 0;
  const rows = report[key] as unknown[];
  if (stage === "discovery") return rows.filter((row) => isRecord(row) && row.source_observation_valid === true).length;
  if (stage === "assessment") return rows.filter((row) => isRecord(row) && row.assessment_complete === true).length;
  return rows.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function lastCheckpoint(report: Report | null, stages: StageResult[]) {
  return {
    discovery: report?.checkpoints ?? stages.find((stage) => stage.stage === "discovery")?.last_durable_checkpoint ?? null,
    retry_schedule: stages.map((stage) => stage.last_durable_checkpoint).filter(Boolean),
  };
}

function safeArgumentMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Invalid arguments.";
  return message.replace(/[\r\n\t]/g, " ").slice(0, 300);
}

if (import.meta.main) process.exitCode = await runPipelineCli(process.argv.slice(2));
