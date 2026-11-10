import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../github/errors";
import type { GitHubRepository } from "../github/types";
import type { CatalogArchiveValidation, CatalogCandidateRecord } from "./archive";
import { executeCatalogImport, makeOfflineImportReport, type CatalogImportDatabase } from "./runner";

const source = <T>(value: T) => ({ state: "present" as const, value });

function candidate(id = "123456", batch = 1): CatalogCandidateRecord {
  return {
    schema_version: 1, github_repository_id: id, github_full_name: `acme/repo-${id}`,
    github_url: `https://github.com/acme/repo-${id}`, name: `Repo ${id}`, slug: `repo-${id}`,
    description: "A useful public software project.", tagline: "A concise tagline",
    website_url: null, primary_category: "developer-tools", tags: ["tools"], github_topics: ["developer-tools"],
    primary_language: "TypeScript", stars: 2, forks: 0, license_spdx_id: "MIT",
    license_evidence_url: `https://github.com/acme/repo-${id}/blob/main/LICENSE`,
    license_review_status: "unverified", archived: false, visibility: "public",
    logo_candidate_url: null, logo_verification_status: null,
    source_urls: [`https://api.github.com/repos/acme/repo-${id}`],
    source_checked_at: "2026-11-09T20:00:00Z", editorial_status: "pending_review",
    source_batch: batch, source_line: 1, source_batch_path: `batches/batch-${String(batch).padStart(3, "0")}.jsonl`,
  };
}

function validation(records: CatalogCandidateRecord[]): CatalogArchiveValidation {
  const batches = records.map((record) => ({
    number: record.source_batch,
    path: record.source_batch_path.replace("batches/", ""),
    sha256: String(record.source_batch).repeat(64).slice(0, 64),
    records: [record],
  }));
  return {
    valid: true, archivePath: ".catalog-input/catalog.zip", archiveSha256: "a".repeat(64), archiveBytes: 500,
    integrity: { zipStructure: "passed", entryCount: 45, crcChecks: 45 },
    counts: { candidates: records.length, batches: batches.length, uniqueRepositoryIds: records.length, uniqueFullNames: records.length, uniqueSlugs: records.length },
    categories: { "developer-tools": records.length },
    licenses: { reviewStatuses: { unverified: records.length }, spdxIdentifiersPresent: records.length, spdxIdentifiersMissing: 0, licenseEvidenceUrlsPresent: records.length, logoCandidatesPresent: 0 },
    metadataQuality: { descriptionsPresent: records.length, taglinesPresent: records.length, websitesPresent: 0, repositoriesClaimedPublic: records.length, repositoriesClaimedArchived: 0, sourceUrlCounts: { "1": records.length } },
    sha256: { allCandidates: "b".repeat(64), manifest: "c".repeat(64), batches: Object.fromEntries(batches.map((batch) => [batch.path, batch.sha256])) },
    declaredValidation: { candidateCountMatches: true, batchCountMatches: true, uniqueRepositoryIdsMatch: true, uniqueFullNamesMatch: true, uniqueSlugsMatch: true, categoriesMatch: true, batchHashesMatch: true, declaredValid: true },
    issues: [],
    manifest: { schema_version: 1, target_unique_candidates: records.length, total_batches: batches.length, source_checked_at: "2026-11-09T20:00:00Z", category_coverage: { "developer-tools": records.length }, license_review_counts: { unverified: records.length }, batches: [] },
    batches, records,
  } as unknown as CatalogArchiveValidation;
}

function currentRepository(id: string): GitHubRepository {
  return {
    id: Number(id), nodeId: `R_${id}`, owner: { id: 1, nodeId: "O_1", login: "acme" },
    name: `repo-${id}`, fullName: `acme/repo-${id}`, canonicalUrl: `https://github.com/acme/repo-${id}`,
    description: source("A current description."), homepage: { state: "null" }, topics: source(["developer-tools"]),
    primaryLanguage: source("TypeScript"), languageBytes: { state: "null" }, starCount: 2, forkCount: 0,
    watcherCount: 2, openIssueCount: 0, isArchived: false, isDisabled: false, isFork: false, isPrivate: false,
    visibility: source("public"), defaultBranch: source("main"), createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z", pushedAt: source("2026-11-01T00:00:00Z"),
    license: source({ key: "mit", name: "MIT License", spdxId: source("MIT"), url: { state: "null" }, htmlUrl: { state: "null" }, nodeId: { state: "null" } }),
  };
}

function githubResponse(id: string) {
  const repo = currentRepository(id);
  const originalResponse = {
    id: Number(id), node_id: `R_${id}`, name: `repo-${id}`, full_name: `acme/repo-${id}`,
    owner: { id: 1, node_id: "O_1", login: "acme" }, html_url: repo.canonicalUrl,
    url: `https://api.github.com/repos/acme/repo-${id}`, description: "A current description.",
    homepage: null, topics: ["developer-tools"], language: "TypeScript", stargazers_count: 2,
    forks_count: 0, watchers_count: 2, open_issues_count: 0, archived: false, disabled: false,
    fork: false, private: false, visibility: "public", default_branch: "main",
    created_at: "2024-01-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", pushed_at: "2026-11-01T00:00:00Z",
    license: { key: "mit", name: "MIT License", spdx_id: "MIT", url: null, html_url: null },
  };
  return {
    kind: "ok" as const,
    data: repo,
    provenance: {
      provider: "github" as const,
      resourceType: "repository" as const,
      stableResourceIdentity: `github:repository:${id}`,
      sourceApiUrl: `https://api.github.com/repositories/${id}`,
      fetchedAt: "2026-11-09T20:05:00Z",
      httpStatus: 200,
      apiVersion: "2022-11-28" as const,
      parsedResponseData: repo,
      originalResponseData: originalResponse,
    },
  };
}

function fakeDatabase(start: Record<string, unknown> = {}, commitError = false, heartbeatError = false) {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const db: CatalogImportDatabase = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "start_catalog_import") return { data: {
        job_id: "11111111-1111-4111-8111-111111111111", status: "running", next_batch_number: 1,
        total_batches: 1, archive_sha256: "a".repeat(64), created_job: true, ...start,
      }, error: null };
      if (name === "heartbeat_catalog_import") return heartbeatError
        ? { data: null, error: { code: "40001", message: "stale lease" } }
        : { data: "2026-11-09T20:15:00Z", error: null };
      if (name === "catalog_import_exclusions") return { data: [], error: null };
      if (name === "commit_catalog_import_batch") {
        if (commitError) return { data: null, error: { code: "23514", message: "transaction rolled back" } };
        const argsObject = args ?? {};
        const batchRecords = argsObject.p_records as Array<{ source_candidate: CatalogCandidateRecord; import_candidate: boolean }>;
        return { data: {
          next_batch_number: 2, imported: batchRecords.filter((item) => item.import_candidate).length,
          existing: 0, excluded: batchRecords.filter((item) => !item.import_candidate).length,
          results: batchRecords.map((item) => ({ github_repository_id: item.source_candidate.github_repository_id, result: item.import_candidate ? "created_candidate" : "excluded" })),
        }, error: null };
      }
      if (name === "finish_catalog_import") return { data: { status: "succeeded", next_batch_number: 2, total_batches: 1 }, error: null };
      return { data: null, error: { code: "42883", message: "missing RPC" } };
    },
  };
  return { db, calls };
}

const options = { mode: "execute" as const, resume: false, maxBatches: 1, environment: "local", projectRef: "local" };
const now = () => new Date("2026-11-09T20:06:00Z");

describe("catalog import execution", () => {
  it("keeps the offline dry-run write-free and marks every candidate for current checks", () => {
    const report = makeOfflineImportReport(validation([candidate(), candidate("222222")]));
    expect(report.mode).toBe("dry-run");
    expect(report.database_mutations.direct_project_rows).toBe(0);
    expect(report.review_summary.requires_manual_review).toBe(2);
    expect(report.review_records.every((item) => item.database_result === undefined)).toBe(true);
  });

  it("preflights and commits one atomic batch with actual response provenance", async () => {
    const { db, calls } = fakeDatabase();
    const report = await executeCatalogImport(validation([candidate()]), options, {
      database: db,
      github: { getRepositoryById: async (id: number) => githubResponse(String(id)) } as never,
      workerId: "catalog-test-worker", leaseToken: "22222222-2222-4222-8222-222222222222", now,
    });
    expect(calls.map(({ name }) => name)).toEqual([
      "start_catalog_import", "heartbeat_catalog_import", "commit_catalog_import_batch", "finish_catalog_import",
    ]);
    const batchCall = calls.find(({ name }) => name === "commit_catalog_import_batch")!;
    const batchItem = (batchCall.args?.p_records as Array<Record<string, unknown>>)[0]!;
    expect(batchItem.import_candidate).toBe(true);
    expect(batchItem.github_response).toMatchObject({ full_name: "acme/repo-123456", private: false, visibility: "public" });
    expect(batchItem.github_response).not.toHaveProperty("fullName");
    expect(batchItem.provenance).toMatchObject({ http_status: 200, fetched_at: "2026-11-09T20:05:00Z" });
    expect(report.review_records[0]?.database_result).toBe("created_candidate");
    expect(report.checkpoint).toMatchObject({ status: "succeeded" });
  });

  it("excludes restricted repositories without placing repository metadata in reports or the commit payload", async () => {
    const { db, calls } = fakeDatabase();
    const response = githubResponse("123456");
    response.data.isPrivate = true;
    response.data.visibility = source("private");
    response.data.description = source("Sensitive private project description.");
    const raw = response.provenance.originalResponseData as Record<string, unknown>;
    raw.private = true;
    raw.visibility = "private";
    raw.description = "Sensitive private project description.";
    const report = await executeCatalogImport(validation([candidate()]), options, {
      database: db,
      github: { getRepositoryById: async () => response } as never,
      now,
    });
    const batchItem = (calls.find(({ name }) => name === "commit_catalog_import_batch")?.args?.p_records as Array<Record<string, unknown>>)[0]!;
    expect(batchItem.import_candidate).toBe(false);
    expect(batchItem.github_response).toBeNull();
    expect(batchItem.source_candidate).toEqual({ schema_version: 1, github_repository_id: "123456" });
    expect(JSON.stringify(batchItem.verification)).not.toContain("Sensitive private");
    expect(report.review_records[0]?.source_candidate).toEqual({ github_repository_id: "123456" });
    expect(JSON.stringify(report.review_records[0])).not.toContain("Sensitive private");
    expect(report.review_records[0]).toMatchObject({ status: "rejected_or_excluded", observed_at: "2026-11-09T20:05:00Z" });
  });

  it("does not fetch GitHub again when the same import is already complete", async () => {
    const { db, calls } = fakeDatabase({ already_complete: true, status: "succeeded", next_batch_number: 2 });
    let requests = 0;
    const report = await executeCatalogImport(validation([candidate()]), options, {
      database: db,
      github: { getRepositoryById: async (id: number) => { requests += 1; return githubResponse(String(id)); } } as never,
      now,
    });
    expect(requests).toBe(0);
    expect(calls.map(({ name }) => name)).toEqual(["start_catalog_import", "catalog_import_exclusions"]);
    expect(report.checkpoint).toMatchObject({ already_complete: true });
  });

  it("leaves the batch checkpoint recoverable when its database transaction fails", async () => {
    const { db, calls } = fakeDatabase({}, true);
    await expect(executeCatalogImport(validation([candidate()]), options, {
      database: db,
      github: { getRepositoryById: async (id: number) => githubResponse(String(id)) } as never,
      now,
    })).rejects.toThrow("catalog import batch 1 failed");
    expect(calls.some(({ name }) => name === "finish_catalog_import")).toBe(true);
    expect(calls.find(({ name }) => name === "finish_catalog_import")?.args?.p_error_summary).toContain("batch 1 failed");
  });

  it("does not checkpoint a retryable GitHub failure and can be resumed", async () => {
    const { db, calls } = fakeDatabase();
    const github = { getRepositoryById: async () => { throw new GitHubApiError("rate_limit", "Rate limited", { retryable: true }); } };
    await expect(executeCatalogImport(validation([candidate()]), options, { database: db, github: github as never, now }))
      .rejects.toThrow("GitHub rate_limit interrupted batch 1");
    expect(calls.some(({ name }) => name === "commit_catalog_import_batch")).toBe(false);
  });

  it("does not convert a failed lease heartbeat into an excluded candidate", async () => {
    const { db, calls } = fakeDatabase({}, false, true);
    let requests = 0;
    await expect(executeCatalogImport(validation([candidate()]), options, {
      database: db,
      github: { getRepositoryById: async (id: number) => { requests += 1; return githubResponse(String(id)); } } as never,
      now,
    })).rejects.toThrow("catalog import lease heartbeat failed");
    expect(requests).toBe(0);
    expect(calls.some(({ name }) => name === "commit_catalog_import_batch")).toBe(false);
  });

  it("interrupts on malformed GitHub data instead of committing an unverifiable exclusion", async () => {
    const { db, calls } = fakeDatabase();
    const github = { getRepositoryById: async () => { throw new GitHubApiError("malformed_payload", "Invalid repository response"); } };
    await expect(executeCatalogImport(validation([candidate()]), options, { database: db, github: github as never, now }))
      .rejects.toThrow("GitHub malformed_payload interrupted batch 1");
    expect(calls.some(({ name }) => name === "commit_catalog_import_batch")).toBe(false);
  });
});
