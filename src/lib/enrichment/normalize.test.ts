import { describe, expect, it } from "vitest";
import {
  normalizeRepositoryEnrichment,
  type EnrichmentResourceResults,
} from "./normalize";
import type {
  GitHubProvenance,
  GitHubRelease,
  GitHubRepository,
} from "../github/types";

const fetchedAt = "2026-11-05T12:00:00.000Z";

function repository(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    id: 912345,
    nodeId: "R_kgDOFixture",
    owner: { id: 101, nodeId: "O_fixture", login: "acme", type: "Organization" },
    name: "widget",
    fullName: "acme/widget",
    canonicalUrl: "https://github.com/acme/widget",
    description: { state: "present", value: "A useful tool" },
    homepage: { state: "null" },
    topics: { state: "present", value: ["editor"] },
    primaryLanguage: { state: "present", value: "TypeScript" },
    languageBytes: { state: "unavailable", reason: "Fetched separately." },
    starCount: 150,
    forkCount: 12,
    watcherCount: 160,
    openIssueCount: 9,
    isArchived: false,
    isDisabled: false,
    isFork: false,
    isPrivate: false,
    visibility: { state: "present", value: "public" },
    defaultBranch: { state: "present", value: "main" },
    createdAt: "2024-02-01T00:00:00.000Z",
    updatedAt: "2026-11-04T08:00:00.000Z",
    pushedAt: { state: "present", value: "2026-11-03T10:00:00.000Z" },
    license: {
      state: "present",
      value: {
        key: "mit",
        name: "MIT License",
        spdxId: { state: "present", value: "MIT" },
        url: { state: "present", value: "https://api.github.com/licenses/mit" },
        htmlUrl: { state: "present", value: "https://github.com/acme/widget/blob/main/LICENSE" },
        nodeId: { state: "absent" },
      },
    },
    ...overrides,
  };
}

function provenance<T>(resourceType: "repository" | "languages" | "topics" | "releases", data: T): GitHubProvenance<T> {
  return {
    provider: "github",
    resourceType,
    stableResourceIdentity: resourceType === "repository" ? "github:repository:912345" : `github:repository:912345:${resourceType}`,
    sourceApiUrl: resourceType === "repository"
      ? "https://api.github.com/repositories/912345"
      : `https://api.github.com/repos/acme/widget/${resourceType}`,
    fetchedAt,
    httpStatus: 200,
    etag: `"${resourceType}-etag"`,
    apiVersion: "2022-11-28",
    parsedResponseData: data,
  };
}

function release(id: number, tagName: string): GitHubRelease {
  return {
    id,
    nodeId: `REL_${id}`,
    tagName,
    name: { state: "present", value: `Release ${tagName}` },
    url: `https://api.github.com/repos/acme/widget/releases/${id}`,
    htmlUrl: `https://github.com/acme/widget/releases/tag/${tagName}`,
    createdAt: fetchedAt,
    publishedAt: { state: "present", value: fetchedAt },
    isDraft: false,
    isPrerelease: false,
  };
}

function resources(overrides: Partial<EnrichmentResourceResults> = {}): EnrichmentResourceResults {
  const topicPage = {
    ...provenance("topics", ["Editor", "editor", "developer-tools"]),
    parsedResponseData: ["Editor", "editor", "developer-tools"],
  };
  return {
    languages: { kind: "ok", data: { TypeScript: 900, CSS: 100 }, provenance: provenance("languages", { TypeScript: 900, CSS: 100 }) },
    topics: {
      kind: "ok",
      data: ["Editor", "editor", "developer-tools"],
      provenance: {
        ...provenance("topics", ["Editor", "editor", "developer-tools"]),
        pages: [topicPage],
      },
    },
    releases: {
      kind: "ok",
      data: [release(501, "v2.0.0"), release(500, "v1.9.0")],
      provenance: provenance("releases", [release(501, "v2.0.0"), release(500, "v1.9.0")]),
    },
    ...overrides,
  };
}

function normalize(repo = repository(), resourceResults = resources()) {
  return normalizeRepositoryEnrichment({
    expectedRepositoryId: "912345",
    repository: { kind: "ok", data: repo, provenance: provenance("repository", repo) },
    resources: resourceResults,
  });
}

describe("repository enrichment normalization", () => {
  it("bounds provider-authored release titles before building the database payload", () => {
    const largeReleasePage = Array.from({ length: 100 }, (_, index) => ({
      ...release(index + 1, `v${index}`),
      name: { state: "present" as const, value: "x".repeat(4000) },
    }));
    const result = normalize(repository(), resources({
      releases: { kind: "ok", data: largeReleasePage, provenance: provenance("releases", largeReleasePage) },
    }));
    expect(result.releases.entries).toHaveLength(100);
    expect(result.releases.entries.every((item) => item.version.length <= 256 && item.release_name?.length === 500)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(1_048_576);
  });

  it("preserves GitHub identity, metrics, source field states, and license evidence", () => {
    const result = normalize();
    expect(result.repository).toMatchObject({
      provider_repository_id: "912345",
      provider_node_id: "R_kgDOFixture",
      owner_login: "acme",
      repository_name: "widget",
      full_name: "acme/widget",
      canonical_url: "https://github.com/acme/widget",
      stars: 150,
      forks: 12,
      watchers: 160,
      open_issues: 9,
      description_state: { state: "present" },
      homepage_state: { state: "null" },
      license_state: { state: "present" },
      source_license_metadata: { key: "mit", name: "MIT License", spdx_id: "MIT" },
    });
    expect(result.repository.source_license_metadata).not.toHaveProperty("verified_open_source");
    expect(result.snapshot).toEqual({
      snapshot_date: "2026-11-05",
      captured_at: fetchedAt,
      stars: 150,
      forks: 12,
      source_index: 1,
    });
  });

  it("normalizes language and topic keys while preserving source spellings and bounded releases", () => {
    const result = normalize();
    expect(result.languages.entries.map(({ name, bytes }) => [name, bytes])).toEqual([["CSS", 100], ["TypeScript", 900]]);
    expect(result.topics.entries.map((topic) => topic.source_topic)).toEqual(["developer-tools", "Editor"]);
    expect(result.releases).toMatchObject({ complete: true, bounded: true });
    expect(result.releases.entries.map((item) => item.provider_release_id)).toEqual(["501", "500"]);
    expect(result.source_records[0]).toMatchObject({
      record_kind: "repository",
      source_url: "https://api.github.com/repositories/912345",
      etag: '"repository-etag"',
      source_metadata: { cache_reusable: false, validated: true },
    });
    expect(result.source_records.every((record) => !record.source_metadata || !("raw_payload" in record.source_metadata))).toBe(true);
  });

  it("distinguishes absent, null, and present optional source fields", () => {
    const repo = repository({
      description: { state: "absent" },
      homepage: { state: "null" },
      defaultBranch: { state: "present", value: "trunk" },
      license: { state: "absent" },
    });
    const result = normalize(repo);
    expect(result.repository).toMatchObject({
      description: null,
      description_state: { state: "absent" },
      homepage: null,
      homepage_state: { state: "null" },
      default_branch: "trunk",
      default_branch_state: { state: "present" },
      source_license_metadata: null,
      license_state: { state: "absent" },
      source_field_states: { description: "absent", homepage: "null", default_branch: "present", license: "absent" },
    });
  });

  it("normalizes only absolute HTTP and HTTPS homepage URLs", () => {
    const https = normalize(repository({ homepage: { state: "present", value: "https://example.com/docs" } }));
    const http = normalize(repository({ homepage: { state: "present", value: "http://example.com" } }));
    expect(https.repository.homepage).toBe("https://example.com/docs");
    expect(http.repository.homepage).toBe("http://example.com/");
    expect(https.repository.homepage_state).toEqual({ state: "present" });
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///etc/passwd",
    "example.com",
    "https:",
    "https://user:password@example.com/path",
    "https://@example.com/path",
    "https://example.com:99999/path",
    "https://example.com:/path",
    "https://example.com/%zz",
    "https:///example.com/path",
    "https://foo_bar.example/path",
    "https://example.com/a[b]",
    "https://example.com/a|b",
    "https://example.com/path\nnext",
  ])("rejects an unsafe homepage without losing other metadata: %s", (homepage) => {
    const result = normalize(repository({ homepage: { state: "present", value: homepage } }));
    expect(result.repository).toMatchObject({
      homepage: null,
      homepage_state: { state: "rejected" },
      source_field_states: { homepage: "rejected" },
    });
    expect(result.languages.entries).toHaveLength(2);
    expect(result.topics.entries).toHaveLength(2);
    expect(result.releases.entries).toHaveLength(2);
    expect(result.repository.homepage).not.toBe(homepage);
  });

  it("rejects private, explicitly non-public, and contradictory GitHub visibility", () => {
    expect(() => normalize(repository({ isPrivate: true, visibility: { state: "absent" } }))).toThrow(/not safely public/);
    expect(() => normalize(repository({ isPrivate: false, visibility: { state: "present", value: "internal" } }))).toThrow(/not safely public/);
    expect(() => normalize(repository({ isPrivate: false, visibility: { state: "present", value: "private" } }))).toThrow(/not safely public/);
    expect(() => normalize(repository({ isPrivate: true, visibility: { state: "present", value: "public" } }))).toThrow(/not safely public/);
  });

  it("rejects identity substitutions, inconsistent names, and invalid metrics", () => {
    expect(() => normalize(repository({ id: 912346 }))).toThrow(/ID that does not match/);
    expect(() => normalize(repository({ fullName: "other/widget" }))).toThrow(/owner and name/);
    expect(() => normalize(repository({ starCount: -1 }))).toThrow();
    expect(() => normalize(repository({ canonicalUrl: "https://example.com/acme/widget" }))).toThrow(/canonical/);
  });

  it("keeps successful repository data explicit when one subresource must be retried", () => {
    const failedResources = resources({
      languages: {
        resource: "languages",
        kind: "rate_limit",
        httpStatus: 403,
        retryable: true,
        retryAfterMs: 180000,
        fetchedAt,
        sourceApiUrl: "https://api.github.com/repos/acme/widget/languages",
      },
    });
    const result = normalize(repository(), failedResources);
    expect(result.partial).toBe(true);
    expect(result.retryable_partial).toBe(true);
    expect(result.retry_after_ms).toBe(180000);
    expect(result.languages).toEqual({ complete: false, entries: [] });
    expect(result.topics.complete).toBe(true);
    expect(result.source_records.find((record) => record.record_kind === "languages")).toMatchObject({
      http_status: 403,
      source_metadata: { outcome: "unavailable", cache_reusable: false, error_kind: "rate_limit" },
    });
  });

  it("treats complete empty language, topic, and release results as valid", () => {
    const emptyTopicPage = {
      ...provenance("topics", []),
      parsedResponseData: [],
    };
    const result = normalize(repository(), resources({
      languages: { kind: "ok", data: {}, provenance: provenance("languages", {}) },
      topics: {
        kind: "ok",
        data: [],
        provenance: { ...provenance("topics", []), pages: [emptyTopicPage] },
      },
      releases: { kind: "ok", data: [], provenance: provenance("releases", []) },
    }));

    expect(result.languages).toEqual({ complete: true, entries: [] });
    expect(result.topics).toEqual({ complete: true, entries: [] });
    expect(result.releases).toEqual({ complete: true, bounded: true, entries: [] });
    expect(result.partial).toBe(false);
  });

  it("refuses to treat a 304 as an empty authoritative subresource", () => {
    expect(() => normalize(repository(), resources({
      languages: {
        kind: "not_modified",
        provenance: {
          provider: "github",
          resourceType: "languages",
          stableResourceIdentity: "github:repository:912345:languages",
          sourceApiUrl: "https://api.github.com/repos/acme/widget/languages",
          fetchedAt,
          httpStatus: 304,
          apiVersion: "2022-11-28",
        },
      },
    }))).toThrow(/304/);
  });
});
