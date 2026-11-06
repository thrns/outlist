begin;
select no_plan();

set local "request.jwt.claims" = '{"role":"service_role"}';

select has_table('public', 'repository_assessments', 'private repository assessment queue exists');
select has_table('public', 'repository_assessment_sources', 'assessment source references are normalized and foreign keyed');
select has_column('public', 'review_queue', 'assessment_id', 'editorial review items can refer to assessment evidence');
select ok(has_function_privilege('service_role', 'public.claim_github_repository_assessments(uuid,text,integer,integer)', 'EXECUTE'), 'service role can claim assessments');
select ok(not has_function_privilege('anon', 'public.claim_github_repository_assessments(uuid,text,integer,integer)', 'EXECUTE'), 'anonymous clients cannot claim assessments');
select ok(not has_function_privilege('authenticated', 'public.complete_github_repository_assessment(uuid,text,uuid,jsonb,uuid[])', 'EXECUTE'), 'ordinary authenticated clients cannot complete assessments');

insert into public.source_records (provider, record_kind, source_key, source_url, fetched_at, http_status, source_metadata)
values ('github', 'discovery_page', 'assessment-pgtap-candidate', 'https://api.github.com/search/repositories?q=assessment', clock_timestamp(), 200, '{"fixture":true}');

insert into public.repositories (
  id, provider, provider_repository_id, provider_node_id, owner_login, repository_name,
  full_name, canonical_url, description, stars, forks, is_archived, is_fork, is_disabled,
  is_private, visibility, availability_status, source_field_states,
  source_observed_at, last_successful_sync_at, provider_created_at, provider_updated_at
) values (
  '71000000-0000-4000-8000-000000000001', 'github', '81100001', 'R_assessment_fixture',
  'assessment-fixture', 'assessment-fixture', 'assessment-fixture/assessment-fixture',
  'https://github.com/assessment-fixture/assessment-fixture', 'A developer tool fixture.',
  1, 0, false, false, false, false, 'public', 'available',
  '{"visibility":"present","license":"present","description":"present"}',
  clock_timestamp(), clock_timestamp(), clock_timestamp() - interval '2 days', clock_timestamp()
);

insert into public.repository_candidates (
  provider, provider_repository_id, full_name, canonical_url, source_record_id,
  repository_id, queue_status, enrichment_status, enrichment_completed_at, review_status,
  owner_login, description, stars, forks, provider_created_at, provider_updated_at,
  topics, source_license_summary
)
select 'github', '81100001', 'assessment-fixture/assessment-fixture',
  'https://github.com/assessment-fixture/assessment-fixture', s.id,
  '71000000-0000-4000-8000-000000000001', 'queued', 'succeeded', clock_timestamp(), 'unreviewed',
  'assessment-fixture', 'A developer tool fixture.', 1, 0, clock_timestamp() - interval '2 days', clock_timestamp(),
  array['developer-tools'], '{"spdx_id":"MIT"}'::jsonb
from public.source_records s where s.source_key = 'assessment-pgtap-candidate';

insert into public.source_records (provider, record_kind, source_key, source_url, fetched_at, http_status, repository_id, candidate_id, source_metadata)
select 'github', fixture.record_kind, 'assessment-pgtap-' || fixture.record_kind,
  'https://api.github.com/repositories/81100001',
  case when fixture.record_kind = 'repository' then r.source_observed_at else r.source_observed_at + interval '1 second' end, 200,
  '71000000-0000-4000-8000-000000000001', c.id,
  case when fixture.record_kind = 'repository' then '{"validated":true,"resource_kind":"repository"}'::jsonb
    else jsonb_build_object('validated', true, 'resource_kind', fixture.record_kind) end
from (values ('repository'), ('languages'), ('topics'), ('releases')) as fixture(record_kind)
join public.repository_candidates c on c.provider_repository_id = '81100001'
join public.repositories r on r.id = c.repository_id;

insert into public.repository_topics (repository_id, source_topic, source_record_id)
select '71000000-0000-4000-8000-000000000001', 'developer-tools', s.id
from public.source_records s where s.source_key = 'assessment-pgtap-topics';
insert into public.repository_languages (repository_id, language_name, bytes, measured_at, source_record_id)
select '71000000-0000-4000-8000-000000000001', 'TypeScript', 100, clock_timestamp(), s.id
from public.source_records s where s.source_key = 'assessment-pgtap-languages';

create temporary table assessment_job as
select public.start_github_repository_assessment_job(false, '{"fixture":"pgTAP"}'::jsonb) as id;
create temporary table assessment_claim as
select * from public.claim_github_repository_assessments((select id from assessment_job), 'assessment-pgtap-worker', 1, 60);
select is((select count(*)::integer from assessment_claim), 1, 'eligible, successful, public enrichment is claimed');
select is((select status from public.repository_assessments where repository_id = '71000000-0000-4000-8000-000000000001'), 'processing', 'assessment claim is durable');
select ok((select lease_expires_at > clock_timestamp() from assessment_claim), 'assessment lease is active');

create function private.assessment_test_fail_category_insert()
returns trigger language plpgsql set search_path = '' as $function$
begin raise exception using errcode = '23514', message = 'assessment rollback fixture'; end;
$function$;
create trigger assessment_test_fail_category_insert
before insert on public.project_categories for each row execute function private.assessment_test_fail_category_insert();

select throws_ok($$select public.complete_github_repository_assessment(
  (select assessment_id from assessment_claim), 'assessment-pgtap-worker',
  (select lease_token from assessment_claim),
  jsonb_build_object(
    'policyVersion','m1-04-assessment-v1','assessmentTimestamp',clock_timestamp(),
    'classification',jsonb_build_object('policyVersion','outlist-category-rules-v1','status','classified',
      'primaryCategoryId',(select id from public.categories where slug='developer-tools'),
      'suggestions',jsonb_build_array(jsonb_build_object('categoryId',(select id from public.categories where slug='developer-tools'),
        'categorySlug','developer-tools','categoryName','Developer Tools','score',5,'confidence','high','evidence',jsonb_build_array(jsonb_build_object('source','topic','value','developer-tools'))))),
    'license',jsonb_build_object('policyVersion','outlist-license-evidence-v1','spdxListVersion','3.29.0','status','recognized_osi_approved','identifier','MIT','projectLicenseStatus','unverified'),
    'quality',jsonb_build_object('policyVersion','outlist-source-quality-v1','status','eligible_for_review','qualityStatus','unreviewed'),
    'sourceFreshness',jsonb_build_object('repositoryObservedAt',(select source_observed_at from public.repositories where id='71000000-0000-4000-8000-000000000001'))
  ),
  (select array_agg(id order by record_kind) from public.source_records where repository_id='71000000-0000-4000-8000-000000000001' and http_status=200)
)$$, '23514', 'assessment rollback fixture', 'failure after draft writes rolls back the full assessment transaction');
drop trigger assessment_test_fail_category_insert on public.project_categories;
drop function private.assessment_test_fail_category_insert();
select is((select count(*)::integer from public.projects where slug='github-81100001'), 0, 'rollback leaves no partial project');
select is((select project_id from public.repositories where id='71000000-0000-4000-8000-000000000001'), null, 'rollback leaves repository unassociated');
select is((select count(*)::integer from public.repository_assessment_sources where assessment_id=(select assessment_id from assessment_claim)), 0, 'rollback leaves no partial evidence references');

select is((public.complete_github_repository_assessment(
  (select assessment_id from assessment_claim), 'assessment-pgtap-worker',
  (select lease_token from assessment_claim),
  jsonb_build_object(
    'policyVersion','m1-04-assessment-v1','assessmentTimestamp',clock_timestamp(),
    'classification',jsonb_build_object('policyVersion','outlist-category-rules-v1','status','classified',
      'primaryCategoryId',(select id from public.categories where slug='developer-tools'),
      'suggestions',jsonb_build_array(jsonb_build_object('categoryId',(select id from public.categories where slug='developer-tools'),
        'categorySlug','developer-tools','categoryName','Developer Tools','score',5,'confidence','high','evidence',jsonb_build_array(jsonb_build_object('source','topic','value','developer-tools'))))),
    'license',jsonb_build_object('policyVersion','outlist-license-evidence-v1','spdxListVersion','3.29.0','status','recognized_osi_approved','identifier','MIT','projectLicenseStatus','unverified'),
    'quality',jsonb_build_object('policyVersion','outlist-source-quality-v1','status','eligible_for_review','qualityStatus','unreviewed'),
    'sourceFreshness',jsonb_build_object('repositoryObservedAt',(select source_observed_at from public.repositories where id='71000000-0000-4000-8000-000000000001'))
  ),
  (select array_agg(id order by record_kind) from public.source_records where repository_id='71000000-0000-4000-8000-000000000001' and http_status=200)
)->>'status'), 'assessed', 'valid assessment creates one pending-review draft atomically');
select is((select publication_status from public.projects where slug='github-81100001'), 'pending_review', 'assessment cannot publish a project');
select is((select quality_status from public.projects where slug='github-81100001'), 'unreviewed', 'assessment cannot verify project quality');
select is((select license_status from public.projects where slug='github-81100001'), 'unverified', 'GitHub license evidence remains unverified');
select is((select license_verified_at from public.projects where slug='github-81100001'), null, 'assessment never populates license verification time');
select is((select published_at from public.projects where slug='github-81100001'), null, 'assessment leaves publication time null');
select is((select count(*)::integer from public.project_categories pc join public.projects p on p.id=pc.project_id where p.slug='github-81100001'), 1, 'supported category is attached to the draft');
select is((select count(*)::integer from public.review_queue q join public.projects p on p.id=q.project_id where p.slug='github-81100001' and q.status='open'), 1, 'draft has an editorial review item');
select is((select count(*)::integer from public.repository_assessment_sources where assessment_id=(select assessment_id from assessment_claim)), 4, 'all source observations are linked to the assessment');
select is((select count(*)::integer from public.repositories r join public.projects p on p.id=r.project_id where p.primary_repository_id=r.id), 1, 'the repository and primary repository share the same project');

set local role anon;
set local "request.jwt.claims" = '{"role":"anon"}';
select throws_ok($$select count(*) from public.repository_assessments$$, '42501', null, 'anonymous clients cannot read private assessment results');
select throws_ok($$select count(*) from public.repository_assessment_sources$$, '42501', null, 'anonymous clients cannot read private assessment provenance');
select throws_ok($$select public.start_github_repository_assessment_job(false, '{}'::jsonb)$$, '42501', null, 'anonymous clients cannot start assessments');

reset role;
select * from finish();
rollback;
