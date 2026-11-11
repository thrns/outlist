begin;
select no_plan();

select has_table('private', 'codex_editorial_authorization', 'Codex editorial policy has a private authorization boundary');
select has_table('private', 'codex_editorial_authorization_events', 'Policy authorization history is durable');
select has_table('private', 'codex_approved_license_ids', 'Pinned OSI license identifiers are stored privately');
select has_table('public', 'codex_editorial_reviews', 'Completed Codex review records are stored');
select has_table('public', 'codex_review_applications', 'Review applications are stored separately from model output');
select has_table('public', 'project_publication_revocations', 'Publication revocations have an append-only audit');
select ok((select relrowsecurity from pg_class where oid = 'public.codex_editorial_reviews'::regclass),
  'Codex review records keep row-level security enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.project_publication_revocations'::regclass),
  'Publication revocation records keep row-level security enabled');
select ok(not has_table_privilege('anon', 'public.codex_editorial_reviews', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated', 'public.codex_editorial_reviews', 'SELECT,INSERT,UPDATE,DELETE'),
  'Public and signed-in users cannot read or mutate Codex review records');
select ok(has_table_privilege('service_role', 'public.codex_editorial_reviews', 'SELECT')
  and not has_table_privilege('service_role', 'public.codex_editorial_reviews', 'INSERT,UPDATE,DELETE'),
  'Service-role audit reads are allowed while raw review writes remain behind RPCs');
select ok(not has_table_privilege('service_role', 'public.editorial_decisions', 'INSERT,UPDATE,DELETE'),
  'Service role cannot write human or automated decision rows directly');
select ok(has_table_privilege('service_role', 'public.editorial_overrides', 'SELECT')
  and not has_table_privilege('service_role', 'public.editorial_overrides', 'INSERT,UPDATE,DELETE'),
  'Service role cannot write human-approved editorial overrides directly');
select ok(not has_table_privilege('anon', 'public.project_publication_revocations', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated', 'public.project_publication_revocations', 'SELECT,INSERT,UPDATE,DELETE'),
  'Revocation records are private to trusted RPCs');
select ok(has_function_privilege('service_role', 'public.codex_record_editorial_review(uuid,text,uuid,text,text,text,timestamptz,text,text,text,text,jsonb,jsonb,jsonb)', 'EXECUTE'),
  'Only the service role can persist a validated Codex review through the RPC');
select ok(not has_function_privilege('anon', 'public.codex_record_editorial_review(uuid,text,uuid,text,text,text,timestamptz,text,text,text,text,jsonb,jsonb,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.codex_record_editorial_review(uuid,text,uuid,text,text,text,timestamptz,text,text,text,text,jsonb,jsonb,jsonb)', 'EXECUTE'),
  'Ordinary users cannot submit automated editorial decisions');
select ok(has_function_privilege('service_role', 'public.codex_apply_editorial_review(uuid,uuid,text,bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.codex_create_reviewed_draft(uuid,uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.codex_publish_project(uuid,uuid,text,bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.codex_revoke_publication(uuid,uuid,bigint,text)', 'EXECUTE'),
  'Apply, publish, and revoke use separate authenticated service-role RPCs');
select ok(has_function_privilege('service_role', 'public.admin_verify_project_license(uuid,uuid,bigint,timestamptz,text,text,text,boolean)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_verify_project_quality(uuid,uuid,bigint,timestamptz,text,boolean)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_publish_project(uuid,uuid,bigint,text)', 'EXECUTE'),
  'The existing human-admin review and publication workflow remains available');
select is((select enabled from private.codex_editorial_authorization where singleton), false,
  'Autonomous editorial policy is disabled by default');

create temporary table codex_editorial_test_fixture (
  review_id text not null,
  project_id uuid not null,
  candidate_id uuid not null
) on commit drop;
grant select on codex_editorial_test_fixture to service_role;
do $fixture$
declare
  v_project_id uuid := gen_random_uuid();
  v_category_id uuid := gen_random_uuid();
  v_repository_id uuid := gen_random_uuid();
  v_candidate_id uuid := gen_random_uuid();
  v_source_record_id uuid := gen_random_uuid();
  v_review_id text := 'codex_' || repeat('a', 40);
  v_observed_at timestamptz := clock_timestamp();
begin
  insert into public.projects (id, slug, name, summary, publication_status)
  values (v_project_id, 'codex-policy-fixture', 'Codex Policy Fixture', 'A test fixture for the Codex publication policy.', 'pending_review');
  insert into public.categories (id, slug, name)
  values (v_category_id, 'codex-policy-test', 'Codex Policy Test');
  insert into public.project_categories (project_id, category_id)
  values (v_project_id, v_category_id);
  insert into public.repositories (
    id, project_id, provider, provider_repository_id, full_name, canonical_url,
    owner_login, repository_name, availability_status, is_private, visibility, is_disabled,
    is_archived, source_observed_at, last_successful_sync_at, source_license_metadata, source_field_states
  ) values (
    v_repository_id, v_project_id, 'github', '987654321', 'fixture/codex-policy',
    'https://github.com/fixture/codex-policy', 'fixture', 'codex-policy', 'available', false, 'public', false,
    false, v_observed_at, v_observed_at, '{"spdx_id":"MIT","name":"MIT License"}'::jsonb,
    '{"visibility":"present","license":"present"}'::jsonb
  );
  update public.projects set primary_repository_id = v_repository_id where id = v_project_id;
  insert into public.source_records (
    id, provider, record_kind, source_key, source_url, fetched_at, http_status,
    repository_id, source_metadata
  ) values (
    v_source_record_id, 'github', 'repository', 'codex-fixture:repository',
    'https://api.github.com/repositories/987654321', v_observed_at, 200,
    v_repository_id, '{}'::jsonb
  );
  insert into public.repository_candidates (
    id, provider, provider_repository_id, full_name, canonical_url,
    source_record_id, repository_id
  ) values (
    v_candidate_id, 'github', '987654321', 'fixture/codex-policy',
    'https://github.com/fixture/codex-policy', v_source_record_id, v_repository_id
  );
  insert into public.codex_editorial_reviews (
    review_id, candidate_id, provider_repository_id, full_name, codex_version,
    review_policy_version, evidence_observed_at, evidence_sha256, evidence,
    codex_review, policy_decision, decision, publication_eligible
  ) values (
    v_review_id, v_candidate_id, '987654321', 'fixture/codex-policy', 'codex-cli test fixture',
    'outlist-codex-editorial-v2', v_observed_at, repeat('b', 64),
    jsonb_build_object('schema', 'outlist.catalog.codex-evidence.v1', 'candidate_id', v_candidate_id,
      'repository_id', '987654321', 'full_name', 'fixture/codex-policy', 'collected_at', v_observed_at,
      'collector_status', 'partial', 'sources', '[]'::jsonb),
    jsonb_build_object('outcome', 'investigate'),
    '{"accepted_outcome":"investigate","publication_eligible":false,"reasons":["Test fixture"]}'::jsonb,
    'investigate', false
  );
  insert into public.project_publication_revocations (
    project_id, repository_id, review_id, source_observed_at, reason, origin, resulting_revision
  ) values (
    v_project_id, v_repository_id, v_review_id, v_observed_at,
    'Test fixture for an append-only revocation record.', 'codex_automated', 1
  );
  update public.projects set publication_status = 'published', quality_status = 'verified',
    license_status = 'verified_open_source', license_identifier = 'MIT',
    license_verified_at = v_observed_at, last_verified_at = v_observed_at,
    published_at = v_observed_at, editorial_revision = editorial_revision + 1
  where id = v_project_id;
  update public.repositories set source_observed_at = v_observed_at + interval '1 second',
    last_successful_sync_at = v_observed_at + interval '1 second'
  where id = v_repository_id;
  insert into codex_editorial_test_fixture (review_id, project_id, candidate_id)
  values (v_review_id, v_project_id, v_candidate_id);
end;
$fixture$;

select set_config('request.jwt.claim.role', 'anon', true);
set local role anon;
select throws_ok($$select public.authorize_codex_editorial_policy(true, 'outlist-codex-editorial-v2', 'ENABLE OUTLIST CODEX EDITORIAL V2')$$,
  '42501', null, 'Anonymous users cannot authorize autonomous publication');
reset role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok($$select public.authorize_codex_editorial_policy(true, 'outlist-codex-editorial-v2', 'wrong confirmation')$$,
  '42501', null, 'Service role still needs the exact explicit policy confirmation');
select lives_ok($$select public.authorize_codex_editorial_policy(true, 'outlist-codex-editorial-v2', 'ENABLE OUTLIST CODEX EDITORIAL V2')$$,
  'The explicit service-role authorization can enable the policy');
select is(public.codex_editorial_policy_status()->>'enabled', 'true', 'Enabled policy state is observable through a restricted RPC');
select throws_ok($$select public.codex_create_reviewed_draft(
  '00000000-0000-4000-8000-000000000099', '00000000-0000-4000-8000-000000000098', 'codex_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')$$,
  '42501', null, 'Draft restoration rejects any authorization ID other than the explicit current grant');
select lives_ok($$select public.codex_record_editorial_review(
  (public.codex_editorial_policy_status()->>'authorization_id')::uuid,
  'codex_cccccccccccccccccccccccccccccccccccccccc',
  (select candidate_id from codex_editorial_test_fixture), '987654321', 'fixture/codex-policy', 'codex-cli test fixture',
  (select r.source_observed_at from public.repositories r join codex_editorial_test_fixture f on f.project_id = r.project_id),
  repeat('c', 64), null, null, null,
  jsonb_build_object('schema', 'outlist.catalog.codex-evidence.v1',
    'candidate_id', (select candidate_id::text from codex_editorial_test_fixture),
    'repository_id', '987654321', 'full_name', 'fixture/codex-policy',
    'collected_at', (select r.source_observed_at from public.repositories r join codex_editorial_test_fixture f on f.project_id = r.project_id),
    'collector_status', 'partial', 'sources', jsonb_build_array(jsonb_build_object(
      'id', 'repository-metadata', 'kind', 'repository_metadata', 'url', 'https://api.github.com/repositories/987654321',
      'status', 'available', 'metadata', jsonb_build_object('id', '987654321')))),
  jsonb_build_object('reviewer', jsonb_build_object('identity', 'codex-cli', 'policy_version', 'outlist-codex-editorial-v2'),
    'outcome', 'approve', 'confidence', 0.92,
    'eligibility', jsonb_build_object('genuine_software_product', true, 'publicly_accessible', true,
      'meaningfully_open_source', true, 'license_identifier', null, 'security_or_trust_concerns', jsonb_build_array()),
    'listing', jsonb_build_object(),
    'supporting_sources', jsonb_build_array(jsonb_build_object('evidence_id', 'repository-metadata',
      'source_url', 'https://api.github.com/repositories/987654321', 'supports', 'Current repository identity.')),
    'uncertainties', jsonb_build_array('License evidence is incomplete.'),
    'material_blockers', jsonb_build_array('The current license evidence is incomplete.'),
    'informational_uncertainties', jsonb_build_array()),
  jsonb_build_object('accepted_outcome', 'investigate', 'publication_eligible', false,
    'reasons', jsonb_build_array('The deterministic license gate downgraded the model recommendation.'))
)$$, 'A deterministic policy downgrade remains a persistable completed review');
reset role;

select is((select r.decision from public.codex_editorial_reviews r where r.review_id = 'codex_cccccccccccccccccccccccccccccccccccccccc'),
  'investigate', 'The accepted outcome records the policy downgrade');
select is((select r.codex_review->>'outcome' from public.codex_editorial_reviews r where r.review_id = 'codex_cccccccccccccccccccccccccccccccccccccccc'),
  'approve', 'The Codex recommendation remains visible separately from the accepted policy outcome');

select throws_ok($$update private.codex_editorial_authorization_events set event_type = 'disabled' where event_type = 'enabled'$$,
  '42501', 'Codex authorization events are append-only', 'Authorization events cannot be rewritten');
select throws_ok($$update public.codex_editorial_reviews set decision = 'reject'
  where review_id = (select review_id from codex_editorial_test_fixture)$$,
  '42501', 'Codex editorial reviews are append-only', 'Codex review records cannot be rewritten');
select throws_ok($$update public.project_publication_revocations set reason = 'changed'
  where project_id = (select project_id from codex_editorial_test_fixture)$$,
  '42501', 'project publication revocations are append-only', 'Publication revocation records cannot be rewritten');
select ok((select count(*) = 141 from private.codex_approved_license_ids),
  'The pinned SPDX policy includes the known OSI-approved identifiers');
select is((select p.publication_status from public.projects p join codex_editorial_test_fixture f on f.project_id = p.id),
  'pending_review', 'A refreshed authoritative source snapshot automatically holds the published project');
select is((select count(*)::integer from public.project_publication_revocations r
  join codex_editorial_test_fixture f on f.project_id = r.project_id where r.origin = 'system_policy'),
  1, 'The automatic hold records a durable system-policy revocation');
select is((select count(*)::integer from public.editorial_decisions d
  join codex_editorial_test_fixture f on f.project_id = d.project_id
  where d.action = 'system_revoke_publication' and d.reviewer_type = 'system_policy' and d.actor_user_id is null),
  1, 'A system source hold is never recorded as human or Codex attestation');

select * from finish();
rollback;
