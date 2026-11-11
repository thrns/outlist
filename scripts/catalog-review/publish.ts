import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "../../src/lib/supabase/admin";
import type { Database } from "../../src/lib/supabase/database.types";
import { loadCatalogReviewQueue, type CatalogReviewQueueItem } from "./queue";
import {
  applyEditorialPolicy,
  EvidencePackageSchema,
  REVIEW_POLICY_VERSION,
  validateCodexReview,
} from "./schema";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_AUDIT_DIR = join(ROOT, "reports/catalog-production-audit");
const DEFAULT_OUTPUT_DIR = join(ROOT, "reports/catalog-codex-review");

type Options = {
  auditDirectory: string;
  outputDirectory: string;
  execute: boolean;
  projectRef: string | null;
  authorizationId: string | null;
  maxItems: number;
  startAt: number;
};

type LocalRecord = {
  execution_status: string;
  review_id: string;
  evidence_sha256: string | null;
  evidence_timestamp: string | null;
  codex_version: string | null;
  model: string;
  review: unknown;
  policy_decision: unknown;
};

type SupabaseRpc = {
  rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

function parseOptions(args: string[]): Options {
  let auditDirectory = DEFAULT_AUDIT_DIR;
  let outputDirectory = DEFAULT_OUTPUT_DIR;
  let execute = false;
  let projectRef: string | null = null;
  let authorizationId: string | null = null;
  let maxItems = 1;
  let startAt = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--execute") { execute = true; continue; }
    if (!["--audit-dir", "--out-dir", "--confirm-project-ref", "--authorization-id", "--max-items", "--start-at"].includes(arg)) {
      throw new TypeError(`Unknown publication option ${arg}.`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value.`);
    if (arg === "--audit-dir") auditDirectory = resolve(value);
    else if (arg === "--out-dir") outputDirectory = resolve(value);
    else if (arg === "--confirm-project-ref") projectRef = value;
    else if (arg === "--authorization-id") authorizationId = value;
    else if (arg === "--max-items") maxItems = parseBoundedInt(value, 1, 1111, "--max-items");
    else if (arg === "--start-at") startAt = parseBoundedInt(value, 0, 1110, "--start-at");
  }
  if (execute && (!projectRef || !authorizationId)) {
    throw new TypeError("Production execution requires --confirm-project-ref and --authorization-id.");
  }
  if (authorizationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(authorizationId)) {
    throw new TypeError("--authorization-id must be a UUID returned by the explicit policy authorization RPC.");
  }
  return { auditDirectory, outputDirectory, execute, projectRef, authorizationId, maxItems, startAt };
}

function parseBoundedInt(value: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(value)) throw new TypeError(`${label} must be a whole decimal number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new TypeError(`${label} must be between ${min} and ${max}.`);
  return parsed;
}

export async function runCatalogPublicationExecutor(argv: string[]): Promise<number> {
  let options: Options;
  try { options = parseOptions(argv); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ event: "catalog_publication_error", stage: "arguments", message: error instanceof Error ? error.message : "Invalid options." })}\n`);
    return 2;
  }
  try {
    const queue = await loadCatalogReviewQueue(options.auditDirectory);
    const prepared = JSON.parse(await readFile(join(options.outputDirectory, "queue.json"), "utf8")) as { input_sha256?: string };
    if (prepared.input_sha256 !== queue.input_sha256) throw new Error("Prepared queue no longer matches the existing catalog audit input.");
    const selected = queue.items.slice(options.startAt, options.startAt + options.maxItems);
    const entries = await Promise.all(selected.map((item) => loadCompletedReview(options.outputDirectory, item)));
    const ready = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (!options.execute) {
      process.stdout.write(`${JSON.stringify({ event: "catalog_publication_dry_run", mode: "dry_run",
        policy_version: REVIEW_POLICY_VERSION, selected_candidates: selected.length,
        completed_reviews: ready.length, actions: ready.map(({ item, review, policy }) => ({
          candidate_id: item.candidate_id, full_name: item.full_name, project_id: item.project_id,
          outcome: policy.accepted_outcome, publication_eligible: policy.publication_eligible,
          action: item.project_id === null
            ? policy.publication_eligible ? "record_create_draft_apply_publish" : "record_review_only"
            : policy.publication_eligible ? "record_apply_publish" : "record_apply_hold",
          rationale: review.rationale,
        })) }, null, 2)}\n`);
      return 0;
    }

    const productionUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
    if (!productionUrl || !anonKey) throw new Error("Production writes require NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY for independent public visibility checks.");
    const actualProjectRef = new URL(productionUrl).hostname.split(".")[0];
    if (actualProjectRef !== options.projectRef) throw new Error(`Confirmed project ref ${options.projectRef} does not match the configured Supabase project ${actualProjectRef}.`);
    if (actualProjectRef !== "hvunezhzpnpdkfiqgaaa") throw new Error("This executor is configured only for the specified Outlist production project.");

    const service = createSupabaseAdminClient() as unknown as SupabaseRpc;
    const anonymous = createClient<Database>(productionUrl, anonKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const authorizationId = options.authorizationId!;
    const status = await callRpc(service, "codex_editorial_policy_status", {});
    if (status.enabled !== true || status.authorization_id !== authorizationId || status.policy_version !== REVIEW_POLICY_VERSION) {
      throw new Error("The explicitly enabled production Codex editorial authorization does not match --authorization-id.");
    }

    let processed = 0;
    let published = 0;
    let held = 0;
    const executionDirectory = join(options.outputDirectory, "execution");
    await mkdir(executionDirectory, { recursive: true });
    for (const entry of ready) {
      const { item, review, evidence, record, policy } = entry;
      const log: Record<string, unknown> = {
        schema: "outlist.catalog.publication-execution.v1",
        candidate_id: item.candidate_id,
        project_id: item.project_id,
        review_id: record.review_id,
        policy_version: REVIEW_POLICY_VERSION,
        started_at: new Date().toISOString(),
        status: "running",
        events: [],
      };
      let projectId = item.project_id;
      log.project_id = projectId;
      const events = log.events as Record<string, unknown>[];
      try {
        const licenseSource = evidence.sources.find((source) => source.kind === "license" && source.status === "available");
        const licenseIdentifier = licenseSource ? review.eligibility.license_identifier : null;
        const recorded = await callRpc(service, "codex_record_editorial_review", {
          p_authorization_id: authorizationId,
          p_review_id: record.review_id,
          p_candidate_id: item.candidate_id,
          p_provider_repository_id: item.repository_id,
          p_full_name: item.full_name,
          p_codex_version: record.codex_version,
          p_evidence_observed_at: evidence.collected_at,
          p_evidence_sha256: record.evidence_sha256,
          p_license_identifier: licenseIdentifier,
          p_license_file_url: licenseIdentifier ? licenseSource?.url ?? null : null,
          p_license_file_sha256: licenseIdentifier ? licenseSource?.sha256 ?? null : null,
          p_evidence: evidence,
          p_codex_review: review,
          p_policy_decision: policy,
        });
        events.push({ event: "review_recorded", result: recorded, at: new Date().toISOString() });

        if (projectId === null && policy.publication_eligible) {
          const draft = await callRpc(service, "codex_create_reviewed_draft", {
            p_authorization_id: authorizationId,
            p_candidate_id: item.candidate_id,
            p_review_id: record.review_id,
          });
          if (typeof draft.project_id !== "string") throw new Error("Approved missing-draft candidate did not return a restored project ID.");
          projectId = draft.project_id;
          log.project_id = projectId;
          events.push({ event: "draft_restored_and_review_applied", result: draft, at: new Date().toISOString() });
        }

        if (projectId !== null) {
          let state = await callRpc(service, "codex_project_review_state", {
            p_authorization_id: authorizationId, p_project_id: projectId, p_review_id: record.review_id,
          });
          if (state.review_applied !== true) {
            const applied = await callRpc(service, "codex_apply_editorial_review", {
              p_authorization_id: authorizationId,
              p_project_id: projectId,
              p_review_id: record.review_id,
              p_expected_revision: readRevision(state.editorial_revision),
            });
            events.push({ event: "review_applied", result: applied, at: new Date().toISOString() });
            state = await callRpc(service, "codex_project_review_state", {
              p_authorization_id: authorizationId, p_project_id: projectId, p_review_id: record.review_id,
            });
          }

          if (policy.publication_eligible && state.publication_status === "pending_review") {
            const result = await callRpc(service, "codex_publish_project", {
              p_authorization_id: authorizationId,
              p_project_id: projectId,
              p_review_id: record.review_id,
              p_expected_revision: readRevision(state.editorial_revision),
            });
            events.push({ event: "project_published", result, at: new Date().toISOString() });
            const afterPublish = await callRpc(service, "codex_project_review_state", {
              p_authorization_id: authorizationId, p_project_id: projectId, p_review_id: record.review_id,
            });
            const publicResult = await anonymous.rpc("search_public_projects", {
              p_categories: [], p_licenses: [], p_languages: [], p_sort: "relevance",
              p_page: 1, p_page_size: 1, p_slug: readProjectSlug(afterPublish, item),
            });
            if (publicResult.error) throw new Error(`Anonymous catalog verification failed: ${publicResult.error.message}`);
            const publicData = asRecord(publicResult.data);
            const projects = Array.isArray(publicData.items) ? publicData.items : [];
            if (!projects.some((row) => asRecord(row).id === projectId)) {
              throw new Error("Project did not appear in the anonymous public catalog after publication.");
            }
            events.push({ event: "anonymous_visibility_confirmed", at: new Date().toISOString() });
            published++;
          } else if (!policy.publication_eligible) {
            events.push({ event: "publication_held", reason: policy.reasons, at: new Date().toISOString() });
            held++;
          } else if (state.publication_status === "published") {
            events.push({ event: "already_published", at: new Date().toISOString() });
            published++;
          } else {
            events.push({ event: "publication_not_attempted", publication_status: state.publication_status, at: new Date().toISOString() });
            held++;
          }
        }
        if (projectId === null && !policy.publication_eligible) {
          events.push({ event: "publication_held_without_draft", reason: policy.reasons, at: new Date().toISOString() });
          held++;
        }
        log.status = policy.publication_eligible
          ? (projectId ? "published_or_pending_verification" : "review_recorded")
          : (projectId ? "review_applied_hold" : "review_recorded_hold");
        processed++;
      } catch (error) {
        log.status = "failed";
        log.failure = error instanceof Error ? error.message.slice(0, 1000) : "Publication operation failed.";
        log.finished_at = new Date().toISOString();
        await atomicJson(join(executionDirectory, `${item.candidate_id}.json`), log);
        throw error;
      }
      log.finished_at = new Date().toISOString();
      await atomicJson(join(executionDirectory, `${item.candidate_id}.json`), log);
      process.stdout.write(`${JSON.stringify({ event: "catalog_publication_candidate_complete", candidate_id: item.candidate_id,
        project_id: projectId, outcome: policy.accepted_outcome, status: log.status })}\n`);
    }
    process.stdout.write(`${JSON.stringify({ event: "catalog_publication_execution_summary", processed, published, held,
      selected: selected.length, policy_version: REVIEW_POLICY_VERSION })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: "catalog_publication_error", stage: "execution", message: error instanceof Error ? error.message.slice(0, 1000) : "Unknown publication failure." })}\n`);
    return 1;
  }
}

async function loadCompletedReview(outputDirectory: string, item: CatalogReviewQueueItem) {
  let record: LocalRecord;
  try { record = JSON.parse(await readFile(join(outputDirectory, "records", `${item.candidate_id}.json`), "utf8")) as LocalRecord; }
  catch { return null; }
  if (record.execution_status !== "completed" || !record.review_id || !record.evidence_sha256 || !record.evidence_timestamp || !record.codex_version) return null;
  const rawEvidence = JSON.parse(await readFile(join(outputDirectory, "evidence", `${item.candidate_id}.json`), "utf8"));
  const evidence = EvidencePackageSchema.parse(rawEvidence);
  if (evidence.candidate_id !== item.candidate_id || evidence.repository_id !== item.repository_id
    || evidence.full_name.toLowerCase() !== item.full_name.toLowerCase() || evidence.project_id !== item.project_id
    || evidence.collected_at !== record.evidence_timestamp
    || createHash("sha256").update(JSON.stringify(evidence)).digest("hex") !== record.evidence_sha256) {
    throw new Error(`Evidence checkpoint integrity failed for ${item.full_name}.`);
  }
  const review = validateCodexReview(record.review, evidence);
  if (review.reviewer.model !== record.model || review.reviewer.identity !== "codex-cli") {
    throw new Error(`Codex reviewer provenance mismatch for ${item.full_name}.`);
  }
  const policy = applyEditorialPolicy(review, evidence);
  if (JSON.stringify(policy) !== JSON.stringify(record.policy_decision)) {
    throw new Error(`Deterministic editorial policy result changed for ${item.full_name}.`);
  }
  const reviewIdHash = createHash("sha256")
    .update(`${item.candidate_id}\0${REVIEW_POLICY_VERSION}\0${record.evidence_sha256}\0${JSON.stringify(review)}`)
    .digest("hex");
  if (record.review_id !== `codex_${reviewIdHash.slice(0, 40)}`) {
    throw new Error(`Review ID integrity failed for ${item.full_name}.`);
  }
  return { item, record, evidence, review, policy };
}

async function callRpc(client: SupabaseRpc, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.rpc(name, args);
  if (result.error) throw new Error(`${name} failed (${result.error.code ?? "unknown"}): ${result.error.message}`);
  return asRecord(result.data);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readRevision(value: unknown): number {
  const revision = typeof value === "string" ? Number(value) : value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Current editorial revision is invalid.");
  return revision;
}

function readProjectSlug(result: Record<string, unknown>, item: CatalogReviewQueueItem): string {
  const slug = result.slug;
  if (typeof slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return slug;
  throw new Error(`Public verification needs a project slug for ${item.full_name}; no project was changed after verification.`);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  process.exitCode = await runCatalogPublicationExecutor(process.argv.slice(2));
}
