import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import { validateSupabaseAdminEnv } from "../src/lib/env/admin";
import { runAssessmentProcess, type AssessmentCliDependencies } from "./assess";

const PROJECT_REF = "hvunezhzpnpdkfiqgaaa";
const MAX_ASSESSMENTS = 4;
const USAGE = `Usage:
  bun run recover:assessment -- --execute --resume --allow-hosted-writes \
    --confirm-project-ref ${PROJECT_REF} --job-id <existing-assessment-job-uuid> --max-assessments 4

Production-only assessment recovery. This command never runs discovery, enrichment, or logo work.`;

export interface AssessmentRecoveryArguments {
  execute: boolean;
  resume: boolean;
  allowHostedWrites: boolean;
  confirmProjectRef?: string;
  jobId?: string;
  maxAssessments?: number;
  help: boolean;
}

type DbError = { code?: string };
type DbResult = { data: unknown; error: DbError | null };
interface RecoveryQuery extends PromiseLike<DbResult> {
  select(columns: string): RecoveryQuery;
  eq(column: string, value: string | number | boolean): RecoveryQuery;
  in(column: string, values: string[]): RecoveryQuery;
  limit(count: number): RecoveryQuery;
}
interface RecoveryDatabase {
  rpc(name: string, args?: Record<string, unknown>): Promise<DbResult>;
  from(table: string): RecoveryQuery;
}

export interface AssessmentRecoveryDependencies {
  supabase?: RecoveryDatabase;
  environment?: { url?: string; secretKey?: string; label?: string };
  runWorker?: (args: string[], dependencies: AssessmentCliDependencies) => Promise<number>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

export function parseAssessmentRecoveryArguments(args: string[]): AssessmentRecoveryArguments {
  const parsed: AssessmentRecoveryArguments = {
    execute: false, resume: false, allowHostedWrites: false, help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--execute") parsed.execute = true;
    else if (arg === "--resume") parsed.resume = true;
    else if (arg === "--allow-hosted-writes") parsed.allowHostedWrites = true;
    else if (arg === "--confirm-project-ref") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(value)) {
        throw new TypeError("--confirm-project-ref requires a Supabase project reference.");
      }
      parsed.confirmProjectRef = value;
      index += 1;
    } else if (arg === "--job-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new TypeError("--job-id requires an existing assessment job UUID.");
      }
      parsed.jobId = value.toLowerCase();
      index += 1;
    } else if (arg === "--max-assessments") {
      const value = args[index + 1];
      if (value !== String(MAX_ASSESSMENTS)) throw new TypeError("Assessment recovery requires --max-assessments 4.");
      parsed.maxAssessments = MAX_ASSESSMENTS;
      index += 1;
    } else throw new TypeError("Unknown assessment recovery option.");
  }
  if (!parsed.help) {
    if (!parsed.execute) throw new TypeError("Assessment recovery requires explicit --execute.");
    if (!parsed.resume) throw new TypeError("Assessment recovery requires explicit --resume.");
    if (!parsed.allowHostedWrites || !parsed.confirmProjectRef) {
      throw new TypeError("Hosted recovery requires --allow-hosted-writes and --confirm-project-ref.");
    }
    if (!parsed.jobId) throw new TypeError("Assessment recovery requires the exact existing --job-id.");
    if (parsed.maxAssessments !== MAX_ASSESSMENTS) throw new TypeError("Assessment recovery requires --max-assessments 4.");
  }
  return parsed;
}

export async function runAssessmentRecoveryCli(
  args: string[],
  dependencies: AssessmentRecoveryDependencies = {},
): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  let parsed: AssessmentRecoveryArguments;
  try { parsed = parseAssessmentRecoveryArguments(args); }
  catch {
    stdout(`${JSON.stringify({ event: "assessment_recovery_report", outcome_class: "rejected", stage: "arguments", mutation_started: false, message: "Recovery arguments are invalid." })}\n`);
    stderr(`${USAGE}\n`);
    return 2;
  }
  if (parsed.help) { stdout(`${USAGE}\n`); return 0; }

  const environment = dependencies.environment ?? {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    secretKey: process.env.SUPABASE_SECRET_KEY,
    label: process.env.OUTLIST_SUPABASE_ENVIRONMENT,
  };
  let url: URL;
  let supabase: RecoveryDatabase;
  try {
    const env = validateSupabaseAdminEnv({ url: environment.url, secretKey: environment.secretKey });
    url = new URL(env.url);
    supabase = dependencies.supabase ?? createSupabaseAdminClient({ requestTimeoutMs: 30_000 }) as unknown as RecoveryDatabase;
  } catch {
    stdout(`${JSON.stringify({ event: "assessment_recovery_report", outcome_class: "rejected", stage: "configuration", mutation_started: false, message: "Server-only Supabase configuration is unavailable." })}\n`);
    return 1;
  }
  const hostname = url.hostname.toLowerCase();
  const targetProjectRef = hostname.endsWith(".supabase.co") ? hostname.split(".")[0] : null;
  if (environment.label?.trim().toLowerCase() !== "production") {
    return reject(stdout, "environment", "OUTLIST_SUPABASE_ENVIRONMENT must be production.");
  }
  if (!targetProjectRef || targetProjectRef !== PROJECT_REF || parsed.confirmProjectRef !== PROJECT_REF) {
    return reject(stdout, "project_ref", "The configured hosted Supabase project and confirmation must match the production project.");
  }

  const operatorResult = await safeRpc(supabase, "pipeline_operator_report");
  if (operatorResult.error || !isRecord(operatorResult.data)) {
    return reject(stdout, "operator_preflight", "Could not read the service-only operator report.");
  }
  const operatorReport = operatorResult.data;
  const schema = isRecord(operatorReport.schema) ? operatorReport.schema : {};
  const categories = isRecord(operatorReport.categories) ? operatorReport.categories : {};
  if (schema.ready !== true || categories.ready !== true) {
    return reject(stdout, "schema_preflight", "The assessment recovery migration or approved category taxonomy is not ready.");
  }
  const activeLeases = isRecord(operatorReport.active_leases) ? operatorReport.active_leases : {};
  if (Object.values(activeLeases).some((value) => Number(value) > 0)) {
    return reject(stdout, "active_ingestion_lease", "An unexpired worker lease exists; recovery is blocked.");
  }

  const jobResult = await safeQuery(supabase.from("ingestion_jobs").select("id,job_type,provider,status")
    .eq("id", parsed.jobId!).limit(1));
  const jobs = Array.isArray(jobResult.data) ? jobResult.data.filter(isRecord) : [];
  const job = jobs.length === 1 ? jobs[0] : null;
  if (jobResult.error || !job || job.id !== parsed.jobId || job.job_type !== "github_assessment"
    || job.provider !== "github" || !["running", "partial"].includes(String(job.status))) {
    return reject(stdout, "job_verification", "The exact requested existing assessment job is missing or not recoverable.");
  }

  const readInventory = await readAssessmentJobIds(supabase);
  if (!readInventory.ok) return reject(stdout, "job_inventory", "Could not verify the existing ingestion job inventory.");
  const beforeJobIds = new Set(readInventory.ids);
  const workerStdout: string[] = [];
  const workerStderr: string[] = [];
  let workerExitCode = 1;
  try {
    workerExitCode = await (dependencies.runWorker ?? runAssessmentProcess)(
      ["--execute", "--resume", "--max-repositories", String(MAX_ASSESSMENTS)],
      {
        supabase: supabase as unknown as AssessmentCliDependencies["supabase"],
        recoveryJobId: parsed.jobId,
        writeStdout: (text) => workerStdout.push(text),
        writeStderr: (text) => workerStderr.push(text),
      },
    );
  } catch {
    workerStderr.push(`${JSON.stringify({ event: "failure", message: "Assessment worker stopped unexpectedly." })}\n`);
  }
  const workerEvents = parseLines(workerStdout);
  const workerSummary = [...workerEvents].reverse().find((event) => event.event === "assessment_recovery_summary") ?? null;

  const [finalOperatorResult, finalJobResult, assessmentResult, finalJobIds] = await Promise.all([
    safeRpc(supabase, "pipeline_operator_report"),
    safeQuery(supabase.from("ingestion_jobs").select("id,job_type,provider,status,items_processed,items_created,items_failed,items_skipped,finished_at")
      .eq("id", parsed.jobId!).limit(1)),
    safeQuery(supabase.from("repository_assessments").select("id,status,attempts,max_attempts,lease_expires_at")
      .eq("job_id", parsed.jobId!).limit(10)),
    readAssessmentJobIds(supabase),
  ]);
  const finalJobRows = Array.isArray(finalJobResult.data) ? finalJobResult.data.filter(isRecord) : [];
  const finalJob = finalJobRows.length === 1 ? finalJobRows[0] : null;
  const assessments = Array.isArray(assessmentResult.data) ? assessmentResult.data.filter(isRecord) : [];
  const states = assessments.reduce<Record<string, number>>((counts, row) => {
    const state = typeof row.status === "string" ? row.status : "unknown";
    counts[state] = (counts[state] ?? 0) + 1;
    return counts;
  }, {});
  const newlyCreatedJobs = finalJobIds.ok ? finalJobIds.ids.filter((id) => !beforeJobIds.has(id)) : [];
  const finalOperator = isRecord(finalOperatorResult.data) ? finalOperatorResult.data : null;
  const finalActiveLeases = finalOperator && isRecord(finalOperator.active_leases) ? finalOperator.active_leases : null;
  const completedCount = (states.assessed ?? 0) + (states.needs_review ?? 0) + (states.skipped ?? 0);
  const jobStatus = typeof finalJob?.status === "string" ? finalJob.status : null;
  const verified = Boolean(finalJob && finalJob.id === parsed.jobId && finalJob.job_type === "github_assessment"
    && assessments.length <= MAX_ASSESSMENTS && newlyCreatedJobs.length === 0
    && finalJobIds.ok && finalOperatorResult.error === null && assessmentResult.error === null
    && finalJobResult.error === null);
  const outcomeClass = workerSummary && typeof workerSummary.outcome_class === "string"
    ? workerSummary.outcome_class
    : workerExitCode === 0 ? "completed" : "database_operation_failure";
  const report = {
    event: "assessment_recovery_report", outcome_class: outcomeClass,
    target: { environment: "production", project_ref: targetProjectRef },
    requested_job_id: parsed.jobId, initial_job_status: job.status, final_job_status: jobStatus,
    worker_exit_code: workerExitCode, recovery_preflight: isRecord(workerSummary?.recovery_preflight) ? workerSummary.recovery_preflight : null,
    worker_outcomes: isRecord(workerSummary?.outcomes) ? workerSummary.outcomes : null,
    assessments: { total: assessments.length, completed: completedCount, by_status: states },
    finalization: { status: workerSummary?.job_status ?? null, confirmed_from_database: Boolean(jobStatus && jobStatus !== "running") },
    operator: { active_leases: finalActiveLeases, running_jobs: finalOperator?.running_jobs ?? null },
    verification: {
      requested_existing_job_reused: finalJob?.id === parsed.jobId,
      no_new_ingestion_jobs: finalJobIds.ok && newlyCreatedJobs.length === 0,
      no_discovery_or_enrichment_work: finalJobIds.ok && newlyCreatedJobs.length === 0,
      assessment_count_within_limit: assessments.length <= MAX_ASSESSMENTS,
      verified,
    },
    publication_or_logo_approval_performed: false,
    source_details_omitted: true,
    worker_errors: parseLines(workerStderr).map((row) => ({
      event: row.event ?? "failure", stage: row.stage ?? null,
      failure_class: row.failure_class ?? null, code: row.code ?? null,
      message: "Assessment details and source payloads were omitted.",
    })),
  };
  stdout(`${JSON.stringify(report, null, 2)}\n`);
  return workerExitCode === 0 && verified && jobStatus === "succeeded" ? 0 : 1;
}

async function safeRpc(supabase: RecoveryDatabase, name: string): Promise<DbResult> {
  try { return await supabase.rpc(name); }
  catch { return { data: null, error: { code: "NETWORK" } }; }
}

async function safeQuery(query: PromiseLike<DbResult>): Promise<DbResult> {
  try { return await query; }
  catch { return { data: null, error: { code: "NETWORK" } }; }
}

async function readAssessmentJobIds(supabase: RecoveryDatabase): Promise<{ ok: boolean; ids: string[] }> {
  const result = await safeQuery(supabase.from("ingestion_jobs").select("id,job_type")
    .in("job_type", ["github_discovery", "github_enrichment", "github_assessment"]).limit(1000));
  if (result.error || !Array.isArray(result.data)) return { ok: false, ids: [] };
  return { ok: true, ids: result.data.filter(isRecord).map((row) => row.id)
    .filter((id): id is string => typeof id === "string") };
}

function parseLines(chunks: string[]): Record<string, unknown>[] {
  return chunks.join("").split("\n").filter(Boolean).flatMap((line) => {
    try { const value: unknown = JSON.parse(line); return isRecord(value) ? [value] : []; }
    catch { return []; }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function reject(stdout: (text: string) => void, stage: string, message: string): number {
  stdout(`${JSON.stringify({ event: "assessment_recovery_report", outcome_class: "rejected", stage, mutation_started: false, message })}\n`);
  return 1;
}

if (import.meta.main) process.exitCode = await runAssessmentRecoveryCli(process.argv.slice(2));
