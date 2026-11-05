import { describe, expect, it, vi } from "vitest";
import { formatSafeGitHubFailure, parseDiscoveryArguments, runDiscoveryCli, toCandidatePayload, type DiscoveryCliDependencies } from "./discover";
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

  it("keeps query page size and fingerprint stable when the candidate budget changes", () => {
    const plan = getDiscoveryPlan("initial");
    const outputs: string[] = [];
    const writeStdout = (text: string) => outputs.push(text);
    const firstFingerprint = plan[0].fingerprint;
    return Promise.all([
      runDiscoveryCli(["--max-candidates", "25"], { writeStdout }),
      runDiscoveryCli(["--max-candidates", "200"], { writeStdout }),
    ]).then(() => {
      const first = JSON.parse(outputs[0] ?? "{}") as { partitions: Array<{ parameters: { perPage: number }; fingerprint: string }> };
      const second = JSON.parse(outputs[1] ?? "{}") as { partitions: Array<{ parameters: { perPage: number }; fingerprint: string }> };
      expect(first.partitions[0]?.parameters.perPage).toBe(100);
      expect(second.partitions[0]?.parameters.perPage).toBe(100);
      expect(first.partitions[0]?.fingerprint).toBe(firstFingerprint);
      expect(second.partitions[0]?.fingerprint).toBe(firstFingerprint);
    });
  });

  it("reports invalid Supabase configuration without starting or summarizing a job", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not-a-valid-url");
    vi.stubEnv("SUPABASE_SECRET_KEY", "fixture-secret-that-must-not-leak");
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const status = await runDiscoveryCli(["--execute"], {
        writeStdout: (text) => stdout.push(text),
        writeStderr: (text) => stderr.push(text),
      });
      expect(status).toBe(1);
      expect(stdout.join("")).not.toContain("job_started");
      expect(stdout.join("")).not.toContain("discovery_summary");
      expect(stderr.join("")).toContain('"stage":"database_configuration"');
      expect(stderr.join("")).toContain("NEXT_PUBLIC_SUPABASE_URL");
      expect(stderr.join("")).toContain("SUPABASE_SECRET_KEY");
      expect(stderr.join("")).not.toContain("fixture-secret-that-must-not-leak");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("distinguishes PostgREST connection failures from GitHub failures", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "fixture-postgrest-secret");
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const failedDatabase = {
        rpc: vi.fn(async () => ({ data: null, error: { message: "fetch failed fixture-postgrest-secret", code: "PGRST000", status: 503 } })),
      } as unknown as NonNullable<DiscoveryCliDependencies["supabase"]>;
      const status = await runDiscoveryCli(["--execute"], {
        supabase: failedDatabase,
        github: { searchRepositories: vi.fn() } as unknown as NonNullable<DiscoveryCliDependencies["github"]>,
        writeStdout: (text) => stdout.push(text),
        writeStderr: (text) => stderr.push(text),
      });
      expect(status).toBe(1);
      expect(stdout.join("")).not.toContain("job_started");
      expect(stdout.join("")).not.toContain("discovery_summary");
      expect(stderr.join("")).toContain('"stage":"database_connection"');
      expect(stderr.join("")).toContain("PostgREST is unreachable");
      expect(stderr.join("")).not.toContain("fixture-postgrest-secret");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("releases an oversized page without advancing the checkpoint past its candidate budget", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const claim = {
      id: "query-budget",
      partition_key: "budget-query",
      query_text: "topic:fixture is:public",
      query_parameters: { sort: "stars", order: "desc", per_page: 100 },
      query_fingerprint: "budget-fingerprint",
      cursor: null,
      total_count: null,
      incomplete_results: false,
      lease_token: "00000000-0000-0000-0000-000000000002",
    };
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_discovery_job") return { data: "job-budget", error: null };
      if (name === "claim_discovery_partitions") return { data: [claim], error: null };
      return { data: null, error: null };
    });
    const database = {
      rpc,
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: [{ status: "pending" }], error: null }),
        }),
      }),
    } as unknown as NonNullable<DiscoveryCliDependencies["supabase"]>;
    const github = {
      searchRepositories: vi.fn(async () => ({
        data: {
          items: [{ id: 41, isPrivate: false }, { id: 42, isPrivate: false }],
          totalCount: 2,
          incompleteResults: false,
        },
        provenance: {},
      })),
    } as unknown as NonNullable<DiscoveryCliDependencies["github"]>;
    const status = await runDiscoveryCli(["--execute", "--max-queries", "1", "--max-pages", "1", "--max-candidates", "1"], {
      supabase: database,
      github,
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    });
    expect(status).toBe(0);
    expect(rpc).toHaveBeenCalledWith("release_discovery_partition", expect.any(Object));
    expect(rpc).not.toHaveBeenCalledWith("commit_discovery_page", expect.any(Object));
    const summary = stdout.map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.event === "discovery_summary");
    expect(summary).toMatchObject({ pages_committed: 0, candidates_seen: 0 });
    expect(stdout.join("")).not.toContain("page_committed");
    expect(stderr).toEqual([]);
  });

  it("does not report candidate counts when the page commit fails", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const claim = {
      id: "query-1",
      partition_key: "test-query",
      query_text: "topic:fixture is:public",
      query_parameters: { sort: "stars", order: "desc", per_page: 1 },
      query_fingerprint: "fingerprint-1",
      cursor: null,
      total_count: null,
      incomplete_results: false,
      lease_token: "00000000-0000-0000-0000-000000000001",
    };
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_discovery_job") return { data: "job-1", error: null };
      if (name === "claim_discovery_partitions") return { data: [claim], error: null };
      if (name === "commit_discovery_page") return { data: null, error: { message: "commit rejected", code: "40001" } };
      return { data: null, error: null };
    });
    const database = { rpc } as unknown as NonNullable<DiscoveryCliDependencies["supabase"]>;
    const github = {
      searchRepositories: vi.fn(async () => ({
        data: { items: [], totalCount: 0, incompleteResults: false },
        provenance: {
          fetchedAt: "2026-11-05T12:00:00.000Z",
          sourceApiUrl: "https://api.github.com/search/repositories?q=topic%3Afixture&page=1&per_page=1",
          httpStatus: 200,
          apiVersion: "2022-11-28",
          resourceType: "repository_search",
          stableResourceIdentity: "fixture",
        },
      })),
    } as unknown as NonNullable<DiscoveryCliDependencies["github"]>;
    const status = await runDiscoveryCli(["--execute", "--max-candidates", "1"], {
      supabase: database,
      github,
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    });
    expect(status).toBe(1);
    expect(stdout.join("")).toContain("job_started");
    expect(stdout.join("")).not.toContain("page_committed");
    expect(stdout.join("")).not.toContain("candidates_seen");
    expect(stdout.join("")).not.toContain("discovery_summary");
    expect(stderr.join("")).toContain('"stage":"database_operation"');
    expect(rpc).toHaveBeenCalledWith("finish_discovery_job", expect.any(Object));
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
