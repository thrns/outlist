-- Return compact, exact facets over the same RLS-visible catalog used by
-- search. Counts and option lists are aggregated inside PostgreSQL so the
-- browser never downloads the project catalog to build filters.
create or replace function public.get_public_catalog_facets()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with visible_projects as materialized (
    select p.id, p.license_identifier, r.primary_language
    from public.projects p
    join public.repositories r
      on r.id = p.primary_repository_id
      and r.project_id = p.id
      and r.provider = 'github'
      and r.availability_status = 'available'
    where p.publication_status = 'published'
      and p.published_at is not null
      and char_length(p.slug) <= 120
      and p.license_status = 'verified_open_source'
      and p.license_identifier ~ '^[A-Za-z0-9.+-]{1,64}$'
      and char_length(r.full_name) <= 140
      and char_length(r.canonical_url) <= 2048
      and r.stars <= 9007199254740991
      and r.forks <= 9007199254740991
      and exists (
        select 1
        from public.project_categories pc
        join public.categories c on c.id = pc.category_id and c.is_active
        where pc.project_id = p.id
          and char_length(c.slug) <= 80
          and char_length(c.name) <= 120
      )
  ),
  category_counts as (
    select c.slug, pg_catalog.count(distinct vp.id)::integer as project_count
    from public.categories c
    left join public.project_categories pc on pc.category_id = c.id
    left join visible_projects vp on vp.id = pc.project_id
    where c.is_active
      and char_length(c.slug) <= 80
      and char_length(c.name) <= 120
    group by c.id, c.slug, c.sort_order, c.name
    order by c.sort_order, c.name, c.id
    limit 200
  ),
  licenses as (
    select distinct vp.license_identifier as value
    from visible_projects vp
    where vp.license_identifier is not null
    order by value
    limit 100
  ),
  languages as (
    select pg_catalog.min(vp.primary_language) as value, lower(vp.primary_language) as sort_key
    from visible_projects vp
    where vp.primary_language is not null
      and btrim(vp.primary_language) <> ''
      and char_length(vp.primary_language) <= 50
    group by lower(vp.primary_language)
    order by sort_key
    limit 100
  )
  select pg_catalog.jsonb_build_object(
    'categoryCounts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'slug', slug, 'projectCount', project_count
      ) order by slug)
      from category_counts
    ), '[]'::jsonb),
    'licenses', coalesce((select pg_catalog.jsonb_agg(value order by value) from licenses), '[]'::jsonb),
    'languages', coalesce((select pg_catalog.jsonb_agg(value order by sort_key) from languages), '[]'::jsonb)
  );
$function$;

revoke all on function public.get_public_catalog_facets() from public, anon, authenticated, service_role;
grant execute on function public.get_public_catalog_facets() to anon, authenticated;
