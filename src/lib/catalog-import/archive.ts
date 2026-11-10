import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";

export const CATALOG_CATEGORIES = [
  "developer-tools", "ai-machine-learning", "productivity", "design", "analytics",
  "infrastructure", "data-databases", "communication", "self-hosted",
  "security-privacy", "automation-workflows",
] as const;

const root = "data/catalog-seeds/";
const MAX_ENTRIES = 64;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_COMPRESSED_ARCHIVE_BYTES = 8 * 1024 * 1024;

const httpsUrl = z.string().max(2048).url().superRefine((value, context) => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
      || !hostname.includes(".") || isIP(hostname) !== 0
      || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
      || hostname.endsWith(".internal") || hostname.endsWith(".test") || hostname.endsWith(".invalid")) {
      context.addIssue({ code: "custom", message: "URL must be a public HTTPS URL without credentials." });
    }
  } catch {
    context.addIssue({ code: "custom", message: "URL is malformed." });
  }
});

const candidateSchema = z.object({
  schema_version: z.literal(1),
  github_repository_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  github_full_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/),
  github_url: httpsUrl,
  name: z.string().trim().min(1).max(160),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(140),
  description: z.string().max(10000),
  tagline: z.string().max(300),
  website_url: httpsUrl.nullable(),
  primary_category: z.enum(CATALOG_CATEGORIES),
  tags: z.array(z.string().trim().min(1).max(100)).max(100),
  github_topics: z.array(z.string().trim().min(1).max(100)).max(100),
  primary_language: z.string().max(100).nullable(),
  stars: z.number().int().nonnegative().safe().nullable(),
  forks: z.number().int().nonnegative().safe().nullable(),
  license_spdx_id: z.string().trim().min(1).max(128).nullable(),
  license_evidence_url: httpsUrl.nullable(),
  license_review_status: z.enum(["unverified", "needs_review"]),
  archived: z.boolean().nullable(),
  visibility: z.literal("public").nullable(),
  logo_candidate_url: httpsUrl.nullable(),
  logo_verification_status: z.enum(["pending_review"]).nullable(),
  source_urls: z.array(httpsUrl).min(1).max(20),
  source_checked_at: z.iso.datetime({ offset: true }),
  editorial_status: z.literal("pending_review"),
}).strict().superRefine((candidate, context) => {
  if (Number(candidate.github_repository_id) > Number.MAX_SAFE_INTEGER) {
    context.addIssue({ code: "custom", message: "GitHub repository ID exceeds the safe numeric API range.", path: ["github_repository_id"] });
  }
  const [owner, repository] = candidate.github_full_name.split("/");
  if (repository === "." || repository === "..") {
    context.addIssue({ code: "custom", message: "Repository name is not supported by GitHub.", path: ["github_full_name"] });
  }
  const expectedUrl = `https://github.com/${owner}/${repository}`;
  if (candidate.github_url.replace(/\/$/, "").toLowerCase() !== expectedUrl.toLowerCase()) {
    context.addIssue({ code: "custom", message: "Repository URL does not match the declared GitHub full name.", path: ["github_url"] });
  }
  if (candidate.logo_candidate_url === null && candidate.logo_verification_status !== null) {
    context.addIssue({ code: "custom", message: "A missing logo candidate cannot have a verification status.", path: ["logo_verification_status"] });
  }
  if (candidate.logo_candidate_url !== null && candidate.logo_verification_status !== "pending_review") {
    context.addIssue({ code: "custom", message: "Logo candidates must remain pending review.", path: ["logo_verification_status"] });
  }
});

const batchManifestSchema = z.object({
  number: z.number().int().positive(),
  path: z.string().regex(/^batches\/batch-\d{3}\.jsonl$/),
  candidate_count: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.string(),
  git_commit_sha: z.string().nullable().optional(),
}).passthrough();

const manifestSchema = z.object({
  schema_version: z.literal(1),
  target_unique_candidates: z.number().int().positive(),
  total_batches: z.number().int().positive(),
  source_checked_at: z.iso.datetime({ offset: true }),
  category_coverage: z.record(z.string(), z.number().int().nonnegative()),
  license_review_counts: z.record(z.string(), z.number().int().nonnegative()),
  batches: z.array(batchManifestSchema),
}).passthrough();

export type CatalogCandidate = z.infer<typeof candidateSchema>;
export type CatalogCandidateRecord = CatalogCandidate & {
  source_batch: number;
  source_line: number;
  source_batch_path: string;
};
export type CatalogBatch = {
  number: number;
  path: string;
  sha256: string;
  records: CatalogCandidateRecord[];
};
export type CatalogArchiveValidation = {
  valid: boolean;
  archivePath: string;
  archiveSha256: string;
  archiveBytes: number;
  integrity: { zipStructure: "passed"; entryCount: number; crcChecks: number };
  counts: {
    candidates: number;
    batches: number;
    uniqueRepositoryIds: number;
    uniqueFullNames: number;
    uniqueSlugs: number;
  };
  categories: Record<string, number>;
  licenses: {
    reviewStatuses: Record<string, number>;
    spdxIdentifiersPresent: number;
    spdxIdentifiersMissing: number;
    licenseEvidenceUrlsPresent: number;
    logoCandidatesPresent: number;
  };
  metadataQuality: {
    descriptionsPresent: number;
    taglinesPresent: number;
    websitesPresent: number;
    repositoriesClaimedPublic: number;
    repositoriesClaimedArchived: number;
    sourceUrlCounts: Record<string, number>;
  };
  sha256: { allCandidates: string; manifest: string; batches: Record<string, string> };
  declaredValidation: {
    candidateCountMatches: boolean;
    batchCountMatches: boolean;
    uniqueRepositoryIdsMatch: boolean;
    uniqueFullNamesMatch: boolean;
    uniqueSlugsMatch: boolean;
    categoriesMatch: boolean;
    batchHashesMatch: boolean;
    declaredValid: boolean;
  };
  issues: string[];
  manifest: z.infer<typeof manifestSchema>;
  batches: CatalogBatch[];
  records: CatalogCandidateRecord[];
};

type ZipEntry = { name: string; bytes: Buffer; crc: number };

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function safeArchivePath(name: string): boolean {
  return name.length > 0 && !name.startsWith("/") && !name.includes("\\")
    && !name.split("/").some((part) => part === "" || part === "." || part === "..");
}

function parseZip(bytes: Buffer): Map<string, ZipEntry> {
  if (bytes.length > MAX_COMPRESSED_ARCHIVE_BYTES) throw new TypeError("ZIP archive exceeds the configured size limit.");
  const lowerBound = Math.max(0, bytes.length - 22 - 0xffff);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= lowerBound; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0 || endOffset + 22 > bytes.length) throw new TypeError("ZIP end record is missing or truncated.");
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntryCount = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  if (endOffset + 22 + commentLength !== bytes.length || disk !== 0 || centralDisk !== 0
    || diskEntryCount !== entryCount || entryCount > MAX_ENTRIES
    || centralOffset + centralSize !== endOffset || centralOffset > bytes.length) {
    throw new TypeError("ZIP must be a single-disk archive with a complete, bounded central directory.");
  }

  const entries = new Map<string, ZipEntry>();
  const localRanges: Array<[number, number]> = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new TypeError("ZIP central directory entry is malformed.");
    }
    const madeBy = bytes.readUInt16LE(cursor + 4) >>> 8;
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const fileCommentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + fileCommentLength;
    if (next > centralOffset + centralSize || nameLength === 0 || diskStart !== 0
      || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff
      || (flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || ![0, 8].includes(method)
      || uncompressedSize > MAX_ENTRY_BYTES) {
      throw new TypeError("ZIP contains an encrypted, unsupported, oversized, or multi-disk entry.");
    }
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const mode = externalAttributes >>> 16;
    const unixType = mode & 0o170000;
    const dosDirectory = (externalAttributes & 0x10) !== 0;
    if (!safeArchivePath(name) || entries.has(name) || dosDirectory
      || (madeBy === 3 && unixType !== 0 && unixType !== 0o100000)) {
      throw new TypeError("ZIP contains a duplicate, unsafe, directory, or non-regular file entry.");
    }
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new TypeError("ZIP local file header is malformed.");
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (localFlags !== flags || localMethod !== method || localName !== name || dataStart < localOffset || dataEnd > centralOffset) {
      throw new TypeError("ZIP local and central headers disagree.");
    }
    localRanges.push([localOffset, dataEnd]);
    const compressed = bytes.subarray(dataStart, dataEnd);
    let decoded: Buffer;
    try {
      decoded = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      throw new TypeError(`ZIP entry cannot be safely decompressed: ${name}`);
    }
    if (decoded.length !== uncompressedSize || crc32(decoded) !== expectedCrc) {
      throw new TypeError(`ZIP entry size or CRC check failed: ${name}`);
    }
    totalUncompressed += decoded.length;
    if (totalUncompressed > MAX_TOTAL_BYTES) throw new TypeError("ZIP expands beyond the configured total size limit.");
    entries.set(name, { name, bytes: decoded, crc: expectedCrc });
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new TypeError("ZIP central directory has trailing or unparsed data.");
  localRanges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index]![0] < localRanges[index - 1]![1]) throw new TypeError("ZIP local entries overlap.");
  }
  return entries;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new TypeError(`${label} is not valid JSON.`); }
}

export function parseCatalogJsonl(text: string, label: string, batchNumber: number): CatalogCandidateRecord[] {
  const records: CatalogCandidateRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { throw new TypeError(`${label}:${index + 1} is malformed JSON.`); }
    const result = candidateSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue?.path.length ? ` (${issue.path.join(".")})` : "";
      throw new TypeError(`${label}:${index + 1} failed candidate validation${path}: ${issue?.message ?? "invalid record"}.`);
    }
    records.push({ ...result.data, source_batch: batchNumber, source_line: index + 1, source_batch_path: label });
  }
  return records;
}

export function candidateIdentityIssues(records: Array<Pick<CatalogCandidateRecord, "github_repository_id" | "github_full_name" | "slug">>): string[] {
  const issues: string[] = [];
  if (new Set(records.map((record) => record.github_repository_id)).size !== records.length) issues.push("Duplicate GitHub repository IDs were found across batches.");
  if (new Set(records.map((record) => record.github_full_name.toLowerCase())).size !== records.length) issues.push("Duplicate GitHub full names were found across batches.");
  if (new Set(records.map((record) => record.slug)).size !== records.length) issues.push("Duplicate proposed slugs were found across batches.");
  return issues;
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function sameRecord(left: CatalogCandidate, right: CatalogCandidate): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceCandidate(record: CatalogCandidateRecord): CatalogCandidate {
  const { source_batch, source_line, source_batch_path, ...candidate } = record;
  void source_batch;
  void source_line;
  void source_batch_path;
  return candidate;
}

export async function validateCatalogArchive(archivePath: string): Promise<CatalogArchiveValidation> {
  const absolutePath = archivePath;
  const archiveBytes = await readFile(archivePath);
  const entries = parseZip(archiveBytes);
  const manifestName = `${root}manifest.json`;
  const manifestParsed = manifestSchema.safeParse(parseJson(entries.get(manifestName)?.bytes ?? Buffer.alloc(0), "manifest.json"));
  if (!manifestParsed.success) throw new TypeError(`manifest.json failed validation: ${manifestParsed.error.issues[0]?.message ?? "invalid manifest"}.`);
  const manifest = manifestParsed.data;
  const expectedNames = new Set([
    ...manifest.batches.map((batch) => `${root}${batch.path}`),
    ...["all_candidates.jsonl", "catalog_index.csv", "manifest.json", "validation.json", "curation_report.json", "README.md", "SCHEMA.md"].map((file) => `${root}${file}`),
  ]);
  const issues: string[] = [];
  if (entries.size !== expectedNames.size || [...entries.keys()].some((name) => !expectedNames.has(name))) {
    issues.push("Archive entries do not exactly match the manifest and required catalog files.");
  }
  for (const name of expectedNames) if (!entries.has(name)) issues.push(`Required archive entry is missing: ${name}`);
  if (manifest.batches.length !== manifest.total_batches) issues.push("Manifest batch count does not match total_batches.");
  const sortedNumbers = [...manifest.batches].map((batch) => batch.number).sort((a, b) => a - b);
  if (sortedNumbers.some((number, index) => number !== index + 1)) issues.push("Manifest batch numbers must be contiguous starting at 1.");
  if (new Set(manifest.batches.map((batch) => batch.path)).size !== manifest.batches.length) issues.push("Manifest batch paths are not unique.");

  const batches: CatalogBatch[] = [];
  const batchRecords: CatalogCandidateRecord[] = [];
  const actualBatchHashes: Record<string, string> = {};
  let batchHashesMatch = true;
  for (const entry of [...manifest.batches].sort((a, b) => a.number - b.number)) {
    const name = `${root}${entry.path}`;
    const payload = entries.get(name)?.bytes;
    if (!payload) continue;
    const actualHash = sha256(payload);
    actualBatchHashes[entry.path] = actualHash;
    const hashMatches = actualHash === entry.sha256;
    batchHashesMatch &&= hashMatches;
    if (!hashMatches) issues.push(`SHA-256 mismatch for ${entry.path}.`);
    const records = parseCatalogJsonl(payload.toString("utf8"), entry.path, entry.number);
    if (records.length !== entry.candidate_count) issues.push(`${entry.path} declares ${entry.candidate_count} records but contains ${records.length}.`);
    const batch = { number: entry.number, path: entry.path, sha256: actualHash, records };
    batches.push(batch);
    batchRecords.push(...records);
  }

  const aggregateBytes = entries.get(`${root}all_candidates.jsonl`)?.bytes ?? Buffer.alloc(0);
  const aggregateRecords = parseCatalogJsonl(aggregateBytes.toString("utf8"), "all_candidates.jsonl", 0);
  const aggregate = aggregateRecords.map(sourceCandidate);
  const flattened = batchRecords.map(sourceCandidate);
  if (aggregate.length !== flattened.length || aggregate.some((record, index) => !flattened[index] || !sameRecord(record, flattened[index]!))) {
    issues.push("all_candidates.jsonl does not exactly match the ordered records in the 38 manifest batches.");
  }

  const records = batchRecords;
  const ids = new Set(records.map((record) => record.github_repository_id));
  const fullNames = new Set(records.map((record) => record.github_full_name.toLowerCase()));
  const slugs = new Set(records.map((record) => record.slug));
  issues.push(...candidateIdentityIssues(records));
  const categories = countBy(records.map((record) => record.primary_category));
  const licenseStatuses = countBy(records.map((record) => record.license_review_status));
  const sourceUrlCounts = countBy(records.map((record) => String(record.source_urls.length)));
  const declaredCategoryMatch = JSON.stringify(categories) === JSON.stringify(Object.fromEntries(Object.entries(manifest.category_coverage).sort(([a], [b]) => a.localeCompare(b))));
  if (!declaredCategoryMatch) issues.push("Recomputed category distribution does not match manifest category_coverage.");

  const validation = entries.get(`${root}validation.json`)
    ? parseJson(entries.get(`${root}validation.json`)!.bytes, "validation.json") as Record<string, unknown>
    : {};
  const declaredValid = validation.valid === true;
  const declaredCandidateCount = validation.candidate_count === records.length && manifest.target_unique_candidates === records.length;
  const declaredBatchCount = validation.batch_count === batches.length && manifest.total_batches === batches.length;
  const declaredIdMatch = validation.github_repository_ids_unique === records.length;
  const declaredFullNameMatch = validation.github_full_names_unique === records.length;
  const declaredSlugMatch = validation.slugs_unique === records.length;
  if (!declaredValid) issues.push("The supplied validation.json does not declare valid=true.");
  if (!declaredCandidateCount) issues.push("The supplied candidate count does not match the recomputed count.");
  if (!declaredBatchCount) issues.push("The supplied batch count does not match the recomputed count.");
  if (!declaredIdMatch || !declaredFullNameMatch || !declaredSlugMatch) issues.push("The supplied uniqueness counts do not match independent recomputation.");
  if (validation.original_batch_sha256_match !== true) issues.push("The supplied validation.json does not declare an original batch SHA-256 match.");

  return {
    valid: issues.length === 0,
    archivePath: absolutePath,
    archiveSha256: sha256(archiveBytes),
    archiveBytes: archiveBytes.length,
    integrity: { zipStructure: "passed", entryCount: entries.size, crcChecks: entries.size },
    counts: { candidates: records.length, batches: batches.length, uniqueRepositoryIds: ids.size, uniqueFullNames: fullNames.size, uniqueSlugs: slugs.size },
    categories,
    licenses: {
      reviewStatuses: licenseStatuses,
      spdxIdentifiersPresent: records.filter((record) => record.license_spdx_id !== null).length,
      spdxIdentifiersMissing: records.filter((record) => record.license_spdx_id === null).length,
      licenseEvidenceUrlsPresent: records.filter((record) => record.license_evidence_url !== null).length,
      logoCandidatesPresent: records.filter((record) => record.logo_candidate_url !== null).length,
    },
    metadataQuality: {
      descriptionsPresent: records.filter((record) => record.description.trim().length > 0).length,
      taglinesPresent: records.filter((record) => record.tagline.trim().length > 0).length,
      websitesPresent: records.filter((record) => record.website_url !== null).length,
      repositoriesClaimedPublic: records.filter((record) => record.visibility?.toLowerCase() === "public").length,
      repositoriesClaimedArchived: records.filter((record) => record.archived === true).length,
      sourceUrlCounts,
    },
    sha256: {
      allCandidates: sha256(aggregateBytes),
      manifest: sha256(entries.get(manifestName)?.bytes ?? Buffer.alloc(0)),
      batches: actualBatchHashes,
    },
    declaredValidation: {
      candidateCountMatches: declaredCandidateCount,
      batchCountMatches: declaredBatchCount,
      uniqueRepositoryIdsMatch: declaredIdMatch,
      uniqueFullNamesMatch: declaredFullNameMatch,
      uniqueSlugsMatch: declaredSlugMatch,
      categoriesMatch: declaredCategoryMatch,
      batchHashesMatch,
      declaredValid,
    },
    issues,
    manifest,
    batches,
    records,
  };
}

export function publicValidationReport(validation: CatalogArchiveValidation) {
  return Object.fromEntries(Object.entries(validation).filter(([key]) =>
    key !== "batches" && key !== "records" && key !== "manifest")) as Omit<CatalogArchiveValidation, "batches" | "records" | "manifest">;
}
