begin;
select no_plan();

select ok(
  not (select prosecdef from pg_proc where oid = 'public.search_public_projects(text,text[],text[],text[],text,integer,integer,text)'::regprocedure),
  'public search runs as SECURITY INVOKER'
);
select ok(
  has_function_privilege('anon', 'public.search_public_projects(text,text[],text[],text[],text,integer,integer,text)', 'EXECUTE'),
  'anonymous users can execute only the public search RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.search_public_projects(text,text[],text[],text[],text,integer,integer,text)', 'EXECUTE'),
  'authenticated users can execute the public search RPC'
);
select ok(
  not has_function_privilege('service_role', 'public.search_public_projects(text,text[],text[],text[],text,integer,integer,text)', 'EXECUTE'),
  'public catalog reads do not require or grant the service role'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.get_public_catalog_facets()'::regprocedure)
    and has_function_privilege('anon', 'public.get_public_catalog_facets()', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_public_catalog_facets()', 'EXECUTE'),
  'public catalog facets run as the caller and are available to public roles'
);
select ok(
  not has_table_privilege('anon', 'public.projects', 'INSERT')
    and not has_table_privilege('anon', 'public.projects', 'UPDATE')
    and not has_table_privilege('anon', 'public.projects', 'DELETE'),
  'anonymous catalog access is read only'
);
select ok(
  not has_table_privilege('authenticated', 'public.projects', 'INSERT')
    and not has_table_privilege('authenticated', 'public.projects', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.projects', 'DELETE'),
  'authenticated catalog access is read only'
);
select ok(
  has_column_privilege('anon', 'public.projects', 'search_document', 'SELECT'),
  'the generated public search vector is readable for indexed invoker search'
);
select ok(
  not has_column_privilege('anon', 'public.repositories', 'source_field_states', 'SELECT'),
  'source field state remains hidden from direct anonymous queries'
);
select ok(
  not has_table_privilege('anon', 'public.source_records', 'SELECT'),
  'anonymous users cannot read source records or payloads'
);
select ok(
  not has_table_privilege('authenticated', 'public.repository_candidates', 'SELECT'),
  'authenticated users cannot read discovery candidates'
);
select ok(
  not has_table_privilege('anon', 'public.editorial_decisions', 'SELECT'),
  'anonymous users cannot read editorial decisions or reviewer identities'
);
select ok(
  not has_table_privilege('anon', 'public.admin_users', 'SELECT'),
  'anonymous users cannot read administrator records'
);

select throws_ok(
  $$select public.search_public_projects(p_page => 0)$$,
  '22023', null, 'page lower bound is validated in the database'
);
select throws_ok(
  $$select public.search_public_projects(p_page => 1001)$$,
  '22023', null, 'page upper bound is validated in the database'
);
select throws_ok(
  $$select public.search_public_projects(p_page_size => 51)$$,
  '22023', null, 'maximum page size is validated in the database'
);
select throws_ok(
  $$select public.search_public_projects(p_query => 'x')$$,
  '22023', null, 'short text queries are rejected before query planning'
);
select throws_ok(
  $$select public.search_public_projects(p_sort => 'trending')$$,
  '22023', null, 'unsupported and invented sorts are rejected'
);
select throws_ok(
  $$select public.search_public_projects(p_slug => '../private')$$,
  '22023', null, 'invalid detail slugs are rejected in the database'
);

insert into public.projects (
  id, slug, name, summary, description, license_status, license_identifier,
  license_verified_at, quality_status, last_verified_at
) values (
  'a8000000-0000-4000-8000-000000000001', 'm108-private-repository-fixture',
  'Private Repository Fixture', 'A valid summary for a visibility test.',
  'This fixture must not be visible through public search.',
  'verified_open_source', 'MIT', now(), 'verified', now()
);
insert into public.repositories (
  id, project_id, provider, provider_repository_id, full_name, canonical_url,
  availability_status, is_private, visibility, is_disabled,
  source_field_states, primary_language, stars, forks
) values (
  'a8000000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000001',
  'other', 'm108-private-fixture', 'fixture/private', 'https://example.test/private',
  'available', true, 'private', false, '{"visibility":"present"}', 'Rust', 8, 2
);
update public.projects set primary_repository_id = 'a8000000-0000-4000-8000-000000000002'
where id = 'a8000000-0000-4000-8000-000000000001';
insert into public.project_categories (project_id, category_id)
select 'a8000000-0000-4000-8000-000000000001', id from public.categories where slug = 'developer-tools';
update public.projects set publication_status = 'published', published_at = now()
where id = 'a8000000-0000-4000-8000-000000000001';

set local role anon;
select is(
  (select count(*)::integer from public.projects where id = 'a8000000-0000-4000-8000-000000000001'),
  0, 'RLS treats a published-looking project with a restricted primary repository as not found'
);
select is(
  (public.search_public_projects(p_query => 'Private Repository Fixture')->>'totalCount')::integer,
  0, 'search RPC excludes restricted primary repositories'
);
select is(
  (select count(*)::integer from public.repositories where project_id = 'a8000000-0000-4000-8000-000000000001'),
  0, 'repository RLS hides non-public repository state'
);
select is(
  (select (item->>'projectCount')::integer
   from pg_catalog.jsonb_array_elements(public.get_public_catalog_facets()->'categoryCounts') item
   where item->>'slug' = 'developer-tools'),
  0, 'facet category counts exclude published-looking projects with restricted sources'
);
reset role;

select finish();
rollback;
