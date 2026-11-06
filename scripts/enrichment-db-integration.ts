import { randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import { createGitHubClient } from "../src/lib/github/client";
import { runEnrichmentCli, type EnrichmentCliDependencies } from "./enrich";
import type { Database } from "../src/lib/supabase/database.types";

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};
type Row = Record<string, unknown>;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rpc<T>(client: RpcClient, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.rpc(name, args);
  if (result.error) throw new Error(`Database RPC failed: ${name} (${result.error.code ?? "unknown"}).`);
  return result.data as T;
}

async function selectOne<T extends Row>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>, description: string): Promise<T> {
  const result = await query;
  assert(!result.error, `${description}: ${result.error?.message ?? "query failed"}`);
  const rows = result.data as T[] | null;
  assert(rows?.length === 1, `${description}: expected one row, got ${rows?.length ?? 0}.`);
  return rows[0] as T;
}

async function insertCandidate(admin: ReturnType<typeof createSupabaseAdminClient>, repositoryId: string, marker: string) {
  const source = await admin.from("source_records").insert({
    provider: "github",
    record_kind: "discovery_page",
    source_key: `enrichment-it:${marker}`,
    source_url: "https://api.github.com/search/repositories?q=outlist-enrichment-fixture",
    fetched_at: new Date().toISOString(),
    http_status: 200,
    source_metadata: { api_version: "2022-11-28", fixture: true },
  }).select("id").single();
  assert(!source.error && source.data, `Create candidate source record: ${source.error?.message ?? "no row returned"}`);
  const candidate = await admin.from("repository_candidates").insert({
    provider: "github",
    provider_repository_id: repositoryId,
    full_name: "fixture/old-name",
    canonical_url: "https://github.com/fixture/old-name",
    owner_login: "fixture",
    source_record_id: source.data.id,
    queue_status: "queued",
    review_status: "unreviewed",
  }).select("id").single();
  assert(!candidate.error && candidate.data, `Create enrichment candidate: ${candidate.error?.message ?? "no row returned"}`);
  return candidate.data.id;
}

function makeGitHubFixture(repositoryId: number, options: {
  observationTime: string;
  variant: "first" | "older" | "newer" | "partial";
}): { fetch: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const state = options.variant;
  const current = state === "first"
    ? { owner: "fixture", name: "renamed", fullName: "fixture/renamed", stars: 100, forks: 5, language: "TypeScript", topic: "stable-topic", tag: "v1.0.0" }
    : state === "older"
      ? { owner: "fixture", name: "outdated", fullName: "fixture/outdated", stars: 9, forks: 1, language: "Go", topic: "outdated-topic", tag: "v0.1.0" }
      : { owner: "new-owner", name: "final-name", fullName: "new-owner/final-name", stars: 210, forks: 14, language: "Rust", topic: "fresh-topic", tag: "v2.0.0" };
  const repoBody = {
    id: repositoryId,
    node_id: `R_fixture_${repositoryId}`,
    name: current.name,
    full_name: current.fullName,
    owner: { id: 882001, node_id: "O_fixture", login: current.owner, type: "Organization" },
    html_url: `https://github.com/${current.fullName}`,
    url: `https://api.github.com/repos/${current.fullName}`,
    description: `Fixture ${state} repository metadata`,
    homepage: "https://example.test/outlist-fixture",
    topics: [current.topic],
    language: current.language,
    stargazers_count: current.stars,
    forks_count: current.forks,
    watchers_count: current.stars + 10,
    open_issues_count: 4,
    archived: false,
    disabled: false,
    fork: false,
    private: false,
    visibility: "public",
    default_branch: "main",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: options.observationTime,
    pushed_at: "2026-11-04T09:00:00Z",
    license: { key: "mit", name: "MIT License", spdx_id: "MIT", url: "https://api.github.com/licenses/mit", html_url: `https://github.com/${current.fullName}/blob/main/LICENSE`, node_id: "L_fixture" },
  };
  const release = (id: number, tag: string, prerelease = false) => ({
    id,
    node_id: `REL_${id}`,
    tag_name: tag,
    name: `${tag} fixture release`,
    url: `https://api.github.com/repos/${current.fullName}/releases/${id}`,
    html_url: `https://github.com/${current.fullName}/releases/tag/${tag}`,
    created_at: options.observationTime,
    published_at: options.observationTime,
    draft: false,
    prerelease,
  });

  const fetcher: typeof fetch = async (input) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    requested.push(requestUrl.href);
    const headers = new Headers({
      "content-type": "application/vnd.github+json",
      etag: `"fixture-${state}-${requestUrl.pathname.split("/").at(-1)}"`,
      "x-github-api-version-selected": "2022-11-28",
    });
    if (requestUrl.pathname === `/repositories/${repositoryId}`) {
      return new Response(JSON.stringify(repoBody), { status: 200, headers });
    }
    if (requestUrl.pathname.endsWith("/languages")) {
      if (state === "partial") return new Response(JSON.stringify({ message: "fixture server error" }), { status: 503, headers });
      return new Response(JSON.stringify({ [current.language]: 900, CSS: 100 }), { status: 200, headers });
    }
    if (requestUrl.pathname.endsWith("/topics")) {
      return new Response(JSON.stringify({ names: [current.topic, current.topic.toUpperCase(), "developer-tools"] }), { status: 200, headers });
    }
    if (requestUrl.pathname.endsWith("/releases")) {
      const link = `<https://api.github.com/repositories/${repositoryId}/releases?per_page=2&page=2>; rel="next"`;
      headers.set("link", link);
      return new Response(JSON.stringify([release(repositoryId + 1, current.tag), release(repositoryId, "v0.9.0", true)]), { status: 200, headers });
    }
    throw new Error(`Unexpected deterministic GitHub fixture URL: ${requestUrl.pathname}`);
  };
  return { fetch: fetcher, requested };
}

async function runWorker(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  repositoryId: number,
  options: { observationTime: string; variant: "first" | "older" | "newer" | "partial"; maxReleases?: number },
) {
  const fixture = makeGitHubFixture(repositoryId, options);
  const github = createGitHubClient({
    fetch: fixture.fetch,
    token: null,
    maxRetries: 0,
    maxRateLimitWaitMs: 0,
    now: () => Date.parse(options.observationTime),
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: EnrichmentCliDependencies = {
    supabase: admin as unknown as NonNullable<EnrichmentCliDependencies["supabase"]>,
    github,
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  };
  const status = await runEnrichmentCli(["--execute", "--max-candidates", "1", "--max-releases", String(options.maxReleases ?? 2)], dependencies);
  const events = stdout.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
  const errors = stderr.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
  return { status, events, errors, requested: fixture.requested };
}

async function main() {
  assert(url && anonKey, "Local Supabase URL and publishable key are required for enrichment integration tests.");
  const admin = createSupabaseAdminClient();
  const rpcClient = admin as unknown as RpcClient;
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const marker = randomInt(100_000_000, 999_999_999).toString();
  const providerId = Number(`9811${marker}`);
  assert(Number.isSafeInteger(providerId), "Fixture ID must be a safe numeric GitHub repository ID.");
  // The discovery integration suite runs first and leaves synthetic candidates
  // for its cross-page identity assertions. Keep those rows out of this worker
  // run so the claim is deterministically bound to this suite's mocked source.
  const discoveryFixtures = await admin.from("repository_candidates")
    .update({ queue_status: "discarded" } as never)
    .eq("provider", "github")
    .in("provider_repository_id", ["880000001", "880000002"]);
  assert(!discoveryFixtures.error, `Isolate discovery integration candidates: ${discoveryFixtures.error?.message ?? "update failed"}`);
  const candidateId = await insertCandidate(admin, String(providerId), marker);

  const projectCountBefore = await admin.from("projects").select("id", { count: "exact", head: true });
  assert(!projectCountBefore.error, "Project count is readable before enrichment.");
  const first = await runWorker(admin, providerId, { observationTime: "2026-11-05T11:00:00.000Z", variant: "first" });
  assert(first.status === 0, `The actual enrichment worker must complete against local Supabase; got ${first.status}: ${JSON.stringify(first.errors)}`);
  assert(first.requested[0] === `https://api.github.com/repositories/${providerId}`, "Worker must fetch by stable numeric repository ID first.");
  assert(first.requested.filter((request) => request.includes("/releases")).length === 1, "Release retrieval must stay within its one-page bound.");
  assert(!first.requested.some((request) => new URL(request).searchParams.get("page") === "2"), "The bounded release window must not fetch later pages.");

  let repository = await selectOne<Row>(admin.from("repositories").select("*")
    .eq("provider", "github").eq("provider_repository_id", String(providerId)), "First canonical repository row");
  const canonicalId = String(repository.id);
  assert(repository.full_name === "fixture/renamed", "Stable ID lookup must store the source's current repository name.");
  assert(repository.owner_login === "fixture" && repository.repository_name === "renamed", "Current owner and repository name must be normalized separately.");
  assert(repository.project_id === null, "New enriched repositories must remain unassociated with a project.");
  assert(repository.source_license_metadata && (repository.source_license_metadata as Row).spdx_id === "MIT", "Detected license is retained only as source evidence.");
  assert(repository.availability_status === "available", "A successful repository response establishes current availability.");

  const languageRows = await admin.from("repository_languages").select("*").eq("repository_id", canonicalId);
  assert(!languageRows.error && languageRows.data?.length === 2, "Complete language response must persist each language.");
  assert(languageRows.data?.some((row) => row.language_key === "typescript" && row.bytes === 900), "Language byte counts and normalized keys must persist.");
  const topicRows = await admin.from("repository_topics").select("*").eq("repository_id", canonicalId);
  assert(!topicRows.error && topicRows.data?.length === 2, "Topics must be deduplicated case-insensitively.");
  assert(topicRows.data?.some((row) => row.topic_key === "stable-topic" && row.source_topic === "stable-topic"), "Topic spelling and normalized key must both persist.");
  const releaseRows = await admin.from("releases").select("*").eq("repository_id", canonicalId);
  assert(!releaseRows.error && releaseRows.data?.length === 2, "The configured bounded recent release window must persist.");
  assert(releaseRows.data?.some((row) => row.provider_release_id === String(providerId) && row.is_prerelease), "Release identity and prerelease state must persist.");
  const snapshotRows = await admin.from("repository_snapshots").select("*").eq("repository_id", canonicalId);
  assert(!snapshotRows.error && snapshotRows.data?.length === 1, "The first daily snapshot must be recorded once.");
  assert(snapshotRows.data?.[0]?.snapshot_date === "2026-11-05" && snapshotRows.data?.[0]?.stars === 100, "Snapshot uses the source capture date and observed counts.");

  const sourceRows = await admin.from("source_records").select("*").eq("repository_id", canonicalId).eq("candidate_id", candidateId);
  assert(!sourceRows.error && sourceRows.data?.length === 4, "Repository and subresource provenance must link to both candidate and canonical repository.");
  assert(sourceRows.data?.every((row) => row.source_metadata && (row.source_metadata as Row).cache_reusable === false), "Stored ETags are not treated as safe cache entries.");
  assert(sourceRows.data?.some((row) => row.record_kind === "repository" && row.etag === '"fixture-first-9811' + marker + '"'), "Repository ETag provenance must be retained.");
  const candidate = await selectOne<Row>(admin.from("repository_candidates").select("*").eq("id", candidateId), "Enrichment candidate state");
  assert(candidate.enrichment_status === "succeeded" && candidate.repository_id === canonicalId && candidate.enrichment_completed_at, "Candidate must link to its completed canonical repository.");

  const projectsAfterEnrichment = await admin.from("projects").select("id", { count: "exact", head: true });
  assert(projectsAfterEnrichment.count === projectCountBefore.count, "Enrichment must not create or publish projects.");

  // Attach the repository to a draft editorial record, then prove enrichment
  // preserves that association and protects fresher canonical data.
  const fixtureProject = await admin.from("projects").insert({
    slug: `enrichment-fixture-${marker}`,
    name: "Enrichment integration fixture",
    summary: "A draft association used to verify that enrichment preserves editorial ownership.",
    license_status: "unknown",
    publication_status: "draft",
  }).select("id").single();
  assert(!fixtureProject.error && fixtureProject.data, `Create draft association fixture: ${fixtureProject.error?.message ?? "no row returned"}`);
  const attach = await admin.from("repositories").update({ project_id: fixtureProject.data.id }).eq("id", canonicalId);
  assert(!attach.error, "Attach the canonical repository to the draft fixture project.");
  const primary = await admin.from("projects").update({ primary_repository_id: canonicalId }).eq("id", fixtureProject.data.id);
  assert(!primary.error, "Set the fixture project's same-project primary repository.");

  const requeue = async () => {
    const result = await admin.from("repository_candidates").update({
      enrichment_status: "queued",
      enrichment_completed_at: null,
      enrichment_error: null,
      enrichment_next_attempt_at: null,
    } as never).eq("id", candidateId);
    assert(!result.error, `Requeue candidate for source freshness check: ${result.error?.message ?? "update failed"}`);
  };
  await requeue();
  const older = await runWorker(admin, providerId, { observationTime: "2026-11-05T10:00:00.000Z", variant: "older" });
  assert(older.status === 0, `Older observations should commit idempotently; got ${older.status}: ${JSON.stringify(older.errors)}`);
  repository = await selectOne<Row>(admin.from("repositories").select("*").eq("id", canonicalId), "Canonical repository after older observation");
  assert(repository.full_name === "fixture/renamed" && repository.stars === 100, "Older observations must not replace fresher canonical metadata.");
  assert(repository.project_id === fixtureProject.data.id, "Enrichment must preserve existing project association.");
  const olderSnapshot = await selectOne<Row>(admin.from("repository_snapshots").select("*").eq("repository_id", canonicalId), "Snapshot after older observation");
  assert(olderSnapshot.stars === 100 && new Date(String(olderSnapshot.captured_at)).toISOString() === "2026-11-05T11:00:00.000Z", "An older same-day snapshot cannot overwrite a newer capture.");
  const unchangedLanguages = await admin.from("repository_languages").select("language_key").eq("repository_id", canonicalId);
  assert(!unchangedLanguages.error && unchangedLanguages.data?.some((row) => row.language_key === "typescript"), "An older complete language payload cannot replace a newer observation.");

  await requeue();
  const newer = await runWorker(admin, providerId, { observationTime: "2026-11-05T12:00:00.000Z", variant: "newer" });
  assert(newer.status === 0, `A later repository transfer observation should upsert; got ${newer.status}: ${JSON.stringify(newer.errors)}`);
  repository = await selectOne<Row>(admin.from("repositories").select("*").eq("id", canonicalId), "Canonical repository after owner transfer");
  assert(repository.full_name === "new-owner/final-name" && repository.owner_login === "new-owner", "A rename and owner transfer must keep the stable repository row.");
  assert(repository.project_id === fixtureProject.data.id, "Later source metadata cannot overwrite editorial project association.");
  const latestSnapshot = await selectOne<Row>(admin.from("repository_snapshots").select("*").eq("repository_id", canonicalId), "Daily snapshot after newer observation");
  assert(latestSnapshot.stars === 210 && new Date(String(latestSnapshot.captured_at)).toISOString() === "2026-11-05T12:00:00.000Z", "A newer same-day observation updates the single daily snapshot.");
  const latestReleases = await admin.from("releases").select("*").eq("repository_id", canonicalId);
  assert(!latestReleases.error && latestReleases.data?.some((row) => row.provider_release_id === String(providerId + 1) && row.version === "v2.0.0"), "Release upsert uses stable provider ID and a newer observation.");
  const fixtureProjectState = await selectOne<Row>(admin.from("projects").select("*").eq("id", fixtureProject.data.id), "Draft project must remain editorially controlled");
  assert(fixtureProjectState.publication_status === "draft" && fixtureProjectState.license_status === "unknown", "Enrichment never verifies the license or publishes the associated project.");

  await requeue();
  const duplicateRun = await runWorker(admin, providerId, { observationTime: "2026-11-05T12:30:00.000Z", variant: "newer" });
  assert(duplicateRun.status === 0, "Repeat enrichment must be idempotent.");
  const duplicateRows = await admin.from("repositories").select("id").eq("provider", "github").eq("provider_repository_id", String(providerId));
  assert(!duplicateRows.error && duplicateRows.data?.length === 1 && duplicateRows.data[0]?.id === canonicalId, "Repeated enrichment must retain exactly one canonical repository row.");
  const duplicateSnapshots = await admin.from("repository_snapshots").select("id").eq("repository_id", canonicalId).eq("snapshot_date", "2026-11-05");
  assert(!duplicateSnapshots.error && duplicateSnapshots.data?.length === 1, "Repeated daily enrichment must remain idempotent.");

  // A partial source failure commits only complete resources and schedules a retry.
  const partialId = Number(`9822${marker}`);
  const partialCandidateId = await insertCandidate(admin, String(partialId), `${marker}-partial`);
  const partial = await runWorker(admin, partialId, { observationTime: "2026-11-05T13:00:00.000Z", variant: "partial" });
  assert(partial.status === 1, "A persisted retryable subresource failure is reported as a nonzero operational result.");
  const partialCandidate = await selectOne<Row>(admin.from("repository_candidates").select("*").eq("id", partialCandidateId), "Partial candidate retry state");
  assert(partialCandidate.enrichment_status === "retry_wait" && partialCandidate.enrichment_next_attempt_at, "Retryable subresource failure persists a due retry time.");
  const partialRepository = await selectOne<Row>(admin.from("repositories").select("*").eq("provider", "github").eq("provider_repository_id", String(partialId)), "Partial source canonical row");
  assert(partialRepository.project_id === null, "Partial enrichment also remains unpublished.");
  const partialLanguages = await admin.from("repository_languages").select("*").eq("repository_id", String(partialRepository.id));
  assert(!partialLanguages.error && partialLanguages.data?.length === 0, "An unavailable language endpoint cannot be represented as a successful empty result.");
  const partialSources = await admin.from("source_records").select("*").eq("candidate_id", partialCandidateId).eq("record_kind", "languages");
  assert(!partialSources.error && partialSources.data?.some((row) => row.http_status === 503 && (row.source_metadata as Row).outcome === "unavailable"), "Failed resource provenance is safely recorded.");
  const makeDue = await admin.from("repository_candidates").update({ enrichment_next_attempt_at: new Date(Date.now() - 1000).toISOString() } as never).eq("id", partialCandidateId);
  assert(!makeDue.error, "Make the retry fixture immediately eligible.");
  const recovered = await runWorker(admin, partialId, { observationTime: "2026-11-05T13:05:00.000Z", variant: "newer" });
  assert(recovered.status === 0, "A due partial candidate can resume and complete.");
  const recoveredCandidate = await selectOne<Row>(admin.from("repository_candidates").select("*").eq("id", partialCandidateId), "Recovered candidate state");
  assert(recoveredCandidate.enrichment_status === "succeeded", "Successful retry clears the partial queue state.");

  // Claim concurrency and expired-lease fencing use the real SQL RPCs.
  const concurrentIds = [Number(`9833${marker}`), Number(`9844${marker}`)];
  await Promise.all(concurrentIds.map((id, index) => insertCandidate(admin, String(id), `${marker}-concurrent-${index}`)));
  const concurrentJob = await rpc<string>(rpcClient, "start_github_enrichment_job", { p_resume: false, p_metadata: { fixture: true } });
  const simultaneous = await Promise.all(["enrichment-worker-a", "enrichment-worker-b"].map((worker) =>
    rpc<Row[]>(rpcClient, "claim_github_enrichment_candidates", {
      p_job_id: concurrentJob, p_worker_id: worker, p_limit: 1, p_lease_seconds: 60,
    }),
  ));
  const concurrentClaimA = simultaneous[0]?.[0];
  const concurrentClaimB = simultaneous[1]?.[0];
  assert(concurrentClaimA && concurrentClaimB, "Concurrent enrichment workers each receive a candidate.");
  assert(concurrentClaimA.candidate_id !== concurrentClaimB.candidate_id, "Concurrent claims cannot own the same candidate.");
  const oldClaim = concurrentClaimA;
  const expire = await admin.from("repository_candidates").update({ enrichment_lease_expires_at: new Date(Date.now() - 1000).toISOString() } as never)
    .eq("id", String(oldClaim.candidate_id));
  assert(!expire.error, "Expire one enrichment lease for fencing verification.");
  const recoveryJob = await rpc<string>(rpcClient, "start_github_enrichment_job", { p_resume: false, p_metadata: { fixture: true, resume: true } });
  const freshClaims = await rpc<Row[]>(rpcClient, "claim_github_enrichment_candidates", {
    p_job_id: recoveryJob, p_worker_id: "enrichment-recovery-worker", p_limit: 1, p_lease_seconds: 60,
  });
  assert(freshClaims.length === 1 && freshClaims[0]?.candidate_id === oldClaim.candidate_id, "An expired claim is automatically recovered.");
  assert(freshClaims[0]?.lease_token !== oldClaim.lease_token, "Expired recovery issues a new fencing token.");
  const staleCommit = await rpcClient.rpc("commit_github_repository_enrichment", {
    p_candidate_id: oldClaim.candidate_id,
    p_worker_id: "enrichment-worker-a",
    p_lease_token: oldClaim.lease_token,
    p_payload: {},
  });
  assert(staleCommit.error?.code === "40001", "A stale worker is rejected before payload parsing or persistence.");

  const recoveredFailure = await rpc<Row>(rpcClient, "fail_github_repository_enrichment", {
    p_candidate_id: String(oldClaim.candidate_id),
    p_worker_id: "enrichment-recovery-worker",
    p_lease_token: String(freshClaims[0]?.lease_token),
    p_error_summary: "integration fixture lease recovery completed",
    p_retryable: false,
    p_retry_after_ms: null,
    p_failure_provenance: null,
  });
  assert(recoveredFailure.status === "failed", "The recovered claim can be terminally closed after stale-write verification.");
  const otherClaim = concurrentClaimB;
  const otherWorkerId = simultaneous[0]?.[0]?.candidate_id === otherClaim.candidate_id
    ? "enrichment-worker-a"
    : "enrichment-worker-b";
  const otherFailure = await rpc<Row>(rpcClient, "fail_github_repository_enrichment", {
    p_candidate_id: String(otherClaim.candidate_id),
    p_worker_id: otherWorkerId,
    p_lease_token: String(otherClaim.lease_token),
    p_error_summary: "integration fixture concurrency completed",
    p_retryable: false,
    p_retry_after_ms: null,
    p_failure_provenance: null,
  });
  assert(otherFailure.status === "failed", "The second isolated claim can be closed without leaving an active lease.");
  await Promise.all([
    rpc<void>(rpcClient, "finish_github_enrichment_job", {
      p_job_id: concurrentJob, p_status: "partial", p_error_summary: "integration fixture claims closed",
    }),
    rpc<void>(rpcClient, "finish_github_enrichment_job", {
      p_job_id: recoveryJob, p_status: "partial", p_error_summary: "integration fixture lease recovery closed",
    }),
  ]);

  // Editorial rejection and discard are never claimable.
  const rejectedId = Number(`9855${marker}`);
  const discardedId = Number(`9866${marker}`);
  const rejectedCandidate = await insertCandidate(admin, String(rejectedId), `${marker}-rejected`);
  const discardedCandidate = await insertCandidate(admin, String(discardedId), `${marker}-discarded`);
  await admin.from("repository_candidates").update({ review_status: "rejected" } as never).eq("id", rejectedCandidate);
  await admin.from("repository_candidates").update({ queue_status: "discarded" } as never).eq("id", discardedCandidate);
  const protectedJob = await rpc<string>(rpcClient, "start_github_enrichment_job", { p_resume: false, p_metadata: { fixture: true, protections: true } });
  const protectedClaims = await rpc<Row[]>(rpcClient, "claim_github_enrichment_candidates", {
    p_job_id: protectedJob, p_worker_id: "protection-worker", p_limit: 10, p_lease_seconds: 60,
  });
  assert(!protectedClaims.some((claim) => [rejectedCandidate, discardedCandidate].includes(String(claim.candidate_id))), "Rejected and discarded candidates remain ineligible.");
  await rpc<void>(rpcClient, "finish_github_enrichment_job", {
    p_job_id: protectedJob, p_status: "succeeded", p_error_summary: null,
  });

  const repositoryAnon = await anon.from("repositories").insert({
    provider: "github", provider_repository_id: String(providerId + 999), full_name: "anon/denied", canonical_url: "https://github.com/anon/denied",
  } as never);
  assert(repositoryAnon.error, "Public clients cannot write canonical repositories.");
  const candidateAnon = await anon.from("repository_candidates").select("id").eq("id", candidateId);
  assert(candidateAnon.error, "Public clients cannot read private candidate queues.");
  const claimAnon = await anon.rpc("claim_github_enrichment_candidates" as never, {} as never);
  assert(claimAnon.error, "Public clients cannot execute mutation RPCs.");

  // Transaction rollback is verified below using a real claim and a normalized
  // payload with a deliberately invalid language source index.
  const rollbackId = Number(`9877${marker}`);
  const rollbackCandidateId = await insertCandidate(admin, String(rollbackId), `${marker}-rollback`);
  const rollbackJob = await rpc<string>(rpcClient, "start_github_enrichment_job", { p_resume: false, p_metadata: { fixture: true, rollback: true } });
  const rollbackClaim = (await rpc<Row[]>(rpcClient, "claim_github_enrichment_candidates", {
    p_job_id: rollbackJob, p_worker_id: "rollback-worker", p_limit: 1, p_lease_seconds: 60,
  }))[0];
  assert(rollbackClaim, "Rollback candidate must be claimable.");
  const rollbackFixture = makeGitHubFixture(rollbackId, { observationTime: "2026-11-05T14:00:00.000Z", variant: "newer" });
  const rollbackGithub = createGitHubClient({ fetch: rollbackFixture.fetch, token: null, maxRetries: 0, now: () => Date.parse("2026-11-05T14:00:00.000Z") });
  const rollbackRepo = await rollbackGithub.getRepositoryById(rollbackId);
  assert(rollbackRepo.kind === "ok", "Rollback payload repository fixture must validate.");
  const owner = rollbackRepo.data.owner.login;
  const name = rollbackRepo.data.name;
  const [languages, topics] = await Promise.all([
    rollbackGithub.getRepositoryLanguages(owner, name),
    rollbackGithub.getRepositoryTopics(owner, name, { perPage: 100 }),
  ]);
  const releasePageIterator = rollbackGithub.iterateRepositoryReleasePages(owner, name, { perPage: 2, maxPages: 1, maxItems: 2 });
  const releasePage = await releasePageIterator.next();
  await releasePageIterator.return(undefined);
  assert(languages.kind === "ok" && topics.kind === "ok" && !releasePage.done && releasePage.value.kind === "ok", "Rollback fixture subresources must validate.");
  const { normalizeRepositoryEnrichment } = await import("../src/lib/enrichment/normalize");
  const invalidPayload = normalizeRepositoryEnrichment({
    expectedRepositoryId: String(rollbackId),
    repository: rollbackRepo,
    resources: {
      languages,
      topics,
      releases: { kind: "ok", data: releasePage.value.data, provenance: releasePage.value.provenance },
    },
  }) as unknown as Row;
  const languageBlock = invalidPayload.languages as Row;
  const languageEntries = languageBlock.entries as Row[];
  languageEntries[0] = { ...languageEntries[0], source_index: 999 };
  const rollbackResult = await rpcClient.rpc("commit_github_repository_enrichment", {
    p_candidate_id: rollbackCandidateId,
    p_worker_id: "rollback-worker",
    p_lease_token: rollbackClaim.lease_token,
    p_payload: invalidPayload,
  });
  assert(rollbackResult.error, "Invalid source index must fail the atomic enrichment transaction.");
  const rollbackRows = await admin.from("repositories").select("id").eq("provider", "github").eq("provider_repository_id", String(rollbackId));
  assert(!rollbackRows.error && rollbackRows.data?.length === 0, "Transaction rollback leaves no canonical repository row.");
  const rollbackSources = await admin.from("source_records").select("id").eq("candidate_id", rollbackCandidateId).eq("record_kind", "repository");
  assert(!rollbackSources.error && rollbackSources.data?.length === 0, "Transaction rollback leaves no partial provenance.");
  const rollbackFailure = await rpc<Row>(rpcClient, "fail_github_repository_enrichment", {
    p_candidate_id: rollbackCandidateId,
    p_worker_id: "rollback-worker",
    p_lease_token: rollbackClaim.lease_token,
    p_error_summary: "integration fixture payload rejected",
    p_retryable: false,
    p_retry_after_ms: null,
    p_failure_provenance: null,
  });
  assert(rollbackFailure.status === "failed", "Invalid payload fixture is moved to a terminal candidate state after rollback.");
  await rpc<void>(rpcClient, "finish_github_enrichment_job", {
    p_job_id: rollbackJob, p_status: "partial", p_error_summary: "integration fixture validation failure",
  });

  console.log(JSON.stringify({
    event: "enrichment_integration_passed",
    fixture_candidates: 7,
    canonical_rows: 2,
    real_supabase: true,
    mocked_github_http: true,
    live_github: false,
  }));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown integration failure";
  process.stderr.write(`${JSON.stringify({ event: "enrichment_integration_failed", message: message.slice(0, 500) })}\n`);
  process.exitCode = 1;
});
