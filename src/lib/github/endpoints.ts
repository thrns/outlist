import { GITHUB_API_ORIGIN } from "./types";

const ownerPattern = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const repositoryPattern = /^(?=.{1,100}$)[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function validateRepositoryLocator(owner: string, repo: string): void {
  if (!ownerPattern.test(owner) || !repositoryPattern.test(repo)) {
    throw new TypeError("GitHub owner and repository must be simple path names.");
  }
}

export function validateRepositoryId(repositoryId: number): void {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new TypeError("GitHub repository ID must be a positive safe integer.");
  }
}

function repositoryPath(owner: string, repo: string): string {
  validateRepositoryLocator(owner, repo);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function repositoryUrl(owner: string, repo: string): URL {
  return new URL(repositoryPath(owner, repo), GITHUB_API_ORIGIN);
}

export function repositoryByIdUrl(repositoryId: number): URL {
  validateRepositoryId(repositoryId);
  return new URL(`/repositories/${repositoryId}`, GITHUB_API_ORIGIN);
}

export function languagesUrl(owner: string, repo: string): URL {
  return new URL(`${repositoryPath(owner, repo)}/languages`, GITHUB_API_ORIGIN);
}

export function topicsUrl(owner: string, repo: string, perPage: number): URL {
  const url = new URL(`${repositoryPath(owner, repo)}/topics`, GITHUB_API_ORIGIN);
  url.searchParams.set("per_page", String(perPage));
  return url;
}

export function licenseUrl(owner: string, repo: string): URL {
  return new URL(`${repositoryPath(owner, repo)}/license`, GITHUB_API_ORIGIN);
}

export function releasesUrl(owner: string, repo: string, perPage: number): URL {
  const url = new URL(`${repositoryPath(owner, repo)}/releases`, GITHUB_API_ORIGIN);
  url.searchParams.set("per_page", String(perPage));
  return url;
}

export function rateLimitUrl(): URL {
  return new URL("/rate_limit", GITHUB_API_ORIGIN);
}

const repositorySearchQualifiers = new Set([
  "archived", "created", "fork", "forks", "in", "is", "language", "license",
  "size", "stars", "topic", "pushed",
]);

export function validateRepositorySearchQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError("GitHub repository search query must be non-empty, at most 256 characters, and contain no control characters.");
  }
  const operators = normalized.match(/\b(?:AND|OR|NOT)\b/gi) ?? [];
  if (operators.length > 5) throw new TypeError("GitHub search queries may contain at most five AND, OR, or NOT operators.");
  for (const match of normalized.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9-]*):([^\s]+)/g)) {
    if (!repositorySearchQualifiers.has(match[1].toLowerCase())) {
      throw new TypeError(`Unsupported GitHub repository search qualifier: ${match[1]}.`);
    }
  }
  return normalized;
}

export function repositorySearchUrl(
  query: string,
  options: { page: number; perPage: number; sort?: string; order?: string },
): URL {
  const url = new URL("/search/repositories", GITHUB_API_ORIGIN);
  url.searchParams.set("q", validateRepositorySearchQuery(query));
  url.searchParams.set("per_page", String(options.perPage));
  url.searchParams.set("page", String(options.page));
  if (options.sort) url.searchParams.set("sort", options.sort);
  if (options.order) url.searchParams.set("order", options.order);
  return url;
}

export function expectedReleasesPath(owner: string, repo: string): string {
  return `${repositoryPath(owner, repo)}/releases`;
}

export function expectedReleasesPaths(owner: string, repo: string, repositoryId: number): string[] {
  validateRepositoryId(repositoryId);
  return [expectedReleasesPath(owner, repo), `/repositories/${repositoryId}/releases`];
}

export function expectedTopicsPaths(owner: string, repo: string, repositoryId: number): string[] {
  validateRepositoryId(repositoryId);
  return [`${repositoryPath(owner, repo)}/topics`, `/repositories/${repositoryId}/topics`];
}
