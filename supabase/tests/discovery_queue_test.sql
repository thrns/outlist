begin;
select no_plan();

set local "request.jwt.claims" = '{"role":"service_role"}';

select throws_ok(
  $$select public.start_discovery_job(
    'pg-test-invalid', 'pg-test-invalid-v1',
    '[{"partition_key":"pg-test-invalid-range","provider":"github","query_text":"topic:outlist-test is:public","query_fingerprint":"pg-test-invalid-range-fp","query_parameters":{"sort":"stars","order":"desc","per_page":1},"date_range":"{}"}]'::jsonb
  )$$,
  '22023', null, 'partition date ranges must be JSON objects'
);

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

-- Registration by another worker must preserve a live lease and checkpoint.
create temporary table registration_job_a (job_id uuid);
insert into registration_job_a
select public.start_discovery_job(
  'pg-registration-test', 'pg-registration-v1',
  '[{"partition_key":"pg-registration-active","provider":"github","query_text":"topic:lease-registration is:public","query_fingerprint":"pg-registration-fp","query_parameters":{"sort":"stars","order":"desc","per_page":1},"date_range":{},"intended_coverage":"registration lease fixture"}]'::jsonb
);
create temporary table registration_claim_a as
select * from public.claim_discovery_partitions((select job_id from registration_job_a), 'pg-registration-worker-a', 1, 180);
create temporary table registration_state_before as
select lease_token, cursor, pages_fetched, candidates_found, total_count, incomplete_results, job_id,
  lock_owner, lease_expires_at, status
from public.discovery_queries where partition_key = 'pg-registration-active';
create temporary table registration_job_b (job_id uuid);
insert into registration_job_b
select public.start_discovery_job(
  'pg-registration-test', 'pg-registration-v1',
  '[{"partition_key":"pg-registration-active","provider":"github","query_text":"topic:lease-registration is:public","query_fingerprint":"pg-registration-fp","query_parameters":{"sort":"stars","order":"desc","per_page":1},"date_range":{},"intended_coverage":"registration lease fixture"}]'::jsonb
);
select is((select lease_token from public.discovery_queries where partition_key = 'pg-registration-active'),
  (select lease_token from registration_state_before), 'unchanged registration preserves the active lease token');
select is((select lock_owner from public.discovery_queries where partition_key = 'pg-registration-active'),
  'pg-registration-worker-a', 'unchanged registration preserves the active owner');
select is((select job_id from public.discovery_queries where partition_key = 'pg-registration-active'),
  (select job_id from registration_state_before), 'unchanged registration preserves original job ownership');
select is((select pages_fetched from public.discovery_queries where partition_key = 'pg-registration-active'), 0,
  'unchanged registration preserves page counters');
select is((select candidates_found from public.discovery_queries where partition_key = 'pg-registration-active'), 0,
  'unchanged registration preserves candidate counters');
create temporary table rejected_registration_job_count as
select count(*)::integer as jobs from public.ingestion_jobs where metadata->>'plan_name' = 'pg-registration-test';
select throws_ok(
  $$select public.start_discovery_job(
    'pg-registration-test', 'pg-registration-v1',
    '[{"partition_key":"pg-registration-active","provider":"github","query_text":"topic:lease-registration-v2 is:public","query_fingerprint":"pg-registration-fp-v2","query_parameters":{"sort":"stars","order":"desc","per_page":1},"date_range":{},"intended_coverage":"incompatible active definition"}]'::jsonb
  )$$,
  '55000', 'active discovery lease prevents incompatible plan registration for partition pg-registration-active',
  'incompatible definition is rejected with a clear live-lease error'
);
select throws_ok(
  $$select public.start_discovery_job(
    'pg-registration-test', 'pg-registration-v2',
    '[{"partition_key":"pg-registration-active","provider":"github","query_text":"topic:lease-registration-v2 is:public","query_fingerprint":"pg-registration-fp-v2","query_parameters":{"sort":"stars","order":"desc","per_page":1},"date_range":{},"intended_coverage":"versioned active definition"}]'::jsonb
  )$$,
  '55000', 'active discovery lease prevents incompatible plan registration for partition pg-registration-active',
  'a plan-version bump cannot invalidate a live lease'
);
select is((select count(*)::integer from public.ingestion_jobs where metadata->>'plan_name' = 'pg-registration-test'),
  (select jobs from rejected_registration_job_count), 'rejected registration rolls back its newly created job atomically');
select is((select lease_token from public.discovery_queries where partition_key = 'pg-registration-active'),
  (select lease_token from registration_state_before), 'rejected registration leaves the original token unchanged');
select is((select cursor::text from public.discovery_queries where partition_key = 'pg-registration-active'),
  (select cursor::text from registration_state_before), 'rejected registration leaves the original cursor unchanged');
select is((select pages_fetched from public.discovery_queries where partition_key = 'pg-registration-active'),
  (select pages_fetched from registration_state_before), 'rejected registration leaves page counters unchanged');
select is((select candidates_found from public.discovery_queries where partition_key = 'pg-registration-active'),
  (select candidates_found from registration_state_before), 'rejected registration leaves candidate counters unchanged');

select public.commit_discovery_page(
  (select id from registration_claim_a), 'pg-registration-worker-a', (select lease_token from registration_claim_a),
  'pg-registration-fp', 1, clock_timestamp(),
  'https://api.github.com/search/repositories?q=topic%3Alease-registration%20is%3Apublic&per_page=1&page=1',
  200, '{}'::jsonb, 2, false, 1,
  '[{"provider_repository_id":"991002","owner_login":"registration","full_name":"registration/tool","canonical_url":"https://github.com/registration/tool","stars":1,"forks":0,"provider_created_at":"2025-01-01T00:00:00Z","provider_updated_at":"2026-01-01T00:00:00Z"}]'::jsonb,
  'yield', '[]'::jsonb, 180
);
create temporary table registration_claim_b as
select * from public.claim_discovery_partitions((select job_id from registration_job_b), 'pg-registration-worker-b', 1, 180);
select is((select (cursor->>'next_page')::integer from registration_claim_b), 2,
  'resumed worker B claims the persisted second page');
select public.commit_discovery_page(
  (select id from registration_claim_b), 'pg-registration-worker-b', (select lease_token from registration_claim_b),
  'pg-registration-fp', 2, clock_timestamp(),
  'https://api.github.com/search/repositories?q=topic%3Alease-registration%20is%3Apublic&per_page=1&page=2',
  200, '{}'::jsonb, 2, false, 1, '[]'::jsonb, 'exhausted', '[]'::jsonb, 180
);
select is((select pages_fetched from public.discovery_queries where partition_key = 'pg-registration-active'), 2,
  'resumed execution retains and advances both committed pages');
select is((select (cursor->>'next_page')::integer from public.discovery_queries where partition_key = 'pg-registration-active'), 3,
  'resumed execution leaves the next page after its committed checkpoint');
select throws_ok(
  $$select public.start_discovery_job(
    'pg-registration-test', 'pg-registration-v1',
    '[{"partition_key":"pg-registration-active","provider":"github","query_text":"topic:lease-registration-v2 is:public","query_fingerprint":"pg-registration-fp-v2","query_parameters":{"sort":"stars","order":"desc","per_page":1},"date_range":{},"intended_coverage":"same-version incompatible definition"}]'::jsonb
  )$$,
  '55000', 'incompatible discovery definition for partition pg-registration-active; keep its checkpoint and use a new plan version or an explicit reset migration',
  'completed checkpoints reject incompatible definitions in the same plan version'
);
select is((select pages_fetched from public.discovery_queries where partition_key = 'pg-registration-active'), 2,
  'rejected same-version definition change preserves completed checkpoint counters');
select is((select status from public.discovery_queries where partition_key = 'pg-registration-active'), 'completed',
  'rejected same-version definition change preserves completed status');
update public.repository_candidates set queue_status = 'discarded', review_status = 'rejected'
where provider = 'github' and provider_repository_id = '991002';
select public.start_discovery_job(
  'pg-registration-test', 'pg-registration-v2',
  '[{"partition_key":"pg-registration-active","provider":"github","query_text":"topic:lease-registration-v2 is:public","query_fingerprint":"pg-registration-fp-v2","query_parameters":{"sort":"stars","order":"desc","per_page":1},"date_range":{},"intended_coverage":"explicit versioned definition change"}]'::jsonb
);
select is((select status from public.discovery_queries where partition_key = 'pg-registration-active'), 'pending',
  'an explicit plan-version change queues a fresh incompatible definition');
select is((select pages_fetched from public.discovery_queries where partition_key = 'pg-registration-active'), 0,
  'an explicit plan-version change resets only checkpoint counters');
select is((select count(*)::integer from public.repository_candidates where provider_repository_id = '991002'), 1,
  'explicit checkpoint reset preserves the candidate row');
select is((select queue_status from public.repository_candidates where provider_repository_id = '991002'), 'discarded',
  'explicit checkpoint reset preserves discarded review state');
select is((select review_status from public.repository_candidates where provider_repository_id = '991002'), 'rejected',
  'explicit checkpoint reset preserves rejected review decision');
select is((select count(*)::integer from public.repository_candidate_sources where candidate_id =
  (select id from public.repository_candidates where provider_repository_id = '991002')), 1,
  'explicit checkpoint reset preserves prior candidate provenance');

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
select is((select items_failed from public.ingestion_jobs where id = (select job_id from lease_test_job)), 1,
  'explicit non-retryable failure increments the owning job counter');
create temporary table max_retry_claim as
select * from public.claim_discovery_partitions((select job_id from lease_test_job), 'pg-max-retry-worker', 1, 30);
update public.discovery_queries set retry_count = max_attempts, lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select id from max_retry_claim);
select is((select count(*)::integer from public.claim_discovery_partitions(
  (select job_id from lease_test_job), 'recovery-worker', 1, 30)), 0,
  'an abandoned partition at the retry limit is not reclaimed');
select is((select status from public.discovery_queries where partition_key = 'pg-lease-retry-exhausted'), 'failed',
  'an abandoned partition at the retry limit becomes terminal');
select is((select items_failed from public.ingestion_jobs where id = (select job_id from lease_test_job)), 2,
  'automatic terminal recovery increments the owning job failure counter');

set local role anon;
set local "request.jwt.claims" = '{"role":"anon"}';
select throws_ok($$select * from public.discovery_queries$$, '42501', null, 'ordinary clients cannot read discovery partitions');
select throws_ok($$select * from public.repository_candidates$$, '42501', null, 'ordinary clients cannot read candidates');
select throws_ok($$select * from public.repository_candidate_sources$$, '42501', null, 'ordinary clients cannot read candidate provenance links');
select throws_ok($$select * from public.source_records$$, '42501', null, 'ordinary clients cannot read source provenance');
select throws_ok($$select * from public.ingestion_jobs$$, '42501', null, 'ordinary clients cannot read ingestion job state');
select throws_ok(
  $$select public.start_discovery_job('ordinary-client-test', 'v1', '[]'::jsonb)$$,
  '42501', null, 'anonymous role cannot invoke privileged discovery registration'
);
reset role;

set local role authenticated;
set local "request.jwt.claims" = '{"role":"authenticated"}';
select throws_ok(
  $$select public.start_discovery_job('ordinary-client-test', 'v1', '[]'::jsonb)$$,
  '42501', null, 'authenticated role cannot invoke privileged discovery registration'
);
reset role;

select * from finish();
rollback;
