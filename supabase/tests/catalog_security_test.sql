begin;
select plan(61);

-- Schema presence and key relationship constraints.
select has_table('public', 'projects', 'projects table exists');
select has_table('public', 'repositories', 'repositories table exists');
select has_table('public', 'categories', 'categories table exists');
select has_table('public', 'project_categories', 'project_categories table exists');
select has_table('public', 'tags', 'tags table exists');
select has_table('public', 'project_tags', 'project_tags table exists');
select has_table('public', 'repository_topics', 'repository_topics table exists');
select has_table('public', 'repository_languages', 'repository_languages table exists');
select has_table('public', 'source_records', 'source_records table exists');
select has_table('public', 'releases', 'releases table exists');
select has_table('public', 'repository_snapshots', 'repository_snapshots table exists');
select has_table('public', 'project_logos', 'project_logos table exists');
select has_table('public', 'project_alternatives', 'project_alternatives table exists');
select has_table('public', 'discovery_queries', 'discovery_queries table exists');
select has_table('public', 'repository_candidates', 'repository_candidates table exists');
select has_table('public', 'ingestion_jobs', 'ingestion_jobs table exists');
select has_table('public', 'ingestion_items', 'ingestion_items table exists');
select has_table('public', 'submissions', 'submissions table exists');
select has_table('public', 'review_queue', 'review_queue table exists');
select has_table('public', 'editorial_overrides', 'editorial_overrides table exists');
select has_table('public', 'admin_users', 'admin_users table exists');
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.projects'::regclass
      and conname = 'projects_primary_repository_same_project_fk'
      and contype = 'f'
  ),
  'primary repository foreign key enforces same-project ownership'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.repositories'::regclass
      and conname = 'repositories_provider_identity_unique'
      and contype = 'u'
  ),
  'provider repository identity is unique'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.repository_snapshots'::regclass
      and conname = 'repository_snapshots_one_per_day'
      and contype = 'u'
  ),
  'repository snapshots are unique per repository and date'
);
select ok(
  not exists (
    select 1
    from (values
      ('projects'), ('repositories'), ('categories'), ('project_categories'),
      ('tags'), ('project_tags'), ('source_records'), ('releases'),
      ('repository_snapshots'), ('repository_topics'), ('repository_languages'),
      ('project_logos'), ('project_alternatives'), ('discovery_queries'),
      ('repository_candidates'), ('ingestion_jobs'), ('ingestion_items'),
      ('submissions'), ('review_queue'), ('editorial_overrides'), ('admin_users')
    ) as application_table(table_name)
    join pg_class c on c.relname = application_table.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind = 'r' and not c.relrowsecurity
  ),
  'RLS is enabled on every application table'
);

-- Fixtures are deliberately limited to this rolled-back test transaction.
insert into public.projects (
  id, slug, name, summary, description, license_status, license_identifier,
  license_verified_at, quality_status
) values
  ('00000000-0000-4000-8000-000000000001', 'published-fixture', 'Published Fixture', 'A published test listing.', 'Test description.', 'verified_open_source', 'MIT', now(), 'verified'),
  ('00000000-0000-4000-8000-000000000002', 'draft-fixture', 'Draft Fixture', 'A private test listing.', '', 'unknown', null, null, 'unreviewed'),
  ('00000000-0000-4000-8000-000000000003', 'missing-name-fixture', '', '', '', 'unknown', null, null, 'unreviewed'),
  ('00000000-0000-4000-8000-000000000004', 'unverified-license-fixture', 'License Fixture', 'A test listing.', '', 'unknown', null, null, 'verified'),
  ('00000000-0000-4000-8000-000000000005', 'missing-repository-fixture', 'Repository Fixture', 'A test listing.', '', 'verified_open_source', 'MIT', now(), 'verified'),
  ('00000000-0000-4000-8000-000000000006', 'missing-category-fixture', 'Category Fixture', 'A test listing.', '', 'verified_open_source', 'MIT', now(), 'verified');

insert into public.repositories (
  id, project_id, provider, provider_repository_id, full_name, canonical_url,
  primary_language, stars, forks, availability_status
) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'github', 'fixture-1', 'fixtures/published', 'https://github.com/fixtures/published', 'Rust', 10, 2, 'available'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'github', 'fixture-2', 'fixtures/published-extra', 'https://github.com/fixtures/published-extra', 'Rust', 4, 1, 'available'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'github', 'fixture-3', 'fixtures/draft', 'https://github.com/fixtures/draft', 'Go', 1, 0, 'available'),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000004', 'github', 'fixture-4', 'fixtures/license', 'https://github.com/fixtures/license', 'Go', 1, 0, 'available'),
  ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006', 'github', 'fixture-5', 'fixtures/category', 'https://github.com/fixtures/category', 'Go', 1, 0, 'available');

update public.projects
set primary_repository_id = '10000000-0000-4000-8000-000000000001'
where id = '00000000-0000-4000-8000-000000000001';
update public.projects
set primary_repository_id = '10000000-0000-4000-8000-000000000003'
where id = '00000000-0000-4000-8000-000000000002';
update public.projects
set primary_repository_id = '10000000-0000-4000-8000-000000000004'
where id = '00000000-0000-4000-8000-000000000004';
update public.projects
set primary_repository_id = '10000000-0000-4000-8000-000000000005'
where id = '00000000-0000-4000-8000-000000000006';

insert into public.project_categories (project_id, category_id)
select project_id, c.id
from (values
  ('00000000-0000-4000-8000-000000000001'::uuid),
  ('00000000-0000-4000-8000-000000000002'::uuid),
  ('00000000-0000-4000-8000-000000000004'::uuid),
  ('00000000-0000-4000-8000-000000000005'::uuid)
) as fixtures(project_id)
cross join lateral (select id from public.categories where slug = 'developer-tools') c;

update public.projects
set publication_status = 'published'
where id = '00000000-0000-4000-8000-000000000001';

insert into public.source_records (
  id, provider, record_kind, source_key, source_url, fetched_at, raw_payload, reuse_context
) values (
  '20000000-0000-4000-8000-000000000001', 'github', 'discovery_page', 'fixture-search-1',
  'https://api.github.com/search/repositories?q=fixture', now(), '{"items":[]}'::jsonb,
  'Database authorization test fixture'
);
insert into public.repository_candidates (
  provider, provider_repository_id, full_name, canonical_url, source_record_id
) values (
  'github', 'candidate-fixture-1', 'fixtures/candidate',
  'https://github.com/fixtures/candidate', '20000000-0000-4000-8000-000000000001'
);
insert into public.ingestion_jobs (job_type, status) values ('database-test', 'queued');
insert into public.project_logos (
  project_id, source_url, media_type, origin, verification_status
) values (
  '00000000-0000-4000-8000-000000000001', 'https://example.com/pending-logo.png',
  'image/png', 'official_site', 'pending_review'
);
insert into public.repository_snapshots (repository_id, snapshot_date, captured_at, stars, forks)
values ('10000000-0000-4000-8000-000000000001', date '2026-11-05', now(), 10, 2);

-- Constraints and relational behavior.
select throws_ok(
  $$insert into public.repositories (provider, provider_repository_id, full_name, canonical_url)
    values ('github', 'fixture-1', 'duplicates/repo', 'https://github.com/duplicates/repo')$$,
  '23505', null, 'duplicate provider repository IDs are rejected'
);
select is(
  (select count(*)::integer from public.repositories where project_id = '00000000-0000-4000-8000-000000000001'),
  2, 'one project can have multiple repositories'
);
select throws_ok(
  $$update public.projects set primary_repository_id = '10000000-0000-4000-8000-000000000003'
    where id = '00000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a project cannot select another project repository as primary'
);
select throws_ok(
  $$insert into public.project_categories (project_id, category_id)
    select '00000000-0000-4000-8000-000000000001', id
    from public.categories where slug = 'developer-tools'$$,
  '23505', null, 'duplicate project-category relationships are rejected'
);
select throws_ok(
  $$insert into public.repository_snapshots (repository_id, snapshot_date, captured_at, stars, forks)
    values ('10000000-0000-4000-8000-000000000001', date '2026-11-05', now(), 10, 2)$$,
  '23505', null, 'duplicate repository-day snapshots are rejected'
);
select throws_ok(
  $$insert into public.projects (slug, publication_status) values ('bad-status-fixture', 'invisible')$$,
  '23514', null, 'invalid project status values are rejected'
);
select throws_ok(
  $$insert into public.repositories (provider, provider_repository_id, full_name, canonical_url, stars)
    values ('github', 'negative-stars-fixture', 'fixtures/negative-stars', 'https://github.com/fixtures/negative-stars', -1)$$,
  '23514', null, 'negative repository metrics are rejected'
);
select is(
  (select count(*)::integer from public.projects where publication_status = 'published'),
  1, 'the complete fixture can be published'
);
select ok(
  (select published_at is not null from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  'publication records its timestamp'
);
select throws_ok(
  $$insert into public.project_logos (
      project_id, source_url, storage_path, media_type, origin, verification_status
    ) values (
      '00000000-0000-4000-8000-000000000001',
      'https://example.com/unreviewed.png',
      '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001.png',
      'image/png', 'official_site', 'pending_review'
    )$$,
  '23514', null, 'unapproved logo rows cannot point at public bucket assets'
);
select ok(
  (select public
      and file_size_limit = 2097152
      and allowed_mime_types @> array['image/png', 'image/jpeg', 'image/webp']::text[]
   from storage.buckets where id = 'project-logos'),
  'project logo bucket is public with the expected size and MIME limits'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass),
  'Supabase Storage object table has RLS enabled'
);

-- Anonymous role and JWT context.
set local role anon;
set local "request.jwt.claims" = '{"role":"anon"}';
select is(
  (select count(*)::integer from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  1, 'anonymous users can read published projects'
);
select is(
  (select count(*)::integer from public.projects where id = '00000000-0000-4000-8000-000000000002'),
  0, 'anonymous users cannot read unpublished projects'
);
select throws_ok($$select * from public.ingestion_jobs$$, '42501', null, 'anonymous users cannot read ingestion jobs');
select throws_ok($$select * from public.source_records$$, '42501', null, 'anonymous users cannot read raw source records');
select throws_ok($$select * from public.repository_candidates$$, '42501', null, 'anonymous users cannot read the candidate queue');
select is(
  (select count(*)::integer from public.repositories where project_id = '00000000-0000-4000-8000-000000000002'),
  0, 'repository visibility follows the parent project publication status'
);
select is(
  (select count(*)::integer from public.project_categories where project_id = '00000000-0000-4000-8000-000000000002'),
  0, 'project-category relationships do not expose unpublished projects'
);
select is(
  (select count(*)::integer from public.project_logos where project_id = '00000000-0000-4000-8000-000000000001'),
  0, 'pending logo metadata is not public'
);
select is((select count(*)::integer from public.categories), 11, 'taxonomy contains 11 readable categories');
select is((select count(distinct slug)::integer from public.categories), 11, 'taxonomy slugs are unique');
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and (
        roles @> array['anon'::name]
        or roles @> array['authenticated'::name]
        or roles @> array['public'::name]
      )
  ),
  'ordinary roles have no Storage object write policies'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, metadata)
    values ('project-logos', 'anonymous-upload.png', '{}'::jsonb)$$,
  '42501', null, 'anonymous users cannot upload logo objects'
);
select throws_ok(
  $$insert into public.submissions (request_type, suggested_name) values ('suggestion', 'Unauthenticated direct write')$$,
  '42501', null, 'anonymous users cannot write submissions directly'
);
reset role;

-- Authenticated users receive only the same public reads, not admin writes.
set local role authenticated;
set local "request.jwt.claims" = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000099"}';
select is(
  (select count(*)::integer from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  1, 'normal authenticated users can read published projects'
);
select is(
  (select count(*)::integer from public.projects where id = '00000000-0000-4000-8000-000000000002'),
  0, 'normal authenticated users cannot read unpublished projects'
);
select throws_ok(
  $$update public.projects set name = 'Unauthorized' where id = '00000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'normal authenticated users cannot update canonical projects'
);
select throws_ok(
  $$delete from public.projects where id = '00000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'normal authenticated users cannot delete canonical projects'
);
select throws_ok(
  $$insert into public.submissions (request_type, suggested_name) values ('suggestion', 'Direct write')$$,
  '42501', null, 'normal authenticated users cannot write submissions directly'
);
select throws_ok($$select * from public.review_queue$$, '42501', null, 'normal authenticated users cannot read moderation records');
select throws_ok(
  $$insert into storage.objects (bucket_id, name, metadata)
    values ('project-logos', 'authenticated-upload.png', '{}'::jsonb)$$,
  '42501', null, 'authenticated users cannot upload logo objects'
);

reset role;

-- Publication guard rejects incomplete or unverified projects.
select throws_ok(
  $$update public.projects set publication_status = 'published'
    where id = '00000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'projects without a name and summary cannot be published'
);
select throws_ok(
  $$update public.projects set publication_status = 'published'
    where id = '00000000-0000-4000-8000-000000000004'$$,
  '23514', null, 'unknown licenses cannot be treated as verified open source'
);
select throws_ok(
  $$update public.projects set publication_status = 'published'
    where id = '00000000-0000-4000-8000-000000000005'$$,
  '23514', null, 'projects without an available primary repository cannot be published'
);
select throws_ok(
  $$update public.projects set publication_status = 'published'
    where id = '00000000-0000-4000-8000-000000000006'$$,
  '23514', null, 'projects without a category cannot be published'
);

select * from finish();
rollback;
