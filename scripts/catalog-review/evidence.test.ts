import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubEvidenceCollector } from "./evidence";
import type { CatalogReviewQueueItem } from "./queue";
import type { OutlistCatalogSnapshot } from "./catalog";

const item: CatalogReviewQueueItem = {
  queue_key: "001:0001:00000000-0000-4000-8000-000000000031",
  batch: 1,
  line: 1,
  repository_id: "123456",
  full_name: "acme/tool",
  candidate_id: "00000000-0000-4000-8000-000000000031",
  project_id: "00000000-0000-4000-8000-000000000032",
  pipeline_outcome: "draft_pending_review",
  pipeline_details: {
    enrichment_status: "succeeded",
    enrichment_error: null,
    assessment_status: "needs_review",
    classification_status: "classified",
    publication_status: "pending_review",
  },
  existing_listing: {
    name: "Tool",
    summary: "A useful tool for software teams.",
    description: "A software tool.",
    categories: ["developer-tools"],
    tags: [],
    official_website_url: null,
  },
  source_record_sha256: "a".repeat(64),
};

const snapshotBody = {
  schema: "outlist.catalog.identity-snapshot.v1" as const,
  captured_at: "2026-11-10T12:00:00.000Z",
  project_ref: "test-project",
  source_tables: ["repositories", "repository_candidates", "projects"] as ["repositories", "repository_candidates", "projects"],
  repositories: [{ id: "repo-row", provider: "github", provider_repository_id: item.repository_id, full_name: item.full_name, canonical_url: `https://github.com/${item.full_name}`, project_id: item.project_id, is_archived: false, is_fork: false, availability_status: "available" }],
  candidates: [{ id: item.candidate_id, provider: "github", provider_repository_id: item.repository_id, full_name: item.full_name, canonical_url: `https://github.com/${item.full_name}`, repository_id: "repo-row", queue_status: "succeeded" }],
  projects: [{ id: item.project_id!, slug: "tool", name: "Tool", primary_repository_id: "repo-row", publication_status: "pending_review" }],
};
const catalogSnapshot: OutlistCatalogSnapshot = {
  ...snapshotBody,
  sha256: createHash("sha256").update(JSON.stringify(snapshotBody)).digest("hex"),
};

describe("GitHub evidence identity", () => {
  it("serializes GitHub's numeric repository ID as the exact string required by the production review RPC", async () => {
    const relevantReadme = [
      "# Tool\nTool is a useful software tool that automates repository work.",
      "## Features\nThe tool provides code review and project reporting.",
      "## Usage\nInstall the package and run `tool review`.",
      "## Development\nRun the test suite with `pytest` and contribute changes.",
      "## Release history\n" + "Older release notes are unrelated to current product use.\n".repeat(900),
    ].join("\n\n");
    const longPyproject = "[project]\nname = \"tool\"\nlicense = { text = \"MIT\" }\n" + ("# retained manifest line\n".repeat(1_500));
    const file = (path: string, content: string) => ({
      path,
      html_url: `https://github.com/acme/tool/blob/main/${path}`,
      content: Buffer.from(content).toString("base64"),
      sha: "b".repeat(40),
      size: Buffer.byteLength(content),
    });
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      let body: unknown;
      if (url.pathname === "/repositories/123456") {
        body = {
          id: 123456,
          node_id: "R_kgDOExample",
          full_name: "acme/tool",
          html_url: "https://github.com/acme/tool",
          owner: { login: "acme", type: "Organization" },
          name: "tool",
          description: "A software tool.",
          homepage: null,
          visibility: "public",
          private: false,
          disabled: false,
          archived: false,
          fork: false,
          default_branch: "main",
          license: { spdx_id: "MIT", name: "MIT License" },
        };
      } else if (url.pathname.endsWith("/readme")) body = file("README.md", relevantReadme);
      else if (url.pathname.endsWith("/license")) body = file("LICENSE", "MIT License\nCopyright (c) 2026");
      else if (url.pathname.endsWith("/contents")) body = [
        { name: "package.json", path: "package.json", type: "file", sha: "c".repeat(40), size: 30 },
        { name: "pyproject.toml", path: "pyproject.toml", type: "file", sha: "e".repeat(40), size: Buffer.byteLength(longPyproject) },
      ];
      else if (url.pathname.endsWith("/contents/package.json")) body = file("package.json", "{\"name\":\"tool\"}");
      else if (url.pathname.endsWith("/contents/pyproject.toml")) body = file("pyproject.toml", longPyproject);
      else if (url.pathname.endsWith("/commits")) body = [{ sha: "d".repeat(40), html_url: "https://github.com/acme/tool/commit/example", commit: { message: "Update tool", author: { date: "2026-11-09T12:00:00Z" } } }];
      else if (url.pathname.endsWith("/releases")) body = [];
      else throw new Error(`Unexpected request ${path}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };

    const evidence = await new GitHubEvidenceCollector({
      fetch: fetcher,
      token: null,
      now: () => new Date("2026-11-10T12:00:00.000Z"),
      requestPauseMs: 0,
      catalogSnapshot,
    }).collect(item);

    expect(evidence.collector_status).toBe("complete");
    expect(evidence.sources.find((source) => source.kind === "repository_metadata")?.metadata.id).toBe("123456");
    const readmeSources = evidence.sources.filter((source) => source.kind === "readme");
    expect(readmeSources).toHaveLength(1);
    expect(readmeSources[0]?.metadata).toMatchObject({
      complete_file: false,
      relevant_sections_complete: true,
      relevance_coverage: { product_identity: true, capabilities: true, usage: true, development: true },
      content_sha256: createHash("sha256").update(relevantReadme).digest("hex"),
    });
    expect(readmeSources[0]?.text).not.toContain("Older release notes");
    const manifestParts = evidence.sources.filter((source) => source.kind === "manifest" && source.metadata.path === "pyproject.toml");
    expect(manifestParts.length).toBeGreaterThan(1);
    expect(manifestParts.every((source) => source.metadata.complete_file === true && source.sha256 === createHash("sha256").update(longPyproject).digest("hex"))).toBe(true);
    expect(evidence.sources.find((source) => source.kind === "outlist_catalog")?.metadata).toMatchObject({
      duplicate_check: { candidate_identity_verified: true, has_material_duplicate_conflict: false },
    });
  });

  it("collects complete root-inventoried license texts that supplement GitHub's primary license notice", async () => {
    const licenseText = new Map([
      ["LICENSE.txt", 'Outside enterprise, source is AGPL. Enterprise source uses "ee/LICENSE".'],
      ["LICENSE-AGPL.txt", ["GNU AFFERO GENERAL PUBLIC LICENSE", "Version 3"].join("\n")],
      ["LICENSE-MCL.txt", "Metabase Commercial License terms."],
      ["ee/LICENSE", "Enterprise-specific source terms."],
    ]);
    const file = (path: string, content: string) => ({
      path,
      html_url: `https://github.com/acme/tool/blob/main/${path}`,
      content: Buffer.from(content).toString("base64"),
      sha: createHash("sha1").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    });
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      let body: unknown;
      if (url.pathname === "/repositories/123456") {
        body = { id: 123456, full_name: "acme/tool", owner: { login: "acme", type: "Organization" }, name: "tool",
          visibility: "public", private: false, disabled: false, archived: false, fork: false, default_branch: "main",
          license: { spdx_id: "NOASSERTION", name: "Other" } };
      } else if (url.pathname.endsWith("/readme")) body = file("README.md", ["# Tool", "A public software product with a complete source implementation."].join("\n"));
      else if (url.pathname.endsWith("/license")) body = file("LICENSE.txt", licenseText.get("LICENSE.txt")!);
      else if (url.pathname.endsWith("/contents")) body = [
        ...[...licenseText.keys()].map((name) => ({ name, path: name, type: "file", size: licenseText.get(name)!.length })),
        { name: "package.json", path: "package.json", type: "file", size: 18 },
        { name: "ee", path: "ee", type: "dir" },
      ];
      else if (url.pathname === "/repos/acme/tool/contents/LICENSE-AGPL.txt") body = file("LICENSE-AGPL.txt", licenseText.get("LICENSE-AGPL.txt")!);
      else if (url.pathname === "/repos/acme/tool/contents/LICENSE-MCL.txt") body = file("LICENSE-MCL.txt", licenseText.get("LICENSE-MCL.txt")!);
      else if (url.pathname === "/repos/acme/tool/contents/ee/LICENSE") body = file("ee/LICENSE", licenseText.get("ee/LICENSE")!);
      else if (url.pathname === "/repos/acme/tool/contents/package.json") body = file("package.json", JSON.stringify({ name: "tool" }));
      else if (url.pathname.endsWith("/commits")) body = [{ sha: "d".repeat(40), commit: { message: "Update tool", author: { date: "2026-11-09T12:00:00Z" } } }];
      else if (url.pathname.endsWith("/releases")) body = [];
      else throw new Error(`Unexpected request ${url.pathname}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await new GitHubEvidenceCollector({
      fetch: fetcher, token: null, requestPauseMs: 0, catalogSnapshot,
      now: () => new Date("2026-11-10T12:00:00.000Z"),
    }).collect(item);

    const licenses = result.sources.filter((source) => source.kind === "license");
    expect(result.collector_status).toBe("complete");
    expect(licenses.map((source) => source.metadata.path).sort()).toEqual(["LICENSE-AGPL.txt", "LICENSE-MCL.txt", "LICENSE.txt", "ee/LICENSE"]);
    expect(licenses.every((source) => source.metadata.complete_file === true && source.sha256 === source.metadata.content_sha256)).toBe(true);
    expect(result.sources.find((source) => source.kind === "root_contents")?.metadata).toMatchObject({
      license_file_paths: ["LICENSE-AGPL.txt", "LICENSE-MCL.txt", "LICENSE.txt", "ee/LICENSE"],
      license_files_truncated: false,
    });
  });
});
