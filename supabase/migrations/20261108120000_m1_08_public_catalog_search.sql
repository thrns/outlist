-- M1-08: anonymous, bounded discovery over the published catalog.

-- Tighten public row visibility without granting the safety columns themselves.
-- RLS evaluates these predicates while invoker queries select only the existing
-- public column grants.
drop policy repositories_public_read on public.repositories;
drop policy projects_public_read on public.projects;
create or replace function private.is_public_catalog_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.projects p
    join public.repositories r
      on r.id = p.primary_repository_id and r.project_id = p.id
    where p.id = p_project_id
      and p.publication_status = 'published'
      and p.published_at is not null
      and p.quality_status = 'verified'
      and p.last_verified_at is not null
      and p.license_status = 'verified_open_source'
      and p.license_verified_at is not null
      and p.license_identifier ~ '^[A-Za-z0-9.+-]{1,64}$'
      and char_length(btrim(p.name)) between 1 and 120
      and char_length(btrim(p.summary)) between 10 and 280
      and r.provider = 'github'
      and r.availability_status = 'available'
      and r.is_private is false
      and lower(btrim(coalesce(r.visibility, ''))) = 'public'
      and r.is_disabled is false
      and r.source_field_states->>'visibility' = 'present'
      and r.source_observed_at >= pg_catalog.clock_timestamp() - interval '90 days'
      and r.last_successful_sync_at >= r.source_observed_at
  );
$function$;

revoke all on function private.is_public_catalog_project(uuid) from public, anon, authenticated, service_role;
grant execute on function private.is_public_catalog_project(uuid) to anon, authenticated;

create policy repositories_public_read on public.repositories
  for select to anon, authenticated
  using (
    project_id is not null
    and provider = 'github'
    and availability_status = 'available'
    and is_private is false
    and lower(btrim(coalesce(visibility, ''))) = 'public'
    and is_disabled is false
    and source_field_states->>'visibility' = 'present'
    and source_observed_at >= pg_catalog.clock_timestamp() - interval '90 days'
    and last_successful_sync_at >= source_observed_at
    and exists (
      select 1 from public.projects p
      where p.id = repositories.project_id
        and private.is_public_catalog_project(p.id)
    )
  );

create policy projects_public_read on public.projects
  for select to anon, authenticated
  using (private.is_public_catalog_project(id));

-- The generated vector contains only the already-public name, summary, and
-- description text. Granting it lets the invoker RPC use the existing GIN index.
grant select (search_document) on public.projects to anon, authenticated;

create index projects_public_license_identifier_idx
  on public.projects (license_identifier, published_at desc, id)
  where publication_status = 'published' and license_status = 'verified_open_source';
create index projects_public_name_sort_idx
  on public.projects (lower(name), id)
  where publication_status = 'published';

create or replace function public.search_public_projects(
  p_query text default null,
  p_categories text[] default '{}'::text[],
  p_licenses text[] default '{}'::text[],
  p_languages text[] default '{}'::text[],
  p_sort text default 'relevance',
  p_page integer default 1,
  p_page_size integer default 20,
  p_slug text default null
) returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_query text := nullif(regexp_replace(btrim(coalesce(p_query, '')), '[[:space:]]+', ' ', 'g'), '');
  v_slug text := nullif(btrim(coalesce(p_slug, '')), '');
  v_pattern text;
  v_tsquery tsquery;
  v_result jsonb;
begin
  if p_page is null or p_page not between 1 and 1000 then
    raise exception 'page must be between 1 and 1000' using errcode = '22023';
  end if;
  if p_page_size is null or p_page_size not between 1 and 50 then
    raise exception 'page_size must be between 1 and 50' using errcode = '22023';
  end if;
  if p_sort is null or p_sort not in ('relevance', 'stars', 'updated', 'newest', 'name') then
    raise exception 'unsupported sort order' using errcode = '22023';
  end if;
  if v_slug is not null and (char_length(v_slug) > 120 or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$') then
    raise exception 'slug must be a valid project slug' using errcode = '22023';
  end if;
  if v_query is not null then
    if char_length(v_query) < 3 or char_length(v_query) > 120
      or cardinality(regexp_split_to_array(v_query, ' ')) > 8 then
      raise exception 'query must contain 3 to 120 characters and no more than 8 terms' using errcode = '22023';
    end if;
  end if;

  if p_categories is null or cardinality(p_categories) > 20
    or array_position(p_categories, null) is not null
    or exists (
      select 1 from unnest(coalesce(p_categories, '{}'::text[])) value
      where length(value) > 80 or value !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    ) then
    raise exception 'categories must contain at most 20 category slugs' using errcode = '22023';
  end if;
  if p_licenses is null or cardinality(p_licenses) > 20
    or array_position(p_licenses, null) is not null
    or exists (
      select 1 from unnest(coalesce(p_licenses, '{}'::text[])) value
      where length(value) > 64 or value !~ '^[A-Za-z0-9.+-]{1,64}$'
    ) then
    raise exception 'licenses must contain at most 20 license identifiers' using errcode = '22023';
  end if;
  if p_languages is null or cardinality(p_languages) > 20
    or array_position(p_languages, null) is not null
    or exists (
      select 1 from unnest(coalesce(p_languages, '{}'::text[])) value
      where length(value) > 50 or value !~ '^[[:alnum:]_+#.-]{1,50}$'
    ) then
    raise exception 'languages must contain at most 20 language names' using errcode = '22023';
  end if;

  if v_query is not null then
    v_pattern := '%' || replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
    v_tsquery := pg_catalog.plainto_tsquery('english'::pg_catalog.regconfig, v_query);
  else
    v_pattern := null;
    v_tsquery := ''::pg_catalog.tsquery;
  end if;

  with filtered as materialized (
    select
      p.id,
      p.slug,
      p.name,
      p.summary,
      left(p.description, 600) as description_excerpt,
      case when char_length(p.official_website_url) <= 2048 then p.official_website_url else null end as official_website_url,
      p.published_at,
      p.license_identifier,
      r.id as repository_id,
      r.provider,
      r.provider_repository_id,
      r.full_name,
      r.canonical_url,
      r.stars,
      r.forks,
      r.primary_language,
      r.provider_pushed_at,
      case
        when v_query is null then 0::double precision
        when lower(p.name) = lower(v_query) then 1000 + extensions.similarity(p.name, v_query)
        when left(lower(p.name), char_length(v_query)) = lower(v_query) then 750 + extensions.similarity(p.name, v_query)
        when p.name ilike v_pattern escape E'\\' then 600 + extensions.similarity(p.name, v_query)
        when p.name operator(extensions.%) v_query and extensions.similarity(p.name, v_query) >= 0.45
          then 500 + extensions.similarity(p.name, v_query)
        else 0
      end
      + 100 * pg_catalog.ts_rank_cd(p.search_document, v_tsquery, 32)
      + case when v_query is not null and (
          p.summary ilike v_pattern escape E'\\'
          or (p.summary operator(extensions.%) v_query and extensions.similarity(p.summary, v_query) >= 0.45)
        ) then 25 + extensions.similarity(p.summary, v_query) else 0 end
        as relevance
    from public.projects p
    join public.repositories r
      on r.id = p.primary_repository_id
      and r.project_id = p.id
      and r.availability_status = 'available'
      and r.provider = 'github'
    where p.publication_status = 'published'
      and (v_slug is null or p.slug = v_slug)
      and p.published_at is not null
      and char_length(p.slug) <= 120
      and char_length(btrim(p.name)) between 1 and 120
      and char_length(btrim(p.summary)) between 10 and 280
      and p.license_status = 'verified_open_source'
      and p.license_identifier is not null
      and p.license_identifier ~ '^[A-Za-z0-9.+-]{1,64}$'
      and p.primary_repository_id is not null
      and char_length(r.full_name) <= 140
      and char_length(r.canonical_url) <= 2048
      and (r.primary_language is null or char_length(r.primary_language) <= 50)
      and r.stars <= 9007199254740991
      and r.forks <= 9007199254740991
      and (
        cardinality(p_categories) = 0
        or exists (
          select 1
          from public.project_categories pc
          join public.categories c on c.id = pc.category_id and c.is_active
          where pc.project_id = p.id and c.slug = any(p_categories)
        )
      )
      and (cardinality(p_licenses) = 0 or p.license_identifier = any(p_licenses))
      and (cardinality(p_languages) = 0 or lower(r.primary_language) = any(
        array(select lower(language) from unnest(p_languages) language)
      ))
      and (
        v_query is null
        or p.search_document @@ v_tsquery
        or p.name ilike v_pattern escape E'\\'
        or (p.name operator(extensions.%) v_query and extensions.similarity(p.name, v_query) >= 0.45)
        or p.summary ilike v_pattern escape E'\\'
        or (p.summary operator(extensions.%) v_query and extensions.similarity(p.summary, v_query) >= 0.45)
      )
      and exists (
        select 1
        from public.project_categories pc
        join public.categories c on c.id = pc.category_id and c.is_active
        where pc.project_id = p.id
          and char_length(c.slug) <= 80
          and char_length(c.name) <= 120
      )
  ),
  ranked as (
    select f.*,
      row_number() over (
        order by
          case when p_sort = 'relevance' and v_query is not null then f.relevance end desc nulls last,
          case when p_sort = 'stars' then f.stars end desc nulls last,
          case when p_sort = 'updated' then f.provider_pushed_at end desc nulls last,
          case when p_sort = 'newest' or (p_sort = 'relevance' and v_query is null) then f.published_at end desc nulls last,
          case when p_sort = 'name' then lower(f.name) end asc nulls last,
          f.id asc
      ) as position
    from filtered f
  ),
  page_rows as materialized (
    select * from ranked
    where position > ((p_page - 1) * p_page_size)
      and position <= (p_page * p_page_size)
  ),
  category_rows as (
    select pc.project_id, c.id, c.slug, c.name,
      row_number() over (partition by pc.project_id order by c.sort_order, c.name, c.id) as category_position
    from page_rows pr
    join public.project_categories pc on pc.project_id = pr.id
    join public.categories c on c.id = pc.category_id and c.is_active
    where char_length(c.slug) <= 80 and char_length(c.name) <= 120
  ),
  categories_by_project as (
    select project_id,
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', id, 'slug', slug, 'name', name
      ) order by category_position) as categories
    from category_rows
    where category_position <= 20
    group by project_id
  ),
  tag_rows as (
    select pt.project_id, left(t.name, 256) as name,
      row_number() over (partition by pt.project_id order by t.name, t.slug) as tag_position
    from page_rows pr
    join public.project_tags pt on pt.project_id = pr.id
    join public.tags t on t.id = pt.tag_id
  ),
  tags_by_project as (
    select project_id,
      pg_catalog.jsonb_agg(name order by tag_position) as tags
    from tag_rows
    where tag_position <= 50
    group by project_id
  ),
  logo_by_project as (
    select distinct on (l.project_id)
      l.project_id, l.id as logo_id, l.origin as logo_origin,
      l.storage_path as logo_storage_path, l.media_type as logo_media_type,
      l.attribution_text as logo_attribution
    from page_rows pr
    join public.project_logos l on l.project_id = pr.id
    where l.verification_status = 'approved'
      and l.storage_path like l.project_id::text || '/%'
      and char_length(l.storage_path) <= 256
    order by l.project_id,
      case when l.origin = 'provider_avatar' then 1 else 0 end,
      l.is_primary desc, l.verified_at desc nulls last, l.id
  ),
  item_rows as (
    select pr.*,
      cbp.categories,
      coalesce(tbp.tags, '[]'::jsonb) as tags,
      lbp.logo_id, lbp.logo_origin, lbp.logo_storage_path,
      lbp.logo_media_type, lbp.logo_attribution
    from page_rows pr
    join categories_by_project cbp on cbp.project_id = pr.id
    left join tags_by_project tbp on tbp.project_id = pr.id
    left join logo_by_project lbp on lbp.project_id = pr.id
  ),
  total as (select count(*)::bigint as total_count from filtered)
  select pg_catalog.jsonb_build_object(
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', i.id,
        'slug', i.slug,
        'name', i.name,
        'summary', i.summary,
        'descriptionExcerpt', i.description_excerpt,
        'officialWebsiteUrl', i.official_website_url,
        'publishedAt', i.published_at,
        'primaryCategory', i.categories->0,
        'categories', i.categories,
        'categoryIds', (select pg_catalog.jsonb_agg(value->'id' order by ord) from pg_catalog.jsonb_array_elements(i.categories) with ordinality as c(value, ord)),
        'categorySlugs', (select pg_catalog.jsonb_agg(value->'slug' order by ord) from pg_catalog.jsonb_array_elements(i.categories) with ordinality as c(value, ord)),
        'tags', i.tags,
        'repository', pg_catalog.jsonb_build_object(
          'provider', i.provider,
          'providerRepositoryId', i.provider_repository_id,
          'fullName', i.full_name,
          'url', i.canonical_url,
          'stars', i.stars,
          'forks', i.forks,
          'primaryLanguage', i.primary_language,
          'activityAt', i.provider_pushed_at
        ),
        'license', pg_catalog.jsonb_build_object(
          'identifier', i.license_identifier,
          'verified', true
        ),
        'logo', case when i.logo_id is null then null else pg_catalog.jsonb_build_object(
          'id', i.logo_id,
          'kind', case when i.logo_origin = 'provider_avatar' then 'provider_avatar' else 'official_logo' end,
          'origin', i.logo_origin,
          'storagePath', i.logo_storage_path,
          'mediaType', i.logo_media_type,
          'attribution', left(i.logo_attribution, 500)
        ) end,
        'fallback', pg_catalog.jsonb_build_object(
          'initial', coalesce(nullif(upper(left(pg_catalog.regexp_replace(i.name, '^[^[:alnum:]]*', ''), 1)), ''), '?'),
          'seed', i.id::text,
          'version', 'letter-fallback-v1'
        )
      ) order by i.position)
      from item_rows i
    ), '[]'::jsonb),
    'page', p_page,
    'pageSize', p_page_size,
    'totalCount', total.total_count,
    'hasMore', (p_page * p_page_size) < total.total_count,
    'sort', p_sort
  ) into v_result from total;

  return v_result;
end;
$function$;

revoke all on function public.search_public_projects(text, text[], text[], text[], text, integer, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.search_public_projects(text, text[], text[], text[], text, integer, integer, text) to anon, authenticated;
