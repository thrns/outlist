import { createHash, randomInt } from "node:crypto";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import { createGitHubClient } from "../src/lib/github/client";
import type { CatalogArchiveValidation, CatalogCandidateRecord } from "../src/lib/catalog-import/archive";
import { executeCatalogImport, type CatalogImportDatabase } from "../src/lib/catalog-import/runner";

type DbError = { message?: string; code?: string };
type DbResult = { data: unknown; error: DbError | null };
type TestQuery = PromiseLike<DbResult> & {
  select(columns: string): TestQuery;
  eq(column: string, value: string | number | boolean): TestQuery;
  maybeSingle(): Promise<DbResult>;
};
type TestDatabase = CatalogImportDatabase & { from(table: string): TestQuery };
type FixtureMode = "public" | "private" | "restricted" | "not_found" | "mismatch" | "malformed";
type Row = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidate(id: number, batch: number, mode: FixtureMode): CatalogCandidateRecord {
  const fullName = `catalog-fixture/repository-${id}`;
  return {
    schema_version: 1,
    github_repository_id: String(id),
    github_full_name: fullName,
    github_url: `https://github.com/${fullName}`,
    name: `Catalog fixture ${id}`,
    slug: `catalog-fixture-${id}`,
    description: mode === "private" ? `ARCHIVE_PRIVATE_SENTINEL_${id}` : "Deterministic local integration candidate.",
    tagline: "Disposable local importer test fixture.",
    website_url: null,
    primary_category: "developer-tools",
    tags: ["integration"],
    github_topics: ["developer-tools"],
    primary_language: "TypeScript",
    stars: 1,
    forks: 0,
    license_spdx_id: "MIT",
    license_evidence_url: `https://github.com/${fullName}/blob/main/LICENSE`,
    license_review_status: "unverified",
    archived: false,
    visibility: "public",
    logo_candidate_url: null,
    logo_verification_status: null,
    source_urls: [`https://api.github.com/repos/${fullName}`],
    source_checked_at: "2026-11-01T00:00:00.000Z",
    editorial_status: "pending_review",
    source_batch: batch,
    source_line: 1,
    source_batch_path: `batches/batch-${String(batch).padStart(3, "0")}.jsonl`,
  };
}

function validation(records: CatalogCandidateRecord[]): CatalogArchiveValidation {
  const batches = records.map((record) => ({
    number: record.source_batch,
    path: record.source_batch_path.replace("batches/", ""),
    sha256: sha256(`${record.github_repository_id}:${record.source_batch}`),
    records: [record],
  }));
  const archiveSha256 = sha256(records.map((record) => record.github_repository_id).join(","));
  const categoryCoverage = { "developer-tools": records.length };
  const reviewStatuses = { unverified: records.length };
  return {
    valid: true,
    archivePath: "/tmp/catalog-import-disposable-integration.zip",
    archiveSha256,
    archiveBytes: 1,
    integrity: { zipStructure: "passed", entryCount: batches.length, crcChecks: batches.length },
    counts: {
      candidates: records.length,
      batches: batches.length,
      uniqueRepositoryIds: records.length,
      uniqueFullNames: records.length,
      uniqueSlugs: records.length,
    },
    categories: categoryCoverage,
    licenses: {
      reviewStatuses,
      spdxIdentifiersPresent: records.length,
      spdxIdentifiersMissing: 0,
      licenseEvidenceUrlsPresent: records.length,
      logoCandidatesPresent: 0,
    },
    metadataQuality: {
      descriptionsPresent: records.length,
      taglinesPresent: records.length,
      websitesPresent: 0,
      repositoriesClaimedPublic: records.length,
      repositoriesClaimedArchived: 0,
      sourceUrlCounts: { "1": records.length },
    },
    sha256: { allCandidates: archiveSha256, manifest: sha256("manifest"), batches: Object.fromEntries(batches.map((batch) => [batch.path, batch.sha256])) },
    declaredValidation: {
      candidateCountMatches: true,
      batchCountMatches: true,
      uniqueRepositoryIdsMatch: true,
      uniqueFullNamesMatch: true,
      uniqueSlugsMatch: true,
      categoriesMatch: true,
      batchHashesMatch: true,
      declaredValid: true,
    },
    issues: [],
    manifest: {
      schema_version: 1,
      target_unique_candidates: records.length,
      total_batches: batches.length,
      source_checked_at: "2026-11-01T00:00:00.000Z",
      category_coverage: categoryCoverage,
      license_review_counts: reviewStatuses,
      batches: [],
    },
    batches,
    records,
  } as unknown as CatalogArchiveValidation;
}

function repositoryPayload(id: number, mode: FixtureMode) {
  const actualId = mode === "mismatch" ? id + 100 : id;
  const owner = `catalog-fixture-${actualId}`;
  const name = `repository-${actualId}`;
  const fullName = `${owner}/${name}`;
  const restricted = mode === "private" || mode === "restricted";
  const payload: Record<string, unknown> = {
    id: actualId,
    node_id: `R_${actualId}`,
    name,
    full_name: fullName,
    owner: { id: actualId + 500, node_id: `O_${actualId}`, login: owner, type: "Organization" },
    html_url: `https://github.com/${fullName}`,
    url: `https://api.github.com/repos/${fullName}`,
    description: restricted ? `PRIVATE_RESPONSE_SENTINEL_${id}` : "Public fixture repository description.",
    homepage: null,
    topics: ["developer-tools"],
    language: "TypeScript",
    stargazers_count: 1,
    forks_count: 0,
    watchers_count: 1,
    open_issues_count: 0,
    archived: false,
    disabled: false,
    fork: false,
    private: mode === "private",
    visibility: mode === "private" ? "private" : mode === "restricted" ? "internal" : "public",
    default_branch: "main",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    pushed_at: "2026-11-01T00:00:00.000Z",
    license: { key: "mit", name: "MIT License", spdx_id: "MIT", url: null, html_url: null },
    response_extension: { origin: "deterministic-github-http-fixture" },
  };
  if (mode === "malformed") delete payload.name;
  return payload;
}

function githubClient(fixtures: Map<number, FixtureMode>, requestLog: string[]) {
  return createGitHubClient({
    token: "deterministic-local-fixture-token",
    now: () => Date.parse("2026-11-09T20:05:00.000Z"),
    maxRetries: 0,
    maxRateLimitWaitMs: 0,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const repositoryId = Number(url.pathname.split("/").at(-1));
      const mode = fixtures.get(repositoryId);
      assert(mode, `Unexpected GitHub request for repository ${repositoryId}.`);
      assert(new Headers(init?.headers).get("authorization") === "Bearer deterministic-local-fixture-token", "The test adapter must exercise the authenticated GitHub request path.");
      requestLog.push(url.pathname);
      const headers = { "content-type": "application/vnd.github+json", etag: `"fixture-${repositoryId}"` };
      if (mode === "not_found") return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers });
      return new Response(JSON.stringify(repositoryPayload(repositoryId, mode)), { status: 200, headers });
    },
  });
}

function dbAdapter(client: TestDatabase): CatalogImportDatabase {
  return { rpc: (name, args) => client.rpc(name, args) };
}

async function rows<T extends Row>(query: PromiseLike<DbResult>, description: string): Promise<T[]> {
  const result = await query;
  assert(!result.error && Array.isArray(result.data), `${description} failed.`);
  return result.data as T[];
}

async function runOne(
  client: TestDatabase,
  record: CatalogCandidateRecord,
  mode: FixtureMode,
  id: number,
) {
  const logs: string[] = [];
  const github = githubClient(new Map([[id, mode]]), logs);
  const errorRows = validation([record]);
  let failed = false;
  try {
    await executeCatalogImport(errorRows, {
      mode: "execute", resume: false, maxBatches: 1, environment: "local", projectRef: "local",
    }, { database: dbAdapter(client), github });
  } catch (error) {
    failed = true;
    assert(error instanceof Error, "Expected a structured importer failure.");
  }
  assert(failed, `${mode} GitHub fixture must stop before a catalog batch commits.`);
  assert(logs.length === 1, `${mode} fixture must make exactly one deterministic repository request.`);
}

async function main() {
  const urlValue = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  assert(urlValue && secretKey, "Disposable local Supabase URL and service key are required.");
  const url = new URL(urlValue);
  assert(["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname), "Catalog import database integration refuses non-local Supabase targets.");
  assert(process.env.OUTLIST_SUPABASE_ENVIRONMENT === "local", "Catalog import database integration requires OUTLIST_SUPABASE_ENVIRONMENT=local.");

  const admin = createSupabaseAdminClient();
  const db = admin as unknown as TestDatabase;
  const baseId = randomInt(800_000_000, 900_000_000);
  const records = [
    candidate(baseId, 1, "public"),
    candidate(baseId + 1, 2, "private"),
    candidate(baseId + 2, 3, "restricted"),
    candidate(baseId + 3, 4, "not_found"),
  ];
  const archive = validation(records);
  const modes = new Map<number, FixtureMode>([
    [baseId, "public"], [baseId + 1, "private"], [baseId + 2, "restricted"], [baseId + 3, "not_found"],
  ]);
  const requests: string[] = [];
  const github = githubClient(modes, requests);
  const committedPayloads: Array<Array<Row>> = [];
  const recordingDb: CatalogImportDatabase = {
    rpc: async (name, args) => {
      if (name === "commit_catalog_import_batch") committedPayloads.push(structuredClone(args?.p_records) as Array<Row>);
      return db.rpc(name, args);
    },
  };
  let injectedDatabaseFailure = false;
  const failingOnce: CatalogImportDatabase = {
    rpc: async (name, args) => {
      if (name === "commit_catalog_import_batch" && !injectedDatabaseFailure) {
        injectedDatabaseFailure = true;
        committedPayloads.push(structuredClone(args?.p_records) as Array<Row>);
        const alteredRecords = structuredClone(args?.p_records) as Array<{ source_candidate: Record<string, unknown> }>;
        alteredRecords[0]!.source_candidate.primary_category = "integration-invalid-category";
        return db.rpc(name, { ...args, p_records: alteredRecords });
      }
      return recordingDb.rpc(name, args);
    },
  };
  const executeOptions = { mode: "execute" as const, resume: false, maxBatches: 1, environment: "local", projectRef: "local" };
  let batchFailure: unknown;
  try {
    await executeCatalogImport(archive, executeOptions, { database: failingOnce, github });
  } catch (error) {
    batchFailure = error;
  }
  assert(batchFailure instanceof Error && batchFailure.message.includes("catalog import batch 1 failed"), "A real database constraint failure must roll back the batch and stop the importer.");
  assert(injectedDatabaseFailure, "The integration must inject a failure through the real commit RPC.");
  const emptyAfterFailure = await rows<Row>(db.from("repository_candidates").select("id").eq("provider_repository_id", String(baseId)), "Read candidate after failed batch");
  assert(emptyAfterFailure.length === 0, "A failed catalog batch must not leave a candidate behind.");
  const checkpointAfterFailure = await rows<Row>(db.from("ingestion_items").select("id").eq("item_key", `github:${baseId}`), "Read ledger after failed batch");
  assert(checkpointAfterFailure.length === 0, "A failed catalog batch must not leave a ledger row behind.");

  const resumed = await executeCatalogImport(archive, { ...executeOptions, resume: true }, { database: recordingDb, github });
  assert(resumed.checkpoint?.status === "partial", "The bounded first batch must leave a resumable checkpoint.");
  const publicSources = await rows<Row>(db.from("source_records").select("source_key,raw_payload,fetched_at,http_status,source_metadata")
    .eq("source_key", `github:repository:${baseId}`), "Read public source record");
  assert(publicSources.length === 1, "A public repository must create one source record.");
  assert((publicSources[0]?.raw_payload as Row)?.full_name === `catalog-fixture-${baseId}/repository-${baseId}`, "The source record must contain the validated provider-shaped REST payload.");
  assert(((publicSources[0]?.raw_payload as Row)?.response_extension as Row)?.origin === "deterministic-github-http-fixture", "The source record must retain the original JSON body rather than a normalized reconstruction.");
  assert(publicSources[0]?.http_status === 200 && Date.parse(String(publicSources[0]?.fetched_at)) === Date.parse("2026-11-09T20:05:00.000Z"), "The public source record must preserve the actual response timestamp and status.");
  const publicCandidate = await rows<Row>(db.from("repository_candidates").select("provider_repository_id,full_name,canonical_url,source_record_id,review_status")
    .eq("provider_repository_id", String(baseId)), "Read public candidate");
  assert(publicCandidate.length === 1 && publicCandidate[0]?.full_name === `catalog-fixture-${baseId}/repository-${baseId}`, "The public response must create the expected canonical candidate.");
  assert(publicCandidate[0]?.review_status === "unreviewed", "Catalog import must not change editorial review state.");
  const publicLedger = await rows<Row>(db.from("ingestion_items").select("item_type,status,result")
    .eq("item_key", `github:${baseId}`), "Read public import ledger");
  assert(publicLedger.length === 1 && publicLedger[0]?.item_type === "catalog_seed_candidate", "The public candidate must have one catalog ledger item.");
  assert(((publicLedger[0]?.result as Row)?.catalog_import as Row)?.provenance !== undefined, "The public ledger must preserve stable source provenance.");
  assert((((publicLedger[0]?.result as Row)?.catalog_import as Row)?.verification as Row)?.license !== undefined, "The public review evidence must retain license uncertainty.");

  const privateRun = await executeCatalogImport(archive, { ...executeOptions, resume: true }, { database: recordingDb, github });
  const privateReview = privateRun.review_records.find((item) => item.github_repository_id === String(baseId + 1));
  assert(privateReview?.status === "rejected_or_excluded" && privateReview.database_result === "excluded", "A private repository must be classified and excluded.");
  assert(JSON.stringify(privateReview).indexOf("PRIVATE_RESPONSE_SENTINEL") < 0 && JSON.stringify(privateReview).indexOf("ARCHIVE_PRIVATE_SENTINEL") < 0, "The local report must not retain private or archived description content for a restricted record.");
  const privateCandidate = await rows<Row>(db.from("repository_candidates").select("id").eq("provider_repository_id", String(baseId + 1)), "Read private candidate queue");
  assert(privateCandidate.length === 0, "A private repository must not enter the candidate queue.");
  const privateSources = await rows<Row>(db.from("source_records").select("id").eq("source_key", `github:repository:${baseId + 1}`), "Read private source records");
  assert(privateSources.length === 0, "A private repository must not create a public source record.");
  const privateLedger = await rows<Row>(db.from("ingestion_items").select("result,item_type")
    .eq("item_key", `github:${baseId + 1}`), "Read private exclusion ledger");
  assert(privateLedger.length === 1 && privateLedger[0]?.item_type === "catalog_import_exclusion", "A private repository must have a sanitized exclusion ledger item.");
  const privateImportPayload = committedPayloads.at(-1)?.[0];
  assert(privateImportPayload?.import_candidate === false
    && JSON.stringify(privateImportPayload.source_candidate) === JSON.stringify({ schema_version: 1, github_repository_id: String(baseId + 1) })
    && privateImportPayload.github_response === null
    && !JSON.stringify(privateImportPayload.verification).includes("PRIVATE_RESPONSE_SENTINEL"),
  "The importer must send only identity and sanitized diagnostics to Supabase for a private response.");
  const privateLedgerJson = JSON.stringify(privateLedger[0]?.result);
  assert(!privateLedgerJson.includes("PRIVATE_RESPONSE_SENTINEL") && !privateLedgerJson.includes("ARCHIVE_PRIVATE_SENTINEL")
    && !privateLedgerJson.includes("private") && !privateLedgerJson.includes("description"), "The private ledger item must contain no raw or normalized repository metadata.");
  const privateSafe = ((privateLedger[0]?.result as Row)?.catalog_import as Row);
  assert(privateSafe.repository_id === String(baseId + 1) && privateSafe.classification === "rejected_or_excluded" && Date.parse(String(privateSafe.observed_at)) === Date.parse("2026-11-09T20:05:00.000Z"), "The private ledger must retain only safe identity, classification, reason codes, and fetch timestamp.");
  assert(Object.keys(privateSafe).length === 4, "The private exclusion ledger has an exact safe field allowlist.");

  const restrictedRun = await executeCatalogImport(archive, { ...executeOptions, resume: true }, { database: recordingDb, github });
  const restrictedReview = restrictedRun.review_records.find((item) => item.github_repository_id === String(baseId + 2));
  assert(restrictedReview?.status === "rejected_or_excluded" && restrictedReview.database_result === "excluded", "A non-public visibility classification must be excluded.");
  const privateAfterResume = restrictedRun.review_records.find((item) => item.github_repository_id === String(baseId + 1));
  assert(privateAfterResume?.source_candidate.github_repository_id === String(baseId + 1)
    && JSON.stringify(privateAfterResume).indexOf("PRIVATE_RESPONSE_SENTINEL") < 0
    && JSON.stringify(privateAfterResume).indexOf("ARCHIVE_PRIVATE_SENTINEL") < 0,
  "A later resume report must keep previously excluded private records redacted.");
  const restrictedCandidate = await rows<Row>(db.from("repository_candidates").select("id").eq("provider_repository_id", String(baseId + 2)), "Read restricted candidate queue");
  assert(restrictedCandidate.length === 0, "A restricted-visibility repository must not enter the candidate queue.");
  const restrictedLedger = await rows<Row>(db.from("ingestion_items").select("result").eq("item_key", `github:${baseId + 2}`), "Read restricted exclusion ledger");
  assert(!JSON.stringify(restrictedLedger[0]?.result).includes("PRIVATE_RESPONSE_SENTINEL"), "Restricted repository response fields must not persist in the ledger.");

  const notFoundRun = await executeCatalogImport(archive, { ...executeOptions, resume: true }, { database: recordingDb, github });
  assert(notFoundRun.review_records.find((item) => item.github_repository_id === String(baseId + 3))?.database_result === "excluded", "A private-or-unavailable 404 must be excluded without a fabricated response.");
  const notFoundLedger = await rows<Row>(db.from("ingestion_items").select("result").eq("item_key", `github:${baseId + 3}`), "Read unavailable exclusion ledger");
  assert(Date.parse(String((((notFoundLedger[0]?.result as Row)?.catalog_import as Row)?.observed_at))) === Date.parse("2026-11-09T20:05:00.000Z"), "An unavailable response must retain the actual request timestamp.");

  const mismatchId = baseId + 10;
  const malformedId = baseId + 11;
  await runOne(db, candidate(mismatchId, 1, "mismatch"), "mismatch", mismatchId);
  await runOne(db, candidate(malformedId, 1, "malformed"), "malformed", malformedId);
  for (const id of [mismatchId, malformedId]) {
    const candidates = await rows<Row>(db.from("repository_candidates").select("id").eq("provider_repository_id", String(id)), `Check invalid response candidate ${id}`);
    const ledger = await rows<Row>(db.from("ingestion_items").select("id").eq("item_key", `github:${id}`), `Check invalid response ledger ${id}`);
    assert(candidates.length === 0 && ledger.length === 0, "Identity mismatches and malformed responses must not create candidates or exclusion ledger rows.");
  }

  const project = await rows<Row>(db.from("projects").select("id").eq("slug", `catalog-fixture-${baseId}`), "Check publication safety");
  assert(project.length === 0, "Catalog import must not create or publish project drafts.");
  assert(requests.length === 5, "The real GitHubClient must fetch each bounded candidate exactly once, with one public refetch after the failed/retried commit.");
  process.stdout.write(`${JSON.stringify({
    event: "catalog_import_local_integration_passed",
    public_source_candidate_ledger: true,
    private_and_restricted_metadata_sanitized: true,
    unavailable_observation_timestamp_preserved: true,
    identity_mismatch_and_malformed_responses_rejected: true,
    database_transaction_failure_and_resume: true,
    editorial_and_publication_safety: true,
    deterministic_authenticated_github_fixtures: true,
    hosted_supabase: false,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 1200) : "unexpected catalog import database integration failure";
  process.stderr.write(`${JSON.stringify({ event: "catalog_import_local_integration_failed", message })}\n`);
  process.exitCode = 1;
});
