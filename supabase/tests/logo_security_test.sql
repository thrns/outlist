begin;
select plan(28);

select has_column('public', 'project_logos', 'candidate_key', 'logo candidates have a stable identity');
select has_column('public', 'project_logos', 'repository_id', 'logo candidates retain their repository association');
select has_column('public', 'project_logos', 'source_record_id', 'logo candidates retain source provenance');
select has_column('public', 'project_logos', 'source_provenance', 'logo candidates retain source API provenance');
select has_column('public', 'project_logos', 'content_digest', 'approved assets retain their content digest');
select has_column('public', 'project_logos', 'approval_provenance', 'approved assets retain operator approval provenance');
select has_column('public', 'project_logos', 'approval_token', 'approval work is fenced by a token');
select has_column('public', 'project_logos', 'approval_lease_expires_at', 'approval claims expire after interruption');

select ok((select relrowsecurity from pg_class where oid = 'public.project_logos'::regclass), 'logo metadata uses RLS');
select ok(not has_table_privilege('anon', 'public.project_logos', 'INSERT'), 'anonymous clients cannot insert logo metadata');
select ok(not has_table_privilege('authenticated', 'public.project_logos', 'UPDATE'), 'authenticated clients cannot update logo metadata');
select ok(not has_table_privilege('service_role', 'public.project_logos', 'INSERT'), 'service-role REST writes are blocked outside trusted RPCs');
select ok(not has_table_privilege('service_role', 'public.project_logos', 'UPDATE'), 'service-role REST updates are blocked outside trusted RPCs');
select ok(not has_function_privilege('anon', 'public.register_project_logo_candidate(uuid,text,text,text,text,uuid,uuid,timestamptz,jsonb)', 'EXECUTE'), 'anonymous clients cannot register candidates');
select ok(not has_function_privilege('authenticated', 'public.approve_project_logo_candidate(uuid,uuid,text,text,text,jsonb)', 'EXECUTE'), 'authenticated clients cannot approve candidates');
select ok(not has_function_privilege('anon', 'public.set_project_logo_review_status(uuid,text)', 'EXECUTE'), 'anonymous clients cannot reject or revoke logos');
select ok(not has_function_privilege('anon', 'public.claim_project_logo_approval(uuid)', 'EXECUTE'), 'anonymous clients cannot claim logo approval');
select ok(not has_function_privilege('anon', 'public.release_project_logo_approval(uuid,uuid)', 'EXECUTE'), 'anonymous clients cannot release logo approval claims');
select ok(not has_function_privilege('anon', 'public.claim_project_logo_cleanup(uuid,uuid)', 'EXECUTE'), 'anonymous clients cannot claim logo cleanup');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'project_logos_candidate_identity_unique'), 'candidate identity is unique per project');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'project_logos_one_primary_per_project_idx'), 'only one approved primary logo can exist per project');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'review_queue_open_logo_unique'), 'logo candidates have one open review item');
select is((select public from storage.buckets where id = 'project-logos'), true, 'project logo bucket remains public read');
select is((select file_size_limit from storage.buckets where id = 'project-logos'), 2097152::bigint, 'logo bucket remains capped at 2 MiB');
select ok(not exists (
  select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname ilike '%project%logo%' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
), 'there is no client upload or mutation policy for the public logo bucket');

insert into public.projects (id, slug, name, publication_status, quality_status, license_status)
values ('91100000-0000-4000-8000-000000000001', 'logo-security-fixture', 'Logo Security Fixture', 'pending_review', 'unreviewed', 'unverified');

select throws_ok($$insert into public.project_logos (project_id, source_url, media_type, origin, verification_status, is_primary)
  values ('91100000-0000-4000-8000-000000000001', 'https://avatars.githubusercontent.com/u/1', 'image/webp', 'provider_avatar', 'pending_review', true)$$,
  '23514', null, 'a pending candidate cannot be primary');

insert into public.project_logos (
  id, project_id, source_url, media_type, origin, verification_status, storage_path,
  content_digest, verified_at, approval_provenance, attribution_text, is_primary
) values (
  '92200000-0000-4000-8000-000000000001', '91100000-0000-4000-8000-000000000001',
  'https://outlist.example/logo.png', 'image/webp', 'official_site', 'approved',
  '91100000-0000-4000-8000-000000000001/92200000-0000-4000-8000-000000000001.webp',
  repeat('a', 64), clock_timestamp(), '{"operator_action":true}'::jsonb, 'Official logo fixture', true
);

select throws_ok($$insert into public.project_logos (
    id, project_id, source_url, media_type, origin, verification_status, storage_path,
    content_digest, verified_at, approval_provenance, is_primary
  ) values (
    '92200000-0000-4000-8000-000000000002', '91100000-0000-4000-8000-000000000001',
    'https://avatars.githubusercontent.com/u/2', 'image/webp', 'provider_avatar', 'approved',
    '91100000-0000-4000-8000-000000000001/92200000-0000-4000-8000-000000000002.webp',
    repeat('b', 64), clock_timestamp(), '{"operator_action":true}'::jsonb, true
  )$$, '23514', 'an approved provider avatar cannot displace an official logo');

select throws_ok($$update public.project_logos set source_url = 'https://attacker.example/logo.png'
  where id = '92200000-0000-4000-8000-000000000001'$$,
  '42501', 'logo source identity and provenance are immutable', 'stored logo source attribution cannot be silently rewritten');

select * from finish();
rollback;
