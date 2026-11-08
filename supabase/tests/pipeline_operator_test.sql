begin;
select plan(13);

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

set local "request.jwt.claims" = '{"role":"service_role"}';
create temporary table pipeline_report_before as
select (select count(*) from public.ingestion_jobs) as jobs,
  (select count(*) from public.repository_candidates) as candidates,
  (select count(*) from public.projects) as projects,
  (select count(*) from public.project_logos) as logos;
create temporary table pipeline_report_call as
select public.pipeline_operator_report() as report;
select is((select report->>'report_version' from pipeline_report_call), 'm1-06-v1',
  'service role receives the versioned operational report');
select is((select public.pipeline_operator_verify_run(gen_random_uuid())->>'pipeline_run_id' is not null), true,
  'service role can call bounded run-scoped persisted-row inspection');
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

select * from finish();
rollback;
