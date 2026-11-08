import "server-only";

import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isValidProjectLogoStoragePath } from "@/lib/logos/resolve";

const categoryIconSchema = z.string().min(1).max(40);

const categoryReferenceSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
});

const categorySchema = categoryReferenceSchema.extend({
  description: z.string().max(500),
  icon: categoryIconSchema,
});

const projectSchema = z.object({
  id: z.uuid(),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(120),
  summary: z.string().max(280),
  descriptionExcerpt: z.string().max(600),
  officialWebsiteUrl: z.string().url().max(2048).nullable(),
  publishedAt: z.iso.datetime({ offset: true }),
  primaryCategory: categoryReferenceSchema,
  categories: z.array(categoryReferenceSchema).max(20),
  categoryIds: z.array(z.uuid()).max(20),
  categorySlugs: z.array(z.string().min(1).max(80)).max(20),
  tags: z.array(z.string().min(1).max(256)).max(50),
  repository: z.object({
    provider: z.literal("github"),
    providerRepositoryId: z.string().regex(/^[1-9][0-9]{0,18}$/),
    fullName: z.string().min(3).max(140),
    url: z.string().url().max(2048),
    stars: z.number().int().nonnegative().safe(),
    forks: z.number().int().nonnegative().safe(),
    primaryLanguage: z.string().max(50).nullable(),
    activityAt: z.iso.datetime({ offset: true }).nullable(),
  }),
  license: z.object({
    identifier: z.string().min(1).max(64),
    verified: z.literal(true),
  }),
  logo: z.object({
    id: z.uuid(),
    kind: z.enum(["official_logo", "provider_avatar"]),
    origin: z.enum(["official_site", "editorial", "submitted", "provider_avatar"]),
    storagePath: z.string().min(1).max(256),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    attribution: z.string().max(500).nullable(),
  }).nullable(),
  fallback: z.object({
    initial: z.string().min(1).max(8),
    seed: z.uuid(),
    version: z.literal("letter-fallback-v1"),
  }),
});

const responseSchema = z.object({
  items: z.array(projectSchema).max(50),
  page: z.number().int().min(1).max(1000),
  pageSize: z.number().int().min(1).max(50),
  totalCount: z.number().int().nonnegative().safe(),
  hasMore: z.boolean(),
  sort: z.enum(["relevance", "stars", "updated", "newest", "name"]),
});

const filtersSchema = z.object({
  query: z.string().trim().max(120).optional(),
  categories: z.array(z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80)).max(20).optional(),
  licenses: z.array(z.string().trim().regex(/^[A-Za-z0-9.+-]{1,64}$/)).max(20).optional(),
  languages: z.array(z.string().trim().regex(/^[\p{L}\p{N}_+#.-]{1,50}$/u)).max(20).optional(),
  sort: z.enum(["relevance", "stars", "updated", "newest", "name"]).default("relevance"),
  page: z.number().int().min(1).max(1000).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
}).strict();

export type PublicCatalogSort = z.infer<typeof filtersSchema>["sort"];
export type PublicCatalogProject = z.infer<typeof projectSchema>;
export type PublicCatalogSearchResult = z.infer<typeof responseSchema>;
export type PublicCatalogFilters = z.input<typeof filtersSchema>;
export type PublicCatalogProjectView = Omit<PublicCatalogProject, "logo"> & {
  logo: (NonNullable<PublicCatalogProject["logo"]> & { publicUrl: string }) | null;
};

export type PublicCatalogCategory = z.infer<typeof categorySchema>;

export interface PublicCatalogFacets {
  categoryCounts: Array<{ slug: string; projectCount: number }>;
  licenses: string[];
  languages: string[];
}

const facetsSchema = z.object({
  categoryCounts: z.array(z.object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
    projectCount: z.number().int().nonnegative().safe(),
  })).max(200),
  licenses: z.array(z.string().regex(/^[A-Za-z0-9.+-]{1,64}$/)).max(100),
  languages: z.array(z.string().regex(/^[\p{L}\p{N}_+#.-]{1,50}$/u)).max(100),
});

export class PublicCatalogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicCatalogInputError";
  }
}

export class PublicCatalogQueryError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "PublicCatalogQueryError";
    this.code = code;
  }
}

function parseFilters(input: PublicCatalogFilters): z.infer<typeof filtersSchema> {
  const parsed = filtersSchema.safeParse(input);
  if (!parsed.success) {
    throw new PublicCatalogInputError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  if (parsed.data.query && (parsed.data.query.length < 3 || parsed.data.query.split(/\s+/).length > 8)) {
    throw new PublicCatalogInputError("Search text must contain at least 3 characters and no more than 8 terms.");
  }
  return {
    ...parsed.data,
    query: parsed.data.query || undefined,
    categories: [...new Set(parsed.data.categories ?? [])],
    licenses: [...new Set(parsed.data.licenses ?? [])],
    languages: [...new Set(parsed.data.languages ?? [])],
  };
}

function parseResponse(value: unknown): PublicCatalogSearchResult {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) {
    const issuePaths = parsed.error.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`).join(",");
    throw new PublicCatalogQueryError(`The public catalog returned a response outside its documented shape (${issuePaths.slice(0, 200)}).`);
  }
  for (const item of parsed.data.items) {
    if (item.primaryCategory.id !== item.categoryIds[0]
      || item.primaryCategory.slug !== item.categorySlugs[0]
      || item.categories.length !== item.categoryIds.length
      || item.categories.some((category, index) => category.id !== item.categoryIds[index] || category.slug !== item.categorySlugs[index])) {
      throw new PublicCatalogQueryError("The public catalog returned inconsistent category metadata.");
    }
    if (item.logo && item.logo.kind === "provider_avatar" && item.logo.origin !== "provider_avatar") {
      throw new PublicCatalogQueryError("The public catalog returned inconsistent logo attribution metadata.");
    }
    if (item.logo && item.logo.kind === "official_logo" && item.logo.origin === "provider_avatar") {
      throw new PublicCatalogQueryError("The public catalog returned an owner avatar as an official logo.");
    }
  }
  return parsed.data;
}

function safeDatabaseMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

/** Search published projects through the anonymous/authenticated Supabase session and public RLS. */
export async function searchPublicProjects(input: PublicCatalogFilters = {}): Promise<PublicCatalogSearchResult> {
  const filters = parseFilters(input);
  return executeSearch(filters);
}

async function executeSearch(
  filters: z.infer<typeof filtersSchema>,
  slug?: string,
): Promise<PublicCatalogSearchResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("search_public_projects", {
    p_query: filters.query,
    p_categories: filters.categories ?? [],
    p_licenses: filters.licenses ?? [],
    p_languages: filters.languages ?? [],
    p_sort: filters.sort,
    p_page: filters.page,
    p_page_size: filters.pageSize,
    p_slug: slug,
  });
  if (error) {
    if (error.code === "22023") throw new PublicCatalogInputError(safeDatabaseMessage(error.message));
    throw new PublicCatalogQueryError(`Public catalog search failed (${error.code}): ${safeDatabaseMessage(error.message)}`, error.code);
  }
  return parseResponse(data);
}

/** Read active category navigation data. The public categories RLS policy hides inactive entries. */
export async function getPublicCategories(): Promise<PublicCatalogCategory[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("categories")
    .select("id, slug, name, description, icon_identifier, sort_order")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(200);
  if (error) {
    throw new PublicCatalogQueryError(`Public category lookup failed (${error.code}): ${safeDatabaseMessage(error.message)}`, error.code);
  }
  return (data ?? []).map((category) => {
    const parsed = categorySchema.safeParse({
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description,
      icon: category.icon_identifier,
    });
    if (!parsed.success) throw new PublicCatalogQueryError("The public category list returned invalid metadata.");
    return parsed.data;
  });
}

/** Fetch compact, database-aggregated facets for the genuinely visible catalog. */
export async function getPublicCatalogFacets(): Promise<PublicCatalogFacets> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_public_catalog_facets");
  if (error) {
    throw new PublicCatalogQueryError(`Public catalog facets failed (${error.code}): ${safeDatabaseMessage(error.message)}`, error.code);
  }
  const parsed = facetsSchema.safeParse(data);
  if (!parsed.success) throw new PublicCatalogQueryError("The public catalog returned invalid filter metadata.");
  return parsed.data;
}

/** Add only public Storage URLs derived from the approved, project-scoped path. */
export async function withPublicProjectLogos<T extends PublicCatalogProject>(
  projects: readonly T[],
): Promise<Array<Omit<T, "logo"> & { logo: PublicCatalogProjectView["logo"] }>> {
  const eligible = projects.filter((project) =>
    project.logo && isValidProjectLogoStoragePath(project.id, project.logo.storagePath),
  );
  if (eligible.length === 0) return projects.map((project) => ({ ...project, logo: null }));
  const supabase = await createSupabaseServerClient();
  return projects.map((project) => {
    const logo = project.logo;
    if (!logo || !isValidProjectLogoStoragePath(project.id, logo.storagePath)) {
      return { ...project, logo: null };
    }
    const { data } = supabase.storage.from("project-logos").getPublicUrl(logo.storagePath);
    return { ...project, logo: { ...logo, publicUrl: data.publicUrl } };
  });
}

/** Return null for unknown, unpublished, invalidly published, or repository-restricted slugs. */
export async function getPublicProjectBySlug(slug: string): Promise<PublicCatalogProject | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) return null;
  const filters = filtersSchema.parse({ sort: "newest", page: 1, pageSize: 1 });
  const result = await executeSearch(filters, slug);
  return result.items[0] ?? null;
}

/** Read the complete approved description through the same public RLS boundary. */
export async function getPublicProjectDescriptionBySlug(slug: string): Promise<string | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("projects").select("description").eq("slug", slug).maybeSingle();
  if (error) {
    throw new PublicCatalogQueryError(`Public project detail lookup failed (${error.code}): ${safeDatabaseMessage(error.message)}`, error.code);
  }
  if (data === null || typeof data.description !== "string") return null;
  return data.description;
}
