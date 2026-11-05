import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubClient } from "../src/lib/github/client";
import { GitHubApiError } from "../src/lib/github/errors";
import type { GitHubLicenseMetadata, GitHubRepository, SourceField } from "../src/lib/github/types";

const ownerPattern = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const repositoryNamePattern = /^(?=.{1,100}$)[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface InspectArguments {
  owner: string;
  repo: string;
  includeTopics: boolean;
  includeLanguages: boolean;
  includeReleases: boolean;
  liveSmoke: boolean;
}

export function parseInspectArguments(args: string[]): InspectArguments {
  let repository: string | undefined;
  let includeTopics = false;
  let includeLanguages = false;
  let includeReleases = false;
  let liveSmoke = false;
  for (const arg of args) {
    if (arg === "--topics") includeTopics = true;
    else if (arg === "--languages") includeLanguages = true;
    else if (arg === "--releases") includeReleases = true;
    else if (arg === "--live-smoke") liveSmoke = true;
    else if (arg.startsWith("-")) throw new TypeError(`Unknown option: ${arg}`);
    else if (repository) throw new TypeError("Supply exactly one repository as owner/name.");
    else repository = arg;
  }
  if (!repository) throw new TypeError("Usage: bun run github:inspect -- owner/repository [--topics] [--languages] [--releases]");
  const parts = repository.split("/");
  if (parts.length !== 2 || !ownerPattern.test(parts[0]) || !repositoryNamePattern.test(parts[1])) {
    throw new TypeError("Repository must use owner/name syntax with valid GitHub path names; URLs are not accepted.");
  }
  return {
    owner: parts[0],
    repo: parts[1],
    includeTopics,
    includeLanguages,
    includeReleases,
    liveSmoke,
  };
}

export function formatSourceField<T>(field: SourceField<T>, render: (value: T) => string): string {
  if (field.state === "present") return render(field.value as T);
  if (field.state === "null") return "not reported (null)";
  if (field.state === "absent") return "not reported (field absent)";
  if (field.state === "unsupported") return `unsupported${field.reason ? `: ${field.reason}` : ""}`;
  return `unavailable${field.reason ? `: ${field.reason}` : ""}`;
}

export function formatRepositorySummary(repository: GitHubRepository): string {
  const license = repository.license.state === "present"
    ? `${repository.license.value.name} (SPDX: ${formatSourceField(repository.license.value.spdxId, (id) => id)})`
    : formatSourceField<GitHubLicenseMetadata>(repository.license, (value) => value.name);
  return [
    `GitHub repository: ${repository.fullName}`,
    `ID: ${repository.id}`,
    `Name: ${repository.name}`,
    `URL: ${repository.canonicalUrl}`,
    `Stars: ${repository.starCount.toLocaleString("en-US")}`,
    `Forks: ${repository.forkCount.toLocaleString("en-US")}`,
    `Primary language: ${formatSourceField(repository.primaryLanguage, (value) => value)}`,
    `Source license: ${license}`,
    `Visibility: ${formatSourceField(repository.visibility, (value) => value)}`,
    `Archived / disabled / fork: ${repository.isArchived} / ${repository.isDisabled} / ${repository.isFork}`,
    `Created: ${repository.createdAt}`,
    `Updated: ${repository.updatedAt}`,
    `Pushed: ${formatSourceField(repository.pushedAt, (value) => value)}`,
  ].join("\n");
}

export async function inspectRepository(args: InspectArguments): Promise<string> {
  const client = createGitHubClient();
  const result = await client.getRepository(args.owner, args.repo);
  if (result.kind === "not_modified") {
    throw new Error("GitHub returned 304, but this CLI has no cached repository body to display.");
  }
  if (result.data.isPrivate) {
    throw new Error("This inspection command accepts public repositories only.");
  }

  const output = [
    args.liveSmoke ? "LIVE SMOKE TEST: one public repository read; this does not validate the full ingestion pipeline." : "",
    formatRepositorySummary(result.data),
    `Topics: ${formatSourceField(result.data.topics, (topics) => topics.length ? topics.join(", ") : "none returned")}`,
  ].filter(Boolean);

  const licenseResult = await client.getRepositoryLicense(args.owner, args.repo);
  if (licenseResult.kind === "ok" && licenseResult.data.state === "unavailable") {
    output.push(`License endpoint: unavailable (${licenseResult.data.detail})`);
  } else if (licenseResult.kind === "ok" && licenseResult.data.state === "available") {
    const detected = licenseResult.data.license;
    output.push(`License endpoint: ${detected.name} (SPDX: ${formatSourceField(detected.spdxId, (id) => id)})`);
  } else if (licenseResult.kind === "not_modified") {
    output.push("License endpoint: unchanged (304); no cached license body in this CLI session.");
  }

  if (args.includeTopics) {
    const topics = await client.getRepositoryTopics(args.owner, args.repo);
    output.push(`Topics endpoint: ${topics.kind === "ok" ? (topics.data.length ? topics.data.join(", ") : "none returned") : "unchanged (304)"}`);
  }
  if (args.includeLanguages) {
    const languages = await client.getRepositoryLanguages(args.owner, args.repo);
    output.push(`Language bytes: ${languages.kind === "ok" ? formatByteCounts(languages.data) : "unchanged (304)"}`);
  }
  if (args.includeReleases) {
    // The inspection CLI intentionally previews only one page; the aggregate
    // client method keeps its complete-pagination guarantee for data callers.
    const releasePages = client.iterateRepositoryReleasePages(args.owner, args.repo, { perPage: 20 });
    const first = await releasePages.next();
    await releasePages.return(undefined);
    if (first.done) throw new GitHubApiError("malformed_payload", "GitHub did not return a first release page.");
    const firstPage = first.value;
    if (firstPage.kind === "not_modified") {
      output.push("Recent releases: unchanged (304); no cached release body in this CLI session.");
    } else {
      const recent = firstPage.data.slice(0, 5);
      output.push(`Recent releases (${firstPage.data.length} retrieved from the first page):`);
      for (const release of recent) {
        const name = release.name.state === "present" ? release.name.value : release.tagName;
        output.push(`  ${release.tagName} — ${name} — ${release.publishedAt.state === "present" ? release.publishedAt.value : "date not reported"}`);
      }
      if (!recent.length) output.push("  none returned");
    }
    output.push("Release results are limited to the first page and may not represent all releases.");
  }
  output.push(`Fetched: ${result.provenance.fetchedAt} (HTTP ${result.provenance.httpStatus}, API ${result.provenance.apiVersion})`);
  return output.join("\n");
}

export async function runInspectCli(args: string[]): Promise<number> {
  try {
    const parsed = parseInspectArguments(args);
    const output = await inspectRepository(parsed);
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof GitHubApiError
      ? `${error.kind}: ${error.message}${error.retryAfterMs === undefined ? "" : ` Retry after ${Math.ceil(error.retryAfterMs / 1000)} seconds.`}`
      : error instanceof Error
        ? error.message
        : "Unexpected GitHub inspection failure.";
    process.stderr.write(`GitHub inspection failed: ${message}\n`);
    return 1;
  }
}

function formatByteCounts(languages: Record<string, number>): string {
  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([name, bytes]) => `${name} ${bytes.toLocaleString("en-US")} B`).join(", ") : "none returned";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runInspectCli(process.argv.slice(2));
}
