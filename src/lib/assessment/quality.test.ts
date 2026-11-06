import { describe, expect, it } from "vitest";
import { assessRepositoryQuality, type QualityInput } from "./quality";

const base = (overrides: Partial<QualityInput> = {}): QualityInput => ({
  provider: "github", providerRepositoryId: "123", fullName: "octo/tool", canonicalUrl: "https://github.com/octo/tool",
  availabilityStatus: "available", visibility: "public", isPrivate: false, isDisabled: false, isArchived: false,
  isFork: false, description: "A useful tool", descriptionState: "present", providerCreatedAt: "2026-11-01T00:00:00.000Z",
  providerUpdatedAt: "2026-11-05T00:00:00.000Z", providerPushedAt: "2026-11-05T00:00:00.000Z",
  observedAt: "2026-11-05T00:00:00.000Z", enrichedAt: "2026-11-05T00:01:00.000Z", enrichmentComplete: true,
  releaseCount: 1, stars: 1, forks: 0, licenseStatus: "recognized_osi_approved", now: "2026-11-06T00:00:00.000Z", ...overrides,
});

describe("source-based quality screening", () => {
  it("treats archive as a review signal, not an automatic rejection", () => {
    expect(assessRepositoryQuality(base({ isArchived: true }))).toMatchObject({ status: "eligible_for_review", qualityStatus: "needs_review" });
  });
  it("does not penalize a new low-star repository", () => {
    expect(assessRepositoryQuality(base({ stars: 0, forks: 0, providerCreatedAt: "2026-11-05T00:00:00.000Z" })).flags).toHaveLength(0);
  });
  it("flags a missing description without manufacturing one", () => {
    expect(assessRepositoryQuality(base({ description: null, descriptionState: "null" })).flags[0]?.code).toBe("missing_description");
  });
  it("adds context when no release was observed", () => {
    expect(assessRepositoryQuality(base({ releaseCount: 0 })).flags.map((flag) => flag.code)).toContain("no_release_history");
  });
  it("makes incomplete enrichment explicit", () => {
    expect(assessRepositoryQuality(base({ enrichmentComplete: false })).flags.map((flag) => flag.code)).toContain("incomplete_enrichment");
  });
  it("flags stale source observations", () => {
    expect(assessRepositoryQuality(base({ observedAt: "2026-01-01T00:00:00.000Z" })).flags.map((flag) => flag.code)).toContain("stale_source");
  });
  it("treats older push activity as a review signal", () => {
    expect(assessRepositoryQuality(base({ providerPushedAt: "2025-01-01T00:00:00.000Z" })).flags.map((flag) => flag.code)).toContain("stale_activity");
  });
  it("blocks explicit private or restricted sources", () => {
    expect(assessRepositoryQuality(base({ isPrivate: true })).status).toBe("ineligible");
    expect(assessRepositoryQuality(base({ availabilityStatus: "access_restricted" })).status).toBe("ineligible");
    expect(assessRepositoryQuality(base({ visibility: null })).status).toBe("ineligible");
    expect(assessRepositoryQuality(base({ isPrivate: null })).status).toBe("ineligible");
    expect(assessRepositoryQuality(base({ isDisabled: null })).status).toBe("ineligible");
  });
  it("keeps quality unverified even when no flags are raised", () => {
    expect(assessRepositoryQuality(base())).toMatchObject({ qualityStatus: "unreviewed", status: "eligible_for_review" });
  });
  it("accepts Postgres timestamps with explicit UTC offsets", () => {
    expect(assessRepositoryQuality(base({ observedAt: "2026-11-05T00:00:00+00:00" })).status).toBe("eligible_for_review");
  });
});
