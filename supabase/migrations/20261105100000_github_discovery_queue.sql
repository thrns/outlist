-- Durable GitHub discovery partitions, page commits, and worker fencing.

alter table public.discovery_queries
  add column plan_name text not null default 'legacy',
  add column plan_version text not null default 'legacy-v1',
  add column query_fingerprint text not null default 'legacy',
  add column query_parameters jsonb not null default '{}'::jsonb
    check (jsonb_typeof(query_parameters) = 'object'),
  add column date_range jsonb not null default '{}'::jsonb
    check (jsonb_typeof(date_range) = 'object'),
  add column intended_coverage text not null default 'Legacy discovery query.',
  add column parent_query_id uuid references public.discovery_queries(id) on delete set null,
  add column job_id uuid references public.ingestion_jobs(id) on delete set null,
  add column total_count integer check (total_count is null or total_count >= 0),
  add column incomplete_results boolean not null default false,
  add column retry_count integer not null default 0 check (retry_count >= 0),
  add column max_attempts integer not null default 5 check (max_attempts > 0),
  add column next_attempt_at timestamptz,
  add column locked_at timestamptz,
  add column lock_owner text,
  add column lease_expires_at timestamptz,
  add column lease_token uuid;

alter table public.discovery_queries drop constraint discovery_queries_status_check;
-- Rows left running by the pre-lease worker cannot prove ownership and must be
-- returned to the queue before enforcing the new lease-state invariant.
update public.discovery_queries
set status = 'pending', locked_at = null, lock_owner = null,
    lease_expires_at = null, lease_token = null, finished_at = null,
    updated_at = clock_timestamp()
where status = 'running';
alter table public.discovery_queries add constraint discovery_queries_status_check
  check (status in ('pending', 'running', 'retry_wait', 'completed', 'failed', 'paused', 'needs_review'));
alter table public.discovery_queries add constraint discovery_queries_lease_state check (
  (status = 'running' and locked_at is not null and lease_expires_at is not null
    and lease_token is not null and nullif(btrim(lock_owner), '') is not null)
  or (status <> 'running' and locked_at is null and lease_expires_at is null
    and lease_token is null and lock_owner is null)
);
create index discovery_queries_claim_idx
  on public.discovery_queries (status, next_attempt_at, created_at, partition_key);
create index discovery_queries_parent_idx on public.discovery_queries (parent_query_id);

alter table public.repository_candidates
  add column owner_login text,
  add column description text,
  add column primary_language text,
  add column stars bigint not null default 0 check (stars >= 0),
  add column forks bigint not null default 0 check (forks >= 0),
  add column provider_created_at timestamptz,
  add column provider_updated_at timestamptz,
  add column provider_pushed_at timestamptz,
  add column topics text[] not null default '{}'::text[],
  add column source_license_summary jsonb
    check (source_license_summary is null or jsonb_typeof(source_license_summary) = 'object'),
  add column review_status text not null default 'unreviewed'
    check (review_status in ('unreviewed', 'accepted', 'rejected'));

alter table public.source_records
  add column source_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_metadata) = 'object');

create table public.repository_candidate_sources (
  candidate_id uuid not null references public.repository_candidates(id) on delete cascade,
  source_record_id uuid not null references public.source_records(id) on delete restrict,
  discovery_query_id uuid not null references public.discovery_queries(id) on delete cascade,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (candidate_id, source_record_id)
);
create index repository_candidate_sources_query_idx
  on public.repository_candidate_sources (discovery_query_id, fetched_at desc);

alter table public.repository_candidate_sources enable row level security;
revoke all on public.repository_candidate_sources from public, anon, authenticated;
grant all privileges on public.repository_candidate_sources to service_role;

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

  for v_partition in select value from jsonb_array_elements(p_partitions)
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

    insert into public.discovery_queries (
      provider, partition_key, query_text, status, plan_name, plan_version,
      query_fingerprint, query_parameters, date_range, intended_coverage
    ) values (
      v_provider, v_key, v_query, 'pending', p_plan_name, p_plan_version,
      v_fingerprint, v_partition->'query_parameters', v_partition->'date_range',
      coalesce(v_partition->>'intended_coverage', 'Approved GitHub repository search partition.')
    )
    on conflict (provider, partition_key) do update set
      plan_name = excluded.plan_name,
      plan_version = excluded.plan_version,
      query_text = excluded.query_text,
      query_parameters = excluded.query_parameters,
      date_range = excluded.date_range,
      intended_coverage = excluded.intended_coverage,
      cursor = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then null else public.discovery_queries.cursor end,
      pages_fetched = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then 0 else public.discovery_queries.pages_fetched end,
      candidates_found = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then 0 else public.discovery_queries.candidates_found end,
      total_count = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then null else public.discovery_queries.total_count end,
      incomplete_results = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then false else public.discovery_queries.incomplete_results end,
      status = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then 'pending' else public.discovery_queries.status end,
      finished_at = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then null else public.discovery_queries.finished_at end,
      last_error = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then null else public.discovery_queries.last_error end,
      retry_count = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then 0 else public.discovery_queries.retry_count end,
      job_id = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then null else public.discovery_queries.job_id end,
      next_attempt_at = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then null else public.discovery_queries.next_attempt_at end,
      locked_at = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then null else public.discovery_queries.locked_at end,
      lock_owner = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then null else public.discovery_queries.lock_owner end,
      lease_expires_at = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then null else public.discovery_queries.lease_expires_at end,
      lease_token = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint
        then null else public.discovery_queries.lease_token end,
      query_fingerprint = excluded.query_fingerprint,
      updated_at = clock_timestamp();
  end loop;
  return v_job_id;
end;
$function$;

create or replace function public.claim_discovery_partitions(
  p_job_id uuid,
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 180
) returns table (
  id uuid,
  partition_key text,
  query_text text,
  query_parameters jsonb,
  query_fingerprint text,
  cursor jsonb,
  total_count integer,
  incomplete_results boolean,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan_name text;
  v_plan_version text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if nullif(btrim(p_worker_id), '') is null or length(p_worker_id) > 128
    or p_limit < 1 or p_limit > 20 or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'invalid discovery claim parameters' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.ingestion_jobs j where j.id = p_job_id
      and j.job_type = 'github_discovery' and j.status = 'running'
  ) then
    raise exception 'discovery job is not running' using errcode = '22023';
  end if;
  select j.metadata->>'plan_name', j.metadata->>'plan_version'
    into v_plan_name, v_plan_version
  from public.ingestion_jobs j where j.id = p_job_id;

  with exhausted as (
    update public.discovery_queries q
    set status = 'failed', finished_at = clock_timestamp(), locked_at = null,
        lock_owner = null, lease_token = null, lease_expires_at = null,
        last_error = 'Partition exceeded the configured retry limit.', updated_at = clock_timestamp()
    where q.plan_name = v_plan_name and q.plan_version = v_plan_version
      and q.retry_count >= q.max_attempts and (
      (q.status = 'running' and q.lease_expires_at <= clock_timestamp())
      or (q.status = 'retry_wait' and q.next_attempt_at <= clock_timestamp())
    )
    returning q.job_id
  ), failures as (
    select job_id, count(*)::integer as failure_count
    from exhausted where job_id is not null group by job_id
  )
  update public.ingestion_jobs j
  set items_failed = j.items_failed + f.failure_count,
      error_summary = 'One or more discovery partitions exceeded the retry limit.',
      updated_at = clock_timestamp()
  from failures f where j.id = f.job_id;

  return query
  with picked as (
    select q.id
    from public.discovery_queries q
    where q.plan_name = v_plan_name and q.plan_version = v_plan_version
      and q.retry_count < q.max_attempts and (
      q.status = 'pending'
      or (q.status = 'retry_wait' and coalesce(q.next_attempt_at, '-infinity'::timestamptz) <= clock_timestamp())
      or (q.status = 'running' and q.lease_expires_at <= clock_timestamp())
    )
    order by coalesce(q.next_attempt_at, q.created_at), q.partition_key
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.discovery_queries q
    set status = 'running', job_id = p_job_id, started_at = coalesce(q.started_at, clock_timestamp()),
        finished_at = null, retry_count = q.retry_count + 1, locked_at = clock_timestamp(),
        lock_owner = p_worker_id, lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
        next_attempt_at = null, updated_at = clock_timestamp()
    from picked p where q.id = p.id
    returning q.id, q.partition_key, q.query_text, q.query_parameters, q.query_fingerprint,
      q.cursor, q.total_count, q.incomplete_results, q.lease_token, q.lease_expires_at
  )
  select c.id, c.partition_key, c.query_text, c.query_parameters, c.query_fingerprint,
    c.cursor, c.total_count, c.incomplete_results, c.lease_token, c.lease_expires_at
  from claimed c order by c.partition_key;
end;
$function$;

create or replace function public.commit_discovery_page(
  p_query_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_query_fingerprint text,
  p_page integer,
  p_fetched_at timestamptz,
  p_source_url text,
  p_http_status integer,
  p_source_metadata jsonb,
  p_total_count integer,
  p_incomplete_results boolean,
  p_per_page integer,
  p_candidates jsonb,
  p_next_state text,
  p_children jsonb default '[]'::jsonb,
  p_lease_seconds integer default 180
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_query public.discovery_queries%rowtype;
  v_source_id uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_candidate_count integer := 0;
  v_next_page integer;
  v_status text;
  v_child jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_page < 1 or p_total_count < 0 or p_per_page < 1 or p_per_page > 100
    or p_page * p_per_page > 1000 or p_http_status <> 200
    or p_next_state is null or p_next_state not in ('more', 'yield', 'exhausted', 'review')
      or jsonb_typeof(p_source_metadata) is distinct from 'object'
      or jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_array_length(p_candidates) > p_per_page
    or jsonb_typeof(p_children) is distinct from 'array' or jsonb_array_length(p_children) > 2
    or p_lease_seconds < 30 or p_lease_seconds > 3600
    or p_source_url !~ '^https://api\.github\.com/search/repositories\?'
    or lower(p_source_url) ~ '(token|authorization|secret|password)=' then
    raise exception 'invalid discovery page payload' using errcode = '22023';
  end if;

  select q.* into v_query from public.discovery_queries q where q.id = p_query_id for update;
  if not found or v_query.query_fingerprint is distinct from p_query_fingerprint then
    raise exception 'discovery claim is stale or incompatible' using errcode = '40001';
  end if;
  v_next_page := coalesce((v_query.cursor->>'next_page')::integer, 1);
  if p_page < v_next_page then
    if exists (
      select 1 from public.source_records s
      where s.provider = 'github' and s.record_kind = 'discovery_page'
        and s.source_key = v_query.partition_key || ':page:' || p_page::text || ':' || v_query.query_fingerprint
    ) then
      return jsonb_build_object('committed', false, 'reason', 'already_committed', 'next_page', v_next_page);
    end if;
    raise exception 'page checkpoint has no committed provenance record' using errcode = '40001';
  elsif p_page <> v_next_page then
    raise exception 'page checkpoint mismatch; expected %, got %', v_next_page, p_page using errcode = '40001';
  end if;
  if v_query.status <> 'running' or v_query.lock_owner is distinct from p_worker_id
    or v_query.lease_token is distinct from p_lease_token
    or v_query.lease_expires_at <= clock_timestamp() then
    raise exception 'discovery claim is stale or incompatible' using errcode = '40001';
  end if;
  if p_per_page <> coalesce((v_query.query_parameters->>'per_page')::integer, 100) then
    raise exception 'page size differs from the registered query definition' using errcode = '22023';
  end if;
  if p_fetched_at is null or p_fetched_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid source fetch time' using errcode = '22023';
  end if;
  if (p_incomplete_results or p_total_count > 1000
      or (p_page * p_per_page >= 1000 and p_total_count > p_page * p_per_page))
    and p_next_state = 'exhausted' then
    raise exception 'incomplete or saturated search cannot be marked exhausted' using errcode = '22023';
  end if;
  if p_next_state = 'review' and jsonb_array_length(p_children) not in (0, 2) then
    raise exception 'partition split must provide exactly two children' using errcode = '22023';
  end if;

  insert into public.source_records (
    provider, record_kind, source_key, source_url, fetched_at, http_status,
    raw_payload, reuse_context, source_metadata
  ) values (
    'github', 'discovery_page',
    v_query.partition_key || ':page:' || p_page::text || ':' || v_query.query_fingerprint,
    p_source_url, p_fetched_at, p_http_status, null,
    'Validated GitHub repository search page; individual candidate metadata is stored separately.',
    p_source_metadata
  ) returning id into v_source_id;

  with payload as (
    select distinct on (r.provider_repository_id)
      r.provider_repository_id, r.owner_login, r.full_name, r.canonical_url, r.description,
      r.primary_language, r.stars, r.forks, r.provider_created_at, r.provider_updated_at,
      r.provider_pushed_at, r.topics, r.source_license_summary
    from jsonb_to_recordset(p_candidates) as r(
      provider_repository_id text,
      owner_login text,
      full_name text,
      canonical_url text,
      description text,
      primary_language text,
      stars bigint,
      forks bigint,
      provider_created_at timestamptz,
      provider_updated_at timestamptz,
      provider_pushed_at timestamptz,
      topics text[],
      source_license_summary jsonb
    )
    order by r.provider_repository_id, r.provider_updated_at desc nulls last, r.full_name
  ), upserted as (
    insert into public.repository_candidates (
      provider, provider_repository_id, owner_login, full_name, canonical_url, source_record_id,
      discovery_query_id, description, primary_language, stars, forks,
      provider_created_at, provider_updated_at, provider_pushed_at, topics,
      source_license_summary, first_seen_at, last_seen_at
    )
    select 'github', p.provider_repository_id, p.owner_login, p.full_name, p.canonical_url, v_source_id,
      v_query.id, p.description, p.primary_language, coalesce(p.stars, 0), coalesce(p.forks, 0),
      p.provider_created_at, p.provider_updated_at, p.provider_pushed_at, coalesce(p.topics, '{}'::text[]),
      p.source_license_summary, p_fetched_at, p_fetched_at
    from payload p
    on conflict (provider, provider_repository_id) do update set
      owner_login = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.owner_login else public.repository_candidates.owner_login end,
      full_name = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.full_name else public.repository_candidates.full_name end,
      canonical_url = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.canonical_url else public.repository_candidates.canonical_url end,
      description = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.description else public.repository_candidates.description end,
      primary_language = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.primary_language else public.repository_candidates.primary_language end,
      stars = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.stars else public.repository_candidates.stars end,
      forks = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.forks else public.repository_candidates.forks end,
      provider_created_at = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.provider_created_at else public.repository_candidates.provider_created_at end,
      provider_updated_at = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.provider_updated_at else public.repository_candidates.provider_updated_at end,
      provider_pushed_at = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.provider_pushed_at else public.repository_candidates.provider_pushed_at end,
      topics = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.topics else public.repository_candidates.topics end,
      source_license_summary = case when excluded.last_seen_at >= public.repository_candidates.last_seen_at then excluded.source_license_summary else public.repository_candidates.source_license_summary end,
      last_seen_at = greatest(public.repository_candidates.last_seen_at, excluded.last_seen_at),
      updated_at = greatest(public.repository_candidates.updated_at, excluded.last_seen_at)
    returning id, provider_repository_id, (xmax = 0) as inserted
  ), linked as (
    insert into public.repository_candidate_sources (candidate_id, source_record_id, discovery_query_id, fetched_at)
    select u.id, v_source_id, v_query.id, p_fetched_at from upserted u
    on conflict (candidate_id, source_record_id) do update
      set fetched_at = greatest(public.repository_candidate_sources.fetched_at, excluded.fetched_at)
    returning candidate_id
  )
  select count(*) filter (where u.inserted)::integer,
    count(*) filter (where not u.inserted)::integer,
    count(*)::integer
  into v_inserted, v_updated, v_candidate_count from upserted u;

  update public.discovery_queries q
  set pages_fetched = q.pages_fetched + 1,
      candidates_found = q.candidates_found + v_candidate_count,
      retry_count = 0,
      cursor = jsonb_build_object(
        'next_page', p_page + 1, 'last_page', p_page,
        'total_count', p_total_count, 'per_page', p_per_page,
        'incomplete_results', p_incomplete_results,
        'retrievable_window', 1000, 'last_committed_at', p_fetched_at
      ),
      total_count = p_total_count,
      incomplete_results = p_incomplete_results,
      last_error = null,
      updated_at = clock_timestamp()
  where q.id = v_query.id;

  update public.ingestion_jobs j
  set items_discovered = j.items_discovered + v_candidate_count,
      items_created = j.items_created + v_inserted,
      items_updated = j.items_updated + v_updated,
      items_processed = j.items_processed + v_candidate_count,
      updated_at = clock_timestamp()
  where j.id = v_query.job_id;

  if p_next_state = 'more' then
    update public.discovery_queries q set locked_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp() where q.id = v_query.id;
    v_status := 'running';
  elsif p_next_state = 'yield' then
    update public.discovery_queries q set status = 'pending', locked_at = null, lock_owner = null,
      lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
      where q.id = v_query.id;
    v_status := 'pending';
  elsif p_next_state = 'exhausted' then
    update public.discovery_queries q set status = 'completed', finished_at = clock_timestamp(),
      locked_at = null, lock_owner = null, lease_token = null, lease_expires_at = null,
      updated_at = clock_timestamp() where q.id = v_query.id;
    v_status := 'completed';
  else
    for v_child in select value from jsonb_array_elements(p_children)
    loop
      if nullif(v_child->>'partition_key', '') is null or v_child->>'provider' is distinct from 'github'
        or nullif(v_child->>'query_text', '') is null
        or length(v_child->>'query_text') > 256
        or nullif(v_child->>'query_fingerprint', '') is null
        or jsonb_typeof(v_child->'query_parameters') is distinct from 'object'
        or jsonb_typeof(v_child->'query_parameters'->'per_page') is distinct from 'number'
        or (v_child->'query_parameters'->>'per_page') !~ '^([1-9][0-9]?|100)$'
        or coalesce(v_child->'query_parameters'->>'sort', 'stars') not in ('stars', 'forks', 'help-wanted-issues', 'updated')
        or coalesce(v_child->'query_parameters'->>'order', 'desc') not in ('asc', 'desc')
        or jsonb_typeof(v_child->'date_range') is distinct from 'object' then
        raise exception 'invalid child partition definition' using errcode = '22023';
      end if;
      insert into public.discovery_queries (
        provider, partition_key, query_text, plan_name, plan_version, query_fingerprint,
        query_parameters, date_range, intended_coverage, parent_query_id
      ) values (
        'github', v_child->>'partition_key', v_child->>'query_text', v_query.plan_name,
        v_query.plan_version, v_child->>'query_fingerprint', v_child->'query_parameters',
        v_child->'date_range', coalesce(v_child->>'intended_coverage', v_query.intended_coverage), v_query.id
      ) on conflict (provider, partition_key) do update set
        query_text = excluded.query_text,
        plan_name = excluded.plan_name,
        plan_version = excluded.plan_version,
        query_parameters = excluded.query_parameters,
        date_range = excluded.date_range,
        intended_coverage = excluded.intended_coverage,
        parent_query_id = excluded.parent_query_id,
        cursor = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then null else public.discovery_queries.cursor end,
        pages_fetched = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then 0 else public.discovery_queries.pages_fetched end,
        candidates_found = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then 0 else public.discovery_queries.candidates_found end,
        status = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then 'pending' else public.discovery_queries.status end,
        finished_at = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then null else public.discovery_queries.finished_at end,
        retry_count = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then 0 else public.discovery_queries.retry_count end,
        job_id = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then null else public.discovery_queries.job_id end,
        next_attempt_at = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then null else public.discovery_queries.next_attempt_at end,
        locked_at = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then null else public.discovery_queries.locked_at end,
        lock_owner = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then null else public.discovery_queries.lock_owner end,
        lease_expires_at = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then null else public.discovery_queries.lease_expires_at end,
        lease_token = case when public.discovery_queries.query_fingerprint <> excluded.query_fingerprint then null else public.discovery_queries.lease_token end,
        query_fingerprint = excluded.query_fingerprint,
        updated_at = clock_timestamp();
    end loop;
    update public.discovery_queries q set status = 'needs_review', finished_at = clock_timestamp(),
      locked_at = null, lock_owner = null, lease_token = null, lease_expires_at = null,
      last_error = case when jsonb_array_length(p_children) = 2
        then 'Partition exceeded GitHub search limits; narrower child partitions were scheduled.'
        else 'Partition exceeded GitHub search limits and requires manual review.' end,
      updated_at = clock_timestamp() where q.id = v_query.id;
    v_status := 'needs_review';
  end if;

  return jsonb_build_object(
    'committed', true, 'status', v_status, 'next_page', p_page + 1,
    'candidates_found', v_candidate_count, 'candidates_created', v_inserted,
    'candidates_updated', v_updated, 'source_record_id', v_source_id
  );
end;
$function$;

create or replace function public.fail_discovery_partition(
  p_query_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_error_summary text,
  p_retryable boolean,
  p_retry_after_ms bigint default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_query public.discovery_queries%rowtype;
  v_delay_ms bigint;
  v_status text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select q.* into v_query from public.discovery_queries q where q.id = p_query_id for update;
  if not found or v_query.status <> 'running' or v_query.lock_owner is distinct from p_worker_id
    or v_query.lease_token is distinct from p_lease_token
    or v_query.lease_expires_at <= clock_timestamp() then
    raise exception 'discovery claim is stale' using errcode = '40001';
  end if;
  if nullif(btrim(p_error_summary), '') is null or length(p_error_summary) > 500
    or p_error_summary ~ '[\r\n\t]' or p_retry_after_ms < 0 or p_retry_after_ms > 604800000 then
    raise exception 'invalid safe error summary or retry interval' using errcode = '22023';
  end if;
  v_delay_ms := coalesce(p_retry_after_ms,
    least(3600000::bigint, 5000::bigint * power(2, greatest(0, v_query.retry_count - 1))::bigint));
  v_status := case when not p_retryable or v_query.retry_count >= v_query.max_attempts then 'failed' else 'retry_wait' end;
  update public.discovery_queries q set
    status = v_status,
    next_attempt_at = case when v_status = 'retry_wait' then clock_timestamp() + make_interval(secs => (v_delay_ms::numeric / 1000)::double precision) else null end,
    finished_at = case when v_status = 'failed' then clock_timestamp() else null end,
    locked_at = null, lock_owner = null, lease_token = null, lease_expires_at = null,
    last_error = p_error_summary, updated_at = clock_timestamp()
  where q.id = v_query.id;
  if v_query.job_id is not null then
    update public.ingestion_jobs j set items_failed = j.items_failed + case when v_status = 'failed' then 1 else 0 end,
      error_summary = left(p_error_summary, 500), updated_at = clock_timestamp() where j.id = v_query.job_id;
  end if;
  return jsonb_build_object('status', v_status, 'retry_after_ms', case when v_status = 'retry_wait' then v_delay_ms else null end);
end;
$function$;

create or replace function public.release_discovery_partition(
  p_query_id uuid,
  p_worker_id text,
  p_lease_token uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.discovery_queries q set status = 'pending', locked_at = null,
    lock_owner = null, lease_token = null, lease_expires_at = null,
    retry_count = greatest(q.retry_count - 1, 0),
    updated_at = clock_timestamp()
  where q.id = p_query_id and q.status = 'running' and q.lock_owner = p_worker_id
    and q.lease_token = p_lease_token and q.lease_expires_at > clock_timestamp();
  if not found then raise exception 'discovery claim is stale' using errcode = '40001'; end if;
end;
$function$;

create or replace function public.finish_discovery_job(p_job_id uuid, p_status text, p_error_summary text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_status not in ('succeeded', 'partial', 'failed', 'cancelled') then
    raise exception 'invalid discovery job terminal status' using errcode = '22023';
  end if;
  update public.ingestion_jobs set status = p_status, finished_at = clock_timestamp(),
    error_summary = case when p_error_summary is null then error_summary else left(p_error_summary, 500) end,
    updated_at = clock_timestamp()
  where id = p_job_id and job_type = 'github_discovery' and status = 'running';
  if not found then raise exception 'discovery job is not running' using errcode = '40001'; end if;
end;
$function$;

revoke all on function public.start_discovery_job(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_discovery_partitions(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.commit_discovery_page(uuid, text, uuid, text, integer, timestamptz, text, integer, jsonb, integer, boolean, integer, jsonb, text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.fail_discovery_partition(uuid, text, uuid, text, boolean, bigint) from public, anon, authenticated;
revoke all on function public.release_discovery_partition(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.finish_discovery_job(uuid, text, text) from public, anon, authenticated;
grant execute on function public.start_discovery_job(text, text, jsonb) to service_role;
grant execute on function public.claim_discovery_partitions(uuid, text, integer, integer) to service_role;
grant execute on function public.commit_discovery_page(uuid, text, uuid, text, integer, timestamptz, text, integer, jsonb, integer, boolean, integer, jsonb, text, jsonb, integer) to service_role;
grant execute on function public.fail_discovery_partition(uuid, text, uuid, text, boolean, bigint) to service_role;
grant execute on function public.release_discovery_partition(uuid, text, uuid) to service_role;
grant execute on function public.finish_discovery_job(uuid, text, text) to service_role;
