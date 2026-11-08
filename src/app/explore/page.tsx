import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProjectDirectory } from "@/components/directory/project-directory";
import { CatalogError } from "@/components/directory/catalog-error";
import { publicCatalogErrorDescription, publicCatalogErrorTitle } from "@/lib/catalog/messages";
import { getPublicCategories, getPublicCatalogFacets, type PublicCatalogCategory, type PublicCatalogFacets } from "@/lib/catalog/public";
import { parseDirectoryState, directoryUrl, type DirectorySearchParams } from "@/lib/catalog/query-state";
import { loadPublicDirectory, type PublicDirectoryResult } from "@/lib/catalog/public-pages";

export const metadata: Metadata = { title: "Explore", description: "Search and compare published open-source projects." };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<DirectorySearchParams> }) {
  const state = parseDirectoryState(await searchParams);
  let categories: PublicCatalogCategory[];
  let facets: PublicCatalogFacets;
  let results: PublicDirectoryResult;
  try {
    [categories, facets, results] = await Promise.all([
      getPublicCategories(),
      getPublicCatalogFacets(),
      loadPublicDirectory(state),
    ]);
  } catch (error) {
    console.error("Public explore catalog request failed " + JSON.stringify(error instanceof Error
      ? { name: error.name, code: "code" in error ? error.code : undefined, message: error.message.slice(0, 300) }
      : { name: "UnknownError" }));
    return <CatalogError description={publicCatalogErrorDescription(error)} title={publicCatalogErrorTitle(error)} retryHref={directoryUrl("/explore", state)} />;
  }
  const lastPage = Math.max(1, Math.ceil(results.totalCount / results.pageSize));
  if (state.page > lastPage) redirect(directoryUrl("/explore", { ...state, page: lastPage }));
  return <ProjectDirectory
    key={JSON.stringify(state)}
    state={state}
    results={results}
    categories={categories}
    facets={facets}
  />;
}
