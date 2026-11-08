-- M1-06 adds one service-only, read-only report endpoint for operator
-- preflight, inventory, active leases, and integrity findings. It never
-- repairs, deletes, approves, verifies, or publishes data.

create or replace function public.pipeline_operator_report()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_expected_migrations text[] := array[
    '20261104100000', '20261104100100', '20261104100200', '20261104100300',
    '20261104100400', '20261104100500', '20261105100000', '20261105110000',
    '20261105120000', '20261105130000', '20261106100000', '20261106110000',
    '20261107120000', '20261107130000', '20261107150000', '20261107160000'
  ];
  v_migration_table boolean;
  v_applied text[] := array[]::text[];
  v_missing_migrations text[] := array[]::text[];
  v_rpcs jsonb;
  v_missing_rpcs text[] := array[]::text[];
  v_missing_permissions text[] := array[]::text[];
  v_table_permissions jsonb;
  v_missing_table_permissions text[] := array[]::text[];
  v_category_count integer;
  v_missing_categories text[] := array[]::text[];
  v_bucket jsonb;
  v_inventory jsonb;
  v_observations jsonb;
  v_findings jsonb;
  v_running_jobs jsonb;
  v_active_leases jsonb;
  v_checkpoints jsonb;
  v_retry_schedule jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  v_migration_table := to_regclass('supabase_migrations.schema_migrations') is not null;
  if v_migration_table then
    execute 'select coalesce(array_agg(version::text order by version::text), array[]::text[]) from supabase_migrations.schema_migrations where version::text = any($1)'
      into v_applied using v_expected_migrations;
    select coalesce(array_agg(m.version order by m.version), array[]::text[])
      into v_missing_migrations
    from unnest(v_expected_migrations) m(version)
    where not (m.version = any(v_applied));
  else
    v_missing_migrations := v_expected_migrations;
  end if;

  with required(signature) as (values
    ('public.start_discovery_job(text,text,jsonb)'),
    ('public.claim_discovery_partitions(uuid,text,integer,integer)'),
    ('public.commit_discovery_page(uuid,text,uuid,text,integer,timestamp with time zone,text,integer,jsonb,integer,boolean,integer,jsonb,text,jsonb,integer)'),
    ('public.fail_discovery_partition(uuid,text,uuid,text,boolean,bigint)'),
    ('public.release_discovery_partition(uuid,text,uuid)'),
    ('public.finish_discovery_job(uuid,text,text)'),
    ('public.start_github_enrichment_job(boolean,jsonb)'),
    ('public.claim_github_enrichment_candidates(uuid,text,integer,integer)'),
    ('public.commit_github_repository_enrichment(uuid,text,uuid,jsonb)'),
    ('public.fail_github_repository_enrichment(uuid,text,uuid,text,boolean,bigint,jsonb)'),
    ('public.finish_github_enrichment_job(uuid,text,text)'),
    ('public.start_github_repository_assessment_job(boolean,jsonb)'),
    ('public.claim_github_repository_assessments(uuid,text,integer,integer)'),
    ('public.complete_github_repository_assessment(uuid,text,uuid,jsonb,uuid[])'),
    ('public.fail_github_repository_assessment(uuid,text,uuid,text,boolean,bigint)'),
    ('public.finish_github_repository_assessment_job(uuid)'),
    ('public.register_project_logo_candidate(uuid,text,text,text,text,uuid,uuid,timestamp with time zone,jsonb)'),
    ('public.tag_pipeline_ingestion_job(uuid,uuid)'),
    ('public.pipeline_operator_verify_run(uuid)')
  ), checked as (
    select signature, to_regprocedure(signature) as proc
    from required
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'signature', signature,
      'exists', proc is not null,
      'service_role_execute', case when proc is null then false
        else has_function_privilege('service_role', proc, 'EXECUTE') end
    ) order by signature), '[]'::jsonb),
    coalesce(array_agg(signature) filter (where proc is null), array[]::text[]),
    coalesce(array_agg(signature) filter (where proc is not null
      and not has_function_privilege('service_role', proc, 'EXECUTE')), array[]::text[])
  into v_rpcs, v_missing_rpcs, v_missing_permissions
  from checked;

  with required(table_name, privilege_name) as (values
    ('public.projects', 'SELECT'),
    ('public.repositories', 'SELECT'),
    ('public.categories', 'SELECT'),
    ('public.repository_candidates', 'SELECT'),
    ('public.project_logos', 'SELECT'),
    ('public.repository_assessments', 'SELECT'),
    ('public.repository_assessment_sources', 'SELECT'),
    ('public.repository_candidate_sources', 'SELECT'),
    ('public.repository_topics', 'SELECT'),
    ('public.repository_languages', 'SELECT'),
    ('public.project_categories', 'SELECT'),
    ('public.repository_snapshots', 'SELECT'),
    ('public.releases', 'SELECT'),
    ('public.review_queue', 'SELECT'),
    ('public.source_records', 'INSERT'),
    ('public.source_records', 'SELECT'),
    ('public.discovery_queries', 'SELECT'),
    ('public.ingestion_jobs', 'SELECT'),
    ('public.ingestion_items', 'SELECT'),
    ('storage.buckets', 'SELECT'),
    ('storage.objects', 'SELECT')
  ), checked as (
    select table_name, privilege_name, to_regclass(table_name) as relation,
      case when to_regclass(table_name) is null then false
        else has_table_privilege('service_role', to_regclass(table_name), privilege_name) end as allowed
    from required
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('table', table_name, 'privilege', privilege_name,
      'exists', relation is not null, 'allowed', allowed) order by table_name, privilege_name), '[]'::jsonb),
    coalesce(array_agg(table_name || ':' || privilege_name) filter (where not allowed), array[]::text[])
  into v_table_permissions, v_missing_table_permissions
  from checked;

  select count(*)::integer into v_category_count
  from public.categories where is_active;
  select coalesce(array_agg(expected.slug order by expected.slug), array[]::text[])
    into v_missing_categories
  from unnest(array[
    'developer-tools', 'ai-machine-learning', 'productivity', 'design', 'analytics',
    'infrastructure', 'data-databases', 'communication', 'self-hosted',
    'security-privacy', 'automation-workflows'
  ]) expected(slug)
  where not exists (select 1 from public.categories c where c.slug = expected.slug and c.is_active);

  select case when b.id is null then jsonb_build_object('exists', false) else jsonb_build_object(
    'exists', true, 'public', b.public, 'file_size_limit', b.file_size_limit,
    'mime_types', b.allowed_mime_types
  ) end into v_bucket
  from (select 1) seed
  left join storage.buckets b on b.id = 'project-logos';

  select jsonb_build_object(
    'discovered_candidates', (select count(*) from public.repository_candidates),
    'candidates_awaiting_enrichment', (select count(*) from public.repository_candidates
      where provider = 'github' and review_status <> 'rejected' and queue_status <> 'discarded'
        and enrichment_status in ('queued', 'retry_wait', 'processing')),
    'successfully_enriched_public_repositories', (select count(*) from public.repositories r
      where r.provider = 'github' and r.availability_status = 'available' and r.is_private is false
        and lower(btrim(coalesce(r.visibility, ''))) = 'public' and r.is_disabled is false
        and r.last_successful_sync_at is not null),
    'partial_enrichments', (select count(*) from public.repository_candidates
      where provider = 'github' and enrichment_status = 'retry_wait'),
    'failed_enrichments', (select count(*) from public.repository_candidates
      where provider = 'github' and enrichment_status = 'failed'),
    'assessed_repositories', (select count(distinct repository_id) from public.repository_assessments
      where status in ('assessed', 'needs_review')),
    'pending_review_project_drafts', (select count(*) from public.projects
      where publication_status = 'pending_review'),
    'projects_lacking_classification_evidence', (select count(*) from public.projects p
      where p.publication_status in ('draft', 'pending_review') and not exists (
        select 1 from public.project_categories pc join public.categories c on c.id = pc.category_id
        where pc.project_id = p.id and c.is_active)),
    'pending_review_queue_items', (select count(*) from public.review_queue where status in ('open', 'in_review')),
    'logos_pending_review', (select count(*) from public.project_logos where verification_status = 'pending_review'),
    'logos_approved', (select count(*) from public.project_logos where verification_status = 'approved'),
    'logos_rejected', (select count(*) from public.project_logos where verification_status = 'rejected'),
    'logos_revoked', (select count(*) from public.project_logos where verification_status = 'revoked'),
    'projects_requiring_letter_fallback', (select count(*) from public.projects p
      where not exists (select 1 from public.project_logos l
        where l.project_id = p.id and l.verification_status = 'approved')),
    'published_projects', (select count(*) from public.projects where publication_status = 'published'),
    'rate_limited_or_failed_jobs', (select count(*) from public.ingestion_jobs j
      where j.status in ('partial', 'failed') or coalesce(j.error_summary, '') ilike '%rate limit%'
        or coalesce(j.error_summary, '') ilike '%rate_limit%'),
    'source_observation_count', (select count(*) from public.source_records)
  ) into v_inventory;

  select coalesce(jsonb_object_agg(x.record_kind, jsonb_build_object(
      'last_successful_at', x.last_successful_at, 'count', x.observation_count
    )), '{}'::jsonb)
    into v_observations
  from (
    select record_kind, max(fetched_at) as last_successful_at, count(*) as observation_count
    from public.source_records
    where http_status = 200 and source_metadata->>'validated' = 'true'
    group by record_kind
  ) x;

  with raw_findings(code, severity, record_id) as (
    select 'duplicate_provider_repository_id', 'critical', (array_agg(r.id::text order by r.id::text))[1]
    from public.repositories r where r.provider = 'github'
    group by r.provider, r.provider_repository_id having count(*) > 1
    union all
    select 'candidate_repository_identity_mismatch', 'critical', c.id::text
    from public.repository_candidates c join public.repositories r on r.id = c.repository_id
    where c.provider is distinct from r.provider
      or c.provider_repository_id is distinct from r.provider_repository_id
      or c.full_name is distinct from r.full_name
    union all
    select 'project_primary_repository_missing', 'high', p.id::text
    from public.projects p left join public.repositories r
      on r.id = p.primary_repository_id and r.project_id = p.id
    where p.publication_status in ('draft', 'pending_review', 'published')
      and (p.primary_repository_id is null or r.id is null)
    union all
    select 'restricted_repository_assessed', 'critical', a.id::text
    from public.repository_assessments a join public.repositories r on r.id = a.repository_id
    where a.status in ('assessed', 'needs_review')
      and (r.provider <> 'github' or r.availability_status <> 'available' or r.is_private is distinct from false
        or lower(btrim(coalesce(r.visibility, ''))) <> 'public' or r.is_disabled is distinct from false)
    union all
    select 'draft_category_without_active_evidence', 'high', p.id::text
    from public.projects p where p.publication_status in ('draft', 'pending_review') and not exists (
      select 1 from public.project_categories pc join public.categories c on c.id = pc.category_id
      where pc.project_id = p.id and c.is_active
    )
    union all
    select 'assessment_missing_validated_provenance', 'high', a.id::text
    from public.repository_assessments a
    where a.status in ('assessed', 'needs_review') and (
      not exists (select 1 from public.repository_assessment_sources x where x.assessment_id = a.id)
      or exists (select 1 from public.repository_assessment_sources x
        left join public.source_records s on s.id = x.source_record_id
        where x.assessment_id = a.id and (s.id is null or s.http_status is distinct from 200
          or s.source_metadata->>'validated' is distinct from 'true'
          or s.repository_id is distinct from a.repository_id))
    )
    union all
    select 'assessment_review_queue_relationship_mismatch', 'high', a.id::text
    from public.repository_assessments a
    where a.status in ('assessed', 'needs_review') and not exists (
      select 1 from public.review_queue q where q.assessment_id = a.id
        and ((q.project_id is not null and exists (select 1 from public.projects p
              where p.id = q.project_id and p.primary_repository_id = a.repository_id))
          or (q.repository_id = a.repository_id and q.project_id is null))
    )
    union all
    select 'pending_logo_review_queue_missing', 'high', l.id::text
    from public.project_logos l where l.verification_status = 'pending_review'
      and not exists (select 1 from public.review_queue q where q.project_logo_id = l.id
        and q.status in ('open', 'in_review'))
    union all
    select 'review_queue_target_relationship_mismatch', 'high', q.id::text
    from public.review_queue q
    where (q.project_logo_id is not null and not exists (select 1 from public.project_logos l
        where l.id = q.project_logo_id and q.project_id is null and q.repository_id is null))
      or (q.assessment_id is not null and not exists (select 1 from public.repository_assessments a
        where a.id = q.assessment_id and (
          (q.repository_id = a.repository_id and q.project_id is null)
          or (q.project_id is not null and exists (select 1 from public.repositories r
            where r.id = a.repository_id and r.project_id = q.project_id))
        )))
    union all
    select 'snapshot_observation_inconsistent', 'medium', s.id::text
    from public.repository_snapshots s left join public.source_records source on source.id = s.source_record_id
    left join public.repositories r on r.id = s.repository_id
    where s.snapshot_date <> (s.captured_at at time zone 'UTC')::date
      or source.id is null or source.repository_id is distinct from s.repository_id
      or source.record_kind <> 'repository' or source.fetched_at is distinct from s.captured_at
      or (r.source_observed_at = s.captured_at and (r.stars <> s.stars or r.forks <> s.forks))
    union all
    select 'approved_logo_object_missing_or_invalid', 'critical', l.id::text
    from public.project_logos l
    left join storage.objects o on o.bucket_id = 'project-logos' and o.name = l.storage_path
    where l.verification_status = 'approved'
      and (l.storage_path is null or o.id is null or l.approval_provenance is null
        or (l.content_digest is not null and l.content_digest !~ '^[a-f0-9]{64}$'))
    union all
    select 'pipeline_project_has_unexpected_state', 'critical', p.id::text
    from public.projects p join public.repositories r on r.project_id = p.id
    where exists (select 1 from public.repository_assessments a where a.repository_id = r.id
      and a.policy_version = 'm1-04-assessment-v1')
      and (p.publication_status = 'published' or p.featured
        or p.quality_status = 'verified' or p.license_status = 'verified_open_source')
    union all
    select 'pending_logo_has_approval_or_primary_state', 'high', l.id::text
    from public.project_logos l where l.verification_status = 'pending_review'
      and (l.is_primary or l.storage_path is not null or l.verified_at is not null or l.approval_provenance is not null)
    union all
    select 'assessment_job_counter_mismatch', 'medium', j.id::text
    from public.ingestion_jobs j
    where j.job_type = 'github_assessment' and j.status <> 'running'
      and (
        coalesce((j.metadata->>'assessed')::integer, 0) <> (select count(*) from public.repository_assessments a
          where a.job_id = j.id and a.status in ('assessed', 'needs_review'))
        or coalesce((j.metadata->>'failed')::integer, 0) <> (select count(*) from public.repository_assessments a
          where a.job_id = j.id and a.status = 'failed')
        or coalesce((j.metadata->>'drafted')::integer, 0) <> j.items_created
      )
    union all
    select 'enrichment_job_counter_mismatch', 'medium', j.id::text
    from public.ingestion_jobs j
    where j.job_type = 'github_enrichment' and j.status <> 'running'
      and j.items_processed <> (select count(*) from public.ingestion_items i
        where i.job_id = j.id and i.item_type = 'github_repository'
          and (i.status in ('succeeded', 'failed', 'skipped')
            or (i.status = 'retry_wait' and i.result->>'partial' = 'true')))
    union all
    select 'discovery_job_counter_mismatch', 'medium', j.id::text
    from public.ingestion_jobs j
    where j.job_type = 'github_discovery' and j.status <> 'running'
      and (j.items_processed <> j.items_discovered
        or j.items_discovered <> j.items_created + j.items_updated)
    union all
    select 'duplicate_provider_candidate_id', 'critical', (array_agg(c.id::text order by c.id::text))[1]
    from public.repository_candidates c where c.provider = 'github'
    group by c.provider, c.provider_repository_id having count(*) > 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', grouped.code, 'severity', grouped.severity,
    'affected_count', grouped.affected_count, 'affected_record_ids', grouped.record_ids
  ) order by case grouped.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, grouped.code), '[]'::jsonb)
  into v_findings
  from (
    select code, severity, count(*) as affected_count,
      to_jsonb((array_agg(record_id order by record_id))[1:100]) as record_ids
    from raw_findings group by code, severity
  ) grouped;

  select coalesce(jsonb_agg(jsonb_build_object(
    'job_id', id, 'job_type', job_type, 'status', status,
    'started_at', started_at, 'error_summary', error_summary
  ) order by started_at desc), '[]'::jsonb)
  into v_running_jobs from public.ingestion_jobs where status = 'running';

  select jsonb_build_object(
    'discovery', (select count(*) from public.discovery_queries
      where status = 'running' and lease_expires_at > clock_timestamp()),
    'enrichment', (select count(*) from public.repository_candidates
      where enrichment_status = 'processing' and enrichment_lease_expires_at > clock_timestamp()),
    'assessment', (select count(*) from public.repository_assessments
      where status = 'processing' and lease_expires_at > clock_timestamp()),
    'logo_approval', (select count(*) from public.project_logos
      where approval_token is not null and approval_lease_expires_at > clock_timestamp())
  ) into v_active_leases;

  select coalesce(jsonb_agg(jsonb_build_object(
    'partition_key', q.partition_key, 'status', q.status, 'cursor', q.cursor,
    'pages_fetched', q.pages_fetched, 'next_attempt_at', q.next_attempt_at,
    'last_error', q.last_error, 'lease_expires_at', q.lease_expires_at,
    'updated_at', q.updated_at
  ) order by q.updated_at desc), '[]'::jsonb)
  into v_checkpoints
  from (select * from public.discovery_queries where plan_name = 'initial'
    order by updated_at desc limit 20) q;

  select coalesce(jsonb_agg(x.item order by x.next_attempt_at), '[]'::jsonb)
  into v_retry_schedule
  from (
    select q.next_attempt_at, jsonb_build_object('stage', 'discovery', 'partition_key', q.partition_key,
      'status', q.status, 'next_attempt_at', q.next_attempt_at, 'reason', q.last_error) as item
    from public.discovery_queries q where q.status = 'retry_wait'
    union all
    select c.enrichment_next_attempt_at, jsonb_build_object('stage', 'enrichment', 'candidate_id', c.id,
      'status', c.enrichment_status, 'next_attempt_at', c.enrichment_next_attempt_at, 'reason', c.enrichment_error)
    from public.repository_candidates c where c.enrichment_status = 'retry_wait'
    union all
    select a.next_attempt_at, jsonb_build_object('stage', 'assessment', 'assessment_id', a.id,
      'status', a.status, 'next_attempt_at', a.next_attempt_at, 'reason', a.last_error)
    from public.repository_assessments a where a.status = 'retry_wait'
  ) x;

  return jsonb_build_object(
    'report_version', 'm1-06-v1',
    'generated_at', clock_timestamp(),
    'schema', jsonb_build_object(
      'migration_table_available', v_migration_table,
      'expected_migrations', to_jsonb(v_expected_migrations),
      'applied_migrations', to_jsonb(v_applied),
      'missing_migrations', to_jsonb(v_missing_migrations),
      'required_rpcs', v_rpcs,
      'missing_rpcs', to_jsonb(v_missing_rpcs),
      'missing_service_role_permissions', to_jsonb(v_missing_permissions),
      'table_permissions', v_table_permissions,
      'missing_table_permissions', to_jsonb(v_missing_table_permissions),
      'ready', v_migration_table and cardinality(v_missing_migrations) = 0
        and cardinality(v_missing_rpcs) = 0 and cardinality(v_missing_permissions) = 0
        and cardinality(v_missing_table_permissions) = 0
    ),
    'categories', jsonb_build_object('active_count', v_category_count,
      'expected_active_count', 11, 'missing_slugs', to_jsonb(v_missing_categories),
      'ready', v_category_count = 11 and cardinality(v_missing_categories) = 0),
    'storage_bucket', coalesce(v_bucket, jsonb_build_object('exists', false)),
    'inventory', v_inventory,
    'last_successful_source_observations', v_observations,
    'running_jobs', v_running_jobs,
    'active_leases', v_active_leases,
    'checkpoints', v_checkpoints,
    'retry_schedule', v_retry_schedule,
    'integrity_findings', v_findings
  );
end;
$function$;

revoke all on function public.pipeline_operator_report() from public, anon, authenticated;
grant execute on function public.pipeline_operator_report() to service_role;

-- Correlate the existing durable worker jobs with one bounded orchestrator run.
create or replace function public.tag_pipeline_ingestion_job(p_job_id uuid, p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_job_id is null or p_run_id is null then
    raise exception 'job and pipeline run identifiers are required' using errcode = '22023';
  end if;
  update public.ingestion_jobs
  set metadata = metadata || jsonb_build_object('pipeline_run_id', p_run_id::text),
      updated_at = clock_timestamp()
  where id = p_job_id and status = 'running'
    and job_type in ('github_discovery', 'github_enrichment', 'github_assessment');
  if not found then
    raise exception 'running pipeline job was not found' using errcode = '55000';
  end if;
end;
$function$;

revoke all on function public.tag_pipeline_ingestion_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.tag_pipeline_ingestion_job(uuid, uuid) to service_role;

-- Inspect only records connected to this run's existing job IDs and provenance.
-- The bounded arrays make the live-smoke result auditable without reading whole tables.
create or replace function public.pipeline_operator_verify_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_run_id is null then
    raise exception 'pipeline run identifier is required' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'pipeline_run_id', p_run_id,
    'discovered_candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'provider_repository_id', c.provider_repository_id,
        'source_observation_valid', exists (
          select 1 from public.repository_candidate_sources cs
          join public.discovery_queries q on q.id = cs.discovery_query_id
          join public.ingestion_jobs j on j.id = q.job_id
          join public.source_records s on s.id = cs.source_record_id
          where cs.candidate_id = c.id and j.metadata->>'pipeline_run_id' = p_run_id::text
            and s.record_kind = 'discovery_page' and s.http_status = 200
            and s.source_metadata->>'resource_type' = 'repository_search'
        )
      ) order by c.id)
      from (select distinct c.id, c.provider_repository_id
        from public.repository_candidates c
        join public.repository_candidate_sources cs on cs.candidate_id = c.id
        join public.discovery_queries q on q.id = cs.discovery_query_id
        join public.ingestion_jobs j on j.id = q.job_id
        where j.metadata->>'pipeline_run_id' = p_run_id::text
        order by c.id limit 50) c
    ), '[]'::jsonb),
    'enriched_repositories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'provider_repository_id', r.provider_repository_id,
        'public_eligible', r.availability_status = 'available' and r.is_private is false
          and lower(btrim(coalesce(r.visibility, ''))) = 'public' and r.is_disabled is false,
        'enrichment_succeeded', c.enrichment_status = 'succeeded' and r.last_successful_sync_at is not null
      ) order by r.id)
      from (select distinct c.id, c.repository_id, c.enrichment_status
        from public.repository_candidates c
        join public.ingestion_jobs j on j.id = c.enrichment_job_id
        where j.metadata->>'pipeline_run_id' = p_run_id::text and c.repository_id is not null
        order by c.id limit 50) c
      join public.repositories r on r.id = c.repository_id
    ), '[]'::jsonb),
    'assessments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'repository_id', a.repository_id, 'status', a.status,
        'assessment_complete', a.status in ('assessed', 'needs_review'),
        'provenance_valid', exists (
          select 1 from public.repository_assessment_sources x
          join public.source_records s on s.id = x.source_record_id
          where x.assessment_id = a.id and s.http_status = 200
            and s.source_metadata->>'validated' = 'true' and s.repository_id = a.repository_id
        ),
        'review_relationship_valid', exists (
          select 1 from public.repositories r
          left join public.review_queue q on q.assessment_id = a.id
            and q.status in ('open', 'in_review')
          where r.id = a.repository_id and (
            q.project_id = r.project_id or (q.project_id is null and q.repository_id = r.id)
          )
        )
      ) order by a.id)
      from (select a.id, a.repository_id, a.status from public.repository_assessments a
        join public.ingestion_jobs j on j.id = a.job_id
        where j.metadata->>'pipeline_run_id' = p_run_id::text
        order by a.id limit 50) a
    ), '[]'::jsonb),
    'project_drafts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'primary_repository_id', p.primary_repository_id,
        'publication_status', p.publication_status, 'category_evidence_count', counts.category_evidence_count,
        'draft_valid', p.publication_status = 'pending_review' and p.featured is false
          and p.quality_status <> 'verified' and p.license_status <> 'verified_open_source'
          and p.license_verified_at is null and p.primary_repository_id = r.id
          and r.project_id = p.id and a.status in ('assessed', 'needs_review')
      ) order by p.id)
      from (select distinct a.repository_id, a.id, a.status, j.started_at from public.repository_assessments a
        join public.ingestion_jobs j on j.id = a.job_id
        where j.metadata->>'pipeline_run_id' = p_run_id::text
        order by a.id limit 50) a
      join public.repositories r on r.id = a.repository_id
      join public.projects p on p.primary_repository_id = r.id and r.project_id = p.id
      cross join lateral (select count(*)::integer as category_evidence_count
        from public.project_categories pc join public.categories c on c.id = pc.category_id
        where pc.project_id = p.id and c.is_active) counts
      where p.created_at >= a.started_at
    ), '[]'::jsonb),
    'logo_candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'project_id', l.project_id,
        'logo_candidate_valid', l.verification_status = 'pending_review' and l.storage_path is null
          and l.is_primary is false and l.verified_at is null and l.approval_provenance is null,
        'review_relationship_valid', exists (select 1 from public.review_queue q
          where q.project_logo_id = l.id and q.status in ('open', 'in_review'))
      ) order by l.id)
      from (select l.id, l.project_id, l.verification_status, l.storage_path, l.is_primary,
          l.verified_at, l.approval_provenance, l.source_provenance from public.project_logos l
        where l.source_provenance->>'pipeline_run_id' = p_run_id::text
        order by l.id limit 50) l
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;

revoke all on function public.pipeline_operator_verify_run(uuid) from public, anon, authenticated;
grant execute on function public.pipeline_operator_verify_run(uuid) to service_role;
