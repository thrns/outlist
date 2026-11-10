import { describe, expect, it } from "vitest";
import type { GitHubRepository, SourceField } from "../github/types";
import type { CatalogCandidateRecord } from "./archive";
import { reviewCatalogCandidate } from "./review";

const field = <T>(value: T): SourceField<T> => ({ state: "present", value });
const noField = <T>(): SourceField<T> => ({ state: "null" });

function seed(overrides: Partial<CatalogCandidateRecord> = {}): CatalogCandidateRecord {
  return {
    schema_version: 1,
    github_repository_id: "123456",
    github_full_name: "acme/example",
    github_url: "https://github.com/acme/example",
    name: "Example",
    slug: "example",
    description: "An open-source example project.",
    tagline: "A concise project tagline",
    website_url: "https://example.org",
    primary_category: "developer-tools",
    tags: ["tooling"],
    github_topics: ["developer-tools"],
    primary_language: "TypeScript",
    stars: 100,
    forks: 10,
    license_spdx_id: "MIT",
    license_evidence_url: "https://github.com/acme/example/blob/main/LICENSE",
    license_review_status: "unverified",
    archived: false,
    visibility: "public",
    logo_candidate_url: null,
    logo_verification_status: null,
    source_urls: ["https://api.github.com/repos/acme/example"],
    source_checked_at: "2026-11-09T20:00:00Z",
    editorial_status: "pending_review",
    source_batch: 1,
    source_line: 1,
    source_batch_path: "batches/batch-001.jsonl",
    ...overrides,
  };
}

function repository(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    id: 123456,
    nodeId: "R_kgDOExample",
    owner: { id: 987, nodeId: "O_kgDOExample", login: "acme" },
    name: "example",
    fullName: "acme/example",
    canonicalUrl: "https://github.com/acme/example",
    description: field("An example project built for teams."),
    homepage: field("https://example.org"),
    topics: field(["developer-tools", "typescript"]),
    primaryLanguage: field("TypeScript"),
    languageBytes: noField(),
    starCount: 100,
    forkCount: 10,
    watcherCount: 100,
    openIssueCount: 2,
    isArchived: false,
    isDisabled: false,
    isFork: false,
    isPrivate: false,
    visibility: field("public"),
    defaultBranch: field("main"),
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    pushedAt: field("2026-11-01T00:00:00Z"),
    license: field({
      key: "mit", name: "MIT License", spdxId: field("MIT"),
      url: field("https://api.github.com/licenses/mit"),
      htmlUrl: field("https://github.com/acme/example/blob/main/LICENSE"),
      nodeId: field("MDc6TGljZW5zZW1pdA=="),
    }),
    ...overrides,
  };
}

const current = (repo: GitHubRepository) => ({
  repository: repo,
  fetchedAt: "2026-11-09T20:05:00Z",
  sourceUrl: "https://api.github.com/repositories/123456",
  httpStatus: 200,
});

const assessment = {
  quality: { status: "eligible_for_review", qualityStatus: "unreviewed", flags: [] },
  classification: { status: "classified", confidence: "high", primaryCategoryId: "e6b658c0-29db-4a33-9b63-d11ba80880cd", suggestions: [{ categorySlug: "developer-tools", confidence: "high" }] },
  license: { status: "recognized_osi_approved", identifier: "MIT", projectLicenseStatus: "unverified", evidence: [{ method: "repository_metadata", state: "present", value: "MIT" }] },
};

describe("catalog candidate review", () => {
  it("keeps an offline candidate in manual review until current source checks run", () => {
    const report = reviewCatalogCandidate(seed());
    expect(report.status).toBe("requires_manual_review");
    expect(report.reasons.map(({ code }) => code)).toContain("fresh_github_check_pending");
    expect(report.reasons.map(({ code }) => code)).toContain("full_assessment_pending");
    expect(report.license.legal_verification_granted).toBe(false);
    expect(report.evidence.current_repository).toBeNull();
  });

  it("excludes private repositories and mismatched stable IDs", () => {
    const privateReport = reviewCatalogCandidate(seed(), current(repository({ isPrivate: true, visibility: field("private") })));
    expect(privateReport.status).toBe("rejected_or_excluded");
    expect(privateReport.reasons.map(({ code }) => code)).toContain("not_publicly_available");
    const mismatch = reviewCatalogCandidate(seed(), current(repository({ id: 999 })));
    expect(mismatch.status).toBe("rejected_or_excluded");
    expect(mismatch.reasons.map(({ code }) => code)).toContain("repository_id_mismatch");
  });

  it("requires review for stale activity and missing license metadata", () => {
    const stale = repository({ pushedAt: field("2024-01-01T00:00:00Z"), updatedAt: "2024-01-01T00:00:00Z" });
    const staleReport = reviewCatalogCandidate(seed(), current(stale), null, new Date("2026-11-09T20:00:00Z"));
    expect(staleReport.status).toBe("requires_manual_review");
    expect(staleReport.reasons.map(({ code }) => code)).toContain("stale_repository_activity");
    const noLicense = repository({ license: noField() });
    const noLicenseReport = reviewCatalogCandidate(seed(), current(noLicense));
    expect(noLicenseReport.license.review_status).toBe("needs_review");
    expect(noLicenseReport.required_follow_up).toContain("manually_review_license_evidence");
  });

  it("can recommend a fully assessed candidate without granting legal approval", () => {
    const report = reviewCatalogCandidate(seed(), current(repository()), assessment, new Date("2026-11-09T20:00:00Z"));
    expect(report.status).toBe("eligible_for_automated_editorial_recommendation");
    expect(report.recommendation).toBe("consider_for_editorial_review");
    expect(report.license.review_status).toBe("unverified");
    expect(report.license.legal_verification_granted).toBe(false);
    expect(report.required_follow_up).toContain("manually_verify_license_terms");
  });

  it("routes conflicting license IDs and classifications to manual review", () => {
    const currentLicense = repository({ license: field({
      key: "apache-2.0", name: "Apache License 2.0", spdxId: field("Apache-2.0"),
      url: field("https://api.github.com/licenses/apache-2.0"),
      htmlUrl: field("https://github.com/acme/example/blob/main/LICENSE"),
      nodeId: field("MDc6TGljZW5zZWFwYWNoZTI=")
    }) });
    const conflict = reviewCatalogCandidate(seed(), current(currentLicense), assessment, new Date("2026-11-09T20:00:00Z"));
    expect(conflict.status).toBe("requires_manual_review");
    expect(conflict.reasons.map(({ code }) => code)).toContain("license_evidence_changed_or_flagged");

    const ambiguousClass = reviewCatalogCandidate(seed(), current(repository()), {
      ...assessment,
      classification: { status: "conflicting_signals", confidence: "low", primaryCategoryId: null, suggestions: [] },
    }, new Date("2026-11-09T20:00:00Z"));
    expect(ambiguousClass.status).toBe("requires_manual_review");
    expect(ambiguousClass.reasons.map(({ code }) => code)).toContain("classification_needs_review");
  });

  it("rejects candidates whose source-backed assessment is ineligible", () => {
    const report = reviewCatalogCandidate(seed(), current(repository()), {
      ...assessment,
      quality: { status: "ineligible", qualityStatus: "needs_review", flags: [{ code: "access_or_identity", severity: "blocking", evidence: ["repository.visibility"] }] },
    });
    expect(report.status).toBe("rejected_or_excluded");
    expect(report.reasons.map(({ code }) => code)).toContain("assessment_ineligible");
  });
});
