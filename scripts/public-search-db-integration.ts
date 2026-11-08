import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import type { Database } from "../src/lib/supabase/database.types";

type SearchPayload = {
  items: Array<{
    id: string;
    slug: string;
    name: string;
    summary: string;
    descriptionExcerpt: string;
    primaryCategory: { id: string; slug: string; name: string };
    categoryIds: string[];
    categorySlugs: string[];
    tags: string[];
    repository: { fullName: string; stars: number; forks: number; primaryLanguage: string | null };
    license: { identifier: string; verified: true };
    logo: null | { kind: "official_logo" | "provider_avatar"; origin: string; storagePath: string; attribution: string | null };
    fallback: { initial: string; seed: string; version: string };
  }>;
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
  sort: string;
};

type DbError = { code: string; message: string };
type DbResult<T> = PromiseLike<{ data: T | null; error: DbError | null }>;
let assertionCount = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  assertionCount += 1;
}

async function must<T>(request: DbResult<T>, label: string): Promise<T> {
  const { data, error } = await request;
  if (error) throw new Error(`${label} failed (${error.code}): ${error.message.replace(/[\r\n\t]+/g, " ").slice(0, 300)}`);
  if (data === null) throw new Error(`${label} returned no data.`);
  return data;
}

function uuidFor(seed: string): string {
  const hex = createHash("md5").update(seed).digest("hex");
  const versioned = `${hex.slice(0, 12)}4${hex.slice(13, 16)}8${hex.slice(17)}`;
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20)}`;
}

async function runSql(sql: string): Promise<string> {
  const file = join(tmpdir(), `outlist-m108-${randomUUID()}.sql`);
  try {
    await writeFile(file, sql, { encoding: "utf8", mode: 0o600 });
    return execFileSync(join(process.cwd(), "node_modules/.bin/supabase"), ["db", "query", "--file", file, "--output-format", "json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

async function indexedPlanProbes(token: string): Promise<string> {
  await runSql("drop table if exists private.m108_query_plans");
  await runSql("create table private.m108_query_plans (probe text, line_number integer generated always as identity, plan_line text)");
  await runSql(`do $block$
declare plan_line text;
begin
  perform pg_catalog.set_config('enable_seqscan', 'off', true);
  for plan_line in execute $plan$explain (costs off) select id from public.projects
    where search_document @@ plainto_tsquery('english', 'needle honeycomb')$plan$
  loop insert into private.m108_query_plans (probe, plan_line) values ('full_text', plan_line); end loop;
  for plan_line in execute $plan$explain (costs off) select id from public.projects
    where name ilike '%${token} Alphx%'$plan$
  loop insert into private.m108_query_plans (probe, plan_line) values ('trigram', plan_line); end loop;
  for plan_line in execute $plan$explain (costs off) select id from public.projects
    where publication_status = 'published'
      and license_status = 'verified_open_source' and license_identifier = 'MIT'$plan$
  loop insert into private.m108_query_plans (probe, plan_line) values ('license', plan_line); end loop;
  for plan_line in execute $plan$explain (costs off) select id from public.repositories
    where availability_status = 'available' and primary_language is not null
      and lower(primary_language) = 'typescript'$plan$
  loop insert into private.m108_query_plans (probe, plan_line) values ('language', plan_line); end loop;
end;
$block$`);
  const plan = await runSql(`select probe, string_agg(plan_line, E'\\n' order by line_number) as plan
from private.m108_query_plans group by probe order by probe`);
  await runSql("drop table private.m108_query_plans");
  return plan;
}

function fixtureDataCte(token: string): string {
  const safeToken = token.replace(/[^a-f0-9]/g, "");
  return `
with m108_fixture_data as materialized (
select i,
  '${safeToken}'::text as token,
  (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid as project_id,
  (substr(rh, 1, 8) || '-' || substr(rh, 9, 4) || '-4' || substr(rh, 14, 3) || '-8' || substr(rh, 18, 3) || '-' || substr(rh, 21, 12))::uuid as repository_id,
  (1000000000000 + abs(hashtextextended('${safeToken}', 0) % 1000000000000) + i)::text as provider_repository_id,
  'm108${safeToken}'::text as owner_login,
  case i
    when 1 then 'M108 ${safeToken} Alpha'
    when 2 then 'M108 ${safeToken} Alphx'
    when 3 then 'Summary target ${safeToken}'
    when 4 then 'Aardvark ${safeToken} Description'
    when 1001 then 'Unpublished ${safeToken} Draft'
    when 1002 then 'Rejected ${safeToken} Project'
    when 1003 then 'Restricted ${safeToken} Project'
    else 'Fixture ${safeToken} Project ' || lpad(i::text, 4, '0')
  end as project_name,
  case when i = 3 then 'Summary needle ${safeToken} honeycomb'
    else 'Performance fixture ${safeToken} open source project' end as summary_text,
  case when i = 4 then 'Description needle ${safeToken} honeycomb'
    else 'Description fixture ${safeToken} open source project' end as description_text,
  case when i % 100 = 1 then 'MIT' else 'Apache-2.0' end as license_identifier,
  case when i % 2 = 1 then 'TypeScript' else 'Python' end as language_name,
  case when i % 2 = 1 then 'developer-tools' else 'ai-machine-learning' end as category_slug,
  i <= 1000 as should_publish,
  i = 1002 as should_reject,
  i = 1003 as restricted
from generate_series(1, 1003) as series(i)
cross join lateral (select md5('${safeToken}' || '-p-' || i::text) h, md5('${safeToken}' || '-r-' || i::text) rh) hashes;
`;
}

function fixtureStatements(token: string): string[] {
  const data = fixtureDataCte(token);
  const safeToken = token.replace(/[^a-f0-9]/g, "");
  return [`${data.replace(/;\s*$/, ")")}
insert into public.projects (
  id, slug, name, summary, description, license_status, license_identifier,
  license_verified_at, quality_status, last_verified_at, publication_status
)
select project_id, 'm108-${safeToken}-' || i::text, project_name, summary_text, description_text,
  'verified_open_source', license_identifier, now(), 'verified', now(), 'draft'
from m108_fixture_data;
`, `${data.replace(/;\s*$/, ")")}

insert into public.repositories (
  id, project_id, provider, provider_repository_id, full_name, canonical_url,
  primary_language, stars, forks, is_archived, is_fork,
  provider_pushed_at, last_successful_sync_at, availability_status,
  owner_login, repository_name, is_private, visibility, is_disabled,
  source_field_states, source_observed_at
)
select d.repository_id, d.project_id,
  case when d.restricted then 'other' else 'github' end,
  d.provider_repository_id,
  d.owner_login || '/repo-' || d.i::text,
  case when d.restricted then 'https://example.test/repo-' || d.i::text
    else 'https://github.com/' || d.owner_login || '/repo-' || d.i::text end,
  d.language_name,
  10000000 - d.i,
  1000000 - d.i,
  false, false,
  now() - d.i * interval '1 minute',
  now() - interval '1 day',
  'available',
  d.owner_login,
  'repo-' || d.i::text,
  d.restricted,
  case when d.restricted then 'private' else 'public' end,
  false,
  jsonb_build_object('visibility', 'present', 'license', 'present'),
  now() - interval '1 day'
from m108_fixture_data d;
`, `${data.replace(/;\s*$/, ")")}

insert into public.project_categories (project_id, category_id)
select d.project_id, c.id
from m108_fixture_data d
join public.categories c on c.slug = d.category_slug
union all
select d.project_id, c.id
from m108_fixture_data d
join public.categories c on c.slug = case when d.category_slug = 'developer-tools' then 'ai-machine-learning' else 'developer-tools' end
where d.i = 1;
`, `${data.replace(/;\s*$/, ")")}

update public.projects p set
  primary_repository_id = d.repository_id,
  publication_status = case when d.should_publish or d.restricted then 'published'
    when d.should_reject then 'rejected' else 'draft' end,
  published_at = case when d.should_publish or d.restricted then now() - d.i * interval '1 minute' else null end
from m108_fixture_data d
where p.id = d.project_id;
`];
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  assert(url && publicKey && serviceKey, "Local Supabase public URL/key and service key are required.");
  const token = randomUUID().replaceAll("-", "").slice(0, 8);
  const projectSlug = (i: number) => `m108-${token}-${i}`;
  const projectId = uuidFor(`${token}-p-1`);
  const avatarOnlyProjectId = uuidFor(`${token}-p-2`);
  const fallbackProjectId = uuidFor(`${token}-p-3`);
  const logoIds = ["official", "avatar-first", "avatar-only"].map((key) => uuidFor(`${token}-${key}`));
  const storagePaths = [
    `${projectId}/${logoIds[0]}.webp`,
    `${projectId}/${logoIds[1]}.webp`,
    `${avatarOnlyProjectId}/${logoIds[2]}.webp`,
  ];
  const service = createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }) },
  });
  const anonymous = createClient<Database>(url, publicKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const uploaded: string[] = [];
  let fixtureCreated = false;

  try {
    const empty = await must(anonymous.rpc("search_public_projects", {}), "Anonymous empty-catalog search");
    assert((empty as unknown as SearchPayload).totalCount === 0 && (empty as unknown as SearchPayload).items.length === 0,
      "An empty catalog must return a successful empty page with a zero total.");

    fixtureCreated = true;
    for (const statement of fixtureStatements(token)) await runSql(statement);

    const webp = await sharp({ create: { width: 1, height: 1, channels: 4, background: "#3578d4" } }).webp().toBuffer();
    for (const path of storagePaths) {
      const { error } = await service.storage.from("project-logos").upload(path, webp, {
        contentType: "image/webp", upsert: true, cacheControl: "60",
      });
      if (error) throw new Error(`Upload a temporary approved-logo fixture failed: ${error.message.slice(0, 200)}`);
      uploaded.push(path);
    }

    const approvedAt = new Date(Date.now() - 60_000).toISOString();
    const avatarApprovedAt = new Date().toISOString();
    const logoRows = [
      `('${logoIds[0]}', '${projectId}', 'https://example.test/logo.webp', '${storagePaths[0]}', 'image/webp', 'official_site', 'approved', 'Project website', false, '${approvedAt}', '${"a".repeat(64)}', '{"operator_action":"true","fixture":true}'::jsonb)`,
      `('${logoIds[1]}', '${projectId}', 'https://avatars.githubusercontent.com/u/12345', '${storagePaths[1]}', 'image/webp', 'provider_avatar', 'approved', 'GitHub owner avatar', false, '${avatarApprovedAt}', '${"b".repeat(64)}', '{"operator_action":"true","fixture":true}'::jsonb)`,
      `('${logoIds[2]}', '${avatarOnlyProjectId}', 'https://avatars.githubusercontent.com/u/12346', '${storagePaths[2]}', 'image/webp', 'provider_avatar', 'approved', 'GitHub owner avatar', true, '${approvedAt}', '${"c".repeat(64)}', '{"operator_action":"true","fixture":true}'::jsonb)`,
    ];
    await runSql(`insert into public.project_logos (
  id, project_id, source_url, storage_path, media_type, origin, verification_status,
  attribution_text, is_primary, verified_at, content_digest, approval_provenance
) values ${logoRows.join(",\n")}`);
    await runSql(`insert into public.project_logos (project_id, source_url, media_type, origin, verification_status)
values
  ('${fallbackProjectId}', 'https://example.test/pending.png', 'image/png', 'official_site', 'pending_review'),
  ('${fallbackProjectId}', 'https://example.test/rejected.png', 'image/png', 'editorial', 'rejected')`);

    const tag = await service.from("tags").upsert({ slug: `m108-${token}-tag`, name: "Search fixture" }, { onConflict: "slug" }).select("id").single();
    assert(!tag.error && tag.data, "Create one deterministic search tag.");
    const attachTag = await service.from("project_tags").insert([
      { project_id: projectId, tag_id: tag.data.id },
      { project_id: fallbackProjectId, tag_id: tag.data.id },
    ]);
    assert(!attachTag.error, "Attach representative search tags.");

    for (const table of ["projects", "repositories", "project_categories", "project_tags", "project_logos"]) {
      await runSql(`analyze public.${table}`);
    }

    const search = async (args: Record<string, unknown> = {}) => {
      const { data, error } = await anonymous.rpc("search_public_projects", args as never);
      if (error) throw new Error(`Anonymous search failed (${error.code}): ${error.message}`);
      return data as unknown as SearchPayload;
    };
    const firstSearchStartedAt = performance.now();
    const common = await search({ p_query: token, p_page_size: 50 });
    const firstSearchLatencyMs = Math.round(performance.now() - firstSearchStartedAt);
    assert(common.totalCount === 1000 && common.items.length === 50 && common.hasMore,
      "The search endpoint must count and paginate 1,000 published fixtures without unpublished or restricted rows.");

    const rawFacets = await must(anonymous.rpc("get_public_catalog_facets"), "Anonymous public catalog facets");
    const facets = rawFacets as unknown as {
      categoryCounts: Array<{ slug: string; projectCount: number }>;
      licenses: string[];
      languages: string[];
    };
    assert(facets.categoryCounts.find((item) => item.slug === "developer-tools")?.projectCount === 500
      && facets.categoryCounts.find((item) => item.slug === "ai-machine-learning")?.projectCount === 501,
    "Bounded category facets count only published, safe projects in each active category.");
    assert(facets.licenses.includes("MIT") && facets.licenses.includes("Apache-2.0")
      && facets.languages.some((value) => value.toLowerCase() === "typescript")
      && facets.languages.some((value) => value.toLowerCase() === "python"),
    "Facet options reflect the visible projects' verified licenses and primary languages.");

    const exact = await search({ p_query: `M108 ${token} Alpha`, p_page_size: 20 });
    assert(exact.items[0]?.slug === projectSlug(1), "Exact project-name matches must rank first.");
    const partial = await search({ p_query: `M108 ${token} Alph`, p_page_size: 20 });
    assert(partial.items.some((item) => item.slug === projectSlug(1)) && partial.items.some((item) => item.slug === projectSlug(2)),
      "Trigram-backed partial names must match close name variants.");
    const typo = await search({ p_query: `M108 ${token} Alpa`, p_page_size: 20 });
    assert(typo.items.some((item) => item.slug === projectSlug(1)), "Trigram similarity must recover a reasonable name misspelling.");
    const summaryAndDescription = await search({ p_query: "needle honeycomb", p_page_size: 20 });
    assert(summaryAndDescription.items[0]?.slug === projectSlug(3)
      && summaryAndDescription.items.some((item) => item.slug === projectSlug(4)),
    `Summary matches must rank above description-only matches (first=${summaryAndDescription.items[0]?.slug ?? "none"}).`);

    const categories = await search({ p_categories: ["developer-tools", "ai-machine-learning"], p_page_size: 50 });
    assert(categories.totalCount === 1000, "Multiple category filters use OR semantics within the category group.");
    const oneCategory = await search({ p_categories: ["developer-tools"], p_page_size: 50 });
    assert(oneCategory.totalCount === 500, "A single category filter selects the matching half of the fixtures.");
    const licenses = await search({ p_licenses: ["MIT", "Apache-2.0"], p_page_size: 50 });
    assert(licenses.totalCount === 1000, "Multiple license filters use OR semantics within the license group.");
    const rareLicense = await search({ p_licenses: ["MIT"], p_page_size: 20 });
    assert(rareLicense.totalCount === 10, "A selective verified-license filter returns the matching projects.");
    const languages = await search({ p_languages: ["TypeScript", "Python"], p_page_size: 50 });
    assert(languages.totalCount === 1000, "Multiple language filters use OR semantics within the language group.");
    const combined = await search({
      p_query: token,
      p_categories: ["developer-tools", "ai-machine-learning"],
      p_licenses: ["MIT"],
      p_languages: ["typescript"],
      p_page_size: 50,
    });
    assert(combined.totalCount === 10 && combined.items.every((item) => item.license.identifier === "MIT" && item.repository.primaryLanguage === "TypeScript"),
      "Filter groups combine with AND semantics and language matching is case insensitive.");

    const stars = await search({ p_query: token, p_sort: "stars", p_page_size: 20 });
    assert(stars.items[0]?.slug === projectSlug(1), "Stars sort is descending with a stable identity tie-breaker.");
    const updated = await search({ p_query: token, p_sort: "updated", p_page_size: 20 });
    assert(updated.items[0]?.slug === projectSlug(1), "Updated sort uses latest repository push time first.");
    const newest = await search({ p_query: token, p_sort: "newest", p_page_size: 20 });
    assert(newest.items[0]?.slug === projectSlug(1), "Newest sort uses publication timestamp first.");
    const name = await search({ p_query: token, p_sort: "name", p_page_size: 20 });
    assert(name.items[0]?.slug === projectSlug(4), "Name sort is ascending alphabetically.");
    const relevanceWithoutQuery = await search({ p_sort: "relevance", p_page_size: 20 });
    assert(relevanceWithoutQuery.items[0]?.slug === projectSlug(1), "Relevance without a query falls back to newest published first.");

    const firstPage = await search({ p_query: token, p_page: 1, p_page_size: 25 });
    const secondPage = await search({ p_query: token, p_page: 2, p_page_size: 25 });
    const repeatedFirstPage = await search({ p_query: token, p_page: 1, p_page_size: 25 });
    assert(firstPage.totalCount === 1000 && firstPage.items.length === 25 && secondPage.items.length === 25,
      "Page totals and counts remain accurate across page boundaries.");
    assert(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size === 50,
      "Stable pagination has no duplicate records across adjacent pages.");
    assert(firstPage.items.map((item) => item.id).join(",") === repeatedFirstPage.items.map((item) => item.id).join(","),
      "Repeated page requests preserve deterministic ordering for unchanged records.");
    const noMatches = await search({ p_query: `nothing-${token}-matches`, p_page_size: 10 });
    assert(noMatches.totalCount === 0 && noMatches.items.length === 0 && !noMatches.hasMore,
      "No-match queries return a successful empty result with an accurate count.");
    const detail = await search({ p_slug: projectSlug(1), p_page_size: 1 });
    assert(detail.totalCount === 1 && detail.items[0]?.slug === projectSlug(1),
      "Safe detail lookup returns the published project by slug.");
    const hiddenDetail = await search({ p_slug: projectSlug(1001), p_page_size: 1 });
    assert(hiddenDetail.totalCount === 0 && hiddenDetail.items.length === 0,
      "Safe detail lookup treats an unpublished slug as not found.");
    const unknownDetail = await search({ p_slug: `missing-${token}`, p_page_size: 1 });
    assert(unknownDetail.totalCount === 0 && unknownDetail.items.length === 0,
      "Safe detail lookup treats an unknown slug as not found.");

    const official = (await search({ p_query: `M108 ${token} Alpha`, p_page_size: 10 })).items.find((item) => item.slug === projectSlug(1));
    assert(official?.logo?.kind === "official_logo" && official.logo.origin === "official_site"
      && official.logo.storagePath === storagePaths[0], "An approved official logo wins over a newer owner avatar.");
    const avatar = (await search({ p_query: token, p_sort: "stars", p_page_size: 10 })).items.find((item) => item.slug === projectSlug(2));
    assert(avatar?.logo?.kind === "provider_avatar" && avatar.logo.origin === "provider_avatar",
      "An approved owner avatar is attributed as an avatar, never as an official logo.");
    const fallback = (await search({ p_query: token, p_page_size: 50 })).items.find((item) => item.slug === projectSlug(3));
    assert(fallback?.logo === null && fallback.fallback.initial === "S" && fallback.fallback.seed === fallback.id,
      "Pending and rejected logo candidates do not appear; letter fallback metadata is deterministic.");
    assert((fallback?.tags ?? []).includes("Search fixture"), "UI-ready records include project tags.");
    assert((official?.categoryIds.length ?? 0) === 2 && (official?.categorySlugs.length ?? 0) === 2,
      "UI-ready records include primary and full category identity metadata.");

    const draft = await anonymous.from("projects").select("id").eq("slug", projectSlug(1001)).maybeSingle();
    assert(!draft.error && draft.data === null, "Anonymous slug detail reads treat unpublished projects as not found.");
    const rejected = await anonymous.from("projects").select("id").eq("slug", projectSlug(1002)).maybeSingle();
    assert(!rejected.error && rejected.data === null, "Rejected projects are hidden by public RLS.");
    const restricted = await anonymous.from("projects").select("id").eq("slug", projectSlug(1003)).maybeSingle();
    assert(!restricted.error && restricted.data === null, "A published-looking project with a restricted primary repository is hidden by public RLS.");
    const privateRepository = await anonymous.from("repositories").select("id").eq("project_id", uuidFor(`${token}-p-1003`)).maybeSingle();
    assert(!privateRepository.error && privateRepository.data === null, "Anonymous repository RLS hides a non-public source row.");
    const operationsRead = await anonymous.from("source_records").select("id").limit(1);
    assert(operationsRead.error?.code === "42501", "Anonymous users cannot read operational source records.");
    const anonymousWrite = await anonymous.from("projects").update({ featured: true }).eq("slug", projectSlug(1));
    assert(anonymousWrite.error?.code === "42501", "Anonymous users cannot mutate project records.");

    const invalidCalls: Array<[Record<string, unknown>, string]> = [
      [{ p_query: "x" }, "minimum query length"],
      [{ p_query: "a".repeat(121) }, "oversized query"],
      [{ p_query: "one two three four five six seven eight nine" }, "query term limit"],
      [{ p_categories: Array.from({ length: 21 }, (_, i) => `category-${i}`) }, "category filter limit"],
      [{ p_categories: ["../private"] }, "invalid category slug"],
      [{ p_licenses: Array.from({ length: 21 }, (_, i) => `License-${i}`) }, "license filter limit"],
      [{ p_languages: Array.from({ length: 21 }, (_, i) => `Language-${i}`) }, "language filter limit"],
      [{ p_page: 0 }, "page lower bound"],
      [{ p_page: 1001 }, "page upper bound"],
      [{ p_page_size: 51 }, "page size upper bound"],
      [{ p_sort: "trending" }, "unsupported trending sort"],
      [{ p_slug: "../private" }, "invalid slug"],
    ];
    for (const [args, label] of invalidCalls) {
      const { error } = await anonymous.rpc("search_public_projects", args as never);
      assert(error?.code === "22023", `Invalid ${label} must fail with SQLSTATE 22023.`);
    }

    await runSql("analyze public.projects");
    await runSql("analyze public.repositories");
    const naturalPlans = await Promise.all([
      runSql(`explain (costs off) select id from public.projects
  where publication_status = 'published'
    and search_document @@ plainto_tsquery('english', 'needle honeycomb')`),
      runSql(`explain (costs off) select id from public.projects
  where publication_status = 'published'
    and name ilike '%${token} Alphx%'`),
      runSql(`explain (costs off) select id from public.projects
  where publication_status = 'published'
    and license_status = 'verified_open_source' and license_identifier = 'MIT'`),
      runSql(`explain (costs off) select id from public.repositories
  where availability_status = 'available' and primary_language is not null
    and lower(primary_language) = 'typescript'`),
    ]);
    const naturalPlan = naturalPlans.join("\n");
    assert(naturalPlan.includes("Seq Scan on projects"),
      `At 1,003 local rows PostgreSQL should prefer a sequential scan for at least the broad project probes.\n${naturalPlan}`);
    assert(naturalPlan.includes("Index Scan using repositories_primary_language_idx")
      || naturalPlan.includes("Bitmap Index Scan on repositories_primary_language_idx"),
      `The primary-language plan should naturally use its selective repository index.\n${naturalPlan}`);
    assert(naturalPlan.includes("projects_public_license_identifier_idx"),
      `The selective verified-license plan should naturally use its project index.\n${naturalPlan}`);
    const indexedPlan = await indexedPlanProbes(token);
    assert(indexedPlan.includes("projects_search_document_gin_idx"), `The stored-vector predicate must have a GIN index path.\n${indexedPlan}`);
    assert(indexedPlan.includes("projects_name_trgm_idx"), `The partial-name predicate must have a trigram index path.\n${indexedPlan}`);
    assert(indexedPlan.includes("projects_public_license_identifier_idx"), `The license filter must have its selective index path.\n${indexedPlan}`);
    assert(indexedPlan.includes("repositories_primary_language_idx"), `The language filter must have its existing index path.\n${indexedPlan}`);

    process.stdout.write(JSON.stringify({
      status: "passed",
      fixtures: 1003,
      publishedSearchable: common.totalCount,
      assertions: assertionCount,
      firstSearchLatencyMs,
      planIndexes: [
        "projects_search_document_gin_idx",
        "projects_name_trgm_idx",
        "projects_public_license_identifier_idx",
        "repositories_primary_language_idx",
      ],
      plannerObservation: "At 1,003 local rows PostgreSQL selects sequential scans for full-text and partial-name probes, and uses the selective license and repository-language indexes naturally; forced-plan checks verify GIN and trigram paths are available.",
      publicRpc: "anonymous",
    }) + "\n");
  } finally {
    if (uploaded.length > 0) await service.storage.from("project-logos").remove(uploaded).catch(() => undefined);
    if (fixtureCreated) {
      const cleanup = await service.from("projects").delete().like("slug", `m108-${token}-%`);
      if (cleanup.error) throw new Error(`Could not remove temporary M1-08 fixtures: ${cleanup.error.message.slice(0, 250)}`);
      const tagCleanup = await service.from("tags").delete().eq("slug", `m108-${token}-tag`);
      if (tagCleanup.error) throw new Error(`Could not remove temporary M1-08 tags: ${tagCleanup.error.message.slice(0, 250)}`);
    }
  }
}

await main();
