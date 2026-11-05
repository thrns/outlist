import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "./errors";
import { GitHubClient } from "./client";

const item = {
  id: 42,
  node_id: "R_kgDOExample",
  name: "queue-tool",
  full_name: "acme/queue-tool",
  owner: { id: 9, node_id: "O_kgDOExample", login: "acme", type: "Organization" },
  html_url: "https://github.com/acme/queue-tool",
  url: "https://api.github.com/repos/acme/queue-tool",
  description: "A queue tool",
  topics: ["developer-tools", "queues"],
  language: "TypeScript",
  stargazers_count: 50,
  forks_count: 6,
  watchers_count: 50,
  open_issues_count: 2,
  archived: false,
  disabled: false,
  fork: false,
  private: false,
  visibility: "public",
  default_branch: "main",
  created_at: "2024-01-02T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  pushed_at: "2026-10-30T00:00:00Z",
  license: { key: "mit", name: "MIT License", spdx_id: "MIT" },
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createClient(fetcher: typeof fetch) {
  return new GitHubClient({ token: null, fetch: fetcher, maxRetries: 0, maxRateLimitWaitMs: 0 });
}

describe("GitHub repository search", () => {
  it("validates sparse Search API results and preserves totals, stable IDs, and provenance", async () => {
    const calls: URL[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(new URL(String(input)));
      return json({ total_count: 1, incomplete_results: false, items: [item] }, 200, {
        "x-ratelimit-limit": "30",
        "x-ratelimit-remaining": "29",
        "x-ratelimit-reset": "1794000000",
        "x-ratelimit-resource": "search",
      });
    }) as typeof fetch;
    const result = await createClient(fetcher).searchRepositories(
      "topic:developer-tools is:public fork:false stars:0..99 created:2024-01-01..2026-11-05",
      { page: 2, perPage: 50, sort: "stars", order: "desc" },
    );

    expect(result.data).toMatchObject({
      totalCount: 1,
      incompleteResults: false,
      items: [{
        id: 42,
        fullName: "acme/queue-tool",
        canonicalUrl: "https://github.com/acme/queue-tool",
        starCount: 50,
        forkCount: 6,
        description: { state: "present", value: "A queue tool" },
        topics: { state: "present", value: ["developer-tools", "queues"] },
        license: { state: "present", value: { key: "mit" } },
      }],
    });
    expect(result.provenance).toMatchObject({
      provider: "github",
      resourceType: "repository_search",
      stableResourceIdentity: "github:search:repositories:topic%3Adeveloper-tools%20is%3Apublic%20fork%3Afalse%20stars%3A0..99%20created%3A2024-01-01..2026-11-05:page:2",
      httpStatus: 200,
      rateLimit: { remaining: 29, resource: "search" },
    });
    expect(calls[0].pathname).toBe("/search/repositories");
    expect(calls[0].searchParams.get("page")).toBe("2");
    expect(calls[0].searchParams.get("per_page")).toBe("50");
    expect(calls[0].searchParams.get("sort")).toBe("stars");
    expect(result.provenance.parsedResponseData).toEqual(result.data);
    expect(JSON.stringify(result)).not.toContain("verified_open_source");
  });

  it("represents absent search-only metadata without requiring a full repository response", async () => {
    const sparseItem = {
      id: 43,
      node_id: "R_kgDOSparse",
      name: "sparse",
      full_name: "acme/sparse",
      owner: { id: 9, login: "acme" },
      html_url: "https://github.com/acme/sparse",
      description: null,
      stargazers_count: 0,
      forks_count: 0,
      fork: false,
      private: false,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };
    const result = await createClient((async () => json({ total_count: 1, incomplete_results: false, items: [sparseItem] })) as typeof fetch)
      .searchRepositories("topic:self-hosted is:public");

    expect(result.data.items[0]).toMatchObject({
      id: 43,
      description: { state: "null" },
      primaryLanguage: { state: "absent" },
      topics: { state: "absent" },
      license: { state: "absent" },
      isArchived: { state: "absent" },
    });
  });

  it("returns incomplete results for planner review instead of treating them as exhausted", async () => {
    const result = await createClient((async () => json({ total_count: 100, incomplete_results: true, items: [] })) as typeof fetch)
      .searchRepositories("topic:developer-tools is:public");
    expect(result.data.incompleteResults).toBe(true);
    expect(result.data.totalCount).toBe(100);
  });

  it("keeps GitHub search rate limits separate and exposes the search retry time", async () => {
    const fetcher = (async () => json({ message: "API rate limit exceeded" }, 403, {
      "x-ratelimit-limit": "10",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1794003600",
      "x-ratelimit-resource": "search",
    })) as typeof fetch;
    await expect(createClient(fetcher).searchRepositories("topic:developer-tools is:public")).rejects.toMatchObject({
      kind: "rate_limit",
      rateLimit: { kind: "primary", resource: "search", remaining: 0 },
      retryAfterMs: expect.any(Number),
    });
  });

  it("does not retry invalid search queries or malformed Search API responses", async () => {
    const calls = vi.fn(async () => json({ total_count: "many", incomplete_results: false, items: [] }));
    const api = createClient(calls as unknown as typeof fetch);
    await expect(api.searchRepositories("topic:developer-tools nonsense:bad")).rejects.toThrow(/Unsupported.*qualifier/);
    expect(calls).not.toHaveBeenCalled();
    await expect(api.searchRepositories("topic:developer-tools is:public")).rejects.toMatchObject({
      kind: "malformed_payload",
      status: 200,
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("enforces GitHub's 1000-result retrieval window and endpoint sort values", async () => {
    const fetcher = vi.fn(async () => json({ total_count: 0, incomplete_results: false, items: [] }));
    const api = createClient(fetcher as unknown as typeof fetch);
    await expect(api.searchRepositories("topic:developer-tools", { page: 11, perPage: 100 })).rejects.toThrow(/page must be/);
    await expect(api.searchRepositories("topic:developer-tools", { sort: "best-match" as never })).rejects.toThrow(/sort is invalid/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces structured 422 query errors without retrying", async () => {
    const fetcher = vi.fn(async () => json({ message: "Validation Failed" }, 422));
    await expect(createClient(fetcher as unknown as typeof fetch).searchRepositories("topic:developer-tools is:public"))
      .rejects.toBeInstanceOf(GitHubApiError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
