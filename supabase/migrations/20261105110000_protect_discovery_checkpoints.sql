-- Make plan registration checkpoint-safe. Existing definitions are immutable
-- within a plan version; an intentional definition change needs a new version.
create or replace function public.start_discovery_job(
  p_plan_name text,
  p_plan_version text,
  p_partitions jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job_id uuid;
  v_partition jsonb;
  v_key text;
  v_provider text;
  v_query text;
  v_fingerprint text;
  v_existing public.discovery_queries%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if nullif(btrim(p_plan_name), '') is null or nullif(btrim(p_plan_version), '') is null
    or jsonb_typeof(p_partitions) is distinct from 'array' or jsonb_array_length(p_partitions) < 1
    or jsonb_array_length(p_partitions) > 100 then
    raise exception 'invalid discovery plan registration' using errcode = '22023';
  end if;

  insert into public.ingestion_jobs (job_type, provider, status, started_at, metadata)
  values (
    'github_discovery', 'github', 'running', clock_timestamp(),
    jsonb_build_object('plan_name', p_plan_name, 'plan_version', p_plan_version)
  ) returning id into v_job_id;

  for v_partition in
    select p.value from jsonb_array_elements(p_partitions) as p(value)
    order by p.value->>'partition_key'
  loop
    v_key := v_partition->>'partition_key';
    v_provider := v_partition->>'provider';
    v_query := v_partition->>'query_text';
    v_fingerprint := v_partition->>'query_fingerprint';
    if nullif(btrim(v_key), '') is null or v_provider is distinct from 'github'
      or nullif(btrim(v_query), '') is null or length(v_query) > 256
      or nullif(btrim(v_fingerprint), '') is null
      or jsonb_typeof(v_partition->'query_parameters') is distinct from 'object'
      or jsonb_typeof(v_partition->'query_parameters'->'per_page') is distinct from 'number'
      or (v_partition->'query_parameters'->>'per_page') !~ '^([1-9][0-9]?|100)$'
      or coalesce(v_partition->'query_parameters'->>'sort', 'stars') not in ('stars', 'forks', 'help-wanted-issues', 'updated')
      or coalesce(v_partition->'query_parameters'->>'order', 'desc') not in ('asc', 'desc')
      or jsonb_typeof(v_partition->'date_range') is distinct from 'object' then
      raise exception 'invalid partition definition for key %', coalesce(v_key, '<empty>') using errcode = '22023';
    end if;

    -- Insert only missing rows, then lock the canonical row before inspecting
    -- or changing it. This serializes concurrent registrations with claims and
    -- page commits, including two registrations racing on a new partition.
    insert into public.discovery_queries (
      provider, partition_key, query_text, status, plan_name, plan_version,
      query_fingerprint, query_parameters, date_range, intended_coverage
    ) values (
      v_provider, v_key, v_query, 'pending', p_plan_name, p_plan_version,
      v_fingerprint, v_partition->'query_parameters', v_partition->'date_range',
      coalesce(v_partition->>'intended_coverage', 'Approved GitHub repository search partition.')
    ) on conflict (provider, partition_key) do nothing;

    select q.* into v_existing
    from public.discovery_queries q
    where q.provider = v_provider and q.partition_key = v_key
    for update;
    if not found then
      raise exception 'discovery partition % disappeared during registration', v_key using errcode = '40001';
    end if;

    if v_existing.plan_name = p_plan_name
      and v_existing.plan_version = p_plan_version
      and v_existing.query_fingerprint = v_fingerprint
      and v_existing.query_text = v_query
      and v_existing.query_parameters = v_partition->'query_parameters'
      and v_existing.date_range = v_partition->'date_range' then
      -- Exact registration is deliberately a no-op: in particular it does not
      -- refresh leases, timestamps, job ownership, checkpoints, or counters.
      continue;
    end if;

    if v_existing.status = 'running' and v_existing.lease_expires_at > clock_timestamp() then
      raise exception 'active discovery lease prevents incompatible plan registration for partition %', v_key
        using errcode = '55000';
    end if;
    if v_existing.plan_version = p_plan_version then
      raise exception 'incompatible discovery definition for partition %; keep its checkpoint and use a new plan version or an explicit reset migration', v_key
        using errcode = '55000';
    end if;

    -- A changed fingerprint is reset only when the caller deliberately bumps
    -- the plan version. Candidate rows and source provenance are not touched.
    update public.discovery_queries q set
      plan_name = p_plan_name,
      plan_version = p_plan_version,
      query_text = v_query,
      query_fingerprint = v_fingerprint,
      query_parameters = v_partition->'query_parameters',
      date_range = v_partition->'date_range',
      intended_coverage = coalesce(v_partition->>'intended_coverage', 'Approved GitHub repository search partition.'),
      status = 'pending',
      cursor = null,
      pages_fetched = 0,
      candidates_found = 0,
      total_count = null,
      incomplete_results = false,
      retry_count = 0,
      next_attempt_at = null,
      started_at = null,
      finished_at = null,
      last_error = null,
      job_id = null,
      locked_at = null,
      lock_owner = null,
      lease_expires_at = null,
      lease_token = null,
      updated_at = clock_timestamp()
    where q.id = v_existing.id;
  end loop;

  return v_job_id;
end;
$function$;
