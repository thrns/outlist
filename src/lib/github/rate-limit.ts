import type { GitHubRateLimit } from "./types";

export function parseRateLimitHeaders(headers: Headers, nowMs: number): GitHubRateLimit | undefined {
  const limit = parseNumber(headers.get("x-ratelimit-limit"));
  const remaining = parseNumber(headers.get("x-ratelimit-remaining"));
  const resetEpochSeconds = parseNumber(headers.get("x-ratelimit-reset"));
  const resource = headers.get("x-ratelimit-resource") ?? undefined;
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"), nowMs);
  if (
    limit === undefined && remaining === undefined && resetEpochSeconds === undefined &&
    resource === undefined && retryAfterMs === undefined
  ) return undefined;
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(resetEpochSeconds === undefined ? {} : {
      resetEpochSeconds,
      ...(resetEpochSeconds <= 8_640_000_000_000
        ? { resetAt: new Date(resetEpochSeconds * 1000).toISOString() }
        : {}),
    }),
    ...(resource === undefined ? {} : { resource }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(remaining === 0 ? { kind: "primary" as const } : {}),
  };
}

export function classifyRateLimitResponse(
  status: number,
  rateLimit: GitHubRateLimit | undefined,
  message: string,
): "primary" | "secondary" | undefined {
  if (rateLimit?.remaining === 0) return "primary";
  if (
    status === 429 || rateLimit?.retryAfterMs !== undefined ||
    /secondary rate limit|abuse detection|rate limit exceeded/i.test(message)
  ) {
    return "secondary";
  }
  return undefined;
}

export function requiredRateLimitWaitMs(
  rateLimit: GitHubRateLimit | undefined,
  kind: "primary" | "secondary",
  nowMs: number,
): number {
  if (rateLimit?.retryAfterMs !== undefined) return rateLimit.retryAfterMs;
  if (kind === "primary" && rateLimit?.resetEpochSeconds !== undefined) {
    return Math.max(0, rateLimit.resetEpochSeconds * 1000 - nowMs);
  }
  // GitHub asks integrations to wait at least one minute when no more precise
  // secondary-limit instruction is present.
  return 60_000;
}

function parseNumber(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - nowMs);
}
