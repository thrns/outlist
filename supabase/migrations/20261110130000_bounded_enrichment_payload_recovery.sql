-- A one-time, idempotent recovery path for explicitly selected candidates
-- whose original failure was the known database_payload_validation error.

create table private.github_enrichment_recovery_requests (
  request_key text primary key check (request_key ~ '^[a-f0-9]{64}$'),
  job_id uuid not null unique references public.ingestion_jobs(id) on delete restrict,
  candidate_ids uuid[] not null check (cardinality(candidate_ids) between 1 and 5),
  worker_id text not null check (length(btrim(worker_id)) between 1 and 128),
  created_at timestamptz not null default clock_timestamp()
);
alter table private.github_enrichment_recovery_requests enable row level security;
revoke all on private.github_enrichment_recovery_requests from public, anon, authenticated, service_role;

create table private.github_enrichment_recovery_candidates (
  candidate_id uuid primary key references public.repository_candidates(id) on delete restrict,
  request_key text not null references private.github_enrichment_recovery_requests(request_key) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);
alter table private.github_enrichment_recovery_candidates enable row level security;
revoke all on private.github_enrichment_recovery_candidates from public, anon, authenticated, service_role;

create function private.guard_enrichment_recovery_records_append_only()
returns trigger language plpgsql set search_path = '' as $function$
begin
  raise exception 'enrichment recovery records are append-only' using errcode = '42501';
end;
$function$;
revoke all on function private.guard_enrichment_recovery_records_append_only() from public, anon, authenticated, service_role;
create trigger github_enrichment_recovery_requests_append_only
before update or delete on private.github_enrichment_recovery_requests
for each row execute function private.guard_enrichment_recovery_records_append_only();
create trigger github_enrichment_recovery_candidates_append_only
before update or delete on private.github_enrichment_recovery_candidates
for each row execute function private.guard_enrichment_recovery_records_append_only();

create function public.begin_github_enrichment_recovery(
  p_candidate_ids uuid[],
  p_worker_id text,
  p_max_releases integer default 5
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_ids uuid[];
  v_key text;
  v_job_id uuid;
  v_job public.ingestion_jobs%rowtype;
  v_candidate public.repository_candidates%rowtype;
  v_count integer;
  v_remaining integer;
  v_terminal_failures integer;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_candidate_ids is null or cardinality(p_candidate_ids) not between 1 and 5
    or exists (select 1 from unnest(p_candidate_ids) id where id is null)
    or length(btrim(p_worker_id)) not between 1 and 128
    or p_max_releases < 1 or p_max_releases > 20 then
    raise exception 'recovery requires one to five candidate IDs, a worker ID, and at most twenty releases' using errcode = '22023';
  end if;
  select array_agg(id order by id) into v_ids from (select distinct unnest(p_candidate_ids) id) candidates;
  if cardinality(v_ids) <> cardinality(p_candidate_ids) then
    raise exception 'recovery candidate IDs must be unique' using errcode = '22023';
  end if;
  v_key := encode(extensions.digest(convert_to(array_to_string(v_ids, ','), 'UTF8'), 'sha256'), 'hex');

  select r.job_id into v_job_id from private.github_enrichment_recovery_requests r where r.request_key = v_key;
  if found then
    select j.* into v_job from public.ingestion_jobs j where j.id = v_job_id for update;
    if not found then raise exception 'recovery job record is missing' using errcode = '55000'; end if;
    select count(*)::integer into v_terminal_failures
    from public.repository_candidates c where c.id = any(v_ids)
      and c.enrichment_status = 'failed' and c.enrichment_error = 'database_payload_validation';
    select count(*)::integer into v_remaining from public.repository_candidates c
    where c.id = any(v_ids) and (c.enrichment_status in ('queued', 'retry_wait')
      or (c.enrichment_status = 'processing' and c.enrichment_lease_expires_at <= v_now));
    if v_job.status = 'running' and v_job.metadata->>'worker_id' is distinct from p_worker_id
      and exists (select 1 from public.repository_candidates c where c.id = any(v_ids)
        and c.enrichment_status = 'processing' and c.enrichment_lease_expires_at > v_now) then
      raise exception 'another worker currently owns a recovery candidate' using errcode = '55P03';
    end if;
    if v_job.status in ('running', 'partial', 'failed', 'cancelled') and v_remaining > 0 then
      update public.ingestion_jobs set status = 'running', finished_at = null,
        metadata = metadata || jsonb_build_object('worker_id', p_worker_id), updated_at = v_now
      where id = v_job_id;
    end if;
    return jsonb_build_object('job_id', v_job_id, 'request_key', v_key, 'idempotent', true,
      'job_status', case when v_job.status in ('running', 'partial', 'failed', 'cancelled') and v_remaining > 0 then 'running' else v_job.status end,
      'terminal_failures', v_terminal_failures, 'candidate_count', cardinality(v_ids));
  end if;

  select count(*)::integer into v_count from public.repository_candidates c
  where c.id = any(v_ids) and c.provider = 'github' and c.enrichment_status = 'failed'
    and c.enrichment_error = 'database_payload_validation' and c.repository_id is null
    and c.queue_status = 'queued' and c.review_status <> 'rejected'
    and c.enrichment_lock_owner is null and c.enrichment_lease_token is null
    and not exists (select 1 from public.repositories r where r.provider = 'github'
      and r.provider_repository_id = c.provider_repository_id);
  if v_count <> cardinality(v_ids) then
    raise exception 'every recovery candidate must still be an undrafted terminal payload-validation failure' using errcode = '55000';
  end if;
  if exists (select 1 from private.github_enrichment_recovery_candidates c where c.candidate_id = any(v_ids)) then
    raise exception 'one or more candidates already used their bounded recovery attempt' using errcode = '55000';
  end if;
  for v_candidate in select c.* from public.repository_candidates c where c.id = any(v_ids) order by c.id for update loop
    if v_candidate.enrichment_status <> 'failed' or v_candidate.enrichment_error <> 'database_payload_validation'
      or v_candidate.repository_id is not null or v_candidate.queue_status <> 'queued' or v_candidate.review_status = 'rejected'
      or exists (select 1 from public.repositories r where r.provider = 'github'
        and r.provider_repository_id = v_candidate.provider_repository_id) then
      raise exception 'candidate eligibility changed during recovery preparation' using errcode = '40001';
    end if;
  end loop;

  insert into public.ingestion_jobs (job_type, provider, status, started_at, metadata, created_at, updated_at)
  values ('github_enrichment', 'github', 'running', v_now,
    jsonb_build_object('recovery_policy', 'database_payload_validation-v1', 'recovery_request_key', v_key,
      'recovery_candidate_ids', to_jsonb(v_ids), 'worker_id', p_worker_id,
      'max_releases', p_max_releases, 'cache_policy', 'no_conditional_requests'), v_now, v_now)
  returning id into v_job_id;
  insert into private.github_enrichment_recovery_requests (request_key, job_id, candidate_ids, worker_id, created_at)
  values (v_key, v_job_id, v_ids, p_worker_id, v_now);
  insert into private.github_enrichment_recovery_candidates (candidate_id, request_key, created_at)
  select id, v_key, v_now from unnest(v_ids) id;
  update public.repository_candidates set enrichment_status = 'queued', enrichment_attempts = 0,
    enrichment_max_attempts = 1, enrichment_next_attempt_at = null, enrichment_completed_at = null,
    enrichment_error = null, enrichment_job_id = v_job_id, updated_at = v_now
  where id = any(v_ids);
  return jsonb_build_object('job_id', v_job_id, 'request_key', v_key, 'idempotent', false,
    'job_status', 'running', 'terminal_failures', 0, 'candidate_count', cardinality(v_ids));
end;
$function$;
revoke all on function public.begin_github_enrichment_recovery(uuid[], text, integer) from public, anon, authenticated;
grant execute on function public.begin_github_enrichment_recovery(uuid[], text, integer) to service_role;

create function public.claim_github_enrichment_candidates_for_recovery(
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
language plpgsql security definer set search_path = '' as $function$
declare
  v_job public.ingestion_jobs%rowtype;
  v_candidate public.repository_candidates%rowtype;
  v_now timestamptz := clock_timestamp();
  v_item_new boolean := false;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_job_id is null or length(btrim(p_worker_id)) not between 1 and 128
    or p_limit is distinct from 1 or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'invalid bounded recovery claim parameters' using errcode = '22023';
  end if;
  select j.* into v_job from public.ingestion_jobs j
  where j.id = p_job_id and j.job_type = 'github_enrichment' and j.provider = 'github' and j.status = 'running'
  for update;
  if not found or v_job.metadata->>'recovery_policy' is distinct from 'database_payload_validation-v1'
    or v_job.metadata->>'worker_id' is distinct from p_worker_id then
    raise exception 'recovery job ownership or state is invalid' using errcode = '40001';
  end if;
  select c.* into v_candidate from public.repository_candidates c
  join private.github_enrichment_recovery_candidates x on x.candidate_id = c.id
  where x.request_key = v_job.metadata->>'recovery_request_key'
    and (c.enrichment_status in ('queued', 'retry_wait')
      or (c.enrichment_status = 'processing' and c.enrichment_lease_expires_at <= v_now))
    and c.enrichment_attempts < c.enrichment_max_attempts
    and c.review_status <> 'rejected' and c.queue_status = 'queued'
    and coalesce(c.enrichment_next_attempt_at, '-infinity'::timestamptz) <= v_now
  order by c.id limit 1 for update of c skip locked;
  if not found then return; end if;
  update public.repository_candidates c set enrichment_status = 'processing',
    enrichment_attempts = c.enrichment_attempts + 1, enrichment_next_attempt_at = null,
    enrichment_locked_at = v_now, enrichment_lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
    enrichment_lease_token = gen_random_uuid(), enrichment_lock_owner = p_worker_id,
    enrichment_job_id = p_job_id, enrichment_completed_at = null, enrichment_error = null, updated_at = v_now
  where c.id = v_candidate.id returning c.* into v_candidate;
  update public.ingestion_items i set status = 'retry_wait', locked_at = null, lock_owner = null,
    last_error = 'Recovery claim resumed the candidate.', updated_at = v_now
  where i.candidate_id = v_candidate.id and i.job_id <> p_job_id and i.status = 'processing';
  insert into public.ingestion_items (
    job_id, item_key, item_type, candidate_id, repository_id, status, attempts,
    max_attempts, locked_at, lock_owner, started_at
  ) values (
    p_job_id, 'github:' || v_candidate.provider_repository_id, 'github_repository',
    v_candidate.id, v_candidate.repository_id, 'processing', 1, v_candidate.enrichment_max_attempts,
    v_now, p_worker_id, v_now
  ) on conflict (job_id, item_key) do update set
    status = 'processing', attempts = public.ingestion_items.attempts + 1,
    max_attempts = excluded.max_attempts, locked_at = v_now, lock_owner = p_worker_id,
    started_at = coalesce(public.ingestion_items.started_at, v_now), finished_at = null,
    next_attempt_at = null, last_error = null, updated_at = v_now
  returning (xmax = 0) into v_item_new;
  if v_item_new then
    update public.ingestion_jobs j set items_discovered = j.items_discovered + 1, updated_at = v_now where j.id = p_job_id;
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
end;
$function$;
revoke all on function public.claim_github_enrichment_candidates_for_recovery(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_github_enrichment_candidates_for_recovery(uuid, text, integer, integer) to service_role;
