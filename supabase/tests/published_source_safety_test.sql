begin;
select no_plan();

select has_table('public', 'project_safety_events', 'system-origin safety event table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.project_safety_events'::regclass),
  'system-origin safety events have RLS enabled');
select ok(not has_table_privilege('anon', 'public.project_safety_events', 'SELECT,INSERT,UPDATE,DELETE'),
  'anonymous clients cannot read or mutate safety events');
select ok(not has_table_privilege('authenticated', 'public.project_safety_events', 'SELECT,INSERT,UPDATE,DELETE'),
  'authenticated clients cannot read or mutate safety events');
select ok(has_table_privilege('service_role', 'public.project_safety_events', 'SELECT')
  and not has_table_privilege('service_role', 'public.project_safety_events', 'INSERT,UPDATE,DELETE'),
  'service role can inspect but cannot forge or mutate safety events');
select ok(not exists (
  select 1 from pg_indexes where schemaname = 'public'
    and indexname = 'editorial_decisions_one_publish_per_project_idx'
), 'a project can accumulate a new explicit publication decision after safety demotion');

insert into public.categories (id, slug, name) values
  ('00000000-0000-4000-8000-000000000301', 'safety-fixture-category', 'Safety fixture');
insert into public.projects (
  id, slug, name, summary, license_status, license_identifier, license_verified_at,
  quality_status, publication_status, last_verified_at
) values
  ('00000000-0000-4000-8000-000000000101', 'safety-fixture', 'Safety fixture',
    'A published fixture with a verified repository.', 'verified_open_source', 'MIT', clock_timestamp(),
    'verified', 'pending_review', clock_timestamp()),
  ('00000000-0000-4000-8000-000000000103', 'safety-unrelated-fixture', 'Unrelated published fixture',
    'A separate published fixture with another primary repository.', 'verified_open_source', 'MIT', clock_timestamp(),
    'verified', 'pending_review', clock_timestamp());
insert into public.repositories (
  id, project_id, provider, provider_repository_id, full_name, canonical_url,
  owner_login, repository_name, availability_status, is_private, visibility,
  is_disabled, provider_node_id, source_observed_at, last_successful_sync_at,
  source_field_states, stars, forks, description
) values
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000101',
    'github', '99101001', 'fixture/safety-primary', 'https://github.com/fixture/safety-primary',
    'fixture', 'safety-primary', 'available', false, 'public', false, 'R_safety_primary',
    clock_timestamp(), clock_timestamp(), '{"visibility":"present","license":"present"}', 43, 7, 'Historical public metadata.'),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000103',
    'github', '99101002', 'fixture/unrelated-primary', 'https://github.com/fixture/unrelated-primary',
    'fixture', 'unrelated-primary', 'available', false, 'public', false, 'R_unrelated_primary',
    clock_timestamp(), clock_timestamp(), '{"visibility":"present","license":"present"}', 8, 2, 'Unrelated primary metadata.'),
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000103',
    'github', '99101003', 'fixture/unrelated-secondary', 'https://github.com/fixture/unrelated-secondary',
    'fixture', 'unrelated-secondary', 'available', false, 'public', false, 'R_unrelated_secondary',
    clock_timestamp(), clock_timestamp(), '{"visibility":"present","license":"present"}', 3, 1, 'Secondary repository metadata.');
update public.projects set primary_repository_id = '00000000-0000-4000-8000-000000000102'
where id = '00000000-0000-4000-8000-000000000101';
update public.projects set primary_repository_id = '00000000-0000-4000-8000-000000000104'
where id = '00000000-0000-4000-8000-000000000103';
insert into public.project_categories (project_id, category_id) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000301'),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000301');
update public.projects set publication_status = 'published', published_at = clock_timestamp()
where id in ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000103');

set local "request.jwt.claims" = '{"role":"service_role"}';

-- A stale claim and an ambiguous 404 must not demote a published project.
with source_row as (
  insert into public.source_records (provider, record_kind, source_key, source_url, fetched_at, http_status)
  values ('github', 'discovery_page', 'safety-pgtap-stale',
    'https://api.github.com/search/repositories?q=safety-pgtap', clock_timestamp(), 200)
  returning id
)
insert into public.repository_candidates (
  id, provider, provider_repository_id, full_name, canonical_url, source_record_id,
  repository_id, queue_status, review_status
)
select '00000000-0000-4000-8000-000000000201', 'github', '99101001',
  'fixture/safety-primary', 'https://github.com/fixture/safety-primary', source_row.id,
  '00000000-0000-4000-8000-000000000102', 'queued', 'unreviewed'
from source_row;
create temporary table safety_job_a (id uuid);
insert into safety_job_a select public.start_github_enrichment_job(false, '{"fixture":"published-safety"}');
create temporary table safety_claim_a as
select * from public.claim_github_enrichment_candidates((select id from safety_job_a), 'safety-stale-worker', 1, 60);
update public.repository_candidates set enrichment_lease_expires_at = clock_timestamp() - interval '1 second'
where id = '00000000-0000-4000-8000-000000000201';
select throws_ok($$select public.fail_github_repository_enrichment(
  '00000000-0000-4000-8000-000000000201', 'safety-stale-worker',
  (select lease_token from safety_claim_a), 'source_access_restricted', false, null,
  jsonb_build_object('source_url', 'https://api.github.com/repositories/99101001',
    'fetched_at', clock_timestamp(), 'http_status', 200, 'error_kind', 'visibility_restricted',
    'outcome', 'access_restricted', 'visibility_signal', 'private_flag'))$$,
  '40001', null, 'expired claim cannot apply a confirmed restriction');
select is((select publication_status from public.projects where id = '00000000-0000-4000-8000-000000000101'),
  'published', 'stale restriction leaves publication unchanged');
select is((select availability_status from public.repositories where id = '00000000-0000-4000-8000-000000000102'),
  'available', 'stale restriction leaves repository availability unchanged');

create temporary table safety_job_b (id uuid);
insert into safety_job_b select public.start_github_enrichment_job(false, '{"fixture":"stale-recovery"}');
create temporary table safety_claim_b as
select * from public.claim_github_enrichment_candidates((select id from safety_job_b), 'safety-404-worker', 1, 60);
select is((select candidate_id::text from safety_claim_b), '00000000-0000-4000-8000-000000000201',
  'expired safety claim is recovered with a new fence');
select is(public.fail_github_repository_enrichment(
  '00000000-0000-4000-8000-000000000201', 'safety-404-worker',
  (select lease_token from safety_claim_b), 'repository_unavailable', false, null,
  jsonb_build_object('source_url', 'https://api.github.com/repositories/99101001',
    'fetched_at', clock_timestamp(), 'http_status', 404, 'error_kind', 'not_found')
)->>'status', 'failed', 'ambiguous 404 is recorded as an ordinary terminal source failure');
select is((select publication_status from public.projects where id = '00000000-0000-4000-8000-000000000101'),
  'published', 'ambiguous 404 does not demote a published project');
select is((select availability_status from public.repositories where id = '00000000-0000-4000-8000-000000000102'),
  'available', 'ambiguous 404 does not restrict a repository');

-- Rate limits remain retryable and cannot enter the access-restriction path.
update public.repository_candidates set enrichment_status = 'queued',
  enrichment_completed_at = null, enrichment_error = null, enrichment_next_attempt_at = null
where id = '00000000-0000-4000-8000-000000000201';
create temporary table safety_job_c (id uuid);
insert into safety_job_c select public.start_github_enrichment_job(false, '{"fixture":"rate-limit"}');
create temporary table safety_claim_c as
select * from public.claim_github_enrichment_candidates((select id from safety_job_c), 'safety-rate-worker', 1, 60);
select is(public.fail_github_repository_enrichment(
  '00000000-0000-4000-8000-000000000201', 'safety-rate-worker',
  (select lease_token from safety_claim_c), 'rate_limit', true, 60000,
  jsonb_build_object('source_url', 'https://api.github.com/repositories/99101001',
    'fetched_at', clock_timestamp(), 'http_status', 403, 'error_kind', 'rate_limit')
)->>'status', 'retry_wait', 'rate limit remains retryable');
select is((select publication_status from public.projects where id = '00000000-0000-4000-8000-000000000101'),
  'published', 'rate limit does not demote a published project');

-- A validated restriction first exercises rollback after the project update,
-- system audit insert, and review item insert have all happened.
update public.repository_candidates set enrichment_status = 'queued',
  enrichment_completed_at = null, enrichment_error = null, enrichment_next_attempt_at = null
where id = '00000000-0000-4000-8000-000000000201';
create temporary table safety_job_d (id uuid);
insert into safety_job_d select public.start_github_enrichment_job(false, '{"fixture":"rollback"}');
create temporary table safety_claim_d as
select * from public.claim_github_enrichment_candidates((select id from safety_job_d), 'safety-restriction-worker', 1, 60);

create function public.zz_test_force_source_restriction_rollback()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if new.provider_repository_id = '99101001' and new.availability_status = 'access_restricted' then
    raise exception 'forced safety transition rollback' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
create trigger zz_test_force_source_restriction_rollback
  before update of availability_status on public.repositories
  for each row execute function public.zz_test_force_source_restriction_rollback();

select throws_ok($$select public.fail_github_repository_enrichment(
  '00000000-0000-4000-8000-000000000201', 'safety-restriction-worker',
  (select lease_token from safety_claim_d), 'source_access_restricted', false, null,
  jsonb_build_object('source_url', 'https://api.github.com/repositories/99101001',
    'fetched_at', clock_timestamp(), 'http_status', 200, 'error_kind', 'visibility_restricted',
    'outcome', 'access_restricted', 'visibility_signal', 'private_flag'))$$,
  'P0001', 'forced safety transition rollback', 'a failed repository write rolls back every safety change');
select is((select publication_status from public.projects where id = '00000000-0000-4000-8000-000000000101'),
  'published', 'rollback restores published visibility state');
select is((select availability_status from public.repositories where id = '00000000-0000-4000-8000-000000000102'),
  'available', 'rollback restores canonical repository availability');
select is((select count(*)::integer from public.project_safety_events where project_id = '00000000-0000-4000-8000-000000000101'),
  0, 'rollback removes the attempted system event');
select is((select count(*)::integer from public.review_queue where repository_id = '00000000-0000-4000-8000-000000000102'
    and reason = 'GitHub repository access is restricted; review current public source evidence before republishing.'),
  0, 'rollback removes the attempted safety review item');
select is((select enrichment_status from public.repository_candidates where id = '00000000-0000-4000-8000-000000000201'),
  'processing', 'rollback leaves the original fenced claim available for a safe retry');

drop trigger zz_test_force_source_restriction_rollback on public.repositories;
drop function public.zz_test_force_source_restriction_rollback();
select is(public.fail_github_repository_enrichment(
  '00000000-0000-4000-8000-000000000201', 'safety-restriction-worker',
  (select lease_token from safety_claim_d), 'source_access_restricted', false, null,
  jsonb_build_object('source_url', 'https://api.github.com/repositories/99101001',
    'fetched_at', clock_timestamp(), 'http_status', 200, 'error_kind', 'visibility_restricted',
    'outcome', 'access_restricted', 'visibility_signal', 'private_flag')
)->>'status', 'failed', 'a live validated restriction completes after rollback injection is removed');
select is((select publication_status from public.projects where id = '00000000-0000-4000-8000-000000000101'),
  'pending_review', 'confirmed restriction atomically demotes the published project');
select is((select editorial_revision from public.projects where id = '00000000-0000-4000-8000-000000000101'),
  1::bigint, 'demotion advances editorial revision to fence stale forms');
select is((select availability_status from public.repositories where id = '00000000-0000-4000-8000-000000000102'),
  'access_restricted', 'confirmed restriction records canonical repository availability');
select is((select count(*)::integer from public.project_safety_events where project_id = '00000000-0000-4000-8000-000000000101'),
  1, 'published project demotion has one durable system-origin event');
select is((select origin from public.project_safety_events where project_id = '00000000-0000-4000-8000-000000000101'),
  'system', 'safety event is system-origin and does not impersonate an administrator');
select is((select count(*)::integer from public.review_queue where repository_id = '00000000-0000-4000-8000-000000000102'
    and reason = 'GitHub repository access is restricted; review current public source evidence before republishing.'
    and status = 'open'), 1, 'demotion creates one blocking repository review item');
select is((select provider_repository_id from public.repositories where id = '00000000-0000-4000-8000-000000000102'),
  '99101001', 'demotion preserves stable repository identity');
select is((select project_id::text from public.repositories where id = '00000000-0000-4000-8000-000000000102'),
  '00000000-0000-4000-8000-000000000101', 'demotion preserves repository association');
select is((select stars from public.repositories where id = '00000000-0000-4000-8000-000000000102'),
  43::bigint, 'demotion preserves historical public metadata');
select is((select license_status from public.projects where id = '00000000-0000-4000-8000-000000000101'),
  'verified_open_source', 'demotion preserves editorial licensing evidence');

-- A later public observation may restore availability. Even if the candidate
-- is discarded after claim, a repeated confirmed restriction remains durable
-- and reuses the existing safety event and review item.
update public.repositories set availability_status = 'available'
where id = '00000000-0000-4000-8000-000000000102';
update public.repository_candidates set enrichment_status = 'queued',
  enrichment_completed_at = null, enrichment_error = null, enrichment_next_attempt_at = null
where id = '00000000-0000-4000-8000-000000000201';
create temporary table safety_job_e (id uuid);
insert into safety_job_e select public.start_github_enrichment_job(false, '{"fixture":"duplicate"}');
create temporary table safety_claim_e as
select * from public.claim_github_enrichment_candidates((select id from safety_job_e), 'safety-duplicate-worker', 1, 60);
update public.repository_candidates set queue_status = 'discarded'
where id = '00000000-0000-4000-8000-000000000201';
select is(public.fail_github_repository_enrichment(
  '00000000-0000-4000-8000-000000000201', 'safety-duplicate-worker',
  (select lease_token from safety_claim_e), 'source_access_restricted', false, null,
  jsonb_build_object('source_url', 'https://api.github.com/repositories/99101001',
    'fetched_at', clock_timestamp(), 'http_status', 200, 'error_kind', 'visibility_restricted',
    'outcome', 'access_restricted', 'visibility_signal', 'private_flag')
)->>'status', 'skipped', 'confirmed restriction commits after candidate eligibility changes');
select is((select availability_status from public.repositories where id = '00000000-0000-4000-8000-000000000102'),
  'access_restricted', 'confirmed restriction remains canonical when the legacy writer skips an ineligible candidate');
select is((select count(*)::integer from public.project_safety_events where project_id = '00000000-0000-4000-8000-000000000101'),
  1, 'repeated restriction does not duplicate the system safety event');
select is((select count(*)::integer from public.review_queue where repository_id = '00000000-0000-4000-8000-000000000102'
    and reason = 'GitHub repository access is restricted; review current public source evidence before republishing.'
    and status in ('open', 'in_review')), 1, 'repeated restriction does not duplicate its blocking review item');

-- A restricted non-primary repository cannot demote a different primary.
with source_row as (
  insert into public.source_records (provider, record_kind, source_key, source_url, fetched_at, http_status)
  values ('github', 'discovery_page', 'safety-pgtap-unrelated',
    'https://api.github.com/search/repositories?q=safety-pgtap', clock_timestamp(), 200)
  returning id
)
insert into public.repository_candidates (
  id, provider, provider_repository_id, full_name, canonical_url, source_record_id,
  repository_id, queue_status, review_status
)
select '00000000-0000-4000-8000-000000000205', 'github', '99101003',
  'fixture/unrelated-secondary', 'https://github.com/fixture/unrelated-secondary', source_row.id,
  '00000000-0000-4000-8000-000000000105', 'queued', 'unreviewed'
from source_row;
create temporary table safety_job_f (id uuid);
insert into safety_job_f select public.start_github_enrichment_job(false, '{"fixture":"unrelated"}');
create temporary table safety_claim_f as
select * from public.claim_github_enrichment_candidates((select id from safety_job_f), 'safety-unrelated-worker', 1, 60);
select is(public.fail_github_repository_enrichment(
  '00000000-0000-4000-8000-000000000205', 'safety-unrelated-worker',
  (select lease_token from safety_claim_f), 'source_access_restricted', false, null,
  jsonb_build_object('source_url', 'https://api.github.com/repositories/99101003',
    'fetched_at', clock_timestamp(), 'http_status', 200, 'error_kind', 'visibility_restricted',
    'outcome', 'access_restricted', 'visibility_signal', 'non_public_visibility')
)->>'status', 'failed', 'restriction on a non-primary repository is recorded');
select is((select publication_status from public.projects where id = '00000000-0000-4000-8000-000000000103'),
  'published', 'unrelated published project remains published');
select is((select availability_status from public.repositories where id = '00000000-0000-4000-8000-000000000105'),
  'access_restricted', 'non-primary canonical repository still records its restriction');

select throws_ok($$update public.repositories set availability_status = 'access_restricted'
  where id = '00000000-0000-4000-8000-000000000104'$$,
  '23514', null, 'unrelated service-role writes cannot bypass the published primary-repository guard');
select is((select availability_status from public.repositories where id = '00000000-0000-4000-8000-000000000104'),
  'available', 'published primary repository remains available after a rejected direct update');

set local role anon;
set local "request.jwt.claims" = '{"role":"anon"}';
select is((select count(*)::integer from public.projects where id = '00000000-0000-4000-8000-000000000101'),
  0, 'anonymous RLS immediately hides the safety-demoted project');
select is((select count(*)::integer from public.repositories where id = '00000000-0000-4000-8000-000000000102'),
  0, 'anonymous RLS immediately hides the restricted primary repository');
select is((select count(*)::integer from public.projects where id = '00000000-0000-4000-8000-000000000103'),
  1, 'anonymous RLS retains visibility of an unrelated published project');
select is((select count(*)::integer from public.repositories where id = '00000000-0000-4000-8000-000000000104'),
  1, 'anonymous RLS retains the unrelated available primary repository');
reset role;

select throws_ok($$update public.project_safety_events set provider_repository_id = '99101009'
  where project_id = '00000000-0000-4000-8000-000000000101'$$,
  '42501', 'project safety events are append-only', 'system safety audit rows cannot be changed');

select * from finish();
rollback;
