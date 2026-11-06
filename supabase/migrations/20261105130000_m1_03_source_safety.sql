-- Corrective source boundary for M1-03. Private source responses are never
-- written as canonical GitHub metadata, and repository homepages are web URLs.

create or replace function private.is_safe_http_url(p_url text)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $function$
declare
  v_parts text[];
  v_authority text;
  v_tail text;
  v_host text;
  v_port text;
  v_octets text[];
  v_part text;
  v_ip inet;
begin
  if p_url = '' or p_url ~ '[[:space:][:cntrl:]]' or position(chr(92) in p_url) > 0 then
    return false;
  end if;
  v_parts := regexp_match(p_url, '^https?://([^/?#]*)(.*)$', 'i');
  if v_parts is null then return false; end if;
  v_authority := v_parts[1];
  v_tail := v_parts[2];
  if v_authority = '' or position('@' in v_authority) > 0 or position('%' in v_authority) > 0 then
    return false;
  end if;
  if v_tail !~ '^(/([A-Za-z0-9._~!$&''()*+,;=:@/-]|%[0-9A-Fa-f]{2})*)?(\?([A-Za-z0-9._~!$&''()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*)?(#([A-Za-z0-9._~!$&''()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*)?$' then
    return false;
  end if;

  if left(v_authority, 1) = '[' then
    v_parts := regexp_match(v_authority, '^(\[[0-9A-Fa-f:.]+\])(:([0-9]{1,5}))?$');
    if v_parts is null then return false; end if;
    v_host := substr(v_parts[1], 2, length(v_parts[1]) - 2);
    v_port := v_parts[3];
    if position(':' in v_host) = 0 then return false; end if;
    v_ip := v_host::inet;
    if family(v_ip) <> 6 then return false; end if;
  else
    v_parts := regexp_match(v_authority, '^([^:]+)(:([0-9]{1,5}))?$');
    if v_parts is null then return false; end if;
    v_host := v_parts[1];
    v_port := v_parts[3];
    if length(v_host) > 253 then return false; end if;
    if v_host ~ '^[0-9.]+$' then
      v_octets := string_to_array(v_host, '.');
      if cardinality(v_octets) <> 4 then return false; end if;
      foreach v_part in array v_octets loop
        if v_part !~ '^(0|[1-9][0-9]{0,2})$' or v_part::integer > 255 then
          return false;
        end if;
      end loop;
    elsif v_host !~ '^(localhost|[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?)$' then
      return false;
    end if;
  end if;
  if v_port is not null and v_port::integer > 65535 then return false; end if;
  return true;
exception when others then
  return false;
end;
$function$;

revoke all on function private.is_safe_http_url(text) from public, anon, authenticated;
grant execute on function private.is_safe_http_url(text) to service_role;

-- Clear only invalid untrusted homepage strings; retain the safe reason that
-- the source value was present but rejected.
update public.repositories r set
  homepage_url = null,
  source_field_states = r.source_field_states || jsonb_build_object('homepage', 'rejected')
where r.homepage_url is not null
  and not private.is_safe_http_url(r.homepage_url);

alter table public.repositories
  add constraint repositories_homepage_url_safe_web check (
    homepage_url is null or private.is_safe_http_url(homepage_url)
  );

create or replace function private.guard_public_github_repository_source()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.provider = 'github'
    and (new.is_private is true or (new.visibility is not null and lower(btrim(new.visibility)) <> 'public')) then
    if tg_op = 'UPDATE'
      and row(
        new.provider_repository_id, new.full_name, new.canonical_url, new.description,
        new.default_branch, new.primary_language, new.stars, new.forks, new.is_archived,
        new.is_fork, new.provider_created_at, new.provider_updated_at, new.provider_pushed_at,
        new.last_successful_sync_at, new.provider_node_id, new.owner_login, new.repository_name,
        new.homepage_url, new.watchers, new.open_issues, new.is_disabled, new.is_private,
        new.visibility, new.source_license_metadata, new.source_field_states, new.source_observed_at
      ) is not distinct from row(
        old.provider_repository_id, old.full_name, old.canonical_url, old.description,
        old.default_branch, old.primary_language, old.stars, old.forks, old.is_archived,
        old.is_fork, old.provider_created_at, old.provider_updated_at, old.provider_pushed_at,
        old.last_successful_sync_at, old.provider_node_id, old.owner_login, old.repository_name,
        old.homepage_url, old.watchers, old.open_issues, old.is_disabled, old.is_private,
        old.visibility, old.source_license_metadata, old.source_field_states, old.source_observed_at
      )
      and new.availability_status = 'access_restricted' then
      return new;
    end if;
    raise exception 'private or non-public GitHub repository metadata cannot be enriched'
      using errcode = '22023';
  end if;
  return new;
end;
$function$;

revoke all on function private.guard_public_github_repository_source() from public, anon, authenticated;
grant execute on function private.guard_public_github_repository_source() to service_role;

create trigger repositories_public_github_source_guard
before insert or update of
  provider_repository_id, full_name, canonical_url, description, default_branch,
  primary_language, stars, forks, is_archived, is_fork, provider_created_at,
  provider_updated_at, provider_pushed_at, last_successful_sync_at,
  provider_node_id, owner_login, repository_name, homepage_url, watchers,
  open_issues, is_disabled, is_private, visibility, source_license_metadata,
  source_field_states, source_observed_at, availability_status
on public.repositories
for each row execute function private.guard_public_github_repository_source();

-- Keep the established transactional commit implementation intact while
-- adapting the new safe homepage state to its older transport enum. The
-- durable source_field_states value remains `rejected` and the rejected URL
-- itself remains null.
alter function public.commit_github_repository_enrichment(uuid, text, uuid, jsonb) set schema private;
alter function private.commit_github_repository_enrichment(uuid, text, uuid, jsonb)
  rename to commit_github_repository_enrichment_v1;
revoke all on function private.commit_github_repository_enrichment_v1(uuid, text, uuid, jsonb)
  from public, anon, authenticated, service_role;

create function public.commit_github_repository_enrichment(
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
  v_payload jsonb := p_payload;
begin
  if p_payload->'repository'->'homepage_state'->>'state' = 'rejected' then
    v_payload := jsonb_set(v_payload, '{repository,source_field_states,homepage}', '"rejected"'::jsonb, true);
    v_payload := jsonb_set(v_payload, '{repository,homepage_state,state}', '"null"'::jsonb, false);
  end if;
  return private.commit_github_repository_enrichment_v1(
    p_candidate_id, p_worker_id, p_lease_token, v_payload
  );
end;
$function$;

revoke all on function public.commit_github_repository_enrichment(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.commit_github_repository_enrichment(uuid, text, uuid, jsonb)
  to service_role;

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
  v_repository_id uuid;
  v_access_restricted boolean := false;
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
      or (p_failure_provenance->>'http_status') is not null and (p_failure_provenance->>'http_status') !~ '^[1-5][0-9][0-9]$'
      or p_failure_provenance->>'outcome' is not null and p_failure_provenance->>'outcome' <> 'access_restricted' then
      raise exception 'invalid failure provenance' using errcode = '22023';
    end if;
    v_access_restricted := p_failure_provenance->>'outcome' = 'access_restricted';
    if v_access_restricted and (
      p_retryable is distinct from false
      or p_failure_provenance->>'http_status' is distinct from '200'
      or p_failure_provenance->>'error_kind' is distinct from 'visibility_restricted'
      or coalesce(p_failure_provenance->>'visibility_signal', '') not in (
        'private_flag', 'non_public_visibility', 'contradictory_visibility'
      )
    ) then
      raise exception 'invalid structured access-restriction outcome' using errcode = '22023';
    end if;

    if v_access_restricted then
      if v_status = 'failed' then
        update public.repositories r set
          availability_status = 'access_restricted', updated_at = v_now
        where r.provider = 'github' and r.provider_repository_id = v_candidate.provider_repository_id
        returning r.id into v_repository_id;
      else
        select r.id into v_repository_id from public.repositories r
        where r.provider = 'github' and r.provider_repository_id = v_candidate.provider_repository_id;
      end if;
    else
      v_repository_id := v_candidate.repository_id;
    end if;

    insert into public.source_records (
      provider, record_kind, source_key, source_url, fetched_at, http_status,
      reuse_context, source_metadata, repository_id, candidate_id
    ) values (
      'github', 'repository', 'github:repository:' || v_candidate.provider_repository_id || ':attempt:' || v_candidate.enrichment_attempts,
      p_failure_provenance->>'source_url', coalesce((p_failure_provenance->>'fetched_at')::timestamptz, v_now),
      nullif(p_failure_provenance->>'http_status', '')::integer,
      case when v_access_restricted then 'Visibility restriction recorded; response body omitted.'
        else 'No body cached; failed request evidence only.' end,
      jsonb_strip_nulls(jsonb_build_object('api_version', '2022-11-28', 'cache_reusable', false,
        'outcome', case when v_access_restricted then 'access_restricted' else 'unavailable' end,
        'error_kind', left(coalesce(p_failure_provenance->>'error_kind', 'request'), 64),
        'visibility_signal', case when v_access_restricted then p_failure_provenance->>'visibility_signal' end)),
      coalesce(v_repository_id, v_candidate.repository_id), v_candidate.id
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
    'retry_after_ms', case when v_status = 'retry_wait' then v_delay_ms else null end)
    || case when v_access_restricted then jsonb_build_object('outcome', 'access_restricted') else '{}'::jsonb end;
end;
$function$;

revoke all on function public.fail_github_repository_enrichment(uuid, text, uuid, text, boolean, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.fail_github_repository_enrichment(uuid, text, uuid, text, boolean, bigint, jsonb) to service_role;
