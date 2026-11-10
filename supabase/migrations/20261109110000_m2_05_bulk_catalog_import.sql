-- Bounded, lease-fenced catalog seed imports. The importer writes only source
-- observations, candidate queue rows, and its own ingestion job/items. The
-- normal enrichment and assessment workers remain responsible for drafts.

alter table public.ingestion_jobs
  add column catalog_import_lease_token uuid,
  add column catalog_import_lease_expires_at timestamptz,
  add constraint ingestion_jobs_catalog_import_lease_state check (
    job_type <> 'catalog_import'
    or (status = 'running' and catalog_import_lease_token is not null
      and catalog_import_lease_expires_at is not null)
    or (status <> 'running' and catalog_import_lease_token is null
      and catalog_import_lease_expires_at is null)
  );

create unique index ingestion_jobs_one_catalog_import_running
  on public.ingestion_jobs (job_type)
  where job_type = 'catalog_import' and status = 'running';

-- Rejected repository identities have no safe candidate/repository target, so
-- allow their source evidence to remain in the dedicated import ledger.
alter table public.ingestion_items drop constraint ingestion_items_target_required;
alter table public.ingestion_items add constraint ingestion_items_target_required check (
  candidate_id is not null or repository_id is not null or item_type = 'catalog_import_exclusion'
);

create or replace function private.resolve_catalog_import_slug(
  p_job_id uuid, p_candidate_id uuid, p_proposed_slug text, p_repository_id text
) returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_slug text := p_proposed_slug;
  v_suffix text;
  v_attempt integer := 0;
begin
  if p_proposed_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or p_repository_id !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'invalid catalog slug identity' using errcode = '22023';
  end if;
  while exists (select 1 from public.projects p where p.slug = v_slug)
    or exists (
      select 1 from public.ingestion_items i
      join public.ingestion_jobs j on j.id = i.job_id
      where j.job_type = 'catalog_import'
        and i.result->'catalog_import'->>'resolved_slug' = v_slug
        and (p_candidate_id is null or i.candidate_id is distinct from p_candidate_id)
    )
  loop
    v_attempt := v_attempt + 1;
    v_suffix := '-' || p_repository_id || case when v_attempt = 1 then '' else '-' || v_attempt::text end;
    v_slug := left(p_proposed_slug, 140 - length(v_suffix)) || v_suffix;
    if v_attempt > 100 then
      raise exception 'unable to resolve a deterministic catalog slug' using errcode = '23505';
    end if;
  end loop;
  return v_slug;
end;
$function$;

revoke all on function private.resolve_catalog_import_slug(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function private.resolve_catalog_import_slug(uuid, uuid, text, text) to service_role;

create or replace function public.start_catalog_import(
  p_archive_sha256 text,
  p_total_batches integer,
  p_total_candidates integer,
  p_environment text,
  p_project_ref text,
  p_resume boolean,
  p_worker_id text,
  p_lease_token uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ingestion_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_metadata jsonb;
  v_project_ref text := nullif(btrim(p_project_ref), '');
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_archive_sha256 is null or p_archive_sha256 !~ '^[a-f0-9]{64}$'
    or p_total_batches is null or p_total_batches < 1 or p_total_batches > 100
    or p_total_candidates is null or p_total_candidates < 1 or p_total_candidates > 10000
    or p_environment is null or p_environment not in ('local', 'development', 'staging', 'production')
    or v_project_ref is null or length(v_project_ref) > 128
    or nullif(btrim(p_worker_id), '') is null or length(p_worker_id) > 128
    or p_resume is null or p_lease_token is null then
    raise exception 'invalid catalog import start request' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('outlist.catalog_import', 0));
  if p_resume then
    select j.* into v_job from public.ingestion_jobs j
    where j.job_type = 'catalog_import'
      and j.metadata->'catalog_import'->>'archive_sha256' = p_archive_sha256
      and j.metadata->'catalog_import'->>'project_ref' = v_project_ref
      and (j.metadata->'catalog_import'->>'environment') = p_environment
    order by j.created_at desc limit 1 for update;
    if not found then
      raise exception 'matching resumable catalog import was not found' using errcode = '55000';
    end if;
    if v_job.status = 'succeeded' then
      return jsonb_build_object('job_id', v_job.id, 'status', v_job.status,
        'next_batch_number', (v_job.metadata->'catalog_import'->>'next_batch_number')::integer,
        'total_batches', (v_job.metadata->'catalog_import'->>'total_batches')::integer,
        'archive_sha256', p_archive_sha256, 'already_complete', true, 'created_job', false);
    end if;
    if v_job.status = 'running' and v_job.catalog_import_lease_expires_at > v_now then
      raise exception 'another catalog import worker still holds the lease' using errcode = '55P03';
    end if;
    if v_job.status not in ('running', 'partial', 'failed') then
      raise exception 'catalog import is not resumable from its current state' using errcode = '55000';
    end if;
  else
    select j.* into v_job from public.ingestion_jobs j
    where j.job_type = 'catalog_import'
      and j.metadata->'catalog_import'->>'archive_sha256' = p_archive_sha256
      and j.metadata->'catalog_import'->>'project_ref' = v_project_ref
      and j.metadata->'catalog_import'->>'environment' = p_environment
    order by j.created_at desc limit 1 for update;
    if found then
      if v_job.status = 'succeeded' then
        return jsonb_build_object('job_id', v_job.id, 'status', v_job.status,
          'next_batch_number', (v_job.metadata->'catalog_import'->>'next_batch_number')::integer,
          'total_batches', (v_job.metadata->'catalog_import'->>'total_batches')::integer,
          'archive_sha256', p_archive_sha256, 'already_complete', true, 'created_job', false);
      end if;
      raise exception 'an import for this archive already exists; use --resume' using errcode = '55000';
    end if;
    if exists (select 1 from public.ingestion_jobs j
      where j.job_type = 'catalog_import' and j.status = 'running'
        and j.catalog_import_lease_expires_at > v_now) then
      raise exception 'another catalog import worker still holds the lease' using errcode = '55P03';
    end if;
    v_metadata := jsonb_build_object('catalog_import', jsonb_build_object(
      'schema_version', 1,
      'archive_sha256', p_archive_sha256,
      'environment', p_environment,
      'project_ref', v_project_ref,
      'total_batches', p_total_batches,
      'total_candidates', p_total_candidates,
      'next_batch_number', 1,
      'batch_hashes', '{}'::jsonb,
      'batch_payload_hashes', '{}'::jsonb,
      'imported', 0,
      'existing', 0,
      'excluded', 0,
      'worker_id', p_worker_id
    ));
    insert into public.ingestion_jobs (
      job_type, provider, status, started_at, items_discovered, metadata,
      catalog_import_lease_token, catalog_import_lease_expires_at
    ) values (
      'catalog_import', 'github', 'running', v_now, p_total_candidates, v_metadata,
      p_lease_token, v_now + interval '10 minutes'
    ) returning * into v_job;
    return jsonb_build_object('job_id', v_job.id, 'status', v_job.status,
      'next_batch_number', 1, 'total_batches', p_total_batches,
      'archive_sha256', p_archive_sha256, 'already_complete', false, 'created_job', true);
  end if;

  if v_job.items_discovered <> p_total_candidates
    or (v_job.metadata->'catalog_import'->>'total_batches')::integer <> p_total_batches then
    raise exception 'resume archive counts do not match the stored checkpoint' using errcode = '22023';
  end if;
  update public.ingestion_jobs set
    status = 'running', started_at = v_now, finished_at = null, error_summary = null,
    metadata = jsonb_set(metadata, '{catalog_import,worker_id}', to_jsonb(p_worker_id), true),
    catalog_import_lease_token = p_lease_token,
    catalog_import_lease_expires_at = v_now + interval '10 minutes',
    updated_at = v_now
  where id = v_job.id returning * into v_job;
  return jsonb_build_object('job_id', v_job.id, 'status', v_job.status,
    'next_batch_number', (v_job.metadata->'catalog_import'->>'next_batch_number')::integer,
    'total_batches', p_total_batches, 'archive_sha256', p_archive_sha256,
    'already_complete', false, 'created_job', false);
end;
$function$;

create or replace function public.heartbeat_catalog_import(
  p_job_id uuid, p_worker_id text, p_lease_token uuid
) returns timestamptz
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_expiry timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.ingestion_jobs set catalog_import_lease_expires_at = clock_timestamp() + interval '10 minutes',
    updated_at = clock_timestamp()
  where id = p_job_id and job_type = 'catalog_import' and status = 'running'
    and metadata->'catalog_import'->>'worker_id' = p_worker_id
    and catalog_import_lease_token = p_lease_token
    and catalog_import_lease_expires_at > clock_timestamp()
  returning catalog_import_lease_expires_at into v_expiry;
  if v_expiry is null then raise exception 'catalog import lease is stale' using errcode = '40001'; end if;
  return v_expiry;
end;
$function$;

create or replace function public.commit_catalog_import_batch(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_batch_number integer,
  p_batch_sha256 text,
  p_records jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ingestion_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_next integer;
  v_total integer;
  v_archive_sha text;
  v_item jsonb;
  v_seed jsonb;
  v_check jsonb;
  v_provenance jsonb;
  v_response jsonb;
  v_id text;
  v_owner text;
  v_name text;
  v_full_name text;
  v_url text;
  v_category_id uuid;
  v_candidate_id uuid;
  v_repository_id uuid;
  v_source_record_id uuid;
  v_proposed_slug text;
  v_resolved_slug text;
  v_item_status text;
  v_item_result jsonb;
  v_imported integer := 0;
  v_existing integer := 0;
  v_excluded integer := 0;
  v_item_count integer;
  v_batch_hashes jsonb;
  v_batch_payload_hashes jsonb;
  v_batch_payload_hash text;
  v_results jsonb := '[]'::jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_job_id is null or nullif(btrim(p_worker_id), '') is null or length(p_worker_id) > 128
    or p_lease_token is null or p_batch_number is null or p_batch_number < 1
    or p_batch_sha256 is null or p_batch_sha256 !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_records) is distinct from 'array'
    or jsonb_array_length(p_records) < 1 or jsonb_array_length(p_records) > 30
    or pg_column_size(p_records) > 2097152 then
    raise exception 'invalid catalog import batch' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_records) item
    group by item->'source_candidate'->>'github_repository_id'
    having count(*) > 1
  ) then raise exception 'duplicate repository ID inside catalog batch' using errcode = '23505'; end if;

  select j.* into v_job from public.ingestion_jobs j
  where j.id = p_job_id and j.job_type = 'catalog_import' and j.status = 'running'
  for update;
  if not found or v_job.catalog_import_lease_token is distinct from p_lease_token
    or v_job.catalog_import_lease_expires_at <= v_now then
    raise exception 'catalog import lease is stale' using errcode = '40001';
  end if;
  if v_job.metadata->'catalog_import'->>'worker_id' is distinct from p_worker_id then
    raise exception 'catalog import worker identity is stale' using errcode = '40001';
  end if;
  v_archive_sha := v_job.metadata->'catalog_import'->>'archive_sha256';
  v_next := (v_job.metadata->'catalog_import'->>'next_batch_number')::integer;
  v_total := (v_job.metadata->'catalog_import'->>'total_batches')::integer;
  v_batch_hashes := coalesce(v_job.metadata->'catalog_import'->'batch_hashes', '{}'::jsonb);
  v_batch_payload_hashes := coalesce(v_job.metadata->'catalog_import'->'batch_payload_hashes', '{}'::jsonb);
  v_batch_payload_hash := pg_catalog.md5(p_records::text);
  if p_batch_number < v_next then
    if v_batch_hashes->>p_batch_number::text is distinct from p_batch_sha256
      or v_batch_payload_hashes->>p_batch_number::text is distinct from v_batch_payload_hash then
      raise exception 'replayed catalog batch hash differs from committed data' using errcode = '22023';
    end if;
    return jsonb_build_object('job_id', v_job.id, 'next_batch_number', v_next,
      'imported', 0, 'existing', 0, 'excluded', 0, 'idempotent_replay', true);
  end if;
  if p_batch_number <> v_next or p_batch_number > v_total then
    raise exception 'catalog batches must commit in checkpoint order' using errcode = '55000';
  end if;

  for v_item in select value from jsonb_array_elements(p_records)
  loop
    v_seed := v_item->'source_candidate';
    v_check := v_item->'verification';
    v_provenance := v_item->'provenance';
    v_response := v_item->'github_response';
    v_id := v_seed->>'github_repository_id';
    if jsonb_typeof(v_seed) is distinct from 'object'
      or v_id is null or v_id !~ '^[1-9][0-9]{0,18}$'
      or v_seed->>'schema_version' is distinct from '1'
      or v_seed->>'primary_category' is null
      or coalesce(v_item->>'source_batch', '') !~ '^[1-9][0-9]{0,2}$'
      or coalesce(v_item->>'source_line', '') !~ '^[1-9][0-9]{0,3}$'
      or jsonb_typeof(v_check) is distinct from 'object'
      or jsonb_typeof(v_item->'import_candidate') is distinct from 'boolean' then
      raise exception 'catalog batch item is missing validated source data' using errcode = '22023';
    end if;
    select c.id into v_category_id from public.categories c
      where c.slug = v_seed->>'primary_category' and c.is_active;
    if v_category_id is null then
      raise exception 'catalog category is missing or inactive: %', v_seed->>'primary_category' using errcode = '23503';
    end if;

    if not (v_item->>'import_candidate')::boolean then
      v_excluded := v_excluded + 1;
      v_item_result := jsonb_build_object('catalog_import', jsonb_build_object(
        'archive_sha256', v_archive_sha, 'batch_number', (v_item->>'source_batch')::integer,
        'batch_line', (v_item->>'source_line')::integer, 'source_candidate', v_seed,
        'category_slug', v_seed->>'primary_category', 'category_id', v_category_id,
        'verification', v_check, 'github_response', v_response, 'provenance', v_provenance,
        'exclusion_reason', 'Automated repository review rejected or excluded this candidate.'
      ));
      insert into public.ingestion_items (
        job_id, item_key, item_type, status, started_at, finished_at, result
      ) values (
        p_job_id, 'github:' || v_id, 'catalog_import_exclusion', 'skipped', v_now, v_now, v_item_result
      ) on conflict (job_id, item_key) do nothing;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'github_repository_id', v_id, 'result', 'excluded'
      ));
      continue;
    end if;

    if jsonb_typeof(v_response) is distinct from 'object'
      or jsonb_typeof(v_provenance) is distinct from 'object'
      or v_response->>'id' is distinct from v_id
      or nullif(v_response->'owner'->>'login', '') is null
      or nullif(v_response->>'name', '') is null
      or v_response->>'full_name' is distinct from (v_response->'owner'->>'login') || '/' || (v_response->>'name')
      or jsonb_typeof(v_response->'private') is distinct from 'boolean'
      or (v_response->>'private')::boolean is not false
      or jsonb_typeof(v_response->'disabled') is distinct from 'boolean'
      or (v_response->>'disabled')::boolean is not false
      or lower(coalesce(v_response->>'visibility', '')) <> 'public'
      or (v_provenance->>'http_status')::integer is distinct from 200
      or v_provenance->>'api_version' is distinct from '2022-11-28'
      or v_provenance->>'stable_resource_identity' is distinct from 'github:repository:' || v_id
      or v_provenance->>'source_url' is distinct from 'https://api.github.com/repositories/' || v_id
      or nullif(v_provenance->>'fetched_at', '') is null
      or (v_provenance->>'fetched_at')::timestamptz > v_now + interval '5 minutes' then
      raise exception 'catalog import requires a current validated public GitHub response' using errcode = '23514';
    end if;
    if v_id::numeric > 9007199254740991
      or (v_response->'owner'->>'login') !~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'
      or (v_response->>'name') !~ '^[A-Za-z0-9_.-]{1,100}$'
      or v_response->>'name' in ('.', '..') then
      raise exception 'unsupported GitHub repository identity' using errcode = '22023';
    end if;

    v_owner := v_response->'owner'->>'login';
    v_name := v_response->>'name';
    v_full_name := v_owner || '/' || v_name;
    v_url := 'https://github.com/' || v_full_name;
    v_proposed_slug := v_seed->>'slug';

    select c.id, c.repository_id into v_candidate_id, v_repository_id
    from public.repository_candidates c
    where c.provider = 'github' and c.provider_repository_id = v_id
    for update;
    if v_candidate_id is null then
      select r.id into v_repository_id from public.repositories r
      where r.provider = 'github' and r.provider_repository_id = v_id
      for update;
    end if;

    if v_candidate_id is not null or v_repository_id is not null then
      v_existing := v_existing + 1;
      v_item_status := 'skipped';
      v_resolved_slug := private.resolve_catalog_import_slug(p_job_id, v_candidate_id, v_proposed_slug, v_id);
      v_item_result := jsonb_build_object('catalog_import', jsonb_build_object(
        'archive_sha256', v_archive_sha, 'batch_number', (v_item->>'source_batch')::integer,
        'batch_line', (v_item->>'source_line')::integer, 'source_candidate', v_seed,
        'category_slug', v_seed->>'primary_category', 'category_id', v_category_id,
        'proposed_slug', v_proposed_slug, 'resolved_slug', v_resolved_slug,
        'verification', v_check, 'github_response', v_response, 'provenance', v_provenance,
        'dedupe_reason', case when v_candidate_id is not null then 'existing_candidate_identity' else 'existing_repository_identity' end
      ));
      insert into public.ingestion_items (
        job_id, item_key, item_type, candidate_id, repository_id, status, started_at, finished_at, result
      ) values (
        p_job_id, 'github:' || v_id, 'catalog_seed_candidate', v_candidate_id, v_repository_id,
        v_item_status, v_now, v_now, v_item_result
      ) on conflict (job_id, item_key) do nothing;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'github_repository_id', v_id,
        'result', case when v_candidate_id is not null then 'existing_candidate' else 'existing_repository' end
      ));
      continue;
    end if;

    insert into public.source_records (
      provider, record_kind, source_key, source_url, fetched_at, http_status,
      etag, raw_payload, reuse_context, source_metadata
    ) values (
      'github', 'repository', v_provenance->>'stable_resource_identity', v_provenance->>'source_url',
      (v_provenance->>'fetched_at')::timestamptz, 200,
      nullif(v_provenance->>'etag', ''), v_response,
      'Catalog import verification used a fresh repository response; conditional reuse was disabled.',
      jsonb_build_object(
        'validated', true, 'api_version', v_provenance->>'api_version',
        'resource_kind', 'repository', 'stable_provider_id', v_id,
        'cache_reusable', false, 'catalog_import_archive_sha256', v_archive_sha,
        'catalog_import_job_id', p_job_id
      )
    ) on conflict (provider, source_key, fetched_at) do nothing
    returning id into v_source_record_id;
    if v_source_record_id is null then
      select s.id into v_source_record_id from public.source_records s
      where s.provider = 'github' and s.source_key = v_provenance->>'stable_resource_identity'
        and s.fetched_at = (v_provenance->>'fetched_at')::timestamptz;
    end if;
    if v_source_record_id is null then raise exception 'source provenance row was not persisted' using errcode = '23502'; end if;

    insert into public.repository_candidates (
      provider, provider_repository_id, full_name, canonical_url, source_record_id, source_metadata
    ) values (
      'github', v_id, v_full_name, v_url, v_source_record_id,
      jsonb_build_object('catalog_import_archive_sha256', v_archive_sha, 'source_batch', (v_item->>'source_batch')::integer)
    ) on conflict (provider, provider_repository_id) do nothing
    returning id into v_candidate_id;
    if v_candidate_id is null then
      select c.id, c.repository_id into v_candidate_id, v_repository_id from public.repository_candidates c
      where c.provider = 'github' and c.provider_repository_id = v_id;
      if v_candidate_id is null then
        select r.id into v_repository_id from public.repositories r
        where r.provider = 'github' and r.provider_repository_id = v_id;
      end if;
      if v_candidate_id is null and v_repository_id is null then raise exception 'repository identity conflict could not be reconciled' using errcode = '40001'; end if;
      update public.source_records set candidate_id = v_candidate_id
      where id = v_source_record_id and candidate_id is null and v_candidate_id is not null;
      v_existing := v_existing + 1;
      v_item_status := 'skipped';
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'github_repository_id', v_id,
        'result', case when v_candidate_id is not null then 'existing_candidate' else 'existing_repository' end
      ));
    else
      update public.source_records set candidate_id = v_candidate_id where id = v_source_record_id;
      v_imported := v_imported + 1;
      v_item_status := 'succeeded';
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'github_repository_id', v_id, 'result', 'created_candidate'
      ));
    end if;
    v_resolved_slug := private.resolve_catalog_import_slug(p_job_id, v_candidate_id, v_proposed_slug, v_id);
    v_item_result := jsonb_build_object('catalog_import', jsonb_build_object(
      'archive_sha256', v_archive_sha, 'batch_number', (v_item->>'source_batch')::integer,
      'batch_line', (v_item->>'source_line')::integer, 'source_candidate', v_seed,
      'category_slug', v_seed->>'primary_category', 'category_id', v_category_id,
      'proposed_slug', v_proposed_slug, 'resolved_slug', v_resolved_slug,
      'verification', v_check, 'github_response', v_response, 'provenance', v_provenance,
      'source_record_id', v_source_record_id
    ));
    insert into public.ingestion_items (
      job_id, item_key, item_type, candidate_id, repository_id, status,
      started_at, finished_at, result
    ) values (
      p_job_id, 'github:' || v_id, 'catalog_seed_candidate', v_candidate_id, v_repository_id,
      v_item_status, v_now, v_now, v_item_result
    ) on conflict (job_id, item_key) do nothing;
  end loop;

  v_item_count := jsonb_array_length(p_records);
  v_batch_hashes := jsonb_set(v_batch_hashes, array[p_batch_number::text], to_jsonb(p_batch_sha256), true);
  v_batch_payload_hashes := jsonb_set(v_batch_payload_hashes, array[p_batch_number::text], to_jsonb(v_batch_payload_hash), true);
  update public.ingestion_jobs set
    items_processed = items_processed + v_item_count,
    items_created = items_created + v_imported,
    items_skipped = items_skipped + v_existing + v_excluded,
    metadata = jsonb_set(metadata, '{catalog_import}',
      (metadata->'catalog_import') || jsonb_build_object(
        'next_batch_number', p_batch_number + 1,
        'batch_hashes', v_batch_hashes,
        'batch_payload_hashes', v_batch_payload_hashes,
        'imported', coalesce((metadata->'catalog_import'->>'imported')::integer, 0) + v_imported,
        'existing', coalesce((metadata->'catalog_import'->>'existing')::integer, 0) + v_existing,
        'excluded', coalesce((metadata->'catalog_import'->>'excluded')::integer, 0) + v_excluded,
        'worker_id', p_worker_id
      ), true),
    catalog_import_lease_expires_at = v_now + interval '10 minutes',
    updated_at = v_now
  where id = p_job_id;
  return jsonb_build_object('job_id', p_job_id, 'next_batch_number', p_batch_number + 1,
    'total_batches', v_total, 'imported', v_imported, 'existing', v_existing,
    'excluded', v_excluded, 'idempotent_replay', false, 'results', v_results);
end;
$function$;

create or replace function public.finish_catalog_import(
  p_job_id uuid, p_worker_id text, p_lease_token uuid, p_error_summary text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ingestion_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_next integer;
  v_total integer;
  v_status text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select j.* into v_job from public.ingestion_jobs j
  where j.id = p_job_id and j.job_type = 'catalog_import' and j.status = 'running'
  for update;
  if not found or v_job.catalog_import_lease_token is distinct from p_lease_token
    or v_job.catalog_import_lease_expires_at <= v_now
    or v_job.metadata->'catalog_import'->>'worker_id' is distinct from p_worker_id then
    raise exception 'catalog import lease is stale' using errcode = '40001';
  end if;
  v_next := (v_job.metadata->'catalog_import'->>'next_batch_number')::integer;
  v_total := (v_job.metadata->'catalog_import'->>'total_batches')::integer;
  v_status := case when v_next > v_total and p_error_summary is null then 'succeeded' else 'partial' end;
  update public.ingestion_jobs set status = v_status, finished_at = v_now,
    error_summary = nullif(left(coalesce(p_error_summary, ''), 1000), ''),
    catalog_import_lease_token = null, catalog_import_lease_expires_at = null,
    updated_at = v_now
  where id = p_job_id;
  return jsonb_build_object('job_id', p_job_id, 'status', v_status,
    'next_batch_number', v_next, 'total_batches', v_total,
    'imported', coalesce((v_job.metadata->'catalog_import'->>'imported')::integer, 0),
    'existing', coalesce((v_job.metadata->'catalog_import'->>'existing')::integer, 0),
    'excluded', coalesce((v_job.metadata->'catalog_import'->>'excluded')::integer, 0));
end;
$function$;

create or replace function public.catalog_import_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ingestion_jobs%rowtype;
  v_item_counts jsonb;
  v_item_count integer;
  v_source_count integer;
  v_expected_items integer;
  v_expected_processed integer;
  v_next integer;
  v_total integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select j.* into v_job from public.ingestion_jobs j
  where j.job_type = 'catalog_import'
  order by j.created_at desc limit 1;
  if not found then return jsonb_build_object('exists', false); end if;
  select coalesce(jsonb_object_agg(x.status, x.count), '{}'::jsonb) into v_item_counts
  from (select i.status, count(*)::integer as count from public.ingestion_items i
    where i.job_id = v_job.id group by i.status) x;
  select count(*)::integer into v_item_count from public.ingestion_items i where i.job_id = v_job.id;
  select count(*)::integer into v_source_count from public.source_records s
    where s.source_metadata->>'catalog_import_job_id' = v_job.id::text;
  v_next := (v_job.metadata->'catalog_import'->>'next_batch_number')::integer;
  v_total := (v_job.metadata->'catalog_import'->>'total_batches')::integer;
  v_expected_items := coalesce((v_job.metadata->'catalog_import'->>'imported')::integer, 0)
    + coalesce((v_job.metadata->'catalog_import'->>'existing')::integer, 0)
    + coalesce((v_job.metadata->'catalog_import'->>'excluded')::integer, 0);
  v_expected_processed := v_expected_items;
  return jsonb_build_object(
    'exists', true, 'job_id', v_job.id, 'status', v_job.status,
    'created_at', v_job.created_at, 'started_at', v_job.started_at, 'finished_at', v_job.finished_at,
    'items_discovered', v_job.items_discovered, 'items_processed', v_job.items_processed,
    'items_created', v_job.items_created, 'items_skipped', v_job.items_skipped,
    'metadata', v_job.metadata, 'ingestion_item_status_counts', v_item_counts,
    'lease_expires_at', v_job.catalog_import_lease_expires_at,
    'reconciliation', jsonb_build_object(
      'recorded_ingestion_items', v_item_count,
      'expected_ingestion_items', v_expected_items,
      'candidate_item_ledger_matches', v_item_count = v_expected_items,
      'import_source_records', v_source_count,
      'processed_candidates', v_job.items_processed,
      'expected_processed_candidates', v_expected_processed,
      'job_candidate_counters_match', v_job.items_processed = v_expected_processed,
      'checkpointed_batches', greatest(v_next - 1, 0),
      'total_batches', v_total,
      'uncheckpointed_batches', greatest(v_total - v_next + 1, 0),
      'unprocessed_candidates', greatest(v_job.items_discovered - v_job.items_processed, 0)
    )
  );
end;
$function$;

revoke all on function public.start_catalog_import(text, integer, integer, text, text, boolean, text, uuid) from public, anon, authenticated;
revoke all on function public.heartbeat_catalog_import(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.commit_catalog_import_batch(uuid, text, uuid, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.finish_catalog_import(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.catalog_import_status() from public, anon, authenticated;
grant execute on function public.start_catalog_import(text, integer, integer, text, text, boolean, text, uuid) to service_role;
grant execute on function public.heartbeat_catalog_import(uuid, text, uuid) to service_role;
grant execute on function public.commit_catalog_import_batch(uuid, text, uuid, integer, text, jsonb) to service_role;
grant execute on function public.finish_catalog_import(uuid, text, uuid, text) to service_role;
grant execute on function public.catalog_import_status() to service_role;

-- New seed metadata is consumed only when the standard assessment RPC creates
-- a new pending-review project. Existing projects are never overwritten.
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
  v_import_item_id uuid;
  v_catalog_import jsonb;
  v_seed_license_id text;
  v_tag_value jsonb;
  v_tag text;
  v_tag_slug text;
  v_tag_id uuid;
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
  if v_repository.provider_repository_id::numeric > 9007199254740991
    or v_candidate.provider <> 'github'
    or v_candidate.provider_repository_id <> v_repository.provider_repository_id
    or v_candidate.enrichment_status <> 'succeeded' or v_candidate.enrichment_completed_at < v_repository.source_observed_at
    or v_candidate.review_status = 'rejected' or v_candidate.queue_status = 'discarded'
    or exists (select 1 from public.repository_candidates c where c.repository_id = v_repository.id
      and (c.review_status = 'rejected' or c.queue_status = 'discarded')) then
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
  select v_assessment.id, source_id from unnest(p_source_record_ids) source_id on conflict do nothing;
  select i.id, i.result->'catalog_import' into v_import_item_id, v_catalog_import
  from public.ingestion_items i
  join public.ingestion_jobs j on j.id = i.job_id and j.job_type = 'catalog_import'
  where i.item_type = 'catalog_seed_candidate' and i.candidate_id = v_candidate.id
    and jsonb_typeof(i.result->'catalog_import'->'source_candidate') = 'object'
  order by i.created_at desc, i.id desc limit 1;

  v_project_id := v_repository.project_id;
  if v_primary_id is not null and v_project_id is null
    and p_result->'quality'->>'status' = 'eligible_for_review' then
    v_seed_license_id := v_catalog_import->'source_candidate'->>'license_spdx_id';
    if v_catalog_import->'source_candidate'->>'license_review_status' = 'needs_review'
      or (v_seed_license_id is not null and v_seed_license_id is distinct from p_result->'license'->>'identifier') then
      v_license_status := 'needs_review';
    end if;
    if v_catalog_import is null then
      -- Keep the established discovery/assessment collision behavior for
      -- repositories outside this catalog import.
      v_slug := 'github-' || v_repository.provider_repository_id;
    else
      v_slug := private.resolve_catalog_import_slug(
        null, v_candidate.id,
        coalesce(nullif(v_catalog_import->>'resolved_slug', ''), 'github-' || v_repository.provider_repository_id),
        v_repository.provider_repository_id
      );
    end if;
    if not exists (select 1 from public.projects p where p.slug = v_slug) then
      insert into public.projects (
        slug, name, summary, description, official_website_url, license_status,
        license_identifier, license_verified_at, publication_status, quality_status,
        featured, primary_repository_id, published_at
      ) values (
        v_slug,
        coalesce(nullif(btrim(v_catalog_import->'source_candidate'->>'name'), ''), v_repository.repository_name),
        coalesce(v_catalog_import->'source_candidate'->>'tagline', ''),
        coalesce(nullif(btrim(v_catalog_import->'source_candidate'->>'description'), ''),
          case when v_repository.source_field_states->>'description' = 'present'
            then coalesce(nullif(btrim(v_repository.description), ''), '') else '' end),
        case when v_catalog_import->'source_candidate'->>'website_url' ~* '^https://[^[:space:]]+$'
          then v_catalog_import->'source_candidate'->>'website_url' else null end,
        v_license_status,
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
      if jsonb_typeof(v_catalog_import->'source_candidate'->'tags') = 'array' then
        for v_tag_value in select value from jsonb_array_elements(v_catalog_import->'source_candidate'->'tags')
        loop
          v_tag := left(btrim(v_tag_value #>> '{}'), 100);
          v_tag_slug := trim(both '-' from regexp_replace(lower(v_tag), '[^a-z0-9]+', '-', 'g'));
          if v_tag_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
            insert into public.tags (slug, name) values (v_tag_slug, v_tag)
            on conflict (slug) do nothing;
            select t.id into v_tag_id from public.tags t where t.slug = v_tag_slug;
            insert into public.project_tags (project_id, tag_id)
            values (v_project_id, v_tag_id) on conflict do nothing;
          end if;
        end loop;
      end if;
      if v_import_item_id is not null then
        update public.ingestion_items set result = jsonb_set(result,
          '{catalog_import}', (result->'catalog_import') || jsonb_build_object(
            'project_id', v_project_id, 'draft_slug', v_slug, 'draft_created_unpublished', true
          ), true), updated_at = v_now where id = v_import_item_id;
      end if;
      v_drafted := true;
    else
      v_project_id := null;
    end if;
  end if;

  if v_drafted then v_status := 'assessed';
  elsif v_project_id is not null then
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
  return jsonb_build_object('status', v_status, 'drafted', v_drafted,
    'project_id', v_project_id, 'review_queue_id', v_queue_id,
    'publication_status', case when v_drafted then 'pending_review' else null end);
end;
$function$;

revoke all on function public.complete_github_repository_assessment(uuid, text, uuid, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.complete_github_repository_assessment(uuid, text, uuid, jsonb, uuid[]) to service_role;

-- Keep operator readiness aware of this migration and its service-only RPCs.
alter function public.pipeline_operator_report() rename to pipeline_operator_report_m2_05_previous;
revoke all on function public.pipeline_operator_report_m2_05_previous() from public, anon, authenticated, service_role;

create function public.pipeline_operator_report()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_report jsonb;
  v_schema jsonb;
  v_migration_applied boolean := false;
  v_migration text := '20261109110000';
  v_import_rpcs jsonb;
  v_missing_import_rpcs text[] := array[]::text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  v_report := public.pipeline_operator_report_m2_05_previous();
  v_schema := v_report->'schema';
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select exists (select 1 from supabase_migrations.schema_migrations where version::text = $1)'
      into v_migration_applied using v_migration;
  end if;
  v_schema := jsonb_set(v_schema, '{expected_migrations}',
    coalesce(v_schema->'expected_migrations', '[]'::jsonb) || jsonb_build_array(v_migration), true);
  v_schema := jsonb_set(v_schema, '{applied_migrations}',
    coalesce(v_schema->'applied_migrations', '[]'::jsonb)
      || case when v_migration_applied then jsonb_build_array(v_migration) else '[]'::jsonb end, true);
  v_schema := jsonb_set(v_schema, '{missing_migrations}',
    coalesce(v_schema->'missing_migrations', '[]'::jsonb)
      || case when v_migration_applied then '[]'::jsonb else jsonb_build_array(v_migration) end, true);
  with required(signature) as (values
    ('public.start_catalog_import(text,integer,integer,text,text,boolean,text,uuid)'),
    ('public.heartbeat_catalog_import(uuid,text,uuid)'),
    ('public.commit_catalog_import_batch(uuid,text,uuid,integer,text,jsonb)'),
    ('public.finish_catalog_import(uuid,text,uuid,text)'),
    ('public.catalog_import_status()')
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
  into v_import_rpcs, v_missing_import_rpcs from checked;
  v_schema := jsonb_set(v_schema, '{required_rpcs}',
    coalesce(v_schema->'required_rpcs', '[]'::jsonb) || v_import_rpcs, true);
  v_schema := jsonb_set(v_schema, '{missing_rpcs}',
    coalesce(v_schema->'missing_rpcs', '[]'::jsonb) || to_jsonb(v_missing_import_rpcs), true);
  v_schema := jsonb_set(v_schema, '{missing_service_role_permissions}',
    coalesce(v_schema->'missing_service_role_permissions', '[]'::jsonb)
      || to_jsonb(v_missing_import_rpcs), true);
  v_schema := jsonb_set(v_schema, '{ready}', to_jsonb(
    coalesce((v_schema->>'ready')::boolean, false) and v_migration_applied
      and cardinality(v_missing_import_rpcs) = 0), true);
  v_report := jsonb_set(v_report, '{report_version}', '"m2-05-v1"'::jsonb, true);
  return jsonb_set(v_report, '{schema}', v_schema, true);
end;
$function$;
revoke all on function public.pipeline_operator_report() from public, anon, authenticated;
grant execute on function public.pipeline_operator_report() to service_role;
