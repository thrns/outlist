import { createHash } from "node:crypto";
import { z } from "zod";
import type { CatalogReviewQueueItem } from "./queue";
import { EvidencePackageSchema, EvidenceSourceSchema, type EvidencePackage } from "./schema";
import type { OutlistCatalogSnapshot } from "./catalog";
import { buildCatalogDuplicateCheck } from "./duplicates";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ADDITIONAL_ROOT_LICENSE_FILES = 10;
const MAX_REFERENCED_LICENSE_FILES = 1;
const MAX_LICENSE_EVIDENCE_BYTES = 150_000;

export const OUTLIST_CATEGORIES = [
  { slug: "developer-tools", name: "Developer Tools", active: true },
  { slug: "ai-machine-learning", name: "AI & Machine Learning", active: true },
  { slug: "productivity", name: "Productivity", active: true },
  { slug: "design", name: "Design", active: true },
  { slug: "analytics", name: "Analytics", active: true },
  { slug: "infrastructure", name: "Infrastructure", active: true },
  { slug: "data-databases", name: "Data & Databases", active: true },
  { slug: "communication", name: "Communication", active: true },
  { slug: "self-hosted", name: "Self-hosted", active: true },
  { slug: "security-privacy", name: "Security & Privacy", active: true },
  { slug: "automation-workflows", name: "Automation & Workflows", active: true },
] as const;

export class GitHubEvidenceError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly rateLimited = false) {
    super(message);
    this.name = "GitHubEvidenceError";
  }
}

type HttpResult = { status: number; url: string; headers: Headers; body: unknown; raw: string };
type Source = z.infer<typeof EvidenceSourceSchema>;

export type EvidenceCollectorOptions = {
  fetch?: typeof fetch;
  token?: string | null;
  now?: () => Date;
  requestPauseMs?: number;
  catalogSnapshot?: OutlistCatalogSnapshot | null;
};

export class GitHubEvidenceCollector {
  readonly #fetch: typeof fetch;
  readonly #token: string | undefined;
  readonly #now: () => Date;
  readonly #requestPauseMs: number;
  readonly #catalogSnapshot: OutlistCatalogSnapshot | null;

  constructor(options: EvidenceCollectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#token = options.token === null ? undefined : (options.token ?? process.env.GITHUB_TOKEN)?.trim() || undefined;
    this.#now = options.now ?? (() => new Date());
    this.#requestPauseMs = options.requestPauseMs ?? 250;
    this.#catalogSnapshot = options.catalogSnapshot ?? null;
  }

  async collect(item: CatalogReviewQueueItem, catalogSnapshot = this.#catalogSnapshot): Promise<EvidencePackage> {
    const sources: Source[] = [];
    const notes: string[] = [];
    let status: EvidencePackage["collector_status"] = "complete";
    const repositoryUrl = `${GITHUB_API}/repositories/${encodeURIComponent(item.repository_id)}`;

    let repositoryResponse: HttpResult;
    try {
      repositoryResponse = await this.#request(repositoryUrl);
    } catch (error) {
      const rateLimited = error instanceof GitHubEvidenceError && error.rateLimited;
      return this.#package(item, sources, [this.#message(error)], rateLimited ? "rate_limited" : "failed");
    }
    const observedAt = this.#now().toISOString();
    const repositoryBody = isRecord(repositoryResponse.body) ? repositoryResponse.body : null;
    sources.push(this.#jsonSource("repository-metadata", "repository_metadata", repositoryResponse, observedAt, {
      id: identifierValue(repositoryBody?.id),
      node_id: stringValue(repositoryBody?.node_id),
      full_name: stringValue(repositoryBody?.full_name),
      html_url: stringValue(repositoryBody?.html_url),
      owner_login: nestedString(repositoryBody, "owner", "login"),
      owner_type: nestedString(repositoryBody, "owner", "type"),
      description: stringValue(repositoryBody?.description),
      homepage: stringValue(repositoryBody?.homepage),
      visibility: stringValue(repositoryBody?.visibility),
      private: booleanValue(repositoryBody?.private),
      disabled: booleanValue(repositoryBody?.disabled),
      archived: booleanValue(repositoryBody?.archived),
      fork: booleanValue(repositoryBody?.fork),
      default_branch: stringValue(repositoryBody?.default_branch),
      created_at: stringValue(repositoryBody?.created_at),
      updated_at: stringValue(repositoryBody?.updated_at),
      pushed_at: stringValue(repositoryBody?.pushed_at),
      stars: numberValue(repositoryBody?.stargazers_count),
      forks: numberValue(repositoryBody?.forks_count),
      topics: Array.isArray(repositoryBody?.topics) ? repositoryBody.topics.filter((value): value is string => typeof value === "string").slice(0, 100) : [],
      license_spdx_id: nestedString(repositoryBody, "license", "spdx_id"),
      license_name: nestedString(repositoryBody, "license", "name"),
      mirror_url: stringValue(repositoryBody?.mirror_url),
      parent: identitySummary(repositoryBody?.parent),
      source: identitySummary(repositoryBody?.source),
    }));

    if (repositoryResponse.status !== 200 || !repositoryBody) {
      return this.#package(item, sources, [`Repository identity lookup returned HTTP ${repositoryResponse.status}.`], "partial");
    }
    if (String(repositoryBody.id) !== item.repository_id
      || String(repositoryBody.full_name ?? "").toLowerCase() !== item.full_name.toLowerCase()) {
      throw new GitHubEvidenceError("GitHub repository ID or canonical full name does not match the imported candidate.", false);
    }
    const duplicateCheck = buildCatalogDuplicateCheck(item, catalogSnapshot, repositoryBody, this.#now());
    sources.push(this.#catalogSource(duplicateCheck, catalogSnapshot));

    const owner = stringValue(repositoryBody.owner && isRecord(repositoryBody.owner) ? repositoryBody.owner.login : null);
    const repo = stringValue(repositoryBody.name);
    const branch = stringValue(repositoryBody.default_branch) ?? "HEAD";
    if (!owner || !repo) return this.#package(item, sources, ["GitHub repository owner or name is absent."], "partial");
    const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const readmeResult = await this.#getFile(`${base}/readme?ref=${encodeURIComponent(branch)}`, "readme", "readme", sources, notes);
    if (readmeResult.status === "rate_limited") return this.#package(item, sources, notes, "rate_limited");
    await this.#pause();
    const licenseResult = await this.#getFile(`${base}/license?ref=${encodeURIComponent(branch)}`, "license", "license", sources, notes);
    if (licenseResult.status === "rate_limited") return this.#package(item, sources, notes, "rate_limited");
    await this.#pause();
    const contentsResult = await this.#getJson(`${base}/contents?ref=${encodeURIComponent(branch)}&per_page=1000`, "root-contents", "root_contents", sources, notes);
    if (contentsResult.kind === "rate_limited") return this.#package(item, sources, notes, "rate_limited");
    const rootEntries = Array.isArray(contentsResult.body) ? contentsResult.body.filter(isRecord) : [];
    const rootLicenseEntries = rootEntries
      .filter((entry) => entry.type === "file" && typeof entry.name === "string" && isRootLicenseFile(entry.name)
        && typeof entry.path === "string")
      .sort((left, right) => licenseFileRank(String(left.name)) - licenseFileRank(String(right.name)) || String(left.path).localeCompare(String(right.path)));
    let discoveredLicensePaths = rootLicenseEntries.map((entry) => String(entry.path));
    const rootContentsSource = sources.find((source) => source.kind === "root_contents" && source.status === "available");
    if (rootContentsSource) {
      rootContentsSource.metadata.license_file_paths = discoveredLicensePaths;
      rootContentsSource.metadata.license_files_truncated = discoveredLicensePaths.length > MAX_ADDITIONAL_ROOT_LICENSE_FILES + 1;
    }
    const licenseEndpointPath = sources.find((source) => source.id === "license")?.metadata.path;
    const additionalLicenseEntries = rootLicenseEntries
      .filter((entry) => entry.path !== licenseEndpointPath)
      .slice(0, MAX_ADDITIONAL_ROOT_LICENSE_FILES);
    for (const entry of additionalLicenseEntries) {
      const path = String(entry.path);
      const id = `license-${slugify(String(entry.name))}`;
      await this.#pause();
      const budget = Math.max(0, MAX_LICENSE_EVIDENCE_BYTES - retainedLicenseContentBytes(sources));
      const result = await this.#getFile(`${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, id, "license", sources, notes, undefined, budget);
      if (result.status === "rate_limited") return this.#package(item, sources, notes, "rate_limited");
    }
    const rootDirectories = new Set(rootEntries.filter((entry) => entry.type === "dir" && typeof entry.path === "string")
      .map((entry) => String(entry.path)));
    const referencedLicensePaths = [...new Set(extractReferencedLicensePaths(sources))]
      .filter((path) => !discoveredLicensePaths.includes(path) && rootDirectories.has(path.split("/")[0]!));
    const boundedReferencedLicensePaths = referencedLicensePaths.slice(0, MAX_REFERENCED_LICENSE_FILES);
    discoveredLicensePaths = [...discoveredLicensePaths, ...referencedLicensePaths];
    if (rootContentsSource) {
      rootContentsSource.metadata.license_file_paths = discoveredLicensePaths;
      if (referencedLicensePaths.length > MAX_REFERENCED_LICENSE_FILES) rootContentsSource.metadata.license_files_truncated = true;
    }
    for (const path of boundedReferencedLicensePaths) {
      await this.#pause();
      const budget = Math.max(0, MAX_LICENSE_EVIDENCE_BYTES - retainedLicenseContentBytes(sources));
      const result = await this.#getFile(`${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, `license-ref-${slugify(path)}`, "license", sources, notes, undefined, budget);
      if (result.status === "rate_limited") return this.#package(item, sources, notes, "rate_limited");
    }
    const manifestNames = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "composer.json", "Gemfile", "mix.exs", "deno.json", "pubspec.yaml", "CMakeLists.txt", "Makefile"];
    const manifests = rootEntries.filter((entry) => typeof entry.name === "string" && manifestNames.includes(entry.name))
      .sort((left, right) => manifestNames.indexOf(String(left.name)) - manifestNames.indexOf(String(right.name))).slice(0, 3);
    for (const [index, manifest] of manifests.entries()) {
      if (typeof manifest.path !== "string") continue;
      await this.#pause();
      await this.#getFile(`${base}/contents/${manifest.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, index === 0 ? "manifest" : `manifest-${slugify(manifest.name)}`, "manifest", sources, notes, 8_000);
    }

    const docsDirectory = rootEntries.find((entry) => entry.name === "docs" && entry.type === "dir");
    if (docsDirectory) {
      await this.#pause();
      const docs = await this.#getJson(`${base}/contents/docs?ref=${encodeURIComponent(branch)}&per_page=1000`, "documentation-index", "documentation", sources, notes);
      if (docs.kind === "rate_limited") return this.#package(item, sources, notes, "rate_limited");
      const docsEntries = Array.isArray(docs.body) ? docs.body.filter(isRecord) : [];
      let docIndex = chooseDocumentationFile(docsEntries);
      if (!docIndex) {
        const documentationDirectories = docsEntries
          .filter((entry) => entry.type === "dir" && typeof entry.path === "string")
          .sort((left, right) => documentationDirectoryRank(String(left.name)) - documentationDirectoryRank(String(right.name))).slice(0, 2);
        for (const documentationDirectory of documentationDirectories) {
          if (typeof documentationDirectory.path !== "string") continue;
          await this.#pause();
          const nested = await this.#getJson(`${base}/contents/${documentationDirectory.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}&per_page=1000`, `documentation-${slugify(documentationDirectory.name)}-index`, "documentation", sources, notes);
          if (nested.kind === "rate_limited") return this.#package(item, sources, notes, "rate_limited");
          docIndex = chooseDocumentationFile(Array.isArray(nested.body) ? nested.body.filter(isRecord) : []);
          if (docIndex) break;
        }
      }
      if (docIndex && typeof docIndex.path === "string") {
        await this.#pause();
        await this.#getFile(`${base}/contents/${docIndex.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, "documentation-index-file", "documentation", sources, notes, 8_000);
      }
    }

    await this.#pause();
    const commitResult = await this.#getJson(`${base}/commits?per_page=1`, "latest-commit", "latest_commit", sources, notes);
    if (commitResult.kind === "rate_limited") return this.#package(item, sources, notes, "rate_limited");
    await this.#pause();
    const releasesResult = await this.#getJson(`${base}/releases?per_page=10`, "release-history", "releases", sources, notes);
    if (releasesResult.kind === "rate_limited") return this.#package(item, sources, notes, "rate_limited");

    const hasSourceTreeEvidence = rootContentsSource?.metadata.source_tree_complete === true
      && isRecord(rootContentsSource.metadata.software_signals)
      && (rootContentsSource.metadata.software_signals.source_code === true || rootContentsSource.metadata.software_signals.test_or_build_files === true);
    if (readmeResult.status !== "available" || licenseResult.status !== "available" || contentsResult.kind !== "ok") status = "partial";
    if (!sources.some((source) => source.kind === "manifest" && source.status === "available") && !hasSourceTreeEvidence) {
      notes.push("No supported software manifest or root-level source/build/test evidence was found.");
      status = "partial";
    }
    if (readmeResult.status === "available" && !sources.some((source) => source.kind === "readme" && source.metadata.relevant_sections_complete === true)) status = "partial";
    if (licenseResult.status === "available" && !sources.some((source) => source.kind === "license" && source.metadata.complete_file === true)) status = "partial";
    const collectedLicensePaths = new Set(sources.filter((source) => source.kind === "license" && source.status === "available" && source.metadata.complete_file === true)
      .map((source) => source.metadata.path).filter((path): path is string => typeof path === "string"));
    const unavailableRootLicensePaths = discoveredLicensePaths.filter((path) => !collectedLicensePaths.has(path));
    if (rootContentsSource?.metadata.license_files_truncated === true || unavailableRootLicensePaths.length > 0) {
      notes.push("Not every bounded root-level license file was collected completely; license applicability needs review.");
      status = "partial";
    }
    // Documentation indexes, commit detail, and release history are useful context but are not required when
    // current repository metadata, a complete README, legal terms, and source/build evidence are present.
    void commitResult;
    void releasesResult;
    return this.#package(item, sources, notes, status);
  }

  #package(item: CatalogReviewQueueItem, sources: Source[], notes: string[], collectorStatus: EvidencePackage["collector_status"]): EvidencePackage {
    return EvidencePackageSchema.parse({
      schema: "outlist.catalog.codex-evidence.v1",
      candidate_id: item.candidate_id,
      repository_id: item.repository_id,
      full_name: item.full_name,
      project_id: item.project_id,
      pipeline_outcome: item.pipeline_outcome,
      pipeline_details: item.pipeline_details,
      existing_listing: item.existing_listing,
      outlist_categories: OUTLIST_CATEGORIES,
      collected_at: this.#now().toISOString(),
      collector_status: collectorStatus,
      sources,
      collection_notes: notes.slice(0, 20),
    });
  }

  async #getFile(
    url: string,
    id: string,
    kind: "readme" | "license" | "manifest" | "documentation",
    sources: Source[],
    notes: string[],
    textLimit = kind === "readme" ? 24_000 : kind === "license" ? 16_000 : 8_000,
    maxRetainedBytes = Number.POSITIVE_INFINITY,
  ): Promise<{ status: Source["status"] | "rate_limited" }> {
    let response: HttpResult;
    try { response = await this.#request(url); }
    catch (error) {
      if (error instanceof GitHubEvidenceError && error.rateLimited) return { status: "rate_limited" };
      notes.push(`${kind} fetch failed: ${this.#message(error)}`);
      return { status: "unavailable" };
    }
    if (response.status === 404) {
      sources.push(this.#source(id, kind, url, "not_found", this.#now().toISOString(), null, null, {}));
      return { status: "not_found" };
    }
    if (response.status !== 200 || !isRecord(response.body) || typeof response.body.content !== "string") {
      notes.push(`${kind} content returned HTTP ${response.status} or an unrecognized file payload.`);
      sources.push(this.#source(id, kind, url, "unavailable", this.#now().toISOString(), null, null, { http_status: response.status }));
      return { status: "unavailable" };
    }
    const text = Buffer.from(response.body.content.replace(/\s+/g, ""), "base64").toString("utf8");
    const sha256 = createHash("sha256").update(text).digest("hex");
    const filePath = stringValue(response.body.path);
    const budgetExceeded = Buffer.byteLength(text, "utf8") > maxRetainedBytes;
    const bounded: EvidencePartSelection = budgetExceeded
      ? { parts: [], strategy: "bounded-content-not-retained", sections: [], completeFile: false, relevantSectionsComplete: false,
        relevanceCoverage: { product_identity: false, capabilities: false, usage: false, development: false } }
      : selectEvidenceParts(text, kind, filePath);
    if (budgetExceeded) notes.push(`${kind} file ${filePath ?? "(unknown path)"} was hash-checked but omitted because the bounded license text budget was exhausted.`);
    const contentUrl = stringValue(response.body.html_url) ?? url;
    const observedAt = this.#now().toISOString();
    for (const [partIndex, part] of bounded.parts.entries()) {
      sources.push(this.#source(partIndex === 0 ? id : `${id}-part-${partIndex + 1}`, kind, contentUrl, "available", observedAt, sha256, part, {
        path: filePath,
        repository_file_sha: stringValue(response.body.sha),
        size_bytes: numberValue(response.body.size) ?? Buffer.byteLength(text, "utf8"),
        content_sha256: sha256,
        initial_text_limit: textLimit,
        extraction_strategy: bounded.strategy,
        license_text_budget_exceeded: budgetExceeded,
        selected_sections: bounded.sections,
        relevance_coverage: bounded.relevanceCoverage,
        relevant_sections_complete: bounded.relevantSectionsComplete,
        complete_file: bounded.completeFile,
        truncated: !bounded.completeFile,
        content_part_index: partIndex + 1,
        content_part_count: bounded.parts.length,
      }));
    }
    if (bounded.parts.length === 0) {
      sources.push(this.#source(id, kind, contentUrl, "available", observedAt, sha256, null, {
        path: filePath, repository_file_sha: stringValue(response.body.sha),
        size_bytes: numberValue(response.body.size) ?? Buffer.byteLength(text, "utf8"), content_sha256: sha256,
        initial_text_limit: textLimit, extraction_strategy: "bounded-content-not-retained", selected_sections: [],
        license_text_budget_exceeded: budgetExceeded,
        relevance_coverage: { product_identity: false, capabilities: false, usage: false, development: false },
        relevant_sections_complete: false, complete_file: false, truncated: true,
      }));
    }
    return { status: "available" };
  }

  async #getJson(
    url: string,
    id: string,
    kind: "root_contents" | "documentation" | "latest_commit" | "releases",
    sources: Source[],
    notes: string[],
  ): Promise<{ kind: "ok" | "not_found" | "unavailable" | "rate_limited"; body: unknown }> {
    try {
      const response = await this.#request(url);
      const observedAt = this.#now().toISOString();
      const digest = createHash("sha256").update(response.raw).digest("hex");
      if (response.status === 404) {
        sources.push(this.#source(id, kind, url, "not_found", observedAt, digest, null, { http_status: 404 }));
        return { kind: "not_found", body: null };
      }
      if (response.status !== 200) {
        notes.push(`${kind} fetch returned HTTP ${response.status}.`);
        sources.push(this.#source(id, kind, url, "unavailable", observedAt, digest, null, { http_status: response.status }));
        return { kind: "unavailable", body: null };
      }
      const body = response.body;
      const normalized = kind === "root_contents" && Array.isArray(body)
        ? body.filter(isRecord).map((entry) => ({ name: entry.name, path: entry.path, type: entry.type, sha: entry.sha, size: entry.size }))
        : kind === "latest_commit" && Array.isArray(body)
          ? body.slice(0, 1).map((entry) => isRecord(entry) ? ({ sha: entry.sha, html_url: entry.html_url, message: nestedString(entry, "commit", "message"), date: nestedString(entry, "commit", "author", "date") }) : entry)
          : kind === "releases" && Array.isArray(body)
            ? body.slice(0, 10).map((entry) => isRecord(entry) ? ({ tag_name: entry.tag_name, name: entry.name, html_url: entry.html_url, published_at: entry.published_at, draft: entry.draft, prerelease: entry.prerelease }) : entry)
            : body;
      const metadata = kind === "root_contents" && Array.isArray(body)
        ? { data: normalized, source_tree_complete: body.length < 1_000, source_tree_truncated: body.length >= 1_000, software_signals: rootSoftwareSignals(body) }
        : { data: normalized };
      sources.push(this.#source(id, kind, url, "available", observedAt, digest, null, metadata));
      return { kind: "ok", body };
    } catch (error) {
      if (error instanceof GitHubEvidenceError && error.rateLimited) return { kind: "rate_limited", body: null };
      notes.push(`${kind} fetch failed: ${this.#message(error)}`);
      return { kind: "unavailable", body: null };
    }
  }

  async #request(url: string): Promise<HttpResult> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com") {
      throw new GitHubEvidenceError("Evidence collector only permits requests to the GitHub API host.", false);
    }
    const headers = new Headers({
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": "outlist-catalog-review/1.0",
    });
    if (this.#token) headers.set("authorization", `Bearer ${this.#token}`);
    let response: Response;
    try {
      response = await this.#fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new GitHubEvidenceError("GitHub API request failed before a response was received.", true);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new GitHubEvidenceError("GitHub evidence response exceeded the 2 MiB size limit.", false);
    const raw = new TextDecoder().decode(bytes);
    let body: unknown = null;
    if (raw) {
      try { body = JSON.parse(raw); }
      catch { throw new GitHubEvidenceError("GitHub returned malformed JSON evidence.", true); }
    }
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (response.status === 429 || remaining === "0" || response.headers.has("retry-after")) {
        const reset = response.headers.get("x-ratelimit-reset");
        throw new GitHubEvidenceError(`GitHub API rate limit reached${reset ? `; reset epoch ${reset}` : "."}`, true, true);
      }
    }
    if (response.status >= 500) throw new GitHubEvidenceError(`GitHub API returned HTTP ${response.status}.`, true);
    return { status: response.status, url, headers: response.headers, body, raw };
  }

  #source(id: string, kind: Source["kind"], url: string, status: Source["status"], observedAt: string, sha256: string | null, text: string | null, metadata: Record<string, unknown>): Source {
    return { id, kind, url, status, observed_at: observedAt, sha256, text, metadata };
  }

  #jsonSource(id: string, kind: Source["kind"], response: HttpResult, observedAt: string, metadata: Record<string, unknown>): Source {
    return this.#source(id, kind, response.url, response.status === 200 ? "available" : response.status === 404 ? "not_found" : "unavailable", observedAt,
      createHash("sha256").update(response.raw).digest("hex"), null, { ...metadata, http_status: response.status });
  }

  #catalogSource(check: ReturnType<typeof buildCatalogDuplicateCheck>, snapshot: OutlistCatalogSnapshot | null): Source {
    const available = snapshot !== null && check.snapshot_complete && check.snapshot_fresh;
    return this.#source("outlist-catalog-index", "outlist_catalog",
      snapshot ? `urn:outlist:catalog-snapshot:${snapshot.sha256}` : "urn:outlist:catalog-snapshot:unavailable",
      available ? "available" : "unavailable",
      snapshot?.captured_at ?? this.#now().toISOString(),
      snapshot?.sha256 ?? null,
      null,
      {
        provenance: snapshot ? "Read-only snapshot of Supabase repositories, repository_candidates, and projects tables." : "No verified fresh Outlist catalog snapshot was supplied.",
        source_tables: snapshot?.source_tables ?? ["repositories", "repository_candidates", "projects"],
        snapshot_project_ref: snapshot?.project_ref ?? null,
        duplicate_check: check,
      });
  }

  async #pause() {
    if (this.#requestPauseMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#requestPauseMs));
  }

  #message(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 400) : "Unknown source collection error.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identitySummary(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return {
    id: identifierValue(value.id),
    full_name: stringValue(value.full_name),
    html_url: stringValue(value.html_url),
  };
}

function slugify(value: unknown): string {
  return String(value ?? "manifest").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "manifest";
}

function rootSoftwareSignals(entries: unknown[]): Record<string, boolean> {
  const names = entries.filter(isRecord).map((entry) => String(entry.name ?? "").toLowerCase());
  const sourceCode = names.some((name) => ["src", "source", "lib", "packages", "cmd", "internal", "app", "apps", "crates"].includes(name)
    || /\.(py|js|jsx|ts|tsx|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|ex|exs|dart)$/.test(name));
  const testOrBuildFiles = names.some((name) => ["test", "tests", "spec", "specs", "__tests__", "tox.ini", "pytest.ini", "makefile", "justfile", "dockerfile", "meson.build", "build.gradle", "build.gradle.kts", "cargo.toml", "go.mod", "pyproject.toml", "package.json", "pom.xml"].includes(name)
    || /(^|[-_.])(test|spec)([-_.]|$)/.test(name));
  return { source_code: sourceCode, test_or_build_files: testOrBuildFiles };
}

function chooseDocumentationFile(entries: Record<string, unknown>[]): Record<string, unknown> | null {
  return entries.filter((entry) => typeof entry.path === "string" && typeof entry.name === "string"
    && /\.(md|mdx|rst|txt)$/i.test(entry.name))
    .sort((left, right) => documentationFileRank(String(left.name)) - documentationFileRank(String(right.name)))[0] ?? null;
}

function isRootLicenseFile(name: string): boolean { return /^(?:LICENSE|COPYING)(?:[._-].+)?$/i.test(name); }
function extractReferencedLicensePaths(sources: Source[]): string[] {
  const references: string[] = [];
  for (const source of sources.filter((item) => item.kind === "license" && item.status === "available" && item.text !== null)) {
    for (const match of source.text!.matchAll(/(?<![A-Za-z0-9_.-])((?:[A-Za-z0-9_.-]+\/)+(?:LICENSE|COPYING)(?:[._-][A-Za-z0-9_.-]+)?)(?![A-Za-z0-9_.-])/gi)) {
      const path = match[1]!;
      if (path.split("/").every((part) => part !== "." && part !== "..")) references.push(path);
    }
  }
  return references;
}
function licenseFileRank(name: string): number {
  const normalized = name.toLowerCase();
  return /(?:agpl|gpl|lgpl)/.test(normalized) ? 0 : /(?:commercial|mcl|enterprise)/.test(normalized) ? 1 : 2;
}
function retainedLicenseContentBytes(sources: Source[]): number {
  const paths = new Map<string, number>();
  for (const source of sources.filter((item) => item.kind === "license" && item.text !== null)) {
    const path = typeof source.metadata.path === "string" ? source.metadata.path : source.id;
    paths.set(path, (paths.get(path) ?? 0) + Buffer.byteLength(source.text ?? "", "utf8"));
  }
  return [...paths.values()].reduce((total, value) => total + value, 0);
}

function documentationDirectoryRank(name: string): number {
  const value = name.toLowerCase();
  if (/architecture|overview|concept/.test(value)) return 0;
  if (/guide|getting-started|quickstart/.test(value)) return 1;
  if (/api|reference/.test(value)) return 2;
  return 3;
}

function documentationFileRank(name: string): number {
  const value = name.toLowerCase();
  if (/^(readme|index|overview|architecture|getting-started|quickstart)(\.|$)/.test(value)) return 0;
  if (/install|usage|concept|pipeline|transport/.test(value)) return 1;
  return 2;
}

type EvidencePartSelection = {
  parts: string[];
  strategy: "complete-file" | "complete-relevant-sections" | "relevant-sections-incomplete" | "bounded-content-not-retained";
  sections: string[];
  completeFile: boolean;
  relevantSectionsComplete: boolean;
  relevanceCoverage: { product_identity: boolean; capabilities: boolean; usage: boolean; development: boolean };
};

function selectEvidenceParts(text: string, kind: "readme" | "license" | "manifest" | "documentation", filePath: string | null): EvidencePartSelection {
  const maxPart = 30_000;
  if (kind === "license" || kind === "manifest") {
    const fullFileLimit = kind === "license" ? maxPart * 4 : maxPart * 2;
    if (text.length <= fullFileLimit) {
      const parts = splitBounded(text, maxPart);
      return { parts, strategy: "complete-file", sections: [], completeFile: true, relevantSectionsComplete: true,
        relevanceCoverage: { product_identity: true, capabilities: true, usage: true, development: true } };
    }
    if (kind === "manifest") {
      const selected = extractRelevantManifestSections(text, filePath);
      if (selected.text.length <= maxPart * 2 && selected.complete) {
        return { parts: splitBounded(selected.text, maxPart), strategy: "complete-relevant-sections", sections: selected.sections, completeFile: false, relevantSectionsComplete: true,
          relevanceCoverage: { product_identity: true, capabilities: true, usage: true, development: true } };
      }
    }
    return { parts: [], strategy: "bounded-content-not-retained", sections: [], completeFile: false, relevantSectionsComplete: false,
      relevanceCoverage: { product_identity: false, capabilities: false, usage: false, development: false } };
  }
  if (text.length <= maxPart) {
    return { parts: [text], strategy: "complete-file", sections: [], completeFile: true, relevantSectionsComplete: true,
      relevanceCoverage: { product_identity: true, capabilities: true, usage: true, development: true } };
  }
  const selected = extractRelevantMarkdownSections(text);
  const coverage = markdownRelevanceCoverage(selected.sections, selected.bodies, text);
  const relevantSectionsComplete = coverage.product_identity && coverage.capabilities && coverage.usage;
  if (selected.text.length > maxPart * 2 || !selected.complete) {
    return { parts: splitBounded(selected.text.slice(0, maxPart * 2), maxPart), strategy: "relevant-sections-incomplete", sections: selected.sections, completeFile: false, relevantSectionsComplete: false, relevanceCoverage: coverage };
  }
  return { parts: splitBounded(selected.text, maxPart), strategy: relevantSectionsComplete ? "complete-relevant-sections" : "relevant-sections-incomplete",
    sections: selected.sections, completeFile: false, relevantSectionsComplete, relevanceCoverage: coverage };
}

function markdownRelevanceCoverage(sections: string[], bodies: Record<string, string>, text: string): EvidencePartSelection["relevanceCoverage"] {
  const titles = sections.filter((section) => Boolean(bodies[section]?.replace(/^#{1,6}\s+[^\n]+/m, "").trim())).map((section) => section.toLowerCase());
  const content = text.toLowerCase();
  return {
    product_identity: titles.some((title) => /about|overview|what (?:is|it)|introduction|project|product/.test(title))
      || /(?:^|\n)#[^\n]+\n[\s\S]{0,1200}(?:is|are|provides|builds|framework|library|application|platform)/i.test(text),
    capabilities: titles.some((title) => /feature|capabilit|what you can|supported|product|overview|about/.test(title))
      || /\b(features?|capabilities)\s*[:.\n]|what (?:you|it) can (?:build|do|use)/i.test(content),
    usage: titles.some((title) => /getting started|install|usage|quick ?start|example|cli/.test(title)),
    development: titles.some((title) => /develop|contribut|test|build|architecture/.test(title)),
  };
}

function splitBounded(text: string, maxPart: number): string[] {
  const parts: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxPart) parts.push(text.slice(offset, offset + maxPart));
  return parts;
}

function extractRelevantMarkdownSections(text: string): { text: string; sections: string[]; bodies: Record<string, string>; complete: boolean } {
  const lines = text.split(/\r?\n/);
  const headings: { title: string; start: number; level: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index] ?? "");
    if (match) headings.push({ title: match[2]!, start: index, level: match[1]!.length });
  }
  if (!headings.length) return { text: lines.slice(0, 100).join("\n"), sections: [], bodies: {}, complete: false };

  const relevant = /about|overview|what (?:is|it)|features?|product|getting started|install|usage|quick ?start|example|cli|develop|test|contribut|documentation|license|security|architecture|supported|build/i;
  const selected: { title: string; start: number; end: number }[] = [];
  const prefaceEnd = headings[0]!.start;
  if (prefaceEnd > 0) selected.push({ title: "Introduction", start: 0, end: prefaceEnd });
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    if (!relevant.test(heading.title)) continue;
    let end = lines.length;
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next]!.level <= heading.level) { end = headings[next]!.start; break; }
    }
    selected.push({ title: heading.title, start: heading.start, end });
  }
  const bodies = Object.fromEntries(selected.map((section) => [section.title, lines.slice(section.start, section.end).join("\n")]));
  const picked = selected.map((section) => `<!-- evidence section: ${section.title} -->\n${bodies[section.title]}`);
  return { text: picked.join("\n\n"), sections: selected.map((section) => section.title).slice(0, 40), bodies, complete: selected.length > 0 };
}

function extractRelevantManifestSections(text: string, filePath: string | null): { text: string; sections: string[]; complete: boolean } {
  if (filePath?.toLowerCase().endsWith(".json")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const keys = ["name", "description", "version", "license", "repository", "homepage", "engines", "scripts", "bin", "dependencies", "peerDependencies", "optionalDependencies", "workspaces", "exports"];
      const selected = Object.fromEntries(keys.filter((key) => Object.hasOwn(parsed, key)).map((key) => [key, parsed[key]]));
      return { text: JSON.stringify(selected, null, 2), sections: Object.keys(selected), complete: Object.keys(selected).length > 0 };
    } catch { return { text: "", sections: [], complete: false }; }
  }
  const lines = text.split(/\r?\n/);
  const headings: { title: string; start: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (/^\[[^\]]+\]$/.test(line)) headings.push({ title: line, start: index });
  }
  if (!headings.length) return { text: "", sections: [], complete: false };
  const relevant = /project|build-system|tool\.(poetry|pdm|hatch|setuptools|pytest|tox|mypy|ruff)|scripts|dependencies|package|workspace|features/i;
  const selected = headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? lines.length;
    return { ...heading, end };
  }).filter((section) => relevant.test(section.title));
  return { text: selected.map((section) => lines.slice(section.start, section.end).join("\n")).join("\n"), sections: selected.map((section) => section.title).slice(0, 40), complete: selected.length > 0 };
}
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
function identifierValue(value: unknown): string | null {
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}
function booleanValue(value: unknown): boolean | null { return typeof value === "boolean" ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function nestedString(value: unknown, ...keys: string[]): string | null {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return stringValue(current);
}
