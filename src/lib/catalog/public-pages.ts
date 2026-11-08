import "server-only";

import { emptyPublicSearch, type DirectoryState } from "@/lib/catalog/query-state";
import {
  searchPublicProjects,
  withPublicProjectLogos,
  type PublicCatalogProjectView,
  type PublicCatalogSearchResult,
} from "@/lib/catalog/public";

export const PUBLIC_PAGE_SIZE = 9;

export type PublicDirectoryResult = Omit<PublicCatalogSearchResult, "items"> & {
  items: PublicCatalogProjectView[];
};

export async function loadPublicDirectory(
  state: DirectoryState,
  fixedCategory?: string,
): Promise<PublicDirectoryResult> {
  if (state.query.length > 0 && state.query.length < 3) {
    return { ...emptyPublicSearch(state.sort, state.page, PUBLIC_PAGE_SIZE), items: [] };
  }
  const categories = fixedCategory ? [fixedCategory] : state.categories;
  const result = await searchPublicProjects({
    query: state.query || undefined,
    categories,
    licenses: state.licenses,
    languages: state.languages,
    sort: state.sort,
    page: state.page,
    pageSize: PUBLIC_PAGE_SIZE,
  });
  return { ...result, items: await withPublicProjectLogos(result.items) };
}
