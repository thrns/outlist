import { randomInt, randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { runLogoCli, type LogoCliDependencies } from "./logos";
import { createGitHubClient } from "../src/lib/github/client";
import { normalizeLogoImage } from "../src/lib/logos/process";
import { resolveProjectLogo, type LogoCandidate } from "../src/lib/logos/resolve";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";

type Row = Record<string, unknown>;
type DbError = { message: string; code?: string; status?: number; statusCode?: string };
type DbResult = { data: unknown; error: DbError | null };
interface TestQuery extends PromiseLike<DbResult> {
  select(columns: string): TestQuery;
  insert(values: Record<string, unknown>): TestQuery;
  update(values: Record<string, unknown>): TestQuery;
  delete(): TestQuery;
  eq(column: string, value: string | number | boolean): TestQuery;
  in(column: string, values: string[]): TestQuery;
  order(column: string, options?: { ascending?: boolean }): TestQuery;
  limit(count: number): TestQuery;
  single(): Promise<DbResult>;
}
interface TestDb {
  rpc(name: string, args: Record<string, unknown>): Promise<DbResult>;
  from(table: string): TestQuery;
  storage: {
    from(bucket: string): {
      upload(path: string, data: Buffer | Uint8Array, options: { contentType: string; upsert: boolean; cacheControl?: string }): Promise<{ data: unknown; error: DbError | null }>;
      download(path: string): Promise<{ data: Blob | null; error: DbError | null }>;
      remove(paths: string[]): Promise<{ data: unknown; error: DbError | null }>;
      exists(path: string): Promise<{ data: boolean; error: DbError | null }>;
    };
  };
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function rows<T extends Row>(query: PromiseLike<DbResult>, message: string): Promise<T[]> {
  const result = await query;
  assert(!result.error && Array.isArray(result.data), `${message} failed.`);
  return result.data as T[];
}
async function single<T extends Row>(query: PromiseLike<DbResult>, message: string): Promise<T> {
  const result = await query;
  assert(!result.error && result.data && !Array.isArray(result.data), `${message} failed.`);
  return result.data as T;
}
function outputEvents(output: string[]): Row[] { return output.flatMap((line) => line.split("\n").filter(Boolean).map((item) => JSON.parse(item) as Row)); }
async function run(args: string[], dependencies: LogoCliDependencies): Promise<{ status: number; output: Row[]; errors: string[] }> {
  const output: string[] = [];
  const errors: string[] = [];
  const status = await runLogoCli(args, { ...dependencies, writeStdout: (line) => output.push(line), writeStderr: (line) => errors.push(line) });
  return { status, output: outputEvents(output), errors };
}
async function idFromOutput(result: Awaited<ReturnType<typeof run>>, event: string): Promise<string> {
  const row = result.output.find((item) => item.event === event);
  assert(typeof row?.logo_id === "string", `Expected a ${event} event with a logo ID.`);
  return row.logo_id;
}

async function main() {
  assert(url && anonKey, "Local Supabase URL and public key are required.");
  const admin = createSupabaseAdminClient();
  const db = admin as unknown as TestDb;
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) as unknown as TestDb;
  const fixtureId = randomInt(700_000_000, 800_000_000);
  const repositoryNumber = fixtureId;
  const owner = `logo-fixture-${fixtureId}`;
  const repoName = `project-${fixtureId}`;
  const fullName = `${owner}/${repoName}`;
  const project = await single<Row>(db.from("projects").insert({
    slug: `logo-it-${fixtureId}`, name: `  Café ${fixtureId}`, summary: "", description: "M1-05 logo integration fixture.",
    publication_status: "pending_review", quality_status: "unreviewed", license_status: "unverified", featured: false,
  }).select("id,publication_status,quality_status,license_status").single(), "Create logo integration project");
  const projectId = String(project.id);
  const repository = await single<Row>(db.from("repositories").insert({
    project_id: projectId, provider: "github", provider_repository_id: String(repositoryNumber), full_name: fullName,
    canonical_url: `https://github.com/${fullName}`, owner_login: owner, repository_name: repoName,
    is_private: false, visibility: "public", is_disabled: false, availability_status: "available",
    source_observed_at: "2026-11-06T12:00:00.000Z", last_successful_sync_at: "2026-11-06T12:00:00.000Z",
    source_field_states: { visibility: "present", homepage: "null", license: "null" },
  }).select("id,provider_repository_id").single(), "Create public repository fixture");
  const repositoryId = String(repository.id);
  const setPrimary = await db.from("projects").update({ primary_repository_id: repositoryId }).eq("id", projectId);
  assert(!setPrimary.error, "Set logo fixture repository as primary.");

  const restrictedProject = await single<Row>(db.from("projects").insert({
    slug: `logo-restricted-it-${fixtureId}`, name: "Restricted logo fixture", publication_status: "pending_review",
    quality_status: "unreviewed", license_status: "unverified",
  }).select("id").single(), "Create restricted fixture project");
  const restrictedRepositoryId = fixtureId + 1;
  const restrictedRepository = await single<Row>(db.from("repositories").insert({
    project_id: restrictedProject.id, provider: "github", provider_repository_id: String(restrictedRepositoryId),
    full_name: `restricted-${fixtureId}/project-${fixtureId}`, canonical_url: `https://github.com/restricted-${fixtureId}/project-${fixtureId}`,
    availability_status: "access_restricted", is_private: null, visibility: null, is_disabled: null,
  }).select("id").single(), "Create restricted repository fixture");
  const restrictedPrimary = await db.from("projects").update({ primary_repository_id: restrictedRepository.id }).eq("id", String(restrictedProject.id));
  assert(!restrictedPrimary.error, "Set restricted fixture repository as primary.");

  const existingDrafts = await rows<Row>(db.from("projects").select("id,primary_repository_id")
    .in("publication_status", ["draft", "pending_review"]).limit(25), "Load projects for deterministic GitHub response fixtures");
  const repositoryIds = existingDrafts.flatMap((row) => typeof row.primary_repository_id === "string" ? [row.primary_repository_id] : []);
  const repositoryRows = repositoryIds.length
    ? await rows<Row>(db.from("repositories").select("id,provider,provider_repository_id,owner_login,repository_name,full_name,canonical_url,availability_status,is_private,visibility,is_disabled,project_id")
      .in("id", repositoryIds), "Load eligible repository fixtures")
    : [];
  const githubRepositories = new Map(repositoryRows.map((row) => [String(row.provider_repository_id), row]));
  const requestedRepositories: string[] = [];
  const github = createGitHubClient({
    token: null, now: () => Date.parse("2026-11-06T12:00:00.000Z"), maxRetries: 0,
    fetch: (async (input) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      const match = /^\/repositories\/([1-9][0-9]*)$/.exec(requestUrl.pathname);
      if (!match?.[1]) throw new Error("Unexpected fixture GitHub request.");
      const id = match[1];
      requestedRepositories.push(id);
      const row = githubRepositories.get(id);
      if (!row || !Number.isSafeInteger(Number(id))) throw new Error("Unexpected repository ID in logo integration.");
      const storedFullName = String(row.full_name);
      const [storedOwner, storedName] = storedFullName.split("/");
      const login = typeof row.owner_login === "string" ? row.owner_login : storedOwner;
      const name = typeof row.repository_name === "string" ? row.repository_name : storedName;
      const avatarOwnerId = Number(id) + 50;
      const payload = {
        id: Number(id), node_id: `R_${id}`, name, full_name: storedFullName,
        owner: { id: avatarOwnerId, node_id: `O_${avatarOwnerId}`, login, type: "Organization", avatar_url: `https://avatars.githubusercontent.com/u/${avatarOwnerId}?v=4` },
        html_url: String(row.canonical_url), url: `https://api.github.com/repos/${storedFullName}`,
        description: "M1-05 deterministic logo integration fixture", homepage: null, topics: [], language: "TypeScript",
        stargazers_count: 1, forks_count: 0, watchers_count: 1, open_issues_count: 0, archived: false,
        disabled: false, fork: false, private: false, visibility: "public", default_branch: "main",
        created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-11-06T12:00:00.000Z", pushed_at: null, license: null,
      };
      return new Response(JSON.stringify(payload), { status: 200, headers: {
        "content-type": "application/vnd.github+json", etag: `"logo-${id}"`, "x-github-api-version-selected": "2022-11-28",
      } });
    }) as typeof fetch,
  });
  const fixedTime = () => new Date("2026-11-06T12:00:00.000Z");
  const dependencies: LogoCliDependencies = { supabase: db, github, now: fixedTime };

  const dryRun = await run(["--discover", "--dry-run", "--max-projects", "25"], dependencies);
  assert(dryRun.status === 0 && dryRun.output.some((event) => event.event === "logo_discovery_summary" && event.mode === "dry-run"), "Logo discovery must default safely to dry-run.");
  assert((await rows<Row>(db.from("project_logos").select("id").eq("project_id", projectId), "Verify dry-run did not write logo candidates")).length === 0, "Dry-run must not write candidates.");

  const firstRun = await run(["--discover", "--execute", "--max-projects", "25"], dependencies);
  assert(firstRun.status === 0, `Real logo discovery failed: ${firstRun.errors.join("").slice(0, 300)}`);
  const discovered = await rows<Row>(db.from("project_logos").select("id,project_id,repository_id,origin,verification_status,source_url,source_record_id,candidate_key,source_provenance,storage_path")
    .eq("project_id", projectId), "Read discovered logo candidate");
  assert(discovered.length === 1, "Discovery should register exactly one candidate for the public project.");
  const avatarCandidate = discovered[0]!;
  const avatarId = String(avatarCandidate.id);
  assert(avatarCandidate.repository_id === repositoryId && avatarCandidate.origin === "provider_avatar" && avatarCandidate.verification_status === "pending_review", "Candidate must be linked to the correct repository and remain pending.");
  assert(avatarCandidate.storage_path === null && String(avatarCandidate.source_url).startsWith("https://avatars.githubusercontent.com/u/"), "Candidate must keep bytes out of public Storage and retain only a validated GitHub avatar source.");
  assert(!requestedRepositories.includes(String(restrictedRepositoryId)), "Restricted repositories must not be queried for avatars.");
  const source = await single<Row>(db.from("source_records").select("record_kind,source_url,repository_id,source_metadata").eq("id", String(avatarCandidate.source_record_id)).single(), "Read avatar source provenance");
  assert(source.record_kind === "owner_avatar_observation" && source.repository_id === repositoryId, "Source record must link to the correct GitHub repository.");
  const queue = await rows<Row>(db.from("review_queue").select("id,status,project_logo_id").eq("project_logo_id", avatarId), "Read pending logo review queue");
  assert(queue.length === 1 && queue[0]?.status === "open", "A pending candidate must have exactly one open review item linked through its project-logo row.");

  const secondRun = await run(["--discover", "--execute", "--max-projects", "25"], dependencies);
  assert(secondRun.status === 0, `Idempotent logo discovery failed: ${secondRun.errors.join("").slice(0, 300)}`);
  const repeated = await rows<Row>(db.from("project_logos").select("id").eq("project_id", projectId), "Verify duplicate avatar discovery");
  const repeatedQueue = await rows<Row>(db.from("review_queue").select("id").eq("project_logo_id", avatarId), "Verify duplicate review queue handling");
  assert(repeated.length === 1 && repeatedQueue.length === 1, "Repeated discovery must reuse one candidate and one review item.");

  const anonCandidateRead = await anon.from("project_logos").select("id").eq("id", avatarId).limit(1);
  assert(!anonCandidateRead.error && Array.isArray(anonCandidateRead.data) && anonCandidateRead.data.length === 0, "Anonymous clients must not read pending logo metadata.");
  const anonInsert = await anon.from("project_logos").insert({
    project_id: projectId, source_url: "https://avatars.githubusercontent.com/u/1", media_type: "image/webp", origin: "provider_avatar",
  });
  assert(Boolean(anonInsert.error), "Anonymous clients must not write logo metadata.");
  const anonApproval = await anon.rpc("approve_project_logo_candidate", {
    p_logo_id: avatarId, p_approval_token: randomUUID(), p_storage_path: `${projectId}/${avatarId}.webp`, p_content_digest: "a".repeat(64),
    p_media_type: "image/webp", p_approval_provenance: { operator_action: true },
  });
  assert(Boolean(anonApproval.error), "Anonymous clients must not invoke the approval transaction.");

  const fixturePng = await sharp({ create: { width: 80, height: 40, channels: 4, background: "#65349d" } }).png().toBuffer();
  const downloadAvatar = async (sourceUrl: string, ownerId: number | string) => {
    assert(String(sourceUrl).includes(`/u/${ownerId}`), "Approval must use the candidate's validated GitHub owner source.");
    return fixturePng;
  };
  const avatarApproval = await run(["--approve", avatarId, "--avatar-source"], { ...dependencies, downloadAvatar });
  assert(avatarApproval.status === 0, `Avatar approval failed: ${avatarApproval.errors.join("").slice(0, 300)}`);
  const approvedAvatarRow = await single<Row>(db.from("project_logos").select("verification_status,storage_path,content_digest,approval_provenance,is_primary,origin")
    .eq("id", avatarId).single(), "Read approved avatar metadata");
  assert(approvedAvatarRow.verification_status === "approved" && approvedAvatarRow.storage_path === `${projectId}/${avatarId}.webp`
    && typeof approvedAvatarRow.content_digest === "string" && approvedAvatarRow.is_primary === true, "Explicit avatar approval must atomically set verified metadata and primary state.");
  const publicAvatar = await anon.storage.from("project-logos").download(String(approvedAvatarRow.storage_path));
  assert(!publicAvatar.error && publicAvatar.data instanceof Blob && publicAvatar.data.size > 0, "The approved object must be readable from real local public Storage.");
  const repeatedApproval = await run(["--approve", avatarId, "--avatar-source"], { ...dependencies, downloadAvatar });
  assert(repeatedApproval.status === 0 && repeatedApproval.output.some((event) => event.event === "logo_approval_skipped"), "An already-approved candidate must be idempotent.");
  const removedForRecovery = await db.storage.from("project-logos").remove([String(approvedAvatarRow.storage_path)]);
  assert(!removedForRecovery.error, "Remove approved object to verify interrupted-upload reconciliation.");
  const restoredApprovedObject = await run(["--reconcile", avatarId, "--avatar-source"], { ...dependencies, downloadAvatar });
  assert(restoredApprovedObject.status === 0 && restoredApprovedObject.output.some((event) => event.action === "approved_object_restored"), "Reconciliation must restore an approved object from the same reviewed digest.");
  const publicAvatarRestored = await anon.storage.from("project-logos").download(String(approvedAvatarRow.storage_path));
  assert(!publicAvatarRestored.error && publicAvatarRestored.data instanceof Blob, "A reconciled approved object must remain publicly readable.");
  const anonUpload = await anon.storage.from("project-logos").upload(`${projectId}/${randomInt(800_000_000, 900_000_000)}.webp`, fixturePng, { contentType: "image/webp", upsert: false });
  assert(Boolean(anonUpload.error), "Anonymous clients must not upload to the public bucket.");

  const officialRegistration = await run(["--register-official", "--execute", "--project-id", projectId,
    "--source-url", "https://outlist.example/assets/logo.png", "--attribution", "Official project mark supplied for M1-05 integration."], dependencies);
  assert(officialRegistration.status === 0, `Official logo candidate registration failed: ${officialRegistration.errors.join("").slice(0, 300)}`);
  const officialId = await idFromOutput(officialRegistration, "logo_candidate_registered");
  const localFixture = join(tmpdir(), `outlist-logo-${fixtureId}.png`);
  await writeFile(localFixture, fixturePng);
  const officialApproval = await run(["--approve", officialId, "--local-file", localFixture], dependencies);
  assert(officialApproval.status === 0, `Official logo approval failed: ${officialApproval.errors.join("").slice(0, 300)}`);
  const currentLogos = await rows<Row>(db.from("project_logos").select("id,project_id,origin,verification_status,storage_path,media_type,attribution_text,is_primary,verified_at")
    .eq("project_id", projectId), "Read approved project logos");
  const resolution = resolveProjectLogo("Café", projectId, currentLogos.map((row) => ({
    id: String(row.id), projectId: String(row.project_id), origin: row.origin as LogoCandidate["origin"],
    verificationStatus: row.verification_status as LogoCandidate["verificationStatus"], storagePath: row.storage_path as string | null,
    mediaType: row.media_type as LogoCandidate["mediaType"], attributionText: row.attribution_text as string | null,
    isPrimary: Boolean(row.is_primary), verifiedAt: row.verified_at as string | null,
  })));
  assert(resolution.kind === "official_logo" && resolution.logoId === officialId
    && resolution.attributionText === "Official project mark supplied for M1-05 integration.", "Approved official logo and attribution must outrank an approved GitHub owner avatar.");
  const avatarAfterOfficial = currentLogos.find((row) => row.id === avatarId);
  assert(avatarAfterOfficial?.is_primary === false, "An approved avatar must not displace an approved official primary logo.");

  const uploadFailureCandidate = await run(["--register-official", "--execute", "--project-id", projectId,
    "--source-url", "https://outlist.example/assets/upload-failure.png", "--attribution", "Upload failure compensation fixture."], dependencies);
  assert(uploadFailureCandidate.status === 0, "Register upload-failure candidate.");
  const uploadFailureId = await idFromOutput(uploadFailureCandidate, "logo_candidate_registered");
  let injectedUploadAttempted = false;
  const failUploadDb: NonNullable<LogoCliDependencies["supabase"]> = {
    rpc: (name, args) => db.rpc(name, args),
    from: (table) => db.from(table),
    storage: {
      from: (bucket) => {
        const storage = db.storage.from(bucket);
        return {
          upload: async () => {
            injectedUploadAttempted = true;
            return { data: null, error: { message: "Injected Storage upload failure." } };
          },
          remove: (paths) => storage.remove(paths),
          exists: (path) => storage.exists(path),
        };
      },
    },
  };
  const uploadFailure = await run(["--approve", uploadFailureId, "--local-file", localFixture], { ...dependencies, supabase: failUploadDb });
  assert(uploadFailure.status === 1 && injectedUploadAttempted,
    `Failed Storage uploads must not proceed to approval (status=${uploadFailure.status}, attempted=${injectedUploadAttempted}, errors=${uploadFailure.errors.join("").slice(0, 500)}).`);
  const uploadFailureRow = await single<Row>(db.from("project_logos").select("verification_status,storage_path,approval_token")
    .eq("id", uploadFailureId).single(), "Verify failed upload released its claim");
  assert(uploadFailureRow.verification_status === "pending_review" && uploadFailureRow.storage_path === null && uploadFailureRow.approval_token === null,
    `A failed upload must retain pending status and release the approval claim (status=${String(uploadFailureRow.verification_status)}, storage_path=${String(uploadFailureRow.storage_path)}, approval_token=${String(uploadFailureRow.approval_token)}, errors=${uploadFailure.errors.join("").slice(0, 500)}).`);

  const failedCandidate = await run(["--register-official", "--execute", "--project-id", projectId,
    "--source-url", "https://outlist.example/assets/recovery.png", "--attribution", "Failure compensation fixture."], dependencies);
  assert(failedCandidate.status === 0, "Register failure-compensation candidate.");
  const failedLogoId = await idFromOutput(failedCandidate, "logo_candidate_registered");
  const failCommitDb: LogoCliDependencies["supabase"] = {
    rpc: (name, args) => name === "approve_project_logo_candidate"
      ? Promise.resolve({ data: null, error: { message: "Injected commit failure." } }) : db.rpc(name, args),
    from: (table) => db.from(table), storage: db.storage,
  };
  const failedApproval = await run(["--approve", failedLogoId, "--local-file", localFixture], { ...dependencies, supabase: failCommitDb });
  assert(failedApproval.status === 1 && failedApproval.errors.join("").includes("database_commit"), "A failed database commit must be reported as failure.");
  const failedRow = await single<Row>(db.from("project_logos").select("verification_status,storage_path").eq("id", failedLogoId).single(), "Verify failed commit did not approve the logo");
  assert(failedRow.verification_status === "pending_review" && failedRow.storage_path === null, "A failed database commit must not leave a falsely approved row.");
  const compensatedObject = await db.storage.from("project-logos").download(`${projectId}/${failedLogoId}.webp`);
  assert(Boolean(compensatedObject.error), "Failed commit compensation must remove the object from public Storage.");

  const ambiguousCandidate = await run(["--register-official", "--execute", "--project-id", projectId,
    "--source-url", "https://outlist.example/assets/ambiguous-commit.png", "--attribution", "Ambiguous commit recovery fixture."], dependencies);
  assert(ambiguousCandidate.status === 0, "Register ambiguous-commit candidate.");
  const ambiguousLogoId = await idFromOutput(ambiguousCandidate, "logo_candidate_registered");
  const commitThenTimeoutDb: LogoCliDependencies["supabase"] = {
    rpc: async (name, args) => {
      if (name !== "approve_project_logo_candidate") return db.rpc(name, args);
      const committed = await db.rpc(name, args);
      assert(!committed.error, "Commit the approval before simulating a lost database response.");
      return { data: null, error: { message: "Injected response timeout after commit." } };
    },
    from: (table) => db.from(table), storage: db.storage,
  };
  const ambiguousApproval = await run(["--approve", ambiguousLogoId, "--local-file", localFixture], { ...dependencies, supabase: commitThenTimeoutDb });
  assert(ambiguousApproval.status === 0 && ambiguousApproval.output.some((event) => event.event === "logo_approval_recovered"),
    "A lost database response after commit must be recovered without deleting an approved public object.");
  const ambiguousObject = await db.storage.from("project-logos").download(`${projectId}/${ambiguousLogoId}.webp`);
  assert(!ambiguousObject.error && ambiguousObject.data instanceof Blob, "Ambiguous-commit recovery must preserve the approved Storage object.");

  const orphanId = await idFromOutput(failedCandidate, "logo_candidate_registered");
  const orphanNormalized = await normalizeLogoImage(fixturePng);
  const orphanUpload = await db.storage.from("project-logos").upload(`${projectId}/${orphanId}.webp`, orphanNormalized.bytes, { contentType: "image/webp", upsert: true });
  assert(!orphanUpload.error, "Create an interrupted-approval orphan fixture in real Storage.");
  const reconciliation = await run(["--reconcile", orphanId], dependencies);
  assert(reconciliation.status === 0 && reconciliation.output.some((event) => event.event === "logo_reconciliation_complete"), "Pending candidate reconciliation must clean orphaned public objects.");
  const orphanRead = await db.storage.from("project-logos").download(`${projectId}/${orphanId}.webp`);
  assert(Boolean(orphanRead.error), "Reconciliation must remove the pending candidate object.");

  const raceSourceUrl = `https://avatars.githubusercontent.com/u/${repositoryNumber + 50}?v=5`;
  const raceSourceKey = `logo-race-${fixtureId}`;
  const raceObservation = "2026-11-06T12:01:00.000Z";
  const raceProvenance = {
    provider: "github", api_version: "2022-11-28", stable_repository_id: String(repositoryNumber),
    source_api_url: `https://api.github.com/repositories/${repositoryNumber}`, http_status: 200,
    observed_at: raceObservation, owner_id: String(repositoryNumber + 50), owner_login: owner,
    owner_type: "Organization", repository_full_name: fullName,
  };
  const raceSource = await single<Row>(db.from("source_records").insert({
    provider: "github", record_kind: "owner_avatar_observation", source_key: raceSourceKey,
    source_url: `https://api.github.com/repositories/${repositoryNumber}`, fetched_at: raceObservation, http_status: 200,
    repository_id: repositoryId, source_metadata: { ...raceProvenance, avatar_url: raceSourceUrl, fixture: true },
  }).select("id").single(), "Create race candidate source record");
  const raceKey = `github-avatar:${repositoryNumber}:${await digest(raceSourceUrl)}`;
  const raceCandidateRpc = await db.rpc("register_project_logo_candidate", {
    p_project_id: projectId, p_origin: "provider_avatar", p_source_url: raceSourceUrl,
    p_attribution_text: "GitHub owner avatar race fixture; not verified as the official logo.", p_candidate_key: raceKey,
    p_repository_id: repositoryId, p_source_record_id: String(raceSource.id), p_source_observed_at: raceObservation,
    p_source_provenance: raceProvenance,
  });
  assert(!raceCandidateRpc.error && typeof raceCandidateRpc.data === "string", "Register database race candidate.");
  const raceLogoId = String(raceCandidateRpc.data);
  const raceImage = await normalizeLogoImage(fixturePng);
  const racePath = `${projectId}/${raceLogoId}.webp`;
  const raceUpload = await db.storage.from("project-logos").upload(racePath, raceImage.bytes, { contentType: "image/webp", upsert: true });
  assert(!raceUpload.error, "Upload image for approval race fixture.");
  const raceClaim = await db.rpc("claim_project_logo_approval", { p_logo_id: raceLogoId });
  assert(!raceClaim.error && raceClaim.data && typeof raceClaim.data === "object"
    && "approval_token" in raceClaim.data && typeof raceClaim.data.approval_token === "string", "Claim approval candidate before concurrent finalization.");
  const raceArguments = {
    p_logo_id: raceLogoId, p_approval_token: raceClaim.data.approval_token,
    p_storage_path: racePath, p_content_digest: raceImage.contentDigest,
    p_media_type: "image/webp", p_approval_provenance: { operator_action: true, fixture: "concurrent-approval" },
  };
  const raceResults = await Promise.all([
    db.rpc("approve_project_logo_candidate", raceArguments),
    db.rpc("approve_project_logo_candidate", raceArguments),
  ]);
  assert(raceResults.every((result) => !result.error), "Concurrent approval requests must serialize safely.");
  const raceResultStatuses = raceResults.map((result) => (result.data as Row).status).sort();
  assert(raceResultStatuses.join(",") === "already_approved,approved", "Approval race must report one commit and one idempotent result.");
  const finalAvatar = await single<Row>(db.from("project_logos").select("is_primary,verification_status").eq("id", raceLogoId).single(), "Verify race result");
  assert(finalAvatar.verification_status === "approved" && finalAvatar.is_primary === false, "Concurrent avatar approval must preserve the official primary logo.");

  const rejectCandidate = await run(["--register-official", "--execute", "--project-id", projectId,
    "--source-url", "https://outlist.example/assets/rejected.png", "--attribution", "Rejected candidate fixture."], dependencies);
  assert(rejectCandidate.status === 0, "Register rejection fixture candidate.");
  const rejectedLogoId = await idFromOutput(rejectCandidate, "logo_candidate_registered");
  const rejectResult = await run(["--reject", rejectedLogoId, "--execute"], dependencies);
  assert(rejectResult.status === 0, "Explicit rejection should succeed.");
  const rejectedRow = await single<Row>(db.from("project_logos").select("verification_status,storage_path,is_primary")
    .eq("id", rejectedLogoId).single(), "Read rejected logo metadata");
  const rejectedQueue = await rows<Row>(db.from("review_queue").select("status").eq("project_logo_id", rejectedLogoId), "Read rejected logo review item");
  assert(rejectedRow.verification_status === "rejected" && rejectedRow.storage_path === null && rejectedRow.is_primary === false
    && rejectedQueue[0]?.status === "dismissed", "Rejected candidates must clear public paths and resolve their review item.");
  const repeatedRejectedRegistration = await run(["--register-official", "--execute", "--project-id", projectId,
    "--source-url", "https://outlist.example/assets/rejected.png", "--attribution", "Rejected candidate fixture."], dependencies);
  const repeatedRejectedId = await idFromOutput(repeatedRejectedRegistration, "logo_candidate_registered");
  const rejectedQueueAfterRediscovery = await rows<Row>(db.from("review_queue").select("id,status").eq("project_logo_id", rejectedLogoId), "Verify rejected review item stays closed");
  assert(repeatedRejectedRegistration.status === 0 && repeatedRejectedId === rejectedLogoId && rejectedQueueAfterRediscovery.length === 1
    && rejectedQueueAfterRediscovery[0]?.status === "dismissed", "Repeated discovery must not reopen a rejected candidate's review item.");

  const revokeResult = await run(["--revoke", avatarId, "--execute"], dependencies);
  assert(revokeResult.status === 0, "Explicit revocation should succeed.");
  const revokedRow = await single<Row>(db.from("project_logos").select("verification_status,storage_path,is_primary")
    .eq("id", avatarId).single(), "Read revoked logo metadata");
  const revokedObject = await anon.storage.from("project-logos").download(`${projectId}/${avatarId}.webp`);
  assert(revokedRow.verification_status === "revoked" && revokedRow.storage_path === null && revokedRow.is_primary === false
    && Boolean(revokedObject.error), "Revocation must make the logo unresolvable and remove its public object.");

  const unchangedProject = await single<Row>(db.from("projects").select("publication_status,quality_status,license_status,featured,published_at")
    .eq("id", projectId).single(), "Verify editorial and publication state");
  assert(unchangedProject.publication_status === "pending_review" && unchangedProject.quality_status === "unreviewed"
    && unchangedProject.license_status === "unverified" && unchangedProject.featured === false && unchangedProject.published_at === null,
  "Logo discovery and approval must not change publication, editorial, quality, or license state.");
  await rm(localFixture, { force: true });
  process.stdout.write(`${JSON.stringify({ event: "logo_database_integration_passed", fixture_project_id: projectId, avatar_discovery: true, deduplication: true, review_queue: true, approval: true, official_priority: true, public_storage: true, anonymous_write_block: true, compensation: true, reconciliation: true, approval_race: true, restricted_repository_excluded: true, editorial_state_unchanged: true })}\n`);
}

async function digest(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: "logo_database_integration_failed", message: error instanceof Error ? error.message : "unknown" })}\n`);
  process.exitCode = 1;
});
