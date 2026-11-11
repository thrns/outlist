import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PAGE_SIZE = 1_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CATALOG_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

export type CatalogRepositoryIdentity = {
  id: string;
  provider: string;
  provider_repository_id: string;
  full_name: string;
  canonical_url: string;
  project_id: string | null;
  is_archived: boolean;
  is_fork: boolean;
  availability_status: string;
};

export type CatalogCandidateIdentity = {
  id: string;
  provider: string;
  provider_repository_id: string;
  full_name: string;
  canonical_url: string;
  repository_id: string | null;
  queue_status: string;
};

export type CatalogProjectIdentity = {
  id: string;
  slug: string;
  name: string;
  primary_repository_id: string | null;
  publication_status: string;
};

export type OutlistCatalogSnapshot = {
  schema: "outlist.catalog.identity-snapshot.v1";
  captured_at: string;
  project_ref: string;
  source_tables: ["repositories", "repository_candidates", "projects"];
  repositories: CatalogRepositoryIdentity[];
  candidates: CatalogCandidateIdentity[];
  projects: CatalogProjectIdentity[];
  sha256: string;
};

export type CatalogSnapshotResult = {
  snapshot: OutlistCatalogSnapshot | null;
  status: "available" | "unavailable";
  source: "live_read_only_query" | "fresh_local_snapshot" | "unavailable";
  note: string | null;
};

export async function loadOutlistCatalogSnapshot(
  outputDirectory: string,
  options: { environment?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => Date } = {},
): Promise<CatalogSnapshotResult> {
  const environment = options.environment ?? process.env;
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const snapshotDirectory = join(outputDirectory, "catalog-snapshots");
  const url = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = environment.SUPABASE_SECRET_KEY?.trim();
  let liveNote: string | null = null;

  if (url && key) {
    try {
      const snapshot = await fetchOutlistCatalogSnapshot({ url, key, fetch: fetcher, now });
      await saveSnapshot(snapshotDirectory, snapshot);
      return { snapshot, status: "available", source: "live_read_only_query", note: null };
    } catch (error) {
      liveNote = error instanceof Error ? error.message.slice(0, 300) : "Live Outlist catalog read failed.";
    }
  } else {
    liveNote = "Live Outlist catalog query requires the configured Supabase URL and service key.";
  }

  const cached = await readCachedSnapshot(join(snapshotDirectory, "current.json"), now()).catch(() => null);
  if (cached) {
    return {
      snapshot: cached,
      status: "available",
      source: "fresh_local_snapshot",
      note: liveNote ? `Live refresh failed; using a verified snapshot younger than 24 hours. ${liveNote}` : null,
    };
  }
  return { snapshot: null, status: "unavailable", source: "unavailable", note: liveNote ?? "No verified Outlist catalog snapshot younger than 24 hours is available." };
}

export async function fetchOutlistCatalogSnapshot(options: {
  url: string;
  key: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<OutlistCatalogSnapshot> {
  const base = new URL(options.url);
  if (base.protocol !== "https:" || !base.hostname.endsWith(".supabase.co")) {
    throw new TypeError("Read-only Outlist catalog query requires an HTTPS Supabase project URL.");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const repositories = await readPagedTable<CatalogRepositoryIdentity>(base, options.key, "repositories", "id,provider,provider_repository_id,full_name,canonical_url,project_id,is_archived,is_fork,availability_status", fetcher);
  const candidates = await readPagedTable<CatalogCandidateIdentity>(base, options.key, "repository_candidates", "id,provider,provider_repository_id,full_name,canonical_url,repository_id,queue_status", fetcher);
  const projects = await readPagedTable<CatalogProjectIdentity>(base, options.key, "projects", "id,slug,name,primary_repository_id,publication_status", fetcher);

  const snapshotBody = {
    schema: "outlist.catalog.identity-snapshot.v1" as const,
    captured_at: (options.now ?? (() => new Date()))().toISOString(),
    project_ref: base.hostname.split(".")[0]!,
    source_tables: ["repositories", "repository_candidates", "projects"] as ["repositories", "repository_candidates", "projects"],
    repositories: repositories.map(normalizeRepository).sort((a, b) => a.id.localeCompare(b.id)),
    candidates: candidates.map(normalizeCandidate).sort((a, b) => a.id.localeCompare(b.id)),
    projects: projects.map(normalizeProject).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { ...snapshotBody, sha256: sha256(JSON.stringify(snapshotBody)) };
}

async function readPagedTable<T>(base: URL, key: string, table: string, select: string, fetcher: typeof fetch): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL(`/rest/v1/${table}`, base);
    url.searchParams.set("select", select);
    url.searchParams.set("order", "id.asc");
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`Read-only Outlist ${table} query could not reach Supabase.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PAGE_BYTES) throw new Error(`Outlist ${table} response exceeded the 4 MiB page limit.`);
    if (!response.ok) throw new Error(`Read-only Outlist ${table} query returned HTTP ${response.status}.`);
    let data: unknown;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error(`Read-only Outlist ${table} response was malformed JSON.`); }
    if (!Array.isArray(data)) throw new Error(`Read-only Outlist ${table} response was not a row array.`);
    rows.push(...data as T[]);
    if (data.length < PAGE_SIZE) return rows;
  }
}

async function saveSnapshot(directory: string, snapshot: OutlistCatalogSnapshot): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicJson(join(directory, `snapshot-${snapshot.sha256}.json`), snapshot);
  await atomicJson(join(directory, "current.json"), snapshot);
}

async function readCachedSnapshot(path: string, now: Date): Promise<OutlistCatalogSnapshot | null> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isSnapshot(raw)) return null;
  const { sha256: expected, ...body } = raw;
  if (sha256(JSON.stringify(body)) !== expected) return null;
  const age = now.getTime() - Date.parse(raw.captured_at);
  if (!Number.isFinite(age) || age < 0 || age > MAX_CATALOG_SNAPSHOT_AGE_MS) return null;
  return raw;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function normalizeRepository(row: CatalogRepositoryIdentity): CatalogRepositoryIdentity {
  return {
    id: string(row.id), provider: string(row.provider), provider_repository_id: string(row.provider_repository_id),
    full_name: string(row.full_name), canonical_url: string(row.canonical_url), project_id: nullableString(row.project_id),
    is_archived: row.is_archived === true, is_fork: row.is_fork === true, availability_status: string(row.availability_status),
  };
}
function normalizeCandidate(row: CatalogCandidateIdentity): CatalogCandidateIdentity {
  return {
    id: string(row.id), provider: string(row.provider), provider_repository_id: string(row.provider_repository_id),
    full_name: string(row.full_name), canonical_url: string(row.canonical_url), repository_id: nullableString(row.repository_id),
    queue_status: string(row.queue_status),
  };
}
function normalizeProject(row: CatalogProjectIdentity): CatalogProjectIdentity {
  return {
    id: string(row.id), slug: string(row.slug), name: string(row.name),
    primary_repository_id: nullableString(row.primary_repository_id), publication_status: string(row.publication_status),
  };
}

function isSnapshot(value: unknown): value is OutlistCatalogSnapshot {
  if (!isRecord(value) || value.schema !== "outlist.catalog.identity-snapshot.v1"
    || typeof value.captured_at !== "string" || typeof value.project_ref !== "string"
    || typeof value.sha256 !== "string" || !Array.isArray(value.repositories)
    || !Array.isArray(value.candidates) || !Array.isArray(value.projects) || !Array.isArray(value.source_tables)) return false;
  return value.source_tables.length === 3;
}
export function verifyCatalogSnapshot(snapshot: OutlistCatalogSnapshot): boolean {
  const { sha256: expected, ...body } = snapshot;
  return /^[a-f0-9]{64}$/.test(expected)
    && createHash("sha256").update(JSON.stringify(body)).digest("hex") === expected
    && snapshot.schema === "outlist.catalog.identity-snapshot.v1"
    && snapshot.source_tables.join(",") === "repositories,repository_candidates,projects"
    && Array.isArray(snapshot.repositories) && Array.isArray(snapshot.candidates) && Array.isArray(snapshot.projects);
}
export function catalogSnapshotDataHash(snapshot: OutlistCatalogSnapshot): string {
  return sha256(JSON.stringify({
    schema: snapshot.schema,
    project_ref: snapshot.project_ref,
    source_tables: snapshot.source_tables,
    repositories: snapshot.repositories,
    candidates: snapshot.candidates,
    projects: snapshot.projects,
  }));
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function nullableString(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
