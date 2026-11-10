import { z } from "zod";
import {
  expectedReleasesPaths,
  expectedTopicsPaths,
  languagesUrl,
  licenseUrl,
  rateLimitUrl,
  releasesUrl,
  repositoryByIdUrl,
  repositorySearchUrl,
  repositoryUrl,
  topicsUrl,
  validateRepositoryId,
  validateRepositoryLocator,
  validateRepositorySearchQuery,
} from "./endpoints";
import { GitHubApiError, redactDiagnostic, statusError } from "./errors";
import {
  PaginationError,
  getNextLink,
  validateNextPageUrl,
} from "./pagination";
import {
  classifyRateLimitResponse,
  parseRateLimitHeaders,
  requiredRateLimitWaitMs,
} from "./rate-limit";
import {
  githubLanguagesSchema,
  githubLicenseResponseSchema,
  githubRateLimitSchema,
  githubReleaseListSchema,
  githubRepositorySchema,
  githubRepositorySearchSchema,
  githubTopicsSchema,
  type GitHubLicensePayload,
  type GitHubReleasePayload,
  type GitHubRepositoryPayload,
  type GitHubRepositorySearchPayload,
  type GitHubSearchRepositoryPayload,
} from "./schemas";
import {
  GITHUB_API_VERSION,
  type GitHubClientOptions,
  type GitHubFetchResult,
  type GitHubLicenseMetadata,
  type GitHubLicenseResult,
  type GitHubNotModifiedProvenance,
  type GitHubPaginationOptions,
  type GitHubProvenance,
  type GitHubRateLimit,
  type GitHubRateLimitSnapshot,
  type GitHubRelease,
  type GitHubReleaseFetchResult,
  type GitHubReleaseOptions,
  type GitHubRepository,
  type GitHubRepositorySearchPage,
  type GitHubRepositorySearchResult,
  type GitHubSearchOptions,
  type GitHubSearchRepository,
  type GitHubRequestOptions,
  type GitHubTopicFetchResult,
  type GitHubTopicsOptions,
  sourceField,
} from "./types";

const CLIENT_NAME = "outlist-github-api-adapter/1.0";
const JSON_ACCEPT = "application/vnd.github+json";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_ELAPSED_MS = 45_000;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 30_000;
// GitHub's largest expected JSON page (100 releases) is well below this cap.
// Keep diagnostics smaller because error responses are never needed in full.
const MAX_SUCCESS_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 32 * 1024;

const clientOptionsSchema = z.object({
  timeoutMs: z.number().int().positive().max(120_000).default(DEFAULT_TIMEOUT_MS),
  maxRetries: z.number().int().min(0).max(5).default(DEFAULT_MAX_RETRIES),
  maxElapsedTimeMs: z.number().int().positive().max(300_000).default(DEFAULT_MAX_ELAPSED_MS),
  maxRateLimitWaitMs: z.number().int().nonnegative().max(3_600_000).default(DEFAULT_MAX_RATE_LIMIT_WAIT_MS),
});

type InternalRequestResult<T> = {
  result: GitHubFetchResult<T>;
  linkHeader?: string;
};

type RepositoryIdentity = { id: number; owner: string; repo: string };
type BufferedResponse = { response: Response; body: Uint8Array };

export class GitHubClient {
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxElapsedTimeMs: number;
  readonly #maxRateLimitWaitMs: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #identityByLocator = new Map<string, RepositoryIdentity>();
  readonly #identityById = new Map<number, RepositoryIdentity>();

  constructor(options: GitHubClientOptions = {}) {
    const parsed = clientOptionsSchema.safeParse(options);
    if (!parsed.success) throw new TypeError("GitHub client retry and timeout configuration is invalid.");

    const configuredToken = options.token === null ? undefined : options.token ?? process.env.GITHUB_TOKEN;
    if (configuredToken !== undefined && /[\u0000-\u001f\u007f]/.test(configuredToken)) {
      throw new TypeError("GITHUB_TOKEN must not contain control characters.");
    }
    this.#token = configuredToken?.trim() || undefined;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = parsed.data.timeoutMs;
    this.#maxRetries = parsed.data.maxRetries;
    this.#maxElapsedTimeMs = parsed.data.maxElapsedTimeMs;
    this.#maxRateLimitWaitMs = parsed.data.maxRateLimitWaitMs;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? sleep;
  }

  async searchRepositories(
    query: string,
    options: GitHubSearchOptions = {},
  ): Promise<GitHubRepositorySearchResult> {
    const normalizedQuery = validateRepositorySearchQuery(query);
    const settings = validateSearchOptions(options);
    const url = repositorySearchUrl(normalizedQuery, settings);
    const response = await this.#requestJson(
      url,
      "repository_search",
      githubRepositorySearchSchema,
      (payload) => toRepositorySearchPage(payload),
      { signal: options.signal },
      `github:search:repositories:${encodeURIComponent(normalizedQuery)}:page:${settings.page}`,
    );
    if (response.result.kind !== "ok") {
      throw new GitHubApiError("malformed_payload", "GitHub returned an unexpected not-modified result for repository search.");
    }
    return response.result;
  }

  async getRepository(
    owner: string,
    repo: string,
    options: GitHubRequestOptions = {},
  ): Promise<GitHubFetchResult<GitHubRepository>> {
    const requestedOwner = owner;
    const requestedRepo = repo;
    const cached = this.#identityByLocator.get(locatorKey(owner, repo));
    if (options.repositoryId !== undefined) validateRepositoryId(options.repositoryId);
    const knownRepositoryId = cached?.id ?? options.repositoryId;
    if (options.etag && knownRepositoryId === undefined) {
      throw new TypeError("Pass the known repositoryId when revalidating a repository ETag with a fresh client.");
    }
    const response = await this.#requestJson(
      repositoryUrl(cached?.owner ?? owner, cached?.repo ?? repo),
      "repository",
      githubRepositorySchema,
      (payload) => toRepository(payload),
      options,
      (data) => repositoryIdentity(data.id),
      undefined,
      knownRepositoryId ? repositoryIdentity(knownRepositoryId) : undefined,
    );
    if (response.result.kind === "ok") {
      this.#rememberRepository(response.result.data, requestedOwner, requestedRepo);
    }
    return response.result;
  }

  async getRepositoryById(
    repositoryId: number,
    options: GitHubRequestOptions = {},
  ): Promise<GitHubFetchResult<GitHubRepository>> {
    validateRepositoryId(repositoryId);
    const response = await this.#requestJson(
      repositoryByIdUrl(repositoryId),
      "repository",
      githubRepositorySchema,
      (payload) => {
        if (payload.id !== repositoryId) {
          throw new GitHubApiError("malformed_payload", "GitHub returned a different repository ID than requested.");
        }
        return toRepository(payload);
      },
      options,
      repositoryIdentity(repositoryId),
      undefined,
      undefined,
      true,
    );
    if (response.result.kind === "ok") this.#rememberRepository(response.result.data);
    return response.result;
  }

  async getRepositoryLanguages(
    owner: string,
    repo: string,
    options: GitHubRequestOptions = {},
  ): Promise<GitHubFetchResult<Record<string, number>>> {
    const identity = await this.#resolveRepository(owner, repo, options.signal);
    const response = await this.#requestJson(
      languagesUrl(identity.owner, identity.repo),
      "languages",
      githubLanguagesSchema,
      (payload) => payload,
      options,
      repositorySubresourceIdentity(identity.id, "languages"),
    );
    return response.result;
  }

  async getRepositoryTopics(
    owner: string,
    repo: string,
    options: GitHubTopicsOptions = {},
  ): Promise<GitHubTopicFetchResult> {
    const pages: GitHubProvenance<string[]>[] = [];
    const names: string[] = [];
    for await (const result of this.iterateRepositoryTopicPages(owner, repo, options)) {
      if (result.kind === "not_modified") {
        if (pages.length > 0) {
          throw new GitHubApiError("malformed_payload", "GitHub returned 304 after a topics page had already changed.");
        }
        return result;
      }
      pages.push(result.provenance);
      names.push(...result.data);
    }
    const first = pages[0];
    if (!first) throw new GitHubApiError("malformed_payload", "GitHub did not return a topics page.");
    const last = pages[pages.length - 1];
    return {
      kind: "ok",
      data: names,
      provenance: {
        ...first,
        fetchedAt: last.fetchedAt,
        rateLimit: last.rateLimit,
        parsedResponseData: names,
        pages,
      },
    };
  }

  async *iterateRepositoryTopicPages(
    owner: string,
    repo: string,
    options: GitHubTopicsOptions = {},
  ): AsyncGenerator<GitHubFetchResult<string[]>, void, void> {
    const settings = validatePaginationOptions(options);
    const identity = await this.#resolveRepository(owner, repo, options.signal);
    const expectedPaths = expectedTopicsPaths(identity.owner, identity.repo, identity.id);
    let currentUrl = topicsUrl(identity.owner, identity.repo, settings.perPage);
    const seen = new Set([currentUrl.href]);
    let page = 0;
    let totalItems = 0;

    while (true) {
      page += 1;
      const response = await this.#requestJson(
        currentUrl,
        "topics",
        githubTopicsSchema,
        (payload) => payload.names,
        { signal: options.signal, ...(page === 1 && options.etag ? { etag: options.etag } : {}) },
        repositorySubresourceIdentity(identity.id, "topics"),
      );
      if (response.result.kind === "not_modified") {
        if (page !== 1) {
          throw new GitHubApiError("malformed_payload", "GitHub returned 304 for an uncached later topics page.");
        }
        yield response.result;
        return;
      }
      totalItems += response.result.data.length;
      if (totalItems > settings.maxItems) {
        throw new GitHubApiError("pagination", `GitHub topics exceeded the ${settings.maxItems} item limit.`);
      }
      yield response.result;

      const nextLink = getNextLink(response.linkHeader ?? null);
      if (!nextLink) return;
      if (page >= settings.maxPages) {
        throw new GitHubApiError("pagination", `GitHub topics exceeded the ${settings.maxPages} page limit.`);
      }
      currentUrl = validatedNextPage(nextLink, expectedPaths, seen);
      validateSequentialPage(currentUrl, page, settings.perPage, "topics");
    }
  }

  async getRepositoryLicense(
    owner: string,
    repo: string,
    options: GitHubRequestOptions = {},
  ): Promise<GitHubFetchResult<GitHubLicenseResult>> {
    const identity = await this.#resolveRepository(owner, repo, options.signal);
    const response = await this.#requestJson(
      licenseUrl(identity.owner, identity.repo),
      "license",
      githubLicenseResponseSchema,
      (payload): GitHubLicenseResult => ({ state: "available", license: toLicense(payload.license) }),
      options,
      repositorySubresourceIdentity(identity.id, "license"),
      (): GitHubLicenseResult => ({
        state: "unavailable",
        reason: "not_detected_or_access_restricted",
        detail: "GitHub did not return license data. This does not verify a license or establish repository deletion.",
      }),
    );
    return response.result;
  }

  async *iterateRepositoryReleasePages(
    owner: string,
    repo: string,
    options: GitHubReleaseOptions = {},
  ): AsyncGenerator<GitHubFetchResult<GitHubRelease[]>, void, void> {
    const settings = validatePaginationOptions(options);
    const identity = await this.#resolveRepository(owner, repo, options.signal);
    const expectedPaths = expectedReleasesPaths(identity.owner, identity.repo, identity.id);
    let currentUrl = releasesUrl(identity.owner, identity.repo, settings.perPage);
    const seen = new Set([currentUrl.href]);
    let page = 0;
    let totalItems = 0;

    while (true) {
      page += 1;
      const response = await this.#requestJson(
        currentUrl,
        "releases",
        githubReleaseListSchema,
        (payload) => payload.map(toRelease),
        { signal: options.signal, ...(page === 1 && options.etag ? { etag: options.etag } : {}) },
        repositorySubresourceIdentity(identity.id, "releases"),
      );
      if (response.result.kind === "not_modified") {
        if (page !== 1) {
          throw new GitHubApiError("malformed_payload", "GitHub returned 304 for an uncached later release page.");
        }
        yield response.result;
        return;
      }

      totalItems += response.result.data.length;
      if (totalItems > settings.maxItems) {
        throw new GitHubApiError("pagination", `GitHub releases exceeded the ${settings.maxItems} item limit.`);
      }
      yield response.result;

      const nextLink = getNextLink(response.linkHeader ?? null);
      if (!nextLink) return;
      if (page >= settings.maxPages) {
        throw new GitHubApiError("pagination", `GitHub releases exceeded the ${settings.maxPages} page limit.`);
      }
      currentUrl = validatedNextPage(nextLink, expectedPaths, seen);
      validateSequentialPage(currentUrl, page, settings.perPage, "releases");
    }
  }

  async getRepositoryReleases(
    owner: string,
    repo: string,
    options: GitHubReleaseOptions = {},
  ): Promise<GitHubReleaseFetchResult> {
    const pages: GitHubProvenance<GitHubRelease[]>[] = [];
    const releases: GitHubRelease[] = [];
    for await (const result of this.iterateRepositoryReleasePages(owner, repo, options)) {
      if (result.kind === "not_modified") {
        if (pages.length > 0) {
          throw new GitHubApiError("malformed_payload", "GitHub returned 304 after a release page had already changed.");
        }
        return result;
      }
      pages.push(result.provenance);
      releases.push(...result.data);
    }
    const first = pages[0];
    if (!first) {
      // The iterator always requests a first page, so reaching this indicates
      // an internal adapter error rather than a successful empty response.
      throw new GitHubApiError("malformed_payload", "GitHub did not return a release page.");
    }
    const last = pages[pages.length - 1];
    const provenance = {
      ...first,
      fetchedAt: last.fetchedAt,
      rateLimit: last.rateLimit,
      parsedResponseData: releases,
      pages,
    };
    return { kind: "ok", data: releases, provenance };
  }

  async getRateLimit(options: GitHubRequestOptions = {}): Promise<GitHubFetchResult<GitHubRateLimitSnapshot>> {
    const response = await this.#requestJson(
      rateLimitUrl(),
      "rate_limit",
      githubRateLimitSchema,
      (payload) => payload,
      options,
      "github:rate-limit",
    );
    return response.result;
  }

  async #resolveRepository(owner: string, repo: string, signal?: AbortSignal): Promise<RepositoryIdentity> {
    validateRepositoryLocator(owner, repo);
    const cached = this.#identityByLocator.get(locatorKey(owner, repo));
    if (cached) return cached;
    const result = await this.getRepository(owner, repo, { signal });
    if (result.kind !== "ok") {
      throw new GitHubApiError("malformed_payload", "Repository identity lookup did not return repository data.");
    }
    const resolved = this.#identityById.get(result.data.id);
    if (!resolved) {
      throw new GitHubApiError("malformed_payload", "Repository identity could not be cached after validation.");
    }
    return resolved;
  }

  #rememberRepository(repository: GitHubRepository, requestedOwner?: string, requestedRepo?: string): void {
    const identity: RepositoryIdentity = {
      id: repository.id,
      owner: repository.owner.login,
      repo: repository.name,
    };
    this.#identityById.set(repository.id, identity);
    this.#identityByLocator.set(locatorKey(identity.owner, identity.repo), identity);
    this.#identityByLocator.set(locatorKey(repository.owner.login, repository.name), identity);
    if (requestedOwner && requestedRepo) {
      this.#identityByLocator.set(locatorKey(requestedOwner, requestedRepo), identity);
    }
  }

  async #requestJson<TPayload, TData>(
    url: URL,
    resourceType: GitHubProvenance<TData>["resourceType"],
    schema: z.ZodType<TPayload>,
    transform: (payload: TPayload) => TData,
    options: GitHubRequestOptions,
    identity: string | ((data: TData) => string),
    onNotFound?: () => TData,
    notModifiedIdentity?: string,
    includeOriginalResponse = false,
  ): Promise<InternalRequestResult<TData>> {
    const { response, body } = await this.#fetchResponse(url, options);
    const rateLimit = parseRateLimitHeaders(response.headers, this.#now());
    const fetchedAt = new Date(this.#now()).toISOString();
    const sourceApiUrl = url.href;
    const stableResourceIdentity = typeof identity === "string" ? identity : undefined;
    const etag = response.headers.get("etag") ?? undefined;

    if (response.status === 304) {
      const provenance: GitHubNotModifiedProvenance = {
        provider: "github",
        resourceType,
        stableResourceIdentity: stableResourceIdentity ?? notModifiedIdentity ?? "github:repository:unresolved",
        sourceApiUrl,
        fetchedAt,
        httpStatus: 304,
        ...(etag ? { etag } : {}),
        ...(rateLimit ? { rateLimit } : {}),
        apiVersion: GITHUB_API_VERSION,
      };
      return { result: { kind: "not_modified", ...(etag ? { etag } : {}), provenance } };
    }

    if (response.status === 404 && onNotFound) {
      const data = onNotFound();
      const provenance: GitHubProvenance<TData> = {
        provider: "github",
        resourceType,
        stableResourceIdentity: stableResourceIdentity ?? (typeof identity === "function" ? identity(data) : "github:unknown"),
        sourceApiUrl,
        fetchedAt,
        httpStatus: 404,
        ...(etag ? { etag } : {}),
        ...(rateLimit ? { rateLimit } : {}),
        apiVersion: GITHUB_API_VERSION,
        parsedResponseData: data,
      };
      return { result: { kind: "ok", data, provenance }, linkHeader: response.headers.get("link") ?? undefined };
    }

    if (!response.ok) {
      const error = await this.#responseError(response, body, rateLimit);
      throw new GitHubApiError(error.kind, error.message, {
        ...error.options,
        sourceApiUrl,
        fetchedAt,
        httpStatus: response.status,
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!isJsonContentType(contentType)) {
      throw new GitHubApiError("unexpected_content_type", "GitHub returned a non-JSON response for a JSON endpoint.", {
        status: response.status,
        requestId: safeRequestId(response.headers.get("x-github-request-id")),
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new GitHubApiError("malformed_payload", "GitHub returned malformed JSON.", {
        status: response.status,
        requestId: safeRequestId(response.headers.get("x-github-request-id")),
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const path = firstIssue?.path.map(String).join(".") || "response";
      throw new GitHubApiError("malformed_payload", `GitHub returned an invalid response at ${path}.`, {
        status: response.status,
        requestId: safeRequestId(response.headers.get("x-github-request-id")),
      });
    }

    const data = transform(parsed.data);
    const resolvedIdentity = typeof identity === "function" ? identity(data) : identity;
    const provenance: GitHubProvenance<TData> = {
      provider: "github",
      resourceType,
      stableResourceIdentity: resolvedIdentity,
      sourceApiUrl,
      fetchedAt,
      httpStatus: response.status,
      ...(etag ? { etag } : {}),
      ...(rateLimit ? { rateLimit } : {}),
      apiVersion: GITHUB_API_VERSION,
      // Keep the exact provider-shaped JSON object from this response. The
      // endpoint schema and resource-specific transform have both validated it.
      ...(includeOriginalResponse ? { originalResponseData: json } : {}),
      parsedResponseData: data,
    };
    return {
      result: { kind: "ok", data, provenance },
      linkHeader: response.headers.get("link") ?? undefined,
    };
  }

  async #fetchResponse(url: URL, options: GitHubRequestOptions): Promise<BufferedResponse> {
    const startedAt = this.#now();
    let attempt = 0;
    while (true) {
      const headers = new Headers({
        Accept: JSON_ACCEPT,
        "User-Agent": CLIENT_NAME,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      });
      if (this.#token) headers.set("Authorization", `Bearer ${this.#token}`);
      if (options.etag) headers.set("If-None-Match", options.etag);
      const remainingMs = this.#maxElapsedTimeMs - (this.#now() - startedAt);
      if (remainingMs <= 0) {
        throw new GitHubApiError("timeout", "The GitHub request exceeded the configured elapsed-time limit.", {
          retryable: true,
        });
      }
      const attemptStartedAt = this.#now();
      const timeoutMs = Math.min(this.#timeoutMs, remainingMs);
      let buffered: BufferedResponse;
      try {
        buffered = await this.#fetchWithTimeout(
          url,
          headers,
          options.signal,
          timeoutMs,
        );
        if (this.#now() - attemptStartedAt >= timeoutMs) {
          throw new GitHubApiError("timeout", `The GitHub request timed out after ${timeoutMs} ms.`, { retryable: true });
        }
      } catch (error) {
        if (error instanceof GitHubApiError && error.kind === "aborted") throw error;
        if (this.#now() - startedAt >= this.#maxElapsedTimeMs) {
          throw new GitHubApiError("timeout", "The GitHub request exceeded the configured elapsed-time limit.", {
            retryable: true,
          });
        }
        const timeout = error instanceof GitHubApiError && error.kind === "timeout";
        const retryable = timeout || (error instanceof GitHubApiError && error.kind === "network");
        if (!retryable || attempt >= this.#maxRetries) {
          if (error instanceof GitHubApiError) throw error;
          throw new GitHubApiError("network", "The GitHub request failed before receiving a response.", { retryable: true });
        }
        const delay = this.#backoff(attempt++);
        await this.#wait(delay, options.signal, startedAt, "network");
        continue;
      }

      const { response, body } = buffered;
      const rateLimit = parseRateLimitHeaders(response.headers, this.#now());
      if (response.status === 408 || response.status >= 500) {
        if (attempt >= this.#maxRetries) throw await this.#responseError(response, body, rateLimit);
        const delay = this.#backoff(attempt++);
        await this.#wait(delay, options.signal, startedAt, "server");
        continue;
      }

      if (response.status === 403 || response.status === 429) {
        const diagnostic = safeErrorMessage(body, this.#token);
        const rateLimitKind = classifyRateLimitResponse(response.status, rateLimit, diagnostic);
        if (rateLimitKind) {
          const waitMs = requiredRateLimitWaitMs(rateLimit, rateLimitKind, this.#now());
          const enriched = rateLimit ? { ...rateLimit, kind: rateLimitKind } : { kind: rateLimitKind };
          if (waitMs > this.#maxRateLimitWaitMs || attempt >= this.#maxRetries) {
            throw statusError(response.status, {
              rateLimit: enriched,
              rateLimitKind,
              retryAfterMs: waitMs,
              requestId: safeRequestId(response.headers.get("x-github-request-id")),
              diagnostic: diagnostic || undefined,
            });
          }
          await this.#wait(waitMs, options.signal, startedAt, "rate_limit");
          attempt += 1;
          continue;
        }
      }
      return buffered;
    }
  }

  async #fetchWithTimeout(url: URL, headers: Headers, signal: AbortSignal | undefined, timeoutMs: number): Promise<BufferedResponse> {
    if (signal?.aborted) throw new GitHubApiError("aborted", "The GitHub request was cancelled.");
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);
    let response: Response | undefined;
    try {
      response = await this.#fetch(url, { method: "GET", headers, signal: controller.signal });
      if (timedOut || signal?.aborted) throw new Error("Request cancelled while receiving response headers.");
      const limit = response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES;
      const body = response.status === 304
        ? new Uint8Array()
        : await readLimitedBody(response, limit, controller.signal);
      if (timedOut || signal?.aborted) throw new Error("Request cancelled while reading the response body.");
      return { response, body };
    } catch (error) {
      if (signal?.aborted) throw new GitHubApiError("aborted", "The GitHub request was cancelled.");
      if (timedOut) {
        throw new GitHubApiError("timeout", `The GitHub request timed out after ${timeoutMs} ms.`, { retryable: true });
      }
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(
        "network",
        response ? "The GitHub response body could not be read." : "The GitHub request failed before receiving a response.",
        { retryable: true },
      );
    } finally {
      if (controller.signal.aborted && response?.body) cancelResponseBody(response, controller.signal.reason);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async #responseError(response: Response, body: Uint8Array, rateLimit?: GitHubRateLimit): Promise<GitHubApiError> {
    const diagnostic = safeErrorMessage(body, this.#token);
    const rateLimitKind = classifyRateLimitResponse(response.status, rateLimit, diagnostic);
    const retryAfterMs = rateLimitKind
      ? requiredRateLimitWaitMs(rateLimit, rateLimitKind, this.#now())
      : undefined;
    return statusError(response.status, {
      ...(rateLimit ? { rateLimit: rateLimitKind ? { ...rateLimit, kind: rateLimitKind } : rateLimit } : {}),
      ...(rateLimitKind ? { rateLimitKind } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      requestId: safeRequestId(response.headers.get("x-github-request-id")),
      diagnostic: diagnostic || undefined,
    });
  }

  async #wait(
    milliseconds: number,
    signal: AbortSignal | undefined,
    startedAt: number,
    kind: "network" | "server" | "rate_limit",
  ): Promise<void> {
    const elapsed = this.#now() - startedAt;
    if (elapsed + milliseconds > this.#maxElapsedTimeMs) {
      throw new GitHubApiError(kind, "The GitHub retry would exceed the configured elapsed-time limit.", {
        retryable: true,
        retryAfterMs: milliseconds,
      });
    }
    try {
      await this.#sleep(milliseconds, signal);
    } catch {
      if (signal?.aborted) throw new GitHubApiError("aborted", "The GitHub request was cancelled.");
      throw new GitHubApiError("network", "The GitHub retry wait failed.", { retryable: true });
    }
  }

  #backoff(attempt: number): number {
    const ceiling = Math.min(10_000, 250 * 2 ** attempt);
    return Math.floor(ceiling * (0.5 + this.#random()));
  }
}

export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  return new GitHubClient(options);
}

function toRepository(payload: GitHubRepositoryPayload): GitHubRepository {
  const record = payload as unknown as Record<string, unknown>;
  const rawLicense = payload.license;
  return {
    id: payload.id,
    nodeId: payload.node_id,
    owner: {
      id: payload.owner.id,
      nodeId: payload.owner.node_id,
      login: payload.owner.login,
      ...(payload.owner.type ? { type: payload.owner.type } : {}),
      ...(payload.owner.avatar_url ? { avatarUrl: payload.owner.avatar_url } : {}),
    },
    name: payload.name,
    fullName: payload.full_name,
    canonicalUrl: payload.html_url,
    description: sourceField<string>(record, "description"),
    homepage: sourceField<string>(record, "homepage"),
    topics: sourceField<string[]>(record, "topics"),
    primaryLanguage: sourceField<string>(record, "language"),
    languageBytes: {
      state: "unavailable",
      reason: "Fetch the repository languages endpoint to obtain byte counts.",
    },
    starCount: payload.stargazers_count,
    forkCount: payload.forks_count,
    watcherCount: payload.watchers_count,
    openIssueCount: payload.open_issues_count,
    isArchived: payload.archived,
    isDisabled: payload.disabled,
    isFork: payload.fork,
    isPrivate: payload.private,
    visibility: sourceField<string>(record, "visibility"),
    defaultBranch: sourceField<string>(record, "default_branch"),
    createdAt: payload.created_at,
    updatedAt: payload.updated_at,
    pushedAt: sourceField<string>(record, "pushed_at"),
    license: rawLicense === undefined
      ? { state: "absent" }
      : rawLicense === null
        ? { state: "null" }
        : { state: "present", value: toLicense(rawLicense) },
  };
}

function toRepositorySearchPage(payload: GitHubRepositorySearchPayload): GitHubRepositorySearchPage {
  return {
    totalCount: payload.total_count,
    incompleteResults: payload.incomplete_results,
    items: payload.items.map(toSearchRepository),
  };
}

function toSearchRepository(payload: GitHubSearchRepositoryPayload): GitHubSearchRepository {
  const record = payload as unknown as Record<string, unknown>;
  const owner = payload.owner as unknown as Record<string, unknown>;
  const rawLicense = payload.license;
  return {
    id: payload.id,
    nodeId: payload.node_id,
    owner: {
      id: payload.owner.id,
      nodeId: sourceField<string>(owner, "node_id"),
      login: payload.owner.login,
      type: sourceField<string>(owner, "type"),
    },
    name: payload.name,
    fullName: payload.full_name,
    canonicalUrl: payload.html_url,
    description: sourceField<string>(record, "description"),
    homepage: sourceField<string>(record, "homepage"),
    topics: sourceField<string[]>(record, "topics"),
    primaryLanguage: sourceField<string>(record, "language"),
    starCount: payload.stargazers_count,
    forkCount: payload.forks_count,
    watcherCount: sourceField<number>(record, "watchers_count"),
    openIssueCount: sourceField<number>(record, "open_issues_count"),
    isArchived: sourceField<boolean>(record, "archived"),
    isDisabled: sourceField<boolean>(record, "disabled"),
    isFork: payload.fork,
    isPrivate: payload.private,
    visibility: sourceField<string>(record, "visibility"),
    defaultBranch: sourceField<string>(record, "default_branch"),
    createdAt: payload.created_at,
    updatedAt: payload.updated_at,
    pushedAt: sourceField<string>(record, "pushed_at"),
    license: rawLicense === undefined
      ? { state: "absent" }
      : rawLicense === null
        ? { state: "null" }
        : { state: "present", value: toLicense(rawLicense) },
  };
}

function toLicense(payload: GitHubLicensePayload): GitHubLicenseMetadata {
  const record = payload as unknown as Record<string, unknown>;
  return {
    key: payload.key,
    name: payload.name,
    spdxId: sourceField<string>(record, "spdx_id"),
    url: sourceField<string>(record, "url"),
    htmlUrl: sourceField<string>(record, "html_url"),
    nodeId: sourceField<string>(record, "node_id"),
  };
}

function toRelease(payload: GitHubReleasePayload): GitHubRelease {
  const record = payload as unknown as Record<string, unknown>;
  return {
    id: payload.id,
    nodeId: payload.node_id,
    tagName: payload.tag_name,
    name: sourceField<string>(record, "name"),
    url: payload.url,
    htmlUrl: payload.html_url,
    createdAt: payload.created_at,
    publishedAt: sourceField<string>(record, "published_at"),
    isDraft: payload.draft,
    isPrerelease: payload.prerelease,
  };
}

function repositoryIdentity(id: number): string {
  return `github:repository:${id}`;
}

function repositorySubresourceIdentity(id: number, resource: string): string {
  return `${repositoryIdentity(id)}:${resource}`;
}

function locatorKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function isJsonContentType(value: string): boolean {
  return /^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(value.trim());
}

function safeErrorMessage(body: Uint8Array, token?: string): string {
  try {
    if (!body.byteLength || body.byteLength > MAX_ERROR_BODY_BYTES) return "";
    const text = new TextDecoder().decode(body);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !("message" in parsed)) return "";
    const message = (parsed as { message?: unknown }).message;
    return typeof message === "string" ? redactDiagnostic(message, token) : "";
  } catch {
    return "";
  }
}

async function readLimitedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    cancelResponseBody(response, "Response body exceeded configured byte limit.");
    throw responseTooLarge(response, maxBytes);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        cancelReader(reader, "Response body exceeded configured byte limit.");
        throw responseTooLarge(response, maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(reader, error);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream can still be settling after cancellation; the abort path
      // already requested cancellation and the lock will be released by it.
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    cancelReader(reader, signal.reason);
    return Promise.reject(signal.reason ?? new Error("Response body read was aborted."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      cancelReader(reader, signal.reason);
      finish(() => reject(signal.reason ?? new Error("Response body read was aborted.")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  try {
    void reader.cancel(reason).catch(() => {});
  } catch {
    // Cancellation is best effort for streams that have already errored.
  }
}

function cancelResponseBody(response: Response, reason?: unknown): void {
  try {
    void response.body?.cancel(reason).catch(() => {});
  } catch {
    // The body may already be locked or consumed.
  }
}

function responseTooLarge(response: Response, maxBytes: number): GitHubApiError {
  return new GitHubApiError("response_too_large", `GitHub returned a response larger than the ${maxBytes}-byte limit.`, {
    status: response.status,
  });
}

function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9-]{1,128}$/.test(value) ? value : undefined;
}

function validatePaginationOptions(options: GitHubPaginationOptions): {
  perPage: number;
  maxPages: number;
  maxItems: number;
} {
  const perPage = options.perPage ?? 100;
  const maxPages = options.maxPages ?? 10;
  const maxItems = options.maxItems ?? 1_000;
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw new TypeError("GitHub pagination perPage must be an integer from 1 to 100.");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new TypeError("GitHub pagination maxPages must be an integer from 1 to 100.");
  }
  if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > 10_000) {
    throw new TypeError("GitHub pagination maxItems must be an integer from 0 to 10000.");
  }
  return { perPage, maxPages, maxItems };
}

function validateSearchOptions(options: GitHubSearchOptions): {
  page: number;
  perPage: number;
  sort?: "stars" | "forks" | "help-wanted-issues" | "updated";
  order?: "asc" | "desc";
} {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? 100;
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw new TypeError("GitHub repository search perPage must be an integer from 1 to 100.");
  }
  const maxPage = Math.floor(1_000 / perPage);
  if (!Number.isInteger(page) || page < 1 || page > maxPage) {
    throw new TypeError(`GitHub repository search page must be an integer from 1 to ${maxPage} for this page size.`);
  }
  const validSorts = ["stars", "forks", "help-wanted-issues", "updated"];
  if (options.sort !== undefined && !validSorts.includes(options.sort)) {
    throw new TypeError("GitHub repository search sort is invalid.");
  }
  if (options.order !== undefined && options.order !== "asc" && options.order !== "desc") {
    throw new TypeError("GitHub repository search order must be asc or desc.");
  }
  return {
    page,
    perPage,
    ...(options.sort ? { sort: options.sort } : {}),
    ...(options.order ? { order: options.order } : {}),
  };
}

function validatedNextPage(nextLink: string, expectedPaths: readonly string[], seen: Set<string>): URL {
  try {
    return validateNextPageUrl(nextLink, expectedPaths, seen);
  } catch (error) {
    const message = error instanceof PaginationError ? error.message : "GitHub returned an invalid pagination link.";
    throw new GitHubApiError("pagination", message);
  }
}

function validateSequentialPage(
  nextUrl: URL,
  currentPage: number,
  perPage: number,
  resource: "topics" | "releases",
): void {
  const nextPage = Number(nextUrl.searchParams.get("page"));
  const linkedPageSize = nextUrl.searchParams.get("per_page");
  if (nextPage !== currentPage + 1 || (linkedPageSize !== null && Number(linkedPageSize) !== perPage)) {
    throw new GitHubApiError("pagination", `GitHub returned a non-sequential ${resource} page link.`);
  }
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
