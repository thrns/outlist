-- Private, lease-fenced repository assessments and atomic editorial draft creation.

create table public.repository_assessments (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references public.repositories(id) on delete cascade,
  policy_version text not null check (policy_version = 'm1-04-assessment-v1'),
  source_observed_at timestamptz not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry_wait', 'assessed', 'needs_review', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  lock_owner text,
  lease_expires_at timestamptz,
  lease_token uuid,
  job_id uuid references public.ingestion_jobs(id) on delete set null,
  result jsonb,
  assessed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repository_assessments_identity_unique unique (repository_id, policy_version),
  constraint repository_assessments_lease_state check (
    (status = 'processing' and locked_at is not null and lease_expires_at is not null
      and lease_token is not null and nullif(btrim(lock_owner), '') is not null)
    or (status <> 'processing' and locked_at is null and lease_expires_at is null
      and lease_token is null and lock_owner is null)
  ),
  constraint repository_assessments_result_object check (
    result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 32768)
  ),
  constraint repository_assessments_terminal_timestamp check (
    status not in ('assessed', 'needs_review', 'skipped', 'failed') or assessed_at is not null
  ),
  constraint repository_assessments_updated_after_created check (updated_at >= created_at)
);

create index repository_assessments_claim_idx
  on public.repository_assessments (status, next_attempt_at, created_at, id)
  where status in ('queued', 'retry_wait', 'processing');
create index repository_assessments_repository_idx
  on public.repository_assessments (repository_id, assessed_at desc);

create table public.repository_assessment_sources (
  assessment_id uuid not null references public.repository_assessments(id) on delete cascade,
  source_record_id uuid not null references public.source_records(id) on delete restrict,
  primary key (assessment_id, source_record_id)
);

alter table public.review_queue
  add column assessment_id uuid references public.repository_assessments(id) on delete set null;
create unique index review_queue_open_assessment_unique
  on public.review_queue (assessment_id) where assessment_id is not null and status in ('open', 'in_review');

alter table public.repository_assessments enable row level security;
alter table public.repository_assessment_sources enable row level security;
revoke all on public.repository_assessments, public.repository_assessment_sources from public, anon, authenticated;
grant all privileges on public.repository_assessments, public.repository_assessment_sources to service_role;

create or replace function public.start_github_repository_assessment_job(
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
    raise exception 'invalid assessment job metadata' using errcode = '22023';
  end if;
  if p_resume then
    select j.id into v_job_id from public.ingestion_jobs j
    where j.job_type = 'github_assessment' and j.provider = 'github' and j.status = 'running'
    order by j.started_at desc, j.created_at desc limit 1 for update;
  end if;
  if v_job_id is null then
    insert into public.ingestion_jobs (job_type, provider, status, started_at, metadata)
    values ('github_assessment', 'github', 'running', clock_timestamp(), p_metadata)
    returning id into v_job_id;
  end if;

  insert into public.repository_assessments (repository_id, policy_version, source_observed_at, status, job_id)
  select r.id, 'm1-04-assessment-v1', r.source_observed_at, 'queued', v_job_id
  from public.repositories r
  where r.provider = 'github' and r.availability_status = 'available'
    and r.is_private is false and coalesce(lower(btrim(r.visibility)), '') = 'public'
    and r.is_disabled is false and r.provider_repository_id ~ '^[1-9][0-9]{0,18}$'
    and case when r.provider_repository_id ~ '^[1-9][0-9]{0,18}$'
      then r.provider_repository_id::numeric <= 9007199254740991 else false end
    and r.owner_login ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'
    and r.repository_name ~ '^[A-Za-z0-9_.-]{1,100}$' and r.repository_name not in ('.', '..')
    and r.full_name = coalesce(r.owner_login, '') || '/' || coalesce(r.repository_name, '')
    and lower(r.canonical_url) = 'https://github.com/' || lower(r.full_name)
    and r.source_observed_at is not null and r.last_successful_sync_at is not null
    and exists (
      select 1 from public.repository_candidates c
      where c.repository_id = r.id and c.provider = 'github'
        and c.provider_repository_id = r.provider_repository_id
        and c.enrichment_status = 'succeeded' and c.review_status <> 'rejected'
        and c.queue_status <> 'discarded' and c.enrichment_completed_at >= r.source_observed_at
    )
    and not exists (
      select 1 from public.repository_candidates c
      where c.repository_id = r.id and (c.review_status = 'rejected' or c.queue_status = 'discarded')
    )
    and (r.source_field_states->>'visibility' = 'present')
    and (r.source_field_states->>'license' is not null)
    and exists (select 1 from public.source_records s where s.repository_id = r.id
      and s.record_kind = 'repository' and s.http_status = 200
      and s.fetched_at = r.source_observed_at and s.source_metadata->>'validated' = 'true')
    and exists (select 1 from public.source_records s where s.repository_id = r.id
      and s.record_kind = 'languages' and s.http_status = 200 and s.fetched_at >= r.source_observed_at
      and s.source_metadata->>'validated' = 'true')
    and exists (select 1 from public.source_records s where s.repository_id = r.id
      and s.record_kind = 'topics' and s.http_status = 200 and s.fetched_at >= r.source_observed_at
      and s.source_metadata->>'validated' = 'true')
    and exists (select 1 from public.source_records s where s.repository_id = r.id
      and s.record_kind = 'releases' and s.http_status = 200 and s.fetched_at >= r.source_observed_at
      and s.source_metadata->>'validated' = 'true')
  on conflict (repository_id, policy_version) do update set
    source_observed_at = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and (public.repository_assessments.status in ('queued', 'retry_wait', 'assessed', 'needs_review', 'skipped', 'failed')
        or (public.repository_assessments.status = 'processing'
          and public.repository_assessments.lease_expires_at <= clock_timestamp()))
      then excluded.source_observed_at else public.repository_assessments.source_observed_at end,
    status = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and (public.repository_assessments.status in ('queued', 'retry_wait', 'assessed', 'needs_review', 'skipped', 'failed')
        or (public.repository_assessments.status = 'processing'
          and public.repository_assessments.lease_expires_at <= clock_timestamp())) then 'queued'
      else public.repository_assessments.status end,
    attempts = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and (public.repository_assessments.status in ('queued', 'retry_wait', 'assessed', 'needs_review', 'skipped', 'failed')
        or (public.repository_assessments.status = 'processing'
          and public.repository_assessments.lease_expires_at <= clock_timestamp())) then 0 else public.repository_assessments.attempts end,
    assessed_at = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and (public.repository_assessments.status in ('queued', 'retry_wait', 'assessed', 'needs_review', 'skipped', 'failed')
        or (public.repository_assessments.status = 'processing'
          and public.repository_assessments.lease_expires_at <= clock_timestamp())) then null else public.repository_assessments.assessed_at end,
    result = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and (public.repository_assessments.status in ('queued', 'retry_wait', 'assessed', 'needs_review', 'skipped', 'failed')
        or (public.repository_assessments.status = 'processing'
          and public.repository_assessments.lease_expires_at <= clock_timestamp())) then null else public.repository_assessments.result end,
    last_error = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and (public.repository_assessments.status in ('queued', 'retry_wait', 'assessed', 'needs_review', 'skipped', 'failed')
        or (public.repository_assessments.status = 'processing'
          and public.repository_assessments.lease_expires_at <= clock_timestamp())) then null else public.repository_assessments.last_error end,
    next_attempt_at = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and (public.repository_assessments.status in ('queued', 'retry_wait', 'assessed', 'needs_review', 'skipped', 'failed')
        or (public.repository_assessments.status = 'processing'
          and public.repository_assessments.lease_expires_at <= clock_timestamp())) then null else public.repository_assessments.next_attempt_at end,
    locked_at = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and public.repository_assessments.status = 'processing'
      and public.repository_assessments.lease_expires_at <= clock_timestamp() then null else public.repository_assessments.locked_at end,
    lock_owner = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and public.repository_assessments.status = 'processing'
      and public.repository_assessments.lease_expires_at <= clock_timestamp() then null else public.repository_assessments.lock_owner end,
    lease_expires_at = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and public.repository_assessments.status = 'processing'
      and public.repository_assessments.lease_expires_at <= clock_timestamp() then null else public.repository_assessments.lease_expires_at end,
    lease_token = case when excluded.source_observed_at > public.repository_assessments.source_observed_at
      and public.repository_assessments.status = 'processing'
      and public.repository_assessments.lease_expires_at <= clock_timestamp() then null else public.repository_assessments.lease_token end,
    job_id = excluded.job_id
    where public.repository_assessments.status in ('queued', 'retry_wait')
      or (excluded.source_observed_at > public.repository_assessments.source_observed_at
        and (public.repository_assessments.status in ('assessed', 'needs_review', 'skipped', 'failed')
          or (public.repository_assessments.status = 'processing'
            and public.repository_assessments.lease_expires_at <= clock_timestamp())));
  return v_job_id;
end;
$function$;

create or replace function public.claim_github_repository_assessments(
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
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if nullif(btrim(p_worker_id), '') is null or length(p_worker_id) > 128
    or p_limit < 1 or p_limit > 20 or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'invalid assessment claim parameters' using errcode = '22023';
  end if;
  if not exists (select 1 from public.ingestion_jobs j where j.id = p_job_id
    and j.job_type = 'github_assessment' and j.status = 'running') then
    raise exception 'assessment job is not running' using errcode = '22023';
  end if;

  with exhausted as (
    update public.repository_assessments a set status = 'needs_review', assessed_at = clock_timestamp(),
      last_error = 'Assessment lease expired after the retry limit.', locked_at = null, lock_owner = null,
      lease_expires_at = null, lease_token = null, next_attempt_at = null, updated_at = clock_timestamp()
    where a.policy_version = 'm1-04-assessment-v1' and a.attempts >= a.max_attempts
      and ((a.status = 'processing' and a.lease_expires_at <= clock_timestamp())
        or (a.status = 'retry_wait' and a.next_attempt_at <= clock_timestamp()))
    returning a.id, a.repository_id, a.job_id
  ), review_items as (
    insert into public.review_queue (project_id, repository_id, assessment_id, reason, status)
    select case when r.project_id is null then null else r.project_id end,
      case when r.project_id is null then r.id else null end, e.id,
      'Assessment worker exhausted its retry limit; review the source evidence.', 'open'
    from exhausted e join public.repositories r on r.id = e.repository_id
    where not exists (select 1 from public.review_queue q where q.status in ('open', 'in_review')
      and ((r.project_id is not null and q.project_id = r.project_id)
        or (r.project_id is null and q.repository_id = r.id)))
    on conflict (assessment_id) where public.review_queue.assessment_id is not null
      and public.review_queue.status in ('open', 'in_review') do nothing
    returning public.review_queue.assessment_id
  ), counts as (
    select job_id, count(*)::integer as count from exhausted where job_id is not null group by job_id
  )
  update public.ingestion_jobs j set items_processed = j.items_processed + c.count,
    items_failed = j.items_failed + c.count,
    metadata = j.metadata || jsonb_build_object(
      'failed', coalesce((j.metadata->>'failed')::integer, 0) + c.count,
      'queued_for_review', coalesce((j.metadata->>'queued_for_review')::integer, 0) + c.count
    ), updated_at = clock_timestamp()
  from counts c where j.id = c.job_id;

  return query
  with picked as (
    select a.id from public.repository_assessments a
    where a.policy_version = 'm1-04-assessment-v1' and a.attempts < a.max_attempts and (
      a.status = 'queued'
      or (a.status = 'retry_wait' and coalesce(a.next_attempt_at, '-infinity'::timestamptz) <= clock_timestamp())
      or (a.status = 'processing' and a.lease_expires_at <= clock_timestamp())
    )
      and exists (select 1 from public.repositories r where r.id = a.repository_id and r.source_observed_at = a.source_observed_at)
    order by coalesce(a.next_attempt_at, a.created_at), a.id
    limit p_limit for update skip locked
  ), claimed as (
    update public.repository_assessments a set status = 'processing', job_id = p_job_id,
      attempts = a.attempts + 1, next_attempt_at = null, locked_at = clock_timestamp(),
      lock_owner = p_worker_id, lease_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds), updated_at = clock_timestamp()
    from picked p where a.id = p.id
    returning a.id, a.repository_id, a.lease_token, a.lease_expires_at
  )
  select c.id, c.repository_id, r.provider_repository_id, c.lease_token, c.lease_expires_at
  from claimed c join public.repositories r on r.id = c.repository_id order by c.id;
end;
$function$;

create or replace function public.complete_github_repository_assessment(
  p_assessment_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_result jsonb,
  p_source_record_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_assessment public.repository_assessments%rowtype;
  v_repository public.repositories%rowtype;
  v_candidate public.repository_candidates%rowtype;
  v_category jsonb;
  v_category_id uuid;
  v_primary_id uuid;
  v_suggestion_count integer;
  v_project_id uuid;
  v_queue_id uuid;
  v_status text;
  v_drafted boolean := false;
  v_now timestamptz := clock_timestamp();
  v_slug text;
  v_license_status text;
  v_quality_status text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_result) is distinct from 'object' or pg_column_size(p_result) > 32768
    or coalesce(p_result->>'policyVersion', '') <> 'm1-04-assessment-v1'
    or coalesce(p_result->>'assessmentTimestamp', '') = ''
    or coalesce(p_result->'classification'->>'policyVersion', '') <> 'outlist-category-rules-v1'
    or coalesce(p_result->'classification'->>'status', '') not in ('classified', 'insufficient_evidence', 'conflicting_signals')
    or coalesce(p_result->'license'->>'policyVersion', '') <> 'outlist-license-evidence-v1'
    or coalesce(p_result->'license'->>'spdxListVersion', '') <> '3.29.0'
    or coalesce(p_result->'license'->>'status', '') not in ('recognized_osi_approved', 'recognized_not_osi_approved', 'missing', 'noassertion', 'unknown_identifier', 'complex_expression', 'conflicting_evidence', 'unavailable')
    or coalesce(p_result->'quality'->>'policyVersion', '') <> 'outlist-source-quality-v1'
    or coalesce(p_result->'quality'->>'status', '') not in ('eligible_for_review', 'ineligible')
    or jsonb_typeof(p_result->'classification'->'suggestions') is distinct from 'array'
    or jsonb_array_length(p_result->'classification'->'suggestions') > 3
    or p_source_record_ids is null or cardinality(p_source_record_ids) < 3
    or cardinality(p_source_record_ids) > 32 then
    raise exception 'invalid assessment result payload' using errcode = '22023';
  end if;
  select a.* into v_assessment from public.repository_assessments a
  where a.id = p_assessment_id for update;
  if not found or v_assessment.status <> 'processing' or v_assessment.lock_owner is distinct from p_worker_id
    or v_assessment.lease_token is distinct from p_lease_token or v_assessment.lease_expires_at <= v_now then
    raise exception 'assessment claim is stale' using errcode = '40001';
  end if;
  -- Keep the same candidate-before-repository lock order as the enrichment commit.
  select c.* into v_candidate from public.repository_candidates c
  where c.repository_id = v_assessment.repository_id for update;
  if not found or v_candidate.enrichment_status <> 'succeeded' or v_candidate.enrichment_completed_at is null
    or v_candidate.review_status = 'rejected' or v_candidate.queue_status = 'discarded'
    or exists (select 1 from public.repository_candidates c where c.repository_id = v_assessment.repository_id
      and (c.review_status = 'rejected' or c.queue_status = 'discarded')) then
    raise exception 'repository candidate is no longer assessment-eligible' using errcode = '55000';
  end if;
  select r.* into v_repository from public.repositories r where r.id = v_assessment.repository_id for update;
  if not found or v_repository.provider <> 'github' or v_repository.availability_status <> 'available'
    or v_repository.is_private is distinct from false or lower(btrim(coalesce(v_repository.visibility, ''))) <> 'public'
    or v_repository.is_disabled is distinct from false
    or nullif(btrim(v_repository.owner_login), '') is null or nullif(btrim(v_repository.repository_name), '') is null
    or v_repository.provider_repository_id !~ '^[1-9][0-9]{0,18}$'
    or v_repository.owner_login !~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'
    or v_repository.repository_name !~ '^[A-Za-z0-9_.-]{1,100}$' or v_repository.repository_name in ('.', '..')
    or v_repository.full_name <> coalesce(v_repository.owner_login, '') || '/' || coalesce(v_repository.repository_name, '')
    or lower(v_repository.canonical_url) <> 'https://github.com/' || lower(v_repository.full_name)
    or v_repository.source_observed_at is null or v_repository.last_successful_sync_at is null
    or v_repository.source_field_states->>'visibility' is distinct from 'present'
    or v_repository.source_field_states->>'license' is null
    or v_repository.source_observed_at is distinct from v_assessment.source_observed_at then
    raise exception 'repository is no longer assessment-eligible' using errcode = '55000';
  end if;
  if v_repository.provider_repository_id::numeric > 9007199254740991 then
    raise exception 'repository is no longer assessment-eligible' using errcode = '55000';
  end if;
  if v_candidate.provider <> 'github'
    or v_candidate.provider_repository_id <> v_repository.provider_repository_id
    or v_candidate.enrichment_status <> 'succeeded' or v_candidate.enrichment_completed_at < v_repository.source_observed_at
    or v_candidate.review_status = 'rejected'
    or v_candidate.queue_status = 'discarded' or exists (
      select 1 from public.repository_candidates c where c.repository_id = v_repository.id
        and (c.review_status = 'rejected' or c.queue_status = 'discarded')
    ) then
    raise exception 'repository candidate is no longer assessment-eligible' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(p_source_record_ids) source_id
    where not exists (select 1 from public.source_records s where s.id = source_id
      and s.repository_id = v_repository.id and s.http_status = 200
      and s.source_metadata->>'validated' = 'true'))
    or not exists (select 1 from public.source_records s where s.id = any(p_source_record_ids)
      and s.record_kind = 'repository' and s.fetched_at = v_repository.source_observed_at)
    or not exists (select 1 from public.source_records s where s.id = any(p_source_record_ids)
      and s.record_kind = 'languages' and s.fetched_at >= v_repository.source_observed_at)
    or not exists (select 1 from public.source_records s where s.id = any(p_source_record_ids)
      and s.record_kind = 'topics' and s.fetched_at >= v_repository.source_observed_at)
    or not exists (select 1 from public.source_records s where s.id = any(p_source_record_ids)
      and s.record_kind = 'releases' and s.fetched_at >= v_repository.source_observed_at) then
    raise exception 'assessment source references are incomplete or unrelated' using errcode = '22023';
  end if;

  v_suggestion_count := jsonb_array_length(p_result->'classification'->'suggestions');
  if p_result->'classification'->>'status' = 'classified' then
    v_primary_id := nullif(p_result->'classification'->>'primaryCategoryId', '')::uuid;
    if v_primary_id is null or not exists (
      select 1 from jsonb_array_elements(p_result->'classification'->'suggestions') s
      join public.categories c on c.id = (s->>'categoryId')::uuid and c.is_active
      where (s->>'categoryId')::uuid = v_primary_id
        and jsonb_typeof(s->'evidence') = 'array' and jsonb_array_length(s->'evidence') between 1 and 12
    ) then raise exception 'primary category lacks active taxonomy evidence' using errcode = '22023'; end if;
  else
    v_primary_id := null;
    if v_suggestion_count > 3 then raise exception 'too many category suggestions' using errcode = '22023'; end if;
  end if;
  for v_category in select value from jsonb_array_elements(p_result->'classification'->'suggestions')
  loop
    v_category_id := (v_category->>'categoryId')::uuid;
    if not exists (select 1 from public.categories c where c.id = v_category_id and c.is_active)
      or jsonb_typeof(v_category->'evidence') is distinct from 'array'
      or jsonb_array_length(v_category->'evidence') < 1 or jsonb_array_length(v_category->'evidence') > 12 then
      raise exception 'category suggestion is not supported by current taxonomy evidence' using errcode = '22023';
    end if;
  end loop;
  v_license_status := p_result->'license'->>'projectLicenseStatus';
  if v_license_status is null or v_license_status not in ('unknown', 'unverified', 'needs_review') then
    raise exception 'assessment cannot approve or reject project license status' using errcode = '22023';
  end if;
  v_quality_status := p_result->'quality'->>'qualityStatus';
  if v_quality_status is null or v_quality_status not in ('unreviewed', 'needs_review') then
    raise exception 'assessment cannot verify or reject project quality status' using errcode = '22023';
  end if;

  delete from public.repository_assessment_sources where assessment_id = v_assessment.id;
  insert into public.repository_assessment_sources (assessment_id, source_record_id)
  select v_assessment.id, source_id from unnest(p_source_record_ids) source_id
  on conflict do nothing;
  v_project_id := v_repository.project_id;
  if v_primary_id is not null and v_project_id is null
    and p_result->'quality'->>'status' = 'eligible_for_review' then
    v_slug := 'github-' || v_repository.provider_repository_id;
    if not exists (select 1 from public.projects p where p.slug = v_slug) then
      insert into public.projects (
        slug, name, summary, description, official_website_url, license_status,
        license_identifier, license_verified_at, publication_status, quality_status,
        featured, primary_repository_id, published_at
      ) values (
        v_slug, v_repository.repository_name, '',
        case when v_repository.source_field_states->>'description' = 'present'
          then coalesce(nullif(btrim(v_repository.description), ''), '') else '' end,
        null, v_license_status,
        case when p_result->'license'->>'status' in ('recognized_osi_approved', 'recognized_not_osi_approved')
            and p_result->'license'->>'identifier' ~ '^[A-Za-z0-9.+-]{1,128}$'
          then p_result->'license'->>'identifier' else null end,
        null, 'pending_review', v_quality_status, false, null, null
      ) returning id into v_project_id;
      update public.repositories set project_id = v_project_id, updated_at = v_now where id = v_repository.id;
      update public.projects set primary_repository_id = v_repository.id where id = v_project_id;
      insert into public.project_categories (project_id, category_id)
      select v_project_id, (suggestion->>'categoryId')::uuid
      from jsonb_array_elements(p_result->'classification'->'suggestions') suggestion
      on conflict do nothing;
      v_drafted := true;
    else
      v_project_id := null;
    end if;
  end if;

  if v_drafted then v_status := 'assessed';
  elsif v_project_id is not null then
    -- Existing projects are assessment inputs only; editorial values remain authoritative.
    v_status := 'needs_review';
  elsif v_primary_id is null or p_result->'quality'->>'status' <> 'eligible_for_review'
    or exists (select 1 from public.projects p where p.slug = 'github-' || v_repository.provider_repository_id) then
    v_status := 'needs_review';
  else v_status := 'needs_review'; end if;

  if v_status = 'needs_review' or v_drafted then
    select q.id into v_queue_id from public.review_queue q
    where q.status in ('open', 'in_review') and (
      q.assessment_id = v_assessment.id
      or (v_project_id is not null and q.project_id = v_project_id)
      or (v_project_id is null and q.repository_id = v_repository.id)
    ) order by case when q.assessment_id = v_assessment.id then 0 else 1 end, q.created_at limit 1 for update;
    if v_queue_id is null then
      insert into public.review_queue (project_id, repository_id, assessment_id, reason, status)
      values (case when v_project_id is not null then v_project_id else null end,
        case when v_project_id is null then v_repository.id else null end, v_assessment.id,
        case when v_drafted then 'Source-backed project draft requires editorial review.'
          else 'Repository assessment requires review before project creation or update.' end, 'open')
      returning id into v_queue_id;
    else
      update public.review_queue set
        project_id = case when v_project_id is not null then v_project_id else null end,
        repository_id = case when v_project_id is null then v_repository.id else null end,
        assessment_id = coalesce(assessment_id, v_assessment.id),
        reason = case when v_drafted and assessment_id = v_assessment.id
          then 'Source-backed project draft requires editorial review.' else reason end
      where id = v_queue_id;
    end if;
  end if;

  update public.repository_assessments a set status = v_status, result = p_result,
    assessed_at = v_now, locked_at = null, lock_owner = null, lease_expires_at = null,
    lease_token = null, next_attempt_at = null, last_error = null, updated_at = v_now
  where a.id = v_assessment.id;
  update public.ingestion_jobs j set items_processed = j.items_processed + 1,
    items_created = j.items_created + case when v_drafted then 1 else 0 end,
    items_skipped = j.items_skipped + case when v_status = 'skipped' then 1 else 0 end,
    metadata = j.metadata || jsonb_build_object(
      'assessed', coalesce((j.metadata->>'assessed')::integer, 0) + 1,
      'drafted', coalesce((j.metadata->>'drafted')::integer, 0) + case when v_drafted then 1 else 0 end,
      'queued_for_review', coalesce((j.metadata->>'queued_for_review')::integer, 0) + case when v_queue_id is not null then 1 else 0 end
    ), updated_at = v_now where j.id = v_assessment.job_id;
  return jsonb_build_object('status', v_status, 'drafted', v_drafted, 'project_id', v_project_id, 'review_queue_id', v_queue_id);
end;
$function$;

create or replace function public.fail_github_repository_assessment(
  p_assessment_id uuid, p_worker_id text, p_lease_token uuid,
  p_error_summary text, p_retryable boolean, p_retry_after_ms bigint default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_assessment public.repository_assessments%rowtype;
  v_status text;
  v_delay bigint;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select a.* into v_assessment from public.repository_assessments a where a.id = p_assessment_id for update;
  if not found or v_assessment.status <> 'processing' or v_assessment.lock_owner is distinct from p_worker_id
    or v_assessment.lease_token is distinct from p_lease_token or v_assessment.lease_expires_at <= v_now then
    raise exception 'assessment claim is stale' using errcode = '40001';
  end if;
  if nullif(btrim(p_error_summary), '') is null or length(p_error_summary) > 500
    or p_error_summary ~ '[\r\n\t]' or p_retry_after_ms < 0 or p_retry_after_ms > 604800000 then
    raise exception 'invalid safe assessment error or retry interval' using errcode = '22023';
  end if;
  v_status := case when p_retryable and v_assessment.attempts < v_assessment.max_attempts then 'retry_wait' else 'failed' end;
  v_delay := coalesce(p_retry_after_ms, least(3600000::bigint, 5000::bigint * power(2, greatest(0, v_assessment.attempts - 1))::bigint));
  update public.repository_assessments set status = v_status,
    next_attempt_at = case when v_status = 'retry_wait' then v_now + make_interval(secs => v_delay / 1000.0) else null end,
    assessed_at = case when v_status = 'failed' then v_now else null end,
    locked_at = null, lock_owner = null, lease_expires_at = null, lease_token = null,
    last_error = left(p_error_summary, 500), updated_at = v_now where id = p_assessment_id;
  update public.ingestion_jobs set
    items_failed = items_failed + case when v_status = 'failed' then 1 else 0 end,
    metadata = metadata || jsonb_build_object(
      'retried', coalesce((metadata->>'retried')::integer, 0) + case when v_status = 'retry_wait' then 1 else 0 end,
      'failed', coalesce((metadata->>'failed')::integer, 0) + case when v_status = 'failed' then 1 else 0 end
    ), updated_at = v_now where id = v_assessment.job_id;
  return jsonb_build_object('status', v_status, 'next_attempt_at', case when v_status = 'retry_wait' then v_now + make_interval(secs => v_delay / 1000.0) else null end);
end;
$function$;

create or replace function public.finish_github_repository_assessment_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ingestion_jobs%rowtype;
  v_open integer;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select j.* into v_job from public.ingestion_jobs j
  where j.id = p_job_id and j.job_type = 'github_assessment' and j.status = 'running' for update;
  if not found then raise exception 'assessment job is not running' using errcode = '22023'; end if;
  select count(*)::integer into v_open from public.repository_assessments a
  where a.job_id = p_job_id and a.status in ('queued', 'retry_wait', 'processing');
  update public.ingestion_jobs set status = case when v_open > 0 or items_failed > 0 then 'partial' else 'succeeded' end,
    finished_at = v_now, updated_at = v_now where id = p_job_id;
  return jsonb_build_object('status', case when v_open > 0 or v_job.items_failed > 0 then 'partial' else 'succeeded' end,
    'open_assessments', v_open);
end;
$function$;

create or replace function private.touch_assessment_updated_at()
returns trigger language plpgsql set search_path = '' as $function$
begin new.updated_at := clock_timestamp(); return new; end;
$function$;
revoke all on function private.touch_assessment_updated_at() from public, anon, authenticated;
grant execute on function private.touch_assessment_updated_at() to service_role;
create trigger repository_assessments_90_touch_updated_at before update on public.repository_assessments
  for each row execute function private.touch_assessment_updated_at();

revoke all on function public.start_github_repository_assessment_job(boolean, jsonb) from public, anon, authenticated;
revoke all on function public.claim_github_repository_assessments(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_github_repository_assessment(uuid, text, uuid, jsonb, uuid[]) from public, anon, authenticated;
revoke all on function public.fail_github_repository_assessment(uuid, text, uuid, text, boolean, bigint) from public, anon, authenticated;
revoke all on function public.finish_github_repository_assessment_job(uuid) from public, anon, authenticated;
grant execute on function public.start_github_repository_assessment_job(boolean, jsonb) to service_role;
grant execute on function public.claim_github_repository_assessments(uuid, text, integer, integer) to service_role;
grant execute on function public.complete_github_repository_assessment(uuid, text, uuid, jsonb, uuid[]) to service_role;
grant execute on function public.fail_github_repository_assessment(uuid, text, uuid, text, boolean, bigint) to service_role;
grant execute on function public.finish_github_repository_assessment_job(uuid) to service_role;
