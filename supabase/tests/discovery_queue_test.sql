begin;
select no_plan();

set local "request.jwt.claims" = '{"role":"service_role"}';

create temporary table discovery_test_job (job_id uuid);
insert into discovery_test_job
select public.start_discovery_job(
  'pg-test', 'pg-test-v1',
  jsonb_build_array(
    jsonb_build_object('partition_key', 'pg-test-a', 'provider', 'github', 'query_text', 'topic:outlist-test-a is:public',
      'query_fingerprint', 'pg-test-fp-a', 'query_parameters', '{"sort":"stars","order":"desc","per_page":1}'::jsonb,
      'date_range', '{}'::jsonb, 'intended_coverage', 'transaction fixture A'),
    jsonb_build_object('partition_key', 'pg-test-b', 'provider', 'github', 'query_text', 'topic:outlist-test-b is:public',
      'query_fingerprint', 'pg-test-fp-b', 'query_parameters', '{"sort":"stars","order":"desc","per_page":1}'::jsonb,
      'date_range', '{}'::jsonb, 'intended_coverage', 'transaction fixture B'),
    jsonb_build_object('partition_key', 'pg-test-c', 'provider', 'github', 'query_text', 'topic:outlist-test-c is:public',
      'query_fingerprint', 'pg-test-fp-c', 'query_parameters', '{"sort":"stars","order":"desc","per_page":100}'::jsonb,
      'date_range', '{}'::jsonb, 'intended_coverage', 'saturation fixture')
  )
);

create temporary table discovery_claim_a as
select * from public.claim_discovery_partitions((select job_id from discovery_test_job), 'pg-test-worker-a', 1, 180);
create temporary table discovery_claim_b as
select * from public.claim_discovery_partitions((select job_id from discovery_test_job), 'pg-test-worker-b', 1, 180);
select is((select count(*)::integer from discovery_claim_a), 1, 'first worker claims one partition');
select is((select count(*)::integer from discovery_claim_b), 1, 'second worker claims a different available partition');
select isnt((select id::text from discovery_claim_a), (select id::text from discovery_claim_b), 'two workers cannot own the same partition');

select throws_ok(
  $$select public.commit_discovery_page(
    (select id from discovery_claim_a), 'pg-test-worker-a', (select lease_token from discovery_claim_a),
    'pg-test-fp-a', 1, clock_timestamp(),
    'https://api.github.com/search/repositories?q=topic%3Aoutlist-test-a%20is%3Apublic&per_page=1&page=1',
    200, '{}'::jsonb, 2, false, 1,
    '[{"provider_repository_id":"991001","owner_login":"acme","full_name":"acme/tool","canonical_url":"https://github.com/acme/tool","stars":-1,"forks":0,"provider_created_at":"2025-01-01T00:00:00Z","provider_updated_at":"2025-01-01T00:00:00Z"}]'::jsonb,
    'more', '[]'::jsonb, 180)$$,
  '23514', null,
  'candidate constraint failure rolls back source provenance and page progress'
);
select is((select pages_fetched from public.discovery_queries where id = (select id from discovery_claim_a)), 0, 'failed page leaves its checkpoint retryable');
select is((select count(*)::integer from public.source_records where source_key like 'pg-test-a:page:1:%'), 0, 'failed page leaves no partial source record');
select is((select count(*)::integer from public.repository_candidates where provider_repository_id = '991001'), 0, 'failed page leaves no partial candidate');

create temporary table first_page_commit as
select public.commit_discovery_page(
  (select id from discovery_claim_a), 'pg-test-worker-a', (select lease_token from discovery_claim_a),
  'pg-test-fp-a', 1, clock_timestamp(),
  'https://api.github.com/search/repositories?q=topic%3Aoutlist-test-a%20is%3Apublic&per_page=1&page=1',
  200, '{"api_version":"2022-11-28","rate_limit":{"resource":"search","remaining":28}}'::jsonb,
  2, false, 1,
  '[{"provider_repository_id":"991001","owner_login":"acme","full_name":"acme/tool","canonical_url":"https://github.com/acme/tool","description":"Original name","primary_language":"Rust","stars":5,"forks":1,"provider_created_at":"2025-01-01T00:00:00Z","provider_updated_at":"2026-01-01T00:00:00Z","provider_pushed_at":null,"topics":["outlist-test"],"source_license_summary":{"key":"mit","name":"MIT License","spdx_id":"MIT"}}]'::jsonb,
  'more', '[]'::jsonb, 180
);
select is((select (public.commit_discovery_page(
  (select id from discovery_claim_a), 'pg-test-worker-a', (select lease_token from discovery_claim_a),
  'pg-test-fp-a', 1, clock_timestamp(),
  'https://api.github.com/search/repositories?q=topic%3Aoutlist-test-a%20is%3Apublic&per_page=1&page=1',
  200, '{}'::jsonb, 2, false, 1,
  '[{"provider_repository_id":"991001","owner_login":"acme","full_name":"acme/tool","canonical_url":"https://github.com/acme/tool","stars":5,"forks":1,"provider_created_at":"2025-01-01T00:00:00Z","provider_updated_at":"2026-01-01T00:00:00Z"}]'::jsonb,
  'more', '[]'::jsonb, 180)->>'committed')::boolean), false, 'repeating a committed page is idempotent');
select is((select pages_fetched from public.discovery_queries where id = (select id from discovery_claim_a)), 1, 'repeated page does not double-advance the checkpoint');
select is((select candidates_found from public.discovery_queries where id = (select id from discovery_claim_a)), 1, 'repeated page does not double-count candidates');

select public.commit_discovery_page(
  (select id from discovery_claim_a), 'pg-test-worker-a', (select lease_token from discovery_claim_a),
  'pg-test-fp-a', 2, clock_timestamp(),
  'https://api.github.com/search/repositories?q=topic%3Aoutlist-test-a%20is%3Apublic&per_page=1&page=2',
  200, '{"api_version":"2022-11-28"}'::jsonb, 2, false, 1,
  '[{"provider_repository_id":"991001","owner_login":"acme","full_name":"acme/renamed-tool","canonical_url":"https://github.com/acme/renamed-tool","description":"Renamed","primary_language":"Rust","stars":7,"forks":2,"provider_created_at":"2025-01-01T00:00:00Z","provider_updated_at":"2026-10-01T00:00:00Z","provider_pushed_at":"2026-09-30T00:00:00Z","topics":["outlist-test","tools"],"source_license_summary":{"key":"mit","name":"MIT License","spdx_id":"MIT"}}]'::jsonb,
  'exhausted', '[]'::jsonb, 180
);
select is((select (public.commit_discovery_page(
  (select id from discovery_claim_a), 'pg-test-worker-a', (select lease_token from discovery_claim_a),
  'pg-test-fp-a', 2, clock_timestamp(),
  'https://api.github.com/search/repositories?q=topic%3Aoutlist-test-a%20is%3Apublic&per_page=1&page=2',
  200, '{}'::jsonb, 2, false, 1, '[]'::jsonb, 'exhausted', '[]'::jsonb, 180)->>'committed')::boolean),
  false, 'replaying the final page after completion is idempotent');
select is((select pages_fetched from public.discovery_queries where id = (select id from discovery_claim_a)), 2,
  'replaying the final page cannot increment completed partition counters');
select is((select count(*)::integer from public.repository_candidates where provider = 'github' and provider_repository_id = '991001'), 1, 'stable provider ID deduplicates repositories across pages');
select is((select full_name from public.repository_candidates where provider_repository_id = '991001'), 'acme/renamed-tool', 'repository rename updates candidate metadata without changing identity');
select is((select stars from public.repository_candidates where provider_repository_id = '991001'), 7::bigint, 'newest search metadata is retained');
select is((select count(*)::integer from public.repository_candidate_sources where candidate_id = (select id from public.repository_candidates where provider_repository_id = '991001')), 2, 'page provenance is linked for every observation');
select is((select items_created from public.ingestion_jobs where id = (select job_id from discovery_test_job)), 1, 'job counts one candidate creation');
select is((select items_discovered from public.ingestion_jobs where id = (select job_id from discovery_test_job)), 2, 'job counts each committed page observation once');

update public.repository_candidates set queue_status = 'discarded', review_status = 'rejected'
where provider = 'github' and provider_repository_id = '991001';
select public.commit_discovery_page(
  (select id from discovery_claim_b), 'pg-test-worker-b', (select lease_token from discovery_claim_b),
  'pg-test-fp-b', 1, clock_timestamp(),
  'https://api.github.com/search/repositories?q=topic%3Aoutlist-test-b%20is%3Apublic&per_page=1&page=1',
  200, '{}'::jsonb, 1, false, 1,
  '[{"provider_repository_id":"991001","owner_login":"acme","full_name":"acme/rediscovered-tool","canonical_url":"https://github.com/acme/rediscovered-tool","stars":8,"forks":2,"provider_created_at":"2025-01-01T00:00:00Z","provider_updated_at":"2026-10-02T00:00:00Z"}]'::jsonb,
  'exhausted', '[]'::jsonb, 180
);
select is((select queue_status from public.repository_candidates where provider_repository_id = '991001'), 'discarded', 'rediscovery does not reactivate discarded candidates');
select is((select review_status from public.repository_candidates where provider_repository_id = '991001'), 'rejected', 'rediscovery does not reverse a rejection');
select is((select count(*)::integer from public.repository_candidate_sources where candidate_id = (select id from public.repository_candidates where provider_repository_id = '991001')), 3, 'overlapping partitions retain provenance without duplicating candidates');
select is((select count(*)::integer from public.repositories where provider = 'github' and provider_repository_id = '991001'), 0, 'discovery never creates a canonical repository');
select is((select count(*)::integer from public.projects where slug = 'acme-rediscovered-tool'), 0, 'discovery never creates or publishes a project');

create temporary table discovery_claim_saturated as
select * from public.claim_discovery_partitions((select job_id from discovery_test_job), 'pg-test-worker-c', 1, 180);
select throws_ok(
  $$select public.commit_discovery_page(
    (select id from discovery_claim_saturated), 'pg-test-worker-c', (select lease_token from discovery_claim_saturated),
    'pg-test-fp-c', 1, clock_timestamp(),
    'https://api.github.com/search/repositories?q=topic%3Aoutlist-test-c%20is%3Apublic&per_page=100&page=1',
    200, '{}'::jsonb, 1001, false, 100, '[]'::jsonb, 'exhausted', '[]'::jsonb, 180)$$,
  '22023', null, 'a saturated partition cannot be committed as exhausted'
);
select public.commit_discovery_page(
  (select id from discovery_claim_saturated), 'pg-test-worker-c', (select lease_token from discovery_claim_saturated),
  'pg-test-fp-c', 1, clock_timestamp(),
  'https://api.github.com/search/repositories?q=topic%3Aoutlist-test-c%20is%3Apublic&per_page=100&page=1',
  200, '{"incomplete_results":false}'::jsonb, 1001, false, 100, '[]'::jsonb, 'review',
  '[
    {"partition_key":"pg-test-c-left","provider":"github","query_text":"topic:outlist-test-c created:2020-01-01..2023-06-30","query_fingerprint":"pg-test-child-left","query_parameters":{"per_page":100},"date_range":{"start":"2020-01-01","end":"2023-06-30"},"intended_coverage":"left"},
    {"partition_key":"pg-test-c-right","provider":"github","query_text":"topic:outlist-test-c created:2023-07-01..2026-11-05","query_fingerprint":"pg-test-child-right","query_parameters":{"per_page":100},"date_range":{"start":"2023-07-01","end":"2026-11-05"},"intended_coverage":"right"}
  ]'::jsonb, 180
);
select is((select status from public.discovery_queries where partition_key = 'pg-test-c'), 'needs_review', 'saturated parent remains visible for review');
select is((select count(*)::integer from public.discovery_queries where partition_key in ('pg-test-c-left', 'pg-test-c-right') and status = 'pending'), 2, 'safe narrower partitions are queued');

create temporary table lease_test_job (job_id uuid);
insert into lease_test_job
select public.start_discovery_job(
  'pg-lease-test', 'pg-lease-v1',
  '[
    {"partition_key":"pg-lease-expiring","provider":"github","query_text":"topic:lease-test is:public","query_fingerprint":"pg-lease-fp","query_parameters":{"sort":"stars","order":"desc","per_page":1},"date_range":{},"intended_coverage":"lease fixture"},
    {"partition_key":"pg-lease-retry-exhausted","provider":"github","query_text":"topic:lease-exhausted is:public","query_fingerprint":"pg-lease-exhausted-fp","query_parameters":{"sort":"stars","order":"desc","per_page":1},"date_range":{},"intended_coverage":"retry terminal fixture"}
  ]'::jsonb
);
create temporary table stale_claim as
select * from public.claim_discovery_partitions((select job_id from lease_test_job), 'pg-stale-worker', 1, 30);
update public.discovery_queries set lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select id from stale_claim);
create temporary table fresh_claim as
select * from public.claim_discovery_partitions((select job_id from lease_test_job), 'pg-fresh-worker', 1, 30);
select isnt((select lease_token::text from stale_claim), (select lease_token::text from fresh_claim), 'expired lease recovery issues a new fencing token');
select throws_ok(
  $$select public.commit_discovery_page(
    (select id from stale_claim), 'pg-stale-worker', (select lease_token from stale_claim),
    'pg-lease-fp', 1, clock_timestamp(),
    'https://api.github.com/search/repositories?q=topic%3Alease-test%20is%3Apublic&per_page=1&page=1',
    200, '{}'::jsonb, 0, false, 1, '[]'::jsonb, 'exhausted', '[]'::jsonb, 180)$$,
  '40001', null, 'expired worker is fenced from committing stale results'
);
select public.fail_discovery_partition(
  (select id from fresh_claim), 'pg-fresh-worker', (select lease_token from fresh_claim),
  'rate_limit; HTTP 403; resource search; retry after 60s', true, 60000
);
select is((select status from public.discovery_queries where partition_key = 'pg-lease-expiring'), 'retry_wait', 'retryable failure enters persisted retry wait');
select ok((select next_attempt_at > clock_timestamp() from public.discovery_queries where partition_key = 'pg-lease-expiring'), 'retry-after is persisted as a future eligibility time');
update public.discovery_queries set next_attempt_at = clock_timestamp() - interval '1 second'
where partition_key = 'pg-lease-expiring';
create temporary table terminal_claim as
select * from public.claim_discovery_partitions((select job_id from lease_test_job), 'pg-terminal-worker', 1, 30);
select public.fail_discovery_partition(
  (select id from terminal_claim), 'pg-terminal-worker', (select lease_token from terminal_claim),
  'validation; HTTP 422', false, null
);
select is((select status from public.discovery_queries where partition_key = 'pg-lease-expiring'), 'failed', 'non-retryable failures become terminal');
create temporary table max_retry_claim as
select * from public.claim_discovery_partitions((select job_id from lease_test_job), 'pg-max-retry-worker', 1, 30);
update public.discovery_queries set retry_count = max_attempts, lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select id from max_retry_claim);
select is((select count(*)::integer from public.claim_discovery_partitions(
  (select job_id from lease_test_job), 'recovery-worker', 1, 30)), 0,
  'an abandoned partition at the retry limit is not reclaimed');
select is((select status from public.discovery_queries where partition_key = 'pg-lease-retry-exhausted'), 'failed',
  'an abandoned partition at the retry limit becomes terminal');
select is((select items_failed from public.ingestion_jobs where id = (select job_id from lease_test_job)), 1,
  'automatic terminal recovery increments the owning job failure counter');

set local role anon;
set local "request.jwt.claims" = '{"role":"anon"}';
select throws_ok($$select * from public.discovery_queries$$, '42501', null, 'ordinary clients cannot read discovery partitions');
select throws_ok($$select * from public.repository_candidates$$, '42501', null, 'ordinary clients cannot read candidates');
select throws_ok($$select * from public.repository_candidate_sources$$, '42501', null, 'ordinary clients cannot read candidate provenance links');
select throws_ok($$select * from public.source_records$$, '42501', null, 'ordinary clients cannot read source provenance');
select throws_ok($$select * from public.ingestion_jobs$$, '42501', null, 'ordinary clients cannot read ingestion job state');
reset role;

select * from finish();
rollback;
