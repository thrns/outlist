import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { CatalogError } from "@/components/directory/catalog-error";
import { ProjectDirectory } from "@/components/directory/project-directory";
import { publicCatalogErrorDescription, publicCatalogErrorTitle } from "@/lib/catalog/messages";
import { getPublicCategories, getPublicCatalogFacets, type PublicCatalogCategory, type PublicCatalogFacets } from "@/lib/catalog/public";
import { directoryUrl, parseDirectoryState, type DirectorySearchParams } from "@/lib/catalog/query-state";
import { loadPublicDirectory, type PublicDirectoryResult } from "@/lib/catalog/public-pages";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  try {
    const { id } = await params;
    const category = (await getPublicCategories()).find((item) => item.slug === id);
    return { title: category?.name ?? "Category", description: category?.description };
  } catch {
    return { title: "Category", description: "Browse projects published in an Outlist category." };
  }
}

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<DirectorySearchParams>;
}) {
  const [{ id }, rawSearchParams] = await Promise.all([params, searchParams]);
  const state = { ...parseDirectoryState(rawSearchParams), categories: [] };
  let categories: PublicCatalogCategory[];
  let facets: PublicCatalogFacets;
  try {
    [categories, facets] = await Promise.all([getPublicCategories(), getPublicCatalogFacets()]);
  } catch (error) {
    return <CatalogError description={publicCatalogErrorDescription(error)} title={publicCatalogErrorTitle(error)} retryHref={"/category/" + id} />;
  }
  const category = categories.find((item) => item.slug === id);
  if (!category) notFound();
  if (rawSearchParams.category !== undefined) redirect(directoryUrl("/category/" + id, state));

  let results: PublicDirectoryResult;
  try {
    results = await loadPublicDirectory(state, category.slug);
  } catch (error) {
    return <CatalogError description={publicCatalogErrorDescription(error)} title={publicCatalogErrorTitle(error)} retryHref={directoryUrl("/category/" + id, state)} />;
  }
  const lastPage = Math.max(1, Math.ceil(results.totalCount / results.pageSize));
  if (state.page > lastPage) redirect(directoryUrl("/category/" + id, { ...state, page: lastPage }));
  return <ProjectDirectory
    key={JSON.stringify([id, state])}
    state={state}
    results={results}
    categories={categories}
    facets={facets}
    category={category}
  />;
}
