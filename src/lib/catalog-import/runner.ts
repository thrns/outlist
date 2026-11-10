import { randomUUID } from "node:crypto";
import { GitHubApiError } from "../github/errors";
import type { GitHubClient } from "../github/client";
import { reviewCatalogCandidate, type CatalogCurrentEvidence, type CatalogReviewReportItem } from "./review";
import type { CatalogArchiveValidation, CatalogBatch, CatalogCandidateRecord } from "./archive";

type DbError = { message?: string; code?: string };
type DbResult = { data: unknown; error: DbError | null };
export type CatalogImportDatabase = { rpc(name: string, args?: Record<string, unknown>): Promise<DbResult> };
export type CatalogImportGitHub = Pick<GitHubClient, "getRepositoryById">;
export type CatalogImportMode = "dry-run" | "execute" | "status";

export type CatalogImportOptions = {
  mode: CatalogImportMode;
  resume: boolean;
  maxBatches: number;
  environment?: string;
  projectRef: string;
  reportPath?: string;
};

export type CatalogImportDependencies = {
  database?: CatalogImportDatabase;
  github?: CatalogImportGitHub;
  writeReport?: (path: string, report: unknown) => Promise<void>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  now?: () => Date;
  workerId?: string;
  leaseToken?: string;
};

export type ImportAttempt = {
  github_repository_id: string;
  source_batch: number;
  source_line: number;
  status: CatalogReviewReportItem["status"];
  recommendation: CatalogReviewReportItem["recommendation"];
  imported_into_candidate_queue: boolean;
  reasons: CatalogReviewReportItem["reasons"];
  required_follow_up: string[];
  license: CatalogReviewReportItem["license"];
  evidence: CatalogReviewReportItem["evidence"];
  source_candidate: CatalogCandidateRecord | Pick<CatalogCandidateRecord, "github_repository_id">;
  database_result?: "created_candidate" | "existing_candidate" | "existing_repository" | "excluded";
  observed_at?: string;
};

export type CatalogImportReport = {
  schema_version: 1;
  generated_at: string;
  mode: CatalogImportMode;
  run_id: string | null;
  resume: boolean;
  source_archive: {
    path: string;
    sha256: string;
    candidates: number;
    batches: number;
  };
  archive_validation: ReturnType<typeof import("./archive").publicValidationReport>;
  database_mutations: {
    direct_project_rows: 0;
    published_project_rows: 0;
    approved_logo_rows: 0;
    verified_license_rows: 0;
    maximum_source_records: number;
    maximum_new_repository_candidates: number;
    catalog_import_ingestion_job_rows: number;
    maximum_catalog_import_ingestion_item_rows: number;
    source_records_created_this_invocation: number | null;
    repository_candidates_created_this_invocation: number | null;
    ingestion_items_created_this_invocation: number | null;
    per_candidate_mapping: string[];
  };
  review_summary: Record<string, number>;
  quality_review_summary: {
    archive_metadata_quality: CatalogArchiveValidation["metadataQuality"];
    license_input_statuses: Record<string, number>;
    github_current_license_evidence: number;
    legal_verification_granted: 0;
    candidates_with_live_identity_check: number;
    candidates_with_maintainability_check: number;
    candidates_with_source_assessment: number;
    candidates_with_manual_follow_up: number;
  };
  review_records: ImportAttempt[];
  checkpoint?: Record<string, unknown>;
  issues: string[];
};

export function makeOfflineImportReport(validation: CatalogArchiveValidation, now = new Date()): CatalogImportReport {
  const reviewRecords: ImportAttempt[] = validation.records.map((record) => toAttempt(record, reviewCatalogCandidate(record)));
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    mode: "dry-run",
    run_id: null,
    resume: false,
    source_archive: {
      path: validation.archivePath,
      sha256: validation.archiveSha256,
      candidates: validation.counts.candidates,
      batches: validation.counts.batches,
    },
    archive_validation: importPublicValidation(validation),
    database_mutations: {
      direct_project_rows: 0,
      published_project_rows: 0,
      approved_logo_rows: 0,
      verified_license_rows: 0,
      maximum_source_records: validation.counts.candidates,
      maximum_new_repository_candidates: validation.counts.candidates,
      catalog_import_ingestion_job_rows: 1,
      maximum_catalog_import_ingestion_item_rows: validation.counts.candidates,
      source_records_created_this_invocation: null,
      repository_candidates_created_this_invocation: null,
      ingestion_items_created_this_invocation: null,
      per_candidate_mapping: [
        "public.source_records: one schema-validated original JSON response from GET /repositories/{id}; its provider-shaped payload and actual fetched_at are stored only for a newly queued public candidate.",
        "public.repository_candidates: queued from the current GitHub stable ID, owner, repository name, and canonical URL; existing identity rows are never updated.",
        "public.ingestion_items.result: original candidate JSON, archive SHA-256, source batch and line, safely mapped category ID, resolved proposed slug, and review evidence.",
        "public.ingestion_jobs: one catalog_import job with sequential batch hashes, counters, and a lease-fenced resume checkpoint.",
        "No project, project_category, project_tag, logo, assessment, review decision, or publication row is created by this importer batch.",
      ],
    },
    review_summary: summarizeReview(reviewRecords),
    quality_review_summary: summarizeQuality(validation, reviewRecords),
    review_records: reviewRecords,
    issues: [
      "Offline dry-run does not contact GitHub or Supabase; identity and production conflicts remain pending current-source/database checks.",
      "Every candidate requires the existing source enrichment and assessment before any project draft can be created.",
      "All imported license identifiers remain unverified source metadata; legal verification is never granted by this importer.",
    ],
  };
}

function importPublicValidation(validation: CatalogArchiveValidation): CatalogImportReport["archive_validation"] {
  return Object.fromEntries(Object.entries(validation).filter(([key]) =>
    key !== "batches" && key !== "records" && key !== "manifest")) as CatalogImportReport["archive_validation"];
}

function toAttempt(record: CatalogCandidateRecord, review: CatalogReviewReportItem): ImportAttempt {
  return {
    github_repository_id: record.github_repository_id,
    source_batch: record.source_batch,
    source_line: record.source_line,
    status: review.status,
    recommendation: review.recommendation,
    imported_into_candidate_queue: false,
    reasons: review.reasons,
    required_follow_up: review.required_follow_up,
    license: review.license,
    evidence: review.evidence,
    source_candidate: record,
  };
}

function summarizeReview(records: ImportAttempt[]): Record<string, number> {
  const summary: Record<string, number> = {
    eligible_for_automated_editorial_recommendation: 0,
    requires_manual_review: 0,
    rejected_or_excluded: 0,
  };
  for (const record of records) summary[record.status] = (summary[record.status] ?? 0) + 1;
  return summary;
}

function summarizeQuality(validation: CatalogArchiveValidation, records: ImportAttempt[]): CatalogImportReport["quality_review_summary"] {
  return {
    archive_metadata_quality: validation.metadataQuality,
    license_input_statuses: validation.licenses.reviewStatuses,
    github_current_license_evidence: records.filter((record) => record.license.github_evidence_available).length,
    legal_verification_granted: 0,
    candidates_with_live_identity_check: records.filter((record) => record.evidence.current_repository !== null).length,
    candidates_with_maintainability_check: records.filter((record) => record.reasons.some((reason) =>
      reason.code === "recent_repository_activity" || reason.code === "stale_repository_activity"
      || reason.code === "activity_timestamp_unavailable")).length,
    candidates_with_source_assessment: records.filter((record) => record.evidence.assessment !== null).length,
    candidates_with_manual_follow_up: records.filter((record) => record.required_follow_up.length > 0).length,
  };
}

function requiredRpcResult<T>(result: DbResult, stage: string): T {
  if (result.error) {
    const code = result.error.code ? ` (${result.error.code})` : "";
    throw new Error(`${stage} failed${code}; no credentials or response bodies are shown.`);
  }
  return result.data as T;
}

type RepositoryResponse = Awaited<ReturnType<NonNullable<CatalogImportGitHub>["getRepositoryById"]>>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRepositoryProvenance(result: Extract<RepositoryResponse, { kind: "ok" }>) {
  return {
    source_url: result.provenance.sourceApiUrl,
    stable_resource_identity: result.provenance.stableResourceIdentity,
    fetched_at: result.provenance.fetchedAt,
    http_status: result.provenance.httpStatus,
    api_version: result.provenance.apiVersion,
  };
}

function repoSourceRecord(record: CatalogCandidateRecord, result: RepositoryResponse) {
  if (result.kind !== "ok") throw new Error("A catalog preflight cannot reuse a not-modified response.");
  const original = result.provenance.originalResponseData;
  if (!isObject(original)
    || original.id !== result.data.id
    || String(original.id) !== record.github_repository_id
    || original.full_name !== result.data.fullName
    || original.name !== result.data.name
    || isObject(original.owner) === false
    || original.owner.login !== result.data.owner.login
    || original.private !== false
    || original.disabled !== false
    || String(original.visibility).toLowerCase() !== "public") {
    throw new Error("GitHub did not provide a schema-validated original public repository response.");
  }
  return {
    source_candidate: withoutSourceLocation(record),
    source_batch: record.source_batch,
    source_line: record.source_line,
    import_candidate: true,
    verification: null,
    github_response: original,
    provenance: safeRepositoryProvenance(result),
  };
}

function safeExcludedAttempt(record: CatalogCandidateRecord, code: string, fetchedAt?: string): ImportAttempt {
  const explanation = code === "not_publicly_available"
    ? "Current GitHub metadata indicates that public availability could not be confirmed."
    : "GitHub did not provide a publicly verifiable repository response.";
  const attempt: ImportAttempt = {
    github_repository_id: record.github_repository_id,
    source_batch: record.source_batch,
    source_line: record.source_line,
    status: "rejected_or_excluded",
    recommendation: "exclude",
    imported_into_candidate_queue: false,
    reasons: [{ code, explanation, evidence: ["github_repository_id", "github_visibility"] }],
    required_follow_up: [],
    license: {
      reported_identifier: null,
      github_evidence_available: false,
      review_status: "not_assessed",
      legal_verification_granted: false,
    },
    evidence: { archive_claims: {}, current_repository: null, assessment: null },
    source_candidate: { github_repository_id: record.github_repository_id },
    ...(fetchedAt && Number.isFinite(Date.parse(fetchedAt)) ? { observed_at: fetchedAt } : {}),
  };
  return attempt;
}

function safeErrorProvenance(error: GitHubApiError, repositoryId: string) {
  if (!error.fetchedAt || !error.sourceApiUrl || !error.httpStatus) return null;
  const expectedUrl = `https://api.github.com/repositories/${repositoryId}`;
  if (error.sourceApiUrl !== expectedUrl || !Number.isFinite(Date.parse(error.fetchedAt))) return null;
  return {
    source_url: error.sourceApiUrl,
    stable_resource_identity: `github:repository:${repositoryId}`,
    fetched_at: error.fetchedAt,
    http_status: error.httpStatus,
    api_version: "2022-11-28",
  };
}

type StoredCatalogExclusion = {
  repository_id: string;
  classification: "rejected_or_excluded";
  reason_codes: string[];
  observed_at: string;
};

function withoutSourceLocation(record: CatalogCandidateRecord) {
  const { source_batch, source_line, source_batch_path, ...candidate } = record;
  void source_batch;
  void source_line;
  void source_batch_path;
  return candidate;
}

function failedAttempt(record: CatalogCandidateRecord, error: unknown, now: Date): ImportAttempt {
  const review = reviewCatalogCandidate(record, null, null, now);
  let code = "github_request_failed";
  let explanation = "A current GitHub response could not be obtained; the repository was not queued.";
  if (error instanceof GitHubApiError) {
    code = `github_${error.kind}`;
    if (error.kind === "not_found" || error.kind === "forbidden") {
      code = "github_access_not_publicly_verified";
      explanation = `GitHub did not provide a public repository response${error.status ? ` (HTTP ${error.status})` : ""}. The outcome may be private, unavailable, or deleted, so the candidate was excluded from the import queue.`;
    } else if (error.retryable) {
      code = `github_${error.kind}_retryable`;
      explanation = "GitHub returned a retryable response. The candidate remains for manual review and was not queued in this batch.";
    }
  }
  const reviewReasons = [
    ...review.reasons,
    { code, explanation, evidence: ["github_api_request", "catalog.github_repository_id"] },
  ];
  const status = code === "github_access_not_publicly_verified" ? "rejected_or_excluded" as const : "requires_manual_review" as const;
  if (status === "rejected_or_excluded") {
    return safeExcludedAttempt(record, code, error instanceof GitHubApiError ? error.fetchedAt : undefined);
  }
  return {
    ...toAttempt(record, {
      ...review,
      status,
      recommendation: "manual_review_required",
      reasons: reviewReasons,
      required_follow_up: [...new Set([...review.required_follow_up, code.endsWith("retryable") ? "retry_github_verification" : "manually_review_source_availability"])],
    }),
    imported_into_candidate_queue: false,
  };
}

function commitPayload(
  record: CatalogCandidateRecord,
  review: CatalogReviewReportItem | ImportAttempt,
  response: ReturnType<typeof repoSourceRecord> | null,
  shouldImport: boolean,
  excludedProvenance: ReturnType<typeof safeErrorProvenance> | ReturnType<typeof safeRepositoryProvenance> | null = null,
) {
  return {
    source_candidate: shouldImport
      ? withoutSourceLocation(record)
      : { schema_version: 1, github_repository_id: record.github_repository_id },
    source_batch: record.source_batch,
    source_line: record.source_line,
    import_candidate: shouldImport,
    verification: review,
    github_response: shouldImport ? response?.github_response ?? null : null,
    provenance: shouldImport ? response?.provenance ?? null : excludedProvenance,
  };
}

export async function executeCatalogImport(
  validation: CatalogArchiveValidation,
  options: CatalogImportOptions,
  dependencies: CatalogImportDependencies,
): Promise<CatalogImportReport> {
  if (!dependencies.database || !dependencies.github) throw new TypeError("Database and GitHub adapters are required for execution.");
  const database = dependencies.database;
  const github = dependencies.github;
  const now = dependencies.now ?? (() => new Date());
  const workerId = dependencies.workerId ?? `catalog-import-${randomUUID()}`;
  const leaseToken = dependencies.leaseToken ?? randomUUID();
  const batches = validation.batches;
  const response = requiredRpcResult<{
    job_id: string;
    status: string;
    next_batch_number: number;
    total_batches: number;
    archive_sha256: string;
    already_complete?: boolean;
  }>(await database.rpc("start_catalog_import", {
    p_archive_sha256: validation.archiveSha256,
    p_total_batches: batches.length,
    p_total_candidates: validation.counts.candidates,
    p_environment: options.environment,
    p_project_ref: options.projectRef,
    p_resume: options.resume,
    p_worker_id: workerId,
    p_lease_token: leaseToken,
  }), "catalog import start");
  if (!response.job_id || response.archive_sha256 !== validation.archiveSha256) throw new Error("Database returned an invalid catalog import checkpoint.");

  const report = makeOfflineImportReport(validation, now());
  report.mode = "execute";
  report.run_id = response.job_id;
  report.resume = options.resume;
  const attempts = new Map(validation.records.map((record) => [record.github_repository_id, toAttempt(record, reviewCatalogCandidate(record))]));
  const startNumber = response.next_batch_number;
  const stopBefore = Math.min(batches.length + 1, startNumber + options.maxBatches);
  let committed = 0;
  try {
    if (options.resume || response.already_complete) {
      const exclusions = requiredRpcResult<StoredCatalogExclusion[]>(await database.rpc("catalog_import_exclusions", {
        p_job_id: response.job_id,
      }), "catalog import exclusion report");
      if (!Array.isArray(exclusions)) throw new Error("Database returned invalid catalog import exclusions.");
      const recordsById = new Map(validation.records.map((record) => [record.github_repository_id, record]));
      for (const exclusion of exclusions) {
        const record = recordsById.get(exclusion.repository_id);
        if (!record || exclusion.classification !== "rejected_or_excluded" || !Number.isFinite(Date.parse(exclusion.observed_at))) {
          throw new Error("Database returned an unmatched or invalid catalog exclusion identity.");
        }
        const knownReason = exclusion.reason_codes.find((code) => [
          "not_publicly_available", "repository_id_mismatch", "github_access_not_publicly_verified",
        ].includes(code));
        const attempt = safeExcludedAttempt(record, knownReason ?? "github_access_not_publicly_verified", exclusion.observed_at);
        attempts.set(record.github_repository_id, { ...attempt, database_result: "excluded" });
      }
    }
    if (!response.already_complete) {
      for (const batch of batches) {
        if (batch.number < startNumber || batch.number >= stopBefore) continue;
        const batchPayload: ReturnType<typeof commitPayload>[] = [];
        for (const candidate of batch.records) {
          const heartbeat = requiredRpcResult<unknown>(await database.rpc("heartbeat_catalog_import", {
            p_job_id: response.job_id,
            p_worker_id: workerId,
            p_lease_token: leaseToken,
          }), "catalog import lease heartbeat");
          if (typeof heartbeat !== "string" || !Number.isFinite(Date.parse(heartbeat))) {
            throw new Error("Catalog import lease heartbeat returned no valid expiry.");
          }
          let currentResponse: Awaited<ReturnType<NonNullable<CatalogImportGitHub>["getRepositoryById"]>>;
          try {
            currentResponse = await github.getRepositoryById(Number(candidate.github_repository_id));
          } catch (error) {
            const attempt = failedAttempt(candidate, error, now());
            attempts.set(candidate.github_repository_id, attempt);
            if (error instanceof GitHubApiError && (error.kind === "not_found" || error.kind === "forbidden")) {
              batchPayload.push(commitPayload(candidate, attempt, null, false, safeErrorProvenance(error, candidate.github_repository_id)));
              continue;
            }
            report.review_records = [...attempts.values()];
            report.review_summary = summarizeReview(report.review_records);
            report.quality_review_summary = summarizeQuality(validation, report.review_records);
            report.generated_at = now().toISOString();
            if (options.reportPath && dependencies.writeReport) await dependencies.writeReport(options.reportPath, report);
            const errorKind = error instanceof GitHubApiError ? error.kind : "request";
            throw new Error(`GitHub ${errorKind} interrupted batch ${batch.number}; resume the same archive after resolving the source API condition.`);
          }
          if (currentResponse.kind !== "ok") throw new Error("GitHub returned a cached 304 without a complete identity response.");
          const current: CatalogCurrentEvidence = {
            repository: currentResponse.data,
            fetchedAt: currentResponse.provenance.fetchedAt,
            sourceUrl: currentResponse.provenance.sourceApiUrl,
            httpStatus: currentResponse.provenance.httpStatus,
          };
          const review = reviewCatalogCandidate(candidate, current, null, now());
          const importCandidate = review.status !== "rejected_or_excluded";
          if (!importCandidate) {
            const code = review.reasons.some((reason) => reason.code === "repository_id_mismatch")
              ? "repository_id_mismatch"
              : "not_publicly_available";
            const attempt = safeExcludedAttempt(candidate, code, currentResponse.provenance.fetchedAt);
            batchPayload.push(commitPayload(candidate, attempt, null, false, safeRepositoryProvenance(currentResponse)));
            attempts.set(candidate.github_repository_id, attempt);
          } else {
            const mappedResponse = repoSourceRecord(candidate, currentResponse);
            batchPayload.push(commitPayload(candidate, review, mappedResponse, true));
            attempts.set(candidate.github_repository_id, {
              ...toAttempt(candidate, review),
              imported_into_candidate_queue: true,
            });
          }
        }
        const commit = requiredRpcResult<{ next_batch_number: number; imported: number; existing: number; excluded: number; results?: Array<{ github_repository_id: string; result: ImportAttempt["database_result"] }> }>(
          await database.rpc("commit_catalog_import_batch", {
            p_job_id: response.job_id,
            p_worker_id: workerId,
            p_lease_token: leaseToken,
            p_batch_number: batch.number,
            p_batch_sha256: batch.sha256,
            p_records: batchPayload,
          }),
          `catalog import batch ${batch.number}`,
        );
        if (commit.next_batch_number !== batch.number + 1) throw new Error(`Database did not confirm checkpoint ${batch.number + 1}.`);
        if (!Array.isArray(commit.results) || commit.results.length !== batch.records.length) {
          throw new Error(`Database returned an incomplete identity reconciliation for catalog batch ${batch.number}.`);
        }
        committed += 1;
        const resultById = new Map((commit.results ?? []).map((item) => [item.github_repository_id, item.result]));
        if (resultById.size !== batch.records.length || batch.records.some((candidate) => !resultById.has(candidate.github_repository_id))) {
          throw new Error(`Database returned mismatched repository identities for catalog batch ${batch.number}.`);
        }
        for (const candidate of batch.records) {
          const current = attempts.get(candidate.github_repository_id)!;
          const databaseResult = resultById.get(candidate.github_repository_id);
          if (!databaseResult || !["created_candidate", "existing_candidate", "existing_repository", "excluded"].includes(databaseResult)) {
            throw new Error(`Database returned an unsupported reconciliation result for ${candidate.github_repository_id}.`);
          }
          attempts.set(candidate.github_repository_id, {
            ...current,
            database_result: databaseResult,
            imported_into_candidate_queue: databaseResult === "created_candidate",
          });
        }
        report.generated_at = now().toISOString();
        report.review_records = [...attempts.values()];
        report.review_summary = summarizeReview(report.review_records);
        report.quality_review_summary = summarizeQuality(validation, report.review_records);
        report.database_mutations.source_records_created_this_invocation =
          report.review_records.filter((record) => record.database_result === "created_candidate").length;
        report.database_mutations.repository_candidates_created_this_invocation =
          report.database_mutations.source_records_created_this_invocation;
        report.database_mutations.ingestion_items_created_this_invocation =
          report.review_records.filter((record) => record.database_result !== undefined).length;
        report.checkpoint = { job_id: response.job_id, next_batch_number: commit.next_batch_number, total_batches: batches.length, committed_batches_this_run: committed };
        if (options.reportPath && dependencies.writeReport) await dependencies.writeReport(options.reportPath, report);
      }
    }
    if (response.already_complete) {
      report.checkpoint = { job_id: response.job_id, status: "succeeded", already_complete: true, next_batch_number: response.next_batch_number };
    } else {
      const checkpoint = requiredRpcResult<Record<string, unknown>>(await database.rpc("finish_catalog_import", {
        p_job_id: response.job_id,
        p_worker_id: workerId,
        p_lease_token: leaseToken,
        p_error_summary: null,
      }), "catalog import checkpoint finalization");
      report.generated_at = now().toISOString();
      report.checkpoint = { ...checkpoint, committed_batches_this_run: committed };
    }
  } catch (error) {
    try {
      await database.rpc("finish_catalog_import", {
        p_job_id: response.job_id,
        p_worker_id: workerId,
        p_lease_token: leaseToken,
        p_error_summary: error instanceof Error ? error.message.slice(0, 500) : "catalog import interrupted",
      });
    } catch { /* The database lease and committed batch hashes remain the durable recovery source. */ }
    report.review_records = [...attempts.values()];
    report.review_summary = summarizeReview(report.review_records);
    report.quality_review_summary = summarizeQuality(validation, report.review_records);
    report.generated_at = now().toISOString();
    report.issues.push("The import stopped before its requested batch limit; committed batches remain durable and can be resumed with the same archive.");
    throw Object.assign(error instanceof Error ? error : new Error("Catalog import failed."), { report });
  }
  report.review_records = [...attempts.values()];
  report.review_summary = summarizeReview(report.review_records);
  report.quality_review_summary = summarizeQuality(validation, report.review_records);
  if (options.reportPath && dependencies.writeReport) await dependencies.writeReport(options.reportPath, report);
  return report;
}

export function catalogStatusResult(database: CatalogImportDatabase): Promise<DbResult> {
  return database.rpc("catalog_import_status");
}

export type { CatalogBatch };
