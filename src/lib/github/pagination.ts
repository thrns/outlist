import { GITHUB_API_ORIGIN } from "./types";

export class PaginationError extends Error {
  readonly kind = "pagination" as const;

  constructor(message: string) {
    super(message);
    this.name = "PaginationError";
  }
}

export function getNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.trim().match(/^<([^>]+)>\s*;(.*)$/);
    if (!match) continue;
    if (/(?:^|;)\s*rel\s*=\s*(?:"next"|'next'|next)(?:\s*;|$)/i.test(`;${match[2]}`)) {
      return match[1];
    }
  }
  return undefined;
}

export function validateNextPageUrl(
  href: string,
  expectedPath: string | readonly string[],
  seen: Set<string>,
): URL {
  let url: URL;
  try {
    url = new URL(href, GITHUB_API_ORIGIN);
  } catch {
    throw new PaginationError("GitHub returned an invalid pagination URL.");
  }
  const expectedPaths = typeof expectedPath === "string" ? [expectedPath] : expectedPath;
  if (url.origin !== GITHUB_API_ORIGIN || !expectedPaths.includes(url.pathname)) {
    throw new PaginationError("GitHub returned a pagination URL outside the expected API endpoint.");
  }
  if (url.username || url.password || url.hash) {
    throw new PaginationError("GitHub returned an unsafe pagination URL.");
  }
  const allowed = new Set(["page", "per_page"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new PaginationError("GitHub returned unexpected pagination parameters.");
    if (url.searchParams.getAll(key).length !== 1) {
      throw new PaginationError("GitHub returned duplicate pagination parameters.");
    }
  }
  const page = url.searchParams.get("page");
  const perPage = url.searchParams.get("per_page");
  if (page !== null && (!/^\d+$/.test(page) || Number(page) < 1)) {
    throw new PaginationError("GitHub returned an invalid pagination page number.");
  }
  if (perPage !== null && (!/^\d+$/.test(perPage) || Number(perPage) < 1 || Number(perPage) > 100)) {
    throw new PaginationError("GitHub returned an invalid pagination page size.");
  }
  if (seen.has(url.href)) throw new PaginationError("GitHub returned a repeated pagination URL.");
  seen.add(url.href);
  return url;
}
