import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCodexLoginStatus, getCodexVersion, probeCodexExecution } from "./codex";
import { GitHubEvidenceCollector } from "./evidence";
import { loadOutlistCatalogSnapshot } from "./catalog";
import { loadCatalogReviewQueue } from "./queue";
import { REVIEW_POLICY_VERSION, EvidencePackageSchema } from "./schema";
import { runCatalogReviews, type CandidateReviewRecord } from "./runner";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_AUDIT_DIR = resolve(ROOT, "reports/catalog-production-audit");
const DEFAULT_OUTPUT_DIR = resolve(ROOT, "reports/catalog-codex-review");
const PROBE_SCHEMA = fileURLToPath(new URL("./probe.schema.json", import.meta.url));

const USAGE = `Outlist Codex CLI catalog review

Usage:
  bun run catalog:review -- doctor [--model gpt-6-luna]
  bun run catalog:review -- prepare [--audit-dir PATH] [--out-dir PATH]
  bun run catalog:review -- collect [--out-dir PATH] [--max-items N] [--start-at N] [--refresh]
  bun run catalog:review -- run [--out-dir PATH] [--max-items N] [--start-at N] [--force] [--refresh-evidence]
  bun run catalog:review -- status [--out-dir PATH]

Reviews run one candidate at a time. The default is one candidate per run.
No LLM API credentials or external model providers are supported.`;

type Options = { [key: string]: string | boolean };

export async function runCatalogReviewCli(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let options: Options;
  try { options = parseOptions(args); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid arguments."}\n${USAGE}\n`);
    return 2;
  }
  try {
    if (command === "doctor") return await doctor(options);
    if (command === "prepare") return await prepare(options);
    if (command === "collect") return await collect(options);
    if (command === "run") return await run(options);
    if (command === "status") return await status(options);
    process.stderr.write(`${USAGE}\n`);
    return 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: "catalog_review_error", message: error instanceof Error ? error.message.slice(0, 800) : "Unknown catalog review error." })}\n`);
    return 1;
  }
}

async function doctor(options: Options): Promise<number> {
  const model = stringOption(options, "model", "gpt-6-luna");
  const [version, login] = await Promise.all([getCodexVersion(), getCodexLoginStatus()]);
  if (!login.authenticated) {
    process.stdout.write(`${JSON.stringify({ event: "codex_cli_preflight", cli_version: version, chatgpt_authenticated: false, child_exec_usable: false, detail: login.detail })}\n`);
    return 1;
  }
  const probe = await probeCodexExecution({
    outputSchemaPath: PROBE_SCHEMA,
    workingDirectory: resolve(outputDirectory(options), ".preflight"),
    model,
    reasoningEffort: "medium",
  });
  process.stdout.write(`${JSON.stringify({
    event: "codex_cli_preflight",
    cli_version: version,
    chatgpt_authenticated: login.authenticated,
    child_exec_usable: probe.usable,
    failure_kind: probe.failureKind,
    detail: probe.message,
    model,
    reasoning_effort: "medium",
    sandbox: "read-only",
  }, null, 2)}\n`);
  return probe.usable ? 0 : 1;
}

async function prepare(options: Options): Promise<number> {
  const auditDirectory = resolve(stringOption(options, "audit-dir", DEFAULT_AUDIT_DIR));
  const outDirectory = resolve(outputDirectory(options));
  const queue = await loadCatalogReviewQueue(auditDirectory);
  if (options["allow-count-mismatch"] !== true && (queue.counts.total !== 1111 || queue.counts.drafts !== 639
    || queue.counts.assessment_holds !== 467 || queue.counts.enrichment_failures !== 5)) {
    throw new Error(`Audit reconciliation differed from the supplied production baseline: ${JSON.stringify(queue.counts)}.`);
  }
  const queuePath = join(outDirectory, "queue.json");
  const prior = await readFile(queuePath, "utf8").catch(() => null);
  if (prior) {
    try {
      const existing = JSON.parse(prior) as { input_sha256?: string };
      if (existing.input_sha256 && existing.input_sha256 !== queue.input_sha256 && options["replace-queue"] !== true) {
        throw new Error("A different queue already exists. Use --replace-queue only after preserving its checkpoints.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("A different queue already exists")) throw error;
    }
  }
  await atomicJson(queuePath, queue);
  process.stdout.write(`${JSON.stringify({ event: "catalog_review_queue_prepared", queue_path: queuePath, input_sha256: queue.input_sha256, counts: queue.counts }, null, 2)}\n`);
  return 0;
}

async function collect(options: Options): Promise<number> {
  const outDirectory = resolve(outputDirectory(options));
  const queue = await readQueue(outDirectory);
  const catalog = await loadOutlistCatalogSnapshot(outDirectory);
  process.stdout.write(`${JSON.stringify({ event: "outlist_duplicate_index_loaded", status: catalog.status, source: catalog.source,
    snapshot_sha256: catalog.snapshot?.sha256 ?? null, repository_rows: catalog.snapshot?.repositories.length ?? 0,
    candidate_rows: catalog.snapshot?.candidates.length ?? 0, project_rows: catalog.snapshot?.projects.length ?? 0,
    note: catalog.note })}\n`);
  const maxItems = integerOption(options, "max-items", 1, 1, 1111);
  const startAt = integerOption(options, "start-at", 0, 0, Math.max(0, queue.items.length - 1));
  const evidenceDirectory = join(outDirectory, "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const collector = new GitHubEvidenceCollector();
  let collected = 0;
  let reused = 0;
  let failed = 0;
  let stoppedForRateLimit = false;
  for (const item of queue.items.slice(startAt, startAt + maxItems)) {
    const path = join(evidenceDirectory, `${item.candidate_id}.json`);
    if (!options.refresh) {
      const cached = await readJson(path).catch(() => null);
      const parsed = cached ? EvidencePackageSchema.safeParse(cached) : null;
      if (parsed?.success && Date.now() - Date.parse(parsed.data.collected_at) < 7 * 24 * 60 * 60 * 1000) {
        reused++;
        continue;
      }
    }
    try {
      const evidence = await collector.collect(item, catalog.snapshot);
      await atomicJson(path, evidence);
      collected++;
      process.stdout.write(`${JSON.stringify({ event: "evidence_collected", candidate_id: item.candidate_id, full_name: item.full_name, status: evidence.collector_status, sources: evidence.sources.length })}\n`);
      if (evidence.collector_status === "rate_limited") { stoppedForRateLimit = true; break; }
      if (evidence.collector_status === "failed") failed++;
    } catch (error) {
      failed++;
      process.stdout.write(`${JSON.stringify({ event: "evidence_failed", candidate_id: item.candidate_id, message: error instanceof Error ? error.message.slice(0, 300) : "Source collection failed." })}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ event: "evidence_collection_run", selected: Math.min(maxItems, queue.items.length - startAt), collected, reused, failed, stopped_for_rate_limit: stoppedForRateLimit })}\n`);
  return failed || stoppedForRateLimit ? 1 : 0;
}

async function run(options: Options): Promise<number> {
  const outDirectory = resolve(outputDirectory(options));
  const queue = await readQueue(outDirectory);
  const catalog = await loadOutlistCatalogSnapshot(outDirectory);
  process.stdout.write(`${JSON.stringify({ event: "outlist_duplicate_index_loaded", status: catalog.status, source: catalog.source,
    snapshot_sha256: catalog.snapshot?.sha256 ?? null, repository_rows: catalog.snapshot?.repositories.length ?? 0,
    candidate_rows: catalog.snapshot?.candidates.length ?? 0, project_rows: catalog.snapshot?.projects.length ?? 0,
    note: catalog.note })}\n`);
  const model = stringOption(options, "model", "gpt-6-luna");
  const login = await getCodexLoginStatus();
  if (!login.authenticated) {
    process.stdout.write(`${JSON.stringify({ event: "catalog_review_paused", stage: "authentication", message: login.detail })}\n`);
    return 1;
  }
  const probe = await probeCodexExecution({ outputSchemaPath: PROBE_SCHEMA, workingDirectory: resolve(outDirectory, ".preflight"), model, reasoningEffort: "medium" });
  if (!probe.usable) {
    process.stdout.write(`${JSON.stringify({ event: "catalog_review_paused", stage: "codex_child_preflight", failure_kind: probe.failureKind, message: probe.message })}\n`);
    return 1;
  }
  const summary = await runCatalogReviews(queue, {
    outputDirectory: outDirectory,
    maxItems: integerOption(options, "max-items", 1, 1, 1111),
    startAt: integerOption(options, "start-at", 0, 0, Math.max(0, queue.items.length - 1)),
    force: options.force === true,
    refreshEvidence: options["refresh-evidence"] === true,
    model,
    reasoningEffort: "medium",
    timeoutMs: integerOption(options, "timeout-seconds", 900, 10, 3600) * 1000,
    catalogSnapshot: catalog.snapshot,
    onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  process.stdout.write(`${JSON.stringify({ event: "catalog_review_run_summary", ...summary }, null, 2)}\n`);
  return summary.failed || summary.stopped_for_rate_limit ? 1 : 0;
}

async function status(options: Options): Promise<number> {
  const outDirectory = resolve(outputDirectory(options));
  const queue = await readQueue(outDirectory);
  const recordsDirectory = join(outDirectory, "records");
  const rows: CandidateReviewRecord[] = [];
  for (const item of queue.items) {
    const row = await readJson<CandidateReviewRecord>(join(recordsDirectory, `${item.candidate_id}.json`)).catch(() => null);
    if (row) rows.push(row);
  }
  const byStatus = Object.fromEntries(["completed", "running", "cli_failed", "validation_failed", "evidence_collection_failed"].map((value) => [value, rows.filter((row) => row.execution_status === value).length]));
  const byOutcome = Object.fromEntries(["approve", "reject", "investigate"].map((value) => [value, rows.filter((row) => row.policy_decision?.accepted_outcome === value).length]));
  const tokenUsage = rows.reduce((totals, row) => ({
    input: totals.input + (row.token_usage?.input ?? 0),
    output: totals.output + (row.token_usage?.output ?? 0),
    cached_input: totals.cached_input + (row.token_usage?.cached_input ?? 0),
  }), { input: 0, output: 0, cached_input: 0 });
  process.stdout.write(`${JSON.stringify({
    event: "catalog_review_status",
    policy_version: REVIEW_POLICY_VERSION,
    queue_sha256: queue.input_sha256,
    input_candidates: queue.counts,
    review_records: rows.length,
    execution_status: byStatus,
    editorial_recommendations: byOutcome,
    execution_metrics: {
      records_with_cli_version: rows.filter((row) => row.codex_version !== null).length,
      total_codex_duration_ms: rows.reduce((total, row) => total + (row.duration_ms ?? 0), 0),
      reported_token_usage: tokenUsage,
    },
    local_evidence_packages: await countJsonFiles(join(outDirectory, "evidence")),
    output_directory: outDirectory,
  }, null, 2)}\n`);
  return 0;
}

function parseOptions(args: string[]): Options {
  const result: Options = {};
  const valueOptions = new Set(["--audit-dir", "--out-dir", "--max-items", "--start-at", "--model", "--timeout-seconds"]);
  const flagOptions = new Set(["--force", "--refresh", "--refresh-evidence", "--replace-queue", "--allow-count-mismatch"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flagOptions.has(arg)) { result[arg.slice(2)] = true; continue; }
    if (!valueOptions.has(arg)) throw new TypeError(`Unknown option ${arg}.`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value.`);
    result[arg.slice(2)] = value;
  }
  return result;
}

function stringOption(options: Options, name: string, fallback: string): string {
  const value = options[name];
  return typeof value === "string" ? value : fallback;
}

function integerOption(options: Options, name: string, fallback: number, min: number, max: number): number {
  const raw = options[name];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new TypeError(`--${name} must be an integer from ${min} to ${max}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`--${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function outputDirectory(options: Options): string { return stringOption(options, "out-dir", DEFAULT_OUTPUT_DIR); }

async function readQueue(outDirectory: string) {
  try { return JSON.parse(await readFile(join(outDirectory, "queue.json"), "utf8")); }
  catch { throw new Error(`No prepared queue at ${join(outDirectory, "queue.json")}. Run "bun run catalog:review -- prepare" first.`); }
}

async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function countJsonFiles(path: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(path).catch(() => [])).filter((name) => name.endsWith(".json")).length;
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  process.exitCode = await runCatalogReviewCli(process.argv.slice(2));
}
