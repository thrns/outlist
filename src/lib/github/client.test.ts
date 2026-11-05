import { describe, expect, it, vi } from "vitest";
import { runInspectCli, parseInspectArguments } from "../../../scripts/github-inspect";
import { GitHubApiError } from "./errors";
import { GitHubClient } from "./client";
import { validateNextPageUrl } from "./pagination";
import { parseRateLimitHeaders } from "./rate-limit";
import { sourceField } from "./types";

const repositoryFixture = {
  id: 129_800_813,
  node_id: "R_kgDOB7jzLQ",
  name: "next.js",
  full_name: "vercel/next.js",
  owner: {
    id: 149_850_20,
    node_id: "O_kgDOBJQ5nA",
    login: "vercel",
    type: "Organization",
  },
  html_url: "https://github.com/vercel/next.js",
  url: "https://api.github.com/repos/vercel/next.js",
  description: "The React Framework",
  homepage: "https://nextjs.org",
  topics: ["framework", "nextjs", "react"],
  language: "TypeScript",
  stargazers_count: 100_000,
  forks_count: 25_000,
  watchers_count: 1_500,
  open_issues_count: 2_500,
  archived: false,
  disabled: false,
  fork: false,
  private: false,
  visibility: "public",
  default_branch: "canary",
  created_at: "2016-10-05T23:32:51Z",
  updated_at: "2026-11-04T14:21:00Z",
  pushed_at: "2026-11-04T13:58:10Z",
  license: {
    key: "mit",
    name: "MIT License",
    spdx_id: "MIT",
    url: "https://api.github.com/licenses/mit",
    html_url: "https://github.com/vercel/next.js/blob/canary/LICENSE",
    node_id: "MDc6TGljZW5zZW1pdA==",
  },
} as const;

const releaseFixture = {
  id: 1_234_567,
  node_id: "RE_kwDOB7jzLQ4Hj3",
  tag_name: "v16.0.0",
  name: "Next.js 16",
  url: "https://api.github.com/repos/vercel/next.js/releases/1234567",
  html_url: "https://github.com/vercel/next.js/releases/tag/v16.0.0",
  created_at: "2026-10-20T12:00:00Z",
  published_at: "2026-10-20T12:30:00Z",
  draft: false,
  prerelease: false,
} as const;

type Call = { url: string; init?: RequestInit };
type Responder = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("content-type") && status !== 304) {
    responseHeaders.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: responseHeaders });
}

function mockFetch(responder: Responder | Response | Response[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = Array.isArray(responder) ? [...responder] : undefined;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, init });
    if (queue) {
      const next = queue.shift();
      if (!next) throw new Error("Unexpected extra mocked request.");
      return next;
    }
    return typeof responder === "function" ? responder(url, init) : responder;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function client(fetch: typeof globalThis.fetch, options: Partial<ConstructorParameters<typeof GitHubClient>[0]> = {}) {
  return new GitHubClient({ token: null, fetch, ...options });
}

function repoResponse(payload: unknown = repositoryFixture): Response {
  return response(payload);
}

describe("GitHub REST adapter", () => {
  it("validates repository metadata and returns stable identity with provenance", async () => {
    const mock = mockFetch(repoResponse());
    const result = await client(mock.fetch).getRepository("vercel", "next.js");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data).toMatchObject({
      id: repositoryFixture.id,
      nodeId: repositoryFixture.node_id,
      owner: { login: "vercel", id: repositoryFixture.owner.id },
      fullName: "vercel/next.js",
      canonicalUrl: "https://github.com/vercel/next.js",
      starCount: 100_000,
      forkCount: 25_000,
      watcherCount: 1_500,
      openIssueCount: 2_500,
      isArchived: false,
      isDisabled: false,
      isFork: false,
      isPrivate: false,
      defaultBranch: { state: "present", value: "canary" },
    });
    expect(result.provenance).toMatchObject({
      provider: "github",
      resourceType: "repository",
      stableResourceIdentity: `github:repository:${repositoryFixture.id}`,
      sourceApiUrl: "https://api.github.com/repos/vercel/next.js",
      httpStatus: 200,
      apiVersion: "2022-11-28",
    });
    expect(result.provenance.parsedResponseData).toEqual(result.data);
  });

  it("keeps numeric repository identity stable through a rename and uses the canonical path for subresources", async () => {
    const renamed = { ...repositoryFixture, name: "framework", full_name: "vercel/framework", html_url: "https://github.com/vercel/framework", url: "https://api.github.com/repos/vercel/framework" };
    const mock = mockFetch((url) => {
      if (url.pathname === "/repos/vercel/old-name") return repoResponse(renamed);
      if (url.pathname === "/repos/vercel/framework/languages") return response({ TypeScript: 800, Rust: 200 });
      throw new Error(`Unexpected URL ${url.href}`);
    });
    const api = client(mock.fetch);
    const repository = await api.getRepository("vercel", "old-name");
    const languages = await api.getRepositoryLanguages("vercel", "old-name");

    expect(repository.kind).toBe("ok");
    if (repository.kind === "ok") expect(repository.data.id).toBe(repositoryFixture.id);
    expect(mock.calls[1].url).toBe("https://api.github.com/repos/vercel/framework/languages");
    expect(languages.kind).toBe("ok");
    if (languages.kind === "ok") {
      expect(languages.provenance.stableResourceIdentity).toBe(`github:repository:${repositoryFixture.id}:languages`);
    }
  });

  it("retrieves by numeric repository ID", async () => {
    const mock = mockFetch((url) => {
      expect(url.pathname).toBe(`/repositories/${repositoryFixture.id}`);
      return repoResponse();
    });
    const result = await client(mock.fetch).getRepositoryById(repositoryFixture.id);
    expect(result.kind).toBe("ok");
    expect(mock.calls[0].url).toBe(`https://api.github.com/repositories/${repositoryFixture.id}`);
  });

  it("parses language bytes, topics, license metadata, and release fields", async () => {
    const mock = mockFetch((url) => {
      if (url.pathname.endsWith("/languages")) return response({ TypeScript: 1200, Rust: 350 });
      if (url.pathname.endsWith("/topics")) return response({ names: ["react", "framework"] });
      if (url.pathname.endsWith("/license")) return response({ license: repositoryFixture.license });
      if (url.pathname.endsWith("/releases")) return response([releaseFixture]);
      return repoResponse();
    });
    const api = client(mock.fetch);
    const languages = await api.getRepositoryLanguages("vercel", "next.js");
    const topics = await api.getRepositoryTopics("vercel", "next.js");
    const license = await api.getRepositoryLicense("vercel", "next.js");
    const releases = await api.getRepositoryReleases("vercel", "next.js", { perPage: 10 });

    expect(languages.kind === "ok" && languages.data).toEqual({ TypeScript: 1200, Rust: 350 });
    expect(topics.kind === "ok" && topics.data).toEqual(["react", "framework"]);
    expect(license.kind === "ok" && license.data).toEqual({
      state: "available",
      license: {
        key: "mit",
        name: "MIT License",
        spdxId: { state: "present", value: "MIT" },
        url: { state: "present", value: "https://api.github.com/licenses/mit" },
        htmlUrl: { state: "present", value: "https://github.com/vercel/next.js/blob/canary/LICENSE" },
        nodeId: { state: "present", value: "MDc6TGljZW5zZW1pdA==" },
      },
    });
    expect(releases.kind === "ok" && releases.data[0]).toMatchObject({
      id: releaseFixture.id,
      tagName: "v16.0.0",
      name: { state: "present", value: "Next.js 16" },
      publishedAt: { state: "present", value: releaseFixture.published_at },
      isDraft: false,
      isPrerelease: false,
    });
  });

  it("preserves optional fields as absent or null and does not invent values", async () => {
    const withoutLicense = Object.fromEntries(
      Object.entries(repositoryFixture).filter(([key]) => key !== "license"),
    );
    const sparse = { ...withoutLicense, description: null, homepage: null, language: null, pushed_at: null };
    const mock = mockFetch(repoResponse(sparse));
    const result = await client(mock.fetch).getRepository("vercel", "next.js");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.license).toEqual({ state: "absent" });
    expect(result.data.description).toEqual({ state: "null" });
    expect(result.data.homepage).toEqual({ state: "null" });
    expect(result.data.primaryLanguage).toEqual({ state: "null" });
    expect(result.data.pushedAt).toEqual({ state: "null" });
    expect(result.data.languageBytes.state).toBe("unavailable");
  });

  it("rejects malformed repository payloads with endpoint-specific validation", async () => {
    const mock = mockFetch(response({ id: "not-an-id", full_name: "broken" }));
    await expect(client(mock.fetch).getRepository("vercel", "next.js")).rejects.toMatchObject({
      kind: "malformed_payload",
      status: 200,
    });
  });

  it("sends documented auth and API headers without leaking credentials on errors", async () => {
    const token = "outlist-test-secret-value";
    const mock = mockFetch(response({ message: `credential ${token} rejected` }, 401, { "x-github-request-id": "REQ-123" }));
    try {
      await client(mock.fetch, { token }).getRepository("vercel", "next.js");
      throw new Error("Expected authentication error.");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
      expect(String(error)).not.toContain(token);
      expect((error as GitHubApiError).diagnostic).not.toContain(token);
      expect((error as GitHubApiError).requestId).toBe("REQ-123");
    }
    const headers = new Headers(mock.calls[0].init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("Accept")).toBe("application/vnd.github+json");
    expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(headers.get("User-Agent")).toMatch(/^outlist-github-api-adapter\//);
  });

  it("works unauthenticated and does not send an Authorization header", async () => {
    const mock = mockFetch(repoResponse());
    const result = await client(mock.fetch, { token: null }).getRepository("vercel", "next.js");
    expect(result.kind).toBe("ok");
    expect(new Headers(mock.calls[0].init?.headers).has("Authorization")).toBe(false);
  });

  it("sends conditional ETags and returns an explicit 304 result", async () => {
    const mock = mockFetch([
      repoResponse(),
      response(null, 304, { etag: 'W/"repo-etag"' }),
    ]);
    const api = client(mock.fetch);
    await api.getRepository("vercel", "next.js");
    const result = await api.getRepository("vercel", "next.js", { etag: 'W/"repo-etag"' });
    expect(new Headers(mock.calls[1].init?.headers).get("If-None-Match")).toBe('W/"repo-etag"');
    expect(result).toMatchObject({ kind: "not_modified", etag: 'W/"repo-etag"', provenance: { httpStatus: 304, stableResourceIdentity: `github:repository:${repositoryFixture.id}` } });

    const freshClientMock = mockFetch(response(null, 304));
    await expect(client(freshClientMock.fetch).getRepository("vercel", "next.js", { etag: '"cached"' })).rejects.toThrow(/repositoryId/);
  });

  it("follows release pagination links and preserves per-page provenance", async () => {
    const mock = mockFetch((url) => {
      if (url.pathname === "/repos/vercel/next.js") return repoResponse();
      if (url.searchParams.get("page") === "2") return response([{ ...releaseFixture, id: 2, tag_name: "v15.0.0" }]);
      return response([releaseFixture], 200, {
        link: `<https://api.github.com/repositories/${repositoryFixture.id}/releases?per_page=1&page=2>; rel="next"`,
        etag: '"page-1"',
      });
    });
    const result = await client(mock.fetch).getRepositoryReleases("vercel", "next.js", { perPage: 1, maxPages: 2 });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.data.map((release) => release.tagName)).toEqual(["v16.0.0", "v15.0.0"]);
      expect(result.provenance.pages).toHaveLength(2);
      expect(result.provenance.stableResourceIdentity).toBe(`github:repository:${repositoryFixture.id}:releases`);
    }
    expect(mock.calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/vercel/next.js",
      "https://api.github.com/repos/vercel/next.js/releases?per_page=1",
      `https://api.github.com/repositories/${repositoryFixture.id}/releases?per_page=1&page=2`,
    ]);
  });

  it("follows numeric-ID topic pagination links and returns aggregated provenance", async () => {
    const mock = mockFetch((url) => {
      if (url.pathname === "/repos/vercel/next.js") return repoResponse();
      if (url.searchParams.get("page") === "2") return response({ names: ["server-rendering"] });
      return response({ names: ["react"] }, 200, {
        link: `<https://api.github.com/repositories/${repositoryFixture.id}/topics?per_page=1&page=2>; rel="next"`,
      });
    });
    const result = await client(mock.fetch).getRepositoryTopics("vercel", "next.js", { perPage: 1, maxPages: 2 });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.data).toEqual(["react", "server-rendering"]);
      expect(result.provenance.pages).toHaveLength(2);
      expect(result.provenance.stableResourceIdentity).toBe(`github:repository:${repositoryFixture.id}:topics`);
    }
    expect(mock.calls[2].url).toBe(`https://api.github.com/repositories/${repositoryFixture.id}/topics?per_page=1&page=2`);
  });

  it("detects pagination loops", async () => {
    const mock = mockFetch((url) => {
      if (url.pathname === "/repos/vercel/next.js") return repoResponse();
      return response([releaseFixture], 200, {
        link: '<https://api.github.com/repos/vercel/next.js/releases?per_page=1>; rel="next"',
      });
    });
    await expect(client(mock.fetch).getRepositoryReleases("vercel", "next.js", { perPage: 1 })).rejects.toMatchObject({
      kind: "pagination",
    });
  });

  it("enforces the configured maximum page count", async () => {
    const mock = mockFetch((url) => {
      if (url.pathname === "/repos/vercel/next.js") return repoResponse();
      const page = url.searchParams.get("page") ?? "1";
      return response([releaseFixture], 200, {
        link: `<https://api.github.com/repos/vercel/next.js/releases?per_page=1&page=${Number(page) + 1}>; rel="next"`,
      });
    });
    await expect(client(mock.fetch).getRepositoryReleases("vercel", "next.js", { perPage: 1, maxPages: 1 })).rejects.toMatchObject({
      kind: "pagination",
    });
    expect(mock.calls).toHaveLength(2);
  });

  it("rejects external and wrong-path pagination links", () => {
    const seen = new Set<string>();
    expect(() => validateNextPageUrl("https://attacker.example/collect", "/repos/vercel/next.js/releases", seen)).toThrow(/outside the expected API endpoint/);
    expect(() => validateNextPageUrl("https://api.github.com/repos/other/repo/releases?page=2", "/repos/vercel/next.js/releases", seen)).toThrow(/outside the expected API endpoint/);
    expect(() => validateNextPageUrl("https://api.github.com/repos/vercel/next.js/releases?page=2&token=secret", "/repos/vercel/next.js/releases", seen)).toThrow(/unexpected pagination parameters/);
  });

  it("parses primary rate limits and returns required wait details above the configured maximum", async () => {
    const now = Date.UTC(2026, 10, 5);
    const mock = mockFetch(response({ message: "API rate limit exceeded" }, 403, {
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(now / 1000) + 3600),
      "x-ratelimit-resource": "core",
    }));
    await expect(client(mock.fetch, { now: () => now, maxRateLimitWaitMs: 500 }).getRepository("vercel", "next.js")).rejects.toMatchObject({
      kind: "rate_limit",
      status: 403,
      retryAfterMs: 3_600_000,
      rateLimit: { kind: "primary", remaining: 0, resource: "core" },
    });
    const parsed = parseRateLimitHeaders(new Headers({ "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794000000", "x-ratelimit-resource": "core" }), now);
    expect(parsed).toMatchObject({ limit: 60, remaining: 0, resource: "core", kind: "primary" });
  });

  it("respects secondary rate-limit Retry-After before retrying", async () => {
    const sleep = vi.fn(async () => {});
    const mock = mockFetch([
      response({ message: "You have exceeded a secondary rate limit" }, 429, {
        "retry-after": "2",
        "x-ratelimit-remaining": "20",
        "x-ratelimit-resource": "core",
      }),
      repoResponse(),
    ]);
    const result = await client(mock.fetch, { sleep, maxRateLimitWaitMs: 5_000 }).getRepository("vercel", "next.js");
    expect(result.kind).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(2_000, undefined);
    expect(mock.calls).toHaveLength(2);
  });

  it("retries bounded transient server failures with backoff", async () => {
    const sleep = vi.fn(async () => {});
    const mock = mockFetch([response({ message: "server error" }, 503), repoResponse()]);
    const result = await client(mock.fetch, { sleep, random: () => 0, maxRetries: 1 }).getRepository("vercel", "next.js");
    expect(result.kind).toBe("ok");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(125, undefined);
    expect(mock.calls).toHaveLength(2);

    const exhausted = mockFetch([response({}, 503), response({}, 503)]);
    await expect(client(exhausted.fetch, { maxRetries: 1, sleep: async () => {} }).getRepository("vercel", "next.js")).rejects.toMatchObject({ kind: "server", status: 503 });
    expect(exhausted.calls).toHaveLength(2);
  });

  it.each([401, 404, 422])("does not retry permanent HTTP %i responses", async (status) => {
    const mock = mockFetch(response({ message: "permanent error" }, status));
    const expectedKind = status === 401 ? "unauthorized" : status === 404 ? "not_found" : "validation";
    await expect(client(mock.fetch, { maxRetries: 4 }).getRepository("vercel", "next.js")).rejects.toMatchObject({ kind: expectedKind });
    expect(mock.calls).toHaveLength(1);
  });

  it("distinguishes caller aborts from request timeouts", async () => {
    const controller = new AbortController();
    controller.abort();
    const neverFetch = mockFetch(repoResponse());
    await expect(client(neverFetch.fetch).getRepository("vercel", "next.js", { signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
    expect(neverFetch.calls).toHaveLength(0);

    const timeoutFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")), { once: true });
    })) as typeof fetch;
    await expect(client(timeoutFetch, { timeoutMs: 5, maxRetries: 0 }).getRepository("vercel", "next.js")).rejects.toMatchObject({ kind: "timeout" });
  });

  it("retries network errors within the configured bound", async () => {
    let attempts = 0;
    const fetch = (async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket closed");
      return repoResponse();
    }) as typeof globalThis.fetch;
    const result = await client(fetch, { maxRetries: 1, random: () => 0, sleep: async () => {} }).getRepository("vercel", "next.js");
    expect(result.kind).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("rejects unexpected content types and malformed JSON", async () => {
    const html = mockFetch(new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(client(html.fetch).getRepository("vercel", "next.js")).rejects.toMatchObject({ kind: "unexpected_content_type" });
    const malformed = mockFetch(new Response("{bad", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client(malformed.fetch).getRepository("vercel", "next.js")).rejects.toMatchObject({ kind: "malformed_payload" });
  });

  it("redacts credential-like diagnostics and keeps user-facing errors safe", async () => {
    const token = "outlist test credential value";
    const mock = mockFetch(response({ message: `Bad credentials: ${token}` }, 401));
    try {
      await client(mock.fetch, { token }).getRepository("vercel", "next.js");
      throw new Error("Expected error");
    } catch (error) {
      expect((error as GitHubApiError).diagnostic).toBe("Bad credentials: [redacted]");
      expect((error as Error).message).not.toContain(token);
    }
  });

  it("keeps missing and ambiguous GitHub license information unverified", async () => {
    const noLicense = { ...repositoryFixture, license: null };
    const mock = mockFetch((url) => {
      if (url.pathname.endsWith("/license")) return response({ message: "Not Found" }, 404);
      return repoResponse(noLicense);
    });
    const api = client(mock.fetch);
    const repository = await api.getRepository("vercel", "next.js");
    const license = await api.getRepositoryLicense("vercel", "next.js");
    expect(repository.kind === "ok" && repository.data.license).toEqual({ state: "null" });
    expect(license).toMatchObject({
      kind: "ok",
      data: { state: "unavailable", reason: "not_detected_or_access_restricted" },
      provenance: { httpStatus: 404, stableResourceIdentity: `github:repository:${repositoryFixture.id}:license` },
    });
    expect(JSON.stringify(license)).not.toContain("verified_open_source");
  });

  it("preserves NOASSERTION as a source SPDX identifier without verifying a license", async () => {
    const payload = {
      ...repositoryFixture,
      license: { ...repositoryFixture.license, spdx_id: "NOASSERTION" },
    };
    const mock = mockFetch(repoResponse(payload));
    const result = await client(mock.fetch).getRepository("vercel", "next.js");
    expect(result.kind === "ok" && result.data.license).toMatchObject({
      state: "present",
      value: { spdxId: { state: "present", value: "NOASSERTION" } },
    });
    expect(JSON.stringify(result)).not.toContain("verified_open_source");
  });

  it("supports field states for absent, null, unavailable, and unsupported values", () => {
    expect(sourceField({}, "name")).toEqual({ state: "absent" });
    expect(sourceField({ name: null }, "name")).toEqual({ state: "null" });
    expect(sourceField({ name: "x" }, "name")).toEqual({ state: "present", value: "x" });
    expect(sourceField({ name: "x" }, "name", { unavailableReason: "not fetched" })).toEqual({ state: "unavailable", reason: "not fetched" });
    expect(sourceField({ name: "x" }, "name", { supported: false, unavailableReason: "unsupported by endpoint" })).toEqual({ state: "unsupported", reason: "unsupported by endpoint" });
  });

  it("rejects invalid CLI repository names and performs no network request", async () => {
    expect(() => parseInspectArguments(["https://github.com/vercel/next.js"])).toThrow(/owner\/name/);
    expect(() => parseInspectArguments(["vercel/next.js/extra"])).toThrow(/owner\/name/);
    expect(() => parseInspectArguments(["../private/repo"])).toThrow(/owner\/name/);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runInspectCli(["https://github.com/vercel/next.js"]);
    expect(result).toBe(1);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("uses only GET requests against GitHub and does not perform database or publication writes", async () => {
    const mock = mockFetch((url) => {
      if (url.pathname.endsWith("/languages")) return response({ TypeScript: 10 });
      if (url.pathname.endsWith("/topics")) return response({ names: [] });
      if (url.pathname.endsWith("/license")) return response({ license: repositoryFixture.license });
      if (url.pathname.endsWith("/releases")) return response([]);
      if (url.pathname === "/rate_limit") return response({ resources: { core: { limit: 60, remaining: 40, reset: 1_794_000_000, used: 20 } }, rate: { limit: 60, remaining: 40, reset: 1_794_000_000, used: 20 } });
      return repoResponse();
    });
    const api = client(mock.fetch);
    await api.getRepository("vercel", "next.js");
    await api.getRepositoryLanguages("vercel", "next.js");
    await api.getRepositoryTopics("vercel", "next.js");
    await api.getRepositoryLicense("vercel", "next.js");
    await api.getRepositoryReleases("vercel", "next.js");
    await api.getRateLimit();
    expect(mock.calls.every((call) => call.url.startsWith("https://api.github.com/") && call.init?.method === "GET")).toBe(true);
    expect(mock.calls.some((call) => /supabase|database|publish/i.test(call.url))).toBe(false);
  });
});
