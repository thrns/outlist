import {HomePage} from "@/components/home/home-page";
import {CatalogError} from "@/components/directory/catalog-error";
import {publicCatalogErrorDescription} from "@/lib/catalog/messages";
import {getPublicCategories,getPublicCatalogFacets,searchPublicProjects,withPublicProjectLogos} from "@/lib/catalog/public";

export const dynamic = "force-dynamic";

export default async function Page() {
  let result;
  try {
    const [categories, facets, stars, recent] = await Promise.all([
      getPublicCategories(),
      getPublicCatalogFacets(),
      searchPublicProjects({ sort: "stars", page: 1, pageSize: 6 }),
      searchPublicProjects({ sort: "newest", page: 1, pageSize: 8 }),
    ]);
    const [mostStarred, recentlyPublished] = await Promise.all([
      withPublicProjectLogos(stars.items),
      withPublicProjectLogos(recent.items),
    ]);
    result = {
      categories,
      categoryCounts: Object.fromEntries(facets.categoryCounts.map((item) => [item.slug, item.projectCount])),
      mostStarred,
      recentlyPublished,
      totalProjects: recent.totalCount,
    };
  } catch (error) {
    return <CatalogError description={publicCatalogErrorDescription(error)} retryHref="/" />;
  }
  return <HomePage {...result} />;
}
