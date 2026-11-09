import { randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runAssessmentCli, type AssessmentCliDependencies } from "./assess";
import { runEnrichmentCli, type EnrichmentCliDependencies } from "./enrich";
import { createGitHubClient } from "../src/lib/github/client";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";

type Row = Record<string, unknown>;
type RpcClient = { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }> };
type DbResult = { data: unknown; error: { message: string; code?: string } | null };
interface TestQuery extends PromiseLike<DbResult> {
  select(columns: string): TestQuery;
  insert(values: Record<string, unknown>): TestQuery;
  update(values: Record<string, unknown>): TestQuery;
  eq(column: string, value: string | number | boolean): TestQuery;
  in(column: string, values: string[]): TestQuery;
  limit(count: number): TestQuery;
  single(): Promise<DbResult>;
}
interface TestDatabase extends RpcClient { from(table: string): TestQuery }
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function rpc<T>(client: RpcClient, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.rpc(name, args);
  assert(!result.error, `RPC ${name} failed (${result.error?.code ?? "unknown"}).`);
  return result.data as T;
}
async function rows<T extends Row>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>, message: string): Promise<T[]> {
  const result = await query;
  assert(!result.error && Array.isArray(result.data), `${message} failed.`);
  return result.data as T[];
}
async function single<T extends Row>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>, message: string): Promise<T> {
  const result = await query;
  assert(!result.error && result.data && !Array.isArray(result.data), `${message} failed.`);
  return result.data as T;
}

function githubFixture(id: number, observationTime: string, renamed: boolean, topic = "developer-tools", isPrivate = false) {
  const owner = renamed ? `new-owner-${id}` : `fixture-${id}`;
  const name = renamed ? `renamed-${id}` : `project-${id}`;
  const fullName = `${owner}/${name}`;
  const requests: string[] = [];
  const body = {
    id, node_id: `R_${id}`, name, full_name: fullName,
    owner: { id: id + 50, node_id: `O_${id}`, login: owner, type: "Organization" },
    html_url: `https://github.com/${fullName}`, url: `https://api.github.com/repos/${fullName}`,
    description: "A developer tool for deterministic assessment fixtures", homepage: null,
    topics: [topic], language: "TypeScript", stargazers_count: 1, forks_count: 0,
    watchers_count: 1, open_issues_count: 0, archived: false, disabled: false, fork: false,
    private: isPrivate, visibility: isPrivate ? "private" : "public", default_branch: "main", created_at: "2026-10-01T00:00:00.000Z",
    updated_at: observationTime, pushed_at: observationTime,
    license: { key: "mit", name: "MIT License", spdx_id: "MIT", url: "https://api.github.com/licenses/mit", html_url: `https://github.com/${fullName}/blob/main/LICENSE`, node_id: `L_${id}` },
  };
  const fetcher: typeof fetch = async (input) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    requests.push(requestUrl.href);
    const headers = new Headers({ "content-type": "application/vnd.github+json", etag: `"fixture-${id}-${renamed}"`, "x-github-api-version-selected": "2022-11-28" });
    if (requestUrl.pathname === `/repositories/${id}`) return new Response(JSON.stringify(body), { status: 200, headers });
    if (requestUrl.pathname.endsWith("/languages")) return new Response(JSON.stringify({ TypeScript: 900, CSS: 100 }), { status: 200, headers });
    if (requestUrl.pathname.endsWith("/topics")) return new Response(JSON.stringify({ names: [topic] }), { status: 200, headers });
    if (requestUrl.pathname.endsWith("/releases")) return new Response(JSON.stringify([{
      id: id + 1000, node_id: `REL_${id}`, tag_name: "v1.0.0", name: "First release",
      url: `https://api.github.com/repos/${fullName}/releases/${id + 1000}`,
      html_url: `https://github.com/${fullName}/releases/tag/v1.0.0`, created_at: observationTime,
      published_at: observationTime, draft: false, prerelease: false,
    }]), { status: 200, headers });
    throw new Error(`Unexpected fixture request: ${requestUrl.pathname}`);
  };
  return { fetcher, requests };
}

async function runEnrichment(admin: ReturnType<typeof createSupabaseAdminClient>, id: number, time: string, renamed: boolean, topic = "developer-tools", isPrivate = false) {
  const fixture = githubFixture(id, time, renamed, topic, isPrivate);
  const github = createGitHubClient({ fetch: fixture.fetcher, token: null, now: () => Date.parse(time), maxRetries: 0, maxRateLimitWaitMs: 0 });
  const output: string[] = []; const errors: string[] = [];
  const db = admin as unknown as TestDatabase;
  const claimable = await rows<Row>(db.from("repository_candidates")
    .select("provider_repository_id,queue_status,enrichment_status")
    .eq("provider", "github").in("queue_status", ["queued", "retry_wait"]), "Isolate fixture enrichment claims");
  const suppressed = claimable.filter((candidate) => candidate.provider_repository_id !== String(id)
    && candidate.enrichment_status !== "processing");
  for (const candidate of suppressed) {
    const updated = await db.from("repository_candidates").update({ queue_status: "discarded" })
      .eq("provider", "github").eq("provider_repository_id", String(candidate.provider_repository_id));
    assert(!updated.error, "Could not isolate another candidate from the deterministic enrichment fixture.");
  }
  let status: number;
  try {
    status = await runEnrichmentCli(["--execute", "--max-candidates", "1", "--max-releases", "1"], {
      supabase: admin as unknown as NonNullable<EnrichmentCliDependencies["supabase"]>,
      github,
      writeStdout: (line) => output.push(line), writeStderr: (line) => errors.push(line),
    });
  } finally {
    for (const candidate of suppressed) {
      const updated = await db.from("repository_candidates").update({ queue_status: candidate.queue_status })
        .eq("provider", "github").eq("provider_repository_id", String(candidate.provider_repository_id));
      assert(!updated.error, "Could not restore the queue state after deterministic enrichment fixture work.");
    }
  }
  if (isPrivate) {
    assert(status === 1 && errors.join("").includes("source_access_restricted"), "The private GitHub fixture must become a terminal access-restriction outcome.");
    assert(fixture.requests.length === 1, "A private GitHub response must be rejected before languages, topics, or releases are fetched.");
  } else {
    const neighboringCandidates = await rows<Row>(
      db.from("repository_candidates")
        .select("provider_repository_id,queue_status,enrichment_status,enrichment_attempts,enrichment_next_attempt_at")
        .in("provider_repository_id", [String(id - 1), String(id), String(id + 1)]),
      "Inspect fixture enrichment queue state"
    );
    assert(status === 0, `Fixture enrichment failed (${id}): ${JSON.stringify({ errors: errors.join("").slice(0, 100), requests: fixture.requests.map((request) => new URL(request).pathname), candidates: neighboringCandidates })}`);
    assert(fixture.requests.length >= 4, "Enrichment must make bounded deterministic GitHub HTTP fixture requests.");
    const candidate = await single<Row>(admin.from("repository_candidates").select("provider_repository_id,enrichment_status").eq("provider_repository_id", String(id)).single(), "Verify successful fixture enrichment state");
    assert(candidate.enrichment_status === "succeeded", `Fixture ${id} did not reach succeeded enrichment state (${String(candidate.enrichment_status)}).`);
  }
  const expectedRepositoryPath = `/repos/${renamed ? `new-owner-${id}` : `fixture-${id}`}/${renamed ? `renamed-${id}` : `project-${id}`}`;
  const unexpectedRequest = fixture.requests.find((request) => {
    const path = new URL(request).pathname;
    return path !== `/repositories/${id}` && !path.startsWith(`/repositories/${id}/`)
      && path !== expectedRepositoryPath && !path.startsWith(`${expectedRepositoryPath}/`);
  });
  assert(!unexpectedRequest, `Enrichment claimed a candidate outside its deterministic fixture (${id}): ${unexpectedRequest ? new URL(unexpectedRequest).pathname : "unknown"}.`);
  return output.join("");
}

async function insertCandidate(db: TestDatabase, id: number, marker: string) {
  const source = await single<Row>(db.from("source_records").insert({
    provider: "github", record_kind: "discovery_page", source_key: `${marker}:${id}`,
    source_url: "https://api.github.com/search/repositories?q=outlist-assessment-fixture",
    fetched_at: new Date().toISOString(), http_status: 200,
    source_metadata: { api_version: "2022-11-28", fixture: true },
  }).select("id").single(), "Create assessment candidate provenance");
  await single<Row>(db.from("repository_candidates").insert({
    provider: "github", provider_repository_id: String(id), full_name: `fixture-${id}/project-${id}`,
    canonical_url: `https://github.com/fixture-${id}/project-${id}`, owner_login: `fixture-${id}`,
    source_record_id: source.id, queue_status: "queued", review_status: "unreviewed",
  }).select("id").single(), "Create assessment candidate");
}

async function runAssessment(admin: ReturnType<typeof createSupabaseAdminClient>, max: number) {
  const output: string[] = []; const errors: string[] = [];
  const deps: AssessmentCliDependencies = {
    supabase: admin as unknown as NonNullable<AssessmentCliDependencies["supabase"]>,
    writeStdout: (line) => output.push(line), writeStderr: (line) => errors.push(line),
    now: () => new Date("2026-11-06T12:00:00.000Z"),
  };
  const status = await runAssessmentCli(["--execute", "--max-repositories", String(max)], deps);
  assert(status === 0, `Assessment CLI failed: ${errors.join("").slice(0, 300)}`);
  return output.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

async function runAssessmentRecovery(admin: ReturnType<typeof createSupabaseAdminClient>, jobId: string) {
  const output: string[] = []; const errors: string[] = [];
  const status = await runAssessmentCli(["--execute", "--resume", "--max-repositories", "4"], {
    supabase: admin as unknown as NonNullable<AssessmentCliDependencies["supabase"]>,
    recoveryJobId: jobId,
    writeStdout: (line) => output.push(line), writeStderr: (line) => errors.push(line),
    now: () => new Date("2026-11-06T12:00:00.000Z"),
  });
  assert(status === 0, `Assessment recovery worker failed: ${errors.join("").slice(0, 300)}`);
  return output.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

async function main() {
  assert(url && anonKey, "Local Supabase URL and anon key are required.");
  const admin = createSupabaseAdminClient();
  const db = admin as unknown as TestDatabase;
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) as unknown as TestDatabase;
  const priorProcessing = await db.from("repository_candidates").update({
    queue_status: "discarded", locked_at: null, lock_owner: null,
    enrichment_status: "failed", enrichment_completed_at: new Date().toISOString(), enrichment_next_attempt_at: null,
    enrichment_locked_at: null, enrichment_lease_expires_at: null, enrichment_lease_token: null,
    enrichment_lock_owner: null, enrichment_error: "assessment_integration_isolation",
  }).eq("provider", "github").eq("queue_status", "processing");
  assert(!priorProcessing.error, "Could not clear a stale processing candidate from the prior integration suite.");
  const priorCandidates = await db.from("repository_candidates").update({ queue_status: "discarded" }).eq("provider", "github").in("queue_status", ["queued", "retry_wait", "succeeded", "dead_letter"]);
  assert(!priorCandidates.error, "Could not isolate assessment fixtures from candidates created by earlier integration suites.");
  const leftoverCandidates = await rows<Row>(db.from("repository_candidates").select("id,provider_repository_id,queue_status,enrichment_status").eq("provider", "github").in("queue_status", ["queued", "retry_wait", "processing"]), "Verify prior candidates were removed from the enrichment queue");
  assert(leftoverCandidates.length === 0, `Prior integration candidates remain claimable: ${JSON.stringify(leftoverCandidates.map(({ provider_repository_id, queue_status, enrichment_status }) => ({ provider_repository_id, queue_status, enrichment_status })))}`);
  const idOne = randomInt(600_000_000, 700_000_000);
  const idTwo = idOne + 1;
  const idThree = idOne + 2;
  const marker = `assessment-it-${idOne}`;
  for (const id of [idOne, idTwo]) await insertCandidate(db, id, marker);

  const firstTime = "2026-11-05T10:00:00.000Z";
  const secondTime = "2026-11-05T10:01:00.000Z";
  const enrichmentOne = await runEnrichment(admin, idOne, firstTime, false);
  const firstCandidate = await single<Row>(db.from("repository_candidates").select("queue_status,enrichment_status,enrichment_attempts").eq("provider_repository_id", String(idOne)).single(), "Verify first fixture enrichment state before the next claim");
  assert(firstCandidate.enrichment_status === "succeeded", `The first fixture must be terminally enriched before adding another claim target: ${JSON.stringify(firstCandidate)}`);
  const enrichmentTwo = await runEnrichment(admin, idTwo, secondTime, false);
  assert(enrichmentOne.includes('"enriched":1') && enrichmentTwo.includes('"enriched":1'), "Both complete fixtures must be enriched successfully.");

  const events = await runAssessment(admin, 2);
  const summary = events.find((event) => event.event === "assessment_summary");
  assert(summary && summary.assessed === 2 && summary.drafted === 2 && summary.queued_for_review === 2, "The bounded assessment run should create two reviewable drafts.");
  const projects = await rows<Row>(db.from("projects").select("id,slug,name,summary,description,primary_repository_id,publication_status,quality_status,license_status,license_verified_at,published_at,featured"), "Read assessment drafts");
  const created = projects.filter((project) => project.slug === `github-${idOne}` || project.slug === `github-${idTwo}`);
  assert(created.length === 2, "Assessment should create exactly one project per canonical repository.");
  assert(created.every((project) => project.publication_status === "pending_review" && project.published_at === null && project.featured === false), "Assessment drafts must remain unpublished and unfeatured.");
  assert(created.every((project) => project.quality_status === "unreviewed" && project.license_status === "unverified" && project.license_verified_at === null), "Assessment must not verify quality or licensing.");
  assert(created.every((project) => project.summary === "" && typeof project.description === "string"), "Draft content must use source-backed descriptions without generated summaries.");

  const repo = await single<Row>(db.from("repositories").select("id,project_id,primary_language").eq("provider_repository_id", String(idOne)).limit(1).single(), "Read primary repository");
  const project = created.find((item) => item.slug === `github-${idOne}`)!;
  assert(repo.project_id === project.id && project.primary_repository_id === repo.id, "Repository association and same-project primary repository must be committed.");
  const projectCategory = await rows<Row>(db.from("project_categories").select("category_id").eq("project_id", String(project.id)), "Read suggested category");
  assert(projectCategory.length === 1, "A supported category suggestion must be associated with the draft.");
  const queue = await rows<Row>(db.from("review_queue").select("id,project_id,repository_id,assessment_id,status").eq("project_id", String(project.id)), "Read review queue");
  assert(queue.length === 1 && queue[0]?.status === "open" && queue[0]?.assessment_id, "Draft must have one linked open editorial review item.");
  const assessment = await single<Row>(db.from("repository_assessments").select("id,status,result,source_observed_at").eq("repository_id", String(repo.id)).single(), "Read persisted assessment");
  assert(assessment.status === "assessed" && assessment.result && typeof assessment.result === "object", "Assessment evidence must persist privately.");
  const evidenceRefs = await rows<Row>(db.from("repository_assessment_sources").select("source_record_id").eq("assessment_id", String(assessment.id)), "Read assessment source references");
  assert(evidenceRefs.length >= 4, "Assessment should link validated repository, topic, language and release sources.");

  const repeatBaseline = await rows<Row>(db.from("repository_assessments").select("repository_id,status,source_observed_at,assessed_at").in("repository_id", [String(repo.id), String((await single<Row>(db.from("repositories").select("id").eq("provider_repository_id", String(idTwo)).single(), "Read second repository for idempotency check")).id)]), "Read assessment idempotency baseline");
  const repositoryObservationRows = await rows<Row>(db.from("repositories").select("id,source_observed_at").in("provider_repository_id", [String(idOne), String(idTwo)]), "Read current source observations for idempotency check");
  const repeatEvents = await runAssessment(admin, 2);
  const repeatSummary = repeatEvents.find((event) => event.event === "assessment_summary");
  const repeatDiagnostics = {
    counts: { assessed: repeatSummary?.assessed, drafted: repeatSummary?.drafted, retried: repeatSummary?.retried },
    observationsMatch: repeatBaseline.map((row) => {
      const current = repositoryObservationRows.find((repository) => repository.id === row.repository_id);
      return current && Date.parse(String(current.source_observed_at)) === Date.parse(String(row.source_observed_at));
    }),
    priorStatuses: repeatBaseline.map((row) => row.status),
  };
  assert(repeatSummary?.assessed === 0, `A repeat with identical source observation must not create another assessment revision: ${JSON.stringify(repeatDiagnostics)}`);
  const sameCount = await rows<Row>(db.from("projects").select("id").in("slug", [`github-${idOne}`, `github-${idTwo}`]), "Verify repeat idempotency");
  assert(sameCount.length === 2, "A repeat assessment must not duplicate project drafts.");

  await insertCandidate(db, idThree, marker);
  const enrichmentThree = await runEnrichment(admin, idThree, "2026-11-05T10:02:00.000Z", false);
  assert(enrichmentThree.includes('"enriched":1'), "The concurrent-claim fixture must be enriched successfully.");
  const leaseJob = await rpc<string>(db, "start_github_repository_assessment_job", { p_resume: false, p_metadata: { fixture: "concurrent-claim" } });
  const competingClaims = await Promise.all([
    rpc<Row[]>(db, "claim_github_repository_assessments", { p_job_id: leaseJob, p_worker_id: "assessment-claim-a", p_limit: 1, p_lease_seconds: 60 }),
    rpc<Row[]>(db, "claim_github_repository_assessments", { p_job_id: leaseJob, p_worker_id: "assessment-claim-b", p_limit: 1, p_lease_seconds: 60 }),
  ]);
  const claimedRows = competingClaims.flat();
  assert(claimedRows.length === 1, "Concurrent workers must atomically claim one queued assessment only once.");
  const staleClaim = claimedRows[0]!;
  const staleWorkerId = competingClaims[0]!.length ? "assessment-claim-a" : "assessment-claim-b";
  const expireConcurrentLease = await db.from("repository_assessments").update({
    lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
  }).eq("id", String(staleClaim.assessment_id));
  assert(!expireConcurrentLease.error, "Could not expire the disposable concurrent-claim lease.");
  const concurrentRecovery = await runAssessment(admin, 1);
  const concurrentSummary = concurrentRecovery.find((event) => event.event === "assessment_summary");
  assert(concurrentSummary?.assessed === 1 && concurrentSummary?.drafted === 1,
    "A normal assessment worker must still reclaim an expired claim.");
  const staleMutation = await db.rpc("fail_github_repository_assessment", {
    p_assessment_id: String(staleClaim.assessment_id), p_worker_id: staleWorkerId,
    p_lease_token: String(staleClaim.lease_token), p_error_summary: "stale_fixture", p_retryable: false,
  });
  assert(staleMutation.error, "A stale assessment lease token must be fenced from later writes.");
  const finishLeaseJob = await rpc(db, "finish_github_repository_assessment_job", { p_job_id: leaseJob });
  assert(finishLeaseJob, "The original concurrent-claim job should finish after lease recovery.");

  const recoveryIds = [idOne + 9, idOne + 10, idOne + 11, idOne + 12, idOne + 13];
  for (const id of recoveryIds) await insertCandidate(db, id, marker);
  for (const [index, id] of recoveryIds.entries()) {
    const enrichment = await runEnrichment(admin, id, `2026-11-05T10:0${index + 3}:00.000Z`, false);
    assert(enrichment.includes('"enriched":1'), `The assessment recovery fixture ${id} must be enriched successfully.`);
  }
  const recoveryJob = await rpc<string>(db, "start_github_repository_assessment_job", { p_resume: false, p_metadata: { fixture: "assessment-recovery" } });
  const preservedRepository = await single<Row>(db.from("repositories").select("id").eq("provider_repository_id", String(recoveryIds[4])).single(), "Read the prior-result recovery fixture");
  const preservedAssessment = await single<Row>(db.from("repository_assessments").select("id,attempts,result,assessed_at")
    .eq("repository_id", String(preservedRepository.id)).single(), "Read the prior-result assessment fixture");
  const existingAssessment = await single<Row>(db.from("repository_assessments").select("result")
    .eq("repository_id", String(repo.id)).single(), "Read a valid persisted assessment result for the recovery fixture");
  assert(existingAssessment.result && typeof existingAssessment.result === "object", "The prior-result fixture must have a persisted assessment result.");
  const preservedAttemptCount = Math.max(1, Number(preservedAssessment.attempts));
  const preservePriorResult = await db.from("repository_assessments").update({
    status: "assessed", result: existingAssessment.result, assessed_at: new Date().toISOString(),
    attempts: preservedAttemptCount,
  }).eq("id", String(preservedAssessment.id));
  const preservePriorProject = await db.from("repositories").update({ project_id: String(project.id) }).eq("id", String(preservedRepository.id));
  assert(!preservePriorResult.error && !preservePriorProject.error, "Could not prepare the already-assessed recovery fixture.");

  const curatedName = "Manual editorial title";
  const curatedDescription = "Manual editorial description";
  const editorialValues = await db.from("projects").update({ name: curatedName, description: curatedDescription, official_website_url: "https://example.test/editorial", license_status: "needs_review", license_identifier: "Custom-Editorial", quality_status: "needs_review" }).eq("id", String(project.id));
  assert(!editorialValues.error, "Could not set manual editorial fixture values before recovery.");
  const productivityCategory = await single<Row>(db.from("categories").select("id").eq("slug", "productivity").limit(1).single(), "Read manual category fixture");
  const categoryUpdate = await db.from("project_categories").update({ category_id: productivityCategory.id }).eq("project_id", String(project.id));
  assert(!categoryUpdate.error, "Could not set manual editorial category fixture before recovery.");
  const oldClaim = (await rpc<Row[]>(db, "claim_github_repository_assessments", {
    p_job_id: recoveryJob, p_worker_id: "assessment-recovery-old-worker", p_limit: 1, p_lease_seconds: 60,
  }))[0];
  assert(oldClaim, "The recovery fixture must have one prior processing claim.");
  const wrongJob = await db.rpc("begin_github_repository_assessment_recovery", {
    p_job_id: "11111111-1111-4111-8111-111111111111", p_worker_id: "recovery-wrong-job", p_max_assessments: 4,
  });
  const completedJob = await db.rpc("begin_github_repository_assessment_recovery", {
    p_job_id: String(summary.job_id), p_worker_id: "recovery-completed-job", p_max_assessments: 4,
  });
  assert(wrongJob.error && completedJob.error, "Recovery must reject a missing job and a different completed job.");
  const liveLeaseRecovery = await db.rpc("begin_github_repository_assessment_recovery", {
    p_job_id: recoveryJob, p_worker_id: "recovery-live-lease", p_max_assessments: 4,
  });
  assert(liveLeaseRecovery.error?.code === "55P03", "Recovery must reject when a live assessment lease exists.");
  const expireLease = await db.from("repository_assessments").update({
    lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
  }).eq("id", String(oldClaim.assessment_id));
  assert(!expireLease.error, "Could not expire the assessment recovery fixture lease.");

  const inventoryBeforeRecovery = {
    jobs: await rows<Row>(db.from("ingestion_jobs").select("id,job_type").in("job_type", ["github_discovery", "github_enrichment", "github_assessment"]), "Read jobs before assessment recovery"),
    candidates: await rows<Row>(db.from("repository_candidates").select("id"), "Read candidates before assessment recovery"),
    sources: await rows<Row>(db.from("source_records").select("id"), "Read source records before assessment recovery"),
    discovery: await rows<Row>(db.from("discovery_queries").select("id"), "Read discovery partitions before assessment recovery"),
    assessments: await rows<Row>(db.from("repository_assessments").select("id,attempts,job_id").eq("job_id", recoveryJob), "Read assessments before recovery"),
  };
  const interruptedRecovery = await rpc<Row>(db, "begin_github_repository_assessment_recovery", {
    p_job_id: recoveryJob, p_worker_id: "assessment-recovery-interrupted", p_max_assessments: 4,
  });
  assert(interruptedRecovery.open_assessments === 4 && interruptedRecovery.queued_assessments === 3
    && interruptedRecovery.expired_processing_assessments === 1,
  "Recovery preflight must preserve three queued assessments and reclaim only the one expired lease.");
  const firstInterruptedClaim = (await rpc<Row[]>(db, "claim_github_repository_assessments_for_recovery", {
    p_job_id: recoveryJob, p_worker_id: "assessment-recovery-interrupted", p_limit: 1, p_lease_seconds: 60,
  }))[0];
  assert(firstInterruptedClaim, "The interrupted recovery worker must claim one existing assessment.");
  const firstInterruptedAttempt = await single<Row>(db.from("repository_assessments").select("attempts")
    .eq("id", String(firstInterruptedClaim.assessment_id)).single(), "Read attempt count before simulating the repeated interruption");
  const interruptedAt = new Date(Date.now() - 60_000).toISOString();
  const expireInterruptedClaim = await db.from("repository_assessments").update({ lease_expires_at: interruptedAt })
    .eq("id", String(firstInterruptedClaim.assessment_id));
  const expireRecoveryOwner = await db.from("ingestion_jobs").update({ metadata: {
    assessment_recovery_worker_id: "assessment-recovery-interrupted",
    assessment_recovery_expires_at: interruptedAt,
  } }).eq("id", recoveryJob);
  assert(!expireInterruptedClaim.error && !expireRecoveryOwner.error, "Could not simulate a repeated worker interruption in the disposable database.");
  const interruptedJobFinalization = await rpc<Row>(db, "finish_github_repository_assessment_job", { p_job_id: recoveryJob });
  assert(interruptedJobFinalization.status === "partial" && interruptedJobFinalization.open_assessments === 4,
    "A finalized interruption must remain partial with all four unfinished assessments attached to the original job.");

  const recoveredEvents = await runAssessmentRecovery(admin, recoveryJob);
  const recoveredSummary = recoveredEvents.find((event) => event.event === "assessment_recovery_summary");
  const recoveryPreflight = recoveredSummary?.recovery_preflight as Row;
  assert(recoveredSummary?.job_id === recoveryJob && recoveredSummary?.assessed === 4
    && recoveredSummary?.drafted === 4 && recoveredSummary?.outcome_class === "completed"
    && recoveredSummary?.job_status === "succeeded" && recoveryPreflight.queued_assessments === 3
    && recoveryPreflight.expired_processing_assessments === 1,
  `Recovery must resume the requested job and complete at most its four existing assessments: ${JSON.stringify(recoveredSummary)}`);
  const recoveredRows = await rows<Row>(db.from("repository_assessments").select("id,repository_id,status,attempts,max_attempts,job_id,result")
    .in("repository_id", recoveryIds.map(String)), "Read assessments after recovery");
  const preservedAssessmentAfter = recoveredRows.find((row) => row.id === preservedAssessment.id);
  assert(recoveredRows.length === 5 && recoveredRows.every((row) => row.job_id === recoveryJob
    && ["assessed", "needs_review"].includes(String(row.status)) && Number(row.attempts) <= Number(row.max_attempts)
    && Number(row.attempts) >= Number(inventoryBeforeRecovery.assessments.find((prior) => prior.id === row.id)?.attempts ?? 0)),
  "Recovery must preserve all existing assessment rows, the original job, and their attempt limits.");
  const reinterruptedAssessment = recoveredRows.find((row) => row.id === firstInterruptedClaim.assessment_id);
  assert(reinterruptedAssessment && Number(reinterruptedAssessment.attempts) >= Number(firstInterruptedAttempt.attempts) + 1,
    "A repeated interruption must advance the existing attempt count without losing the assessment row.");
  assert(preservedAssessmentAfter?.status === "assessed"
    && JSON.stringify(preservedAssessmentAfter.result) === JSON.stringify(existingAssessment.result)
    && Number(preservedAssessmentAfter.attempts) === preservedAttemptCount,
  "Recovery must leave a previously completed assessment result and attempt count untouched.");
  const preservedEditorialProject = await single<Row>(db.from("projects").select("name,description,official_website_url,license_status,license_identifier,quality_status")
    .eq("id", String(project.id)).single(), "Read editorial project after assessment recovery");
  assert(preservedEditorialProject.name === curatedName && preservedEditorialProject.description === curatedDescription
    && preservedEditorialProject.official_website_url === "https://example.test/editorial"
    && preservedEditorialProject.license_status === "needs_review" && preservedEditorialProject.license_identifier === "Custom-Editorial"
    && preservedEditorialProject.quality_status === "needs_review",
  "Recovery must preserve preexisting editorial project decisions.");
  const preservedEditorialCategory = await rows<Row>(db.from("project_categories").select("category_id").eq("project_id", String(project.id)), "Read editorial category after assessment recovery");
  assert(preservedEditorialCategory.length === 1 && preservedEditorialCategory[0]?.category_id === productivityCategory.id,
    "Recovery must preserve preexisting editorial category decisions.");
  const recoveredProjects = await rows<Row>(db.from("projects").select("id,slug,publication_status,published_at,featured")
    .in("slug", recoveryIds.map((id) => `github-${id}`)), "Read recovered project drafts");
  assert(recoveredProjects.length === 4 && recoveredProjects.every((row) => row.publication_status === "pending_review"
    && row.published_at === null && row.featured === false), "Recovery may create only unpublished, unfeatured pending-review drafts.");
  const recoveryAssessmentIds = recoveredRows.filter((row) => row.id !== preservedAssessment.id).map((row) => String(row.id));
  const recoveredReviews = await rows<Row>(db.from("review_queue").select("id,assessment_id,status")
    .in("assessment_id", recoveryAssessmentIds), "Read recovered review queue items");
  assert(recoveredReviews.length === 4 && new Set(recoveredReviews.map((row) => row.assessment_id)).size === 4
    && recoveredReviews.every((row) => ["open", "in_review"].includes(String(row.status))),
  "Recovery must reuse one open review record per completed assessment without duplicates.");
  const attemptedAgain = await db.rpc("fail_github_repository_assessment", {
    p_assessment_id: String(oldClaim.assessment_id), p_worker_id: "assessment-recovery-old-worker",
    p_lease_token: String(oldClaim.lease_token), p_error_summary: "stale_fixture", p_retryable: false,
  });
  assert(attemptedAgain.error, "A pre-recovery worker token must remain fenced from later writes.");
  const inventoryAfterRecovery = {
    jobs: await rows<Row>(db.from("ingestion_jobs").select("id,job_type").in("job_type", ["github_discovery", "github_enrichment", "github_assessment"]), "Read jobs after assessment recovery"),
    candidates: await rows<Row>(db.from("repository_candidates").select("id"), "Read candidates after assessment recovery"),
    sources: await rows<Row>(db.from("source_records").select("id"), "Read source records after assessment recovery"),
    discovery: await rows<Row>(db.from("discovery_queries").select("id"), "Read discovery partitions after assessment recovery"),
  };
  assert(JSON.stringify(inventoryAfterRecovery.jobs.map((row) => row.id).sort()) === JSON.stringify(inventoryBeforeRecovery.jobs.map((row) => row.id).sort())
    && JSON.stringify(inventoryAfterRecovery.candidates.map((row) => row.id).sort()) === JSON.stringify(inventoryBeforeRecovery.candidates.map((row) => row.id).sort())
    && JSON.stringify(inventoryAfterRecovery.sources.map((row) => row.id).sort()) === JSON.stringify(inventoryBeforeRecovery.sources.map((row) => row.id).sort())
    && JSON.stringify(inventoryAfterRecovery.discovery.map((row) => row.id).sort()) === JSON.stringify(inventoryBeforeRecovery.discovery.map((row) => row.id).sort()),
  "Assessment recovery must create no jobs, candidates, source observations, or discovery partitions.");
  const finalOperatorReport = await rpc<Row>(db, "pipeline_operator_report", {});
  const activeLeases = finalOperatorReport.active_leases as Row;
  const runningJobs = finalOperatorReport.running_jobs as Row[];
  assert(finalOperatorReport.schema && (finalOperatorReport.schema as Row).ready === true
    && Number(activeLeases.assessment) === 0 && !runningJobs.some((row) => row.job_id === recoveryJob),
  "Operator reporting must show a ready schema, no assessment leases, and no running recovered job.");

  const candidate = await db.from("repository_candidates").update({ enrichment_status: "queued", enrichment_completed_at: null, enrichment_error: null }).eq("provider_repository_id", String(idOne));
  assert(!candidate.error, "Could not queue the rename enrichment fixture.");
  const renameTime = "2026-11-06T10:00:00.000Z";
  const renameEnrichment = await runEnrichment(admin, idOne, renameTime, true);
  assert(renameEnrichment.includes('"enriched":1'), "The renamed repository observation must be committed successfully.");
  const renameEvents = await runAssessment(admin, 1);
  const renameSummary = renameEvents.find((event) => event.event === "assessment_summary");
  assert(renameSummary?.assessed === 1 && renameSummary?.drafted === 0, `Newer source observations must reassess without drafting a second project: ${JSON.stringify(renameSummary ?? renameEvents)}`);
  const renamedProject = await single<Row>(db.from("projects").select("id,slug,name,description,official_website_url,publication_status,quality_status,license_status,license_identifier,license_verified_at,published_at,featured").eq("id", String(project.id)).single(), "Read project after repository rename");
  assert(renamedProject.name === curatedName && renamedProject.slug === `github-${idOne}` && renamedProject.description === curatedDescription, "Repository rename must preserve editorial text and stable slug.");
  assert(renamedProject.official_website_url === "https://example.test/editorial" && renamedProject.license_status === "needs_review" && renamedProject.license_identifier === "Custom-Editorial" && renamedProject.quality_status === "needs_review", "Repository reassessment must preserve manual license, quality, and website decisions.");
  const retainedCategory = await rows<Row>(db.from("project_categories").select("category_id").eq("project_id", String(project.id)), "Read retained editorial category");
  assert(retainedCategory.length === 1 && retainedCategory[0]?.category_id === productivityCategory.id, "Repository reassessment must preserve manual category decisions.");
  const renameDupes = await rows<Row>(db.from("projects").select("id").eq("primary_repository_id", String(repo.id)), "Check rename duplicate projects");
  assert(renameDupes.length === 1, "Repository rename must retain one associated project.");

  const idNine = idOne + 8;
  await insertCandidate(db, idNine, marker);
  await runEnrichment(admin, idNine, "2026-11-06T11:00:00.000Z", false, "miscellaneous");
  const insufficientEvents = await runAssessment(admin, 1);
  const insufficientSummary = insufficientEvents.find((event) => event.event === "assessment_summary");
  assert(insufficientSummary?.assessed === 1 && insufficientSummary?.drafted === 0 && insufficientSummary?.queued_for_review === 1, "Insufficient classification must be reviewable without forcing draft creation.");
  const insufficientRepo = await single<Row>(db.from("repositories").select("id").eq("provider_repository_id", String(idNine)).single(), "Read insufficient repository");
  const insufficientReview = await rows<Row>(db.from("review_queue").select("id,repository_id,project_id,assessment_id,status").eq("repository_id", String(insufficientRepo.id)), "Read insufficient review item");
  assert(insufficientReview.length === 1 && insufficientReview[0]?.project_id === null && insufficientReview[0]?.status === "open", "Insufficient evidence should create a repository review item only.");
  const requeueForBetterEvidence = await db.from("repository_candidates").update({ enrichment_status: "queued", enrichment_completed_at: null, enrichment_error: null }).eq("provider_repository_id", String(idNine));
  assert(!requeueForBetterEvidence.error, "Could not queue a newer evidence observation.");
  await runEnrichment(admin, idNine, "2026-11-06T11:30:00.000Z", false);
  const sufficientEvents = await runAssessment(admin, 1);
  const sufficientSummary = sufficientEvents.find((event) => event.event === "assessment_summary");
  assert(sufficientSummary?.assessed === 1 && sufficientSummary?.drafted === 1 && sufficientSummary?.queued_for_review === 1, "A newer sufficient observation should create one reviewable draft revision.");
  const transitionedProject = await single<Row>(db.from("projects").select("id,slug,publication_status").eq("slug", `github-${idNine}`).single(), "Read project after evidence improves");
  const transitionedReview = await rows<Row>(db.from("review_queue").select("id,repository_id,project_id,assessment_id,status").eq("project_id", String(transitionedProject.id)), "Read transitioned review item");
  assert(transitionedProject.publication_status === "pending_review" && transitionedReview.length === 1 && transitionedReview[0]?.repository_id === null && transitionedReview[0]?.status === "open", "The original repository review item should be reused for the new draft.");

  const idFour = idOne + 3;
  const idFive = idOne + 4;
  const idSix = idOne + 5;
  const idSeven = idOne + 6;
  const idEight = idOne + 7;
  for (const id of [idFour, idFive, idSix, idSeven, idEight]) await insertCandidate(db, id, marker);
  for (const [index, id] of [idFour, idFive, idSeven, idEight].entries()) {
    await runEnrichment(admin, id, `2026-11-06T12:0${index}:00.000Z`, false);
  }
  await runEnrichment(admin, idSix, "2026-11-06T12:02:00.000Z", false, "developer-tools", true);
  const rejected = await db.from("repository_candidates").update({ review_status: "rejected" }).eq("provider_repository_id", String(idFour));
  const discarded = await db.from("repository_candidates").update({ queue_status: "discarded" }).eq("provider_repository_id", String(idFive));
  const restrictedSource = await db.from("repositories").update({ availability_status: "access_restricted" }).eq("provider_repository_id", String(idSeven));
  assert(!rejected.error && !discarded.error && !restrictedSource.error, `Could not prepare rejected, discarded, and restricted eligibility fixtures: ${JSON.stringify({ rejected: rejected.error?.code ?? null, discarded: discarded.error?.code ?? null, restricted: restrictedSource.error?.code ?? null })}`);
  const collision = await db.from("projects").insert({ slug: `github-${idEight}`, name: "Existing editorial slug" }).select("id").single();
  assert(!collision.error && collision.data, "Could not prepare a slug collision fixture.");
  const collisionEvents = await runAssessment(admin, 5);
  const collisionSummary = collisionEvents.find((event) => event.event === "assessment_summary");
  assert(collisionSummary?.assessed === 1 && collisionSummary?.drafted === 0 && collisionSummary?.queued_for_review === 1, "A slug collision should create a review result without a duplicate project.");
  const privateRepository = await rows<Row>(db.from("repositories").select("id").eq("provider_repository_id", String(idSix)), "Check private repository canonical state");
  assert(privateRepository.length === 0, "A private GitHub response must not create public canonical repository metadata.");
  const privateCandidate = await single<Row>(db.from("repository_candidates").select("enrichment_status,enrichment_error").eq("provider_repository_id", String(idSix)).single(), "Check private candidate terminal outcome");
  assert(privateCandidate.enrichment_status === "failed" && privateCandidate.enrichment_error === "source_access_restricted", "The private candidate must remain terminally restricted and outside assessment.");
  const ineligibleProviderIds = [idFour, idFive, idSeven].map(String);
  const ineligibleRepositories = await rows<Row>(db.from("repositories").select("id").in("provider_repository_id", ineligibleProviderIds), "Read ineligible canonical repository IDs");
  const ineligibleRepositoryIds = ineligibleRepositories.map((repository) => String(repository.id));
  const ineligibleAssessments = await rows<Row>(db.from("repository_assessments").select("id").in("repository_id", ineligibleRepositoryIds), "Verify ineligible assessment sources");
  assert(ineligibleAssessments.length === 0, "Rejected, discarded, private, and restricted sources must not enter the assessment queue.");
  const collisionProjects = await rows<Row>(db.from("projects").select("id").eq("slug", `github-${idEight}`), "Verify slug collision handling");
  assert(collisionProjects.length === 1, "A deterministic slug collision must not create a duplicate project.");
  const collisionRepo = await single<Row>(db.from("repositories").select("id").eq("provider_repository_id", String(idEight)).single(), "Read collision repository");
  const collisionReview = await rows<Row>(db.from("review_queue").select("id,repository_id,assessment_id,status").eq("repository_id", String(collisionRepo.id)), "Read collision review item");
  assert(collisionReview.length === 1 && collisionReview[0]?.status === "open" && collisionReview[0]?.assessment_id, "Slug collision evidence should be routed to the editorial review queue.");

  const assessmentRead = await anon.from("repository_assessments").select("id").limit(1);
  assert(assessmentRead.error, "Ordinary anon clients must not read assessment records.");
  const assessmentWrite = await anon.from("repository_assessments").insert({ repository_id: String(repo.id), policy_version: "m1-04-assessment-v1", source_observed_at: firstTime });
  assert(assessmentWrite.error, "Ordinary anon clients must not insert assessment records.");
  const anonymousRpc = await anon.rpc("claim_github_repository_assessments", { p_job_id: String(summary.job_id), p_worker_id: "anon", p_limit: 1, p_lease_seconds: 60 });
  assert(anonymousRpc.error, "Ordinary anon clients must not claim assessments.");

  process.stdout.write(`${JSON.stringify({ event: "assessment_integration_passed", enriched_repositories: 9, enrichment_runs: 10, assessed_repositories: 5, assessment_revisions: 7, drafts: 4, rename_reassessment_preserved_editorial_data: true, repeat_idempotency: true, insufficient_evidence_review: true, review_item_reused_for_new_draft: true, concurrent_claims: true, stale_lease_fencing: true, rejected_discarded_private_restricted_exclusion: true, slug_collision_review: true, actual_worker_orchestration: true, real_postgrest_and_postgres: true, deterministic_github_http: true, live_github: false, hosted_supabase: false })}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 1200) : "unexpected assessment database integration failure";
  process.stderr.write(`${JSON.stringify({ event: "assessment_db_integration_failed", message })}\n`);
  process.exitCode = 1;
});
