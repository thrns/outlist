-- M2-04 adds an explicit, bounded recovery path for one existing assessment
-- job. It creates neither jobs nor assessments and preserves the normal
-- worker's completion, failure, attempt-limit, and lease-fencing functions.

create function public.begin_github_repository_assessment_recovery(
  p_job_id uuid,
  p_worker_id text,
  p_max_assessments integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ingestion_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_open integer;
  v_queued integer;
  v_retry_wait integer;
  v_expired integer;
  v_owner text;
  v_owner_expires timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_job_id is null or nullif(btrim(p_worker_id), '') is null or length(p_worker_id) > 128
    or p_max_assessments is distinct from 4 then
    raise exception 'invalid assessment recovery request' using errcode = '22023';
  end if;

  select j.* into v_job from public.ingestion_jobs j
  where j.id = p_job_id and j.job_type = 'github_assessment' and j.provider = 'github'
  for update;
  if not found then
    raise exception 'the requested existing assessment job was not found' using errcode = '55000';
  end if;
  if v_job.status not in ('running', 'partial') then
    raise exception 'the requested assessment job is not recoverable' using errcode = '55000';
  end if;

  v_owner := v_job.metadata->>'assessment_recovery_worker_id';
  v_owner_expires := nullif(v_job.metadata->>'assessment_recovery_expires_at', '')::timestamptz;
  if v_owner is not null and v_owner_expires > v_now then
    raise exception 'another assessment recovery worker owns this job' using errcode = '55P03';
  end if;
  if exists (select 1 from public.discovery_queries q
    where q.status = 'running' and q.lease_expires_at > v_now)
    or exists (select 1 from public.repository_candidates c
      where c.enrichment_status = 'processing' and c.enrichment_lease_expires_at > v_now)
    or exists (select 1 from public.repository_assessments a
      where a.status = 'processing' and a.lease_expires_at > v_now)
    or exists (select 1 from public.project_logos l
      where l.approval_token is not null and l.approval_lease_expires_at > v_now) then
    raise exception 'an unexpired ingestion lease is active' using errcode = '55P03';
  end if;

  select count(*)::integer,
    (count(*) filter (where a.status = 'queued'))::integer,
    (count(*) filter (where a.status = 'retry_wait'))::integer,
    (count(*) filter (where a.status = 'processing' and a.lease_expires_at <= v_now))::integer
  into v_open, v_queued, v_retry_wait, v_expired
  from public.repository_assessments a
  where a.job_id = p_job_id and a.status in ('queued', 'retry_wait', 'processing');
  if v_open = 0 then
    raise exception 'the requested assessment job has no unfinished assessments' using errcode = '55000';
  end if;
  if v_open > p_max_assessments then
    raise exception 'the assessment job exceeds the four-item recovery limit' using errcode = '22023';
  end if;

  update public.ingestion_jobs set status = 'running',
    started_at = coalesce(started_at, v_now), finished_at = null,
    metadata = metadata || jsonb_build_object(
      'assessment_recovery_worker_id', p_worker_id,
      'assessment_recovery_expires_at', (v_now + interval '15 minutes')
    ), updated_at = v_now
  where id = p_job_id;

  return jsonb_build_object(
    'job_id', p_job_id, 'previous_status', v_job.status, 'status', 'running',
    'open_assessments', v_open, 'queued_assessments', v_queued,
    'retry_wait_assessments', v_retry_wait, 'expired_processing_assessments', v_expired,
    'max_assessments', p_max_assessments
  );
end;
$function$;

create function public.claim_github_repository_assessments_for_recovery(
  p_job_id uuid,
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 900
) returns table (
  assessment_id uuid,
  repository_id uuid,
  provider_repository_id text,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_job public.ingestion_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_job_id is null or nullif(btrim(p_worker_id), '') is null or length(p_worker_id) > 128
    or p_limit < 1 or p_limit > 4 or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'invalid assessment recovery claim parameters' using errcode = '22023';
  end if;
  select j.* into v_job from public.ingestion_jobs j
  where j.id = p_job_id and j.job_type = 'github_assessment' and j.provider = 'github'
    and j.status = 'running'
  for update;
  if not found or v_job.metadata->>'assessment_recovery_worker_id' is distinct from p_worker_id
    or nullif(v_job.metadata->>'assessment_recovery_expires_at', '')::timestamptz <= v_now then
    raise exception 'assessment recovery ownership is stale' using errcode = '40001';
  end if;
  if exists (select 1 from public.discovery_queries q
    where q.status = 'running' and q.lease_expires_at > v_now)
    or exists (select 1 from public.repository_candidates c
      where c.enrichment_status = 'processing' and c.enrichment_lease_expires_at > v_now)
    or exists (select 1 from public.repository_assessments a
      where a.status = 'processing' and a.lease_expires_at > v_now and a.lock_owner is distinct from p_worker_id)
    or exists (select 1 from public.project_logos l
      where l.approval_token is not null and l.approval_lease_expires_at > v_now) then
    raise exception 'another unexpired worker lease is active' using errcode = '55P03';
  end if;

  with exhausted as (
    update public.repository_assessments a set status = 'needs_review', assessed_at = v_now,
      last_error = 'Assessment lease expired after the retry limit.', locked_at = null,
      lock_owner = null, lease_expires_at = null, lease_token = null, next_attempt_at = null,
      updated_at = v_now
    where a.job_id = p_job_id and a.policy_version = 'm1-04-assessment-v1'
      and a.attempts >= a.max_attempts
      and ((a.status = 'processing' and a.lease_expires_at <= v_now)
        or (a.status = 'retry_wait' and a.next_attempt_at <= v_now))
    returning a.id, a.repository_id, a.job_id
  ), review_items as (
    insert into public.review_queue (project_id, repository_id, assessment_id, reason, status)
    select r.project_id, case when r.project_id is null then r.id else null end, e.id,
      'Assessment worker exhausted its retry limit; review the source evidence.', 'open'
    from exhausted e join public.repositories r on r.id = e.repository_id
    where not exists (select 1 from public.review_queue q where q.status in ('open', 'in_review')
      and ((r.project_id is not null and q.project_id = r.project_id)
        or (r.project_id is null and q.repository_id = r.id)))
    on conflict (assessment_id) where public.review_queue.assessment_id is not null
      and public.review_queue.status in ('open', 'in_review') do nothing
    returning public.review_queue.assessment_id
  ), counts as (
    select job_id, count(*)::integer as count from exhausted group by job_id
  )
  update public.ingestion_jobs j set items_processed = j.items_processed + c.count,
    items_failed = j.items_failed + c.count,
    metadata = j.metadata || jsonb_build_object(
      'failed', coalesce((j.metadata->>'failed')::integer, 0) + c.count,
      'queued_for_review', coalesce((j.metadata->>'queued_for_review')::integer, 0) + c.count
    ), updated_at = v_now
  from counts c where j.id = c.job_id;

  return query
  with picked as (
    select a.id from public.repository_assessments a
    where a.job_id = p_job_id and a.policy_version = 'm1-04-assessment-v1'
      and a.attempts < a.max_attempts and (
        a.status = 'queued'
        or (a.status = 'retry_wait' and coalesce(a.next_attempt_at, '-infinity'::timestamptz) <= v_now)
        or (a.status = 'processing' and a.lease_expires_at <= v_now)
      ) and exists (select 1 from public.repositories r
        where r.id = a.repository_id and r.source_observed_at = a.source_observed_at)
    order by coalesce(a.next_attempt_at, a.created_at), a.id
    limit p_limit for update skip locked
  ), claimed as (
    update public.repository_assessments a set status = 'processing',
      attempts = a.attempts + 1, next_attempt_at = null, locked_at = v_now,
      lock_owner = p_worker_id, lease_token = gen_random_uuid(),
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds), updated_at = v_now
    from picked p where a.id = p.id
    returning a.id, a.repository_id, a.lease_token, a.lease_expires_at
  )
  select c.id, c.repository_id, r.provider_repository_id, c.lease_token, c.lease_expires_at
  from claimed c join public.repositories r on r.id = c.repository_id order by c.id;
end;
$function$;

create function public.finish_github_repository_assessment_recovery(
  p_job_id uuid,
  p_worker_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ingestion_jobs%rowtype;
  v_open integer;
  v_live integer;
  v_status text;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select j.* into v_job from public.ingestion_jobs j
  where j.id = p_job_id and j.job_type = 'github_assessment' and j.status = 'running'
  for update;
  if not found or v_job.metadata->>'assessment_recovery_worker_id' is distinct from p_worker_id
    or nullif(v_job.metadata->>'assessment_recovery_expires_at', '')::timestamptz <= v_now then
    raise exception 'assessment recovery ownership is stale' using errcode = '40001';
  end if;
  select count(*)::integer into v_live from public.repository_assessments a
  where a.job_id = p_job_id and a.status = 'processing' and a.lease_expires_at > v_now;
  select count(*)::integer into v_open from public.repository_assessments a
  where a.job_id = p_job_id and a.status in ('queued', 'retry_wait', 'processing');
  if v_live > 0 then
    return jsonb_build_object('status', 'lease_active', 'job_status', 'running',
      'open_assessments', v_open, 'active_leases', v_live);
  end if;
  v_status := case when v_open > 0 or v_job.items_failed > 0 then 'partial' else 'succeeded' end;
  update public.ingestion_jobs set status = v_status, finished_at = v_now,
    metadata = metadata - 'assessment_recovery_worker_id' - 'assessment_recovery_expires_at',
    updated_at = v_now where id = p_job_id;
  return jsonb_build_object('status', v_status, 'job_status', v_status,
    'open_assessments', v_open, 'active_leases', 0);
end;
$function$;

-- Keep legacy assessment mutations from stealing or reassigning a job while
-- the explicit recovery owner holds its short-lived job fence.
create function private.guard_assessment_recovery_ownership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_metadata jsonb;
  v_owner text;
  v_expires timestamptz;
begin
  if old.job_id is null then return new; end if;
  select j.metadata into v_metadata from public.ingestion_jobs j where j.id = old.job_id;
  if not found then return new; end if;
  v_owner := v_metadata->>'assessment_recovery_worker_id';
  v_expires := nullif(v_metadata->>'assessment_recovery_expires_at', '')::timestamptz;
  if v_owner is null or v_expires is null or v_expires <= clock_timestamp() then return new; end if;
  if new.job_id is distinct from old.job_id then
    raise exception 'assessment job is fenced for recovery' using errcode = '40001';
  end if;
  if new.status = 'processing' and new.lock_owner is distinct from v_owner then
    raise exception 'assessment worker is fenced by recovery ownership' using errcode = '40001';
  end if;
  if old.status = 'processing' and old.lock_owner is distinct from v_owner
    and old.lease_expires_at > clock_timestamp() then
    raise exception 'stale assessment worker is fenced by recovery ownership' using errcode = '40001';
  end if;
  return new;
end;
$function$;
revoke all on function private.guard_assessment_recovery_ownership() from public, anon, authenticated, service_role;
create trigger repository_assessments_95_recovery_ownership
before update on public.repository_assessments
for each row execute function private.guard_assessment_recovery_ownership();

revoke all on function public.begin_github_repository_assessment_recovery(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.claim_github_repository_assessments_for_recovery(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_github_repository_assessment_recovery(uuid, text) from public, anon, authenticated;
grant execute on function public.begin_github_repository_assessment_recovery(uuid, text, integer) to service_role;
grant execute on function public.claim_github_repository_assessments_for_recovery(uuid, text, integer, integer) to service_role;
grant execute on function public.finish_github_repository_assessment_recovery(uuid, text) to service_role;

-- Extend the existing operator report's migration and RPC preflight without
-- changing its inventory, audit, active-lease, or retry reporting.
alter function public.pipeline_operator_report() rename to pipeline_operator_report_m2_04_previous;
revoke all on function public.pipeline_operator_report_m2_04_previous() from public, anon, authenticated, service_role;

create function public.pipeline_operator_report()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_report jsonb;
  v_schema jsonb;
  v_expected jsonb;
  v_applied jsonb;
  v_missing jsonb;
  v_migration_applied boolean := false;
  v_recovery_rpcs jsonb;
  v_missing_recovery_rpcs text[] := array[]::text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  v_report := public.pipeline_operator_report_m2_04_previous();
  v_schema := v_report->'schema';
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select exists (select 1 from supabase_migrations.schema_migrations where version::text = $1)'
      into v_migration_applied using '20261109100000';
  end if;
  v_expected := coalesce(v_schema->'expected_migrations', '[]'::jsonb) || jsonb_build_array('20261109100000');
  v_applied := coalesce(v_schema->'applied_migrations', '[]'::jsonb)
    || case when v_migration_applied then jsonb_build_array('20261109100000') else '[]'::jsonb end;
  v_missing := coalesce(v_schema->'missing_migrations', '[]'::jsonb)
    || case when v_migration_applied then '[]'::jsonb else jsonb_build_array('20261109100000') end;
  with required(signature) as (values
    ('public.begin_github_repository_assessment_recovery(uuid,text,integer)'),
    ('public.claim_github_repository_assessments_for_recovery(uuid,text,integer,integer)'),
    ('public.finish_github_repository_assessment_recovery(uuid,text)')
  ), checked as (
    select signature, to_regprocedure(signature) as proc from required
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'signature', signature, 'exists', proc is not null,
      'service_role_execute', case when proc is null then false
        else has_function_privilege('service_role', proc, 'EXECUTE') end
    ) order by signature), '[]'::jsonb),
    coalesce(array_agg(signature) filter (where proc is null
      or not has_function_privilege('service_role', proc, 'EXECUTE')), array[]::text[])
  into v_recovery_rpcs, v_missing_recovery_rpcs from checked;
  v_schema := jsonb_set(v_schema, '{expected_migrations}', v_expected, true);
  v_schema := jsonb_set(v_schema, '{applied_migrations}', v_applied, true);
  v_schema := jsonb_set(v_schema, '{missing_migrations}', v_missing, true);
  v_schema := jsonb_set(v_schema, '{required_rpcs}',
    coalesce(v_schema->'required_rpcs', '[]'::jsonb) || v_recovery_rpcs, true);
  v_schema := jsonb_set(v_schema, '{missing_rpcs}',
    coalesce(v_schema->'missing_rpcs', '[]'::jsonb) || to_jsonb(v_missing_recovery_rpcs), true);
  v_schema := jsonb_set(v_schema, '{missing_service_role_permissions}',
    coalesce(v_schema->'missing_service_role_permissions', '[]'::jsonb)
      || to_jsonb(v_missing_recovery_rpcs), true);
  v_schema := jsonb_set(v_schema, '{ready}', to_jsonb(
    coalesce((v_schema->>'ready')::boolean, false) and v_migration_applied
      and cardinality(v_missing_recovery_rpcs) = 0), true);
  v_report := jsonb_set(v_report, '{report_version}', '"m2-04-v1"'::jsonb, true);
  return jsonb_set(v_report, '{schema}', v_schema, true);
end;
$function$;
revoke all on function public.pipeline_operator_report() from public, anon, authenticated;
grant execute on function public.pipeline_operator_report() to service_role;
