import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CatalogReviewQueueItem } from "./queue";
import type { OutlistCatalogSnapshot } from "./catalog";
import { buildCatalogDuplicateCheck } from "./duplicates";

const now = new Date("2026-11-10T12:00:00.000Z");
const item: CatalogReviewQueueItem = {
  queue_key: "001:0001:00000000-0000-4000-8000-000000000041", batch: 1, line: 1,
  repository_id: "123456", full_name: "Acme/Tool", candidate_id: "00000000-0000-4000-8000-000000000041",
  project_id: "00000000-0000-4000-8000-000000000042", pipeline_outcome: "draft_pending_review",
  pipeline_details: { enrichment_status: "succeeded", enrichment_error: null, assessment_status: "needs_review", classification_status: "classified", publication_status: "pending_review" },
  existing_listing: { name: "Tool", summary: "A useful software tool for teams.", description: "A software tool.", categories: ["developer-tools"], tags: [], official_website_url: null },
  source_record_sha256: "a".repeat(64),
};

function snapshot(options: { repositories?: OutlistCatalogSnapshot["repositories"]; candidates?: OutlistCatalogSnapshot["candidates"]; projects?: OutlistCatalogSnapshot["projects"] } = {}): OutlistCatalogSnapshot {
  const body = {
    schema: "outlist.catalog.identity-snapshot.v1" as const,
    captured_at: now.toISOString(),
    project_ref: "outlist-test",
    source_tables: ["repositories", "repository_candidates", "projects"] as ["repositories", "repository_candidates", "projects"],
    repositories: options.repositories ?? [{ id: "repo-current", provider: "github", provider_repository_id: "123456", full_name: "Acme/Tool", canonical_url: "https://github.com/Acme/Tool.git", project_id: item.project_id, is_archived: false, is_fork: false, availability_status: "available" }],
    candidates: options.candidates ?? [{ id: item.candidate_id, provider: "github", provider_repository_id: "123456", full_name: "acme/tool", canonical_url: "https://github.com/acme/tool", repository_id: "repo-current", queue_status: "succeeded" }],
    projects: options.projects ?? [{ id: item.project_id!, slug: "tool", name: "Tool", primary_repository_id: "repo-current", publication_status: "pending_review" }],
  };
  return { ...body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

describe("Outlist catalog duplicate checks", () => {
  it("recognizes the current imported candidate and its own project as the same listing", () => {
    const result = buildCatalogDuplicateCheck(item, snapshot(), { fork: false }, now);
    expect(result.candidate_identity_verified).toBe(true);
    expect(result.current_candidate_matches).toBe(1);
    expect(result.exact_repository_matches).toHaveLength(1);
    expect(result.exact_repository_matches[0]?.current_candidate_repository).toBe(true);
    expect(result.project_associations).toHaveLength(1);
    expect(result.duplicate_imported_candidates).toHaveLength(0);
    expect(result.duplicate_public_product_listings).toHaveLength(0);
    expect(result.has_material_duplicate_conflict).toBe(false);
  });

  it("detects a duplicate imported candidate by stable repository ID", () => {
    const base = snapshot();
    const secondCandidate = { ...base.candidates[0]!, id: "00000000-0000-4000-8000-000000000099" };
    const result = buildCatalogDuplicateCheck(item, snapshot({ candidates: [...base.candidates, secondCandidate] }), null, now);
    expect(result.duplicate_imported_candidates).toHaveLength(1);
    expect(result.duplicate_public_product_listings).toHaveLength(0);
    expect(result.has_material_duplicate_conflict).toBe(true);
  });

  it("separates a canonical-name candidate conflict from an exact duplicate imported candidate", () => {
    const base = snapshot();
    const separateIdentity = { ...base.candidates[0]!, id: "00000000-0000-4000-8000-000000000098", provider_repository_id: "654321" };
    const result = buildCatalogDuplicateCheck(item, snapshot({ candidates: [...base.candidates, separateIdentity] }), null, now);
    expect(result.duplicate_imported_candidates).toHaveLength(0);
    expect(result.candidate_canonical_identity_conflicts).toHaveLength(1);
    expect(result.has_material_duplicate_conflict).toBe(true);
  });

  it("detects canonical repository identity collisions despite URL casing and trailing .git", () => {
    const base = snapshot();
    const conflictingRepository = { ...base.repositories[0]!, id: "repo-conflict", provider_repository_id: "999999", full_name: "Elsewhere/tool", canonical_url: "https://github.com/acme/TOOL/" };
    const result = buildCatalogDuplicateCheck(item, snapshot({ repositories: [...base.repositories, conflictingRepository] }), null, now);
    expect(result.canonical_identity_conflicts).toHaveLength(1);
    expect(result.has_material_duplicate_conflict).toBe(true);
  });

  it("links fork ancestry to an existing public product listing", () => {
    const base = snapshot();
    const upstream = { id: "repo-upstream", provider: "github", provider_repository_id: "555555", full_name: "upstream/original", canonical_url: "https://github.com/upstream/original", project_id: "public-project", is_archived: false, is_fork: false, availability_status: "available" };
    const result = buildCatalogDuplicateCheck(item, snapshot({
      repositories: [...base.repositories, upstream],
      projects: [...base.projects, { id: "public-project", slug: "original", name: "Original", primary_repository_id: "repo-upstream", publication_status: "published" }],
    }), { fork: true, parent: { id: 555555, full_name: "upstream/original", html_url: "https://github.com/upstream/original" } }, now);
    expect(result.fork_or_mirror_upstream_matches).toHaveLength(1);
    expect(result.duplicate_public_product_listings).toHaveLength(1);
    expect(result.duplicate_public_product_listings[0]?.project_id).toBe("public-project");
  });

  it("links a configured cross-provider mirror URL to an existing public product listing", () => {
    const base = snapshot();
    const mirror = { id: "repo-mirror", provider: "gitlab", provider_repository_id: "gitlab-123", full_name: "acme/tool", canonical_url: "https://gitlab.com/acme/tool.git", project_id: "public-project", is_archived: false, is_fork: false, availability_status: "available" };
    const result = buildCatalogDuplicateCheck(item, snapshot({
      repositories: [...base.repositories, mirror],
      projects: [...base.projects, { id: "public-project", slug: "mirror", name: "Mirror", primary_repository_id: "repo-mirror", publication_status: "published" }],
    }), { mirror_url: "https://gitlab.com/acme/tool.git" }, now);
    expect(result.fork_or_mirror_upstream_matches).toHaveLength(1);
    expect(result.duplicate_public_product_listings).toHaveLength(1);
    expect(result.duplicate_public_product_listings[0]?.project_id).toBe("public-project");
  });

  it("does not call the candidate's own draft a duplicate public product", () => {
    const result = buildCatalogDuplicateCheck(item, snapshot(), null, now);
    expect(result.public_listing_count).toBe(0);
    expect(result.duplicate_public_product_listings).toEqual([]);
  });

  it("fails closed when the duplicate index is unavailable or stale", () => {
    expect(buildCatalogDuplicateCheck(item, null, null, now).snapshot_complete).toBe(false);
    const stale = snapshot();
    stale.captured_at = "2026-11-08T12:00:00.000Z";
    stale.sha256 = "f".repeat(64);
    expect(buildCatalogDuplicateCheck(item, stale, null, now).candidate_identity_verified).toBe(false);
  });
});
