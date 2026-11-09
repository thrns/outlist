import { randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import { createGitHubClient, type GitHubClient } from "../src/lib/github/client";
import { runPipelineCli, summarizePersistedSmoke, type PipelineCliDependencies } from "./pipeline";
import type { Database } from "../src/lib/supabase/database.types";

type Row = Record<string, unknown>;
type FixtureRepository = {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  topics: string[];
  private?: boolean;
  visibility?: string;
  disabled?: boolean;
  avatar?: boolean;
  partialLanguages?: boolean;
  rateLimited?: boolean;
};
type ParsedRun = { code: number; report: Row; stderr: Row[] };

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function markerId(prefix: string): number {
  const id = Number(`${prefix}${randomInt(1_000_000, 9_999_999)}`);
  assert(Number.isSafeInteger(id), "Fixture repository ID must fit in a safe JavaScript integer.");
  return id;
}

function parseLines(chunks: string[]): Row[] {
  return chunks.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

function fixtureHeaders(resource: "core" | "search" = "core", remaining = 4900, reset = Math.ceil(Date.now() / 1000) + 3600): Headers {
  return new Headers({
    "content-type": "application/vnd.github+json",
    "x-github-api-version-selected": "2022-11-28",
    "x-ratelimit-limit": resource === "search" ? "30" : "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(reset),
    "x-ratelimit-resource": resource,
  });
}

function repositoryPayload(repository: FixtureRepository) {
  return {
    id: repository.id,
    node_id: `R_${repository.id}`,
    name: repository.name,
    full_name: `${repository.owner}/${repository.name}`,
    owner: {
      id: repository.id + 50_000,
      node_id: `O_${repository.id}`,
      login: repository.owner,
      type: "Organization",
      ...(repository.avatar ? { avatar_url: `https://avatars.githubusercontent.com/u/${repository.id + 50_000}?v=4` } : {}),
    },
    html_url: `https://github.com/${repository.owner}/${repository.name}`,
    url: `https://api.github.com/repos/${repository.owner}/${repository.name}`,
    description: repository.description,
    homepage: null,
    topics: repository.topics,
    language: "TypeScript",
    stargazers_count: 420,
    forks_count: 35,
    watchers_count: 430,
    open_issues_count: 3,
    archived: false,
    disabled: repository.disabled ?? false,
    fork: false,
    private: repository.private ?? false,
    visibility: repository.visibility ?? ((repository.private ?? false) ? "private" : "public"),
    default_branch: "main",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2026-11-05T12:00:00Z",
    pushed_at: "2026-11-05T12:00:00Z",
    license: {
      key: "mit", name: "MIT License", spdx_id: "MIT",
      url: "https://api.github.com/licenses/mit",
      html_url: `https://github.com/${repository.owner}/${repository.name}/blob/main/LICENSE`,
    },
  };
}

function searchPayload(repository: FixtureRepository) {
  const body = repositoryPayload(repository);
  return {
    ...body,
    owner: { id: body.owner.id, node_id: body.owner.node_id, login: body.owner.login, type: body.owner.type },
  };
}

function makeGitHubFixture(options: {
  main: FixtureRepository;
  rejected: FixtureRepository;
  privateRepo: FixtureRepository;
  extraRepositories?: FixtureRepository[];
  includeDiscoveryResults?: boolean;
}): { client: GitHubClient; requests: string[] } {
  const requests: string[] = [];
  const repositories = new Map<number, FixtureRepository>();
  for (const repository of [options.main, options.rejected, options.privateRepo, ...(options.extraRepositories ?? [])]) {
    repositories.set(repository.id, repository);
  }
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.href);
    const resource = url.pathname === "/search/repositories" ? "search" : "core";
    if (url.pathname === "/rate_limit") {
      const quota = { limit: 5000, remaining: 4900, reset: Math.ceil(Date.now() / 1000) + 3600, used: 100 };
      return new Response(JSON.stringify({ resources: { core: quota, search: { ...quota, limit: 30, remaining: 28 } }, rate: quota }), {
        status: 200, headers: fixtureHeaders("core"),
      });
    }
    if (url.pathname === "/search/repositories") {
      const items = options.includeDiscoveryResults === false ? [] : [options.main, options.privateRepo, options.rejected].map(searchPayload);
      return new Response(JSON.stringify({ total_count: items.length, incomplete_results: false, items }), {
        status: 200, headers: fixtureHeaders("search"),
      });
    }
    const byId = url.pathname.match(/^\/repositories\/(\d+)$/);
    if (byId) {
      const id = Number(byId[1]);
      const repository = repositories.get(id);
      if (!repository) {
        // Logo discovery may inspect older local integration fixtures. Return
        // safe public metadata without an avatar so those rows are skipped.
        const fallback: FixtureRepository = {
          id, owner: "fixture-owner", name: `fixture-${id}`,
          description: "Existing local integration repository", topics: [], avatar: false,
        };
        return new Response(JSON.stringify(repositoryPayload(fallback)), { status: 200, headers: fixtureHeaders(resource) });
      }
      if (repository.rateLimited) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: fixtureHeaders("core", 0, Math.ceil(Date.now() / 1000) + 1),
        });
      }
      return new Response(JSON.stringify(repositoryPayload(repository)), { status: 200, headers: fixtureHeaders(resource) });
    }
    if (url.pathname.endsWith("/languages")) {
      const repository = repositoryForPath(repositories, url.pathname);
      if (repository?.partialLanguages) {
        return new Response(JSON.stringify({ message: "fixture language endpoint unavailable" }), {
          status: 503, headers: fixtureHeaders("core"),
        });
      }
      return new Response(JSON.stringify({ TypeScript: 900, CSS: 100 }), { status: 200, headers: fixtureHeaders("core") });
    }
    if (url.pathname.endsWith("/topics")) {
      const repository = repositoryForPath(repositories, url.pathname);
      return new Response(JSON.stringify({ names: repository?.topics ?? [] }), { status: 200, headers: fixtureHeaders("core") });
    }
    if (url.pathname.endsWith("/releases")) {
      return new Response("[]", { status: 200, headers: fixtureHeaders("core") });
    }
    throw new Error(`Unexpected GitHub fixture URL: ${url.pathname}`);
  };
  return {
    client: createGitHubClient({ fetch: fetcher, token: null, maxRetries: 0, maxRateLimitWaitMs: 0 }),
    requests,
  };
}

function repositoryForPath(repositories: Map<number, FixtureRepository>, path: string): FixtureRepository | undefined {
  const match = path.match(/^\/repos\/([^/]+)\/([^/]+)\/(?:languages|topics|releases)$/);
  if (!match) return undefined;
  return [...repositories.values()].find((repository) => repository.owner.toLowerCase() === match[1]?.toLowerCase()
    && repository.name.toLowerCase() === match[2]?.toLowerCase());
}

async function insertCandidate(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  repository: FixtureRepository,
  marker: string,
  options: { rejected?: boolean } = {},
): Promise<string> {
  const source = await admin.from("source_records").insert({
    provider: "github", record_kind: "discovery_page", source_key: `pipeline-it:${marker}`,
    source_url: "https://api.github.com/search/repositories?q=outlist-m1-06-fixture",
    fetched_at: new Date().toISOString(), http_status: 200,
    source_metadata: { api_version: "2022-11-28", fixture: true },
  } as never).select("id").single();
  assert(!source.error && source.data, `Could not insert the local candidate provenance row: ${source.error?.message ?? "missing row"}`);
  const row = await admin.from("repository_candidates").insert({
    provider: "github", provider_repository_id: String(repository.id),
    full_name: `${repository.owner}/${repository.name}`,
    canonical_url: `https://github.com/${repository.owner}/${repository.name}`,
    owner_login: repository.owner, description: repository.description,
    source_record_id: source.data.id, queue_status: options.rejected ? "discarded" : "queued",
    review_status: options.rejected ? "rejected" : "unreviewed",
  } as never).select("id").single();
  assert(!row.error && row.data, `Could not insert the local candidate: ${row.error?.message ?? "missing row"}`);
  return row.data.id as string;
}

async function run(
  args: string[],
  admin: ReturnType<typeof createSupabaseAdminClient>,
  github: GitHubClient,
  options: Pick<PipelineCliDependencies, "interruptAfterStage"> = {},
): Promise<ParsedRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: PipelineCliDependencies = {
    supabase: admin as unknown as NonNullable<PipelineCliDependencies["supabase"]>,
    github,
    githubSource: "fixture",
    ...options,
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  };
  const code = await runPipelineCli(args, dependencies);
  const outputText = stdout.join("");
  let output: Row | undefined;
  try { output = JSON.parse(outputText) as Row; } catch { output = parseLines(stdout).at(-1); }
  assert(output && typeof output.event === "string" && !String(output.event).includes("failure"),
    `Expected a structured orchestrator report, got ${JSON.stringify(output ?? parseLines(stderr))}`);
  return { code, report: output, stderr: parseLines(stderr) };
}

async function countRows(admin: ReturnType<typeof createSupabaseAdminClient>) {
  const [jobs, candidates, repositories, projects, assessments, logos, sources] = await Promise.all([
    admin.from("ingestion_jobs").select("id"),
    admin.from("repository_candidates").select("id"),
    admin.from("repositories").select("id"),
    admin.from("projects").select("id"),
    admin.from("repository_assessments").select("id"),
    admin.from("project_logos").select("id"),
    admin.from("source_records").select("id"),
  ]);
  const countError = [jobs, candidates, repositories, projects, assessments, logos, sources].find((result) => result.error || !Array.isArray(result.data));
  assert(!countError, `Could not read local integration counts: ${countError?.error?.message ?? "missing rows"}`);
  return {
    jobs: (jobs.data as Row[]).length,
    candidates: (candidates.data as Row[]).length,
    repositories: (repositories.data as Row[]).length,
    projects: (projects.data as Row[]).length,
    assessments: (assessments.data as Row[]).length,
    logos: (logos.data as Row[]).length,
    sources: (sources.data as Row[]).length,
  };
}

async function main() {
  assert(supabaseUrl && publishableKey, "Local Supabase URL and publishable key are required for pipeline integration.");
  const host = new URL(supabaseUrl).hostname;
  assert(["localhost", "127.0.0.1", "::1", "[::1]"].includes(host), "Pipeline database integration refuses non-local Supabase targets.");
  const admin = createSupabaseAdminClient();
  const anonymous = createClient<Database>(supabaseUrl, publishableKey, { auth: { persistSession: false } });
  const suffix = randomInt(1_000_000, 9_999_999).toString();
  const mainRepository: FixtureRepository = {
    id: markerId("99100"), owner: "outlist-pilot", name: `developer-tool-${suffix}`,
    description: "Developer tools for local task automation", topics: ["developer-tools"], avatar: true,
  };
  const rejectedRepository: FixtureRepository = {
    id: markerId("99200"), owner: "rejected-project", name: `old-${suffix}`,
    description: "Previously rejected local fixture", topics: [],
  };
  const privateRepository: FixtureRepository = {
    id: markerId("99300"), owner: "private-project", name: `private-${suffix}`,
    description: "Private local fixture", topics: ["developer-tools"], private: true, visibility: "private",
  };
  const priorityCandidateId = await insertCandidate(admin, mainRepository, `pilot-main-${suffix}`);
  const priorityCandidateUpdate = await admin.from("repository_candidates").update({ first_seen_at: "2020-01-01T00:00:00Z" } as never)
    .eq("id", priorityCandidateId);
  assert(!priorityCandidateUpdate.error, "The lineage fixture must be eligible first so the five-item enrichment cap can still complete it.");
  for (let index = 0; index < 5; index += 1) {
    const queuedRepository: FixtureRepository = {
      id: markerId("99700"), owner: "queued-integration", name: `queued-${suffix}-${index}`,
      description: `Queued local integration fixture ${index}`, topics: [],
    };
    await insertCandidate(admin, queuedRepository, `queued-${suffix}-${index}`);
  }
  const rejectedCandidateId = await insertCandidate(admin, rejectedRepository, `rejected-${suffix}`, { rejected: true });
  const githubFixture = makeGitHubFixture({ main: mainRepository, rejected: rejectedRepository, privateRepo: privateRepository });
  const boundedArgs = ["--max-queries", "1", "--max-pages", "1", "--max-candidates", "100", "--max-enrichments", "5", "--max-assessments", "5", "--max-logo-projects", "25"];

  const clean = await run(["--execute", ...boundedArgs], admin, githubFixture.client);
  assert(clean.code === 0 && clean.report.run_status === "complete", "The real orchestrator should complete the clean local fixture pilot.");
  assert(clean.report.execution_status === "completed" && clean.report.data_status === "committed"
    && clean.report.end_to_end_project_completed === true,
  "A linked fixture pilot must report completed execution, committed data, and a validated end-to-end project separately.");
  const stageNames = (clean.report.stages as Row[]).map((stage) => stage.stage);
  assert(stageNames.join(",") === "discovery,enrichment,assessment,logo_candidates", "All four real workers must run in order.");
  const cleanStages = clean.report.stages as Row[];
  const enrichmentStage = cleanStages.find((stage) => stage.stage === "enrichment");
  const assessmentStage = cleanStages.find((stage) => stage.stage === "assessment");
  assert(Number(enrichmentStage?.attempted) === 5 && Number(enrichmentStage?.persisted_record_count) <= 5
    && Number(assessmentStage?.attempted) <= 5 && Number(assessmentStage?.persisted_record_count) <= 5,
  "The end-to-end pilot must keep both downstream workers capped at five items despite a larger discovery budget.");
  assert((githubFixture.requests.filter((request) => new URL(request).pathname === "/search/repositories").length) === 1,
    "The orchestrator must make exactly one deterministic search request for this bounded pilot.");

  const runInspection = await admin.rpc("pipeline_operator_verify_run", { p_run_id: String(clean.report.run_id) });
  assert(!runInspection.error && runInspection.data, "The service-only run inspector should read actual committed fixture rows.");
  const inspected = runInspection.data as Row;
  for (const key of ["discovered_candidates", "enriched_repositories", "assessments", "project_drafts", "logo_candidates"]) {
    assert(Array.isArray(inspected[key]) && (inspected[key] as unknown[]).length > 0, `Run inspector should find persisted ${key} rows.`);
  }
  assert((inspected.discovered_candidates as Row[]).some((row) => row.source_observation_valid === true)
    && (inspected.enriched_repositories as Row[]).some((row) => row.public_eligible === true && row.enrichment_succeeded === true)
    && (inspected.assessments as Row[]).some((row) => row.provenance_valid === true && row.review_relationship_valid === true)
    && (inspected.project_drafts as Row[]).some((row) => row.draft_valid === true && Number(row.category_evidence_count) > 0)
    && (inspected.logo_candidates as Row[]).some((row) => row.logo_candidate_valid === true && row.review_relationship_valid === true),
  "Run inspection should verify persisted source, public eligibility, assessment, draft, and pending-logo relationships.");
  const cleanLineages = Array.isArray(inspected.validated_lineages) ? inspected.validated_lineages as Row[] : [];
  const mainLineage = cleanLineages.find((lineage) => (lineage.repository as Row)?.provider_repository_id === String(mainRepository.id));
  assert(mainLineage && mainLineage.complete === true && mainLineage.candidate_id && mainLineage.assessment_id
    && mainLineage.project_id && mainLineage.logo_id,
  "The database verifier must return every matching ID in one stable-ID-connected lineage.");
  const unrelatedRecordsProbe = summarizePersistedSmoke({ ...inspected, validated_lineages: [] });
  assert(unrelatedRecordsProbe.success === false,
    "Valid stage records without a joined lineage must not satisfy end-to-end verification.");
  assert(clean.report.publication_or_approval_performed === false,
    "The real pipeline report must state that no publication or approval was performed.");
  assert((inspected.project_drafts as Row[]).every((draft) => draft.publication_status !== "published"),
    "No project discovered or assessed by the pipeline may be automatically published.");

  const beforeDryRun = await countRows(admin);
  const dryFixture = makeGitHubFixture({ main: mainRepository, rejected: rejectedRepository, privateRepo: privateRepository, includeDiscoveryResults: false });
  const dryRun = await run(["--dry-run", ...boundedArgs], admin, dryFixture.client);
  assert(dryRun.code === 0 && dryRun.report.run_status === "dry_run", "Default and explicit dry-run must complete without writes.");
  assert(!dryFixture.requests.some((request) => new URL(request).pathname === "/search/repositories"), "Dry-run must not issue a repository crawl.");
  assert(JSON.stringify(await countRows(admin)) === JSON.stringify(beforeDryRun), "Dry-run stage previews must leave every counted table unchanged.");

  const beforeFixtureSmoke = await countRows(admin);
  const fixtureSmokeApi = makeGitHubFixture({ main: mainRepository, rejected: rejectedRepository, privateRepo: privateRepository, includeDiscoveryResults: false });
  const fixtureSmoke = await run(["--live-smoke", "--execute"], admin, fixtureSmokeApi.client);
  const smokeBlockers = fixtureSmoke.report.blockers as Row[];
  assert(fixtureSmoke.code === 1 && smokeBlockers.some((blocker) => blocker.code === "fixture_is_not_live_smoke"),
    "Live smoke must refuse to describe deterministic fixtures as actual GitHub API results.");
  assert(JSON.stringify(await countRows(admin)) === JSON.stringify(beforeFixtureSmoke), "A fixture-only live-smoke attempt must not start writes.");

  const interruptedFixture = makeGitHubFixture({ main: mainRepository, rejected: rejectedRepository, privateRepo: privateRepository, includeDiscoveryResults: false });
  const interruptedAtCheckpoint = await run(["--resume", "--execute", ...boundedArgs], admin, interruptedFixture.client,
    { interruptAfterStage: "discovery" });
  assert(interruptedAtCheckpoint.code === 1 && interruptedAtCheckpoint.report.run_status === "partial"
    && (interruptedAtCheckpoint.report.stages as Row[]).some((stage) => stage.stage === "enrichment" && stage.status === "skipped"),
  "An interrupted run should stop after its committed discovery checkpoint and report later stages as skipped.");
  const resumeAfterInterruptionFixture = makeGitHubFixture({ main: mainRepository, rejected: rejectedRepository, privateRepo: privateRepository, includeDiscoveryResults: false });
  const resumeAfterInterruption = await run(["--resume", "--execute", ...boundedArgs], admin, resumeAfterInterruptionFixture.client);
  const interruptionResumeStages = Array.isArray(resumeAfterInterruption.report.stages)
    ? (resumeAfterInterruption.report.stages as Row[]).map((stage) => ({ stage: stage.stage, status: stage.status, errors: stage.error_events }))
    : [];
  const resumedLineage = resumeAfterInterruption.report.lineage_validation as Row | null;
  assert(resumeAfterInterruption.code === 0 && resumeAfterInterruption.report.run_status === "complete"
    && resumeAfterInterruption.report.execution_status === "completed"
    && resumeAfterInterruption.report.end_to_end_project_completed === true
    && resumedLineage?.success === true && Number(resumedLineage.validated_lineage_count) > 0,
    `A run stopped at a durable stage boundary should safely resume from existing checkpoints: status=${resumeAfterInterruption.report.run_status}; stages=${JSON.stringify(interruptionResumeStages)}`);

  const candidate = await admin.from("repository_candidates").select("id,queue_status,review_status,enrichment_status,repository_id,full_name")
    .eq("provider", "github").eq("provider_repository_id", String(mainRepository.id)).single();
  assert(!candidate.error && candidate.data?.enrichment_status === "succeeded" && candidate.data?.repository_id,
    "The valid discovered candidate must be enriched through the real worker.");
  const privateCandidate = await admin.from("repository_candidates").select("id")
    .eq("provider", "github").eq("provider_repository_id", String(privateRepository.id));
  assert(!privateCandidate.error && privateCandidate.data.length === 0
    && !cleanLineages.some((lineage) => (lineage.repository as Row)?.provider_repository_id === String(privateRepository.id)),
  "Private GitHub search results must not enter the candidate queue or a valid lineage.");
  const preservedRejected = await admin.from("repository_candidates").select("id,queue_status,review_status")
    .eq("id", rejectedCandidateId).single();
  assert(!preservedRejected.error && preservedRejected.data?.queue_status === "discarded" && preservedRejected.data?.review_status === "rejected",
    "Rediscovery must preserve rejected and discarded candidate decisions.");

  const repository = await admin.from("repositories").select("id,project_id")
    .eq("provider", "github").eq("provider_repository_id", String(mainRepository.id)).single();
  assert(!repository.error && repository.data?.project_id, "The real assessment must associate the repository with a draft project.");
  const project = await admin.from("projects").select("id,publication_status,quality_status,license_status,license_verified_at,featured,primary_repository_id")
    .eq("id", repository.data.project_id).single();
  assert(!project.error && project.data?.publication_status === "pending_review" && project.data?.featured === false,
    "Assessment must create an unpublished, unfeatured draft.");
  assert(project.data.quality_status !== "verified" && project.data.license_status !== "verified_open_source"
    && project.data.license_verified_at === null, "The workflow must not verify quality or approve a license.");
  const assessment = await admin.from("repository_assessments").select("id,status,result")
    .eq("repository_id", repository.data.id).single();
  assert(!assessment.error && ["assessed", "needs_review"].includes(assessment.data?.status as string), "Assessment provenance must be committed.");
  const assessmentReview = await admin.from("review_queue").select("id,project_id,assessment_id,status")
    .eq("assessment_id", assessment.data.id).single();
  assert(!assessmentReview.error && assessmentReview.data?.project_id === project.data.id,
    "The assessment review item must point to the pending project draft.");
  const logo = await admin.from("project_logos").select("id,project_id,verification_status,storage_path,is_primary")
    .eq("project_id", project.data.id).single();
  assert(!logo.error && logo.data?.verification_status === "pending_review" && logo.data?.storage_path === null && logo.data?.is_primary === false,
    "Logo discovery must create only a pending candidate without approving or uploading it.");
  const logoReview = await admin.from("review_queue").select("id,project_logo_id,status")
    .eq("project_logo_id", logo.data.id).single();
  assert(!logoReview.error && ["open", "in_review"].includes(logoReview.data?.status as string), "Logo review queue linkage must be present.");

  await admin.from("repository_candidates").update({ review_status: "rejected" } as never).eq("id", candidate.data.id as string);
  const rejectedLineage = await admin.rpc("pipeline_operator_verify_run", { p_run_id: String(clean.report.run_id) });
  assert(!rejectedLineage.error && !((rejectedLineage.data as Row).validated_lineages as unknown[]).length,
    "A rejected candidate cannot complete otherwise-valid persisted repository lineage.");
  await admin.from("repository_candidates").update({ review_status: "unreviewed" } as never).eq("id", candidate.data.id as string);

  const stableCountsBeforeResume = await countRows(admin);
  const resumeFixture = makeGitHubFixture({ main: mainRepository, rejected: rejectedRepository, privateRepo: privateRepository, includeDiscoveryResults: false });
  const resumed = await run(["--resume", "--execute", ...boundedArgs], admin, resumeFixture.client);
  const resumeStages = Array.isArray(resumed.report.stages)
    ? (resumed.report.stages as Row[]).map((stage) => ({ stage: stage.stage, status: stage.status, errors: stage.error_events }))
    : [];
  assert(resumed.code === 0 && resumed.report.run_status === "empty"
    && resumed.report.execution_status === "completed" && resumed.report.data_status === "empty"
    && resumed.report.end_to_end_project_completed === true,
  `Resume status=${resumed.report.run_status}; blockers=${JSON.stringify(resumed.report.blockers)}; stages=${JSON.stringify(resumeStages)}`);
  assert((resumed.report.stages as Row[]).some((stage) => stage.stage === "logo_candidates" && Number(stage.reused_record_count) > 0),
    "A resume that reuses a durable pending logo must identify that record as reused.");
  const stableCountsAfterResume = await countRows(admin);
  assert(stableCountsAfterResume.candidates === stableCountsBeforeResume.candidates
    && stableCountsAfterResume.repositories === stableCountsBeforeResume.repositories
    && stableCountsAfterResume.projects === stableCountsBeforeResume.projects
    && stableCountsAfterResume.assessments === stableCountsBeforeResume.assessments
    && stableCountsAfterResume.logos === stableCountsBeforeResume.logos,
  "Resume must not duplicate candidate, repository, project, assessment, or logo rows.");

  const noEvidenceRepository: FixtureRepository = {
    id: markerId("99500"), owner: "no-evidence-project", name: `plain-${suffix}`,
    description: null, topics: [],
  };
  const discoveryOnlyFixture = makeGitHubFixture({ main: noEvidenceRepository, rejected: rejectedRepository, privateRepo: privateRepository });
  const discoveryOnly = await run(["--execute", ...boundedArgs], admin, discoveryOnlyFixture.client,
    { interruptAfterStage: "discovery" });
  assert(discoveryOnly.code === 1 && discoveryOnly.report.run_status === "partial"
    && discoveryOnly.report.data_status === "committed" && discoveryOnly.report.end_to_end_project_completed === false
    && (discoveryOnly.report.stages as Row[]).some((stage) => stage.stage === "discovery" && Number(stage.persisted_record_count) > 0),
  `A discovery-only interrupted execution must report its durable candidate without claiming an end-to-end project. report=${JSON.stringify({
    run_status: discoveryOnly.report.run_status, execution_status: discoveryOnly.report.execution_status,
    data_status: discoveryOnly.report.data_status, end_to_end_project_completed: discoveryOnly.report.end_to_end_project_completed,
    stages: (discoveryOnly.report.stages as Row[]).map((stage) => ({ stage: stage.stage, status: stage.status, persisted_record_count: stage.persisted_record_count })),
  })}`);
  const noEvidenceFixture = makeGitHubFixture({ main: noEvidenceRepository, rejected: rejectedRepository,
    privateRepo: privateRepository, includeDiscoveryResults: false });
  const noEvidenceRun = await run(["--execute", ...boundedArgs], admin, noEvidenceFixture.client);
  assert(noEvidenceRun.code === 1 && noEvidenceRun.report.run_status === "partial"
    && noEvidenceRun.report.execution_status === "completed" && noEvidenceRun.report.data_status === "committed"
    && noEvidenceRun.report.end_to_end_project_completed === false
    && (noEvidenceRun.report.lineage_validation as Row)?.validated_lineage_count === 0,
  "A normal run with completed workers and durable enrichment but no classifiable draft must remain operationally complete without claiming project completion.");
  const noEvidenceCandidate = await admin.from("repository_candidates").select("id,repository_id,enrichment_status")
    .eq("provider", "github").eq("provider_repository_id", String(noEvidenceRepository.id)).single();
  assert(!noEvidenceCandidate.error && noEvidenceCandidate.data?.enrichment_status === "succeeded"
    && noEvidenceCandidate.data?.repository_id, "The no-evidence candidate must have successful enrichment evidence.");
  const noEvidenceAssessment = await admin.from("repository_assessments").select("id,status,result")
    .eq("repository_id", noEvidenceCandidate.data.repository_id as string).single();
  const noEvidenceRepositoryRow = await admin.from("repositories").select("project_id")
    .eq("id", noEvidenceCandidate.data.repository_id as string).single();
  assert(!noEvidenceAssessment.error && noEvidenceAssessment.data?.status === "needs_review"
    && ((noEvidenceAssessment.data.result as Row)?.classification as Row)?.status === "insufficient_evidence"
    && !noEvidenceRepositoryRow.error && noEvidenceRepositoryRow.data?.project_id === null,
  "A fully enriched repository without category evidence must remain review-only and not become a completed draft.");

  const checkpointBeforeFailure = await admin.rpc("pipeline_operator_report");
  const failingDatabase = {
    rpc: (name: string, args: Record<string, unknown>) => name === "start_github_enrichment_job"
      ? Promise.resolve({ data: null, error: { message: "deterministic stage failure", code: "ITFAIL" } })
      : (admin as unknown as { rpc: (rpcName: string, rpcArgs: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }> }).rpc(name, args),
    from: admin.from.bind(admin),
    storage: admin.storage,
  } as unknown as ReturnType<typeof createSupabaseAdminClient>;
  const failureFixture = makeGitHubFixture({ main: mainRepository, rejected: rejectedRepository, privateRepo: privateRepository, includeDiscoveryResults: false });
  const interrupted = await run(["--resume", "--execute", ...boundedArgs], failingDatabase, failureFixture.client);
  assert(interrupted.code === 1 && interrupted.report.run_status === "partial"
    && interrupted.report.execution_status === "partial",
  "A failed enrichment stage should stop the pilot and report partial operational execution.");
  assert((interrupted.report.stages as Row[]).some((stage) => stage.stage === "discovery" && stage.status === "complete")
    && (interrupted.report.stages as Row[]).some((stage) => stage.stage === "enrichment" && stage.status === "failed")
    && (interrupted.report.stages as Row[]).some((stage) => stage.stage === "assessment" && stage.status === "skipped"),
  "A stage failure must preserve completed earlier work and skip later stages.");
  const checkpointAfterFailure = await admin.rpc("pipeline_operator_report");
  const durableCheckpoint = (value: unknown) => Array.isArray(value) ? value.map((row) => {
    const checkpoint = row as Row;
    return { partition_key: checkpoint.partition_key, status: checkpoint.status, cursor: checkpoint.cursor,
      pages_fetched: checkpoint.pages_fetched, next_attempt_at: checkpoint.next_attempt_at, last_error: checkpoint.last_error };
  }) : [];
  const beforeDurable = durableCheckpoint((checkpointBeforeFailure.data as Row)?.checkpoints);
  const afterDurable = durableCheckpoint((checkpointAfterFailure.data as Row)?.checkpoints);
  const committedBefore = beforeDurable.filter((row) => row.status === "completed" || row.cursor !== null);
  const preservedCommittedCheckpoints = committedBefore.every((before) => afterDurable.some((after) =>
    after.partition_key === before.partition_key && after.status === before.status
      && JSON.stringify(after.cursor) === JSON.stringify(before.cursor) && after.pages_fetched === before.pages_fetched));
  assert(!checkpointBeforeFailure.error && !checkpointAfterFailure.error
    && preservedCommittedCheckpoints,
  "A failed later stage must not lose or rewrite the committed discovery checkpoint.");
  const recoveredFixture = makeGitHubFixture({ main: mainRepository, rejected: rejectedRepository, privateRepo: privateRepository, includeDiscoveryResults: false });
  const recovered = await run(["--resume", "--execute", ...boundedArgs], admin, recoveredFixture.client);
  assert((recovered.code === 0 && ["complete", "empty"].includes(recovered.report.run_status as string))
    && recovered.report.execution_status === "completed",
    "A subsequent resume should recover cleanly without duplicating committed work.");

  const partialRepository: FixtureRepository = {
    id: markerId("99400"), owner: "partial-project", name: `language-partial-${suffix}`,
    description: "Developer tools for a partial source fixture", topics: ["developer-tools"], partialLanguages: true,
  };
  await insertCandidate(admin, partialRepository, `partial-${suffix}`);
  const edgeFixture = makeGitHubFixture({ main: partialRepository, rejected: rejectedRepository, privateRepo: privateRepository,
    includeDiscoveryResults: false });
  const edgeRun = await run(["--execute", ...boundedArgs], admin, edgeFixture.client);
  assert(edgeRun.report.run_status === "partial", "A persisted partial enrichment must make the run partial.");
  const partialCandidate = await admin.from("repository_candidates").select("id,enrichment_status,enrichment_error")
    .eq("provider", "github").eq("provider_repository_id", String(partialRepository.id)).single();
  assert(!partialCandidate.error && partialCandidate.data?.enrichment_status === "retry_wait",
    "A failed languages resource should remain partial and retryable instead of being treated as complete.");
  const rateLimitedRepository: FixtureRepository = {
    id: markerId("99600"), owner: "rate-limited-project", name: `api-budget-${suffix}`,
    description: "Developer tools for a rate limit fixture", topics: ["developer-tools"], rateLimited: true,
  };
  await insertCandidate(admin, rateLimitedRepository, `rate-limit-${suffix}`);
  const rateFixture = makeGitHubFixture({ main: rateLimitedRepository, rejected: rejectedRepository, privateRepo: privateRepository,
    includeDiscoveryResults: false });
  const rateLimitedRun = await run(["--execute", "--max-enrichments", "1", ...boundedArgs], admin, rateFixture.client);
  assert(rateLimitedRun.report.run_status === "partial", "GitHub rate limits must stop the pilot with a partial status.");
  const rateStage = (rateLimitedRun.report.stages as Row[]).find((stage) => stage.stage === "enrichment");
  const rateCheckpoint = rateStage?.last_durable_checkpoint as Row | undefined;
  assert(typeof rateCheckpoint?.rate_limit_reason === "string" && typeof rateCheckpoint.next_eligible_retry_at === "string",
    "Rate-limit output must include the persisted reason and the matching candidate's next eligible retry time.");

  const beforeReadOnly = await countRows(admin);
  const statusFixture = makeGitHubFixture({ main: mainRepository, rejected: rejectedRepository, privateRepo: privateRepository, includeDiscoveryResults: false });
  const readStatus = await run(["--status"], admin, statusFixture.client);
  assert(readStatus.code === 0 && readStatus.report.event === "pipeline_status", "Read-only status must return the operational inventory without a crawl.");
  assert(Array.isArray(readStatus.report.integrity_findings), "Status must include the read-only integrity audit.");
  assert(!statusFixture.requests.some((request) => new URL(request).pathname === "/search/repositories"), "Status must not start a discovery crawl.");
  const auditFixture = makeGitHubFixture({ main: mainRepository, rejected: rejectedRepository, privateRepo: privateRepository, includeDiscoveryResults: false });
  const readAudit = await run(["--audit"], admin, auditFixture.client);
  assert(readAudit.code === 0 && readAudit.report.event === "pipeline_integrity_audit", "Read-only integrity audit should be available independently.");
  assert(auditFixture.requests.length === 0, "The integrity audit must not call GitHub.");
  const afterReadOnly = await countRows(admin);
  assert(JSON.stringify(afterReadOnly) === JSON.stringify(beforeReadOnly), "Status and audit must not mutate database rows.");

  const candidateNameBeforeRename = candidate.data.full_name as string;
  const renamedCanonicalName = `outlist-pilot/renamed-${suffix}`;
  const renameUpdate = await admin.from("repositories").update({
    owner_login: "outlist-pilot", repository_name: `renamed-${suffix}`,
    full_name: renamedCanonicalName, canonical_url: `https://github.com/${renamedCanonicalName}`,
  } as never).eq("id", repository.data.id as string);
  assert(!renameUpdate.error, "The local audit regression must model a provider repository rename.");
  const renameCandidate = await admin.from("repository_candidates").select("full_name")
    .eq("id", candidate.data.id as string).single();
  const renameAudit = await admin.rpc("pipeline_operator_report");
  const renameFindings = (((renameAudit.data as Row)?.integrity_findings ?? []) as Row[]);
  assert(!renameAudit.error && renameCandidate.data?.full_name === candidateNameBeforeRename
    && !renameFindings.some((finding) => finding.code === "candidate_repository_identity_mismatch"
      && (finding.affected_record_ids as string[] | undefined)?.includes(candidate.data.id as string)),
  "A historical discovery name must remain intact while stable provider identity survives a canonical rename without a false critical finding.");

  const badIdentityUpdate = await admin.from("repository_candidates").update({
    provider_repository_id: String(Number(mainRepository.id) + 1),
  } as never).eq("id", candidate.data.id as string);
  assert(!badIdentityUpdate.error, "The local audit regression must create a provider-ID association conflict.");
  const badIdentityAudit = await admin.rpc("pipeline_operator_report");
  const badIdentityFindings = (((badIdentityAudit.data as Row)?.integrity_findings ?? []) as Row[]);
  assert(!badIdentityAudit.error && badIdentityFindings.some((finding) => finding.code === "candidate_repository_identity_mismatch"
    && finding.severity === "critical" && (finding.affected_record_ids as string[] | undefined)?.includes(candidate.data.id as string)),
  "A genuinely incorrect candidate-to-repository numeric provider ID must remain a critical finding.");
  await admin.from("repository_candidates").update({ provider_repository_id: String(mainRepository.id) } as never)
    .eq("id", candidate.data.id as string);
  await admin.from("repositories").update({ owner_login: mainRepository.owner, repository_name: mainRepository.name,
    full_name: `${mainRepository.owner}/${mainRepository.name}`,
    canonical_url: `https://github.com/${mainRepository.owner}/${mainRepository.name}` } as never)
    .eq("id", repository.data.id as string);

  const projectBeforeEditorial = await admin.from("projects")
    .select("name,summary,publication_status,quality_status,license_status,license_identifier,license_verified_at,featured")
    .eq("id", project.data.id as string).single();
  assert(!projectBeforeEditorial.error && projectBeforeEditorial.data, "The editorial audit regression requires the real assessed draft.");
  const editorialPublish = await admin.from("projects").update({
    name: "Editorially reviewed local project", summary: "A valid editorial publication fixture.",
    publication_status: "published", quality_status: "verified", license_status: "verified_open_source",
    license_identifier: "MIT", license_verified_at: new Date().toISOString(), featured: true,
  } as never).eq("id", project.data.id as string);
  assert(!editorialPublish.error, `The valid editorial publication fixture must satisfy database constraints: ${editorialPublish.error?.message ?? "unknown"}`);
  const editorialAudit = await admin.rpc("pipeline_operator_report");
  const editorialFindings = (((editorialAudit.data as Row)?.integrity_findings ?? []) as Row[]);
  assert(!editorialAudit.error && !editorialFindings.some((finding) => [
    "pipeline_project_has_unexpected_state", "pipeline_project_has_invalid_published_state",
  ].includes(finding.code as string) && (finding.affected_record_ids as string[] | undefined)?.includes(project.data.id as string)),
  "The audit must not call a constraint-valid editorial publication corruption solely because the project originated in assessment.");
  await admin.from("projects").update(projectBeforeEditorial.data as never).eq("id", project.data.id as string);

  const reportResult = await admin.rpc("pipeline_operator_report");
  assert(!reportResult.error && reportResult.data, "The local operator report RPC must be available to the service credential.");
  const report = reportResult.data as Row;
  const inventory = report.inventory as Row;
  assert(Number(inventory.discovered_candidates) >= 2 && Number(inventory.successfully_enriched_public_repositories) >= 1,
    "The post-run inventory must include the real candidate and public enriched repository.");
  assert(Number(inventory.pending_review_project_drafts) >= 1 && Number(inventory.logos_pending_review) >= 1,
    "Inventory must distinguish persisted drafts and pending logos from published listings.");

  const rejectLogo = await admin.rpc("set_project_logo_review_status", { p_logo_id: logo.data.id as string, p_status: "rejected" });
  assert(!rejectLogo.error, `The logo review-state fixture must use the guarded operator RPC: ${rejectLogo.error?.message ?? "unknown"}`);
  const missingLogoLineage = await admin.rpc("pipeline_operator_verify_run", { p_run_id: String(clean.report.run_id) });
  assert(!missingLogoLineage.error && !((missingLogoLineage.data as Row).validated_lineages as unknown[]).length,
    "A draft without a pending valid logo candidate and active review link cannot complete lineage.");

  const anonReport = await anonymous.rpc("pipeline_operator_report");
  assert(anonReport.error !== null, "Anonymous clients must not call the privileged operator report RPC.");
  const anonCandidates = await anonymous.from("repository_candidates").select("id");
  assert(anonCandidates.error !== null || anonCandidates.data.length === 0, "Anonymous clients must not read private ingestion candidates.");

  process.stdout.write(`${JSON.stringify({
    event: "pipeline_db_integration_passed",
    source_kind: "deterministic_github_http_fixtures",
    database_kind: "real_local_supabase_postgrest_and_postgresql",
    actual_orchestrator: true,
    worker_stages: stageNames,
    clean_first_run: true,
    coherent_repository_lineage_verified: true,
    unrelated_stage_records_rejected: true,
    discovery_only_does_not_claim_project: true,
    bounded_resume_idempotent: true,
    reused_records_reported: true,
    interrupted_run_resumed_from_checkpoint: true,
    rejected_and_discarded_preserved: true,
    private_candidate_excluded: true,
    draft_review_relationships_verified: true,
    pending_logo_only: true,
    partial_enrichment_retryable: true,
    no_classification_evidence_review_only: true,
    private_and_rejected_lineages_rejected: true,
    draft_without_valid_pending_logo_rejected: true,
    rename_audit_false_positive_avoided: true,
    incorrect_provider_id_still_critical: true,
    editorial_publication_not_called_corrupt: true,
    rate_limit_reason_and_retry_time_reported: true,
    later_stage_failure_checkpoint_preserved: true,
    status_and_audit_read_only: true,
    fixture_cannot_be_reported_as_live_smoke: true,
    rls_and_privileged_rpc_restrictions: true,
    live_github_or_hosted_supabase_used: false,
  })}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 400) : "unexpected local pilot integration failure";
  process.stderr.write(`${JSON.stringify({ event: "pipeline_db_integration_failed", message })}\n`);
  process.exitCode = 1;
}
