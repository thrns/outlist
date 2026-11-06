import { z } from "zod";
import type { GitHubApiError } from "../github/errors";
import type {
  GitHubFetchResult,
  GitHubNotModifiedProvenance,
  GitHubProvenance,
  GitHubRelease,
  GitHubRepository,
  GitHubTopicFetchResult,
} from "../github/types";

const sourceStateSchema = z.enum(["present", "null", "absent", "unavailable", "unsupported"]);
const sourceFieldSchema = z.object({ state: sourceStateSchema });
const normalizedSourceSchema = z.object({
  provider: z.literal("github"),
  record_kind: z.enum(["repository", "languages", "topics", "releases"]),
  source_key: z.string().min(1).max(256),
  source_url: z.url({ protocol: /^https$/ }).max(2048),
  fetched_at: z.iso.datetime(),
  http_status: z.number().int().min(100).max(599).nullable(),
  etag: z.string().max(512).nullable(),
  api_version: z.literal("2022-11-28"),
  reuse_context: z.string().max(500),
  source_metadata: z.record(z.string(), z.unknown()),
});

const normalizedRepositorySchema = z.object({
  provider_repository_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  provider_node_id: z.string().min(1).max(256),
  owner_login: z.string().min(1).max(100),
  repository_name: z.string().min(1).max(100),
  full_name: z.string().min(3).max(201),
  canonical_url: z.url({ protocol: /^https$/ }).max(2048),
  description: z.string().nullable(),
  description_state: sourceFieldSchema,
  homepage: z.string().nullable(),
  homepage_state: sourceFieldSchema,
  default_branch: z.string().nullable(),
  default_branch_state: sourceFieldSchema,
  primary_language: z.string().nullable(),
  primary_language_state: sourceFieldSchema,
  stars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  forks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  watchers: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  open_issues: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  is_archived: z.boolean(),
  is_disabled: z.boolean(),
  is_fork: z.boolean(),
  is_private: z.boolean(),
  visibility: z.string().nullable(),
  visibility_state: sourceFieldSchema,
  provider_created_at: z.iso.datetime(),
  provider_updated_at: z.iso.datetime(),
  pushed_at: z.string().nullable(),
  pushed_at_state: sourceFieldSchema,
  source_license_metadata: z.record(z.string(), z.unknown()).nullable(),
  license_state: sourceFieldSchema,
  source_field_states: z.record(z.string(), sourceStateSchema),
  repository_observed_at: z.iso.datetime(),
});

const normalizedPayloadSchema = z.object({
  repository: normalizedRepositorySchema,
  source_records: z.array(normalizedSourceSchema).min(1).max(32),
  languages: z.object({
    complete: z.boolean(),
    entries: z.array(z.object({
      name: z.string().min(1).max(256),
      bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      measured_at: z.iso.datetime(),
      source_index: z.number().int().positive(),
    })).max(1000),
  }),
  topics: z.object({
    complete: z.boolean(),
    entries: z.array(z.object({
      source_topic: z.string().min(1).max(256),
      observed_at: z.iso.datetime(),
      source_index: z.number().int().positive(),
    })).max(1000),
  }),
  releases: z.object({
    complete: z.boolean(),
    bounded: z.literal(true),
    entries: z.array(z.object({
      provider_release_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
      version: z.string().min(1).max(256),
      release_name: z.string().nullable(),
      release_url: z.url({ protocol: /^https$/ }).max(2048),
      published_at: z.string().nullable(),
      is_prerelease: z.boolean(),
      is_draft: z.boolean(),
      source_index: z.number().int().positive(),
      source_observed_at: z.iso.datetime(),
    })).max(100),
  }),
  snapshot: z.object({
    snapshot_date: z.iso.date(),
    captured_at: z.iso.datetime(),
    stars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    forks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    source_index: z.number().int().positive(),
  }),
  partial: z.boolean(),
  retryable_partial: z.boolean(),
  retry_after_ms: z.number().int().min(0).max(604800000).nullable(),
  missing_resources: z.array(z.string().min(1).max(64)).max(3),
});

export type EnrichmentResourceFailure = {
  resource: "languages" | "topics" | "releases";
  kind: string;
  httpStatus?: number;
  retryable: boolean;
  retryAfterMs?: number;
  fetchedAt: string;
  sourceApiUrl: string;
};

export interface EnrichmentResourceResults {
  languages: GitHubFetchResult<Record<string, number>> | EnrichmentResourceFailure;
  topics: GitHubTopicFetchResult | EnrichmentResourceFailure;
  releases: { kind: "ok"; data: GitHubRelease[]; provenance: GitHubProvenance<GitHubRelease[]> } | EnrichmentResourceFailure;
}

export type RepositoryEnrichmentPayload = z.infer<typeof normalizedPayloadSchema>;

export function normalizeRepositoryEnrichment(input: {
  expectedRepositoryId: string;
  repository: GitHubFetchResult<GitHubRepository>;
  resources: EnrichmentResourceResults;
}): RepositoryEnrichmentPayload {
  if (input.repository.kind !== "ok") {
    throw new TypeError("Repository metadata must be a complete GitHub response before normalization.");
  }

  const repository = input.repository.data;
  const expectedId = parseProviderId(input.expectedRepositoryId);
  if (repository.id !== expectedId || String(repository.id) !== input.expectedRepositoryId) {
    throw new TypeError("GitHub returned a repository ID that does not match the candidate.");
  }
  if (`${repository.owner.login}/${repository.name}`.toLowerCase() !== repository.fullName.toLowerCase()) {
    throw new TypeError("GitHub returned inconsistent repository owner and name fields.");
  }
  const canonical = new URL(repository.canonicalUrl);
  if (canonical.protocol !== "https:" || canonical.hostname !== "github.com"
    || canonical.pathname.replace(/\/$/, "").toLowerCase() !== `/${repository.fullName}`.toLowerCase()
    || canonical.search || canonical.hash) {
    throw new TypeError("GitHub returned an inconsistent canonical repository URL.");
  }

  const fields = {
    description: repository.description,
    homepage: repository.homepage,
    default_branch: repository.defaultBranch,
    primary_language: repository.primaryLanguage,
    visibility: repository.visibility,
    pushed_at: repository.pushedAt,
    license: repository.license,
  };
  const states = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.state]));
  const license = repository.license.state === "present"
    ? {
        key: repository.license.value.key,
        name: repository.license.value.name,
        spdx_id: fieldValue(repository.license.value.spdxId),
        url: fieldValue(repository.license.value.url),
        html_url: fieldValue(repository.license.value.htmlUrl),
        node_id: fieldValue(repository.license.value.nodeId),
        field_states: {
          spdx_id: repository.license.value.spdxId.state,
          url: repository.license.value.url.state,
          html_url: repository.license.value.htmlUrl.state,
          node_id: repository.license.value.nodeId.state,
        },
      }
    : null;

  const sourceRecords: RepositoryEnrichmentPayload["source_records"] = [];
  const repositorySourceIndex = addProvenance(sourceRecords, "repository", [input.repository.provenance], repository.id)[0] as number;

  const missing: EnrichmentResourceFailure[] = [];
  const languagePages: Array<{ data: Record<string, number>; sourceIndex: number; fetchedAt: string }> = [];
  if (isFailure(input.resources.languages)) {
    missing.push(input.resources.languages);
    addFailureSource(sourceRecords, input.resources.languages, repository.id);
  } else if (input.resources.languages.kind === "not_modified") {
    throw new TypeError("A 304 language response cannot be treated as a complete enrichment result.");
  } else {
    const sourceIndex = addProvenance(sourceRecords, "languages", [input.resources.languages.provenance], repository.id)[0] as number;
    languagePages.push({
      data: input.resources.languages.data,
      sourceIndex,
      fetchedAt: input.resources.languages.provenance.fetchedAt,
    });
  }

  const topicPages: Array<{ names: string[]; sourceIndex: number; fetchedAt: string }> = [];
  if (isFailure(input.resources.topics)) {
    missing.push(input.resources.topics);
    addFailureSource(sourceRecords, input.resources.topics, repository.id);
  } else if (input.resources.topics.kind === "not_modified") {
    throw new TypeError("A 304 topics response cannot be treated as a complete enrichment result.");
  } else {
    const pages = input.resources.topics.provenance.pages;
    const pageIndexes = addProvenance(sourceRecords, "topics", pages.length > 0 ? pages : [input.resources.topics.provenance], repository.id);
    for (let index = 0; index < (pages.length || 1); index += 1) {
      const page = pages[index];
      topicPages.push({
        names: page?.parsedResponseData ?? input.resources.topics.data,
        sourceIndex: pageIndexes[index] as number,
        fetchedAt: page?.fetchedAt ?? input.resources.topics.provenance.fetchedAt,
      });
    }
  }

  let releasePage: { data: GitHubRelease[]; sourceIndex: number; fetchedAt: string } | null = null;
  if (isFailure(input.resources.releases)) {
    missing.push(input.resources.releases);
    addFailureSource(sourceRecords, input.resources.releases, repository.id);
  } else {
    const sourceIndex = addProvenance(sourceRecords, "releases", [input.resources.releases.provenance], repository.id)[0] as number;
    releasePage = {
      data: input.resources.releases.data,
      sourceIndex,
      fetchedAt: input.resources.releases.provenance.fetchedAt,
    };
  }

  const languagesComplete = !isFailure(input.resources.languages);
  const topicsComplete = !isFailure(input.resources.topics);
  const releasesComplete = !isFailure(input.resources.releases);
  const normalizedLanguages = languagesComplete
    ? normalizeLanguages(languagePages)
    : [];
  const normalizedTopics = topicsComplete
    ? normalizeTopics(topicPages)
    : [];
  const normalizedReleases = releasesComplete && releasePage
    ? normalizeReleases(releasePage)
    : [];
  const observedAt = input.repository.provenance.fetchedAt;
  const snapshotDate = new Date(observedAt).toISOString().slice(0, 10);

  return normalizedPayloadSchema.parse({
    repository: {
      provider_repository_id: String(repository.id),
      provider_node_id: repository.nodeId,
      owner_login: repository.owner.login,
      repository_name: repository.name,
      full_name: repository.fullName,
      canonical_url: repository.canonicalUrl,
      description: fieldValue(repository.description),
      description_state: { state: repository.description.state },
      homepage: fieldValue(repository.homepage),
      homepage_state: { state: repository.homepage.state },
      default_branch: fieldValue(repository.defaultBranch),
      default_branch_state: { state: repository.defaultBranch.state },
      primary_language: fieldValue(repository.primaryLanguage),
      primary_language_state: { state: repository.primaryLanguage.state },
      stars: repository.starCount,
      forks: repository.forkCount,
      watchers: repository.watcherCount,
      open_issues: repository.openIssueCount,
      is_archived: repository.isArchived,
      is_disabled: repository.isDisabled,
      is_fork: repository.isFork,
      is_private: repository.isPrivate,
      visibility: fieldValue(repository.visibility),
      visibility_state: { state: repository.visibility.state },
      provider_created_at: repository.createdAt,
      provider_updated_at: repository.updatedAt,
      pushed_at: fieldValue(repository.pushedAt),
      pushed_at_state: { state: repository.pushedAt.state },
      source_license_metadata: license,
      license_state: { state: repository.license.state },
      source_field_states: states,
      repository_observed_at: observedAt,
    },
    source_records: sourceRecords,
    languages: {
      complete: languagesComplete,
      entries: normalizedLanguages,
    },
    topics: {
      complete: topicsComplete,
      entries: normalizedTopics,
    },
    releases: {
      complete: releasesComplete,
      bounded: true,
      entries: normalizedReleases,
    },
    snapshot: {
      snapshot_date: snapshotDate,
      captured_at: observedAt,
      stars: repository.starCount,
      forks: repository.forkCount,
      source_index: repositorySourceIndex,
    },
    partial: missing.length > 0,
    retryable_partial: missing.length > 0 && missing.every((failure) => failure.retryable),
    retry_after_ms: missing.some((failure) => typeof failure.retryAfterMs === "number")
      ? Math.min(604800000, Math.max(60000, ...missing.map((failure) => failure.retryAfterMs ?? 0)))
      : null,
    missing_resources: [...new Set(missing.map((failure) => failure.resource))],
  });
}

export function githubFailureToResourceFailure(
  resource: EnrichmentResourceFailure["resource"],
  error: unknown,
  sourceApiUrl: string,
  now = new Date(),
): EnrichmentResourceFailure {
  const githubError = error as Partial<GitHubApiError>;
  const kind = typeof githubError.kind === "string" ? githubError.kind : "unexpected";
  const status = typeof githubError.status === "number" ? githubError.status : undefined;
  const retryable = typeof githubError.retryable === "boolean" ? githubError.retryable : true;
  const retryAfterMs = typeof githubError.retryAfterMs === "number" ? githubError.retryAfterMs : undefined;
  return {
    resource,
    kind,
    ...(status === undefined ? {} : { httpStatus: status }),
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    fetchedAt: now.toISOString(),
    sourceApiUrl,
  };
}

export function safeFailureSummary(error: unknown): string {
  const githubError = error as Partial<GitHubApiError>;
  const kind = typeof githubError.kind === "string" && /^[a-z_]{1,64}$/.test(githubError.kind)
    ? githubError.kind
    : "unexpected";
  const status = typeof githubError.status === "number" && Number.isInteger(githubError.status)
    ? ` HTTP ${githubError.status}`
    : "";
  const retryAfterMs = typeof githubError.retryAfterMs === "number" && githubError.retryAfterMs >= 0
    ? `; retry after ${Math.ceil(githubError.retryAfterMs / 1000)}s`
    : "";
  return `${kind}${status}${retryAfterMs}`.slice(0, 500);
}

function normalizeLanguages(pages: Array<{ data: Record<string, number>; sourceIndex: number; fetchedAt: string }>) {
  const byKey = new Map<string, { name: string; bytes: number; measured_at: string; source_index: number }>();
  for (const page of pages) {
    for (const [rawName, bytes] of Object.entries(page.data)) {
      const name = rawName.trim();
      const key = name.toLowerCase();
      if (!name || !Number.isSafeInteger(bytes) || bytes < 0 || byKey.has(key)) {
        throw new TypeError("GitHub returned invalid or duplicate normalized language data.");
      }
      byKey.set(key, { name: rawName, bytes, measured_at: page.fetchedAt, source_index: page.sourceIndex });
    }
  }
  return [...byKey.values()].sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
}

function normalizeTopics(pages: Array<{ names: string[]; sourceIndex: number; fetchedAt: string }>) {
  const byKey = new Map<string, { source_topic: string; observed_at: string; source_index: number }>();
  for (const page of pages) {
    for (const rawTopic of page.names) {
      const sourceTopic = rawTopic.trim();
      const key = sourceTopic.toLowerCase();
      if (!sourceTopic) throw new TypeError("GitHub returned an empty repository topic.");
      if (!byKey.has(key)) {
        byKey.set(key, { source_topic: rawTopic, observed_at: page.fetchedAt, source_index: page.sourceIndex });
      }
    }
  }
  return [...byKey.values()].sort((left, right) => left.source_topic.toLowerCase().localeCompare(right.source_topic.toLowerCase()));
}

function normalizeReleases(page: { data: GitHubRelease[]; sourceIndex: number; fetchedAt: string }) {
  const seen = new Set<string>();
  return page.data.map((release) => {
    const providerReleaseId = String(release.id);
    if (!Number.isSafeInteger(release.id) || release.id < 1 || seen.has(providerReleaseId)) {
      throw new TypeError("GitHub returned invalid or duplicate release identity data.");
    }
    seen.add(providerReleaseId);
    return {
      provider_release_id: providerReleaseId,
      version: release.tagName,
      release_name: fieldValue(release.name),
      release_url: release.htmlUrl,
      published_at: fieldValue(release.publishedAt),
      is_prerelease: release.isPrerelease,
      is_draft: release.isDraft,
      source_index: page.sourceIndex,
      source_observed_at: page.fetchedAt,
    };
  });
}

function addProvenance(
  target: RepositoryEnrichmentPayload["source_records"],
  kind: "repository" | "languages" | "topics" | "releases",
  provenance: Array<GitHubProvenance<unknown> | GitHubNotModifiedProvenance>,
  repositoryId: number,
): number[] {
  const indexes: number[] = [];
  for (const [pageIndex, entry] of provenance.entries()) {
    if (entry.httpStatus === 304) throw new TypeError("Conditional GitHub responses cannot be reused by this enrichment worker.");
    target.push({
      provider: "github",
      record_kind: kind,
      source_key: `github:${kind}:${repositoryId}:${pageIndex + 1}`,
      source_url: entry.sourceApiUrl,
      fetched_at: entry.fetchedAt,
      http_status: entry.httpStatus,
      etag: entry.etag ?? null,
      api_version: entry.apiVersion,
      reuse_context: "Validated source observation; conditional reuse is disabled in M1-03.",
      source_metadata: {
        api_version: entry.apiVersion,
        resource_kind: kind,
        stable_provider_id: String(repositoryId),
        page: pageIndex + 1,
        cache_reusable: false,
        validated: true,
      },
    });
    indexes.push(target.length);
  }
  return indexes;
}

function addFailureSource(
  target: RepositoryEnrichmentPayload["source_records"],
  failure: EnrichmentResourceFailure,
  repositoryId: number,
) {
  target.push({
    provider: "github",
    record_kind: failure.resource,
    source_key: `github:${failure.resource}:${repositoryId}:failed:${failure.fetchedAt}`,
    source_url: failure.sourceApiUrl,
    fetched_at: failure.fetchedAt,
    http_status: failure.httpStatus ?? null,
    etag: null,
    api_version: "2022-11-28",
    reuse_context: "No response body cached; failed request evidence only.",
    source_metadata: {
      api_version: "2022-11-28",
      resource_kind: failure.resource,
      stable_provider_id: String(repositoryId),
      cache_reusable: false,
      outcome: "unavailable",
      error_kind: failure.kind,
      retryable: failure.retryable,
    },
  });
}

function fieldValue<T>(field: { state: string; value?: T }): T | null {
  return field.state === "present" ? field.value as T : null;
}

function isFailure<T extends EnrichmentResourceFailure>(value: unknown): value is T {
  return typeof value === "object" && value !== null && "resource" in value;
}

function parseProviderId(value: string): number {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new TypeError("Candidate repository ID is not a valid stable GitHub ID.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError("Candidate repository ID is outside the safe numeric range.");
  return parsed;
}
