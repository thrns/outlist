import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexReview, CodexExecutionError, type CodexInvocationOptions } from "./codex";
import { GitHubEvidenceCollector } from "./evidence";
import { catalogSnapshotDataHash, MAX_CATALOG_SNAPSHOT_AGE_MS, type OutlistCatalogSnapshot } from "./catalog";
import type { CatalogReviewQueueItem, QueueBuildResult } from "./queue";
import {
  applyEditorialPolicy,
  EvidencePackageSchema,
  normalizeOptionalListingUrls,
  REVIEW_POLICY_VERSION,
  validateCodexReview,
  type EvidencePackage,
} from "./schema";

const REVIEW_SCHEMA_PATH = fileURLToPath(new URL("./review.schema.json", import.meta.url));
const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type ExecutionStatus = "completed" | "evidence_collection_failed" | "cli_failed" | "validation_failed" | "running";

export type CandidateReviewRecord = {
  schema: "outlist.catalog.codex-review-record.v1";
  review_id: string;
  candidate_id: string;
  project_id: string | null;
  repository_id: string;
  full_name: string;
  pipeline_outcome: CatalogReviewQueueItem["pipeline_outcome"];
  review_policy_version: typeof REVIEW_POLICY_VERSION;
  evidence_timestamp: string | null;
  evidence_sha256: string | null;
  codex_version: string | null;
  model: string;
  execution_status: ExecutionStatus;
  execution_started_at: string;
  execution_finished_at: string | null;
  duration_ms: number | null;
  failure_kind: string | null;
  failure_message: string | null;
  token_usage: { input: number | null; output: number | null; cached_input: number | null } | null;
  review: unknown | null;
  policy_decision: ReturnType<typeof applyEditorialPolicy> | null;
};

export type ReviewRunnerOptions = {
  outputDirectory: string;
  maxItems?: number;
  startAt?: number;
  force?: boolean;
  refreshEvidence?: boolean;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
  codexCommand?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  collector?: Pick<GitHubEvidenceCollector, "collect">;
  catalogSnapshot?: OutlistCatalogSnapshot | null;
  invoke?: (evidence: EvidencePackage, options: CodexInvocationOptions) => Promise<{
    result: unknown;
    cliVersion: string;
    stdout: string;
    stderr: string;
    durationMs: number;
    tokenUsage?: { input: number | null; output: number | null; cached_input: number | null } | null;
    sessionId?: string | null;
  }>;
  onEvent?: (event: Record<string, unknown>) => void;
};

export type ReviewRunSummary = {
  queue_input_sha256: string;
  selected: number;
  completed: number;
  skipped_completed: number;
  investigate: number;
  approved_recommendations: number;
  rejected_recommendations: number;
  failed: number;
  stopped_for_rate_limit: boolean;
};

export async function runCatalogReviews(queue: QueueBuildResult, options: ReviewRunnerOptions): Promise<ReviewRunSummary> {
  if (!Number.isInteger(options.maxItems ?? 1) || (options.maxItems ?? 1) < 1 || (options.maxItems ?? 1) > 1111) {
    throw new TypeError("--max-items must be an integer from 1 to 1111.");
  }
  if (!Number.isInteger(options.startAt ?? 0) || (options.startAt ?? 0) < 0 || (options.startAt ?? 0) >= queue.items.length) {
    throw new TypeError("--start-at must be an in-range zero-based queue offset.");
  }
  const outputDirectory = options.outputDirectory;
  const evidenceDirectory = join(outputDirectory, "evidence");
  const recordsDirectory = join(outputDirectory, "records");
  const reviewsDirectory = join(outputDirectory, "reviews");
  const attemptsDirectory = join(outputDirectory, "attempts");
  await Promise.all([evidenceDirectory, recordsDirectory, reviewsDirectory, attemptsDirectory].map((path) => mkdir(path, { recursive: true })));

  const collector = options.collector ?? new GitHubEvidenceCollector();
  const invoke = options.invoke ?? runCodexReview;
  const now = options.now ?? (() => new Date());
  const selected = queue.items.slice(options.startAt ?? 0, (options.startAt ?? 0) + (options.maxItems ?? 1));
  const summary: ReviewRunSummary = {
    queue_input_sha256: queue.input_sha256,
    selected: selected.length,
    completed: 0,
    skipped_completed: 0,
    investigate: 0,
    approved_recommendations: 0,
    rejected_recommendations: 0,
    failed: 0,
    stopped_for_rate_limit: false,
  };

  for (const item of selected) {
    const recordPath = join(recordsDirectory, `${item.candidate_id}.json`);
    const evidencePath = join(evidenceDirectory, `${item.candidate_id}.json`);
    let existingRecord = await readJson<CandidateReviewRecord>(recordPath).catch(() => null);
    const evidence = options.refreshEvidence ? null : await readJson<unknown>(evidencePath).catch(() => null);
    let parsedEvidence: EvidencePackage | null = null;
    if (evidence) {
      const parsed = EvidencePackageSchema.safeParse(evidence);
      if (parsed.success && isFresh(parsed.data, now(), options.catalogSnapshot, Object.hasOwn(options, "catalogSnapshot"))
        && evidenceMatchesQueueItem(parsed.data, item)) parsedEvidence = parsed.data;
    }

    const reviewId = existingRecord && existingRecord.evidence_sha256 && existingRecord.review_policy_version === REVIEW_POLICY_VERSION
      ? existingRecord.review_id
      : "pending";
    if (!options.force && existingRecord?.execution_status === "completed" && parsedEvidence
      && existingRecord.evidence_sha256 === await hashJson(parsedEvidence)
      && existingRecord.review_policy_version === REVIEW_POLICY_VERSION) {
      summary.skipped_completed++;
      options.onEvent?.({ event: "review_skipped", candidate_id: item.candidate_id, review_id: existingRecord.review_id, reason: "same evidence and policy already completed" });
      continue;
    }

    const startedAt = now().toISOString();
    existingRecord = newRecord(item, reviewId === "pending" ? makeCatalogReviewId(item.candidate_id, "evidence-pending") : reviewId,
      options.model ?? "gpt-6-luna", "running", startedAt);
    await atomicJson(recordPath, existingRecord);
    options.onEvent?.({ event: "review_started", candidate_id: item.candidate_id, full_name: item.full_name, pipeline_outcome: item.pipeline_outcome });

    try {
      if (!parsedEvidence) {
        parsedEvidence = EvidencePackageSchema.parse(await collector.collect(item, options.catalogSnapshot));
        await atomicJson(evidencePath, parsedEvidence);
      }
      if (parsedEvidence.collector_status === "rate_limited") {
        const record = failRecord(existingRecord, "evidence_collection_failed", "usage_limit", parsedEvidence.collection_notes.join(" "), now());
        await atomicJson(recordPath, record);
        summary.failed++;
        summary.stopped_for_rate_limit = true;
        options.onEvent?.({ event: "review_paused", candidate_id: item.candidate_id, reason: "GitHub source rate limit reached; evidence checkpoint saved." });
        break;
      }
      if (parsedEvidence.collector_status === "failed") {
        const record = failRecord(existingRecord, "evidence_collection_failed", "source_unavailable", parsedEvidence.collection_notes.join(" "), now());
        await atomicJson(recordPath, record);
        summary.failed++;
        options.onEvent?.({ event: "review_failed", candidate_id: item.candidate_id, failure_kind: "source_unavailable" });
        continue;
      }

      const evidenceHash = await hashJson(parsedEvidence);
      const attemptReviewId = makeCatalogReviewId(item.candidate_id, evidenceHash);
      const attemptId = `${item.candidate_id}-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
      const attemptDirectory = join(attemptsDirectory, attemptId);
      await mkdir(attemptDirectory, { recursive: true });
      const responsePath = join(attemptDirectory, "response.json");
      const attemptRecord = { ...existingRecord, review_id: attemptReviewId, evidence_timestamp: parsedEvidence.collected_at, evidence_sha256: evidenceHash };
      await atomicJson(recordPath, attemptRecord);
      let codexResult;
      try {
        codexResult = await invoke(parsedEvidence, {
          codexCommand: options.codexCommand,
          model: options.model ?? "gpt-6-luna",
          reasoningEffort: options.reasoningEffort ?? "medium",
          timeoutMs: options.timeoutMs,
          outputSchemaPath: REVIEW_SCHEMA_PATH,
          workingDirectory: attemptDirectory,
          outputPath: responsePath,
          environment: options.environment,
        });
      } catch (error) {
        const partial = await readFile(responsePath, "utf8").catch(() => null);
        if (partial !== null) await writeFile(join(attemptDirectory, "unaccepted-partial-response.txt"), partial, { mode: 0o600 });
        const kind = error instanceof CodexExecutionError ? error.kind : "cli_exit";
        const message = error instanceof Error ? error.message : "Codex CLI invocation failed.";
        if (error instanceof CodexExecutionError && error.diagnostics) {
          await writeFile(join(attemptDirectory, "stdout.jsonl"), error.diagnostics.stdout, { mode: 0o600 });
          await writeFile(join(attemptDirectory, "stderr.log"), error.diagnostics.stderr, { mode: 0o600 });
        }
        const record = failRecord(attemptRecord, "cli_failed", kind, message, now());
        await atomicJson(recordPath, record);
        summary.failed++;
        options.onEvent?.({ event: "review_failed", candidate_id: item.candidate_id, review_id: attemptReviewId, failure_kind: kind, message: message.slice(0, 300) });
        if (kind === "usage_limit" || kind === "authentication" || kind === "subprocess_unavailable") break;
        continue;
      }

      await atomicJson(join(attemptDirectory, "cli-metadata.json"), {
        cli_version: codexResult.cliVersion,
        duration_ms: codexResult.durationMs,
        stdout_bytes: Buffer.byteLength(codexResult.stdout),
        stderr_bytes: Buffer.byteLength(codexResult.stderr),
        token_usage: codexResult.tokenUsage ?? null,
        codex_session_id: codexResult.sessionId ?? null,
      });
      await writeFile(join(attemptDirectory, "stdout.jsonl"), codexResult.stdout, { mode: 0o600 });
      await writeFile(join(attemptDirectory, "stderr.log"), codexResult.stderr, { mode: 0o600 });
      let validated;
      try { validated = validateCodexReview(codexResult.result, parsedEvidence); }
      catch (error) {
        const record = {
          ...attemptRecord,
          execution_status: "validation_failed" as const,
          execution_finished_at: now().toISOString(),
          duration_ms: codexResult.durationMs,
          codex_version: codexResult.cliVersion,
          failure_kind: "schema_rejected",
          failure_message: error instanceof Error ? error.message.slice(0, 500) : "Codex result failed validation.",
        };
        await atomicJson(recordPath, record);
        summary.failed++;
        options.onEvent?.({ event: "review_failed", candidate_id: item.candidate_id, review_id: attemptReviewId, failure_kind: "schema_rejected" });
        continue;
      }

      const normalizedListing = normalizeOptionalListingUrls(validated, parsedEvidence);
      validated = normalizedListing.review;

      const acceptedReviewId = makeCatalogReviewId(item.candidate_id, evidenceHash, validated);
      await atomicJson(join(reviewsDirectory, `${acceptedReviewId}.response.json`), codexResult.result);
      const policyDecision = applyEditorialPolicy(validated, parsedEvidence, now(), normalizedListing.adjustments);
      const record: CandidateReviewRecord = {
        ...attemptRecord,
        review_id: acceptedReviewId,
        execution_status: "completed",
        execution_finished_at: now().toISOString(),
        duration_ms: codexResult.durationMs,
        codex_version: codexResult.cliVersion,
        failure_kind: null,
        failure_message: null,
        token_usage: codexResult.tokenUsage ?? null,
        review: validated,
        policy_decision: policyDecision,
      };
      await atomicJson(recordPath, record);
      await atomicJson(join(reviewsDirectory, `${acceptedReviewId}.json`), {
        schema: "outlist.catalog.codex-review.v1",
        review_id: acceptedReviewId,
        evidence_sha256: evidenceHash,
        evidence_timestamp: parsedEvidence.collected_at,
        codex_version: codexResult.cliVersion,
        review_policy_version: REVIEW_POLICY_VERSION,
        execution_status: "completed",
        review: validated,
        policy_decision: policyDecision,
      });
      summary.completed++;
      if (policyDecision.accepted_outcome === "approve") summary.approved_recommendations++;
      else if (policyDecision.accepted_outcome === "reject") summary.rejected_recommendations++;
      else summary.investigate++;
      options.onEvent?.({ event: "review_completed", candidate_id: item.candidate_id, review_id: acceptedReviewId, outcome: policyDecision.accepted_outcome, publication_eligible: policyDecision.publication_eligible });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected review orchestration failure.";
      const record = failRecord(existingRecord, "evidence_collection_failed", "source_error", message, now());
      await atomicJson(recordPath, record);
      summary.failed++;
      options.onEvent?.({ event: "review_failed", candidate_id: item.candidate_id, failure_kind: "source_error", message: message.slice(0, 300) });
    }
  }

  await atomicJson(join(outputDirectory, "latest-run.json"), { ...summary, completed_at: now().toISOString(), review_policy_version: REVIEW_POLICY_VERSION });
  return summary;
}

function newRecord(item: CatalogReviewQueueItem, reviewId: string, model: string, status: ExecutionStatus, startedAt: string): CandidateReviewRecord {
  return {
    schema: "outlist.catalog.codex-review-record.v1",
    review_id: reviewId,
    candidate_id: item.candidate_id,
    project_id: item.project_id,
    repository_id: item.repository_id,
    full_name: item.full_name,
    pipeline_outcome: item.pipeline_outcome,
    review_policy_version: REVIEW_POLICY_VERSION,
    evidence_timestamp: null,
    evidence_sha256: null,
    codex_version: null,
    model,
    execution_status: status,
    execution_started_at: startedAt,
    execution_finished_at: null,
    duration_ms: null,
    failure_kind: null,
    failure_message: null,
    token_usage: null,
    review: null,
    policy_decision: null,
  };
}

function failRecord(record: CandidateReviewRecord, status: ExecutionStatus, kind: string, message: string, now: Date): CandidateReviewRecord {
  return { ...record, execution_status: status, execution_finished_at: now.toISOString(), failure_kind: kind, failure_message: message.slice(0, 1000) };
}

export function makeCatalogReviewId(candidateId: string, evidenceHash: string, review?: unknown): string {
  const reviewDigest = review === undefined ? "pending" : JSON.stringify(review);
  const id = createHash("sha256").update(`${candidateId}\0${REVIEW_POLICY_VERSION}\0${evidenceHash}\0${reviewDigest}`).digest("hex");
  return `codex_${id.slice(0, 40)}`;
}

function isFresh(evidence: EvidencePackage, now: Date, currentSnapshot?: OutlistCatalogSnapshot | null, snapshotWasSupplied = false): boolean {
  const collectedAt = Date.parse(evidence.collected_at);
  if (!Number.isFinite(collectedAt) || collectedAt > now.getTime() + 5 * 60_000 || now.getTime() - collectedAt > MAX_EVIDENCE_AGE_MS) return false;
  const duplicateSource = evidence.sources.find((source) => source.kind === "outlist_catalog");
  const duplicateCheck = duplicateSource?.metadata.duplicate_check;
  if (!duplicateSource || !duplicateCheck || typeof duplicateCheck !== "object" || Array.isArray(duplicateCheck)) return false;
  const index = duplicateCheck as Record<string, unknown>;
  const indexCapturedAt = typeof index.snapshot_captured_at === "string" ? Date.parse(index.snapshot_captured_at) : Number.NaN;
  const indexAge = now.getTime() - indexCapturedAt;
  if (duplicateSource.status !== "available" || index.snapshot_complete !== true || index.snapshot_fresh !== true
    || !Number.isFinite(indexAge) || indexAge < -5 * 60_000 || indexAge > MAX_CATALOG_SNAPSHOT_AGE_MS) return false;
  if (snapshotWasSupplied && (!currentSnapshot || index.snapshot_data_sha256 !== catalogSnapshotDataHash(currentSnapshot))) return false;
  return true;
}

function evidenceMatchesQueueItem(evidence: EvidencePackage, item: CatalogReviewQueueItem): boolean {
  return evidence.candidate_id === item.candidate_id
    && evidence.repository_id === item.repository_id
    && evidence.full_name.toLowerCase() === item.full_name.toLowerCase()
    && evidence.project_id === item.project_id
    && evidence.pipeline_outcome === item.pipeline_outcome
    && JSON.stringify(evidence.pipeline_details) === JSON.stringify(item.pipeline_details)
    && JSON.stringify(evidence.existing_listing) === JSON.stringify(item.existing_listing);
}

async function hashJson(value: unknown): Promise<string> {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
