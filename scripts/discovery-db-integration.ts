import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import { createGitHubClient } from "../src/lib/github/client";
import type { DiscoveryCliDependencies } from "./discover";
import { runDiscoveryCli } from "./discover";
import { getDiscoveryPlan, splitSaturatedPartition } from "../src/lib/discovery/plans";
import type { Database } from "../src/lib/supabase/database.types";

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

type Claim = {
  id: string;
  partition_key: string;
  query_text: string;
  query_parameters: { sort?: "stars"; order?: "asc" | "desc"; per_page?: number };
  query_fingerprint: string;
  cursor: { next_page?: number } | null;
  lease_token: string;
};

type WorkerEvent = Record<string, unknown>;

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

function partition(key: string, perPage = 1) {
  const query = `topic:outlist-m1-02-${key.slice(0, 8)} is:public fork:false`;
  return {
    partition_key: key,
    provider: "github",
    query_text: query,
    query_fingerprint: `integration-${key}`,
    query_parameters: { sort: "stars", order: "desc", per_page: perPage },
    date_range: {},
    intended_coverage: "Disposable local discovery queue integration test.",
  };
}

function candidate(fullName: string, stars: number, providerId: string) {
  const [owner, name] = fullName.split("/");
  return {
    provider_repository_id: providerId,
    owner_login: owner,
    full_name: fullName,
    canonical_url: `https://github.com/${owner}/${name}`,
    description: "Integration fixture",
    primary_language: "TypeScript",
    stars,
    forks: 2,
    provider_created_at: "2025-01-01T00:00:00Z",
    provider_updated_at: "2026-11-01T00:00:00Z",
    provider_pushed_at: "2026-10-31T00:00:00Z",
    topics: ["outlist-m1-02"],
    source_license_summary: { key: "mit", name: "MIT License", spdx_id: "MIT" },
  };
}

function workerFixtureFetch(request: RequestInfo | URL): Promise<Response> {
  const url = new URL(request instanceof Request ? request.url : String(request));
  const query = url.searchParams.get("q") ?? "";
  const page = Number(url.searchParams.get("page") ?? "1");
  const headers = {
    "content-type": "application/json",
    "x-ratelimit-limit": "30",
    "x-ratelimit-remaining": "29",
    "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 3600),
    "x-ratelimit-resource": "search",
  };
  if (query.includes("topic:developer-tools") && query.includes("stars:>=100")) {
    return Promise.resolve(new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { ...headers, "x-ratelimit-remaining": "0" },
    }));
  }
  if (query.includes("topic:developer-tools") && query.includes("stars:0..99")) {
    const rootRange = "created:2020-01-01..2026-11-05";
    const saturated = query.includes(rootRange);
    return Promise.resolve(new Response(JSON.stringify({
      total_count: saturated ? 1001 : 0,
      incomplete_results: saturated,
      items: [],
    }), { status: 200, headers }));
  }
  if (query.includes("topic:ai-machine-learning") && query.includes("stars:0..99")) {
    const repo = page === 1
      ? searchRepository(880000001, "fixture/first", "2026-11-01T00:00:00Z")
      : searchRepository(880000002, "fixture/second", "2026-11-02T00:00:00Z");
    return Promise.resolve(new Response(JSON.stringify({ total_count: 101, incomplete_results: false, items: [repo] }), { status: 200, headers }));
  }
  if (query.includes("topic:ai-machine-learning") && query.includes("stars:>=100")) {
    return Promise.resolve(new Response(JSON.stringify({
      total_count: 1,
      incomplete_results: false,
      items: [searchRepository(880000001, "fixture/renamed", "2026-11-04T00:00:00Z")],
    }), { status: 200, headers }));
  }
  return Promise.resolve(new Response(JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }), { status: 200, headers }));
}

function searchRepository(id: number, fullName: string, updatedAt: string) {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    id,
    node_id: `R_${id}`,
    name,
    full_name: fullName,
    owner: { id: 880000000, node_id: "O_fixture", login: owner, type: "Organization" },
    html_url: `https://github.com/${fullName}`,
    url: `https://api.github.com/repos/${fullName}`,
    description: "Deterministic discovery worker fixture",
    language: "TypeScript",
    stargazers_count: 10,
    forks_count: 2,
    watchers_count: 12,
    open_issues_count: 1,
    archived: false,
    disabled: false,
    fork: false,
    private: false,
    visibility: "public",
    default_branch: "main",
    topics: ["outlist-m1-02"],
    created_at: "2025-01-01T00:00:00Z",
    updated_at: updatedAt,
    pushed_at: "2026-10-31T00:00:00Z",
    license: { key: "mit", name: "MIT License", spdx_id: "MIT" },
  };
}

async function runWorker(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  github: ReturnType<typeof createGitHubClient>,
  resume: boolean,
  candidateBudget: number,
  maxQueries = 1,
  maxPages = 1,
): Promise<{ events: WorkerEvent[]; errors: WorkerEvent[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: DiscoveryCliDependencies = {
    supabase: admin as unknown as NonNullable<DiscoveryCliDependencies["supabase"]>,
    github,
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  };
  const args = ["--plan", "initial", "--execute", "--max-queries", String(maxQueries), "--max-pages", String(maxPages), "--max-candidates", String(candidateBudget)];
  if (resume) args.push("--resume");
  const status = await runDiscoveryCli(args, dependencies);
  assert(status === 0, `Actual discovery CLI orchestration must succeed for deterministic fixture run; got status ${status}.`);
  const parseLines = (chunks: string[]) => chunks.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as WorkerEvent);
  return { events: parseLines(stdout), errors: parseLines(stderr) };
}

async function main() {
  assert(url && anonKey, "Local Supabase URL and anonymous key are required for queue integration tests.");
  const admin = createSupabaseAdminClient();
  const rpcClient = admin as unknown as RpcClient;
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const marker = randomUUID();
  const providerId = `8810${marker.replaceAll("-", "").slice(0, 12)}`;
  const registrationProviderId = `7710${marker.replaceAll("-", "").slice(0, 12)}`;
  const keys = [`it-${marker}-a`, `it-${marker}-b`, `it-${marker}-c`];

  const pageAlignedPartition = partition(`it-${marker}-page-aligned`, 100);
  const pageAlignedJob = await rpc<string>(rpcClient, "start_discovery_job", {
    p_plan_name: "local-page-aligned-integration", p_plan_version: marker, p_partitions: [pageAlignedPartition],
  });
  const pageAlignedClaim = (await rpc<Claim[]>(rpcClient, "claim_discovery_partitions", {
    p_job_id: pageAlignedJob, p_worker_id: "page-aligned-worker-a", p_limit: 1, p_lease_seconds: 180,
  }))[0];
  assert(pageAlignedClaim, "The page-aligned local fixture must be claimable.");
  await rpc<void>(rpcClient, "release_discovery_partition", {
    p_query_id: pageAlignedClaim.id, p_worker_id: "page-aligned-worker-a", p_lease_token: pageAlignedClaim.lease_token,
  });
  const releasedCheckpoint = await admin.from("discovery_queries")
    .select("status,cursor,pages_fetched,candidates_found,lease_token")
    .eq("id", pageAlignedClaim.id).single();
  assert(!releasedCheckpoint.error && releasedCheckpoint.data.status === "pending"
    && releasedCheckpoint.data.cursor === null && releasedCheckpoint.data.pages_fetched === 0
    && releasedCheckpoint.data.candidates_found === 0 && releasedCheckpoint.data.lease_token === null,
  "Releasing a page that exceeded its candidate budget must keep the checkpoint unchanged and clear only the lease.");
  const retryClaim = (await rpc<Claim[]>(rpcClient, "claim_discovery_partitions", {
    p_job_id: pageAlignedJob, p_worker_id: "page-aligned-worker-b", p_limit: 1, p_lease_seconds: 180,
  }))[0];
  assert(retryClaim?.cursor === null, "A safe retry after release must return to the same first-page checkpoint.");
  const pageAlignedCandidates = Array.from({ length: 100 }, (_, index) => {
    const digits = marker.replace(/\D/g, "").padEnd(12, "0").slice(0, 12);
    const providerRepositoryId = `8${digits}${String(index).padStart(3, "0")}`;
    return candidate(`page-aligned-fixture/repo-${index}`, 100 + index, providerRepositoryId);
  });
  const pageAlignedUrl = new URL("https://api.github.com/search/repositories");
  pageAlignedUrl.searchParams.set("q", retryClaim.query_text);
  pageAlignedUrl.searchParams.set("per_page", "100");
  pageAlignedUrl.searchParams.set("page", "1");
  pageAlignedUrl.searchParams.set("sort", "stars");
  pageAlignedUrl.searchParams.set("order", "desc");
  const pageAlignedCommitArgs = {
    p_query_id: retryClaim.id,
    p_worker_id: "page-aligned-worker-b",
    p_lease_token: retryClaim.lease_token,
    p_query_fingerprint: retryClaim.query_fingerprint,
    p_page: 1,
    p_fetched_at: new Date().toISOString(),
    p_source_url: pageAlignedUrl.href,
    p_http_status: 200,
    p_source_metadata: { api_version: "2022-11-28", resource_type: "repository_search", page: 1, per_page: 100 },
    p_total_count: 100,
    p_incomplete_results: false,
    p_per_page: 100,
    p_candidates: pageAlignedCandidates,
    p_next_state: "exhausted",
    p_children: [],
    p_lease_seconds: 180,
  };
  const pageAlignedCommit = await rpc<Record<string, unknown>>(rpcClient, "commit_discovery_page", pageAlignedCommitArgs);
  assert(pageAlignedCommit.committed === true && pageAlignedCommit.candidates_created === 100,
    "The local PostgreSQL page transaction must persist all 100 candidates with their source page.");
  const pageAlignedReplay = await rpc<Record<string, unknown>>(rpcClient, "commit_discovery_page", pageAlignedCommitArgs);
  assert(pageAlignedReplay.committed === false && pageAlignedReplay.reason === "already_committed",
    "Replaying the committed 100-result page must be idempotent.");
  const pageAlignedIds = pageAlignedCandidates.map((item) => item.provider_repository_id);
  const pageAlignedRows = await admin.from("repository_candidates").select("id,provider_repository_id")
    .eq("provider", "github").in("provider_repository_id", pageAlignedIds);
  assert(!pageAlignedRows.error && pageAlignedRows.data.length === 100
    && new Set(pageAlignedRows.data.map((row) => row.provider_repository_id)).size === 100,
  "The real local database must retain exactly 100 distinct candidates after a safe page replay.");
  const pageAlignedSources = await admin.from("repository_candidate_sources").select("candidate_id,source_record_id")
    .in("candidate_id", pageAlignedRows.data.map((row) => row.id));
  assert(!pageAlignedSources.error && pageAlignedSources.data.length === 100
    && new Set(pageAlignedSources.data.map((row) => row.source_record_id)).size === 1,
  "Every persisted candidate must link to the same committed page provenance record, with no duplicate links after replay.");
  const pageAlignedCheckpoint = await admin.from("discovery_queries")
    .select("status,cursor,pages_fetched,candidates_found")
    .eq("id", retryClaim.id).single();
  assert(!pageAlignedCheckpoint.error && pageAlignedCheckpoint.data.status === "completed"
    && pageAlignedCheckpoint.data.pages_fetched === 1 && pageAlignedCheckpoint.data.candidates_found === 100
    && (pageAlignedCheckpoint.data.cursor as { next_page?: number }).next_page === 2,
  "The page cursor and durable counters must advance together only after the full transaction commits.");
  await rpc<void>(rpcClient, "finish_discovery_job", {
    p_job_id: pageAlignedJob, p_status: "succeeded", p_error_summary: null,
  });

  const registrationPlan = partition(`it-${marker}-registration`);
  const registrationJobA = await rpc<string>(rpcClient, "start_discovery_job", {
    p_plan_name: "local-registration-integration",
    p_plan_version: marker,
    p_partitions: [registrationPlan],
  });
  const registrationClaimA = (await rpc<Claim[]>(rpcClient, "claim_discovery_partitions", {
    p_job_id: registrationJobA,
    p_worker_id: "registration-worker-a",
    p_limit: 1,
    p_lease_seconds: 180,
  }))[0];
  assert(registrationClaimA, "Worker A must own the registration fixture before Worker B registers it.");
  const unchangedBefore = await admin.from("discovery_queries")
    .select("lease_token,cursor,pages_fetched,candidates_found,total_count,incomplete_results,job_id,lock_owner,lease_expires_at,status")
    .eq("id", registrationClaimA.id).single();
  assert(!unchangedBefore.error, "Worker A lease state must be readable by the integration administrator.");
  const registrationJobB = await rpc<string>(rpcClient, "start_discovery_job", {
    p_plan_name: "local-registration-integration",
    p_plan_version: marker,
    p_partitions: [registrationPlan],
  });
  const unchangedAfter = await admin.from("discovery_queries")
    .select("lease_token,cursor,pages_fetched,candidates_found,total_count,incomplete_results,job_id,lock_owner,lease_expires_at,status")
    .eq("id", registrationClaimA.id).single();
  assert(!unchangedAfter.error, "Unchanged registration state must be readable.");
  assert(JSON.stringify(unchangedAfter.data) === JSON.stringify(unchangedBefore.data), "Unchanged registration must preserve A's live lease, checkpoint, counters, and job ownership.");

  const incompatiblePlan = {
    ...registrationPlan,
    query_text: `${registrationPlan.query_text} stars:>=1`,
    query_fingerprint: `${registrationPlan.query_fingerprint}-changed`,
  };
  const rejectedRegistration = await rpcClient.rpc("start_discovery_job", {
    p_plan_name: "local-registration-integration",
    p_plan_version: marker,
    p_partitions: [incompatiblePlan],
  });
  assert(rejectedRegistration.error !== null, "Incompatible same-version registration must be rejected while A's lease is valid.");
  assert(/active discovery lease prevents incompatible plan registration/.test(rejectedRegistration.error.message), "Lease conflict must return a clear registration error.");
  const rejectedVersionBump = await rpcClient.rpc("start_discovery_job", {
    p_plan_name: "local-registration-integration",
    p_plan_version: `${marker}-v2`,
    p_partitions: [{ ...incompatiblePlan, query_fingerprint: `${incompatiblePlan.query_fingerprint}-v2` }],
  });
  assert(rejectedVersionBump.error !== null && /active discovery lease prevents incompatible plan registration/.test(rejectedVersionBump.error.message), "Even an explicit version bump must not invalidate a live lease.");
  const unchangedAfterReject = await admin.from("discovery_queries")
    .select("lease_token,cursor,pages_fetched,candidates_found,total_count,incomplete_results,job_id,lock_owner,lease_expires_at,status")
    .eq("id", registrationClaimA.id).single();
  assert(!unchangedAfterReject.error && JSON.stringify(unchangedAfterReject.data) === JSON.stringify(unchangedBefore.data), "Rejected registration must atomically leave the original lease and counters unchanged.");

  const jobId = await rpc<string>(rpcClient, "start_discovery_job", {
    p_plan_name: "local-integration",
    p_plan_version: marker,
    p_partitions: keys.map(partition),
  });

  const claims = await Promise.all(["integration-worker-a", "integration-worker-b"].map((worker) =>
    rpc<Claim[]>(rpcClient, "claim_discovery_partitions", {
      p_job_id: jobId,
      p_worker_id: worker,
      p_limit: 1,
      p_lease_seconds: 180,
    }),
  ));
  const claimA = claims[0]?.[0];
  const claimB = claims[1]?.[0];
  assert(claimA && claimB, "Concurrent workers must each claim one partition.");
  assert(claimA.id !== claimB.id, "Concurrent workers cannot claim the same partition.");

  const perPage = 1;
  const sourceUrl = (task: Claim, page: number) => {
    const source = new URL("https://api.github.com/search/repositories");
    source.searchParams.set("q", task.query_text);
    source.searchParams.set("per_page", String(perPage));
    source.searchParams.set("page", String(page));
    source.searchParams.set("sort", "stars");
    source.searchParams.set("order", "desc");
    return source.href;
  };
  const commit = (task: Claim, worker: string, page: number, name: string, stars: number, state: string, total: number, candidateId = providerId) =>
    rpc<Record<string, unknown>>(rpcClient, "commit_discovery_page", {
      p_query_id: task.id,
      p_worker_id: worker,
      p_lease_token: task.lease_token,
      p_query_fingerprint: task.query_fingerprint,
      p_page: page,
      p_fetched_at: new Date().toISOString(),
      p_source_url: sourceUrl(task, page),
      p_http_status: 200,
      p_source_metadata: {
        api_version: "2022-11-28",
        resource_type: "repository_search",
        rate_limit: { resource: "search", remaining: 29 },
        total_count: total,
        incomplete_results: false,
        page,
        per_page: perPage,
      },
      p_total_count: total,
      p_incomplete_results: false,
      p_per_page: perPage,
      p_candidates: [candidate(name, stars, candidateId)],
      p_next_state: state,
      p_children: [],
      p_lease_seconds: 180,
    });

  const workerACommit = await commit(registrationClaimA, "registration-worker-a", 1, "registration/tool", 1, "yield", 2, registrationProviderId);
  assert(workerACommit.committed === true, "Worker A must still be able to commit with its original token after B's rejected registration.");
  const resumedClaimB = (await rpc<Claim[]>(rpcClient, "claim_discovery_partitions", {
    p_job_id: registrationJobB,
    p_worker_id: "registration-worker-b",
    p_limit: 1,
    p_lease_seconds: 180,
  }))[0];
  assert(resumedClaimB?.cursor?.next_page === 2, "A resumed worker must claim the persisted next page, not restart at page one.");
  await commit(resumedClaimB, "registration-worker-b", 2, "registration/renamed-tool", 2, "exhausted", 2, registrationProviderId);
  const registrationCheckpoint = await admin.from("discovery_queries")
    .select("cursor,pages_fetched,candidates_found,status")
    .eq("id", registrationClaimA.id).single();
  assert(!registrationCheckpoint.error && registrationCheckpoint.data.pages_fetched === 2 && registrationCheckpoint.data.candidates_found === 2, "Resumed registration fixture must retain both committed pages and counters.");
  assert((registrationCheckpoint.data.cursor as { next_page?: number }).next_page === 3, "Resumed registration fixture must checkpoint the page after the committed second page.");
  const incompatibleCompletedRegistration = await rpcClient.rpc("start_discovery_job", {
    p_plan_name: "local-registration-integration",
    p_plan_version: marker,
    p_partitions: [incompatiblePlan],
  });
  assert(incompatibleCompletedRegistration.error !== null && /incompatible discovery definition/.test(incompatibleCompletedRegistration.error.message), "A completed checkpoint must reject an incompatible same-version definition.");
  const checkpointAfterCompletedConflict = await admin.from("discovery_queries")
    .select("cursor,pages_fetched,candidates_found,status")
    .eq("id", registrationClaimA.id).single();
  assert(!checkpointAfterCompletedConflict.error && JSON.stringify(checkpointAfterCompletedConflict.data) === JSON.stringify(registrationCheckpoint.data), "Rejected completed-checkpoint registration must preserve all progress.");
  await admin.from("repository_candidates").update({ queue_status: "discarded", review_status: "rejected" } as never)
    .eq("provider", "github").eq("provider_repository_id", registrationProviderId);
  const newVersionJob = await rpc<string>(rpcClient, "start_discovery_job", {
    p_plan_name: "local-registration-integration",
    p_plan_version: `${marker}-v2`,
    p_partitions: [{ ...incompatiblePlan, query_fingerprint: `${registrationPlan.query_fingerprint}-v2` }],
  });
  assert(typeof newVersionJob === "string", "An explicit new plan version may register an incompatible definition after the lease ends.");
  const resetCheckpoint = await admin.from("discovery_queries")
    .select("cursor,pages_fetched,candidates_found,status,query_fingerprint")
    .eq("id", registrationClaimA.id).single();
  assert(!resetCheckpoint.error && resetCheckpoint.data.status === "pending" && resetCheckpoint.data.pages_fetched === 0 && resetCheckpoint.data.candidates_found === 0 && resetCheckpoint.data.cursor === null, "An explicit plan-version change must visibly reset only the incompatible checkpoint.");
  const preservedCandidate = await admin.from("repository_candidates").select("queue_status,review_status")
    .eq("provider", "github").eq("provider_repository_id", registrationProviderId).single();
  assert(!preservedCandidate.error && preservedCandidate.data.queue_status === "discarded" && preservedCandidate.data.review_status === "rejected", "Explicit checkpoint reset must preserve candidate rows and review decisions.");

  const firstCommit = await commit(claimA, "integration-worker-a", 1, "integration/tool", 1, "more", 2);
  assert(firstCommit.committed === true, "First page must commit.");
  const duplicate = await commit(claimA, "integration-worker-a", 1, "integration/tool", 1, "more", 2);
  assert(duplicate.committed === false && duplicate.reason === "already_committed", "Repeated page commit must be idempotent.");
  const secondCommit = await commit(claimA, "integration-worker-a", 2, "integration/renamed-tool", 2, "exhausted", 2);
  assert(secondCommit.status === "completed", "Last page must complete its partition.");
  const replayFinalPage = await commit(claimA, "integration-worker-a", 2, "integration/renamed-tool", 2, "exhausted", 2);
  assert(replayFinalPage.committed === false && replayFinalPage.reason === "already_committed", "Completed page replay must be idempotent after the lease is cleared.");
  await commit(claimB, "integration-worker-b", 1, "integration/renamed-tool", 3, "exhausted", 1);

  const candidateResult = await admin.from("repository_candidates").select("*")
    .eq("provider", "github").eq("provider_repository_id", providerId);
  assert(!candidateResult.error, "Candidate query must succeed.");
  const candidateRows = candidateResult.data as unknown as Array<Record<string, unknown>>;
  assert(candidateRows.length === 1, "Overlapping partitions must keep one candidate row.");
  assert(candidateRows[0].full_name === "integration/renamed-tool", "Repository rename must update metadata.");
  const candidateId = candidateRows[0].id as string;
  const provenanceResult = await admin.from("repository_candidate_sources").select("source_record_id")
    .eq("candidate_id", candidateId);
  assert(!provenanceResult.error && provenanceResult.data.length === 3, "All three committed page observations must retain provenance.");
  const queryResult = await admin.from("discovery_queries").select("pages_fetched,candidates_found,cursor,status")
    .eq("id", claimA.id).single();
  assert(!queryResult.error, "Checkpoint query must succeed.");
  assert(queryResult.data.pages_fetched === 2 && queryResult.data.candidates_found === 2, "Duplicate page must not increment durable counters.");
  assert((queryResult.data.cursor as { next_page?: number }).next_page === 3, "Checkpoint must resume at the next uncommitted page.");

  const anonResult = await anon.from("repository_candidates").select("id").limit(1);
  assert(anonResult.error !== null, "Ordinary anonymous clients must not read operational candidates.");
  const anonMutation = await anon.rpc("start_discovery_job", {
    p_plan_name: "unauthorized-integration",
    p_plan_version: marker,
    p_partitions: [partition(`it-${marker}-unauthorized`) as never],
  });
  assert(anonMutation.error !== null, "Ordinary anonymous clients must not invoke privileged discovery mutations.");

  const expiryJob = await rpc<string>(rpcClient, "start_discovery_job", {
    p_plan_name: "local-expiry-integration",
    p_plan_version: marker,
    p_partitions: [partition(`it-${marker}-expiry`)],
  });
  const stale = (await rpc<Claim[]>(rpcClient, "claim_discovery_partitions", {
    p_job_id: expiryJob, p_worker_id: "stale-worker", p_limit: 1, p_lease_seconds: 30,
  }))[0];
  assert(stale, "Lease test partition must be claimable.");
  const expireUpdate = await admin.from("discovery_queries").update({ lease_expires_at: new Date(Date.now() - 1_000).toISOString() } as never)
    .eq("id", stale.id);
  assert(!expireUpdate.error, "Integration test must expire the local lease.");
  const fresh = (await rpc<Claim[]>(rpcClient, "claim_discovery_partitions", {
    p_job_id: expiryJob, p_worker_id: "fresh-worker", p_limit: 1, p_lease_seconds: 30,
  }))[0];
  assert(fresh && fresh.id === stale.id && fresh.lease_token !== stale.lease_token, "Expired claim must be recovered with a new fence token.");

  const staleWrite = await rpcClient.rpc("commit_discovery_page", {
    p_query_id: stale.id,
    p_worker_id: "stale-worker",
    p_lease_token: stale.lease_token,
    p_query_fingerprint: stale.query_fingerprint,
    p_page: 1,
    p_fetched_at: new Date().toISOString(),
    p_source_url: sourceUrl(stale, 1),
    p_http_status: 200,
    p_source_metadata: {},
    p_total_count: 0,
    p_incomplete_results: false,
    p_per_page: 1,
    p_candidates: [],
    p_next_state: "exhausted",
    p_children: [],
    p_lease_seconds: 180,
  });
  assert(staleWrite.error?.code === "40001", "Expired worker must be fenced from commit.");

  const retryState = await rpc<Record<string, unknown>>(rpcClient, "fail_discovery_partition", {
    p_query_id: fresh.id,
    p_worker_id: "fresh-worker",
    p_lease_token: fresh.lease_token,
    p_error_summary: "rate_limit; resource search; retry after 60s",
    p_retryable: true,
    p_retry_after_ms: 60_000,
  });
  assert(retryState.status === "retry_wait", "Retryable failures must be persisted as retry wait.");
  const retryRow = await admin.from("discovery_queries").select("status,next_attempt_at")
    .eq("id", fresh.id).single();
  assert(!retryRow.error && retryRow.data.status === "retry_wait" && Date.parse(retryRow.data.next_attempt_at ?? "") > Date.now(), "Retry time must be persisted in the future.");
  await admin.from("discovery_queries").update({ next_attempt_at: new Date(Date.now() - 1_000).toISOString() } as never)
    .eq("id", fresh.id);
  const terminal = (await rpc<Claim[]>(rpcClient, "claim_discovery_partitions", {
    p_job_id: expiryJob, p_worker_id: "terminal-worker", p_limit: 1, p_lease_seconds: 30,
  }))[0];
  assert(terminal, "Retry-wait partition must become claimable at its scheduled retry time.");
  const terminalState = await rpc<Record<string, unknown>>(rpcClient, "fail_discovery_partition", {
    p_query_id: terminal.id,
    p_worker_id: "terminal-worker",
    p_lease_token: terminal.lease_token,
    p_error_summary: "validation; HTTP 422",
    p_retryable: false,
    p_retry_after_ms: null,
  });
  assert(terminalState.status === "failed", "Non-retryable failure must be terminal.");
  await rpc(rpcClient, "finish_discovery_job", { p_job_id: expiryJob, p_status: "partial", p_error_summary: null });
  await rpc(rpcClient, "finish_discovery_job", { p_job_id: jobId, p_status: "partial", p_error_summary: null });

  const workerPartitions = getDiscoveryPlan("initial");
  const workerRequests: string[] = [];
  const github = createGitHubClient({
    fetch: (input) => {
      workerRequests.push(new URL(input instanceof Request ? input.url : String(input)).href);
      return workerFixtureFetch(input);
    },
    maxRetries: 0,
    maxRateLimitWaitMs: 0,
  });
  const resumePartition = workerPartitions.find((query) => query.queryText.includes("topic:ai-machine-learning") && query.queryText.includes("stars:0..99"));
  const overlapPartition = workerPartitions.find((query) => query.queryText.includes("topic:ai-machine-learning") && query.queryText.includes("stars:>=100"));
  const saturatedPartition = workerPartitions.find((query) => query.queryText.includes("topic:developer-tools") && query.queryText.includes("stars:0..99"));
  const rateLimitPartition = workerPartitions.find((query) => query.queryText.includes("topic:developer-tools") && query.queryText.includes("stars:>=100"));
  assert(workerPartitions.length === 10 && resumePartition && overlapPartition && saturatedPartition && rateLimitPartition, "The real worker must register the ten approved partitions and exercise its deterministic fixtures.");
  const resumeKey = resumePartition.partitionKey;
  const overlapKey = overlapPartition.partitionKey;
  const saturatedKey = saturatedPartition.partitionKey;
  const rateLimitKey = rateLimitPartition.partitionKey;

  const firstRun = await runWorker(admin, github, false, 1);
  const firstPageEvent = firstRun.events.find((event) => event.event === "page_committed");
  assert(firstPageEvent?.partition_key === resumeKey && firstPageEvent.page === 1, "The real CLI orchestration must fetch and commit fixture page one.");
  const firstCheckpoint = await admin.from("discovery_queries")
    .select("cursor,pages_fetched,candidates_found,status,query_parameters")
    .eq("partition_key", resumeKey).single();
  assert(!firstCheckpoint.error && firstCheckpoint.data.pages_fetched === 1 && firstCheckpoint.data.candidates_found === 1 && firstCheckpoint.data.status === "pending", "First bounded run must persist one page and yield its checkpoint.");
  assert((firstCheckpoint.data.cursor as { next_page?: number }).next_page === 2, "First bounded run must persist page two as the next page.");
  assert((firstCheckpoint.data.query_parameters as { per_page?: number }).per_page === 100, "Candidate execution budget must not rewrite the registered page size.");

  const resumedRun = await runWorker(admin, github, true, 2);
  const resumedPageEvent = resumedRun.events.find((event) => event.event === "page_committed");
  assert(resumedPageEvent?.partition_key === resumeKey && resumedPageEvent.page === 2, "--resume with a changed candidate budget must continue at page two.");
  const resumedCheckpoint = await admin.from("discovery_queries")
    .select("cursor,pages_fetched,candidates_found,status")
    .eq("partition_key", resumeKey).single();
  assert(!resumedCheckpoint.error && resumedCheckpoint.data.status === "completed" && resumedCheckpoint.data.pages_fetched === 2 && resumedCheckpoint.data.candidates_found === 2, "Resumed execution must preserve and advance the existing page and candidate counters.");
  assert((resumedCheckpoint.data.cursor as { next_page?: number }).next_page === 3, "Resumed execution must advance to the page after the second commit.");

  const overlapRun = await runWorker(admin, github, true, 10);
  assert(overlapRun.events.some((event) => event.event === "page_committed" && event.partition_key === overlapKey), "A second overlapping query must commit through the real CLI path.");
  const saturatedRun = await runWorker(admin, github, true, 10);
  assert(saturatedRun.events.some((event) => event.event === "page_committed" && event.partition_key === saturatedKey && event.state === "needs_review"), "Incomplete or over-window search must enter review/split handling.");
  const saturationState = await admin.from("discovery_queries").select("status")
    .eq("partition_key", saturatedKey).single();
  assert(!saturationState.error && saturationState.data.status === "needs_review", "Saturated parent partition must persist needs_review.");

  const rateLimitRun = await runWorker(admin, github, true, 10);
  assert(rateLimitRun.errors.some((event) => event.event === "partition_failure" && event.error_kind === "rate_limit" && event.state === "retry_wait"), "GitHub rate-limit response must become persisted retry_wait through the real worker.");
  const retryWait = await admin.from("discovery_queries").select("status,next_attempt_at,last_error")
    .eq("partition_key", rateLimitKey).single();
  assert(!retryWait.error && retryWait.data.status === "retry_wait" && Date.parse(retryWait.data.next_attempt_at ?? "") > Date.now(), "Rate-limit retry time and safe error summary must be persisted.");

  const saturationChildren = splitSaturatedPartition(saturatedPartition);
  assert(saturationChildren, "The saturated date-range fixture must split into two adjacent children.");
  const childLeft = saturationChildren[0].partitionKey;
  const childRight = saturationChildren[1].partitionKey;
  const drainRun = await runWorker(admin, github, true, 100, 20, 10);
  assert(drainRun.events.some((event) => event.event === "page_committed" && event.partition_key === childLeft), "The first date-split child must be claimed and committed.");
  assert(drainRun.events.some((event) => event.event === "page_committed" && event.partition_key === childRight), "The second date-split child must be claimed and committed.");

  const duplicateCandidate = await admin.from("repository_candidates").select("id,full_name")
    .eq("provider", "github").eq("provider_repository_id", "880000001");
  assert(!duplicateCandidate.error && duplicateCandidate.data.length === 1, "Overlapping fixture pages must keep one candidate by stable GitHub ID.");
  assert(duplicateCandidate.data[0]?.full_name === "fixture/renamed", "A repository rename must update metadata without changing identity.");
  const resumeQuery = await admin.from("discovery_queries").select("id").eq("partition_key", resumeKey).single();
  const overlapQuery = await admin.from("discovery_queries").select("id").eq("partition_key", overlapKey).single();
  assert(!resumeQuery.error && !overlapQuery.error, "Worker query IDs must be available for provenance checks.");
  const candidateSources = await admin.from("repository_candidate_sources").select("source_record_id")
    .eq("candidate_id", duplicateCandidate.data[0]!.id)
    .in("discovery_query_id", [resumeQuery.data.id, overlapQuery.data.id]);
  assert(!candidateSources.error && candidateSources.data.length === 2, "Overlapping observations must retain separate source provenance links.");
  const canonicalRepository = await admin.from("repositories").select("id")
    .eq("provider", "github").eq("provider_repository_id", "880000001");
  assert(!canonicalRepository.error && canonicalRepository.data.length === 0, "Discovery worker must not write canonical repositories.");
  const canonicalProject = await admin.from("projects").select("id").eq("slug", "fixture-renamed");
  assert(!canonicalProject.error && canonicalProject.data.length === 0, "Discovery worker must not write canonical projects.");
  assert(workerRequests.length === 13 && workerRequests.every((request) => new URL(request).origin === "https://api.github.com"), "Only the deterministic GitHub Search transport fixture may service these thirteen worker requests.");

  process.stdout.write(`${JSON.stringify({
    event: "discovery_db_integration_passed",
    concurrency: "two simultaneous claims owned distinct partitions",
    candidate_rows: candidateRows.length,
    provenance_links: provenanceResult.data.length,
    checkpoint_pages: queryResult.data.pages_fetched,
    duplicate_page_counter_safe: true,
    expired_lease_fenced: true,
    retry_wait_persisted: true,
    terminal_failure_persisted: true,
    rls_denied_ordinary_client: true,
    rpc_denied_ordinary_client: true,
    registration_conflict_preserved_active_lease: true,
    explicit_version_reset_preserved_candidate_review: true,
    actual_worker_orchestration: true,
    worker_http_fixture_requests: workerRequests.length,
    worker_resume_page: 2,
    worker_overlap_identity_preserved: true,
    worker_saturated_partition_reviewed: true,
    worker_rate_limit_retry_wait: true,
    worker_canonical_writes: 0,
    live_github_crawl: false,
    hosted_supabase_verified: false,
  })}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 300) : "unexpected database integration failure";
  process.stderr.write(`${JSON.stringify({ event: "discovery_db_integration_failed", message })}\n`);
  process.exitCode = 1;
}
