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
