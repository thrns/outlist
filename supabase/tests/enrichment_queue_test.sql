begin;
select no_plan();

set local "request.jwt.claims" = '{"role":"service_role"}';

select has_column('public', 'repository_candidates', 'enrichment_status', 'enrichment has independent durable candidate state');
select has_column('public', 'repository_candidates', 'enrichment_lease_token', 'enrichment candidate leases carry fencing tokens');
select has_column('public', 'repositories', 'source_observed_at', 'canonical repositories retain source observation order');
select has_column('public', 'source_records', 'etag', 'source provenance retains ETags');
select has_constraint('public', 'repositories', 'repositories_homepage_url_safe_web', 'canonical homepage values have a database URL constraint');
select ok(private.is_safe_http_url('https://docs.example.test/path?source=github#readme'), 'database URL validation accepts an absolute HTTPS URL');
select ok(private.is_safe_http_url('http://docs.example.test/path'), 'database URL validation accepts an absolute HTTP URL');
select ok(not private.is_safe_http_url('javascript:alert(1)'), 'database URL validation rejects javascript URLs');
select ok(not private.is_safe_http_url('data:text/html,unsafe'), 'database URL validation rejects data URLs');
select ok(not private.is_safe_http_url('https://user:password@example.test/path'), 'database URL validation rejects embedded credentials');
select ok(not private.is_safe_http_url('https://example.test:99999/path'), 'database URL validation rejects malformed ports');
select ok(not private.is_safe_http_url('https://example.test/%zz'), 'database URL validation rejects malformed percent escapes');
select ok(not private.is_safe_http_url('https:///example.test/path'), 'database URL validation rejects a missing authority');
select throws_ok(
  $$insert into public.repositories (provider, provider_repository_id, full_name, canonical_url, homepage_url)
    values ('github', 'pgtap-unsafe-homepage', 'fixture/unsafe-homepage', 'https://github.com/fixture/unsafe-homepage', 'javascript:alert(1)')$$,
  '23514', null, 'a canonical row cannot store a non-web homepage URL'
);
select throws_ok(
  $$insert into public.repositories (provider, provider_repository_id, full_name, canonical_url, is_private, visibility)
    values ('github', 'pgtap-private-repository', 'fixture/private-repository', 'https://github.com/fixture/private-repository', true, 'private')$$,
  '22023', null, 'a direct canonical row insert cannot store private GitHub metadata'
);
select ok(has_function_privilege('service_role', 'public.claim_github_enrichment_candidates(uuid,text,integer,integer)', 'EXECUTE'),
  'service role can claim enrichment candidates');
select ok(not has_function_privilege('anon', 'public.claim_github_enrichment_candidates(uuid,text,integer,integer)', 'EXECUTE'),
  'anonymous clients cannot execute enrichment claims');

insert into public.source_records (provider, record_kind, source_key, source_url, fetched_at, http_status)
values
  ('github', 'discovery_page', 'enrichment-pgtap-eligible-a', 'https://api.github.com/search/repositories?q=enrichment-pgtap', clock_timestamp(), 200),
  ('github', 'discovery_page', 'enrichment-pgtap-eligible-b', 'https://api.github.com/search/repositories?q=enrichment-pgtap', clock_timestamp(), 200),
  ('github', 'discovery_page', 'enrichment-pgtap-rejected', 'https://api.github.com/search/repositories?q=enrichment-pgtap', clock_timestamp(), 200),
  ('github', 'discovery_page', 'enrichment-pgtap-discarded', 'https://api.github.com/search/repositories?q=enrichment-pgtap', clock_timestamp(), 200),
  ('github', 'discovery_page', 'enrichment-pgtap-unsafe-id', 'https://api.github.com/search/repositories?q=enrichment-pgtap', clock_timestamp(), 200);

insert into public.repository_candidates (
  provider, provider_repository_id, full_name, canonical_url, source_record_id,
  queue_status, review_status
)
select 'github', fixture.provider_repository_id, fixture.full_name, 'https://github.com/' || fixture.full_name,
  source.id, fixture.queue_status, fixture.review_status
from (values
  ('99110001', 'fixture/eligible-a', 'queued', 'unreviewed', 'enrichment-pgtap-eligible-a'),
  ('99110002', 'fixture/eligible-b', 'queued', 'unreviewed', 'enrichment-pgtap-eligible-b'),
  ('99110003', 'fixture/rejected', 'queued', 'rejected', 'enrichment-pgtap-rejected'),
  ('99110004', 'fixture/discarded', 'discarded', 'unreviewed', 'enrichment-pgtap-discarded'),
  ('9007199254740992', 'fixture/unsafe-id', 'queued', 'unreviewed', 'enrichment-pgtap-unsafe-id')
) as fixture(provider_repository_id, full_name, queue_status, review_status, source_key)
join public.source_records source on source.source_key = fixture.source_key;

create temporary table enrichment_job_a (job_id uuid);
insert into enrichment_job_a
select public.start_github_enrichment_job(false, '{"fixture":"pgTAP"}'::jsonb);
create temporary table enrichment_claim_a as
select * from public.claim_github_enrichment_candidates((select job_id from enrichment_job_a), 'enrichment-pgtap-worker-a', 1, 60);
create temporary table enrichment_claim_b as
select * from public.claim_github_enrichment_candidates((select job_id from enrichment_job_a), 'enrichment-pgtap-worker-b', 1, 60);
select is((select count(*)::integer from enrichment_claim_a), 1, 'first worker atomically claims one eligible candidate');
select is((select count(*)::integer from enrichment_claim_b), 1, 'second worker claims another candidate');
select isnt((select candidate_id::text from enrichment_claim_a), (select candidate_id::text from enrichment_claim_b),
  'two workers cannot claim the same candidate');
select is((select enrichment_status from public.repository_candidates where id = (select candidate_id from enrichment_claim_a)),
  'processing', 'claim is durably recorded as processing');
select ok((select lease_expires_at > clock_timestamp() from enrichment_claim_a), 'claim lease expires in the future');
select is((select count(*)::integer from public.repository_candidates where enrichment_status = 'processing'), 2,
  'both independent candidates have active leases');
select is((select count(*)::integer from public.projects where slug like 'fixture-%'), 0,
  'candidate claiming does not create project listings');
select is((select enrichment_status from public.repository_candidates where provider_repository_id = '9007199254740992'),
  'queued', 'GitHub numeric IDs outside the lossless JavaScript range are never claimed');

update public.repository_candidates set enrichment_lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select candidate_id from enrichment_claim_a);
create temporary table enrichment_job_b (job_id uuid);
insert into enrichment_job_b
select public.start_github_enrichment_job(false, '{"fixture":"lease-recovery"}'::jsonb);
create temporary table enrichment_claim_recovered as
select * from public.claim_github_enrichment_candidates((select job_id from enrichment_job_b), 'enrichment-pgtap-worker-c', 1, 60);
select is((select candidate_id::text from enrichment_claim_recovered), (select candidate_id::text from enrichment_claim_a),
  'expired lease is automatically recovered');
select isnt((select lease_token::text from enrichment_claim_recovered), (select lease_token::text from enrichment_claim_a),
  'lease recovery issues a new fencing token');
select throws_ok(
  $$select public.commit_github_repository_enrichment(
    (select candidate_id from enrichment_claim_a), 'enrichment-pgtap-worker-a',
    (select lease_token from enrichment_claim_a), '{}'::jsonb
  )$$,
  '40001', null, 'expired worker cannot commit even a malformed result'
);

select public.fail_github_repository_enrichment(
  (select candidate_id from enrichment_claim_recovered),
  'enrichment-pgtap-worker-c', (select lease_token from enrichment_claim_recovered),
  'rate_limit; HTTP 403; retry after 120s', true, 120000, null
);
select is((select enrichment_status from public.repository_candidates where id = (select candidate_id from enrichment_claim_a)),
  'retry_wait', 'retryable source failure enters durable retry wait');
select ok((select enrichment_next_attempt_at > clock_timestamp() from public.repository_candidates where id = (select candidate_id from enrichment_claim_a)),
  'retry-after time is stored for the next attempt');

select is((select enrichment_status from public.repository_candidates where provider_repository_id = '99110003'),
  'queued', 'editorially rejected candidates are never claimed or reactivated');
select is((select queue_status from public.repository_candidates where provider_repository_id = '99110004'),
  'discarded', 'discarded candidates remain discarded');
select is((select enrichment_status from public.repository_candidates where provider_repository_id in ('99110003', '99110004') order by provider_repository_id limit 1),
  'queued', 'rejected/discarded candidates remain outside enrichment processing');

set local role anon;
set local "request.jwt.claims" = '{"role":"anon"}';
select throws_ok($$select count(*) from public.repository_candidates$$, '42501', null,
  'public clients cannot read private enrichment candidate state');
select throws_ok(
  $$select public.claim_github_enrichment_candidates('00000000-0000-4000-8000-000000000001', 'anonymous', 1, 60)$$,
  '42501', null, 'public clients cannot call the enrichment mutation RPC'
);

reset role;
select * from finish();
rollback;
