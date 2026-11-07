import { createHash } from "node:crypto";
import { z } from "zod";
import { createGitHubClient } from "../src/lib/github/client";
import { validateGitHubAvatarUrl } from "../src/lib/logos/github-avatar";
import { downloadGitHubAvatar, normalizeLogoImage, readOperatorLogoFile } from "../src/lib/logos/process";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";

const USAGE = `Usage:
  bun run logos -- --discover [--dry-run | --execute] [--max-projects 10]
  bun run logos -- --register-official --execute --project-id <uuid> --source-url <https-url> --attribution <text>
  bun run logos -- --approve <logo-id> --avatar-source
  bun run logos -- --approve <logo-id> --local-file <path>
  bun run logos -- --reject <logo-id> --execute
  bun run logos -- --revoke <logo-id> --execute
  bun run logos -- --reconcile <logo-id> [--avatar-source | --local-file <path>]

Discovery is dry-run by default. Candidate approval and local-file registration always require explicit operator flags.`;
const MAX_PROJECTS = 25;
const UUID = z.string().uuid();
const projectSchema = z.object({ id: UUID, name: z.string(), publication_status: z.string(), primary_repository_id: UUID.nullable() });
const repositorySchema = z.object({
  id: UUID, provider: z.string(), provider_repository_id: z.string(), owner_login: z.string().nullable(), full_name: z.string(),
  canonical_url: z.string(), availability_status: z.string(), is_private: z.boolean().nullable(), visibility: z.string().nullable(),
  is_disabled: z.boolean().nullable(), project_id: UUID.nullable(),
});
const candidateSchema = z.object({
  id: UUID, project_id: UUID, repository_id: UUID.nullable(), source_url: z.string(), origin: z.enum(["provider_avatar", "official_site", "editorial", "submitted"]),
  verification_status: z.enum(["pending_review", "approved", "rejected", "revoked"]), attribution_text: z.string().nullable(),
  source_provenance: z.record(z.string(), z.unknown()), content_digest: z.string().nullable(), storage_path: z.string().nullable(),
});

type DbError = { message: string; code?: string; status?: number; statusCode?: string };
type DbResult = { data: unknown; error: DbError | null };
interface Query extends PromiseLike<DbResult> {
  select(columns: string): Query;
  insert(values: Record<string, unknown>): Query;
  eq(column: string, value: string | number | boolean): Query;
  in(column: string, values: string[]): Query;
  order(column: string, options?: { ascending?: boolean }): Query;
  limit(count: number): Query;
  single(): Promise<DbResult>;
}
interface LogoDatabase {
  rpc(name: string, args: Record<string, unknown>): Promise<DbResult>;
  from(table: string): Query;
  storage: {
    from(bucket: string): {
      upload(path: string, data: Buffer, options: { contentType: string; upsert: boolean; cacheControl: string }): Promise<{ data: unknown; error: DbError | null }>;
      remove(paths: string[]): Promise<{ data: unknown; error: DbError | null }>;
      exists(path: string): Promise<{ data: boolean; error: DbError | null }>;
    };
  };
}
export interface LogoCliDependencies {
  supabase?: LogoDatabase;
  github?: Pick<ReturnType<typeof createGitHubClient>, "getRepositoryById">;
  downloadAvatar?: (sourceUrl: string, ownerId: number | string) => Promise<Buffer>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  now?: () => Date;
}
export interface LogoArguments {
  action: "discover" | "register_official" | "approve" | "reject" | "revoke" | "reconcile" | "help";
  execute: boolean;
  maxProjects: number;
  logoId?: string;
  projectId?: string;
  sourceUrl?: string;
  attribution?: string;
  localFile?: string;
  avatarSource: boolean;
}

export function parseLogoArguments(args: string[]): LogoArguments {
  let action: LogoArguments["action"] | undefined;
  let execute = false;
  let dryRunFlag = false;
  let maxProjects = 10;
  let logoId: string | undefined;
  let projectId: string | undefined;
  let sourceUrl: string | undefined;
  let attribution: string | undefined;
  let localFile: string | undefined;
  let avatarSource = false;
  const setAction = (next: LogoArguments["action"]) => {
    if (action) throw new TypeError("Choose exactly one logo operation.");
    action = next;
  };
  const optionValue = (index: number, option: string) => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value.`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") setAction("help");
    else if (arg === "--discover") setAction("discover");
    else if (arg === "--register-official") setAction("register_official");
    else if (arg === "--approve") { setAction("approve"); logoId = optionValue(index++, arg); }
    else if (arg === "--reject") { setAction("reject"); logoId = optionValue(index++, arg); }
    else if (arg === "--revoke") { setAction("revoke"); logoId = optionValue(index++, arg); }
    else if (arg === "--reconcile") { setAction("reconcile"); logoId = optionValue(index++, arg); }
    else if (arg === "--execute") execute = true;
    else if (arg === "--dry-run") dryRunFlag = true;
    else if (arg === "--max-projects") {
      const raw = optionValue(index++, arg);
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_PROJECTS) throw new TypeError(`--max-projects must be from 1 to ${MAX_PROJECTS}.`);
      maxProjects = Number(raw);
    } else if (arg === "--project-id") projectId = optionValue(index++, arg);
    else if (arg === "--source-url") sourceUrl = optionValue(index++, arg);
    else if (arg === "--attribution") attribution = optionValue(index++, arg);
    else if (arg === "--local-file") localFile = optionValue(index++, arg);
    else if (arg === "--avatar-source") avatarSource = true;
    else throw new TypeError("Unknown logo operation option.");
  }
  if (!action) throw new TypeError("Choose a logo operation.");
  if (dryRunFlag && action !== "discover") throw new TypeError("--dry-run is only valid with --discover.");
  if (dryRunFlag && execute) throw new TypeError("Choose either --dry-run or --execute.");
  if (execute && action !== "discover" && action !== "register_official" && action !== "reject" && action !== "revoke") {
    throw new TypeError("--execute is supported only for discovery, candidate registration, or review status changes.");
  }
  if (action === "discover" && (projectId || sourceUrl || attribution || logoId || localFile || avatarSource)) throw new TypeError("Discovery accepts only --execute and --max-projects.");
  if (action === "register_official" && (!execute || !projectId || !sourceUrl || !attribution || logoId || localFile || avatarSource)) throw new TypeError("Official candidate registration requires --execute, --project-id, --source-url, and --attribution.");
  if (["approve", "reject", "revoke", "reconcile"].includes(action) && (!logoId || projectId || sourceUrl || attribution)) throw new TypeError("Logo candidate operations require one logo ID.");
  if (action === "approve" && !(avatarSource !== Boolean(localFile))) throw new TypeError("Approval requires exactly one of --avatar-source or --local-file.");
  if (["reject", "revoke"].includes(action) && (avatarSource || localFile || !execute)) throw new TypeError("Review status changes require --execute and no source option.");
  if (action === "reconcile" && execute) throw new TypeError("Reconciliation is an explicit operation and does not take --execute.");
  if (action === "reconcile" && avatarSource && localFile) throw new TypeError("Choose only one reconciliation source.");
  if (action !== "discover" && action !== "register_official" && action !== "approve" && action !== "reject" && action !== "revoke" && action !== "reconcile" && action !== "help") {
    throw new TypeError("Unknown logo operation.");
  }
  if (logoId && !UUID.safeParse(logoId).success) throw new TypeError("Logo ID must be a UUID.");
  if (projectId && !UUID.safeParse(projectId).success) throw new TypeError("Project ID must be a UUID.");
  return { action, execute, maxProjects, logoId, projectId, sourceUrl, attribution, localFile, avatarSource };
}

export async function runLogoCli(args: string[], dependencies: LogoCliDependencies = {}): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((line: string) => process.stdout.write(line));
  const stderr = dependencies.writeStderr ?? ((line: string) => process.stderr.write(line));
  let parsed: LogoArguments;
  try { parsed = parseLogoArguments(args); }
  catch {
    stderr(`${JSON.stringify({ event: "failure", stage: "arguments", message: "Invalid logo operation arguments." })}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.action === "help") { stdout(`${USAGE}\n`); return 0; }
  let db: LogoDatabase;
  try { db = dependencies.supabase ?? createSupabaseAdminClient() as unknown as LogoDatabase; }
  catch { stderr(`${JSON.stringify({ event: "failure", stage: "database_configuration", message: "Server-only Supabase configuration is unavailable." })}\n`); return 1; }

  try {
    if (parsed.action === "discover") return await discover(parsed, db, dependencies, stdout, stderr);
    if (parsed.action === "register_official") return await registerOfficial(parsed, db, dependencies, stdout);
    if (parsed.action === "approve") return await approve(parsed, db, dependencies, stdout, stderr);
    if (parsed.action === "reject" || parsed.action === "revoke") return await setReviewStatus(parsed, db, stdout, stderr);
    if (parsed.action === "reconcile") return await reconcile(parsed, db, dependencies, stdout);
  } catch (error) {
    stderr(`${JSON.stringify({ event: "failure", stage: "operation", message: safeMessage(error) })}\n`);
    return 1;
  }
  return 2;
}

async function discover(args: LogoArguments, db: LogoDatabase, dependencies: LogoCliDependencies, stdout: (line: string) => void, stderr: (line: string) => void): Promise<number> {
  const projectsResult = await db.from("projects").select("id,name,publication_status,primary_repository_id")
    .in("publication_status", ["draft", "pending_review"]).order("created_at", { ascending: true }).limit(args.maxProjects);
  if (projectsResult.error || !Array.isArray(projectsResult.data)) throw new Error("Could not load bounded draft projects.");
  const projects = projectsResult.data.map((row) => projectSchema.parse(row));
  const priorLogos = projects.length
    ? await db.from("project_logos").select("project_id,origin,verification_status").in("project_id", projects.map((project) => project.id))
    : { data: [], error: null };
  if (priorLogos.error || !Array.isArray(priorLogos.data)) throw new Error("Could not inspect current project logo states.");
  const priorByProject = new Map<string, Array<{ origin: string; verification_status: string }>>();
  for (const row of priorLogos.data) {
    if (!row || typeof row !== "object" || !("project_id" in row) || typeof row.project_id !== "string") continue;
    const list = priorByProject.get(row.project_id) ?? [];
    list.push({
      origin: "origin" in row && typeof row.origin === "string" ? row.origin : "",
      verification_status: "verification_status" in row && typeof row.verification_status === "string" ? row.verification_status : "",
    });
    priorByProject.set(row.project_id, list);
  }
  const github = dependencies.github ?? createGitHubClient();
  let discovered = 0;
  let pending = 0;
  let skipped = 0;
  let failures = 0;
  for (const project of projects) {
    if ((priorByProject.get(project.id) ?? []).some((logo) => logo.verification_status === "approved" && logo.origin !== "provider_avatar")) { skipped += 1; continue; }
    if (!project.primary_repository_id) { skipped += 1; continue; }
    const repositoryResult = await db.from("repositories").select("id,provider,provider_repository_id,owner_login,full_name,canonical_url,availability_status,is_private,visibility,is_disabled,project_id")
      .eq("id", project.primary_repository_id).limit(1);
    if (repositoryResult.error || !Array.isArray(repositoryResult.data)) { failures += 1; continue; }
    const rawRepository = repositoryResult.data[0];
    if (!rawRepository) { skipped += 1; continue; }
    const repository = repositorySchema.parse(rawRepository);
    if (!isEligibleRepository(repository, project.id)) { skipped += 1; continue; }
    try {
      const response = await github.getRepositoryById(Number(repository.provider_repository_id));
      if (response.kind !== "ok") { skipped += 1; continue; }
      const sourceRepository = response.data;
      if (sourceRepository.id !== Number(repository.provider_repository_id) || sourceRepository.isPrivate || sourceRepository.isDisabled
        || sourceRepository.visibility.state !== "present" || sourceRepository.visibility.value.toLowerCase() !== "public") {
        skipped += 1; continue;
      }
      const [apiOwner, apiName, extraPath] = sourceRepository.fullName.split("/");
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(sourceRepository.owner.login)
        || apiOwner?.toLowerCase() !== sourceRepository.owner.login.toLowerCase()
        || !apiName || extraPath !== undefined || !/^[A-Za-z0-9_.-]{1,100}$/.test(apiName) || [".", ".."].includes(apiName)
        || sourceRepository.canonicalUrl.toLowerCase() !== `https://github.com/${sourceRepository.fullName}`.toLowerCase()) {
        skipped += 1; continue;
      }
      const avatarUrl = sourceRepository.owner.avatarUrl;
      if (!avatarUrl) { skipped += 1; continue; }
      const sourceUrl = validateGitHubAvatarUrl(avatarUrl, sourceRepository.owner.id);
      const sourceObservedAt = response.provenance.fetchedAt;
      const urlDigest = digestText(sourceUrl);
      const candidateKey = `github-avatar:${repository.provider_repository_id}:${urlDigest}`;
      const provenance = {
        provider: "github", api_version: response.provenance.apiVersion,
        stable_repository_id: String(sourceRepository.id), source_api_url: response.provenance.sourceApiUrl,
        http_status: response.provenance.httpStatus, observed_at: sourceObservedAt,
        owner_id: String(sourceRepository.owner.id), owner_login: sourceRepository.owner.login,
        owner_type: sourceRepository.owner.type ?? null, repository_full_name: sourceRepository.fullName,
      };
      if (!args.execute) {
        stdout(`${JSON.stringify({ event: "logo_candidate_preview", mode: "dry-run", project_id: project.id, repository_id: repository.id, provider_repository_id: repository.provider_repository_id, candidate_key: candidateKey, origin: "provider_avatar", status: "would_register_pending_review" })}\n`);
        discovered += 1;
        continue;
      }
      const sourceRecordId = await storeSourceRecord(db, {
        provider: "github", record_kind: "owner_avatar_observation", source_key: `github:repository:${repository.provider_repository_id}:owner-avatar:${urlDigest}`,
        source_url: response.provenance.sourceApiUrl, fetched_at: sourceObservedAt, http_status: 200,
        reuse_context: "GitHub repository API owner avatar observed; no image bytes fetched.", repository_id: repository.id,
        source_metadata: { ...provenance, avatar_url: sourceUrl },
      });
      const registration = await db.rpc("register_project_logo_candidate", {
        p_project_id: project.id, p_origin: "provider_avatar", p_source_url: sourceUrl,
        p_attribution_text: `GitHub owner avatar for ${sourceRepository.owner.login}; not verified as the project's official logo.`,
        p_candidate_key: candidateKey, p_repository_id: repository.id,
        p_source_record_id: sourceRecordId, p_source_observed_at: sourceObservedAt,
        p_source_provenance: provenance,
      });
      if (registration.error) throw new Error("Candidate registration failed.");
      pending += 1;
      discovered += 1;
      stdout(`${JSON.stringify({ event: "logo_candidate_registered", project_id: project.id, repository_id: repository.id, logo_id: registration.data, origin: "provider_avatar", verification_status: "pending_review" })}\n`);
    } catch (error) {
      failures += 1;
      stderr(`${JSON.stringify({ event: "logo_discovery_failed", project_id: project.id, repository_id: repository.id, reason: safeMessage(error) })}\n`);
    }
  }
  const finalLogos = projects.length
    ? await db.from("project_logos").select("project_id,origin,verification_status").in("project_id", projects.map((project) => project.id))
    : { data: [], error: null };
  if (finalLogos.error || !Array.isArray(finalLogos.data)) throw new Error("Could not summarize project logo states.");
  const finalByProject = new Map<string, Array<{ origin: string; verification_status: string }>>();
  for (const row of finalLogos.data) {
    if (!row || typeof row !== "object" || !("project_id" in row) || typeof row.project_id !== "string") continue;
    const list = finalByProject.get(row.project_id) ?? [];
    list.push({
      origin: "origin" in row && typeof row.origin === "string" ? row.origin : "",
      verification_status: "verification_status" in row && typeof row.verification_status === "string" ? row.verification_status : "",
    });
    finalByProject.set(row.project_id, list);
  }
  const states = projects.map((project) => finalByProject.get(project.id) ?? []);
  const logoResolutionCounts = {
    approved: states.filter((items) => items.some((item) => item.verification_status === "approved")).length,
    fallback_only: states.filter((items) => !items.some((item) => item.verification_status === "approved")).length,
  };
  const candidateStatusCounts = {
    pending_review: finalLogos.data.filter((row) => row && typeof row === "object" && "verification_status" in row && row.verification_status === "pending_review").length,
    approved: finalLogos.data.filter((row) => row && typeof row === "object" && "verification_status" in row && row.verification_status === "approved").length,
    rejected: finalLogos.data.filter((row) => row && typeof row === "object" && "verification_status" in row && row.verification_status === "rejected").length,
    revoked: finalLogos.data.filter((row) => row && typeof row === "object" && "verification_status" in row && row.verification_status === "revoked").length,
  };
  stdout(`${JSON.stringify({ event: "logo_discovery_summary", mode: args.execute ? "execute" : "dry-run", projects_examined: projects.length, candidates_observed: discovered, registration_attempts: pending, project_logo_resolution: logoResolutionCounts, candidate_statuses: candidateStatusCounts, skipped, failures })}\n`);
  return failures ? 1 : 0;
}

async function registerOfficial(args: LogoArguments, db: LogoDatabase, dependencies: LogoCliDependencies, stdout: (line: string) => void): Promise<number> {
  const projectId = args.projectId!;
  const url = validateTrustedSourceUrl(args.sourceUrl!);
  const attribution = args.attribution!.trim();
  if (!attribution || attribution.length > 500) throw new Error("Attribution text must contain 1–500 characters.");
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const candidateKey = `operator-official:${digestText(`${url}\n${attribution}`)}`;
  const projectResult = await db.from("projects").select("id,publication_status").eq("id", projectId).limit(1);
  if (projectResult.error || !Array.isArray(projectResult.data) || !projectResult.data[0]) throw new Error("Project was not found.");
  const project = projectResult.data[0] as { id: string; publication_status: string };
  if (["rejected", "archived"].includes(project.publication_status)) throw new Error("Project is not eligible for a logo candidate.");
  const sourceRecordId = await storeSourceRecord(db, {
    provider: "other", record_kind: "operator_logo_candidate", source_key: candidateKey,
    source_url: url, fetched_at: now, http_status: null, reuse_context: "Operator-supplied official logo source; no network request made.",
    source_metadata: { provider: "operator", operator_action: true, observed_at: now, attribution },
  });
  const registration = await db.rpc("register_project_logo_candidate", {
    p_project_id: projectId, p_origin: "official_site", p_source_url: url, p_attribution_text: attribution,
    p_candidate_key: candidateKey, p_repository_id: null, p_source_record_id: sourceRecordId,
    p_source_observed_at: now, p_source_provenance: { provider: "operator", operator_action: true, observed_at: now },
  });
  if (registration.error) throw new Error("Official candidate registration failed.");
  stdout(`${JSON.stringify({ event: "logo_candidate_registered", project_id: projectId, logo_id: registration.data, origin: "official_site", verification_status: "pending_review" })}\n`);
  return 0;
}

async function approve(args: LogoArguments, db: LogoDatabase, dependencies: LogoCliDependencies, stdout: (line: string) => void, stderr: (line: string) => void): Promise<number> {
  const candidate = await loadCandidate(db, args.logoId!);
  const claimed = await db.rpc("claim_project_logo_approval", { p_logo_id: candidate.id });
  if (claimed.error || !claimed.data || typeof claimed.data !== "object") throw new Error("Could not claim this logo candidate for approval.");
  const claimData = claimed.data as Record<string, unknown>;
  if (claimData.status === "already_approved") {
    stdout(`${JSON.stringify({ event: "logo_approval_skipped", logo_id: candidate.id, status: "already_approved" })}\n`);
    return 0;
  }
  if (claimData.status !== "claimed" || typeof claimData.approval_token !== "string") throw new Error("Database returned an invalid approval claim.");
  const approvalToken = claimData.approval_token;
  const path = `${candidate.project_id}/${candidate.id}.webp`;
  let stage = "source_acquisition";
  let uploadAttempted = false;
  try {
    const input = await readApprovalInput(candidate, args, dependencies);
    stage = "image_validation";
    const normalized = await normalizeLogoImage(input.bytes);
    stage = "storage_upload";
    uploadAttempted = true;
    const upload = await db.storage.from("project-logos").upload(path, normalized.bytes, { contentType: "image/webp", upsert: true, cacheControl: "31536000" });
    if (upload.error) throw new Error("Storage upload failed.");
    const provenance = {
      operator_action: true, source_mode: input.mode, processor: "sharp-webp-v1",
      input_format: normalized.inputFormat, normalized_width: normalized.width, normalized_height: normalized.height,
      output_digest: normalized.contentDigest, output_bytes: normalized.bytes.byteLength,
    };
    stage = "database_commit";
    const commit = await db.rpc("approve_project_logo_candidate", {
      p_logo_id: candidate.id, p_approval_token: approvalToken, p_storage_path: path, p_content_digest: normalized.contentDigest,
      p_media_type: "image/webp", p_approval_provenance: provenance,
    });
    if (commit.error) throw new Error("Database commit failed.");
    stdout(`${JSON.stringify({ event: "logo_approved", logo_id: candidate.id, project_id: candidate.project_id, origin: candidate.origin, status: "approved", content_digest: normalized.contentDigest })}\n`);
    return 0;
  } catch {
    if (uploadAttempted) {
      const cleanupClaim = await Promise.resolve(db.rpc("claim_project_logo_cleanup", { p_logo_id: candidate.id, p_approval_token: approvalToken }))
        .catch(() => ({ data: null, error: { message: "Cleanup claim failed." } }));
      const cleanupData = cleanupClaim.data && typeof cleanupClaim.data === "object" ? cleanupClaim.data as Record<string, unknown> : null;
      if (cleanupData?.status === "already_approved" && cleanupData.storage_path === path) {
        stdout(`${JSON.stringify({ event: "logo_approval_recovered", logo_id: candidate.id, status: "approved" })}\n`);
        return 0;
      }
      if (cleanupData?.status === "cleanup_claimed" && typeof cleanupData.approval_token === "string") {
        const removed = await removeObjectOrConfirmAbsent(db, path);
        if (removed) {
          const release = await Promise.resolve(db.rpc("release_project_logo_approval", {
            p_logo_id: candidate.id, p_approval_token: cleanupData.approval_token,
          })).catch(() => ({ data: null, error: { message: "Cleanup claim release failed." } }));
          const released = release.data && typeof release.data === "object" && "status" in release.data
            && release.data.status === "claim_released";
          stderr(`${JSON.stringify({ event: "logo_approval_failed", stage, logo_id: candidate.id, cleanup: "completed", claim_released: released })}\n`);
          return 1;
        }
        stderr(`${JSON.stringify({ event: "logo_approval_failed", stage, logo_id: candidate.id, cleanup: "reconcile_required", claim_released: false })}\n`);
        return 1;
      }
      stderr(`${JSON.stringify({ event: "logo_approval_failed", stage, logo_id: candidate.id, cleanup: "claim_conflict_reconcile_required", claim_released: false })}\n`);
      return 1;
    }
    const release = await Promise.resolve(db.rpc("release_project_logo_approval", { p_logo_id: candidate.id, p_approval_token: approvalToken }))
      .catch(() => ({ data: null, error: { message: "Approval claim release failed." } }));
    const releaseStatus = release.data && typeof release.data === "object" && "status" in release.data ? release.data.status : null;
    stderr(`${JSON.stringify({ event: "logo_approval_failed", stage, logo_id: candidate.id, cleanup: "not_needed", claim_released: releaseStatus === "claim_released" })}\n`);
    return 1;
  }
}

async function setReviewStatus(args: LogoArguments, db: LogoDatabase, stdout: (line: string) => void, stderr: (line: string) => void): Promise<number> {
  const candidate = await loadCandidate(db, args.logoId!);
  const status = args.action === "reject" ? "rejected" : "revoked";
  const result = await db.rpc("set_project_logo_review_status", { p_logo_id: candidate.id, p_status: status });
  if (result.error) throw new Error("Logo review status update failed.");
  const oldPath = typeof result.data === "object" && result.data !== null && "storage_path" in result.data && typeof result.data.storage_path === "string"
    ? result.data.storage_path : null;
  const cleanupPath = oldPath ?? `${candidate.project_id}/${candidate.id}.webp`;
  const cleanup = await removeObject(db, cleanupPath);
  if (cleanup) {
    stderr(`${JSON.stringify({ event: "logo_status_saved_cleanup_failed", logo_id: candidate.id, status, reconcile_required: true })}\n`);
    return 1;
  }
  stdout(`${JSON.stringify({ event: "logo_review_status_updated", logo_id: candidate.id, status })}\n`);
  return 0;
}

async function reconcile(args: LogoArguments, db: LogoDatabase, dependencies: LogoCliDependencies, stdout: (line: string) => void): Promise<number> {
  let candidate = await loadCandidate(db, args.logoId!);
  const path = `${candidate.project_id}/${candidate.id}.webp`;
  if (candidate.verification_status === "pending_review") {
    const claimed = await db.rpc("claim_project_logo_approval", { p_logo_id: candidate.id });
    if (claimed.error || !claimed.data || typeof claimed.data !== "object") throw new Error("Could not claim the pending logo candidate for cleanup.");
    const claimData = claimed.data as Record<string, unknown>;
    if (claimData.status === "already_approved") {
      candidate = await loadCandidate(db, candidate.id);
    } else if (claimData.status === "claimed" && typeof claimData.approval_token === "string") {
      const cleanup = await removeObject(db, path);
      if (cleanup) throw new Error("Could not remove an orphaned public Storage object; retry reconciliation.");
      const released = await db.rpc("release_project_logo_approval", { p_logo_id: candidate.id, p_approval_token: claimData.approval_token });
      const releaseData = released.data && typeof released.data === "object" ? released.data as Record<string, unknown> : null;
      if (released.error || releaseData?.status !== "claim_released") {
        throw new Error("The orphaned object was removed, but the cleanup claim was not released; retry reconciliation.");
      }
      stdout(`${JSON.stringify({ event: "logo_reconciliation_complete", logo_id: candidate.id, status: "pending_review", action: "orphan_removed_or_absent" })}\n`);
      return 0;
    } else {
      throw new Error("Database returned an invalid reconciliation claim.");
    }
  }
  if (candidate.verification_status === "rejected" || candidate.verification_status === "revoked") {
    const cleanup = await removeObject(db, path);
    if (cleanup) throw new Error("Could not remove an orphaned public Storage object; retry reconciliation.");
    stdout(`${JSON.stringify({ event: "logo_reconciliation_complete", logo_id: candidate.id, status: candidate.verification_status, action: "orphan_removed_or_absent" })}\n`);
    return 0;
  }
  const input = await readApprovalInput(candidate, args, dependencies);
  const normalized = await normalizeLogoImage(input.bytes);
  if (normalized.contentDigest !== candidate.content_digest) throw new Error("Current source does not reproduce the approved content digest; manual review is required.");
  const upload = await db.storage.from("project-logos").upload(path, normalized.bytes, { contentType: "image/webp", upsert: true, cacheControl: "31536000" });
  if (upload.error) throw new Error("Could not restore the approved Storage object.");
  const stillApproved = await loadCandidate(db, candidate.id);
  if (stillApproved.verification_status !== "approved" || stillApproved.content_digest !== normalized.contentDigest
    || stillApproved.storage_path !== path) {
    if (await removeObject(db, path)) throw new Error("Logo changed during reconciliation; orphan cleanup is required.");
    throw new Error("Logo changed during reconciliation; the stale object was removed.");
  }
  stdout(`${JSON.stringify({ event: "logo_reconciliation_complete", logo_id: candidate.id, status: "approved", action: "approved_object_restored", content_digest: normalized.contentDigest })}\n`);
  return 0;
}

async function loadCandidate(db: LogoDatabase, logoId: string) {
  const result = await db.from("project_logos").select("id,project_id,repository_id,source_url,origin,verification_status,attribution_text,source_provenance,content_digest,storage_path")
    .eq("id", logoId).limit(1);
  if (result.error || !Array.isArray(result.data) || !result.data[0]) throw new Error("Logo candidate was not found.");
  return candidateSchema.parse(result.data[0]);
}

async function storeSourceRecord(db: LogoDatabase, values: Record<string, unknown>): Promise<string> {
  const provider = String(values.provider);
  const sourceKey = String(values.source_key);
  const fetchedAt = String(values.fetched_at);
  const existing = await db.from("source_records").select("id").eq("provider", provider).eq("source_key", sourceKey).eq("fetched_at", fetchedAt).limit(1);
  if (!existing.error && Array.isArray(existing.data) && existing.data[0] && typeof existing.data[0] === "object" && "id" in existing.data[0]) {
    return String(existing.data[0].id);
  }
  const inserted = await db.from("source_records").insert(values).select("id").single();
  if (!inserted.error && inserted.data && typeof inserted.data === "object" && "id" in inserted.data) return String(inserted.data.id);
  const raced = await db.from("source_records").select("id").eq("provider", provider).eq("source_key", sourceKey).eq("fetched_at", fetchedAt).limit(1);
  if (!raced.error && Array.isArray(raced.data) && raced.data[0] && typeof raced.data[0] === "object" && "id" in raced.data[0]) return String(raced.data[0].id);
  throw new Error("Could not store source provenance.");
}

async function readApprovalInput(candidate: z.infer<typeof candidateSchema>, args: LogoArguments, dependencies: LogoCliDependencies): Promise<{ bytes: Buffer; mode: "avatar_source" | "local_file" }> {
  if (args.avatarSource) {
    if (candidate.origin !== "provider_avatar") throw new Error("Only provider-avatar candidates can use --avatar-source.");
    const ownerId = candidate.source_provenance.owner_id;
    if (typeof ownerId !== "string" && typeof ownerId !== "number") throw new Error("Avatar source is missing its validated GitHub owner identity.");
    validateGitHubAvatarUrl(candidate.source_url, ownerId);
    return { bytes: await (dependencies.downloadAvatar ?? downloadGitHubAvatar)(candidate.source_url, ownerId), mode: "avatar_source" };
  }
  if (!args.localFile || !["official_site", "editorial", "submitted"].includes(candidate.origin)) {
    throw new Error("Official candidates require an explicit --local-file approval source.");
  }
  return { bytes: await readOperatorLogoFile(args.localFile), mode: "local_file" };
}

async function removeObject(db: LogoDatabase, path: string): Promise<boolean> {
  try {
    const result = await db.storage.from("project-logos").remove([path]);
    return Boolean(result.error);
  } catch { return true; }
}

/** Treat a failed remove as clean only when Storage confirms the deterministic object is absent. */
async function removeObjectOrConfirmAbsent(db: LogoDatabase, path: string): Promise<boolean> {
  if (!(await removeObject(db, path))) return true;
  try {
    const result = await db.storage.from("project-logos").exists(path);
    if (result.error) {
      return result.error.status === 404 || result.error.statusCode === "404" || result.error.code === "NoSuchKey";
    }
    return result.data === false;
  } catch { return false; }
}

function isEligibleRepository(repository: z.infer<typeof repositorySchema>, projectId: string): boolean {
  return repository.project_id === projectId && repository.provider === "github"
    && /^[1-9][0-9]{0,18}$/.test(repository.provider_repository_id)
    && Number(repository.provider_repository_id) <= Number.MAX_SAFE_INTEGER
    && repository.availability_status === "available" && repository.is_private === false
    && repository.is_disabled === false && repository.visibility?.trim().toLowerCase() === "public"
    && repository.canonical_url.toLowerCase() === `https://github.com/${repository.full_name}`.toLowerCase();
}

function validateTrustedSourceUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Operator source URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || /[\u0000-\u0020\u007f]/.test(raw)) {
    throw new Error("Operator source URL must be a credential-free HTTPS URL.");
  }
  return url.href;
}

function digestText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeMessage(error: unknown): string {
  if (error instanceof z.ZodError) return "Database or source metadata failed validation.";
  if (error instanceof Error && /^(Logo |GitHub avatar|Official candidate|Candidate registration|Project |Could not |Only |Current source|Operator |Approval |Logo review|Repository |Avatar |Unknown |Discovery |Choose |An |No |Normalized )/.test(error.message)) return error.message;
  return "Logo operation failed; inspect the structured stage output and retry.";
}

if (import.meta.main) {
  process.exitCode = await runLogoCli(process.argv.slice(2));
}
