import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateIdentityIssues, parseCatalogJsonl, validateCatalogArchive } from "./archive";

const temporaryDirectories: string[] = [];
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files: Array<{ name: string; value: string }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const value = Buffer.from(file.value, "utf8");
    const crc = crc32(value);
    const local = Buffer.alloc(30 + name.length + value.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(value.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    value.copy(local, 30 + name.length);
    locals.push(local);

    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(value.length, 20);
    header.writeUInt32LE(value.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(localOffset, 42);
    name.copy(header, 46);
    central.push(header);
    localOffset += local.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, end]);
}

function candidate() {
  return {
    schema_version: 1,
    github_repository_id: "123456",
    github_full_name: "acme/example",
    github_url: "https://github.com/acme/example",
    name: "Example",
    slug: "example",
    description: "An open-source example project.",
    tagline: "A concise project tagline",
    website_url: "https://example.org",
    primary_category: "developer-tools",
    tags: ["tooling"],
    github_topics: ["developer-tools"],
    primary_language: "TypeScript",
    stars: 100,
    forks: 10,
    license_spdx_id: "MIT",
    license_evidence_url: "https://github.com/acme/example/blob/main/LICENSE",
    license_review_status: "unverified",
    archived: false,
    visibility: "public",
    logo_candidate_url: null,
    logo_verification_status: null,
    source_urls: ["https://api.github.com/repos/acme/example", "https://github.com/acme/example/blob/main/README.md"],
    source_checked_at: "2026-11-09T20:00:00Z",
    editorial_status: "pending_review",
  };
}

function archiveFiles(options: { extraEntry?: { name: string; value: string }; visibility?: string } = {}) {
  const source = { ...candidate(), ...(options.visibility ? { visibility: options.visibility } : {}) };
  const jsonl = `${JSON.stringify(source)}\n`;
  const batchHash = hash(jsonl);
  const manifest = {
    schema_version: 1,
    catalog: "Outlist",
    target_unique_candidates: 1,
    total_batches: 1,
    source_checked_at: "2026-11-09T20:00:00Z",
    category_coverage: { "developer-tools": 1 },
    license_review_counts: { unverified: 1 },
    batches: [{ number: 1, path: "batches/batch-001.jsonl", candidate_count: 1, sha256: batchHash, status: "local", git_commit_sha: null }],
  };
  const validation = {
    valid: true,
    candidate_count: 1,
    batch_count: 1,
    github_repository_ids_unique: 1,
    github_full_names_unique: 1,
    slugs_unique: 1,
    original_batch_sha256_match: true,
  };
  const files = [
    { name: "data/catalog-seeds/batches/batch-001.jsonl", value: jsonl },
    { name: "data/catalog-seeds/all_candidates.jsonl", value: jsonl },
    { name: "data/catalog-seeds/catalog_index.csv", value: "name,slug\nExample,example\n" },
    { name: "data/catalog-seeds/manifest.json", value: JSON.stringify(manifest) },
    { name: "data/catalog-seeds/validation.json", value: JSON.stringify(validation) },
    { name: "data/catalog-seeds/curation_report.json", value: "{}" },
    { name: "data/catalog-seeds/README.md", value: "catalog" },
    { name: "data/catalog-seeds/SCHEMA.md", value: "schema" },
  ];
  return options.extraEntry ? [...files, options.extraEntry] : files;
}

async function writeArchive(files: Array<{ name: string; value: string }>) {
  const directory = await mkdtemp(join(tmpdir(), "outlist-catalog-test-"));
  temporaryDirectories.push(directory);
  const archivePath = join(directory, "catalog.zip");
  await writeFile(archivePath, makeZip(files));
  return archivePath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("catalog archive validation", () => {
  it("validates a complete archive and independently recomputes its counts and hashes", async () => {
    const report = await validateCatalogArchive(await writeArchive(archiveFiles()));
    expect(report.valid).toBe(true);
    expect(report.counts).toEqual({ candidates: 1, batches: 1, uniqueRepositoryIds: 1, uniqueFullNames: 1, uniqueSlugs: 1 });
    expect(report.declaredValidation.batchHashesMatch).toBe(true);
    expect(report.integrity.crcChecks).toBe(8);
  });

  it("rejects a private candidate before it can reach a database mapping", async () => {
    const archivePath = await writeArchive(archiveFiles({ visibility: "private" }));
    await expect(validateCatalogArchive(archivePath)).rejects.toThrow("failed candidate validation (visibility)");
  });

  it("rejects ZIP path traversal and does not extract archive entries", async () => {
    const archivePath = await writeArchive(archiveFiles({ extraEntry: { name: "../escape", value: "x" } }));
    await expect(validateCatalogArchive(archivePath)).rejects.toThrow("unsafe");
  });

  it("rejects changed payload bytes when the stored CRC no longer matches", async () => {
    const archivePath = await writeArchive(archiveFiles());
    const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(archivePath));
    const damaged = Buffer.from(bytes);
    const marker = damaged.indexOf(Buffer.from("Example"));
    damaged[marker] = "X".charCodeAt(0);
    await writeFile(archivePath, damaged);
    await expect(validateCatalogArchive(archivePath)).rejects.toThrow("CRC check failed");
  });

  it("rejects malformed JSONL and unsafe or unsupported candidate fields", () => {
    expect(() => parseCatalogJsonl("{not-json", "batch.jsonl", 1)).toThrow("malformed JSON");
    const invalid = { ...candidate(), github_repository_id: "0", github_url: "http://127.0.0.1/acme/example" };
    expect(() => parseCatalogJsonl(JSON.stringify(invalid), "batch.jsonl", 1)).toThrow("failed candidate validation");
    const privateHost = { ...candidate(), source_urls: ["https://192.168.1.10/secret"] };
    expect(() => parseCatalogJsonl(JSON.stringify(privateHost), "batch.jsonl", 1)).toThrow("public HTTPS URL");
  });

  it("reports repository ID, full name, and slug duplicates independently", () => {
    const rows = [candidate(), { ...candidate(), github_full_name: "Other/repo", slug: "other" }];
    expect(candidateIdentityIssues(rows)).toEqual(["Duplicate GitHub repository IDs were found across batches."]);
    expect(candidateIdentityIssues([candidate(), { ...candidate(), github_full_name: "ACME/EXAMPLE" }])).toContain("Duplicate GitHub full names were found across batches.");
    expect(candidateIdentityIssues([candidate(), { ...candidate(), github_repository_id: "222", github_full_name: "Other/repo" }])).toContain("Duplicate proposed slugs were found across batches.");
  });
});
