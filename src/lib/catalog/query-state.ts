import type { PublicCatalogSort } from "@/lib/catalog/public";

export type DirectorySearchParams = Record<string, string | string[] | undefined>;
export interface DirectoryState {
  query: string;
  categories: string[];
  licenses: string[];
  languages: string[];
  sort: PublicCatalogSort;
  page: number;
}

const sortValues = new Set<PublicCatalogSort>(["relevance", "stars", "updated", "newest", "name"]);

function values(value: string | string[] | undefined): string[] {
  const input = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return [...new Set(input.map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}

export function parseDirectoryState(params: DirectorySearchParams): DirectoryState {
  const rawPage = Array.isArray(params.page) ? params.page[0] : params.page;
  const pageNumber = Number(rawPage);
  const rawSort = Array.isArray(params.sort) ? params.sort[0] : params.sort;
  const rawQuery = Array.isArray(params.q) ? params.q[0] : params.q;
  const query = (rawQuery ?? "").trim();
  return {
    query: query.slice(0, 120),
    categories: values(params.category).filter((item) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item) && item.length <= 80),
    licenses: values(params.license).filter((item) => /^[A-Za-z0-9.+-]{1,64}$/.test(item)),
    languages: values(params.language).filter((item) => /^[\p{L}\p{N}_+#.-]{1,50}$/u.test(item)),
    sort: rawSort && sortValues.has(rawSort as PublicCatalogSort) ? rawSort as PublicCatalogSort : "relevance",
    page: Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= 1000 ? pageNumber : 1,
  };
}

export function directoryUrl(pathname: string, state: DirectoryState): string {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  for (const category of state.categories) params.append("category", category);
  for (const license of state.licenses) params.append("license", license);
  for (const language of state.languages) params.append("language", language);
  if (state.sort !== "relevance") params.set("sort", state.sort);
  if (state.page > 1) params.set("page", String(state.page));
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function emptyPublicSearch(sort: PublicCatalogSort, page: number, pageSize: number) {
  return { items: [], page, pageSize, totalCount: 0, hasMore: false, sort } as const;
}
