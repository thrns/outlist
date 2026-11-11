import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createGitHubClient } from "../src/lib/github/client";
import { runEnrichmentCli, type EnrichmentCliDependencies } from "./enrich";
import type { Database, Json } from "../src/lib/supabase/database.types";

type ResultLike<T = unknown> = PromiseLike<{
  data: T;
  error: { code: string; message: string } | null;
}>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function must<T>(request: ResultLike<T>, label: string): Promise<T> {
  const { data, error } = await request;
  if (error) throw new Error(`${label} failed (${error.code}): ${error.message.replace(/[\r\n\t]+/g, " ").slice(0, 400)}`);
  return data;
}

async function mustPresent<T>(request: ResultLike<T>, label: string): Promise<NonNullable<T>> {
  const data = await must(request, label);
  if (data === null || data === undefined) throw new Error(`${label} returned no data.`);
  return data as NonNullable<T>;
}

async function fails(request: ResultLike, expectedCode: string, label: string) {
  const { error } = await request;
  assert(error?.code === expectedCode, `${label}: expected ${expectedCode}, received ${error?.code ?? "success"}`);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SECRET_KEY;
if (!url || !publishableKey || !serviceKey) throw new Error("Local Supabase URL, publishable key, and service key are required.");
const supabaseUrl: string = url;
const anonKey: string = publishableKey;
const serviceRoleKey: string = serviceKey;

const service = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8_000) }) },
});
const anonymous = createClient<Database>(supabaseUrl, anonKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

type Fixture = { projectId: string; repositoryId: string; assessmentId: string | null; observedAt: string };

async function createIdentity(name: string, isAdmin: boolean) {
  const email = `editorial-${name}-${randomUUID()}@example.com`;
  const password = `M1-07-${randomUUID()}-Local`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error("Could not create a local Auth integration identity.");
  if (isAdmin) await must(service.from("admin_users").insert({ user_id: data.user.id }), `Allowlist ${name}`);
  return { userId: data.user.id, email, password };
}

async function createFixture(options: { name: string; category?: boolean; evidence?: boolean; restricted?: boolean; archived?: boolean; queue?: boolean }): Promise<Fixture> {
  const projectId = randomUUID();
  const repoId = randomUUID();
  const observedAt = new Date(Date.now() - 30_000).toISOString();
  const providerId = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`).toString();
  const category = await must(service.from("categories").select("id").eq("slug", "developer-tools").single(), "Read active test category");
  assert(category, "The seeded test category must exist.");
  const project = await must(service.from("projects").insert({
    id: projectId,
    slug: `m107-${randomUUID().replaceAll("-", "").slice(0, 18)}`,
    name: options.name,
    summary: "A clear description for an Outlist integration fixture.",
    description: "Imported from validated GitHub source data for editorial workflow integration testing.",
    publication_status: "pending_review",
    quality_status: "unreviewed",
    license_status: "unverified",
  }).select("id").single(), "Create project fixture");
  assert(project && project.id === projectId, "Project fixture ID changed unexpectedly.");

  const restricted = options.restricted === true;
  await must(service.from("repositories").insert({
    id: repoId,
    project_id: projectId,
    provider: "github",
    provider_repository_id: providerId,
    full_name: "outlist-fixtures/editorial-project",
    canonical_url: "https://github.com/outlist-fixtures/editorial-project",
    owner_login: "outlist-fixtures",
    repository_name: "editorial-project",
    is_archived: options.archived === true,
    provider_node_id: `R_${providerId}`,
    availability_status: restricted ? "access_restricted" : "available",
    is_private: restricted ? null : false,
    visibility: restricted ? null : "public",
    is_disabled: restricted ? null : false,
    source_observed_at: observedAt,
    last_successful_sync_at: observedAt,
    source_field_states: restricted
      ? { visibility: "unavailable", license: "absent" }
      : { visibility: "present", license: "present", description: "present", topics: "present", languages: "present", releases: "present" },
    source_license_metadata: restricted ? null : { detected_spdx_id: "NOASSERTION" },
    stars: 4,
    forks: 1,
  }), "Create repository fixture");
  await must(service.from("projects").update({ primary_repository_id: repoId }).eq("id", projectId), "Set primary repository");
  if (options.category !== false) {
    await must(service.from("project_categories").insert({ project_id: projectId, category_id: category.id }), "Attach active category");
  }

  let assessmentId: string | null = null;
  if (options.evidence !== false) {
    const sourceKinds = ["repository", "topics", "languages", "releases"] as const;
    const records: Array<{ id: string; record_kind: string }> = [];
    for (const kind of sourceKinds) {
      const recordId = randomUUID();
      await must(service.from("source_records").insert({
        id: recordId,
        provider: "github",
        record_kind: kind,
        source_key: `${providerId}:${kind}:${randomUUID()}`,
        source_url: "https://api.github.com/repos/outlist-fixtures/editorial-project",
        fetched_at: observedAt,
        http_status: 200,
        repository_id: repoId,
        source_metadata: { validated: true, api_version: "2022-11-28", resource_kind: kind, stable_provider_id: providerId },
      }), `Create ${kind} source observation`);
      records.push({ id: recordId, record_kind: kind });
    }
    assessmentId = randomUUID();
    await must(service.from("repository_assessments").insert({
      id: assessmentId,
      repository_id: repoId,
      policy_version: "m1-04-assessment-v1",
      source_observed_at: observedAt,
      status: "assessed",
      assessed_at: observedAt,
      result: {
        classification: { status: "classified", primaryCategoryId: category.id, suggestions: [{ categoryId: category.id, score: 1, evidence: ["source topic: developer-tools"] }] },
        license: { policyVersion: "outlist-license-evidence-v1", status: "conflicting_evidence", identifier: null, projectLicenseStatus: "needs_review", evidence: [], explanation: "Source evidence is intentionally uncertain for human review.", requiresReview: true },
        quality: { policyVersion: "outlist-source-quality-v1", status: "eligible_for_review", priority: "normal", qualityStatus: "needs_review", flags: [
          { code: "license_uncertain", severity: "review", evidence: ["source_license_metadata"], explanation: "License evidence requires human review." },
          ...(options.archived ? [{ code: "archived", severity: "review", evidence: ["repository.is_archived"], explanation: "The archived repository needs human consideration." }] : []),
        ] },
      } as Json,
    }), "Create repository assessment");
    await must(service.from("repository_assessment_sources").insert(records.map((record) => ({ assessment_id: assessmentId!, source_record_id: record.id }))), "Link source evidence");
  }
  if (options.queue !== false) {
    await must(service.from("review_queue").insert({
      project_id: projectId,
      assessment_id: assessmentId,
      reason: "Imported project requires administrator evidence review.",
      status: "open",
    }), "Create open review item");
  }
  return { projectId, repositoryId: repoId, assessmentId, observedAt };
}

async function claimPrimaryRepository(repositoryId: string, marker: string, workerId: string, existingCandidateId?: string) {
  const repository = await mustPresent(service.from("repositories")
    .select("provider_repository_id,full_name,canonical_url,owner_login")
    .eq("id", repositoryId).single(), "Read the primary repository for a safety claim");
  let candidateId = existingCandidateId;
  if (candidateId) {
    const requeue = await service.from("repository_candidates").update({
      enrichment_status: "queued",
      enrichment_completed_at: null,
      enrichment_error: null,
      enrichment_next_attempt_at: null,
    }).eq("id", candidateId);
    assert(!requeue.error, `Requeue the existing stable-identity candidate: ${requeue.error?.message ?? "update failed"}`);
  } else {
    const source = await mustPresent(service.from("source_records").insert({
      provider: "github",
      record_kind: "discovery_page",
      source_key: `editorial-safety:${marker}:${randomUUID()}`,
      source_url: "https://api.github.com/search/repositories?q=outlist-editorial-safety-fixture",
      fetched_at: new Date().toISOString(),
      http_status: 200,
      source_metadata: { fixture: true, pipeline: "editorial-safety-integration" },
    }).select("id").single(), "Create the enrichment candidate's source record");
    const candidate = await mustPresent(service.from("repository_candidates").insert({
      provider: "github",
      provider_repository_id: repository.provider_repository_id,
      full_name: repository.full_name,
      canonical_url: repository.canonical_url,
      owner_login: repository.owner_login,
      source_record_id: source.id,
      repository_id: repositoryId,
      queue_status: "queued",
      review_status: "unreviewed",
    }).select("id").single(), "Create the fenced primary-repository candidate");
    candidateId = candidate.id;
  }
  const jobId = await mustPresent(service.rpc("start_github_enrichment_job", {
    p_resume: false,
    p_metadata: { fixture: true, editorial_safety: marker },
  }), "Start a real local enrichment job for the primary repository");
  const claims = await mustPresent(service.rpc("claim_github_enrichment_candidates", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_limit: 1,
    p_lease_seconds: 60,
  }), "Claim the primary repository with a live fencing token");
  const claim = claims[0];
  assert(claim?.candidate_id === candidateId, "The live enrichment claim must match the primary-repository candidate.");
  return { candidateId, jobId, workerId, leaseToken: claim.lease_token, providerRepositoryId: repository.provider_repository_id };
}

function makePublicRecoveryClient(providerRepositoryId: string, observedAt: string) {
  const numericId = Number(providerRepositoryId);
  const response = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/vnd.github+json",
      etag: `"editorial-safety-recovery-${providerRepositoryId}"`,
      "x-github-api-version-selected": "2022-11-28",
    },
  });
  return createGitHubClient({
    token: null,
    maxRetries: 0,
    now: () => Date.parse(observedAt),
    fetch: async (input) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      if (requestUrl.pathname === `/repositories/${providerRepositoryId}`) {
        return response({
          id: numericId,
          node_id: `R_editorial_recovery_${providerRepositoryId}`,
          name: "editorial-project",
          full_name: "outlist-fixtures/editorial-project",
          owner: { id: 882001, node_id: "O_editorial_recovery", login: "outlist-fixtures", type: "Organization" },
          html_url: "https://github.com/outlist-fixtures/editorial-project",
          url: "https://api.github.com/repos/outlist-fixtures/editorial-project",
          description: "Validated public recovery metadata.",
          homepage: "https://example.org/editorial-project",
          topics: ["developer-tools"],
          language: "TypeScript",
          stargazers_count: 12,
          forks_count: 3,
          watchers_count: 15,
          open_issues_count: 2,
          archived: false,
          disabled: false,
          fork: false,
          private: false,
          visibility: "public",
          default_branch: "main",
          created_at: "2024-01-01T00:00:00.000Z",
          updated_at: observedAt,
          pushed_at: observedAt,
          license: { key: "mit", name: "MIT License", spdx_id: "MIT", url: null, html_url: null, node_id: "L_editorial_recovery" },
        });
      }
      if (requestUrl.pathname.endsWith("/languages")) return response({ TypeScript: 1200 });
      if (requestUrl.pathname.endsWith("/topics")) return response({ names: ["developer-tools"] });
      if (requestUrl.pathname.endsWith("/releases")) return response([]);
      throw new Error(`Unexpected recovery fixture URL: ${requestUrl.pathname}`);
    },
  });
}

async function runPublicRecovery(providerRepositoryId: string, candidateId: string, observedAt: string) {
  const requeue = await service.from("repository_candidates").update({
    enrichment_status: "queued",
    enrichment_completed_at: null,
    enrichment_error: null,
    enrichment_next_attempt_at: null,
  }).eq("id", candidateId);
  assert(!requeue.error, `Requeue the source candidate for recovery: ${requeue.error?.message ?? "update failed"}`);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: EnrichmentCliDependencies = {
    supabase: service as unknown as NonNullable<EnrichmentCliDependencies["supabase"]>,
    github: makePublicRecoveryClient(providerRepositoryId, observedAt),
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  };
  const status = await runEnrichmentCli(["--execute", "--max-candidates", "1", "--max-releases", "2"], dependencies);
  assert(status === 0, `Validated public recovery must complete through the enrichment worker: ${stderr.join("").slice(0, 500)}`);
  return stdout.join("");
}

async function primePublicationEligibilityAudit(projectId: string, actorUserId: string, observedAt: string) {
  const initial = await mustPresent(service.from("projects").select("editorial_revision").eq("id", projectId).single(), "Read publication-gate fixture revision");
  await must(service.rpc("admin_verify_project_license", {
    p_actor: actorUserId,
    p_project_id: projectId,
    p_expected_revision: Number(initial.editorial_revision),
    p_expected_source_observed_at: observedAt,
    p_license_identifier: "MIT",
    p_evidence_reference: "https://opensource.org/license/mit",
    p_reason: "Test fixture uses the supported human license review workflow.",
    p_confirm_open_source: true,
  }), "Verify test fixture license through the human review RPC");
  const next = await mustPresent(service.from("projects").select("editorial_revision").eq("id", projectId).single(), "Read quality-review fixture revision");
  await must(service.rpc("admin_verify_project_quality", {
    p_actor: actorUserId,
    p_project_id: projectId,
    p_expected_revision: Number(next.editorial_revision),
    p_expected_source_observed_at: observedAt,
    p_reason: "Test fixture uses the supported human quality review workflow.",
    p_confirm_review: true,
  }), "Verify test fixture quality through the human review RPC");
}

async function main() {
  const admin = await createIdentity("admin", true);
  const secondAdmin = await createIdentity("second-admin", true);
  const revokedAdmin = await createIdentity("revoked-admin", true);
  const ordinary = await createIdentity("ordinary", false);

  const ordinaryClient = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const authResult = await ordinaryClient.auth.signInWithPassword({ email: ordinary.email, password: ordinary.password });
  assert(!authResult.error, "A real local Auth user should receive an authenticated session.");

  const valid = await createFixture({ name: "Editorial publication integration fixture", archived: true });
  const logoObservedAt = new Date().toISOString();
  const logoAttribution = "Local editorial safety regression fixture.";
  const logoSource = await mustPresent(service.from("source_records").insert({
    provider: "other",
    record_kind: "operator_logo_candidate",
    source_key: `editorial-safety-logo:${valid.projectId}`,
    source_url: "https://example.org/editorial-project/logo.webp",
    fetched_at: logoObservedAt,
    http_status: 200,
    repository_id: valid.repositoryId,
    source_metadata: { operator_action: true, observed_at: logoObservedAt, attribution: logoAttribution },
  }).select("id").single(), "Create trusted logo source provenance for safety preservation");
  const preservedLogo = await mustPresent(service.rpc("register_project_logo_candidate", {
    p_project_id: valid.projectId,
    p_origin: "editorial",
    p_source_url: "https://example.org/editorial-project/logo.webp",
    p_attribution_text: logoAttribution,
    p_candidate_key: `operator-official:${"a".repeat(64)}`,
    p_repository_id: valid.repositoryId,
    p_source_record_id: logoSource.id,
    p_source_observed_at: logoObservedAt,
    p_source_provenance: {
      provider: "operator",
      operator_action: true,
      observed_at: logoObservedAt,
      attribution: logoAttribution,
    },
  }), "Register a logo candidate through its authorized RPC");
  const preservedLogoReview = await mustPresent(service.from("review_queue").select("id,status")
    .eq("project_logo_id", preservedLogo).single(), "Capture the existing logo review item");
  const pendingPublic = await anonymous.from("projects").select("id").eq("id", valid.projectId);
  assert(!pendingPublic.error && pendingPublic.data.length === 0, "Pending projects must remain invisible under public RLS.");
  await fails(anonymous.rpc("admin_publish_project", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: 0, p_reason: "Attempt from anonymous client.",
  }), "42501", "Anonymous publication RPC denial");
  await fails(ordinaryClient.rpc("admin_publish_project", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: 0, p_reason: "Attempt from authenticated client.",
  }), "42501", "Ordinary authenticated publication RPC denial");
  await fails(service.rpc("admin_publish_project", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: 0, p_reason: "License remains unverified for this project.",
  }), "23514", "Publication with unverified license");
  await fails(service.rpc("admin_verify_project_quality", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: 0,
    p_expected_source_observed_at: valid.observedAt, p_reason: "A human reason is recorded but no confirmation was supplied.", p_confirm_review: false,
  }), "22023", "Quality verification without explicit review confirmation");
  await fails(service.rpc("admin_verify_project_quality", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: 0,
    p_expected_source_observed_at: new Date(Date.parse(valid.observedAt) + 1_000).toISOString(),
    p_reason: "The administrator form was loaded before this source observation changed.", p_confirm_review: true,
  }), "40001", "Quality verification with a stale source observation");
  await fails(service.rpc("admin_verify_project_license", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: 0,
    p_expected_source_observed_at: valid.observedAt, p_license_identifier: "MIT",
    p_evidence_reference: "https://github.com/outlist-fixtures/editorial-project/blob/main/LICENSE",
    p_reason: "GitHub detection is the only source and is not independent evidence.", p_confirm_open_source: true,
  }), "22023", "License verification without independent evidence");

  const license = await must(service.rpc("admin_verify_project_license", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: 0,
    p_expected_source_observed_at: valid.observedAt, p_license_identifier: "MIT",
    p_evidence_reference: "https://opensource.org/license/mit",
    p_reason: "The official project license file and the OSI listing support this SPDX identifier.", p_confirm_open_source: true,
  }), "Verify source license");
  const afterLicenseRevision = Number((license as { revision?: number }).revision);
  assert(afterLicenseRevision === 1, "License verification should advance the editorial revision.");
  const quality = await must(service.rpc("admin_verify_project_quality", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: afterLicenseRevision,
    p_expected_source_observed_at: valid.observedAt,
    p_reason: "The current repository is public and available. Its archived state and the license flag were considered separately.", p_confirm_review: true,
  }), "Verify minimum catalog quality");
  const afterQualityRevision = Number((quality as { revision?: number }).revision);
  assert(afterQualityRevision === 2, "Quality verification should advance the editorial revision.");
  await fails(service.rpc("admin_publish_project", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: afterQualityRevision,
    p_reason: "An unresolved review item still requires an administrator decision.",
  }), "23514", "Publication with unresolved review item");
  const openItem = await must(service.from("review_queue").select("id").eq("project_id", valid.projectId).eq("status", "open").single(), "Read blocking review item");
  assert(openItem, "The pending project must have its blocking review item.");
  const resolved = await must(service.rpc("admin_resolve_project_review_item", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_queue_id: openItem.id,
    p_expected_revision: afterQualityRevision, p_reason: "The assessment flag and source evidence were reviewed and resolved.",
  }), "Resolve review item");
  const afterResolveRevision = Number((resolved as { revision?: number }).revision);
  const published = await must(service.rpc("admin_publish_project", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: afterResolveRevision,
    p_reason: "Current evidence and both required human decisions meet publication policy.",
  }), "Publish eligible project");
  const publishedRevision = Number((published as { revision?: number }).revision);
  assert((published as { published?: boolean }).published === true, "Publication should succeed.");
  const repeated = await must(service.rpc("admin_publish_project", {
    p_actor: admin.userId, p_project_id: valid.projectId, p_expected_revision: afterResolveRevision,
    p_reason: "Repeated publication request should be idempotent.",
  }), "Repeat publication idempotently");
  assert((repeated as { idempotent?: boolean }).idempotent === true, "Repeated publication must not append a second approval.");
  const publicAfterPublish = await anonymous.from("projects").select("id,publication_status").eq("id", valid.projectId).single();
  assert(!publicAfterPublish.error && publicAfterPublish.data.publication_status === "published", "Published project must be visible under public RLS.");
  const publishEvents = await must(service.from("editorial_decisions").select("id").eq("project_id", valid.projectId).eq("action", "publish"), "Read publication audit");
  assert(publishEvents, "The publication audit query must return rows.");
  assert(publishEvents.length === 1, "Repeated publish must create exactly one audit event.");
  const audit = await must(service.from("editorial_decisions").select("actor_user_id,action,resulting_state,resulting_revision").eq("project_id", valid.projectId).order("resulting_revision"), "Read editorial audit trail");
  assert(audit, "The editorial audit query must return rows.");
  assert(audit.some((event) => event.actor_user_id === admin.userId && event.action === "verify_license"), "License reviewer identity and decision should be audited.");
  assert(audit.some((event) => event.action === "verify_quality"), "Quality decision should be audited.");
  assert(audit.some((event) => event.action === "publish" && event.resulting_state === "published" && event.resulting_revision === publishedRevision), "Publication audit state and revision should be correct.");

  assert(valid.assessmentId, "The source-backed publication fixture must include its assessment.");
  const projectBeforeRestriction = await mustPresent(service.from("projects").select("id,slug,name,summary,primary_repository_id,publication_status,published_at,editorial_revision,license_status,license_identifier,quality_status")
    .eq("id", valid.projectId).single(), "Capture published project identity and editorial evidence");
  const repositoryBeforeRestriction = await mustPresent(service.from("repositories").select("id,project_id,provider_repository_id,full_name,canonical_url,stars,forks,description,availability_status")
    .eq("id", valid.repositoryId).single(), "Capture canonical repository metadata before restriction");
  const humanDecisionsBeforeRestriction = await mustPresent(service.from("editorial_decisions")
    .select("id,actor_user_id,action,resulting_state,resulting_revision").eq("project_id", valid.projectId),
  "Capture existing human editorial decisions");
  const oldResolvedReview = await mustPresent(service.from("review_queue").select("id,status")
    .eq("project_id", valid.projectId).eq("assessment_id", valid.assessmentId).single(),
  "Capture the resolved historical review item");
  assert(oldResolvedReview.status === "resolved", "The original assessment review must be resolved before publication.");

  const restrictionClaim = await claimPrimaryRepository(valid.repositoryId, "published-primary", "published-safety-worker");
  const invalid404Restriction = await service.rpc("fail_github_repository_enrichment", {
    p_candidate_id: restrictionClaim.candidateId,
    p_worker_id: restrictionClaim.workerId,
    p_lease_token: restrictionClaim.leaseToken,
    p_error_summary: "source_access_restricted",
    p_retryable: false,
    p_failure_provenance: {
      source_url: `https://api.github.com/repositories/${restrictionClaim.providerRepositoryId}`,
      fetched_at: new Date().toISOString(),
      http_status: 404,
      error_kind: "visibility_restricted",
      outcome: "access_restricted",
      visibility_signal: "private_flag",
    },
  });
  assert(invalid404Restriction.error?.code === "22023", "An ambiguous 404 cannot use the validated access-restriction outcome.");
  const stillPublishedAfter404 = await mustPresent(service.from("projects").select("publication_status")
    .eq("id", valid.projectId).single(), "Read publication state after ambiguous restriction evidence");
  const stillAvailableAfter404 = await mustPresent(service.from("repositories").select("availability_status")
    .eq("id", valid.repositoryId).single(), "Read repository state after ambiguous restriction evidence");
  assert(stillPublishedAfter404.publication_status === "published" && stillAvailableAfter404.availability_status === "available",
    "An invalid 404 restriction attempt leaves both publication and repository state unchanged.");

  const restriction = await mustPresent(service.rpc("fail_github_repository_enrichment", {
    p_candidate_id: restrictionClaim.candidateId,
    p_worker_id: restrictionClaim.workerId,
    p_lease_token: restrictionClaim.leaseToken,
    p_error_summary: "source_access_restricted",
    p_retryable: false,
    p_failure_provenance: {
      source_url: `https://api.github.com/repositories/${restrictionClaim.providerRepositoryId}`,
      fetched_at: new Date().toISOString(),
      http_status: 200,
      error_kind: "visibility_restricted",
      outcome: "access_restricted",
      visibility_signal: "private_flag",
    },
  }), "Record confirmed restriction against the published primary repository");
  assert((restriction as { status?: string; outcome?: string }).status === "failed"
    && (restriction as { outcome?: string }).outcome === "access_restricted",
  "The fenced failure RPC durably closes the candidate as access restricted.");
  await must(service.rpc("finish_github_enrichment_job", {
    p_job_id: restrictionClaim.jobId,
    p_status: "partial",
    p_error_summary: "A confirmed GitHub visibility restriction was recorded for the published primary repository.",
  }), "Finish the confirmed-restriction enrichment job");

  const demotedProject = await mustPresent(service.from("projects").select("id,slug,name,summary,primary_repository_id,publication_status,published_at,editorial_revision,license_status,license_identifier,quality_status")
    .eq("id", valid.projectId).single(), "Read the safety-demoted project");
  const restrictedRepository = await mustPresent(service.from("repositories").select("id,project_id,provider_repository_id,full_name,canonical_url,stars,forks,description,availability_status")
    .eq("id", valid.repositoryId).single(), "Read restricted canonical repository");
  assert(demotedProject.id === projectBeforeRestriction.id && demotedProject.slug === projectBeforeRestriction.slug
    && demotedProject.primary_repository_id === projectBeforeRestriction.primary_repository_id,
  "Safety demotion preserves project UUID, slug, and primary repository identity.");
  assert(demotedProject.publication_status === "pending_review"
    && Number(demotedProject.editorial_revision) === publishedRevision + 1
    && demotedProject.published_at === projectBeforeRestriction.published_at,
  "Safety demotion removes public status, advances revision, and preserves the historical publication timestamp.");
  assert(demotedProject.name === projectBeforeRestriction.name && demotedProject.summary === projectBeforeRestriction.summary
    && demotedProject.license_status === projectBeforeRestriction.license_status
    && demotedProject.license_identifier === projectBeforeRestriction.license_identifier
    && demotedProject.quality_status === projectBeforeRestriction.quality_status,
  "Safety demotion preserves editorial fields and verified human decisions.");
  assert(restrictedRepository.id === repositoryBeforeRestriction.id
    && restrictedRepository.project_id === repositoryBeforeRestriction.project_id
    && restrictedRepository.provider_repository_id === repositoryBeforeRestriction.provider_repository_id
    && restrictedRepository.availability_status === "access_restricted"
    && restrictedRepository.full_name === repositoryBeforeRestriction.full_name
    && restrictedRepository.canonical_url === repositoryBeforeRestriction.canonical_url
    && restrictedRepository.stars === repositoryBeforeRestriction.stars
    && restrictedRepository.forks === repositoryBeforeRestriction.forks
    && restrictedRepository.description === repositoryBeforeRestriction.description,
  "The restriction preserves canonical ID, association, and historical public metadata.");
  const safetyEvents = await mustPresent(service.from("project_safety_events").select("*")
    .eq("project_id", valid.projectId).eq("repository_id", valid.repositoryId), "Read system-origin safety event");
  assert(safetyEvents.length === 1 && safetyEvents[0]?.origin === "system"
    && safetyEvents[0]?.event_type === "published_source_access_restricted"
    && safetyEvents[0]?.previous_publication_status === "published"
    && safetyEvents[0]?.resulting_publication_status === "pending_review"
    && safetyEvents[0]?.resulting_revision === demotedProject.editorial_revision
    && safetyEvents[0]?.candidate_id === restrictionClaim.candidateId,
  "One system-origin event records the publication safety transition without a human actor.");
  const safetyReviews = await mustPresent(service.from("review_queue").select("id,status,reason,repository_id")
    .eq("repository_id", valid.repositoryId)
    .eq("reason", "GitHub repository access is restricted; review current public source evidence before republishing.")
    .in("status", ["open", "in_review"]), "Read blocking source-safety review item");
  assert(safetyReviews.length === 1 && safetyReviews[0]?.status === "open",
    "Demotion creates exactly one open blocking review item for the canonical repository.");
  const preservedLogoAfterRestriction = await mustPresent(service.from("project_logos").select("id,project_id,repository_id")
    .eq("id", preservedLogo).single(), "Verify the existing logo record survived demotion");
  const preservedLogoReviewAfterRestriction = await mustPresent(service.from("review_queue").select("id,status")
    .eq("id", preservedLogoReview.id).single(), "Verify the existing logo review item survived demotion");
  assert(preservedLogoAfterRestriction.project_id === valid.projectId
    && preservedLogoAfterRestriction.repository_id === valid.repositoryId
    && preservedLogoReviewAfterRestriction.status === preservedLogoReview.status,
  "Safety demotion preserves the project's existing logo record, association, and review state.");
  const humanDecisionsAfterRestriction = await mustPresent(service.from("editorial_decisions")
    .select("id,actor_user_id,action,resulting_state,resulting_revision").eq("project_id", valid.projectId),
  "Verify the append-only human decision audit after demotion");
  assert(humanDecisionsAfterRestriction.length === humanDecisionsBeforeRestriction.length
    && humanDecisionsBeforeRestriction.every((before) => humanDecisionsAfterRestriction.some((after) => after.id === before.id
      && after.actor_user_id === before.actor_user_id && after.action === before.action)),
  "The system event does not impersonate an administrator or replace historical human decisions.");
  const restrictionProvenance = await mustPresent(service.from("source_records").select("source_url,http_status,raw_payload,source_metadata")
    .eq("candidate_id", restrictionClaim.candidateId).eq("http_status", 200).single(),
  "Read safe source-restriction provenance");
  assert(restrictionProvenance.raw_payload === null
    && restrictionProvenance.source_url === `https://api.github.com/repositories/${restrictionClaim.providerRepositoryId}`
    && (restrictionProvenance.source_metadata as Record<string, unknown>).outcome === "access_restricted"
    && (restrictionProvenance.source_metadata as Record<string, unknown>).visibility_signal === "private_flag",
  "The restriction stores allowlisted provenance and no private response body.");
  const hiddenProjectAfterDemotion = await anonymous.from("projects").select("id").eq("id", valid.projectId);
  const hiddenRepositoryAfterDemotion = await anonymous.from("repositories").select("id").eq("id", valid.repositoryId);
  assert(!hiddenProjectAfterDemotion.error && hiddenProjectAfterDemotion.data.length === 0
    && !hiddenRepositoryAfterDemotion.error && hiddenRepositoryAfterDemotion.data.length === 0,
  "Anonymous RLS immediately hides the demoted project and restricted repository.");
  await fails(service.rpc("admin_publish_project", {
    p_actor: admin.userId,
    p_project_id: valid.projectId,
    p_expected_revision: publishedRevision,
    p_reason: "An old publication form must be invalidated by the system safety revision.",
  }), "40001", "Stale pre-demotion publication form");

  const duplicateRestrictionClaim = await claimPrimaryRepository(
    valid.repositoryId, "repeated-restriction", "repeated-safety-worker", restrictionClaim.candidateId,
  );
  await must(service.rpc("fail_github_repository_enrichment", {
    p_candidate_id: duplicateRestrictionClaim.candidateId,
    p_worker_id: duplicateRestrictionClaim.workerId,
    p_lease_token: duplicateRestrictionClaim.leaseToken,
    p_error_summary: "source_access_restricted",
    p_retryable: false,
    p_failure_provenance: {
      source_url: `https://api.github.com/repositories/${duplicateRestrictionClaim.providerRepositoryId}`,
      fetched_at: new Date().toISOString(),
      http_status: 200,
      error_kind: "visibility_restricted",
      outcome: "access_restricted",
      visibility_signal: "private_flag",
    },
  }), "Record an idempotent repeated restriction");
  await must(service.rpc("finish_github_enrichment_job", {
    p_job_id: duplicateRestrictionClaim.jobId,
    p_status: "partial",
    p_error_summary: "Repeated confirmed restriction was recorded without duplicate safety records.",
  }), "Finish the repeated-restriction enrichment job");
  const repeatedSafetyEvents = await mustPresent(service.from("project_safety_events").select("id").eq("project_id", valid.projectId),
    "Count safety events after repeated restriction");
  const repeatedSafetyReviews = await mustPresent(service.from("review_queue").select("id")
    .eq("repository_id", valid.repositoryId)
    .eq("reason", "GitHub repository access is restricted; review current public source evidence before republishing.")
    .in("status", ["open", "in_review"]), "Count safety review items after repeated restriction");
  assert(repeatedSafetyEvents.length === 1 && repeatedSafetyReviews.length === 1,
    "Repeated restrictions are idempotent for both system audit and blocking review records.");

  const recoveryRequestedAt = new Date(Date.now() + 1000).toISOString();
  await runPublicRecovery(duplicateRestrictionClaim.providerRepositoryId, restrictionClaim.candidateId, recoveryRequestedAt);
  const recoveredRepository = await mustPresent(service.from("repositories").select("availability_status,is_private,visibility,project_id,source_observed_at")
    .eq("id", valid.repositoryId).single(), "Read canonical repository after fresh public recovery");
  assert(recoveredRepository.source_observed_at, "Fresh public enrichment must provide a source observation timestamp.");
  const recoveredAt = recoveredRepository.source_observed_at;
  const stillPendingAfterRecovery = await mustPresent(service.from("projects").select("publication_status,editorial_revision")
    .eq("id", valid.projectId).single(), "Confirm source recovery did not republish the project");
  const reviewAfterRecovery = await mustPresent(service.from("review_queue").select("status")
    .eq("id", safetyReviews[0]!.id).single(), "Confirm the safety review remains unresolved after recovery");
  const hiddenAfterRecovery = await anonymous.from("projects").select("id").eq("id", valid.projectId);
  assert(recoveredRepository.availability_status === "available" && recoveredRepository.is_private === false
    && recoveredRepository.visibility === "public"
    && Date.parse(recoveredAt) > Date.parse(valid.observedAt)
    && Date.parse(recoveredAt) >= Date.now() - 5000,
  "Validated fresh public enrichment can restore canonical repository availability.");
  assert(stillPendingAfterRecovery.publication_status === "pending_review"
    && Number(stillPendingAfterRecovery.editorial_revision) === publishedRevision + 1
    && reviewAfterRecovery.status === "open"
    && !hiddenAfterRecovery.error && hiddenAfterRecovery.data.length === 0,
  "Recovery leaves the project pending and invisible until a deliberate administrator review.");
  await fails(service.rpc("admin_publish_project", {
    p_actor: admin.userId,
    p_project_id: valid.projectId,
    p_expected_revision: Number(stillPendingAfterRecovery.editorial_revision),
    p_reason: "Fresh evidence and blocking review must be completed before publication.",
  }), "23514", "Republishing without renewed current evidence and resolved review");

  const currentCategory = await mustPresent(service.from("categories").select("id").eq("slug", "developer-tools").single(),
    "Read the current active project category");
  const assessmentSources = [] as Array<{ id: string; record_kind: string }>;
  for (const kind of ["repository", "topics", "languages", "releases"] as const) {
    const source = await mustPresent(service.from("source_records").insert({
      provider: "github",
      record_kind: kind,
      source_key: `editorial-safety-current:${valid.projectId}:${kind}:${randomUUID()}`,
      source_url: "https://api.github.com/repos/outlist-fixtures/editorial-project",
      fetched_at: recoveredAt,
      http_status: 200,
      repository_id: valid.repositoryId,
      source_metadata: {
        validated: true,
        api_version: "2022-11-28",
        resource_kind: kind,
        stable_provider_id: duplicateRestrictionClaim.providerRepositoryId,
      },
    }).select("id").single(), `Create current ${kind} evidence for deliberate republication`);
    assessmentSources.push({ id: source.id, record_kind: kind });
  }
  const freshAssessmentId = valid.assessmentId;
  assert(freshAssessmentId, "The published fixture must retain its original assessment identity.");
  const freshAssessmentResult = {
    classification: { status: "classified", primaryCategoryId: currentCategory.id, suggestions: [{ categoryId: currentCategory.id, score: 1, evidence: ["source topic: developer-tools"] }] },
    license: { policyVersion: "outlist-license-evidence-v1", status: "recognized_osi_approved", identifier: "MIT", projectLicenseStatus: "needs_review", evidence: [], explanation: "Fresh public metadata supports renewed human review.", requiresReview: false },
    quality: { policyVersion: "outlist-source-quality-v1", status: "eligible_for_review", priority: "normal", qualityStatus: "needs_review", flags: [] },
  } as Json;
  await must(service.from("repository_assessments").update({
    source_observed_at: recoveredAt,
    status: "assessed",
    assessed_at: new Date().toISOString(),
    result: freshAssessmentResult,
  }).eq("id", freshAssessmentId), "Refresh the existing assessment against recovered public evidence");
  await must(service.from("repository_assessment_sources").delete().eq("assessment_id", freshAssessmentId),
    "Replace the old assessment source links");
  await must(service.from("repository_assessment_sources").insert(assessmentSources.map((source) => ({
    assessment_id: freshAssessmentId,
    source_record_id: source.id,
  }))), "Attach current public source records to the fresh assessment");
  const renewedLicense = await mustPresent(service.rpc("admin_verify_project_license", {
    p_actor: admin.userId,
    p_project_id: valid.projectId,
    p_expected_revision: Number(stillPendingAfterRecovery.editorial_revision),
    p_expected_source_observed_at: recoveredAt,
    p_license_identifier: "MIT",
    p_evidence_reference: "https://opensource.org/license/mit",
    p_reason: "The official license listing was checked again after the repository returned to public access.",
    p_confirm_open_source: true,
  }), "Renew human license verification after public recovery");
  const renewedQuality = await mustPresent(service.rpc("admin_verify_project_quality", {
    p_actor: admin.userId,
    p_project_id: valid.projectId,
    p_expected_revision: Number((renewedLicense as { revision: number }).revision),
    p_expected_source_observed_at: recoveredAt,
    p_reason: "The recovered public repository and current assessment were reviewed for minimum catalog quality.",
    p_confirm_review: true,
  }), "Renew human quality review after public recovery");
  const resolvedSafetyReview = await mustPresent(service.rpc("admin_resolve_project_review_item", {
    p_actor: admin.userId,
    p_project_id: valid.projectId,
    p_queue_id: safetyReviews[0]!.id,
    p_expected_revision: Number((renewedQuality as { revision: number }).revision),
    p_reason: "Fresh public source evidence and renewed review resolve the access restriction follow-up.",
  }), "Resolve the source-safety review after current evidence checks");
  const republished = await mustPresent(service.rpc("admin_publish_project", {
    p_actor: admin.userId,
    p_project_id: valid.projectId,
    p_expected_revision: Number((resolvedSafetyReview as { revision: number }).revision),
    p_reason: "Current public source evidence, renewed human decisions, and resolved review support explicit republication.",
  }), "Explicitly republish after current evidence and human approval");
  assert((republished as { published?: boolean; idempotent?: boolean }).published === true
    && (republished as { idempotent?: boolean }).idempotent === false,
  "Republication requires and records a new explicit administrator publication decision.");
  const publicationHistory = await mustPresent(service.from("editorial_decisions").select("id,action,actor_user_id")
    .eq("project_id", valid.projectId).eq("action", "publish"), "Read publication history after deliberate republication");
  assert(publicationHistory.length === 2 && publicationHistory.every((decision) => decision.actor_user_id === admin.userId),
    "Both human publication decisions remain in the append-only audit trail.");
  const publicAfterDeliberateRepublish = await anonymous.from("projects").select("id,publication_status")
    .eq("id", valid.projectId).single();
  assert(!publicAfterDeliberateRepublish.error && publicAfterDeliberateRepublish.data.publication_status === "published",
    "Public RLS exposes the project again only after deliberate republication.");

  // Race the first explicit publication against a validated source restriction.
  // The published result, if it wins the project lock, must be demoted before
  // the restriction transaction commits; if restriction wins, publication must
  // fail its current repository/review gates.
  const publicationRace = await createFixture({ name: "Publication and source restriction race fixture", queue: false });
  const raceLicense = await mustPresent(service.rpc("admin_verify_project_license", {
    p_actor: admin.userId,
    p_project_id: publicationRace.projectId,
    p_expected_revision: 0,
    p_expected_source_observed_at: publicationRace.observedAt,
    p_license_identifier: "MIT",
    p_evidence_reference: "https://opensource.org/license/mit",
    p_reason: "The official license listing supports this independent human verification.",
    p_confirm_open_source: true,
  }), "Verify race fixture license");
  const raceQuality = await mustPresent(service.rpc("admin_verify_project_quality", {
    p_actor: admin.userId,
    p_project_id: publicationRace.projectId,
    p_expected_revision: Number((raceLicense as { revision: number }).revision),
    p_expected_source_observed_at: publicationRace.observedAt,
    p_reason: "The current public repository and assessment support minimum catalog quality.",
    p_confirm_review: true,
  }), "Verify race fixture quality");
  const raceRevision = Number((raceQuality as { revision: number }).revision);
  const raceClaim = await claimPrimaryRepository(publicationRace.repositoryId, "publication-race", "publication-race-worker");
  const [racePublication, raceRestriction] = await Promise.all([
    service.rpc("admin_publish_project", {
      p_actor: admin.userId,
      p_project_id: publicationRace.projectId,
      p_expected_revision: raceRevision,
      p_reason: "Publish only after current evidence and human decisions pass the publication gate.",
    }),
    service.rpc("fail_github_repository_enrichment", {
      p_candidate_id: raceClaim.candidateId,
      p_worker_id: raceClaim.workerId,
      p_lease_token: raceClaim.leaseToken,
      p_error_summary: "source_access_restricted",
      p_retryable: false,
      p_failure_provenance: {
        source_url: `https://api.github.com/repositories/${raceClaim.providerRepositoryId}`,
        fetched_at: new Date().toISOString(),
        http_status: 200,
        error_kind: "visibility_restricted",
        outcome: "access_restricted",
        visibility_signal: "private_flag",
      },
    }),
  ]);
  assert(!raceRestriction.error, `A fenced restriction must commit through the publication race: ${raceRestriction.error?.message ?? "unknown error"}`);
  assert(!racePublication.error || ["23514", "40001"].includes(racePublication.error.code ?? ""),
    `The administrator publication race must either succeed before demotion or fail a current gate: ${racePublication.error?.code ?? "success"}`);
  await must(service.rpc("finish_github_enrichment_job", {
    p_job_id: raceClaim.jobId,
    p_status: "partial",
    p_error_summary: "Publication race included a confirmed source-access restriction.",
  }), "Finish the publication-race enrichment job");
  const raceProjectFinal = await mustPresent(service.from("projects").select("publication_status")
    .eq("id", publicationRace.projectId).single(), "Read project after conflicting publication and restriction");
  const raceRepositoryFinal = await mustPresent(service.from("repositories").select("availability_status")
    .eq("id", publicationRace.repositoryId).single(), "Read repository after conflicting publication and restriction");
  const raceReviewFinal = await mustPresent(service.from("review_queue").select("id,status")
    .eq("repository_id", publicationRace.repositoryId)
    .eq("reason", "GitHub repository access is restricted; review current public source evidence before republishing.")
    .in("status", ["open", "in_review"]), "Read race review blocker");
  assert(raceProjectFinal.publication_status === "pending_review"
    && raceRepositoryFinal.availability_status === "access_restricted"
    && raceReviewFinal.length === 1,
  "Conflicting administrator publication cannot leave a restricted primary repository publicly listed.");
  const racePublicProject = await anonymous.from("projects").select("id").eq("id", publicationRace.projectId);
  const racePublicRepository = await anonymous.from("repositories").select("id").eq("id", publicationRace.repositoryId);
  assert(!racePublicProject.error && racePublicProject.data.length === 0
    && !racePublicRepository.error && racePublicRepository.data.length === 0,
  "Anonymous RLS hides both race fixture rows after the restriction commits.");

  const restricted = await createFixture({ name: "Restricted repository fixture", restricted: true, queue: false });
  await fails(service.rpc("admin_verify_project_quality", {
    p_actor: admin.userId, p_project_id: restricted.projectId, p_expected_revision: 0,
    p_expected_source_observed_at: restricted.observedAt, p_reason: "The access restriction was checked before deciding quality.", p_confirm_review: true,
  }), "23514", "Quality verification for restricted repository");
  await primePublicationEligibilityAudit(restricted.projectId, admin.userId, restricted.observedAt);
  await fails(service.rpc("admin_publish_project", {
    p_actor: admin.userId, p_project_id: restricted.projectId, p_expected_revision: 0,
    p_reason: "The publisher must recheck current repository access state.",
  }), "23514", "Publication with restricted repository");
  const incomplete = await createFixture({ name: "Incomplete evidence fixture", evidence: false, queue: false });
  await fails(service.rpc("admin_verify_project_quality", {
    p_actor: admin.userId, p_project_id: incomplete.projectId, p_expected_revision: 0,
    p_expected_source_observed_at: incomplete.observedAt, p_reason: "The source evidence is incomplete and cannot support verification.", p_confirm_review: true,
  }), "23514", "Quality verification with incomplete source evidence");
  await primePublicationEligibilityAudit(incomplete.projectId, admin.userId, incomplete.observedAt);
  await fails(service.rpc("admin_publish_project", {
    p_actor: admin.userId, p_project_id: incomplete.projectId, p_expected_revision: 0,
    p_reason: "The publisher must recheck complete current source evidence.",
  }), "23514", "Publication with incomplete source evidence");
  const uncategorized = await createFixture({ name: "Missing category fixture", category: false, queue: false });
  const noCategoryLicense = await must(service.rpc("admin_verify_project_license", {
    p_actor: admin.userId, p_project_id: uncategorized.projectId, p_expected_revision: 0,
    p_expected_source_observed_at: uncategorized.observedAt, p_license_identifier: "MIT",
    p_evidence_reference: "https://opensource.org/license/mit",
    p_reason: "The official project license file and the OSI listing support this identifier.", p_confirm_open_source: true,
  }), "Verify license for uncategorized fixture");
  const noCategoryQuality = await must(service.rpc("admin_verify_project_quality", {
    p_actor: admin.userId, p_project_id: uncategorized.projectId, p_expected_revision: Number((noCategoryLicense as { revision?: number }).revision),
    p_expected_source_observed_at: uncategorized.observedAt,
    p_reason: "The current public repository evidence was reviewed for catalog quality.", p_confirm_review: true,
  }), "Verify quality for uncategorized fixture");
  await fails(service.rpc("admin_publish_project", {
    p_actor: admin.userId, p_project_id: uncategorized.projectId,
    p_expected_revision: Number((noCategoryQuality as { revision?: number }).revision),
    p_reason: "The missing category must block publication.",
  }), "23514", "Publication without an active category");

  const race = await createFixture({ name: "Concurrent administrator fixture", queue: false });
  const concurrent = await Promise.all([
    service.rpc("admin_set_project_review_state", {
      p_actor: admin.userId, p_project_id: race.projectId, p_expected_revision: 0,
      p_action: "keep_pending", p_reason: "Administrator A leaves the project pending for a source follow-up.",
    }),
    service.rpc("admin_set_project_review_state", {
      p_actor: secondAdmin.userId, p_project_id: race.projectId, p_expected_revision: 0,
      p_action: "mark_review_required", p_reason: "Administrator B asks for another review of the assessment.",
    }),
  ]);
  assert(concurrent.filter((result) => !result.error).length === 1, "Exactly one concurrent administrator decision should win.");
  assert(concurrent.filter((result) => result.error?.code === "40001").length === 1, "The stale concurrent decision should fail on revision conflict.");

  const rejected = await createFixture({ name: "Rejected ingestion fixture", queue: false });
  await must(service.rpc("admin_set_project_review_state", {
    p_actor: admin.userId, p_project_id: rejected.projectId, p_expected_revision: 0,
    p_action: "reject", p_reason: "Rejected because the project context cannot be verified.",
  }), "Reject project fixture");
  await must(service.from("repositories").update({ description: "Updated on a later source refresh." }).eq("id", rejected.repositoryId), "Simulate later repository refresh");
  const stillRejected = await must(service.from("projects").select("publication_status").eq("id", rejected.projectId).single(), "Read rejected state after refresh");
  assert(stillRejected, "The rejected project must still exist after refresh.");
  assert(stillRejected.publication_status === "rejected", "A repository refresh must not silently resurrect a rejected project.");

  await must(service.from("admin_users").delete().eq("user_id", revokedAdmin.userId), "Revoke administrator allowlist record");
  await fails(service.rpc("admin_set_project_review_state", {
    p_actor: revokedAdmin.userId, p_project_id: race.projectId, p_expected_revision: 1,
    p_action: "keep_pending", p_reason: "A revoked administrator must no longer change the project.",
  }), "42501", "Administrator revocation");

  const overridesFixture = await createFixture({ name: "Editorial override refresh fixture", queue: false });
  const category = await must(service.from("categories").select("id").eq("slug", "developer-tools").single(), "Read category for editorial override");
  assert(category, "The seeded category must exist for editorial override testing.");
  await must(service.rpc("admin_save_project_editorial", {
    p_actor: admin.userId, p_project_id: overridesFixture.projectId, p_expected_revision: 0,
    p_changes: { name: "Corrected editorial name", summary: "An editorially corrected summary with adequate detail.", description: "Administrator corrected description.", official_website_url: "https://example.org/project" },
    p_category_ids: [category.id], p_tags: ["Editorial fixture"],
    p_reason: "The official project site confirms the correct name and description.",
  }), "Save editorial overrides");
  await must(service.from("projects").update({ name: "Pipeline supplied name", summary: "Pipeline supplied summary that should be replaced." }).eq("id", overridesFixture.projectId), "Simulate source refresh over editorial fields");
  const overridden = await must(service.from("projects").select("name,summary").eq("id", overridesFixture.projectId).single(), "Read preserved editorial values");
  assert(overridden, "The project should be readable after the simulated source refresh.");
  assert(overridden.name === "Corrected editorial name" && overridden.summary === "An editorially corrected summary with adequate detail.", "Editorial overrides must win over later source refreshes.");
  const overrides = await must(service.from("editorial_overrides").select("field_key").eq("project_id", overridesFixture.projectId), "Read persisted override fields");
  assert(overrides, "The override query should return an array.");
  assert(["name", "summary", "description", "official_website_url", "tags"].every((field) => overrides.some((item) => item.field_key === field)), "Supported editorial fields and tags should have persisted overrides.");

  process.stdout.write(`${JSON.stringify({
    event: "editorial_publication_integration_passed",
    local_supabase_auth: true,
    verified_license_requires_independent_human_evidence: true,
    quality_review_requires_explicit_confirmation: true,
    publication_atomic_and_idempotent: true,
    restricted_repository_blocked: true,
    restricted_publication_blocked: true,
    published_primary_source_demoted: true,
    system_safety_audit_and_review_verified: true,
    restricted_project_and_repository_hidden_by_rls: true,
    duplicate_restriction_idempotent: true,
    fresh_public_recovery_did_not_republish: true,
    deliberate_republication_requires_new_human_decision: true,
    publication_race_safe: true,
    incomplete_evidence_blocked: true,
    incomplete_publication_evidence_blocked: true,
    missing_category_blocked: true,
    unresolved_review_blocked: true,
    public_rls_visibility_verified: true,
    anonymous_and_authenticated_rpc_denied: true,
    optimistic_concurrency_verified: true,
    rejection_survives_refresh: true,
    admin_revocation_verified: true,
    editorial_override_persistence_verified: true,
    hosted_supabase: false,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 1000) : "unknown editorial database integration failure";
  process.stderr.write(`${JSON.stringify({ event: "editorial_publication_integration_failed", message })}\n`);
  process.exitCode = 1;
});
