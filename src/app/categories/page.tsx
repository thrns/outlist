import type {Metadata} from "next";
import {CategoriesPage} from "@/components/directory/categories-page";
export const metadata:Metadata={title:"Categories",description:"Browse active categories in the published open-source catalog."};
export const dynamic = "force-dynamic";

import {getPublicCategories,getPublicCatalogFacets} from "@/lib/catalog/public";
import {CatalogError} from "@/components/directory/catalog-error";
import {publicCatalogErrorDescription} from "@/lib/catalog/messages";

export default async function Page() {
  let result;
  try {
    const [categories, facets] = await Promise.all([getPublicCategories(), getPublicCatalogFacets()]);
    result = {
      categories,
      categoryCounts: Object.fromEntries(facets.categoryCounts.map((item) => [item.slug, item.projectCount])),
    };
  } catch (error) {
    return <CatalogError description={publicCatalogErrorDescription(error)} retryHref="/categories" />;
  }
  return <CategoriesPage categories={result.categories} categoryCounts={result.categoryCounts} />;
}
