import { describe, expect, it } from "vitest";
import { applyCandidatePageLimit, formatSafeGitHubFailure, parseDiscoveryArguments, toCandidatePayload } from "./discover";
import { GitHubApiError } from "../src/lib/github/errors";
import type { GitHubSearchRepository } from "../src/lib/github/types";
import { getDiscoveryPlan } from "../src/lib/discovery/plans";

describe("discovery CLI safety", () => {
  it("defaults to a read-only bounded plan and requires explicit execution", () => {
    expect(parseDiscoveryArguments(["--plan", "initial"])).toMatchObject({ mode: "dry-run", maxQueries: 2, maxPages: 2, maxCandidates: 200 });
    expect(parseDiscoveryArguments(["--execute", "--resume"])).toMatchObject({ mode: "execute", resume: true });
  });

  it("rejects contradictory modes and unbounded or unsupported options", () => {
    expect(() => parseDiscoveryArguments(["--execute", "--dry-run"])).toThrow(/either/);
    expect(() => parseDiscoveryArguments(["--max-pages", "100000"])).toThrow(/integer from/);
    expect(() => parseDiscoveryArguments(["--plan", "everything"])).toThrow(/Only the approved/);
    expect(() => parseDiscoveryArguments(["--resume"])).toThrow(/requires --execute/);
  });

  it("shrinks the search page size when the candidate cap is smaller than a normal page", () => {
    const plan = getDiscoveryPlan("initial");
    const bounded = applyCandidatePageLimit(plan, 25);
    expect(bounded[0].parameters.perPage).toBe(25);
    expect(bounded[0].fingerprint).not.toBe(plan[0].fingerprint);
    expect(applyCandidatePageLimit(plan, 200)[0].parameters.perPage).toBe(100);
  });

  it("stores only validated candidate metadata and keeps license values as source summaries", () => {
    const repository: GitHubSearchRepository = {
      id: 101,
      nodeId: "R_kgDOExample",
      owner: { id: 1, nodeId: { state: "absent" }, login: "acme", type: { state: "present", value: "Organization" } },
      name: "renamed",
      fullName: "acme/renamed",
      canonicalUrl: "https://github.com/acme/renamed",
      description: { state: "present", value: "A repository" },
      homepage: { state: "absent" },
      topics: { state: "present", value: ["developer-tools"] },
      primaryLanguage: { state: "present", value: "TypeScript" },
      starCount: 20,
      forkCount: 3,
      watcherCount: { state: "absent" },
      openIssueCount: { state: "absent" },
      isArchived: { state: "present", value: false },
      isDisabled: { state: "absent" },
      isFork: false,
      isPrivate: false,
      visibility: { state: "present", value: "public" },
      defaultBranch: { state: "absent" },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
      pushedAt: { state: "null" },
      license: {
        state: "present",
        value: {
          key: "mit",
          name: "MIT License",
          spdxId: { state: "present", value: "MIT" },
          url: { state: "absent" },
          htmlUrl: { state: "absent" },
          nodeId: { state: "absent" },
        },
      },
    };
    const payload = toCandidatePayload(repository);
    expect(payload).toMatchObject({
      provider_repository_id: "101",
      owner_login: "acme",
      full_name: "acme/renamed",
      stars: 20,
      source_license_summary: { key: "mit", name: "MIT License", spdx_id: "MIT" },
    });
    expect(JSON.stringify(payload)).not.toContain("verified_open_source");
    expect(JSON.stringify(payload)).not.toContain("canonical_project");
  });

  it("formats structured errors without logging response diagnostics or credentials", () => {
    const error = new GitHubApiError("rate_limit", "rate limited", {
      status: 403,
      retryable: true,
      retryAfterMs: 60_000,
      rateLimit: { resource: "search", kind: "primary", remaining: 0 },
      diagnostic: "personal access token should not be persisted",
    });
    expect(formatSafeGitHubFailure(error)).toEqual({
      summary: "rate_limit; HTTP 403; resource search; retry after 60s",
      kind: "rate_limit",
      retryable: true,
      retryAfterMs: 60_000,
    });
    expect(formatSafeGitHubFailure(error).summary).not.toContain("token");
  });
});
