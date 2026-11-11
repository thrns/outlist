import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { catalogSnapshotDataHash, fetchOutlistCatalogSnapshot, loadOutlistCatalogSnapshot } from "./catalog";

const temporaryDirectories: string[] = [];
const now = new Date("2026-11-10T12:00:00.000Z");

async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "outlist-catalog-snapshot-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Outlist catalog snapshot loader", () => {
  it("reads all identity tables with bounded read-only pages and hashes normalized provenance", async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
      const url = new URL(String(input));
      const rows = url.pathname.endsWith("/repositories")
        ? [{ id: "repo", provider: "github", provider_repository_id: "123", full_name: "acme/tool", canonical_url: "https://github.com/acme/tool", project_id: null, is_archived: false, is_fork: false, availability_status: "available" }]
        : url.pathname.endsWith("/repository_candidates")
          ? [{ id: "candidate", provider: "github", provider_repository_id: "123", full_name: "acme/tool", canonical_url: "https://github.com/acme/tool", repository_id: "repo", queue_status: "succeeded" }]
          : [{ id: "project", slug: "tool", name: "Tool", primary_repository_id: "repo", publication_status: "pending_review" }];
      return new Response(JSON.stringify(rows), { status: 200 });
    };
    const snapshot = await fetchOutlistCatalogSnapshot({ url: "https://example.supabase.co", key: "test-key", fetch: fetcher, now: () => now });
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.source_tables).toEqual(["repositories", "repository_candidates", "projects"]);
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(catalogSnapshotDataHash({ ...snapshot, captured_at: new Date(now.getTime() + 1_000).toISOString() })).toBe(catalogSnapshotDataHash(snapshot));
    expect(catalogSnapshotDataHash({ ...snapshot, repositories: snapshot.repositories.map((row) => ({ ...row, full_name: "acme/changed" })) }))
      .not.toBe(catalogSnapshotDataHash(snapshot));
  });

  it("uses only a hash-verified cached snapshot younger than 24 hours after a failed live refresh", async () => {
    const directory = await tempDirectory();
    const snapshot = await fetchOutlistCatalogSnapshot({
      url: "https://example.supabase.co", key: "test-key", now: () => now,
      fetch: async () => new Response("[]", { status: 200 }),
    });
    await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(directory, "catalog-snapshots"), { recursive: true })
      .then(() => writeFile(join(directory, "catalog-snapshots/current.json"), JSON.stringify(snapshot))));
    const fallback = await loadOutlistCatalogSnapshot(directory, {
      environment: { NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "test-key" },
      now: () => new Date(now.getTime() + 60_000),
      fetch: async () => { throw new Error("offline"); },
    });
    expect(fallback.source).toBe("fresh_local_snapshot");
    expect(fallback.snapshot?.sha256).toBe(snapshot.sha256);
    expect(fallback.note).toContain("using a verified snapshot younger than 24 hours");

    const stale = await loadOutlistCatalogSnapshot(directory, {
      environment: { NODE_ENV: "test" },
      now: () => new Date(now.getTime() + 25 * 60 * 60 * 1000),
    });
    expect(stale.status).toBe("unavailable");
    expect(stale.snapshot).toBeNull();
    expect(await readFile(join(directory, "catalog-snapshots/current.json"), "utf8")).toContain(snapshot.sha256);
  });
});
