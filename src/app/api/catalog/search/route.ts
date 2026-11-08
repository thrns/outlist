import { NextRequest, NextResponse } from "next/server";
import { getPublicCategories, PublicCatalogInputError, searchPublicProjects, withPublicProjectLogos } from "@/lib/catalog/public";
import { publicCatalogErrorDescription } from "@/lib/catalog/messages";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function GET(request: NextRequest) {
  const query = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (query.length > 120) return json({ error: "Search text must be 120 characters or fewer." }, 400);
  if (!query) return json({ projects: [], categories: [], requiresLongerQuery: false });

  try {
    const categories = await getPublicCategories();
    const matchingCategories = categories.filter((category) =>
      category.name.toLowerCase().includes(query.toLowerCase()),
    ).slice(0, 3);
    if (query.length < 3) {
      return json({ projects: [], categories: matchingCategories, requiresLongerQuery: true });
    }
    const result = await searchPublicProjects({ query, sort: "relevance", page: 1, pageSize: 7 });
    return json({
      projects: await withPublicProjectLogos(result.items),
      categories: matchingCategories,
      requiresLongerQuery: false,
    });
  } catch (error) {
    if (error instanceof PublicCatalogInputError) return json({ error: error.message }, 400);
    return json({ error: publicCatalogErrorDescription(error) }, 503);
  }
}
