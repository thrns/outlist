-- A separate durable queue for normalizing discovered GitHub candidates.
-- Discovery queue status/checkpoints remain independent of enrichment leases.

alter table public.repositories
  add column provider_node_id text,
  add column owner_login text,
  add column repository_name text,
  add column homepage_url text,
  add column watchers bigint check (watchers is null or watchers >= 0),
  add column open_issues bigint check (open_issues is null or open_issues >= 0),
  add column is_disabled boolean,
  add column is_private boolean,
  add column visibility text,
  add column source_license_metadata jsonb
    check (source_license_metadata is null or jsonb_typeof(source_license_metadata) = 'object'),
  add column source_field_states jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_field_states) = 'object'),
  add column source_observed_at timestamptz;

alter table public.releases
  add column source_observed_at timestamptz;

alter table public.source_records
  add column etag text,
  add column candidate_id uuid references public.repository_candidates(id) on delete set null;

alter table public.repository_candidates
  add column enrichment_status text not null default 'queued'
    check (enrichment_status in ('queued', 'processing', 'retry_wait', 'succeeded', 'failed', 'skipped')),
  add column enrichment_attempts integer not null default 0 check (enrichment_attempts >= 0),
  add column enrichment_max_attempts integer not null default 5 check (enrichment_max_attempts > 0),
  add column enrichment_next_attempt_at timestamptz,
  add column enrichment_locked_at timestamptz,
  add column enrichment_lease_expires_at timestamptz,
  add column enrichment_lease_token uuid,
  add column enrichment_lock_owner text,
  add column enrichment_job_id uuid references public.ingestion_jobs(id) on delete set null,
  add column enrichment_error text,
  add column enrichment_completed_at timestamptz,
  add constraint repository_candidates_enrichment_lease_state check (
    (enrichment_status = 'processing'
      and enrichment_locked_at is not null
      and enrichment_lease_expires_at is not null
      and enrichment_lease_token is not null
      and nullif(btrim(enrichment_lock_owner), '') is not null)
    or (enrichment_status <> 'processing'
      and enrichment_locked_at is null
      and enrichment_lease_expires_at is null
      and enrichment_lease_token is null
      and enrichment_lock_owner is null)
  ),
  add constraint repository_candidates_enrichment_terminal_timestamp check (
    enrichment_status not in ('succeeded', 'failed', 'skipped')
    or enrichment_completed_at is not null
  );

create index repository_candidates_enrichment_claim_idx
  on public.repository_candidates (enrichment_status, enrichment_next_attempt_at, first_seen_at, id)
  where provider = 'github' and queue_status in ('queued', 'retry_wait') and review_status <> 'rejected';
create index ingestion_items_candidate_job_idx
  on public.ingestion_items (candidate_id, job_id, status);

create or replace function public.start_github_enrichment_job(
  p_resume boolean default false,
  p_metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_metadata) is distinct from 'object' or pg_column_size(p_metadata) > 8192 then
    raise exception 'invalid enrichment job metadata' using errcode = '22023';
  end if;

  if p_resume then
    select j.id into v_job_id
    from public.ingestion_jobs j
    where j.job_type = 'github_enrichment' and j.provider = 'github' and j.status = 'running'
    order by j.started_at desc, j.created_at desc
    limit 1
    for update;
  end if;

  if v_job_id is null then
    insert into public.ingestion_jobs (job_type, provider, status, started_at, metadata)
    values ('github_enrichment', 'github', 'running', clock_timestamp(), p_metadata)
    returning id into v_job_id;
  end if;
  return v_job_id;
end;
$function$;

create or replace function public.claim_github_enrichment_candidates(
  p_job_id uuid,
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 900
) returns table (
  candidate_id uuid,
  provider_repository_id text,
  full_name text,
  owner_login text,
  enrichment_attempts integer,
  enrichment_max_attempts integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate public.repository_candidates%rowtype;
  v_job public.ingestion_jobs%rowtype;
  v_item_id uuid;
  v_item_new boolean;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if nullif(btrim(p_worker_id), '') is null or length(p_worker_id) > 128
    or p_limit < 1 or p_limit > 100 or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'invalid enrichment claim parameters' using errcode = '22023';
  end if;
  select j.* into v_job from public.ingestion_jobs j
  where j.id = p_job_id and j.job_type = 'github_enrichment'
    and j.provider = 'github' and j.status = 'running' for update;
  if not found then
    raise exception 'enrichment job is not running' using errcode = '22023';
  end if;

  -- Expired final attempts become deterministic terminal failures. Claims with
  -- remaining attempts below are reclaimed with a new fencing token.
  for v_candidate in
    select c.* from public.repository_candidates c
    where c.provider = 'github' and c.queue_status in ('queued', 'retry_wait')
      and c.review_status <> 'rejected'
      and c.provider_repository_id ~ '^[1-9][0-9]{0,18}$'
      and c.enrichment_attempts >= c.enrichment_max_attempts
      and (
        (c.enrichment_status = 'processing' and c.enrichment_lease_expires_at <= v_now)
        or (c.enrichment_status = 'retry_wait' and c.enrichment_next_attempt_at <= v_now)
      )
    order by c.enrichment_lease_expires_at nulls first, c.id
    limit p_limit
    for update skip locked
  loop
    update public.repository_candidates c set
      enrichment_status = 'failed', enrichment_completed_at = v_now,
      enrichment_next_attempt_at = null, enrichment_locked_at = null,
      enrichment_lease_expires_at = null, enrichment_lease_token = null,
      enrichment_lock_owner = null,
      enrichment_error = 'Enrichment lease expired or retry limit reached.', updated_at = v_now
    where c.id = v_candidate.id;
    update public.ingestion_items i set status = 'failed', finished_at = v_now,
      locked_at = null, lock_owner = null, next_attempt_at = null,
      last_error = 'Enrichment lease expired or retry limit reached.', updated_at = v_now
    where i.candidate_id = v_candidate.id and i.job_id = v_candidate.enrichment_job_id
      and i.status in ('processing', 'retry_wait');
    update public.ingestion_jobs j set items_failed = j.items_failed + 1,
      items_processed = j.items_processed + 1, updated_at = v_now
    where j.id = v_candidate.enrichment_job_id;
  end loop;

  for v_candidate in
    with picked as (
      select c.id from public.repository_candidates c
      where c.provider = 'github' and c.queue_status in ('queued', 'retry_wait')
        and c.review_status <> 'rejected'
        and c.provider_repository_id ~ '^[1-9][0-9]{0,18}$'
      and c.provider_repository_id::numeric <= 9007199254740991
        and c.enrichment_attempts < c.enrichment_max_attempts
        and (
          c.enrichment_status = 'queued'
          or (c.enrichment_status = 'retry_wait' and coalesce(c.enrichment_next_attempt_at, '-infinity'::timestamptz) <= v_now)
          or (c.enrichment_status = 'processing' and c.enrichment_lease_expires_at <= v_now)
        )
      order by coalesce(c.enrichment_next_attempt_at, c.first_seen_at), c.id
      limit p_limit
      for update skip locked
    ), claimed as (
      update public.repository_candidates c set
        enrichment_status = 'processing', enrichment_attempts = c.enrichment_attempts + 1,
        enrichment_next_attempt_at = null, enrichment_locked_at = v_now,
        enrichment_lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        enrichment_lease_token = gen_random_uuid(), enrichment_lock_owner = p_worker_id,
        enrichment_job_id = p_job_id, enrichment_completed_at = null,
        enrichment_error = null, updated_at = v_now
      from picked p where c.id = p.id
      returning c.*
    )
    select * from claimed
  loop
    -- A reclaimed claim closes the previous job's item as retryable without
    -- counting a permanent failure. The new job receives its own item row.
    update public.ingestion_items i set status = 'retry_wait', locked_at = null,
      lock_owner = null, last_error = 'Previous enrichment lease expired and was reclaimed.',
      updated_at = v_now
    where i.candidate_id = v_candidate.id and i.job_id <> p_job_id and i.status = 'processing';

    insert into public.ingestion_items (
      job_id, item_key, item_type, candidate_id, repository_id, status,
      attempts, max_attempts, locked_at, lock_owner, started_at
    ) values (
      p_job_id, 'github:' || v_candidate.provider_repository_id, 'github_repository',
      v_candidate.id, v_candidate.repository_id, 'processing', 1,
      v_candidate.enrichment_max_attempts, v_now, p_worker_id, v_now
    ) on conflict (job_id, item_key) do update set
      status = 'processing', attempts = public.ingestion_items.attempts + 1,
      max_attempts = excluded.max_attempts, locked_at = v_now,
      lock_owner = p_worker_id, started_at = coalesce(public.ingestion_items.started_at, v_now),
      finished_at = null, next_attempt_at = null, last_error = null,
      updated_at = v_now
    returning public.ingestion_items.id, (xmax = 0) into v_item_id, v_item_new;

    if v_item_new then
      update public.ingestion_jobs j set items_discovered = j.items_discovered + 1,
        updated_at = v_now where j.id = p_job_id;
    end if;

    candidate_id := v_candidate.id;
    provider_repository_id := v_candidate.provider_repository_id;
    full_name := v_candidate.full_name;
    owner_login := v_candidate.owner_login;
    enrichment_attempts := v_candidate.enrichment_attempts;
    enrichment_max_attempts := v_candidate.enrichment_max_attempts;
    lease_token := v_candidate.enrichment_lease_token;
    lease_expires_at := v_candidate.enrichment_lease_expires_at;
    return next;
  end loop;
end;
$function$;

create or replace function public.commit_github_repository_enrichment(
  p_candidate_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate public.repository_candidates%rowtype;
  v_repo jsonb;
  v_sources jsonb;
  v_source jsonb;
  v_source_ids uuid[] := array[]::uuid[];
  v_source_id uuid;
  v_repo_id uuid;
  v_inserted boolean;
  v_source_count integer;
  v_previous_languages_at timestamptz;
  v_previous_topics_at timestamptz;
  v_languages_at timestamptz;
  v_topics_at timestamptz;
  v_repo_at timestamptz;
  v_delay_ms bigint;
  v_partial boolean;
  v_retryable_partial boolean;
  v_next_status text;
  v_next_attempt timestamptz;
  v_missing text[];
  v_now timestamptz := clock_timestamp();
  v_language jsonb;
  v_topic jsonb;
  v_release jsonb;
  v_snapshot jsonb;
  v_source_index integer;
  v_item_key text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select c.* into v_candidate from public.repository_candidates c
  where c.id = p_candidate_id for update;
  if not found or v_candidate.enrichment_status <> 'processing'
    or v_candidate.enrichment_lock_owner is distinct from p_worker_id
    or v_candidate.enrichment_lease_token is distinct from p_lease_token
    or v_candidate.enrichment_lease_expires_at <= v_now then
    raise exception 'enrichment claim is stale' using errcode = '40001';
  end if;
  if v_candidate.provider <> 'github' or v_candidate.queue_status not in ('queued', 'retry_wait')
    or v_candidate.review_status = 'rejected'
    or v_candidate.provider_repository_id !~ '^[1-9][0-9]{0,18}$'
    or v_candidate.provider_repository_id::numeric > 9007199254740991 then
    raise exception 'candidate is no longer eligible for enrichment' using errcode = '55000';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
    or jsonb_typeof(p_payload->'repository') is distinct from 'object'
    or jsonb_typeof(p_payload->'source_records') is distinct from 'array'
    or jsonb_typeof(p_payload->'languages') is distinct from 'object'
    or jsonb_typeof(p_payload->'topics') is distinct from 'object'
    or jsonb_typeof(p_payload->'releases') is distinct from 'object'
    or jsonb_typeof(p_payload->'snapshot') is distinct from 'object'
    or jsonb_typeof(p_payload->'partial') is distinct from 'boolean'
    or jsonb_typeof(p_payload->'retryable_partial') is distinct from 'boolean'
    or (p_payload->'retry_after_ms' is not null and jsonb_typeof(p_payload->'retry_after_ms') not in ('number', 'null'))
    or jsonb_typeof(p_payload->'missing_resources') is distinct from 'array'
    or pg_column_size(p_payload) > 1048576 then
    raise exception 'invalid enrichment payload structure' using errcode = '22023';
  end if;
  v_repo := p_payload->'repository';
  v_sources := p_payload->'source_records';
  v_source_count := jsonb_array_length(v_sources);
  v_partial := (p_payload->>'partial')::boolean;
  v_retryable_partial := (p_payload->>'retryable_partial')::boolean;
  v_delay_ms := coalesce(nullif(p_payload->>'retry_after_ms', '')::bigint, 60000);
  if v_delay_ms < 0 or v_delay_ms > 604800000 then
    raise exception 'invalid enrichment retry interval' using errcode = '22023';
  end if;
  select array_agg(item #>> '{}') into v_missing
  from jsonb_array_elements(p_payload->'missing_resources') as items(item);
  v_missing := coalesce(v_missing, array[]::text[]);

  if v_source_count < 1 or v_source_count > 32
    or (v_repo->>'provider_repository_id') is distinct from v_candidate.provider_repository_id
    or nullif(v_repo->>'provider_node_id', '') is null
    or nullif(v_repo->>'owner_login', '') is null
    or nullif(v_repo->>'repository_name', '') is null
    or nullif(v_repo->>'full_name', '') is null
    or (v_repo->>'full_name') is distinct from ((v_repo->>'owner_login') || '/' || (v_repo->>'repository_name'))
    or (v_repo->>'full_name') !~ '^[^/[:space:]]+/[^/[:space:]]+$'
    or nullif(v_repo->>'canonical_url', '') is null
    or (v_repo->>'canonical_url') !~* '^https://github\.com/[^/[:space:]]+/[^/[:space:]]+/?$'
    or lower(rtrim(v_repo->>'canonical_url', '/')) <> ('https://github.com/' || lower(v_repo->>'full_name'))
    or coalesce((v_repo->>'stars') !~ '^(0|[1-9][0-9]{0,18})$', true)
    or coalesce((v_repo->>'forks') !~ '^(0|[1-9][0-9]{0,18})$', true)
    or coalesce((v_repo->>'watchers') !~ '^(0|[1-9][0-9]{0,18})$', true)
    or coalesce((v_repo->>'open_issues') !~ '^(0|[1-9][0-9]{0,18})$', true)
    or (v_repo->>'stars')::numeric > 9223372036854775807
    or (v_repo->>'forks')::numeric > 9223372036854775807
    or (v_repo->>'watchers')::numeric > 9223372036854775807
    or (v_repo->>'open_issues')::numeric > 9223372036854775807
    or jsonb_typeof(v_repo->'is_archived') is distinct from 'boolean'
    or jsonb_typeof(v_repo->'is_disabled') is distinct from 'boolean'
    or jsonb_typeof(v_repo->'is_fork') is distinct from 'boolean'
    or jsonb_typeof(v_repo->'is_private') is distinct from 'boolean'
    or jsonb_typeof(v_repo->'source_field_states') is distinct from 'object'
    or nullif(v_repo->>'provider_created_at', '') is null
    or nullif(v_repo->>'provider_updated_at', '') is null
    or nullif(v_repo->>'repository_observed_at', '') is null
    or jsonb_typeof(v_repo->'description_state') is distinct from 'object'
    or coalesce(v_repo->'description_state'->>'state', '') not in ('present', 'null', 'absent', 'unavailable', 'unsupported')
    or jsonb_typeof(v_repo->'homepage_state') is distinct from 'object'
    or coalesce(v_repo->'homepage_state'->>'state', '') not in ('present', 'null', 'absent', 'unavailable', 'unsupported')
    or jsonb_typeof(v_repo->'default_branch_state') is distinct from 'object'
    or coalesce(v_repo->'default_branch_state'->>'state', '') not in ('present', 'null', 'absent', 'unavailable', 'unsupported')
    or jsonb_typeof(v_repo->'primary_language_state') is distinct from 'object'
    or coalesce(v_repo->'primary_language_state'->>'state', '') not in ('present', 'null', 'absent', 'unavailable', 'unsupported')
    or jsonb_typeof(v_repo->'visibility_state') is distinct from 'object'
    or coalesce(v_repo->'visibility_state'->>'state', '') not in ('present', 'null', 'absent', 'unavailable', 'unsupported')
    or jsonb_typeof(v_repo->'pushed_at_state') is distinct from 'object'
    or coalesce(v_repo->'pushed_at_state'->>'state', '') not in ('present', 'null', 'absent', 'unavailable', 'unsupported')
    or jsonb_typeof(v_repo->'license_state') is distinct from 'object'
    or coalesce(v_repo->'license_state'->>'state', '') not in ('present', 'null', 'absent', 'unavailable', 'unsupported')
    or (v_repo->'license_state'->>'state' = 'present' and jsonb_typeof(v_repo->'source_license_metadata') is distinct from 'object')
    or (v_repo->'license_state'->>'state' <> 'present' and v_repo->'source_license_metadata' is distinct from 'null'::jsonb) then
    raise exception 'invalid or inconsistent normalized repository metadata' using errcode = '22023';
  end if;
  v_repo_at := (v_repo->>'repository_observed_at')::timestamptz;
  if v_repo_at is null then raise exception 'invalid repository observation timestamp' using errcode = '22023'; end if;
  if jsonb_typeof(p_payload->'languages'->'complete') is distinct from 'boolean'
    or jsonb_typeof(p_payload->'languages'->'entries') is distinct from 'array'
    or jsonb_typeof(p_payload->'topics'->'complete') is distinct from 'boolean'
    or jsonb_typeof(p_payload->'topics'->'entries') is distinct from 'array'
    or jsonb_typeof(p_payload->'releases'->'complete') is distinct from 'boolean'
    or jsonb_typeof(p_payload->'releases'->'entries') is distinct from 'array'
    or jsonb_array_length(p_payload->'languages'->'entries') > 1000
    or jsonb_array_length(p_payload->'topics'->'entries') > 1000
    or jsonb_array_length(p_payload->'releases'->'entries') > 100
    or cardinality(v_missing) > 3
    or exists (
      select 1 from unnest(v_missing) as missing(resource)
      where resource not in ('languages', 'topics', 'releases')
    )
    or (v_partial is distinct from (cardinality(v_missing) > 0)) then
    raise exception 'invalid enrichment subresource completeness state' using errcode = '22023';
  end if;

  -- The SQL function owns the complete commit. Any bad row or constraint error
  -- rolls back provenance, canonical metadata, subresources, snapshot and job state.
  for v_source in select value from jsonb_array_elements(v_sources)
  loop
    if v_source->>'provider' is distinct from 'github'
      or coalesce(v_source->>'record_kind', '') not in ('repository', 'languages', 'topics', 'releases')
      or nullif(v_source->>'source_key', '') is null
      or nullif(v_source->>'source_url', '') is null
      or (v_source->>'source_url') !~* '^https://api\.github\.com/[^[:space:]]+$'
      or nullif(v_source->>'fetched_at', '') is null
      or (v_source->>'http_status') is not null and (v_source->>'http_status') !~ '^[1-5][0-9][0-9]$'
      or v_source->>'api_version' is distinct from '2022-11-28'
      or jsonb_typeof(v_source->'source_metadata') is distinct from 'object'
      or v_source->'source_metadata'->>'api_version' is distinct from '2022-11-28'
      or v_source->'source_metadata'->>'resource_kind' is distinct from v_source->>'record_kind'
      or v_source->'source_metadata'->>'stable_provider_id' is distinct from v_candidate.provider_repository_id
      or v_source->'source_metadata'->'cache_reusable' is distinct from 'false'::jsonb then
      raise exception 'invalid source provenance record' using errcode = '22023';
    end if;
    insert into public.source_records (
      provider, record_kind, source_key, source_url, fetched_at, http_status,
      etag, reuse_context, source_metadata, repository_id, candidate_id
    ) values (
      'github', v_source->>'record_kind', v_source->>'source_key', v_source->>'source_url',
      (v_source->>'fetched_at')::timestamptz,
      nullif(v_source->>'http_status', '')::integer,
      nullif(v_source->>'etag', ''),
      left(coalesce(v_source->>'reuse_context', 'Conditional reuse disabled; validated response metadata only.'), 500),
      v_source->'source_metadata', null, p_candidate_id
    ) on conflict (provider, source_key, fetched_at) do update set
      record_kind = excluded.record_kind, source_url = excluded.source_url,
      http_status = excluded.http_status, etag = excluded.etag,
      reuse_context = excluded.reuse_context, source_metadata = excluded.source_metadata,
      candidate_id = excluded.candidate_id
    returning id into v_source_id;
    v_source_ids := array_append(v_source_ids, v_source_id);
  end loop;
  if (v_sources->0->>'record_kind') <> 'repository' then
    raise exception 'first provenance record must describe repository metadata' using errcode = '22023';
  end if;
  if (not (p_payload->'languages'->>'complete')::boolean
      and (not ('languages' = any(v_missing)) or not exists (
        select 1 from jsonb_array_elements(v_sources) as records(source)
        where source->>'record_kind' = 'languages' and source->>'http_status' is distinct from '200'
      )))
    or (not (p_payload->'topics'->>'complete')::boolean
      and (not ('topics' = any(v_missing)) or not exists (
        select 1 from jsonb_array_elements(v_sources) as records(source)
        where source->>'record_kind' = 'topics' and source->>'http_status' is distinct from '200'
      )))
    or (not (p_payload->'releases'->>'complete')::boolean
      and (not ('releases' = any(v_missing)) or not exists (
        select 1 from jsonb_array_elements(v_sources) as records(source)
        where source->>'record_kind' = 'releases' and source->>'http_status' is distinct from '200'
      )))
    or (('languages' = any(v_missing)) is distinct from (not (p_payload->'languages'->>'complete')::boolean))
    or (('topics' = any(v_missing)) is distinct from (not (p_payload->'topics'->>'complete')::boolean))
    or (('releases' = any(v_missing)) is distinct from (not (p_payload->'releases'->>'complete')::boolean))
    or ((p_payload->'languages'->>'complete')::boolean and not exists (
        select 1 from jsonb_array_elements(v_sources) as records(source)
        where source->>'record_kind' = 'languages' and source->>'http_status' = '200'
      ))
    or ((p_payload->'topics'->>'complete')::boolean and not exists (
        select 1 from jsonb_array_elements(v_sources) as records(source)
        where source->>'record_kind' = 'topics' and source->>'http_status' = '200'
      ))
    or ((p_payload->'releases'->>'complete')::boolean and not exists (
        select 1 from jsonb_array_elements(v_sources) as records(source)
        where source->>'record_kind' = 'releases' and source->>'http_status' = '200'
      ))
    or (not v_partial and v_retryable_partial)
    or (v_retryable_partial and exists (
      select 1 from jsonb_array_elements(v_sources) as records(source)
      where source->>'record_kind' = any(v_missing)
        and coalesce((source->'source_metadata'->>'retryable')::boolean, false) is not true
    )) then
    raise exception 'enrichment completeness does not match its source responses' using errcode = '22023';
  end if;
  v_source_id := v_source_ids[1];

  select exists (
    select 1 from public.repositories r
    where r.provider = 'github' and r.provider_repository_id = v_candidate.provider_repository_id
  ) into v_inserted;
  insert into public.repositories (
    provider, provider_repository_id, full_name, canonical_url, description,
    default_branch, primary_language, stars, forks, is_archived, is_fork,
    provider_created_at, provider_updated_at, provider_pushed_at,
    availability_status, provider_node_id, owner_login, repository_name,
    homepage_url, watchers, open_issues, is_disabled, is_private, visibility,
    source_license_metadata, source_field_states, source_observed_at,
    last_successful_sync_at
  ) values (
    'github', v_candidate.provider_repository_id, v_repo->>'full_name', v_repo->>'canonical_url',
    case when v_repo->'description_state'->>'state' in ('present', 'null') then v_repo->>'description' end,
    case when v_repo->'default_branch_state'->>'state' in ('present', 'null') then v_repo->>'default_branch' end,
    case when v_repo->'primary_language_state'->>'state' in ('present', 'null') then v_repo->>'primary_language' end,
    (v_repo->>'stars')::bigint, (v_repo->>'forks')::bigint, (v_repo->>'is_archived')::boolean,
    (v_repo->>'is_fork')::boolean, (v_repo->>'provider_created_at')::timestamptz,
    (v_repo->>'provider_updated_at')::timestamptz,
    case when v_repo->'pushed_at_state'->>'state' in ('present', 'null') then nullif(v_repo->>'pushed_at', '')::timestamptz end,
    'available', v_repo->>'provider_node_id', v_repo->>'owner_login', v_repo->>'repository_name',
    case when v_repo->'homepage_state'->>'state' in ('present', 'null') then v_repo->>'homepage' end,
    (v_repo->>'watchers')::bigint, (v_repo->>'open_issues')::bigint,
    (v_repo->>'is_disabled')::boolean, (v_repo->>'is_private')::boolean,
    case when v_repo->'visibility_state'->>'state' in ('present', 'null') then v_repo->>'visibility' end,
    case when v_repo->'license_state'->>'state' = 'present' then v_repo->'source_license_metadata'
      when v_repo->'license_state'->>'state' = 'null' then null else null end,
    v_repo->'source_field_states', v_repo_at, v_repo_at
  ) on conflict (provider, provider_repository_id) do update set
    full_name = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.full_name else public.repositories.full_name end,
    canonical_url = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.canonical_url else public.repositories.canonical_url end,
    description = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) and excluded.source_field_states->>'description' in ('present', 'null') then excluded.description else public.repositories.description end,
    default_branch = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) and excluded.source_field_states->>'default_branch' in ('present', 'null') then excluded.default_branch else public.repositories.default_branch end,
    primary_language = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) and excluded.source_field_states->>'primary_language' in ('present', 'null') then excluded.primary_language else public.repositories.primary_language end,
    stars = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.stars else public.repositories.stars end,
    forks = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.forks else public.repositories.forks end,
    is_archived = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.is_archived else public.repositories.is_archived end,
    is_fork = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.is_fork else public.repositories.is_fork end,
    provider_created_at = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.provider_created_at else public.repositories.provider_created_at end,
    provider_updated_at = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.provider_updated_at else public.repositories.provider_updated_at end,
    provider_pushed_at = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) and excluded.source_field_states->>'pushed_at' in ('present', 'null') then excluded.provider_pushed_at else public.repositories.provider_pushed_at end,
    availability_status = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then 'available' else public.repositories.availability_status end,
    provider_node_id = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.provider_node_id else public.repositories.provider_node_id end,
    owner_login = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.owner_login else public.repositories.owner_login end,
    repository_name = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.repository_name else public.repositories.repository_name end,
    homepage_url = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) and excluded.source_field_states->>'homepage' in ('present', 'null') then excluded.homepage_url else public.repositories.homepage_url end,
    watchers = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.watchers else public.repositories.watchers end,
    open_issues = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.open_issues else public.repositories.open_issues end,
    is_disabled = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.is_disabled else public.repositories.is_disabled end,
    is_private = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.is_private else public.repositories.is_private end,
    visibility = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) and excluded.source_field_states->>'visibility' in ('present', 'null') then excluded.visibility else public.repositories.visibility end,
    source_license_metadata = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) and excluded.source_field_states->>'license' in ('present', 'null') then excluded.source_license_metadata else public.repositories.source_license_metadata end,
    source_field_states = case when excluded.source_observed_at >= coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz) then excluded.source_field_states else public.repositories.source_field_states end,
    source_observed_at = greatest(coalesce(public.repositories.source_observed_at, '-infinity'::timestamptz), excluded.source_observed_at),
    last_successful_sync_at = greatest(coalesce(public.repositories.last_successful_sync_at, '-infinity'::timestamptz), excluded.last_successful_sync_at),
    updated_at = greatest(public.repositories.updated_at, v_now)
  returning id into v_repo_id;
  if v_repo_id is null then
    select r.id into v_repo_id from public.repositories r
    where r.provider = 'github' and r.provider_repository_id = v_candidate.provider_repository_id;
  end if;

  update public.source_records s set repository_id = v_repo_id
  where s.id = any(v_source_ids);

  select max((source->>'fetched_at')::timestamptz) into v_languages_at
  from jsonb_array_elements(v_sources) as sources(source) where source->>'record_kind' = 'languages' and source->>'http_status' = '200';
  select max((source->>'fetched_at')::timestamptz) into v_topics_at
  from jsonb_array_elements(v_sources) as sources(source) where source->>'record_kind' = 'topics' and source->>'http_status' = '200';
  select max(s.fetched_at) into v_previous_languages_at from public.source_records s
  where s.repository_id = v_repo_id and s.record_kind = 'languages' and s.http_status = 200
    and not (s.id = any(v_source_ids));
  select max(s.fetched_at) into v_previous_topics_at from public.source_records s
  where s.repository_id = v_repo_id and s.record_kind = 'topics' and s.http_status = 200
    and not (s.id = any(v_source_ids));

  if (p_payload->'languages'->>'complete')::boolean
    and v_languages_at is not null and v_languages_at >= coalesce(v_previous_languages_at, '-infinity'::timestamptz) then
    delete from public.repository_languages l where l.repository_id = v_repo_id;
    for v_language in select value from jsonb_array_elements(p_payload->'languages'->'entries')
    loop
      v_source_index := nullif(v_language->>'source_index', '')::integer;
      if nullif(btrim(v_language->>'name'), '') is null
        or coalesce((v_language->>'bytes') !~ '^(0|[1-9][0-9]{0,18})$', true)
        or (v_language->>'bytes')::numeric > 9223372036854775807
        or coalesce((v_language->>'source_index') !~ '^[1-9][0-9]{0,2}$', true)
        or v_source_index > cardinality(v_source_ids)
        or v_sources->(v_source_index - 1)->>'record_kind' is distinct from 'languages'
        or nullif(v_language->>'measured_at', '') is null then
        raise exception 'invalid normalized language record' using errcode = '22023';
      end if;
      insert into public.repository_languages (repository_id, language_name, bytes, measured_at, source_record_id)
      values (v_repo_id, v_language->>'name', (v_language->>'bytes')::bigint,
        (v_language->>'measured_at')::timestamptz, v_source_ids[(v_language->>'source_index')::integer]);
    end loop;
  end if;

  if (p_payload->'topics'->>'complete')::boolean
    and v_topics_at is not null and v_topics_at >= coalesce(v_previous_topics_at, '-infinity'::timestamptz) then
    delete from public.repository_topics t where t.repository_id = v_repo_id;
    for v_topic in select value from jsonb_array_elements(p_payload->'topics'->'entries')
    loop
      v_source_index := nullif(v_topic->>'source_index', '')::integer;
      if nullif(btrim(v_topic->>'source_topic'), '') is null
        or coalesce((v_topic->>'source_index') !~ '^[1-9][0-9]{0,2}$', true)
        or v_source_index > cardinality(v_source_ids)
        or v_sources->(v_source_index - 1)->>'record_kind' is distinct from 'topics'
        or nullif(v_topic->>'observed_at', '') is null then
        raise exception 'invalid normalized topic record' using errcode = '22023';
      end if;
      insert into public.repository_topics (repository_id, source_topic, observed_at, source_record_id)
      values (v_repo_id, v_topic->>'source_topic', (v_topic->>'observed_at')::timestamptz,
        v_source_ids[(v_topic->>'source_index')::integer])
      on conflict (repository_id, topic_key) do update set
        source_topic = excluded.source_topic, observed_at = excluded.observed_at,
        source_record_id = excluded.source_record_id;
    end loop;
  end if;

  if (p_payload->'releases'->>'complete')::boolean then
    for v_release in select value from jsonb_array_elements(p_payload->'releases'->'entries')
    loop
      v_source_index := nullif(v_release->>'source_index', '')::integer;
      if coalesce((v_release->>'provider_release_id') !~ '^[1-9][0-9]{0,18}$', true)
        or (v_release->>'provider_release_id')::numeric > 9223372036854775807
        or nullif(btrim(v_release->>'version'), '') is null
        or (v_release->>'release_url') !~* '^https://github\.com/[^/[:space:]]+/[^/[:space:]]+/releases/[^[:space:]]+$'
        or jsonb_typeof(v_release->'is_prerelease') is distinct from 'boolean'
        or jsonb_typeof(v_release->'is_draft') is distinct from 'boolean'
        or coalesce((v_release->>'source_index') !~ '^[1-9][0-9]{0,2}$', true)
        or v_source_index > cardinality(v_source_ids)
        or v_sources->(v_source_index - 1)->>'record_kind' is distinct from 'releases'
        or nullif(v_release->>'source_observed_at', '') is null then
        raise exception 'invalid normalized release record' using errcode = '22023';
      end if;
      insert into public.releases (
        repository_id, provider_release_id, version, release_name, release_url,
        published_at, is_prerelease, is_draft, source_record_id, source_observed_at
      ) values (
        v_repo_id, v_release->>'provider_release_id', v_release->>'version',
        nullif(v_release->>'release_name', ''), v_release->>'release_url',
        nullif(v_release->>'published_at', '')::timestamptz,
        (v_release->>'is_prerelease')::boolean, (v_release->>'is_draft')::boolean,
        v_source_ids[(v_release->>'source_index')::integer],
        (v_release->>'source_observed_at')::timestamptz
      ) on conflict (repository_id, provider_release_id) do update set
        version = case when excluded.source_observed_at >= coalesce(public.releases.source_observed_at, '-infinity'::timestamptz) then excluded.version else public.releases.version end,
        release_name = case when excluded.source_observed_at >= coalesce(public.releases.source_observed_at, '-infinity'::timestamptz) then excluded.release_name else public.releases.release_name end,
        release_url = case when excluded.source_observed_at >= coalesce(public.releases.source_observed_at, '-infinity'::timestamptz) then excluded.release_url else public.releases.release_url end,
        published_at = case when excluded.source_observed_at >= coalesce(public.releases.source_observed_at, '-infinity'::timestamptz) then excluded.published_at else public.releases.published_at end,
        is_prerelease = case when excluded.source_observed_at >= coalesce(public.releases.source_observed_at, '-infinity'::timestamptz) then excluded.is_prerelease else public.releases.is_prerelease end,
        is_draft = case when excluded.source_observed_at >= coalesce(public.releases.source_observed_at, '-infinity'::timestamptz) then excluded.is_draft else public.releases.is_draft end,
        source_record_id = case when excluded.source_observed_at >= coalesce(public.releases.source_observed_at, '-infinity'::timestamptz) then excluded.source_record_id else public.releases.source_record_id end,
        source_observed_at = greatest(coalesce(public.releases.source_observed_at, '-infinity'::timestamptz), excluded.source_observed_at),
        updated_at = greatest(public.releases.updated_at, v_now);
    end loop;
  end if;

  v_snapshot := p_payload->'snapshot';
  if (v_snapshot->>'snapshot_date') is null
    or nullif(v_snapshot->>'captured_at', '') is null
    or coalesce((v_snapshot->>'stars') !~ '^(0|[1-9][0-9]{0,18})$', true)
    or coalesce((v_snapshot->>'forks') !~ '^(0|[1-9][0-9]{0,18})$', true)
    or coalesce((v_snapshot->>'source_index') !~ '^[1-9][0-9]{0,2}$', true)
    or ((v_snapshot->>'stars')::numeric > 9223372036854775807)
    or ((v_snapshot->>'forks')::numeric > 9223372036854775807)
    or (v_snapshot->>'source_index')::integer > cardinality(v_source_ids)
    or v_sources->((v_snapshot->>'source_index')::integer - 1)->>'record_kind' is distinct from 'repository'
    or (v_snapshot->>'stars') is distinct from (v_repo->>'stars')
    or (v_snapshot->>'forks') is distinct from (v_repo->>'forks')
    or (v_snapshot->>'captured_at') is distinct from (v_repo->>'repository_observed_at')
    or (v_snapshot->>'snapshot_date')::date is distinct from ((v_snapshot->>'captured_at')::timestamptz at time zone 'UTC')::date then
    raise exception 'invalid repository snapshot record' using errcode = '22023';
  end if;
  insert into public.repository_snapshots (
    repository_id, snapshot_date, captured_at, stars, forks, source_record_id
  ) values (
    v_repo_id, (v_snapshot->>'snapshot_date')::date, (v_snapshot->>'captured_at')::timestamptz,
    (v_snapshot->>'stars')::bigint, (v_snapshot->>'forks')::bigint,
    v_source_ids[(v_snapshot->>'source_index')::integer]
  ) on conflict (repository_id, snapshot_date) do update set
    captured_at = excluded.captured_at, stars = excluded.stars, forks = excluded.forks,
    source_record_id = excluded.source_record_id
  where excluded.captured_at > public.repository_snapshots.captured_at;

  v_next_status := case when not v_partial then 'succeeded'
    when v_retryable_partial and v_candidate.enrichment_attempts < v_candidate.enrichment_max_attempts then 'retry_wait'
    else 'failed' end;
  v_next_attempt := case when v_next_status = 'retry_wait'
    then v_now + make_interval(secs => (v_delay_ms::numeric / 1000)::double precision) else null end;
  update public.repository_candidates c set
    repository_id = v_repo_id, enrichment_status = v_next_status,
    enrichment_next_attempt_at = v_next_attempt,
    enrichment_locked_at = null, enrichment_lease_expires_at = null,
    enrichment_lease_token = null, enrichment_lock_owner = null,
    enrichment_error = case when v_partial then left(array_to_string(v_missing, ', '), 500) else null end,
    enrichment_completed_at = case when v_next_status in ('succeeded', 'failed') then v_now else null end,
    updated_at = v_now
  where c.id = p_candidate_id;

  v_item_key := 'github:' || v_candidate.provider_repository_id;
  update public.ingestion_items i set
    repository_id = v_repo_id,
    status = case when v_next_status = 'retry_wait' then 'retry_wait'
      when v_next_status = 'failed' then 'failed' else 'succeeded' end,
    next_attempt_at = v_next_attempt, locked_at = null, lock_owner = null,
    finished_at = case when v_next_status = 'retry_wait' then null else v_now end,
    last_error = case when v_partial then left(array_to_string(v_missing, ', '), 500) else null end,
    result = jsonb_build_object('repository_id', v_repo_id, 'partial', v_partial, 'missing_resources', v_missing),
    updated_at = v_now
  where i.job_id = v_candidate.enrichment_job_id and i.item_key = v_item_key;
  update public.ingestion_jobs j set
    items_processed = j.items_processed + 1,
    items_created = j.items_created + case when not v_inserted then 1 else 0 end,
    items_updated = j.items_updated + case when v_inserted then 1 else 0 end,
    items_failed = j.items_failed + case when v_next_status = 'failed' then 1 else 0 end,
    metadata = j.metadata || jsonb_build_object(
      'partial_count', coalesce((j.metadata->>'partial_count')::integer, 0) + case when v_partial then 1 else 0 end,
      'retry_scheduled_count', coalesce((j.metadata->>'retry_scheduled_count')::integer, 0) + case when v_next_status = 'retry_wait' then 1 else 0 end
    ), updated_at = v_now
  where j.id = v_candidate.enrichment_job_id;

  return jsonb_build_object(
    'repository_id', v_repo_id, 'repository_created', not v_inserted,
    'status', v_next_status, 'partial', v_partial,
    'missing_resources', v_missing, 'source_record_count', cardinality(v_source_ids)
  );
end;
$function$;

create or replace function public.fail_github_repository_enrichment(
  p_candidate_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_error_summary text,
  p_retryable boolean,
  p_retry_after_ms bigint default null,
  p_failure_provenance jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate public.repository_candidates%rowtype;
  v_delay_ms bigint;
  v_status text;
  v_item_key text;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select c.* into v_candidate from public.repository_candidates c where c.id = p_candidate_id for update;
  if not found or v_candidate.enrichment_status <> 'processing'
    or v_candidate.enrichment_lock_owner is distinct from p_worker_id
    or v_candidate.enrichment_lease_token is distinct from p_lease_token
    or v_candidate.enrichment_lease_expires_at <= v_now then
    raise exception 'enrichment claim is stale' using errcode = '40001';
  end if;
  if nullif(btrim(p_error_summary), '') is null or length(p_error_summary) > 500
    or p_error_summary ~ '[\r\n\t]' or p_retry_after_ms < 0 or p_retry_after_ms > 604800000 then
    raise exception 'invalid safe enrichment error summary or retry interval' using errcode = '22023';
  end if;
  if v_candidate.queue_status not in ('queued', 'retry_wait') or v_candidate.review_status = 'rejected' then
    v_status := 'skipped';
  else
    v_status := case when p_retryable and v_candidate.enrichment_attempts < v_candidate.enrichment_max_attempts
      then 'retry_wait' else 'failed' end;
  end if;
  v_delay_ms := coalesce(p_retry_after_ms,
    least(3600000::bigint, 5000::bigint * power(2, greatest(0, v_candidate.enrichment_attempts - 1))::bigint));

  if p_failure_provenance is not null then
    if jsonb_typeof(p_failure_provenance) is distinct from 'object'
      or (p_failure_provenance->>'source_url') !~* '^https://api\.github\.com/[^[:space:]]+$'
      or (p_failure_provenance->>'http_status') is not null and (p_failure_provenance->>'http_status') !~ '^[1-5][0-9][0-9]$' then
      raise exception 'invalid failure provenance' using errcode = '22023';
    end if;
    insert into public.source_records (
      provider, record_kind, source_key, source_url, fetched_at, http_status,
      reuse_context, source_metadata, repository_id, candidate_id
    ) values (
      'github', 'repository', 'github:repository:' || v_candidate.provider_repository_id || ':attempt:' || v_candidate.enrichment_attempts,
      p_failure_provenance->>'source_url', coalesce((p_failure_provenance->>'fetched_at')::timestamptz, v_now),
      nullif(p_failure_provenance->>'http_status', '')::integer,
      'No body cached; failed request evidence only.',
      jsonb_build_object('api_version', '2022-11-28', 'cache_reusable', false,
        'outcome', 'unavailable', 'error_kind', left(coalesce(p_failure_provenance->>'error_kind', 'request'), 64)),
      v_candidate.repository_id, v_candidate.id
    ) on conflict (provider, source_key, fetched_at) do nothing;
  end if;

  update public.repository_candidates c set
    enrichment_status = v_status,
    enrichment_next_attempt_at = case when v_status = 'retry_wait' then v_now + make_interval(secs => (v_delay_ms::numeric / 1000)::double precision) else null end,
    enrichment_locked_at = null, enrichment_lease_expires_at = null,
    enrichment_lease_token = null, enrichment_lock_owner = null,
    enrichment_error = case when v_status = 'skipped' then null else p_error_summary end,
    enrichment_completed_at = case when v_status in ('failed', 'skipped') then v_now else null end,
    updated_at = v_now
  where c.id = v_candidate.id;

  v_item_key := 'github:' || v_candidate.provider_repository_id;
  update public.ingestion_items i set
    status = v_status, next_attempt_at = case when v_status = 'retry_wait' then v_now + make_interval(secs => (v_delay_ms::numeric / 1000)::double precision) else null end,
    locked_at = null, lock_owner = null,
    finished_at = case when v_status in ('failed', 'skipped') then v_now else null end,
    last_error = case when v_status = 'skipped' then null else p_error_summary end,
    result = jsonb_build_object('status', v_status, 'retry_after_ms', case when v_status = 'retry_wait' then v_delay_ms else null end),
    updated_at = v_now
  where i.job_id = v_candidate.enrichment_job_id and i.item_key = v_item_key;
  update public.ingestion_jobs j set
    items_failed = j.items_failed + case when v_status = 'failed' then 1 else 0 end,
    items_skipped = j.items_skipped + case when v_status = 'skipped' then 1 else 0 end,
    items_processed = j.items_processed + case when v_status in ('failed', 'skipped') then 1 else 0 end,
    metadata = j.metadata || jsonb_build_object(
      'retry_scheduled_count', coalesce((j.metadata->>'retry_scheduled_count')::integer, 0) + case when v_status = 'retry_wait' then 1 else 0 end
    ), updated_at = v_now
  where j.id = v_candidate.enrichment_job_id;
  return jsonb_build_object('status', v_status,
    'retry_after_ms', case when v_status = 'retry_wait' then v_delay_ms else null end);
end;
$function$;

create or replace function public.finish_github_enrichment_job(
  p_job_id uuid,
  p_status text,
  p_error_summary text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_status not in ('succeeded', 'partial', 'failed', 'cancelled')
    or (p_error_summary is not null and (length(p_error_summary) > 500 or p_error_summary ~ '[\r\n\t]')) then
    raise exception 'invalid enrichment job terminal state' using errcode = '22023';
  end if;
  update public.ingestion_jobs j set status = case
      when p_status in ('failed', 'cancelled') then p_status
      when j.items_failed > 0 or j.items_skipped > 0
        or coalesce((j.metadata->>'retry_scheduled_count')::integer, 0) > 0
        or coalesce((j.metadata->>'partial_count')::integer, 0) > 0 then 'partial'
      else p_status end,
    finished_at = clock_timestamp(),
    error_summary = coalesce(p_error_summary, j.error_summary), updated_at = clock_timestamp()
  where j.id = p_job_id and j.job_type = 'github_enrichment' and j.provider = 'github' and j.status = 'running'
    and not exists (
      select 1 from public.repository_candidates c where c.enrichment_job_id = j.id
        and c.enrichment_status = 'processing'
    );
  if not found then raise exception 'enrichment job is active or not running' using errcode = '40001'; end if;
end;
$function$;

revoke all on function public.start_github_enrichment_job(boolean, jsonb) from public, anon, authenticated;
revoke all on function public.claim_github_enrichment_candidates(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.commit_github_repository_enrichment(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fail_github_repository_enrichment(uuid, text, uuid, text, boolean, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.finish_github_enrichment_job(uuid, text, text) from public, anon, authenticated;
grant execute on function public.start_github_enrichment_job(boolean, jsonb) to service_role;
grant execute on function public.claim_github_enrichment_candidates(uuid, text, integer, integer) to service_role;
grant execute on function public.commit_github_repository_enrichment(uuid, text, uuid, jsonb) to service_role;
grant execute on function public.fail_github_repository_enrichment(uuid, text, uuid, text, boolean, bigint, jsonb) to service_role;
grant execute on function public.finish_github_enrichment_job(uuid, text, text) to service_role;
