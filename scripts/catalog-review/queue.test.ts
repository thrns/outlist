import { describe, expect, it } from "vitest";
import { buildCatalogReviewQueue } from "./queue";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];

function fixture(index: number, options: { project?: boolean; failed?: boolean } = {}) {
  const repositoryId = String(9000 + index);
  const fullName = `fixture/project-${index}`;
  const projectId = options.project ? `10000000-0000-4000-8000-00000000000${index}` : null;
  const enrichmentStatus = options.failed ? "failed" : "succeeded";
  return {
    ledger: {
      batch: 1, line: index + 1, github_repository_id: repositoryId, github_full_name: fullName,
      candidate_id: ids[index], status: "succeeded", excluded: false,
    },
    audit: {
      schema: "outlist.catalog.editorial-audit.v1",
      input: { batch: 1, line: index + 1, github_repository_id: repositoryId, github_full_name: fullName, catalog_sha256: "a".repeat(64) },
      import: { candidate_id: ids[index], status: "succeeded", excluded: false },
      listing_proposal: { name: `Project ${index}`, tagline: "A useful open source software project.", description: "A project description.", primary_category: "developer-tools", tags: ["software"] },
      assessment: {
        project_id: projectId,
        enrichment_status: enrichmentStatus,
        enrichment_error: options.failed ? "release payload exceeded size limit" : null,
        assessment_status: options.project ? "assessed" : "needs_review",
        classification_status: options.project ? "classified" : "insufficient_evidence",
        publication_status: options.project ? "pending_review" : "no_project_draft",
        project_categories_current: [], project_tags_current: [],
      },
    },
  };
}

describe("buildCatalogReviewQueue", () => {
  it("reconciles all imported rows and sorts them by batch and line", () => {
    const rows = [fixture(2, { failed: true }), fixture(0, { project: true }), fixture(1)];
    const queue = buildCatalogReviewQueue(rows.map((row) => row.ledger), rows.map((row) => row.audit), "2026-11-10T00:00:00.000Z");

    expect(queue.items.map((item) => item.candidate_id)).toEqual([ids[0], ids[1], ids[2]]);
    expect(queue.counts).toEqual({ total: 3, drafts: 1, assessment_holds: 1, enrichment_failures: 1 });
    expect(queue.items[0]?.existing_listing.name).toBe("Project 0");
  });

  it("rejects candidate or repository identity mismatches instead of silently dropping rows", () => {
    const row = fixture(0);
    expect(() => buildCatalogReviewQueue([row.ledger], [{ ...row.audit, input: { ...row.audit.input, github_full_name: "someone/else" } }]))
      .toThrow("Candidate identity or import provenance mismatch");
  });

  it("rejects duplicate stable repository IDs", () => {
    const row = fixture(0);
    const duplicate = { ...row.ledger, line: 2, candidate_id: ids[1] };
    expect(() => buildCatalogReviewQueue([row.ledger, duplicate], [row.audit, { ...row.audit, input: { ...row.audit.input, line: 2 }, import: { ...row.audit.import, candidate_id: ids[1] } }]))
      .toThrow("Duplicate repository ID");
  });
});
