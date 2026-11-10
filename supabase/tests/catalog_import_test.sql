begin;
select no_plan();

set local "request.jwt.claims" = '{"role":"service_role"}';

create temporary table catalog_import_job (job_id uuid, lease_token uuid);
create temporary table catalog_import_commit (result jsonb);

-- Existing candidate metadata is human/system state and must remain untouched.
insert into public.source_records (
  provider, record_kind, source_key, source_url, fetched_at, http_status, raw_payload, source_metadata
) values (
  'github', 'repository', 'github:repository:99110003', 'https://api.github.com/repositories/99110003',
  clock_timestamp(), 200, '{"id":99110003}'::jsonb, '{"validated":true}'::jsonb
);
insert into public.repository_candidates (
  provider, provider_repository_id, full_name, canonical_url, source_record_id, description, review_status
) values (
  'github', '99110003', 'human/existing', 'https://github.com/human/existing',
  (select id from public.source_records where source_key = 'github:repository:99110003'),
  'Human reviewed candidate note', 'accepted'
);
insert into public.repositories (provider, provider_repository_id, full_name, canonical_url)
values ('github', '99110005', 'human/repository', 'https://github.com/human/repository');

insert into catalog_import_job
select (public.start_catalog_import(
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  1, 4, 'local', 'local-test-project', false, 'catalog-test-worker',
  '00000000-0000-4000-8000-000000000101'
)->>'job_id')::uuid,
  '00000000-0000-4000-8000-000000000101'::uuid;

insert into catalog_import_commit
select public.commit_catalog_import_batch(
  (select job_id from catalog_import_job), 'catalog-test-worker', (select lease_token from catalog_import_job),
  1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  jsonb_build_array(
    jsonb_build_object(
      'source_candidate', jsonb_build_object('schema_version', 1, 'github_repository_id', '99110001',
        'name', 'Candidate One', 'slug', 'same-title', 'primary_category', 'developer-tools',
        'license_review_status', 'unverified'),
      'source_batch', 1, 'source_line', 1, 'import_candidate', true,
      'verification', '{"status":"requires_manual_review"}'::jsonb,
      'github_response', jsonb_build_object('id', 99110001, 'owner', jsonb_build_object('login', 'public-owner'),
        'name', 'tool-one', 'full_name', 'public-owner/tool-one', 'private', false,
        'disabled', false, 'visibility', 'public', 'license', jsonb_build_object('spdx_id', 'MIT')),
      'provenance', jsonb_build_object('source_url', 'https://api.github.com/repositories/99110001',
        'stable_resource_identity', 'github:repository:99110001', 'fetched_at', clock_timestamp(),
        'http_status', 200, 'api_version', '2022-11-28')
    ),
    jsonb_build_object(
      'source_candidate', jsonb_build_object('schema_version', 1, 'github_repository_id', '99110002',
        'name', 'Candidate Two', 'slug', 'same-title', 'primary_category', 'developer-tools',
        'license_review_status', 'unverified'),
      'source_batch', 1, 'source_line', 2, 'import_candidate', true,
      'verification', '{"status":"requires_manual_review"}'::jsonb,
      'github_response', jsonb_build_object('id', 99110002, 'owner', jsonb_build_object('login', 'another-owner'),
        'name', 'tool-two', 'full_name', 'another-owner/tool-two', 'private', false,
        'disabled', false, 'visibility', 'public', 'license', null),
      'provenance', jsonb_build_object('source_url', 'https://api.github.com/repositories/99110002',
        'stable_resource_identity', 'github:repository:99110002', 'fetched_at', clock_timestamp(),
        'http_status', 200, 'api_version', '2022-11-28')
    ),
    jsonb_build_object(
      'source_candidate', jsonb_build_object('schema_version', 1, 'github_repository_id', '99110003',
        'name', 'Do Not Replace', 'slug', 'existing-seed', 'primary_category', 'developer-tools',
        'license_review_status', 'unverified'),
      'source_batch', 1, 'source_line', 3, 'import_candidate', true,
      'verification', '{"status":"requires_manual_review"}'::jsonb,
      'github_response', jsonb_build_object('id', 99110003, 'owner', jsonb_build_object('login', 'current-owner'),
        'name', 'renamed', 'full_name', 'current-owner/renamed', 'private', false,
        'disabled', false, 'visibility', 'public', 'license', null),
      'provenance', jsonb_build_object('source_url', 'https://api.github.com/repositories/99110003',
        'stable_resource_identity', 'github:repository:99110003', 'fetched_at', clock_timestamp(),
        'http_status', 200, 'api_version', '2022-11-28')
    ),
    jsonb_build_object(
      'source_candidate', jsonb_build_object('schema_version', 1, 'github_repository_id', '99110005',
        'name', 'Do Not Replace Repository', 'slug', 'existing-repository', 'primary_category', 'developer-tools',
        'license_review_status', 'unverified'),
      'source_batch', 1, 'source_line', 4, 'import_candidate', true,
      'verification', '{"status":"requires_manual_review"}'::jsonb,
      'github_response', jsonb_build_object('id', 99110005, 'owner', jsonb_build_object('login', 'current-owner'),
        'name', 'renamed-repository', 'full_name', 'current-owner/renamed-repository', 'private', false,
        'disabled', false, 'visibility', 'public', 'license', null),
      'provenance', jsonb_build_object('source_url', 'https://api.github.com/repositories/99110005',
        'stable_resource_identity', 'github:repository:99110005', 'fetched_at', clock_timestamp(),
        'http_status', 200, 'api_version', '2022-11-28')
    )
  )
);

select is((select result->>'next_batch_number' from catalog_import_commit), '2',
  'successful batch advances one durable checkpoint');
select is((select result->>'imported' from catalog_import_commit), '2',
  'new stable repository identities enter the existing candidate queue');
select is((select result->>'existing' from catalog_import_commit), '2',
  'existing candidate and repository identities are counted without replacing state');
select is((select result->'results'->1->>'result' from catalog_import_commit), 'created_candidate',
  'new candidate is recorded against its canonical GitHub identity');
select is((select result->'results'->2->>'result' from catalog_import_commit), 'existing_candidate',
  'production candidate identity is reconciled safely');
select is((select result->'results'->3->>'result' from catalog_import_commit), 'existing_repository',
  'production repository identity is reconciled without creating a duplicate candidate');
select is((select result->'results'->0->>'result' from catalog_import_commit), 'created_candidate',
  'first slug proposal imports deterministically');
select is((select result->'results'->1->>'github_repository_id' from catalog_import_commit), '99110002',
  'second colliding slug candidate retains its source repository identity');
select is((select result->'catalog_import'->>'resolved_slug' from public.ingestion_items
  where job_id = (select job_id from catalog_import_job) and item_key = 'github:99110002'),
  'same-title-99110002', 'a slug collision receives a deterministic repository-ID suffix');
select is((select public.commit_catalog_import_batch(
  (select job_id from catalog_import_job), 'catalog-test-worker', (select lease_token from catalog_import_job),
  1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  (select jsonb_agg(jsonb_build_object(
    'source_candidate', i.result->'catalog_import'->'source_candidate',
    'source_batch', i.result->'catalog_import'->'batch_number',
    'source_line', i.result->'catalog_import'->'batch_line',
    'import_candidate', true,
    'verification', i.result->'catalog_import'->'verification',
    'github_response', i.result->'catalog_import'->'github_response',
    'provenance', i.result->'catalog_import'->'provenance'
  ) order by (i.result->'catalog_import'->>'batch_line')::integer)
    from public.ingestion_items i where i.job_id = (select job_id from catalog_import_job))
)->>'idempotent_replay'), 'true', 'replaying the committed batch hash is idempotent');
select is((select description from public.repository_candidates where provider_repository_id = '99110003'),
  'Human reviewed candidate note', 'existing candidate description is never overwritten');
select is((select review_status from public.repository_candidates where provider_repository_id = '99110003'),
  'accepted', 'existing candidate editorial review state is never overwritten');
select is((select full_name from public.repositories where provider_repository_id = '99110005'),
  'human/repository', 'existing repository identity is never renamed by catalog input');
select is((select count(*)::integer from public.repository_candidates where provider_repository_id = '99110005'), 0,
  'a conflicting production repository does not receive a duplicate candidate');
select is((select count(*)::integer from public.projects where slug like 'same-title%'), 0,
  'import batches never create project drafts or publish projects');
select is((select count(*)::integer from public.project_logos where project_id in
  (select id from public.projects where slug like 'same-title%')), 0,
  'import batches never approve or create logos');
select is((select count(*)::integer from public.source_records where source_metadata->>'catalog_import_job_id' =
  (select job_id::text from catalog_import_job)), 2, 'current GitHub source evidence is saved for new candidates');
select is((select raw_payload->>'full_name' from public.source_records
  where source_key = 'github:repository:99110001'), 'public-owner/tool-one',
  'the source record preserves the provider-shaped GitHub REST response');
select is((select result->'catalog_import'->'provenance'->>'stable_resource_identity' from public.ingestion_items
  where job_id = (select job_id from catalog_import_job) and item_key = 'github:99110001'),
  'github:repository:99110001', 'the candidate ledger preserves the stable identity provenance');

select public.finish_catalog_import((select job_id from catalog_import_job), 'catalog-test-worker',
  (select lease_token from catalog_import_job), null);
select is((select status from public.ingestion_jobs where id = (select job_id from catalog_import_job)), 'succeeded',
  'complete import releases its lease and records success');

select is((public.start_catalog_import(
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  1, 4, 'local', 'local-test-project', false, 'catalog-test-worker-replay',
  '00000000-0000-4000-8000-000000000102'
)->>'already_complete')::boolean, true, 'starting an already complete archive cannot duplicate mutations');

create temporary table catalog_import_recovery (job_id uuid, lease_token uuid);
insert into catalog_import_recovery
select (public.start_catalog_import(
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  2, 2, 'local', 'local-test-project', false, 'catalog-test-worker-interrupted',
  '00000000-0000-4000-8000-000000000103'
)->>'job_id')::uuid,
  '00000000-0000-4000-8000-000000000103'::uuid;
select public.finish_catalog_import((select job_id from catalog_import_recovery), 'catalog-test-worker-interrupted',
  (select lease_token from catalog_import_recovery), 'simulated interruption');
select is((select status from public.ingestion_jobs where id = (select job_id from catalog_import_recovery)), 'partial',
  'interrupted import remains resumable with its checkpoint');
select (public.start_catalog_import(
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  2, 2, 'local', 'local-test-project', true, 'catalog-test-worker-resume',
  '00000000-0000-4000-8000-000000000104'
)->>'next_batch_number')::integer as next_batch_number
into temporary table catalog_import_recovered_checkpoint;
select is((select next_batch_number from catalog_import_recovered_checkpoint), 1,
  'resume recovers the first uncommitted batch');
select throws_ok($$select public.start_catalog_import(
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  1, 1, 'local', 'local-test-project', false, 'catalog-test-worker-concurrent',
  '00000000-0000-4000-8000-000000000106'
)$$, '55P03', null, 'a live catalog import lease blocks another archive import');
select public.finish_catalog_import((select job_id from catalog_import_recovery), 'catalog-test-worker-resume',
  '00000000-0000-4000-8000-000000000104', 'test cleanup');

create temporary table catalog_import_invalid (job_id uuid, lease_token uuid);
insert into catalog_import_invalid
select (public.start_catalog_import(
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  1, 1, 'local', 'local-test-project', false, 'catalog-test-worker-invalid',
  '00000000-0000-4000-8000-000000000105'
)->>'job_id')::uuid,
  '00000000-0000-4000-8000-000000000105'::uuid;
select throws_ok($$select public.commit_catalog_import_batch(
  (select job_id from catalog_import_invalid), 'catalog-test-worker-invalid',
  (select lease_token from catalog_import_invalid), 1,
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  jsonb_build_array(jsonb_build_object(
    'source_candidate', jsonb_build_object('schema_version', 1, 'github_repository_id', '99110004',
      'name', 'Private', 'slug', 'private', 'primary_category', 'developer-tools'),
    'source_batch', 1, 'source_line', 1, 'import_candidate', true,
    'verification', '{"status":"requires_manual_review"}'::jsonb,
    'github_response', jsonb_build_object('id', 99110004, 'owner', jsonb_build_object('login', 'private-owner'),
      'name', 'private-repo', 'full_name', 'private-owner/private-repo', 'private', true,
      'disabled', false, 'visibility', 'private'),
    'provenance', jsonb_build_object('source_url', 'https://api.github.com/repositories/99110004',
      'stable_resource_identity', 'github:repository:99110004', 'fetched_at', clock_timestamp(),
      'http_status', 200, 'api_version', '2022-11-28')
  )))$$, '23514', null, 'private repository response aborts the complete database batch');
select is((select (metadata->'catalog_import'->>'next_batch_number')::integer
  from public.ingestion_jobs where id = (select job_id from catalog_import_invalid)), 1,
  'failed batch transaction does not advance its checkpoint');
select is((select count(*)::integer from public.repository_candidates where provider_repository_id = '99110004'), 0,
  'failed batch transaction leaves no candidate row behind');
select public.commit_catalog_import_batch(
  (select job_id from catalog_import_invalid), 'catalog-test-worker-invalid',
  (select lease_token from catalog_import_invalid), 1,
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  jsonb_build_array(jsonb_build_object(
    'source_candidate', jsonb_build_object('schema_version', 1, 'github_repository_id', '99110006',
      'name', 'Excluded Private Candidate', 'slug', 'excluded-private-candidate',
      'description', 'SENSITIVE ARCHIVED DESCRIPTION',
      'primary_category', 'developer-tools', 'license_review_status', 'needs_review'),
    'source_batch', 1, 'source_line', 1, 'import_candidate', false,
    'verification', jsonb_build_object('status', 'rejected_or_excluded', 'reasons',
      jsonb_build_array(jsonb_build_object('code', 'not_publicly_available'))),
    'github_response', jsonb_build_object('id', 99110006, 'owner', jsonb_build_object('login', 'private-owner'),
      'name', 'private-repo', 'full_name', 'private-owner/private-repo', 'private', true,
      'disabled', false, 'visibility', 'private', 'description', 'SENSITIVE PRIVATE DESCRIPTION'),
    'provenance', jsonb_build_object('source_url', 'https://api.github.com/repositories/99110006',
      'stable_resource_identity', 'github:repository:99110006', 'fetched_at', clock_timestamp(),
      'http_status', 200, 'api_version', '2022-11-28')
  ))
);
select is((select item_type from public.ingestion_items where job_id = (select job_id from catalog_import_invalid)
  and item_key = 'github:99110006'), 'catalog_import_exclusion',
  'excluded identities receive a sanitized classification in the import ledger');
select is((select result->'catalog_import'->>'repository_id' from public.ingestion_items
  where job_id = (select job_id from catalog_import_invalid) and item_key = 'github:99110006'), '99110006',
  'the exclusion ledger retains only the safe stable repository identity');
select is((select result->'catalog_import'->>'classification' from public.ingestion_items
  where job_id = (select job_id from catalog_import_invalid) and item_key = 'github:99110006'), 'rejected_or_excluded',
  'the exclusion ledger records the review classification');
select ok((select not (result->'catalog_import' ? 'github_response')
  and not (result->'catalog_import' ? 'source_candidate')
  and not (result->'catalog_import' ? 'provenance')
  and result::text not like '%SENSITIVE%'
  and result::text not like '%private-owner%'
  from public.ingestion_items where job_id = (select job_id from catalog_import_invalid) and item_key = 'github:99110006'),
  'private repository fields and archived descriptions are absent from the exclusion ledger');
select is((select count(*)::integer from public.ingestion_items i,
  lateral jsonb_object_keys(i.result->'catalog_import') as catalog_import_keys(key)
  where i.job_id = (select job_id from catalog_import_invalid) and i.item_key = 'github:99110006'), 4,
  'the exclusion result contains only identity, classification, reason codes, and observation timestamp');
select is((select count(*)::integer from public.repository_candidates where provider_repository_id = '99110006'), 0,
  'excluded private identities never enter the repository candidate queue');
select is((select count(*)::integer from public.source_records where source_key = 'github:repository:99110006'), 0,
  'restricted GitHub metadata never enters public source_records');
select is(jsonb_array_length(public.catalog_import_exclusions((select job_id from catalog_import_invalid))), 1,
  'resume reporting can safely recover previously excluded identities');
select is((public.catalog_import_exclusions((select job_id from catalog_import_invalid))->0->>'repository_id'), '99110006',
  'resumed reports receive only the safe excluded identity');
select ok((public.catalog_import_exclusions((select job_id from catalog_import_invalid)))::text not like '%SENSITIVE%'
  and (public.catalog_import_exclusions((select job_id from catalog_import_invalid)))::text not like '%private-owner%',
  'resume exclusion results cannot re-expose restricted metadata');
select public.finish_catalog_import((select job_id from catalog_import_invalid), 'catalog-test-worker-invalid',
  (select lease_token from catalog_import_invalid), null);
select is((public.catalog_import_status()->'reconciliation'->>'candidate_item_ledger_matches')::boolean, true,
  'status reconciles included and excluded candidates against the durable ledger');
set local "request.jwt.claims" = '{"role":"anon"}';
select throws_ok($$select public.catalog_import_status()$$, '42501', null,
  'import status is available only to the service role');
select throws_ok($$select public.catalog_import_exclusions((select job_id from catalog_import_invalid))$$, '42501', null,
  'catalog exclusion details are available only to the service role');

select * from finish();
rollback;
