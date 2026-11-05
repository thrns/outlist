import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
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

function partition(key: string) {
  const query = `topic:outlist-m1-02-${key.slice(0, 8)} is:public fork:false`;
  return {
    partition_key: key,
    provider: "github",
    query_text: query,
    query_fingerprint: `integration-${key}`,
    query_parameters: { sort: "stars", order: "desc", per_page: 1 },
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

async function main() {
  assert(url && anonKey, "Local Supabase URL and anonymous key are required for queue integration tests.");
  const admin = createSupabaseAdminClient();
  const rpcClient = admin as unknown as RpcClient;
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const marker = randomUUID();
  const providerId = `8810${marker.replaceAll("-", "").slice(0, 12)}`;
  const keys = [`it-${marker}-a`, `it-${marker}-b`, `it-${marker}-c`];
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
  const commit = (task: Claim, worker: string, page: number, name: string, stars: number, state: string, total: number) =>
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
      p_candidates: [candidate(name, stars, providerId)],
      p_next_state: state,
      p_children: [],
      p_lease_seconds: 180,
    });

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
  })}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 300) : "unexpected database integration failure";
  process.stderr.write(`${JSON.stringify({ event: "discovery_db_integration_failed", message })}\n`);
  process.exitCode = 1;
}
