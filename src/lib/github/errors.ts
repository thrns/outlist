import type { GitHubRateLimit } from "./types";

export type GitHubErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "rate_limit"
  | "server"
  | "timeout"
  | "aborted"
  | "network"
  | "malformed_payload"
  | "unexpected_content_type"
  | "response_too_large"
  | "pagination"
  | "request";

export class GitHubApiError extends Error {
  readonly name = "GitHubApiError";

  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly options: {
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      rateLimit?: GitHubRateLimit;
      requestId?: string;
      diagnostic?: string;
      sourceApiUrl?: string;
      fetchedAt?: string;
      httpStatus?: number;
    } = {},
  ) {
    super(message);
  }

  get status(): number | undefined {
    return this.options.status;
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }

  get rateLimit(): GitHubRateLimit | undefined {
    return this.options.rateLimit;
  }

  get requestId(): string | undefined {
    return this.options.requestId;
  }

  get diagnostic(): string | undefined {
    return this.options.diagnostic;
  }

  get sourceApiUrl(): string | undefined {
    return this.options.sourceApiUrl;
  }

  get fetchedAt(): string | undefined {
    return this.options.fetchedAt;
  }

  get httpStatus(): number | undefined {
    return this.options.httpStatus;
  }
}

export function redactDiagnostic(value: string, token?: string): string {
  let result = value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 240);
  if (token) result = result.split(token).join("[redacted]");
  return result
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\btoken\s+\S+/gi, "token [redacted]");
}

export function statusError(
  status: number,
  options: {
    rateLimit?: GitHubRateLimit;
    requestId?: string;
    diagnostic?: string;
    rateLimitKind?: "primary" | "secondary";
    retryAfterMs?: number;
  } = {},
): GitHubApiError {
  const safeDetails = {
    status,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  };
  if (status === 401) return new GitHubApiError("unauthorized", "GitHub rejected the credentials.", safeDetails);
  if (status === 403 && options.rateLimitKind) {
    return new GitHubApiError("rate_limit", "GitHub rate limits this request.", {
      ...safeDetails,
      retryable: true,
      rateLimit: { ...(options.rateLimit ?? {}), kind: options.rateLimitKind },
    });
  }
  if (status === 403) return new GitHubApiError("forbidden", "GitHub denied access to this resource.", safeDetails);
  if (status === 404) {
    return new GitHubApiError(
      "not_found",
      "GitHub returned 404. The resource may be unavailable, private, or deleted; this response does not establish deletion.",
      safeDetails,
    );
  }
  if (status === 422) return new GitHubApiError("validation", "GitHub rejected the request parameters.", safeDetails);
  if (status === 429) {
    return new GitHubApiError("rate_limit", "GitHub rate limits this request.", {
      ...safeDetails,
      retryable: true,
      rateLimit: { ...(options.rateLimit ?? {}), kind: options.rateLimitKind ?? "secondary" },
    });
  }
  if (status === 408) {
    return new GitHubApiError("timeout", "GitHub timed out while processing the request.", {
      ...safeDetails,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new GitHubApiError("server", "GitHub returned a server error.", {
      ...safeDetails,
      retryable: true,
    });
  }
  return new GitHubApiError("request", `GitHub returned HTTP ${status}.`, safeDetails);
}
