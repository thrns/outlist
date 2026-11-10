export const GITHUB_API_VERSION = "2022-11-28" as const;
export const GITHUB_API_ORIGIN = "https://api.github.com" as const;

export type GitHubResourceType =
  | "repository"
  | "repository_search"
  | "languages"
  | "topics"
  | "license"
  | "releases"
  | "rate_limit";

export type SourceField<T> =
  | { state: "present"; value: T }
  | { state: "null" }
  | { state: "absent" }
  | { state: "unavailable"; reason: string }
  | { state: "unsupported"; reason: string };

export interface GitHubRateLimit {
  limit?: number;
  remaining?: number;
  resetAt?: string;
  resetEpochSeconds?: number;
  resource?: string;
  retryAfterMs?: number;
  kind?: "primary" | "secondary";
}

export interface GitHubProvenance<T> {
  provider: "github";
  resourceType: GitHubResourceType;
  /** Stable numeric GitHub repository identity where the resource belongs to a repository. */
  stableResourceIdentity: string;
  sourceApiUrl: string;
  fetchedAt: string;
  httpStatus: number;
  etag?: string;
  rateLimit?: GitHubRateLimit;
  apiVersion: typeof GITHUB_API_VERSION;
  /** Schema-validated provider-shaped payload, only exposed by endpoints that explicitly request it. */
  originalResponseData?: unknown;
  parsedResponseData: T;
}

export interface GitHubNotModifiedProvenance {
  provider: "github";
  resourceType: GitHubResourceType;
  stableResourceIdentity: string;
  sourceApiUrl: string;
  fetchedAt: string;
  httpStatus: 304;
  etag?: string;
  rateLimit?: GitHubRateLimit;
  apiVersion: typeof GITHUB_API_VERSION;
}

export type GitHubFetchResult<T> =
  | { kind: "ok"; data: T; provenance: GitHubProvenance<T> }
  | { kind: "not_modified"; etag?: string; provenance: GitHubNotModifiedProvenance };

export interface GitHubReleaseListResult {
  kind: "ok";
  data: GitHubRelease[];
  provenance: Omit<GitHubProvenance<GitHubRelease[]>, "parsedResponseData"> & {
    parsedResponseData: GitHubRelease[];
    pages: GitHubProvenance<GitHubRelease[]>[];
  };
}

export interface GitHubTopicListResult {
  kind: "ok";
  data: string[];
  provenance: Omit<GitHubProvenance<string[]>, "parsedResponseData"> & {
    parsedResponseData: string[];
    pages: GitHubProvenance<string[]>[];
  };
}

export type GitHubReleaseFetchResult = GitHubReleaseListResult | {
  kind: "not_modified";
  etag?: string;
  provenance: GitHubNotModifiedProvenance;
};

export type GitHubTopicFetchResult = GitHubTopicListResult | {
  kind: "not_modified";
  etag?: string;
  provenance: GitHubNotModifiedProvenance;
};

export type GitHubLicenseResult =
  | { state: "available"; license: GitHubLicenseMetadata }
  | {
      state: "unavailable";
      reason: "not_detected_or_access_restricted";
      detail: string;
    };

export interface GitHubRepository {
  id: number;
  nodeId: string;
  owner: { id: number; nodeId: string; login: string; type?: string; avatarUrl?: string };
  name: string;
  fullName: string;
  canonicalUrl: string;
  description: SourceField<string>;
  homepage: SourceField<string>;
  topics: SourceField<string[]>;
  primaryLanguage: SourceField<string>;
  languageBytes: SourceField<Record<string, number>>;
  starCount: number;
  forkCount: number;
  watcherCount: number;
  openIssueCount: number;
  isArchived: boolean;
  isDisabled: boolean;
  isFork: boolean;
  isPrivate: boolean;
  visibility: SourceField<string>;
  defaultBranch: SourceField<string>;
  createdAt: string;
  updatedAt: string;
  pushedAt: SourceField<string>;
  license: SourceField<GitHubLicenseMetadata>;
}

/** Search returns a deliberately smaller, endpoint-specific repository shape. */
export interface GitHubSearchRepository {
  id: number;
  nodeId: string;
  owner: { id: number; nodeId: SourceField<string>; login: string; type: SourceField<string> };
  name: string;
  fullName: string;
  canonicalUrl: string;
  description: SourceField<string>;
  homepage: SourceField<string>;
  topics: SourceField<string[]>;
  primaryLanguage: SourceField<string>;
  starCount: number;
  forkCount: number;
  watcherCount: SourceField<number>;
  openIssueCount: SourceField<number>;
  isArchived: SourceField<boolean>;
  isDisabled: SourceField<boolean>;
  isFork: boolean;
  isPrivate: boolean;
  visibility: SourceField<string>;
  defaultBranch: SourceField<string>;
  createdAt: string;
  updatedAt: string;
  pushedAt: SourceField<string>;
  license: SourceField<GitHubLicenseMetadata>;
}

export type GitHubSearchSort = "stars" | "forks" | "help-wanted-issues" | "updated";
export type GitHubSearchOrder = "asc" | "desc";

export interface GitHubSearchOptions extends GitHubRequestOptions {
  page?: number;
  perPage?: number;
  sort?: GitHubSearchSort;
  order?: GitHubSearchOrder;
}

export interface GitHubRepositorySearchPage {
  totalCount: number;
  incompleteResults: boolean;
  items: GitHubSearchRepository[];
}

export interface GitHubRepositorySearchResult {
  kind: "ok";
  data: GitHubRepositorySearchPage;
  provenance: GitHubProvenance<GitHubRepositorySearchPage>;
}

export interface GitHubLicenseMetadata {
  key: string;
  name: string;
  spdxId: SourceField<string>;
  url: SourceField<string>;
  htmlUrl: SourceField<string>;
  nodeId: SourceField<string>;
}

export interface GitHubRelease {
  id: number;
  nodeId: string;
  tagName: string;
  name: SourceField<string>;
  url: string;
  htmlUrl: string;
  createdAt: string;
  publishedAt: SourceField<string>;
  isDraft: boolean;
  isPrerelease: boolean;
}

export interface GitHubClientOptions {
  /** Defaults to GITHUB_TOKEN read when the client is constructed. */
  token?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  maxElapsedTimeMs?: number;
  maxRateLimitWaitMs?: number;
  /** Injectable hooks keep time and retry tests deterministic. */
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface GitHubRequestOptions {
  etag?: string;
  signal?: AbortSignal;
  /** Preserve stable provenance when revalidating a cached repository response. */
  repositoryId?: number;
}

export interface GitHubPaginationOptions extends GitHubRequestOptions {
  perPage?: number;
  maxPages?: number;
  maxItems?: number;
}

export type GitHubReleaseOptions = GitHubPaginationOptions;
export type GitHubTopicsOptions = GitHubPaginationOptions;

export type GitHubRateLimitSnapshot = {
  resources: Record<string, { limit: number; remaining: number; reset: number; used: number }>;
  rate: { limit: number; remaining: number; reset: number; used: number };
};

export function sourceField<T>(
  object: Record<string, unknown>,
  key: string,
  options: { supported?: boolean; unavailableReason?: string } = {},
): SourceField<T> {
  if (options.supported === false) {
    return { state: "unsupported", reason: options.unavailableReason ?? "The source API does not support this field." };
  }
  if (options.unavailableReason) {
    return { state: "unavailable", reason: options.unavailableReason };
  }
  if (!Object.prototype.hasOwnProperty.call(object, key)) return { state: "absent" };
  const value = object[key];
  if (value === null || value === undefined) return { state: "null" };
  return { state: "present", value: value as T };
}
