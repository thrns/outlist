begin;
select plan(53);

select has_column('public', 'project_logos', 'candidate_key', 'logo candidates have a stable identity');
select has_column('public', 'project_logos', 'repository_id', 'logo candidates retain their repository association');
select has_column('public', 'project_logos', 'source_record_id', 'logo candidates retain source provenance');
select has_column('public', 'project_logos', 'source_provenance', 'logo candidates retain source API provenance');
select has_column('public', 'project_logos', 'content_digest', 'approved assets retain their content digest');
select has_column('public', 'project_logos', 'approval_provenance', 'approved assets retain operator approval provenance');
select has_column('public', 'project_logos', 'approval_token', 'approval work is fenced by a token');
select has_column('public', 'project_logos', 'approval_worker_id', 'approval claims retain worker identity separately from the random token');
select has_column('public', 'project_logos', 'approval_lease_expires_at', 'approval claims expire after interruption');
select has_table('private', 'project_logo_storage_attempts', 'approval attempts retain immutable Storage identities for recovery');
select ok((select relrowsecurity from pg_class where oid = 'private.project_logo_storage_attempts'::regclass), 'Storage attempt metadata uses RLS');
select ok(not has_table_privilege('anon', 'private.project_logo_storage_attempts', 'SELECT'), 'anonymous clients cannot read private attempt paths');
select ok(not has_table_privilege('authenticated', 'private.project_logo_storage_attempts', 'SELECT'), 'authenticated clients cannot read private attempt paths');
select ok(not has_table_privilege('service_role', 'private.project_logo_storage_attempts', 'SELECT'), 'service role REST reads cannot bypass cleanup RPCs');
select ok(not has_function_privilege('anon', 'public.list_project_logo_cleanup_attempts(uuid)', 'EXECUTE'), 'anonymous clients cannot list cleanup paths');
select ok(not has_function_privilege('authenticated', 'public.list_project_logo_cleanup_attempts(uuid)', 'EXECUTE'), 'authenticated clients cannot list cleanup paths');
select ok(has_function_privilege('service_role', 'public.list_project_logo_cleanup_attempts(uuid)', 'EXECUTE'), 'service role can list cleanup paths through the RPC');

select ok((select relrowsecurity from pg_class where oid = 'public.project_logos'::regclass), 'logo metadata uses RLS');
select ok(not has_table_privilege('anon', 'public.project_logos', 'INSERT'), 'anonymous clients cannot insert logo metadata');
select ok(not has_table_privilege('authenticated', 'public.project_logos', 'UPDATE'), 'authenticated clients cannot update logo metadata');
select ok(not has_table_privilege('service_role', 'public.project_logos', 'INSERT'), 'service-role REST writes are blocked outside trusted RPCs');
select ok(not has_table_privilege('service_role', 'public.project_logos', 'UPDATE'), 'service-role REST updates are blocked outside trusted RPCs');
select ok(not has_function_privilege('anon', 'public.register_project_logo_candidate(uuid,text,text,text,text,uuid,uuid,timestamptz,jsonb)', 'EXECUTE'), 'anonymous clients cannot register candidates');
select ok(not has_function_privilege('authenticated', 'public.approve_project_logo_candidate(uuid,uuid,uuid,text,text,text,jsonb)', 'EXECUTE'), 'authenticated clients cannot approve candidates');
select ok(not has_function_privilege('anon', 'public.set_project_logo_review_status(uuid,text)', 'EXECUTE'), 'anonymous clients cannot reject or revoke logos');
select ok(not has_function_privilege('anon', 'public.claim_project_logo_approval(uuid,uuid)', 'EXECUTE'), 'anonymous clients cannot claim logo approval');
select ok(not has_function_privilege('anon', 'public.release_project_logo_approval(uuid,uuid,uuid)', 'EXECUTE'), 'anonymous clients cannot release logo approval claims');
select ok(not has_function_privilege('anon', 'public.claim_project_logo_cleanup(uuid,uuid,uuid)', 'EXECUTE'), 'anonymous clients cannot claim logo cleanup');
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
select ok(exists (select 1 from public.project_logos where id = '92200000-0000-4000-8000-000000000001'
  and storage_path = '91100000-0000-4000-8000-000000000001/92200000-0000-4000-8000-000000000001.webp'),
  'previous valid two-segment Storage paths remain accepted after migration');

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

insert into public.project_logos (
  id, project_id, source_url, media_type, origin, verification_status, attribution_text
) values (
  '92200000-0000-4000-8000-000000000003', '91100000-0000-4000-8000-000000000001',
  'https://outlist.example/logo-next.png', 'image/webp', 'official_site', 'pending_review', 'Second official logo fixture'
);
insert into public.review_queue (project_logo_id, reason, status)
values ('92200000-0000-4000-8000-000000000003', 'Logo fencing test fixture', 'open');

select set_config('request.jwt.claim.role', 'service_role', true);
create temporary table logo_claim_a on commit drop as
select public.claim_project_logo_approval('92200000-0000-4000-8000-000000000003', '93300000-0000-4000-8000-000000000011') as result;
select is((select result->>'status' from logo_claim_a), 'claimed', 'worker A receives an approval fencing token');
select ok((select result->>'worker_id' = '93300000-0000-4000-8000-000000000011'
  and approval_worker_id = '93300000-0000-4000-8000-000000000011'::uuid
  from logo_claim_a cross join public.project_logos
  where id = '92200000-0000-4000-8000-000000000003'),
  'claim response and candidate row retain the owning worker identity');
select ok((select (result->>'storage_path') = ('91100000-0000-4000-8000-000000000001/92200000-0000-4000-8000-000000000003/' || (result->>'approval_token') || '.webp') from logo_claim_a),
  'worker A receives a project-scoped immutable path derived from its token');

select throws_ok($$insert into private.project_logo_storage_attempts (
    approval_token, worker_id, logo_id, project_id, storage_path, state, lease_expires_at
  ) values (
    '93300000-0000-4000-8000-000000000001', '93300000-0000-4000-8000-000000000010', '92200000-0000-4000-8000-000000000003',
    '91100000-0000-4000-8000-000000000001',
    '91100000-0000-4000-8000-000000000001/92200000-0000-4000-8000-000000000003/93300000-0000-4000-8000-000000000002.webp',
    'claimed', clock_timestamp() + interval '10 minutes'
  )$$, '23514', null, 'attempt ledger rejects an object path that does not match its fencing token');

update public.project_logos set approval_lease_expires_at = clock_timestamp() - interval '1 second'
where id = '92200000-0000-4000-8000-000000000003';
create temporary table logo_claim_b on commit drop as
select public.claim_project_logo_approval('92200000-0000-4000-8000-000000000003', '93300000-0000-4000-8000-000000000012') as result;
select is((select result->>'status' from logo_claim_b), 'claimed', 'worker B can claim after worker A expires');
select isnt((select result->>'approval_token' from logo_claim_b), (select result->>'approval_token' from logo_claim_a),
  'reclaiming approval creates a distinct fencing token');
select isnt((select result->>'storage_path' from logo_claim_b), (select result->>'storage_path' from logo_claim_a),
  'reclaiming approval creates a distinct Storage object path');

select throws_ok(
  format('select public.approve_project_logo_candidate(%L::uuid, %L::uuid, %L::uuid, %L, %L, %L, %L::jsonb)',
    '92200000-0000-4000-8000-000000000003',
    '93300000-0000-4000-8000-000000000011',
    (select result->>'approval_token' from logo_claim_a),
    (select result->>'storage_path' from logo_claim_a), repeat('a', 64), 'image/webp', '{"operator_action":true}'),
  '40001', 'logo approval claim is missing, expired, or stale', 'expired worker A cannot commit approval after worker B reclaims');

select throws_ok(
  format('select public.approve_project_logo_candidate(%L::uuid, %L::uuid, %L::uuid, %L, %L, %L, %L::jsonb)',
    '92200000-0000-4000-8000-000000000003', '93300000-0000-4000-8000-000000000099',
    (select result->>'approval_token' from logo_claim_b), (select result->>'storage_path' from logo_claim_b),
    repeat('b', 64), 'image/webp', '{"operator_action":true}'),
  '40001', 'logo approval claim is missing, expired, or stale', 'a different worker cannot commit with another worker token');

select is((public.approve_project_logo_candidate(
    '92200000-0000-4000-8000-000000000003', '93300000-0000-4000-8000-000000000012',
    (select (result->>'approval_token')::uuid from logo_claim_b),
    (select result->>'storage_path' from logo_claim_b), repeat('b', 64), 'image/webp', '{"operator_action":true}'::jsonb
  )->>'status'), 'approved', 'current worker B can atomically approve its own immutable object');
select ok((select storage_path = result->>'storage_path' and content_digest = repeat('b', 64)
  from public.project_logos cross join logo_claim_b where id = '92200000-0000-4000-8000-000000000003'),
  'approved metadata records worker B path and digest together');
select ok((select is_primary from public.project_logos where id = '92200000-0000-4000-8000-000000000001'),
  'approving another official candidate does not replace the existing official primary');
select is((public.claim_project_logo_cleanup(
    '92200000-0000-4000-8000-000000000003',
    (select (result->>'approval_token')::uuid from logo_claim_a), '93300000-0000-4000-8000-000000000011'
  )->>'status'), 'cleanup_claimed', 'stale worker cleanup is scoped to its unapproved attempt');
select is((public.claim_project_logo_cleanup(
    '92200000-0000-4000-8000-000000000003',
    (select (result->>'approval_token')::uuid from logo_claim_a), '93300000-0000-4000-8000-000000000011'
  )->>'storage_path'), (select result->>'storage_path' from logo_claim_a),
  'stale cleanup returns A path rather than the approved B path');
select ok((select storage_path = result->>'storage_path' and content_digest = repeat('b', 64)
  from public.project_logos cross join logo_claim_b where id = '92200000-0000-4000-8000-000000000003'),
  'stale cleanup leaves worker B approved metadata unchanged');

select * from finish();
rollback;
