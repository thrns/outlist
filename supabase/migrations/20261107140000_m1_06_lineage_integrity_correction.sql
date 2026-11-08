-- M1-06 correction: keep repository identity stable across renames, avoid
-- inferring unauthorized publication, and verify one bounded coherent chain.

alter function public.pipeline_operator_report() rename to pipeline_operator_report_v1;
revoke all on function public.pipeline_operator_report_v1() from public, anon, authenticated, service_role;

create function public.pipeline_operator_report()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_report jsonb;
  v_findings jsonb;
  v_corrected_findings jsonb;
  v_expected jsonb;
  v_applied jsonb;
  v_missing jsonb;
  v_schema jsonb;
  v_new_migration_applied boolean;
  v_resume_rpc_ready boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  v_report := public.pipeline_operator_report_v1();
  select coalesce(jsonb_agg(finding), '[]'::jsonb) into v_findings
  from jsonb_array_elements(coalesce(v_report->'integrity_findings', '[]'::jsonb)) finding
  where finding->>'code' not in (
    'candidate_repository_identity_mismatch', 'pipeline_project_has_unexpected_state'
  );

  with raw_findings(code, severity, record_id) as (
    select 'candidate_repository_identity_mismatch', 'critical', c.id::text
    from public.repository_candidates c
    join public.repositories r on r.id = c.repository_id
    where c.provider is distinct from r.provider
      or case when c.provider = 'github' then
        case when c.provider_repository_id ~ '^[1-9][0-9]{0,18}$'
          and r.provider_repository_id ~ '^[1-9][0-9]{0,18}$'
          then c.provider_repository_id::numeric is distinct from r.provider_repository_id::numeric
          else true end
        else c.provider_repository_id is distinct from r.provider_repository_id end
    union all
    select 'pipeline_project_has_invalid_published_state', 'critical', p.id::text
    from public.projects p
    where p.publication_status = 'published'
      and (
        nullif(btrim(p.name), '') is null or nullif(btrim(p.summary), '') is null
        or p.quality_status <> 'verified'
        or p.license_status <> 'verified_open_source'
        or nullif(btrim(p.license_identifier), '') is null
        or p.license_verified_at is null
        or p.published_at is null
        or not exists (select 1 from public.repositories r
          where r.id = p.primary_repository_id and r.project_id = p.id
            and r.availability_status = 'available')
        or not exists (select 1 from public.project_categories pc where pc.project_id = p.id)
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', grouped.code, 'severity', grouped.severity,
    'affected_count', grouped.affected_count, 'affected_record_ids', grouped.record_ids
  ) order by case grouped.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, grouped.code), '[]'::jsonb)
  into v_corrected_findings
  from (
    select code, severity, count(*) as affected_count,
      to_jsonb((array_agg(record_id order by record_id))[1:100]) as record_ids
    from raw_findings group by code, severity
  ) grouped;

  select coalesce(jsonb_agg(item order by
    case item->>'severity' when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
    item->>'code'), '[]'::jsonb)
  into v_findings
  from jsonb_array_elements(v_findings || v_corrected_findings) item;

  v_schema := v_report->'schema';
  v_expected := coalesce(v_schema->'expected_migrations', '[]'::jsonb) || jsonb_build_array('20261107140000');
  v_new_migration_applied := false;
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select exists (select 1 from supabase_migrations.schema_migrations where version::text = $1)'
      into v_new_migration_applied using '20261107140000';
  end if;
  v_applied := coalesce(v_schema->'applied_migrations', '[]'::jsonb)
    || case when v_new_migration_applied then jsonb_build_array('20261107140000') else '[]'::jsonb end;
  v_missing := coalesce(v_schema->'missing_migrations', '[]'::jsonb)
    || case when v_new_migration_applied then '[]'::jsonb else jsonb_build_array('20261107140000') end;
  v_resume_rpc_ready := to_regprocedure('public.pipeline_operator_verify_resume(uuid)') is not null
    and has_function_privilege('service_role', 'public.pipeline_operator_verify_resume(uuid)', 'EXECUTE');
  v_schema := jsonb_set(v_schema, '{expected_migrations}', v_expected, true);
  v_schema := jsonb_set(v_schema, '{applied_migrations}', v_applied, true);
  v_schema := jsonb_set(v_schema, '{missing_migrations}', v_missing, true);
  v_schema := jsonb_set(v_schema, '{required_rpcs}',
    coalesce(v_schema->'required_rpcs', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'signature', 'public.pipeline_operator_verify_resume(uuid)',
      'exists', to_regprocedure('public.pipeline_operator_verify_resume(uuid)') is not null,
      'service_role_execute', v_resume_rpc_ready
    )), true);
  v_schema := jsonb_set(v_schema, '{missing_rpcs}',
    coalesce(v_schema->'missing_rpcs', '[]'::jsonb)
      || case when v_resume_rpc_ready then '[]'::jsonb else jsonb_build_array('public.pipeline_operator_verify_resume(uuid)') end, true);
  v_schema := jsonb_set(v_schema, '{missing_service_role_permissions}',
    coalesce(v_schema->'missing_service_role_permissions', '[]'::jsonb)
      || case when v_resume_rpc_ready then '[]'::jsonb else jsonb_build_array('public.pipeline_operator_verify_resume(uuid)') end, true);
  v_schema := jsonb_set(v_schema, '{ready}',
    to_jsonb(coalesce((v_schema->>'ready')::boolean, false)
      and v_new_migration_applied and v_resume_rpc_ready), true);

  v_report := jsonb_set(v_report, '{report_version}', '"m1-06-v2"'::jsonb, true);
  v_report := jsonb_set(v_report, '{schema}', v_schema, true);
  v_report := jsonb_set(v_report, '{integrity_findings}', v_findings, true);
  return v_report;
end;
$function$;

revoke all on function public.pipeline_operator_report() from public, anon, authenticated;
grant execute on function public.pipeline_operator_report() to service_role;

create function private.pipeline_operator_verify_lineage(p_run_id uuid, p_resume boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_discovered jsonb;
  v_enriched jsonb;
  v_assessments jsonb;
  v_drafts jsonb;
  v_logos jsonb;
  v_evaluations jsonb;
  v_lineages jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_run_id is null or p_resume is null then
    raise exception 'pipeline run identifier and resume mode are required' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'provider', c.provider, 'provider_repository_id', c.provider_repository_id,
    'full_name', c.full_name, 'queue_status', c.queue_status, 'review_status', c.review_status,
    'source_observation_valid', true,
    'discovery_state_valid', c.queue_status <> 'discarded' and c.review_status in ('unreviewed', 'accepted'),
    'source_record_id', c.source_record_id, 'discovery_query_id', c.discovery_query_id
  ) order by c.id), '[]'::jsonb) into v_discovered
  from (
    select distinct c.id, c.provider, c.provider_repository_id, c.full_name,
      c.queue_status, c.review_status, cs.source_record_id, cs.discovery_query_id
    from public.repository_candidates c
    join public.repository_candidate_sources cs on cs.candidate_id = c.id
    join public.discovery_queries q on q.id = cs.discovery_query_id
    join public.ingestion_jobs j on j.id = q.job_id
    join public.source_records s on s.id = cs.source_record_id
    where j.metadata->>'pipeline_run_id' = p_run_id::text
      and s.provider = c.provider and s.record_kind = 'discovery_page'
      and s.http_status = 200 and s.source_metadata->>'resource_type' = 'repository_search'
    order by c.id limit 50
  ) c;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'candidate_id', c.id, 'provider_repository_id', r.provider_repository_id,
    'public_eligible', r.provider = 'github' and r.availability_status = 'available'
      and r.is_private is false and lower(btrim(coalesce(r.visibility, ''))) = 'public'
      and r.is_disabled is false,
    'enrichment_succeeded', c.enrichment_status = 'succeeded'
      and c.enrichment_completed_at is not null and r.last_successful_sync_at is not null
      and r.source_observed_at is not null and c.enrichment_completed_at >= r.source_observed_at
      and evidence.repository_source_id is not null and evidence.languages_source_id is not null
      and evidence.topics_source_id is not null and evidence.releases_source_id is not null,
    'enrichment_source_record_ids', evidence.source_record_ids
  ) order by r.id), '[]'::jsonb) into v_enriched
  from (
    select c.id, c.repository_id, c.enrichment_status, c.enrichment_completed_at, c.enrichment_job_id
    from public.repository_candidates c join public.ingestion_jobs j on j.id = c.enrichment_job_id
    where j.metadata->>'pipeline_run_id' = p_run_id::text and c.repository_id is not null
    order by c.id limit 50
  ) c
  join public.repositories r on r.id = c.repository_id
  cross join lateral (
    select
      (array_agg(s.id order by s.fetched_at desc, s.id) filter (where s.record_kind = 'repository'))[1] as repository_source_id,
      (array_agg(s.id order by s.fetched_at desc, s.id) filter (where s.record_kind = 'languages'))[1] as languages_source_id,
      (array_agg(s.id order by s.fetched_at desc, s.id) filter (where s.record_kind = 'topics'))[1] as topics_source_id,
      (array_agg(s.id order by s.fetched_at desc, s.id) filter (where s.record_kind = 'releases'))[1] as releases_source_id,
      coalesce(jsonb_agg(s.id order by s.record_kind, s.fetched_at desc) filter (where s.id is not null), '[]'::jsonb) as source_record_ids
    from public.source_records s
    where s.repository_id = r.id and s.http_status = 200 and s.source_metadata->>'validated' = 'true'
      and s.fetched_at >= r.source_observed_at
      and s.record_kind in ('repository', 'languages', 'topics', 'releases')
      and (s.record_kind <> 'repository' or s.fetched_at = r.source_observed_at)
  ) evidence;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'repository_id', a.repository_id, 'status', a.status,
    'assessment_complete', a.status in ('assessed', 'needs_review'),
    'provenance_valid', evidence.source_record_ids <> '[]'::jsonb,
    'source_record_ids', evidence.source_record_ids,
    'review_relationship_valid', exists (
      select 1 from public.review_queue q
      where q.assessment_id = a.id and q.status in ('open', 'in_review')
        and ((q.project_id is not null and q.project_id = r.project_id)
          or (q.project_id is null and q.repository_id = r.id))
    ),
    'review_queue_id', evidence.review_queue_id
  ) order by a.id), '[]'::jsonb) into v_assessments
  from (
    select a.id, a.repository_id, a.status, a.job_id
    from public.repository_assessments a join public.ingestion_jobs j on j.id = a.job_id
    where j.metadata->>'pipeline_run_id' = p_run_id::text
    order by a.id limit 50
  ) a
  join public.repositories r on r.id = a.repository_id
  cross join lateral (
    select coalesce(jsonb_agg(s.id order by s.record_kind, s.fetched_at desc), '[]'::jsonb) as source_record_ids,
      (select q.id from public.review_queue q where q.assessment_id = a.id
        and q.status in ('open', 'in_review')
        and ((q.project_id is not null and q.project_id = r.project_id)
          or (q.project_id is null and q.repository_id = r.id))
        order by q.created_at, q.id limit 1) as review_queue_id
    from public.repository_assessment_sources x
    join public.source_records s on s.id = x.source_record_id
    where x.assessment_id = a.id and s.http_status = 200
      and s.source_metadata->>'validated' = 'true' and s.repository_id = a.repository_id
  ) evidence;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'primary_repository_id', p.primary_repository_id,
    'publication_status', p.publication_status, 'category_evidence_count', categories.active_count,
    'active_category_ids', categories.active_category_ids,
    'valid_primary_repository', p.primary_repository_id = r.id and r.project_id = p.id,
    'classification_evidence_valid', a.result->'classification'->>'status' = 'classified'
      and categories.primary_category_evidence,
    'draft_valid', p.publication_status = 'pending_review' and p.featured is false
      and p.quality_status <> 'verified' and p.license_status <> 'verified_open_source'
      and p.license_verified_at is null and p.primary_repository_id = r.id
      and r.project_id = p.id and a.status in ('assessed', 'needs_review')
      and a.result->'classification'->>'status' = 'classified'
      and categories.active_count > 0 and categories.primary_category_evidence,
    'quality_status', p.quality_status, 'license_status', p.license_status,
    'license_verified_at', p.license_verified_at
  ) order by p.id), '[]'::jsonb) into v_drafts
  from (
    select a.id, a.repository_id, a.status, a.result, a.job_id
    from public.repository_assessments a join public.ingestion_jobs j on j.id = a.job_id
    where j.metadata->>'pipeline_run_id' = p_run_id::text
    order by a.id limit 50
  ) a
  join public.repositories r on r.id = a.repository_id
  join public.projects p on p.id = r.project_id and p.primary_repository_id = r.id
  cross join lateral (
    select count(*) filter (where c.is_active)::integer as active_count,
      coalesce(jsonb_agg(c.id order by c.slug) filter (where c.is_active), '[]'::jsonb) as active_category_ids,
      bool_or(c.is_active and c.id::text = a.result->'classification'->>'primaryCategoryId'
        and exists (select 1 from jsonb_array_elements(coalesce(a.result->'classification'->'suggestions', '[]'::jsonb)) suggestion
          where suggestion->>'categoryId' = c.id::text)) as primary_category_evidence
    from public.project_categories pc join public.categories c on c.id = pc.category_id
    where pc.project_id = p.id
  ) categories;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'project_id', l.project_id, 'repository_id', l.repository_id,
    'logo_candidate_valid', l.verification_status = 'pending_review' and l.storage_path is null
      and l.is_primary is false and l.verified_at is null and l.approval_provenance is null
      and l.repository_id = r.id and l.project_id = p.id
      and l.source_provenance->>'stable_repository_id' = r.provider_repository_id,
    'source_provenance_valid', s.id is not null and s.provider = 'github'
      and s.record_kind = 'owner_avatar_observation' and s.http_status = 200
      and s.repository_id = r.id and s.source_metadata->>'stable_repository_id' = r.provider_repository_id,
    'review_relationship_valid', q.id is not null,
    'review_queue_id', q.id, 'source_record_id', l.source_record_id,
    'verification_status', l.verification_status, 'storage_path', l.storage_path
  ) order by l.id), '[]'::jsonb) into v_logos
  from (
    select l.id, l.project_id, l.repository_id, l.verification_status, l.storage_path,
      l.is_primary, l.verified_at, l.approval_provenance, l.source_provenance, l.source_record_id
    from public.project_logos l
    where l.source_provenance->>'pipeline_run_id' = p_run_id::text
    order by l.id limit 50
  ) l
  join public.repositories r on r.id = l.repository_id
  join public.projects p on p.id = l.project_id
  left join public.source_records s on s.id = l.source_record_id
  left join lateral (select q.id from public.review_queue q where q.project_logo_id = l.id
    and q.status in ('open', 'in_review') order by q.created_at, q.id limit 1) q on true;

  with bounded_candidates as (
    select c.*, d.source_record_id as discovery_source_record_id,
      d.discovery_query_id as provenance_discovery_query_id, d.discovery_run_id,
      ej.metadata->>'pipeline_run_id' as enrichment_run_id
    from public.repository_candidates c
    join lateral (
      select cs.source_record_id, cs.discovery_query_id, j.metadata->>'pipeline_run_id' as discovery_run_id
      from public.repository_candidate_sources cs
      join public.discovery_queries q on q.id = cs.discovery_query_id
      join public.ingestion_jobs j on j.id = q.job_id
      join public.source_records s on s.id = cs.source_record_id
      where cs.candidate_id = c.id and s.provider = c.provider
        and s.record_kind = 'discovery_page' and s.http_status = 200
        and s.source_metadata->>'resource_type' = 'repository_search'
      order by cs.fetched_at desc, cs.source_record_id limit 1
    ) d on true
    left join public.ingestion_jobs ej on ej.id = c.enrichment_job_id
    where c.provider = 'github' and c.provider_repository_id ~ '^[1-9][0-9]{0,18}$'
      and c.repository_id is not null and c.queue_status <> 'discarded'
      and c.review_status in ('unreviewed', 'accepted')
      and (p_resume or d.discovery_run_id = p_run_id::text
        or ej.metadata->>'pipeline_run_id' = p_run_id::text
        or exists (select 1 from public.repository_assessments ax
          join public.ingestion_jobs aj on aj.id = ax.job_id
          where ax.repository_id = c.repository_id and aj.metadata->>'pipeline_run_id' = p_run_id::text)
        or exists (select 1 from public.repositories rx join public.project_logos lx on lx.project_id = rx.project_id
          where rx.id = c.repository_id and lx.repository_id = rx.id
            and lx.source_provenance->>'pipeline_run_id' = p_run_id::text))
    order by c.updated_at desc, c.id limit 50
  ), evaluations as (
    select c.id as candidate_id, c.provider, c.provider_repository_id as candidate_provider_repository_id,
      c.full_name as candidate_full_name, c.queue_status, c.review_status,
      c.discovery_source_record_id, c.provenance_discovery_query_id as discovery_query_id,
      c.discovery_run_id = p_run_id::text as discovery_committed_in_run,
      r.id as repository_id, r.provider as repository_provider,
      r.provider_repository_id as repository_provider_repository_id, r.full_name as canonical_full_name,
      (c.provider = r.provider and c.provider_repository_id = r.provider_repository_id) as identity_valid,
      (r.provider = 'github' and r.availability_status = 'available' and r.is_private is false
        and lower(btrim(coalesce(r.visibility, ''))) = 'public' and r.is_disabled is false) as public_eligible,
      c.enrichment_status, c.enrichment_completed_at, c.enrichment_job_id,
      c.enrichment_run_id = p_run_id::text as enrichment_committed_in_run,
      (c.enrichment_status = 'succeeded' and c.enrichment_completed_at is not null
        and r.last_successful_sync_at is not null and r.source_observed_at is not null
        and c.enrichment_completed_at >= r.source_observed_at
        and enrichment.repository_source_id is not null and enrichment.languages_source_id is not null
        and enrichment.topics_source_id is not null and enrichment.releases_source_id is not null) as enrichment_valid,
      enrichment.source_record_ids as enrichment_source_record_ids,
      a.id as assessment_id, a.status as assessment_status, a.job_id as assessment_job_id,
      aj.started_at as assessment_job_started_at,
      aj.metadata->>'pipeline_run_id' = p_run_id::text as assessment_committed_in_run,
      (a.id is not null and a.status in ('assessed', 'needs_review')
        and assessment_evidence.source_record_ids <> '[]'::jsonb) as assessment_valid,
      assessment_evidence.source_record_ids as assessment_source_record_ids,
      assessment_evidence.review_queue_id as assessment_review_queue_id,
      (assessment_evidence.review_queue_id is not null) as assessment_review_valid,
      p.id as project_id, p.publication_status, p.primary_repository_id,
      p.quality_status, p.license_status, p.license_verified_at,
      categories.active_category_ids, categories.active_count,
      (p.id is not null and p.publication_status = 'pending_review' and p.featured is false
        and p.quality_status <> 'verified' and p.license_status <> 'verified_open_source'
        and p.license_verified_at is null and p.primary_repository_id = r.id and r.project_id = p.id
        and a.status in ('assessed', 'needs_review') and a.result->'classification'->>'status' = 'classified'
        and categories.active_count > 0 and categories.primary_category_evidence) as draft_valid,
      (p.id is not null and p.created_at >= aj.started_at
        and aj.metadata->>'pipeline_run_id' = p_run_id::text) as draft_committed_in_run,
      categories.primary_category_evidence as category_evidence_valid,
      logo.id as logo_id, logo.verification_status as logo_status,
      logo.storage_path as logo_storage_path, logo.review_queue_id as logo_review_queue_id,
      (logo.id is not null and logo.verification_status = 'pending_review' and logo.storage_path is null
        and logo.is_primary is false and logo.verified_at is null and logo.approval_provenance is null
        and logo.repository_id = r.id and logo.project_id = p.id
        and logo.source_provenance->>'stable_repository_id' = r.provider_repository_id
        and logo.source_record_valid and logo.review_queue_id is not null) as logo_valid,
      logo.pipeline_run_id = p_run_id::text as logo_committed_in_run,
      logo.source_record_id as logo_source_record_id,
      (c.queue_status <> 'discarded' and c.review_status in ('unreviewed', 'accepted')) as discovery_state_valid,
      (c.queue_status <> 'discarded' and c.review_status in ('unreviewed', 'accepted')
        and c.provider = r.provider and c.provider_repository_id = r.provider_repository_id
        and r.provider = 'github' and r.availability_status = 'available' and r.is_private is false
        and lower(btrim(coalesce(r.visibility, ''))) = 'public' and r.is_disabled is false
        and c.enrichment_status = 'succeeded' and c.enrichment_completed_at is not null
        and r.last_successful_sync_at is not null and enrichment.repository_source_id is not null
        and enrichment.languages_source_id is not null and enrichment.topics_source_id is not null
        and enrichment.releases_source_id is not null
        and a.id is not null and a.status in ('assessed', 'needs_review')
        and assessment_evidence.source_record_ids <> '[]'::jsonb and assessment_evidence.review_queue_id is not null
        and p.id is not null and p.publication_status = 'pending_review' and p.featured is false
        and p.quality_status <> 'verified' and p.license_status <> 'verified_open_source'
        and p.license_verified_at is null and p.primary_repository_id = r.id and r.project_id = p.id
        and a.result->'classification'->>'status' = 'classified'
        and categories.active_count > 0 and categories.primary_category_evidence
        and logo.id is not null and logo.verification_status = 'pending_review'
        and logo.storage_path is null and logo.is_primary is false and logo.verified_at is null
        and logo.approval_provenance is null and logo.repository_id = r.id and logo.project_id = p.id
        and logo.source_provenance->>'stable_repository_id' = r.provider_repository_id
        and logo.source_record_valid and logo.review_queue_id is not null) as complete
    from bounded_candidates c
    join public.repositories r on r.id = c.repository_id
    left join lateral (
      select
        (array_agg(s.id order by s.fetched_at desc, s.id) filter (where s.record_kind = 'repository'))[1] as repository_source_id,
        (array_agg(s.id order by s.fetched_at desc, s.id) filter (where s.record_kind = 'languages'))[1] as languages_source_id,
        (array_agg(s.id order by s.fetched_at desc, s.id) filter (where s.record_kind = 'topics'))[1] as topics_source_id,
        (array_agg(s.id order by s.fetched_at desc, s.id) filter (where s.record_kind = 'releases'))[1] as releases_source_id,
        coalesce(jsonb_agg(s.id order by s.record_kind, s.fetched_at desc) filter (where s.id is not null), '[]'::jsonb) as source_record_ids
      from public.source_records s
      where s.repository_id = r.id and s.http_status = 200 and s.source_metadata->>'validated' = 'true'
        and s.fetched_at >= r.source_observed_at and s.record_kind in ('repository', 'languages', 'topics', 'releases')
        and (s.record_kind <> 'repository' or s.fetched_at = r.source_observed_at)
    ) enrichment on true
    left join lateral (select ax.* from public.repository_assessments ax
      where ax.repository_id = r.id and ax.policy_version = 'm1-04-assessment-v1'
      order by ax.assessed_at desc nulls last, ax.created_at desc, ax.id limit 1) a on true
    left join public.ingestion_jobs aj on aj.id = a.job_id
    left join lateral (
      select coalesce(jsonb_agg(s.id order by s.record_kind, s.fetched_at desc), '[]'::jsonb) as source_record_ids,
        (select q.id from public.review_queue q where q.assessment_id = a.id
          and q.status in ('open', 'in_review')
          and ((q.project_id is not null and q.project_id = r.project_id)
            or (q.project_id is null and q.repository_id = r.id))
          order by q.created_at, q.id limit 1) as review_queue_id
      from public.repository_assessment_sources x
      join public.source_records s on s.id = x.source_record_id
      where x.assessment_id = a.id and s.http_status = 200
        and s.source_metadata->>'validated' = 'true' and s.repository_id = r.id
    ) assessment_evidence on true
    left join public.projects p on p.id = r.project_id
    left join lateral (
      select count(*) filter (where cat.is_active)::integer as active_count,
        coalesce(jsonb_agg(cat.id order by cat.slug) filter (where cat.is_active), '[]'::jsonb) as active_category_ids,
        coalesce(bool_or(cat.is_active and cat.id::text = a.result->'classification'->>'primaryCategoryId'
          and exists (select 1 from jsonb_array_elements(coalesce(a.result->'classification'->'suggestions', '[]'::jsonb)) suggestion
            where suggestion->>'categoryId' = cat.id::text)), false) as primary_category_evidence
      from public.project_categories pc join public.categories cat on cat.id = pc.category_id
      where pc.project_id = p.id
    ) categories on true
    left join lateral (
      select l.*, q.id as review_queue_id,
        l.source_provenance->>'pipeline_run_id' as pipeline_run_id,
        exists (select 1 from public.source_records s where s.id = l.source_record_id
          and s.provider = 'github' and s.record_kind = 'owner_avatar_observation'
          and s.http_status = 200 and s.repository_id = r.id
          and s.source_metadata->>'stable_repository_id' = r.provider_repository_id) as source_record_valid
      from public.project_logos l
      left join lateral (select rq.id from public.review_queue rq where rq.project_logo_id = l.id
        and rq.status in ('open', 'in_review') order by rq.created_at, rq.id limit 1) q on true
      where l.project_id = p.id and l.repository_id = r.id
      order by l.created_at desc, l.id limit 1
    ) logo on true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'candidate_id', e.candidate_id,
    'repository_id', e.repository_id,
    'assessment_id', e.assessment_id,
    'project_id', e.project_id,
    'logo_id', e.logo_id,
    'complete', e.complete,
    'candidate', jsonb_build_object('id', e.candidate_id, 'provider', e.provider,
      'provider_repository_id', e.candidate_provider_repository_id, 'historical_full_name', e.candidate_full_name,
      'queue_status', e.queue_status, 'review_status', e.review_status,
      'source_record_id', e.discovery_source_record_id, 'discovery_query_id', e.discovery_query_id),
    'repository', jsonb_build_object('id', e.repository_id, 'provider', e.repository_provider,
      'provider_repository_id', e.repository_provider_repository_id, 'canonical_full_name', e.canonical_full_name,
      'public_eligible', e.public_eligible),
    'assessment', jsonb_build_object('id', e.assessment_id, 'status', e.assessment_status,
      'source_record_ids', e.assessment_source_record_ids, 'review_queue_id', e.assessment_review_queue_id,
      'provenance_valid', e.assessment_valid, 'review_relationship_valid', e.assessment_review_valid),
    'project', jsonb_build_object('id', e.project_id, 'publication_status', e.publication_status,
      'primary_repository_id', e.primary_repository_id, 'valid_primary_repository', e.project_id is not null
        and e.primary_repository_id = e.repository_id,
      'quality_status', e.quality_status, 'license_status', e.license_status,
      'license_verified_at', e.license_verified_at, 'category_evidence_count', e.active_count,
      'active_category_ids', e.active_category_ids, 'classification_evidence_valid', e.category_evidence_valid,
      'draft_valid', e.draft_valid),
    'logo', jsonb_build_object('id', e.logo_id, 'project_id', e.project_id,
      'repository_id', e.repository_id, 'verification_status', e.logo_status,
      'storage_path', e.logo_storage_path, 'review_queue_id', e.logo_review_queue_id,
      'source_record_id', e.logo_source_record_id, 'valid', e.logo_valid),
    'evidence', jsonb_build_object('candidate_provenance_valid', e.discovery_source_record_id is not null,
      'candidate_state_valid', e.discovery_state_valid, 'candidate_repository_identity_valid', e.identity_valid,
      'public_repository_eligible', e.public_eligible, 'enrichment_succeeded', e.enrichment_valid,
      'enrichment_source_record_ids', e.enrichment_source_record_ids,
      'assessment_source_provenance_valid', e.assessment_valid,
      'assessment_review_relationship_valid', e.assessment_review_valid,
      'draft_primary_repository_valid', e.project_id is not null and e.primary_repository_id = e.repository_id,
      'draft_category_evidence_valid', e.category_evidence_valid,
      'pending_logo_review_relationship_valid', e.logo_valid,
      'no_automatic_approval_or_publication', e.project_id is not null
        and e.publication_status = 'pending_review' and e.quality_status <> 'verified'
        and e.license_status <> 'verified_open_source' and e.license_verified_at is null
        and e.logo_status = 'pending_review' and e.logo_storage_path is null),
    'stage_origins', jsonb_build_object(
      'discovery', jsonb_build_object('status', case when e.discovery_committed_in_run then 'committed_in_run' else 'reused' end,
        'record_id', e.candidate_id),
      'enrichment', jsonb_build_object('status', case when e.enrichment_committed_in_run then 'committed_in_run' else 'reused' end,
        'record_id', e.repository_id),
      'assessment', jsonb_build_object('status', case when e.assessment_committed_in_run then 'committed_in_run' else 'reused' end,
        'record_id', e.assessment_id),
      'draft', jsonb_build_object('status', case when e.draft_committed_in_run
          then 'committed_in_run' else 'reused' end,
        'record_id', e.project_id),
      'logo', jsonb_build_object('status', case when e.logo_committed_in_run then 'committed_in_run' else 'reused' end,
        'record_id', e.logo_id)
    ),
    'eligible_for_run_success', e.complete and (p_resume or (
      e.discovery_committed_in_run and e.enrichment_committed_in_run
      and e.assessment_committed_in_run and e.draft_committed_in_run and e.logo_committed_in_run
    ))
  ) order by e.candidate_id), '[]'::jsonb) into v_evaluations
  from evaluations e;

  select coalesce(jsonb_agg(evaluation order by evaluation->>'candidate_id'), '[]'::jsonb)
    into v_lineages
  from jsonb_array_elements(v_evaluations) evaluation
  where evaluation->>'eligible_for_run_success' = 'true';

  return jsonb_build_object(
    'pipeline_run_id', p_run_id,
    'resume_mode', p_resume,
    'discovered_candidates', v_discovered,
    'enriched_repositories', v_enriched,
    'assessments', v_assessments,
    'project_drafts', v_drafts,
    'logo_candidates', v_logos,
    'lineage_evaluations', v_evaluations,
    'validated_lineages', v_lineages
  );
end;
$function$;

revoke all on function private.pipeline_operator_verify_lineage(uuid, boolean) from public, anon, authenticated, service_role;

create or replace function public.pipeline_operator_verify_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return private.pipeline_operator_verify_lineage(p_run_id, false);
end;
$function$;

revoke all on function public.pipeline_operator_verify_run(uuid) from public, anon, authenticated;
grant execute on function public.pipeline_operator_verify_run(uuid) to service_role;

create function public.pipeline_operator_verify_resume(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return private.pipeline_operator_verify_lineage(p_run_id, true);
end;
$function$;

revoke all on function public.pipeline_operator_verify_resume(uuid) from public, anon, authenticated;
grant execute on function public.pipeline_operator_verify_resume(uuid) to service_role;
