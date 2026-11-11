import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecutionError } from "./codex";
import { makeCatalogReviewId, runCatalogReviews } from "./runner";
import { REVIEW_POLICY_VERSION, type EvidencePackage } from "./schema";
import type { CatalogReviewQueueItem, QueueBuildResult } from "./queue";

const tempDirectories: string[] = [];
const nowDate = new Date();
const candidateId = "00000000-0000-4000-8000-000000000021";
const projectId = "00000000-0000-4000-8000-000000000022";

function makeQueue(): QueueBuildResult {
  return {
    schema: "outlist.catalog.codex-queue.v1",
    created_at: nowDate.toISOString(),
    input_sha256: "b".repeat(64),
    counts: { total: 1, drafts: 1, assessment_holds: 0, enrichment_failures: 0 },
    items: [{
      queue_key: `001:0001:${candidateId}`,
      batch: 1,
      line: 1,
      repository_id: "567890",
      full_name: "fixture/task-manager",
      candidate_id: candidateId,
      project_id: projectId,
      pipeline_outcome: "draft_pending_review",
      pipeline_details: { enrichment_status: "succeeded", enrichment_error: null, assessment_status: "needs_review", classification_status: "classified", publication_status: "pending_review" },
      existing_listing: { name: "Task Manager", summary: "A collaborative task manager for teams.", description: "A task manager.", categories: ["productivity"], tags: ["tasks"], official_website_url: "https://example.com" },
      source_record_sha256: "c".repeat(64),
    }],
  };
}

function makeEvidence(): EvidencePackage {
  const source = (id: string, kind: EvidencePackage["sources"][number]["kind"], url: string, text: string | null, metadata: Record<string, unknown> = {}) => ({
    id, kind, url, status: "available" as const, observed_at: nowDate.toISOString(), sha256: "d".repeat(64), text, metadata,
  });
  return {
    schema: "outlist.catalog.codex-evidence.v1",
    candidate_id: candidateId,
    repository_id: "567890",
    full_name: "fixture/task-manager",
    project_id: projectId,
    pipeline_outcome: "draft_pending_review",
    pipeline_details: makeQueue().items[0]!.pipeline_details,
    existing_listing: makeQueue().items[0]!.existing_listing,
    outlist_categories: [{ slug: "productivity", name: "Productivity", active: true }],
    collected_at: nowDate.toISOString(),
    collector_status: "complete",
    collection_notes: [],
    sources: [
      source("repository", "repository_metadata", "https://api.github.com/repositories/567890", null, { id: "567890", full_name: "fixture/task-manager", private: false, disabled: false, visibility: "public", archived: false, homepage: null, license_spdx_id: "MIT" }),
      source("readme", "readme", "https://github.com/fixture/task-manager/blob/main/README.md", "# Task Manager\nA task application.", { content_sha256: "d".repeat(64), complete_file: true, relevant_sections_complete: true, truncated: false }),
      source("license", "license", "https://github.com/fixture/task-manager/blob/main/LICENSE", "MIT License", { content_sha256: "d".repeat(64), complete_file: true, truncated: false, content_part_index: 1, content_part_count: 1 }),
      source("root", "root_contents", "https://api.github.com/repos/fixture/task-manager/contents", null, { source_tree_complete: true, software_signals: { source_code: true, test_or_build_files: true }, data: [{ name: "src", type: "dir" }, { name: "tests", type: "dir" }] }),
      source("manifest", "manifest", "https://github.com/fixture/task-manager/blob/main/package.json", "{}", { path: "package.json", content_sha256: "d".repeat(64), complete_file: true, truncated: false }),
      source("outlist-catalog-index", "outlist_catalog", `urn:outlist:catalog-snapshot:${"d".repeat(64)}`, null, { duplicate_check: {
        snapshot_complete: true, snapshot_fresh: true, snapshot_sha256: "d".repeat(64), snapshot_data_sha256: "e".repeat(64), snapshot_captured_at: nowDate.toISOString(),
        candidate_id: candidateId, candidate_repository_id: "567890", candidate_full_name: "fixture/task-manager", candidate_identity_verified: true,
        has_material_duplicate_conflict: false, duplicate_imported_candidates: [], candidate_canonical_identity_conflicts: [], canonical_identity_conflicts: [], duplicate_public_product_listings: [],
      } }),
    ],
  };
}

function makeReview(evidence: EvidencePackage) {
  const result = {
    reviewer: { identity: "codex-cli", model: "gpt-6-luna", policy_version: REVIEW_POLICY_VERSION },
    outcome: "approve",
    confidence: 0.97,
    eligibility: {
      genuine_software_product: true, publicly_accessible: true, meaningfully_open_source: true,
      license_identifier: "MIT", license_confidence: 0.98, product_status: "functional", documentation_status: "sufficient",
      maintenance_status: "active", duplicate_status: "distinct", security_or_trust_concerns: [],
    },
    listing: {
      name: "Task Manager", summary: "A collaborative task management application for teams.", description: "A task management application for teams.",
      categories: ["productivity"], tags: ["tasks"], official_website_url: null, logo_url: null,
    },
    supporting_sources: evidence.sources.slice(0, 3).map((item) => ({ evidence_id: item.id, source_url: item.url, supports: `Supports review claim from ${item.kind}.` })),
    rationale: "The repository identifies a public software product with current project documentation and a reviewed open-source license.",
    uncertainties: [],
    material_blockers: [],
    informational_uncertainties: [],
  };
  const catalogSource = evidence.sources.find((item) => item.kind === "outlist_catalog")!;
  const manifestSource = evidence.sources.find((item) => item.kind === "manifest")!;
  result.supporting_sources.push({ evidence_id: catalogSource.id, source_url: catalogSource.url, supports: "The current Outlist identity snapshot found no duplicate candidate or public listing." });
  result.supporting_sources.push({ evidence_id: manifestSource.id, source_url: manifestSource.url, supports: "The complete package manifest identifies the software distribution." });
  return result;
}

async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "outlist-catalog-review-"));
  tempDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runCatalogReviews", () => {
  it("persists evidence and a validated result, then skips an unchanged completed review", async () => {
    const outputDirectory = await tempDirectory();
    const evidence = makeEvidence();
    const collect = vi.fn(async () => evidence);
    const invoke = vi.fn(async (input: EvidencePackage) => ({
      result: makeReview(input), cliVersion: "codex-cli 0.166.0", stdout: "{}\n", stderr: "", durationMs: 1500,
      tokenUsage: { input: 1200, output: 300, cached_input: 0 }, sessionId: "thread-test",
    }));
    const options = { outputDirectory, maxItems: 1, collector: { collect }, invoke, now: () => new Date(nowDate) };

    const first = await runCatalogReviews(makeQueue(), options);
    const record = JSON.parse(await readFile(join(outputDirectory, "records", `${candidateId}.json`), "utf8"));
    expect(first.completed).toBe(1);
    expect(record.execution_status).toBe("completed");
    expect(record.review_id).toBe(makeCatalogReviewId(candidateId, record.evidence_sha256, record.review));
    expect(record.codex_version).toBe("codex-cli 0.166.0");
    expect(record.token_usage).toEqual({ input: 1200, output: 300, cached_input: 0 });
    expect(record.policy_decision.publication_eligible).toBe(true);

    const second = await runCatalogReviews(makeQueue(), options);
    expect(second.skipped_completed).toBe(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("recollects and reviews again when the production audit listing changes", async () => {
    const outputDirectory = await tempDirectory();
    const collect = vi.fn(async (queueItem: CatalogReviewQueueItem) => {
      const evidence = makeEvidence();
      evidence.existing_listing = { ...queueItem.existing_listing };
      return evidence;
    });
    const invoke = vi.fn(async (input: EvidencePackage) => ({
      result: makeReview(input), cliVersion: "codex-cli 0.166.0", stdout: "{}\n", stderr: "", durationMs: 900,
    }));
    const original = makeQueue();
    await runCatalogReviews(original, { outputDirectory, collector: { collect }, invoke, now: () => new Date(nowDate) });

    const revised = makeQueue();
    revised.input_sha256 = "d".repeat(64);
    revised.items[0]!.existing_listing.name = "Renamed Project";
    await runCatalogReviews(revised, { outputDirectory, collector: { collect }, invoke, now: () => new Date(nowDate) });

    expect(collect).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(2);
    const record = JSON.parse(await readFile(join(outputDirectory, "records", `${candidateId}.json`), "utf8"));
    expect(record.review_id).toBe(makeCatalogReviewId(candidateId, record.evidence_sha256, record.review));
  });

  it("saves the failed attempt and stops immediately when the authenticated child CLI is blocked", async () => {
    const outputDirectory = await tempDirectory();
    const invoke = vi.fn(async () => { throw new CodexExecutionError("Operation not permitted", "subprocess_unavailable"); });
    const summary = await runCatalogReviews(makeQueue(), {
      outputDirectory,
      collector: { collect: async () => makeEvidence() },
      invoke,
      now: () => new Date(nowDate),
    });
    const record = JSON.parse(await readFile(join(outputDirectory, "records", `${candidateId}.json`), "utf8"));
    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(0);
    expect(record.execution_status).toBe("cli_failed");
    expect(record.failure_kind).toBe("subprocess_unavailable");
  });

  it("rejects an unsafe concurrency request before performing work", async () => {
    const outputDirectory = await tempDirectory();
    await expect(runCatalogReviews(makeQueue(), { outputDirectory, maxItems: 1112 }))
      .rejects.toThrow("--max-items must be an integer");
  });
});
