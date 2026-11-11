import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const LedgerRowSchema = z.object({
  batch: z.number().int().positive(),
  line: z.number().int().positive(),
  github_repository_id: z.string().regex(/^[1-9][0-9]*$/),
  github_full_name: z.string().min(3),
  candidate_id: z.string().uuid(),
  status: z.string(),
  excluded: z.boolean(),
}).passthrough();

const AuditRowSchema = z.object({
  schema: z.literal("outlist.catalog.editorial-audit.v1"),
  input: z.object({
    batch: z.number().int().positive(),
    line: z.number().int().positive(),
    github_repository_id: z.string().regex(/^[1-9][0-9]*$/),
    github_full_name: z.string().min(3),
    catalog_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).passthrough(),
  import: z.object({
    candidate_id: z.string().uuid(),
    status: z.string(),
    excluded: z.boolean(),
  }).passthrough(),
  listing_proposal: z.object({}).passthrough().optional(),
  assessment: z.object({}).passthrough(),
}).passthrough();

export type CatalogReviewQueueItem = {
  queue_key: string;
  batch: number;
  line: number;
  repository_id: string;
  full_name: string;
  candidate_id: string;
  project_id: string | null;
  pipeline_outcome: "draft_pending_review" | "assessment_hold" | "enrichment_failure";
  pipeline_details: {
    enrichment_status: string;
    enrichment_error: string | null;
    assessment_status: string;
    classification_status: string;
    publication_status: string;
  };
  existing_listing: {
    name: string | null;
    summary: string | null;
    description: string | null;
    categories: string[];
    tags: string[];
    official_website_url: string | null;
  };
  source_record_sha256: string;
};

export type QueueBuildResult = {
  schema: "outlist.catalog.codex-queue.v1";
  created_at: string;
  input_sha256: string;
  counts: { total: number; drafts: number; assessment_holds: number; enrichment_failures: number };
  items: CatalogReviewQueueItem[];
};

function records<T>(raw: string, schema: z.ZodType<T>, label: string): T[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try { return schema.parse(JSON.parse(line)); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "invalid record";
      throw new TypeError(`${label} line ${index + 1} is invalid: ${reason}`);
    }
  });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function buildCatalogReviewQueue(ledger: unknown[], audits: unknown[], createdAt = new Date().toISOString()): QueueBuildResult {
  const parsedLedger = ledger.map((row) => LedgerRowSchema.parse(row));
  const parsedAudits = audits.map((row) => AuditRowSchema.parse(row));
  if (parsedLedger.length !== parsedAudits.length) throw new TypeError("Import ledger and audit evidence have different row counts.");

  const ledgerById = new Map<string, z.infer<typeof LedgerRowSchema>>();
  for (const row of parsedLedger) {
    if (row.status !== "succeeded" || row.excluded) throw new TypeError(`Input repository ${row.github_full_name} is not a successful imported candidate.`);
    if (ledgerById.has(row.github_repository_id)) throw new TypeError(`Duplicate repository ID ${row.github_repository_id} in import ledger.`);
    ledgerById.set(row.github_repository_id, row);
  }

  const auditById = new Map<string, z.infer<typeof AuditRowSchema>>();
  for (const audit of parsedAudits) {
    const id = audit.input.github_repository_id;
    if (auditById.has(id)) throw new TypeError(`Duplicate repository ID ${id} in audit file.`);
    auditById.set(id, audit);
  }

  const items: CatalogReviewQueueItem[] = [];
  for (const row of parsedLedger) {
    const audit = auditById.get(row.github_repository_id);
    if (!audit) throw new TypeError(`Missing source audit for ${row.github_full_name}.`);
    if (audit.input.github_full_name.toLowerCase() !== row.github_full_name.toLowerCase()
      || audit.input.batch !== row.batch || audit.input.line !== row.line
      || audit.import.candidate_id !== row.candidate_id) {
      throw new TypeError(`Candidate identity or import provenance mismatch for ${row.github_full_name}.`);
    }
    const assessment = audit.assessment;
    const projectId = asString(assessment.project_id);
    const enrichmentStatus = asString(assessment.enrichment_status) ?? "unknown";
    const pipelineOutcome = projectId
      ? "draft_pending_review"
      : enrichmentStatus === "failed" ? "enrichment_failure" : "assessment_hold";
    const listing = audit.listing_proposal ?? {};
    const rawCategories = assessment.project_categories_current;
    const categories = asStringArray(rawCategories);
    const tags = asStringArray(assessment.project_tags_current);
    const auditJson = JSON.stringify(audit);
    items.push({
      queue_key: `${String(row.batch).padStart(3, "0")}:${String(row.line).padStart(4, "0")}:${row.candidate_id}`,
      batch: row.batch,
      line: row.line,
      repository_id: row.github_repository_id,
      full_name: row.github_full_name,
      candidate_id: row.candidate_id,
      project_id: projectId,
      pipeline_outcome: pipelineOutcome,
      pipeline_details: {
        enrichment_status: enrichmentStatus,
        enrichment_error: asString(assessment.enrichment_error),
        assessment_status: asString(assessment.assessment_status) ?? "unknown",
        classification_status: asString(assessment.classification_status) ?? "unknown",
        publication_status: asString(assessment.publication_status) ?? "no_project_draft",
      },
      existing_listing: {
        name: asString(listing.name) ?? asString(assessment.project_database_name),
        summary: asString(listing.tagline) ?? asString(assessment.project_database_summary),
        description: asString(listing.description) ?? asString(assessment.project_database_description),
        categories: categories.length ? categories : [asString(listing.primary_category)].filter((value): value is string => value !== null),
        tags: tags.length ? tags : asStringArray(listing.tags),
        official_website_url: asString(listing.proposed_official_website_url) ?? asString(assessment.project_website),
      },
      source_record_sha256: createHash("sha256").update(auditJson).digest("hex"),
    });
  }
  if (auditById.size !== ledgerById.size) throw new TypeError("Audit contains candidates absent from the import ledger.");
  items.sort((left, right) => left.batch - right.batch || left.line - right.line || left.candidate_id.localeCompare(right.candidate_id));
  const counts = {
    total: items.length,
    drafts: items.filter((item) => item.pipeline_outcome === "draft_pending_review").length,
    assessment_holds: items.filter((item) => item.pipeline_outcome === "assessment_hold").length,
    enrichment_failures: items.filter((item) => item.pipeline_outcome === "enrichment_failure").length,
  };
  const inputHash = createHash("sha256").update(items.map((item) => `${item.queue_key}:${item.source_record_sha256}`).join("\n")).digest("hex");
  return { schema: "outlist.catalog.codex-queue.v1", created_at: createdAt, input_sha256: inputHash, counts, items };
}

export async function loadCatalogReviewQueue(auditDirectory: string, createdAt?: string): Promise<QueueBuildResult> {
  const [ledgerRaw, auditsRaw] = await Promise.all([
    readFile(`${auditDirectory}/import-ledger.jsonl`, "utf8"),
    readFile(`${auditDirectory}/decisions.jsonl`, "utf8"),
  ]);
  const ledger = records(ledgerRaw, LedgerRowSchema, "Import ledger");
  const audits = records(auditsRaw, AuditRowSchema, "Catalog audit");
  return buildCatalogReviewQueue(ledger, audits, createdAt);
}
