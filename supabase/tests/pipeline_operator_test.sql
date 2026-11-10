begin;
select plan(20);

set local "request.jwt.claims" = '{"role":"anon"}';
select throws_ok(
  $$select public.pipeline_operator_report()$$,
  '42501', null,
  'operator inventory and audit RPC is unavailable to anonymous clients'
);
select throws_ok(
  $$select public.pipeline_operator_verify_run(gen_random_uuid())$$,
  '42501', null,
  'run-scoped persisted-row verification is unavailable to anonymous clients'
);
select throws_ok(
  $$select public.pipeline_operator_verify_resume(gen_random_uuid())$$,
  '42501', null,
  'resume lineage verification is unavailable to anonymous clients'
);
select throws_ok(
  $$select public.tag_pipeline_ingestion_job(gen_random_uuid(), gen_random_uuid())$$,
  '42501', null,
  'pipeline job correlation is unavailable to anonymous clients'
);

set local "request.jwt.claims" = '{"role":"authenticated"}';
select throws_ok(
  $$select public.pipeline_operator_report()$$,
  '42501', null,
  'operator inventory and audit RPC is unavailable to signed-in users'
);
select throws_ok(
  $$select public.pipeline_operator_verify_run(gen_random_uuid())$$,
  '42501', null,
  'run-scoped persisted-row verification is unavailable to signed-in users'
);
select throws_ok(
  $$select public.pipeline_operator_verify_resume(gen_random_uuid())$$,
  '42501', null,
  'resume lineage verification is unavailable to signed-in users'
);

set local "request.jwt.claims" = '{"role":"service_role"}';
create temporary table pipeline_audit_fixture(project_id uuid, repository_id uuid, candidate_id uuid, source_record_id uuid);
insert into pipeline_audit_fixture(project_id) values (gen_random_uuid());
insert into public.projects (id, slug, name, summary)
select project_id, 'audit-rename-fixture', 'Audit rename fixture', 'Project created for operator audit regression.'
from pipeline_audit_fixture;
insert into public.repositories (
  project_id, provider, provider_repository_id, full_name, canonical_url,
  owner_login, repository_name, availability_status, is_disabled, is_private,
  visibility, source_observed_at, last_successful_sync_at
)
select project_id, 'github', '98765432101', 'canonical/new-name', 'https://github.com/canonical/new-name',
  'canonical', 'new-name', 'available', false, false, 'public', now(), now()
from pipeline_audit_fixture returning id;
update pipeline_audit_fixture set repository_id = (
  select r.id from public.repositories r where r.project_id = pipeline_audit_fixture.project_id
);
update public.projects p set primary_repository_id = f.repository_id
from pipeline_audit_fixture f where p.id = f.project_id;
insert into public.project_categories (project_id, category_id)
select f.project_id, c.id from pipeline_audit_fixture f
join public.categories c on c.slug = 'developer-tools';
insert into public.source_records (
  provider, record_kind, source_key, source_url, fetched_at, http_status, source_metadata
) values (
  'github', 'discovery_page', 'pipeline-operator-rename-regression',
  'https://api.github.com/search/repositories?q=audit', now(), 200,
  '{"resource_type":"repository_search"}'::jsonb
) returning id;
update pipeline_audit_fixture set source_record_id = (
  select s.id from public.source_records s where s.source_key = 'pipeline-operator-rename-regression'
);
insert into public.repository_candidates (
  provider, provider_repository_id, full_name, canonical_url, source_record_id,
  repository_id, queue_status, review_status
)
select 'github', '98765432101', 'historical/old-name', 'https://github.com/historical/old-name',
  source_record_id, repository_id, 'succeeded', 'unreviewed'
from pipeline_audit_fixture returning id;
update pipeline_audit_fixture set candidate_id = (
  select c.id from public.repository_candidates c where c.provider_repository_id = '98765432101'
);
insert into public.repository_assessments (
  repository_id, policy_version, source_observed_at, status, assessed_at
)
select repository_id, 'm1-04-assessment-v1', now(), 'assessed', now()
from pipeline_audit_fixture;
update public.projects set name = 'Editorially approved fixture', summary = 'Reviewed and published by editorial staff.',
  quality_status = 'verified', license_status = 'verified_open_source', license_identifier = 'MIT',
  license_verified_at = now(), publication_status = 'published'
where id = (select project_id from pipeline_audit_fixture);

create temporary table pipeline_report_before as
select (select count(*) from public.ingestion_jobs) as jobs,
  (select count(*) from public.repository_candidates) as candidates,
  (select count(*) from public.projects) as projects,
  (select count(*) from public.project_logos) as logos;
create temporary table pipeline_report_call as
select public.pipeline_operator_report() as report;
select is((select report->>'report_version' from pipeline_report_call), 'm2-05-v1',
  'service role receives the versioned operational report');
select is((select count(*)::integer from jsonb_array_elements(pipeline_report_call.report->'schema'->'required_rpcs') rpc
  where rpc->>'signature' like 'public.%catalog_import%'
    and (rpc->>'exists')::boolean and (rpc->>'service_role_execute')::boolean), 5,
  'all catalog import checkpoint RPCs exist and remain service-role-only');
select is((select public.pipeline_operator_verify_run(gen_random_uuid())->>'pipeline_run_id' is not null), true,
  'service role can call bounded run-scoped persisted-row inspection');
select is((public.pipeline_operator_verify_resume(gen_random_uuid())->>'resume_mode')::boolean, true,
  'service role can inspect bounded previously committed lineage during resume');
select is(((select report->'schema'->>'ready' from pipeline_report_call)::boolean), true,
  'the clean migration chain and required service RPC permissions pass preflight');
select is(((select report->'categories'->>'ready' from pipeline_report_call)::boolean), true,
  'the complete category taxonomy passes preflight');
select is((select count(*)::integer from public.ingestion_jobs), (select jobs::integer from pipeline_report_before),
  'read-only report does not create ingestion jobs');
select is((select count(*)::integer from public.repository_candidates), (select candidates::integer from pipeline_report_before),
  'read-only report does not change candidates');
select is((select count(*)::integer from public.projects), (select projects::integer from pipeline_report_before),
  'read-only report does not create projects');
select is((select count(*)::integer from public.project_logos), (select logos::integer from pipeline_report_before),
  'read-only report does not create logo candidates');
select is((select coalesce(sum((finding->>'affected_count')::integer), 0)::integer
  from jsonb_array_elements((public.pipeline_operator_report()->'integrity_findings')) finding
  where finding->>'code' = 'candidate_repository_identity_mismatch'), 0,
  'a historical discovery name differing from the current canonical name is not identity corruption');
select is((select count(*)::integer from jsonb_array_elements((public.pipeline_operator_report()->'integrity_findings')) finding
  where finding->>'code' = 'pipeline_project_has_invalid_published_state'), 0,
  'a constraint-valid editorially published assessment project is not reported as corruption');
update public.repository_candidates set provider_repository_id = '98765432102'
where id = (select candidate_id from pipeline_audit_fixture);
select is((select coalesce(sum((finding->>'affected_count')::integer), 0)::integer
  from jsonb_array_elements((public.pipeline_operator_report()->'integrity_findings')) finding
  where finding->>'code' = 'candidate_repository_identity_mismatch'), 1,
  'a genuine stable provider-ID association conflict remains a critical audit finding');
update public.repository_candidates set provider_repository_id = '98765432101'
where id = (select candidate_id from pipeline_audit_fixture);

select * from finish();
rollback;
