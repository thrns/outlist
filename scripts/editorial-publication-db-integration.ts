import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
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
  const providerId = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 14)}`).toString();
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

async function primePublicationEligibilityAudit(projectId: string, actorUserId: string, observedAt: string) {
  const decisionAt = new Date().toISOString();
  await must(service.from("projects").update({
    license_status: "verified_open_source",
    license_identifier: "MIT",
    license_verified_at: decisionAt,
    quality_status: "verified",
    last_verified_at: decisionAt,
  }).eq("id", projectId), "Prepare publication-gate fixture statuses");
  await must(service.from("editorial_decisions").insert([
    {
      project_id: projectId,
      actor_user_id: actorUserId,
      action: "verify_license",
      previous_state: "unverified",
      resulting_state: "verified_open_source",
      evidence: { license_identifier: "MIT", evidence_reference: "https://opensource.org/license/mit", human_confirmed_open_source: true, source_observed_at: observedAt },
      reason: "Test fixture seeds the earlier license gate to isolate publication evidence checks.",
      resulting_revision: 0,
    },
    {
      project_id: projectId,
      actor_user_id: actorUserId,
      action: "verify_quality",
      previous_state: "unreviewed",
      resulting_state: "verified",
      evidence: { human_reviewed_current_repository: true, not_a_security_or_code_audit: true, source_observed_at: observedAt },
      reason: "Test fixture seeds the earlier quality gate to isolate publication evidence checks.",
      resulting_revision: 0,
    },
  ]), "Seed publication-gate decision fixtures");
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
