-- Authenticated editorial review and deliberately gated project publication.

alter table public.projects
  add column editorial_revision bigint not null default 0
    check (editorial_revision >= 0);

alter table public.editorial_overrides
  drop constraint editorial_overrides_field_key_check,
  add constraint editorial_overrides_field_key_check check (field_key in (
    'name', 'summary', 'description', 'official_website_url', 'license_status',
    'license_identifier', 'featured', 'editorial_rank', 'tags'
  ));

create table public.editorial_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in (
    'save_editorial', 'verify_license', 'verify_quality', 'keep_pending',
    'mark_review_required', 'reject', 'return_to_review', 'resolve_review_item', 'publish'
  )),
  previous_state text not null,
  resulting_state text not null,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  reason text not null check (length(btrim(reason)) between 8 and 1000),
  resulting_revision bigint not null check (resulting_revision >= 0),
  created_at timestamptz not null default clock_timestamp()
);

create index editorial_decisions_project_created_idx
  on public.editorial_decisions (project_id, created_at desc);
create unique index editorial_decisions_one_publish_per_project_idx
  on public.editorial_decisions (project_id) where action = 'publish';

alter table public.editorial_decisions enable row level security;
revoke all on public.editorial_decisions from public, anon, authenticated, service_role;
grant select, insert on public.editorial_decisions to service_role;

create or replace function private.guard_editorial_decisions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'editorial decisions are append-only' using errcode = '42501';
end;
$function$;

revoke all on function private.guard_editorial_decisions_append_only() from public, anon, authenticated;
grant execute on function private.guard_editorial_decisions_append_only() to service_role;

create trigger editorial_decisions_append_only
  before update or delete on public.editorial_decisions
  for each row execute function private.guard_editorial_decisions_append_only();

create or replace function private.preserve_project_editorial_overrides()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_value jsonb;
begin
  -- Editorial transactions increment the revision and write their override in
  -- the same transaction. Pipeline/service updates retain the stored decision.
  if new.editorial_revision = old.editorial_revision then
    select o.override_value into v_value from public.editorial_overrides o
      where o.project_id = old.id and o.field_key = 'name';
    if found then new.name := v_value #>> '{}'; end if;
    select o.override_value into v_value from public.editorial_overrides o
      where o.project_id = old.id and o.field_key = 'summary';
    if found then new.summary := v_value #>> '{}'; end if;
    select o.override_value into v_value from public.editorial_overrides o
      where o.project_id = old.id and o.field_key = 'description';
    if found then new.description := v_value #>> '{}'; end if;
    select o.override_value into v_value from public.editorial_overrides o
      where o.project_id = old.id and o.field_key = 'official_website_url';
    if found then new.official_website_url := case when v_value = 'null'::jsonb then null else v_value #>> '{}' end; end if;
    select o.override_value into v_value from public.editorial_overrides o
      where o.project_id = old.id and o.field_key = 'license_status';
    if found then new.license_status := v_value #>> '{}'; end if;
    select o.override_value into v_value from public.editorial_overrides o
      where o.project_id = old.id and o.field_key = 'license_identifier';
    if found then new.license_identifier := case when v_value = 'null'::jsonb then null else v_value #>> '{}' end; end if;
    select o.override_value into v_value from public.editorial_overrides o
      where o.project_id = old.id and o.field_key = 'featured';
    if found then new.featured := (v_value #>> '{}')::boolean; end if;
    select o.override_value into v_value from public.editorial_overrides o
      where o.project_id = old.id and o.field_key = 'editorial_rank';
    if found then new.editorial_rank := (v_value #>> '{}')::integer; end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.preserve_project_editorial_overrides() from public, anon, authenticated;
grant execute on function private.preserve_project_editorial_overrides() to service_role;
create trigger projects_05_preserve_editorial_overrides
  before update on public.projects for each row
  execute function private.preserve_project_editorial_overrides();

create or replace function private.assert_editorial_admin(p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_actor is null or not exists (
    select 1 from public.admin_users a where a.user_id = p_actor
  ) then
    raise exception 'current administrator membership required' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function private.assert_editorial_admin(uuid) from public, anon, authenticated;
grant execute on function private.assert_editorial_admin(uuid) to service_role;

create or replace function private.assert_current_project_evidence(p_project_id uuid)
returns table (
  repository_id uuid,
  source_observed_at timestamptz,
  assessment_id uuid,
  assessment_result jsonb
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project public.projects%rowtype;
  v_repository public.repositories%rowtype;
  v_assessment public.repository_assessments%rowtype;
begin
  select p.* into v_project from public.projects p where p.id = p_project_id;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;

  select r.* into v_repository from public.repositories r
  where r.id = v_project.primary_repository_id and r.project_id = v_project.id
  for share;
  if not found
    or v_repository.provider <> 'github'
    or v_repository.availability_status <> 'available'
    or v_repository.is_private is distinct from false
    or lower(btrim(coalesce(v_repository.visibility, ''))) <> 'public'
    or v_repository.is_disabled is distinct from false
    or v_repository.provider_repository_id !~ '^[1-9][0-9]{0,18}$'
    or v_repository.owner_login is null or v_repository.repository_name is null
    or v_repository.full_name <> v_repository.owner_login || '/' || v_repository.repository_name
    or lower(v_repository.canonical_url) <> 'https://github.com/' || lower(v_repository.full_name)
    or v_repository.source_observed_at is null
    or v_repository.source_observed_at < clock_timestamp() - interval '90 days'
    or v_repository.last_successful_sync_at is null
    or v_repository.last_successful_sync_at < v_repository.source_observed_at
    or v_repository.source_field_states->>'visibility' is distinct from 'present'
    or v_repository.source_field_states->>'license' is null
    or exists (
      select 1 from public.repository_candidates c
      where c.repository_id = v_repository.id
        and (c.review_status = 'rejected' or c.queue_status = 'discarded')
    )
  then
    raise exception 'current repository evidence is stale, restricted, or incomplete' using errcode = '23514';
  end if;

  select a.* into v_assessment from public.repository_assessments a
  where a.repository_id = v_repository.id
    and a.source_observed_at = v_repository.source_observed_at
    and a.status in ('assessed', 'needs_review')
    and a.assessed_at is not null
  order by a.assessed_at desc limit 1 for share;
  if not found
    or jsonb_typeof(v_assessment.result->'quality'->'flags') is distinct from 'array'
    or coalesce(v_assessment.result->'quality'->>'status', '') <> 'eligible_for_review'
    or exists (
      select 1 from jsonb_array_elements(coalesce(v_assessment.result->'quality'->'flags', '[]'::jsonb)) flag
      where flag->>'severity' = 'blocking'
    )
    or not exists (
      select 1 from public.repository_assessment_sources x
      join public.source_records s on s.id = x.source_record_id
      where x.assessment_id = v_assessment.id and s.repository_id = v_repository.id
        and s.record_kind = 'repository' and s.fetched_at = v_repository.source_observed_at
        and s.http_status = 200 and s.source_metadata->>'validated' = 'true'
    )
    or not exists (
      select 1 from public.repository_assessment_sources x
      join public.source_records s on s.id = x.source_record_id
      where x.assessment_id = v_assessment.id and s.repository_id = v_repository.id
        and s.record_kind = 'topics' and s.fetched_at >= v_repository.source_observed_at
        and s.http_status = 200 and s.source_metadata->>'validated' = 'true'
    )
    or not exists (
      select 1 from public.repository_assessment_sources x
      join public.source_records s on s.id = x.source_record_id
      where x.assessment_id = v_assessment.id and s.repository_id = v_repository.id
        and s.record_kind = 'languages' and s.fetched_at >= v_repository.source_observed_at
        and s.http_status = 200 and s.source_metadata->>'validated' = 'true'
    )
    or not exists (
      select 1 from public.repository_assessment_sources x
      join public.source_records s on s.id = x.source_record_id
      where x.assessment_id = v_assessment.id and s.repository_id = v_repository.id
        and s.record_kind = 'releases' and s.fetched_at >= v_repository.source_observed_at
        and s.http_status = 200 and s.source_metadata->>'validated' = 'true'
    )
    or exists (
      select 1 from public.repository_assessment_sources x
      left join public.source_records s on s.id = x.source_record_id
      where x.assessment_id = v_assessment.id and (s.id is null
        or s.repository_id is distinct from v_repository.id
        or s.provider is distinct from 'github'
        or s.source_url !~* '^https://api\.github\.com/[^[:space:]]+$'
        or s.http_status is distinct from 200
        or s.source_metadata->>'validated' is distinct from 'true'
        or s.source_metadata->>'api_version' is distinct from '2022-11-28'
        or s.source_metadata->>'resource_kind' is distinct from s.record_kind
        or s.source_metadata->>'stable_provider_id' is distinct from v_repository.provider_repository_id
        or s.fetched_at > clock_timestamp() + interval '5 minutes'
        or (s.record_kind = 'repository' and s.fetched_at is distinct from v_repository.source_observed_at))
    )
  then
    raise exception 'current assessment provenance is incomplete or contradictory' using errcode = '23514';
  end if;

  return query select v_repository.id, v_repository.source_observed_at,
    v_assessment.id, v_assessment.result;
end;
$function$;

revoke all on function private.assert_current_project_evidence(uuid) from public, anon, authenticated;
grant execute on function private.assert_current_project_evidence(uuid) to service_role;

create or replace function public.admin_save_project_editorial(
  p_actor uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_changes jsonb,
  p_category_ids uuid[],
  p_tags text[],
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project public.projects%rowtype;
  v_key text;
  v_tag text;
  v_slug text;
  v_slugs text[] := array[]::text[];
  v_next_revision bigint;
  v_changes jsonb := '{}'::jsonb;
  v_previous_state text;
begin
  perform private.assert_editorial_admin(p_actor);
  if p_project_id is null or p_expected_revision is null
    or jsonb_typeof(p_changes) is distinct from 'object'
    or p_changes = '{}'::jsonb
    or p_category_ids is null or cardinality(p_category_ids) < 1 or cardinality(p_category_ids) > 8
    or p_tags is null or cardinality(p_tags) > 20
    or nullif(btrim(p_reason), '') is null or length(p_reason) > 1000 then
    raise exception 'invalid editorial update' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('name', 'summary', 'description', 'official_website_url') then
      raise exception 'editorial field is not allowed' using errcode = '22023';
    end if;
    if jsonb_typeof(p_changes->v_key) is distinct from 'string' then
      raise exception 'editorial field must be a string' using errcode = '22023';
    end if;
  end loop;

  select p.* into v_project from public.projects p where p.id = p_project_id for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.editorial_revision <> p_expected_revision then
    raise exception 'stale editorial form; reload the project before saving' using errcode = '40001';
  end if;
  if v_project.publication_status not in ('draft', 'pending_review') then
    raise exception 'editorial changes require a draft in review' using errcode = '55000';
  end if;
  if p_changes ? 'name' and (length(btrim(p_changes->>'name')) not between 1 and 120) then
    raise exception 'project name must contain 1 to 120 characters' using errcode = '22023';
  end if;
  if p_changes ? 'summary' and (length(btrim(p_changes->>'summary')) not between 10 and 280) then
    raise exception 'summary must contain 10 to 280 characters' using errcode = '22023';
  end if;
  if p_changes ? 'description' and length(p_changes->>'description') > 10000 then
    raise exception 'description is too long' using errcode = '22023';
  end if;
  if p_changes ? 'official_website_url' and p_changes->>'official_website_url' <> ''
    and not private.is_safe_http_url(p_changes->>'official_website_url') then
    raise exception 'official website URL must be a safe HTTP or HTTPS address' using errcode = '22023';
  end if;
  if cardinality(p_category_ids) <> (select count(distinct c) from unnest(p_category_ids) c)
    or exists (select 1 from unnest(p_category_ids) requested(id)
      where not exists (select 1 from public.categories c where c.id = requested.id and c.is_active)) then
    raise exception 'categories must be unique and active' using errcode = '22023';
  end if;

  foreach v_tag in array p_tags loop
    if length(btrim(v_tag)) not between 2 and 40 or v_tag !~ '^[A-Za-z0-9][A-Za-z0-9 -]*$' then
      raise exception 'tags must contain 2 to 40 simple letters or numbers' using errcode = '22023';
    end if;
    v_slug := trim(both '-' from regexp_replace(lower(btrim(v_tag)), '[^a-z0-9]+', '-', 'g'));
    if v_slug = '' or v_slug = any(v_slugs) then
      raise exception 'tags must be unique after normalization' using errcode = '22023';
    end if;
    v_slugs := array_append(v_slugs, v_slug);
  end loop;

  v_previous_state := v_project.publication_status;
  update public.projects set
    name = case when p_changes ? 'name' then btrim(p_changes->>'name') else name end,
    summary = case when p_changes ? 'summary' then btrim(p_changes->>'summary') else summary end,
    description = case when p_changes ? 'description' then p_changes->>'description' else description end,
    official_website_url = case when p_changes ? 'official_website_url'
      then nullif(btrim(p_changes->>'official_website_url'), '') else official_website_url end,
    editorial_revision = editorial_revision + 1
  where id = p_project_id returning editorial_revision into v_next_revision;

  for v_key in select jsonb_object_keys(p_changes) loop
    insert into public.editorial_overrides (
      project_id, field_key, override_value, created_by, approved_by, approved_at
    ) values (
      p_project_id, v_key, case when v_key = 'official_website_url'
        then coalesce(to_jsonb(nullif(btrim(p_changes->>v_key), '')), 'null'::jsonb)
        else to_jsonb(case when v_key = 'name' or v_key = 'summary' then btrim(p_changes->>v_key) else p_changes->>v_key end) end,
      p_actor, p_actor, clock_timestamp()
    ) on conflict (project_id, field_key) do update set
      override_value = excluded.override_value, created_by = p_actor,
      approved_by = p_actor, approved_at = excluded.approved_at, updated_at = excluded.approved_at;
    v_changes := v_changes || jsonb_build_object(v_key, p_changes->v_key);
  end loop;

  delete from public.project_categories where project_id = p_project_id;
  insert into public.project_categories (project_id, category_id)
  select p_project_id, category_id from unnest(p_category_ids) category_id;
  delete from public.project_tags where project_id = p_project_id;
  foreach v_tag in array p_tags loop
    v_slug := trim(both '-' from regexp_replace(lower(btrim(v_tag)), '[^a-z0-9]+', '-', 'g'));
    insert into public.tags (slug, name) values (v_slug, btrim(v_tag))
    on conflict (slug) do nothing;
  end loop;
  insert into public.project_tags (project_id, tag_id)
  select p_project_id, t.id from public.tags t where t.slug = any(v_slugs);
  insert into public.editorial_overrides (
    project_id, field_key, override_value, created_by, approved_by, approved_at
  ) values (p_project_id, 'tags', to_jsonb(p_tags), p_actor, p_actor, clock_timestamp())
  on conflict (project_id, field_key) do update set override_value = excluded.override_value,
    created_by = p_actor, approved_by = p_actor, approved_at = excluded.approved_at,
    updated_at = excluded.approved_at;

  insert into public.editorial_decisions (
    project_id, actor_user_id, action, previous_state, resulting_state, evidence, reason, resulting_revision
  ) values (p_project_id, p_actor, 'save_editorial', v_previous_state, v_previous_state,
    jsonb_build_object('changed_fields', v_changes, 'category_ids', to_jsonb(p_category_ids), 'tags', to_jsonb(p_tags)),
    p_reason, v_next_revision);
  return jsonb_build_object('revision', v_next_revision, 'status', v_previous_state);
end;
$function$;

create or replace function public.admin_verify_project_license(
  p_actor uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_expected_source_observed_at timestamptz,
  p_license_identifier text,
  p_evidence_reference text,
  p_reason text,
  p_confirm_open_source boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project public.projects%rowtype;
  v_repo_id uuid;
  v_observed_at timestamptz;
  v_assessment_id uuid;
  v_result jsonb;
  v_revision bigint;
  v_previous_state text;
  v_now timestamptz := clock_timestamp();
begin
  perform private.assert_editorial_admin(p_actor);
  if p_project_id is null or p_expected_revision is null or p_expected_source_observed_at is null
    or p_license_identifier is null or p_license_identifier !~ '^[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$'
    or p_evidence_reference is null
    or not private.is_safe_http_url(p_evidence_reference)
    or lower(p_evidence_reference) ~ '^https?://([^/]*[.])?github[.]com([/:?#]|$)'
    or length(btrim(p_reason)) not between 20 and 1000
    or p_confirm_open_source is distinct from true then
    raise exception 'valid independent evidence, reason, and explicit open-source confirmation are required' using errcode = '22023';
  end if;
  select p.* into v_project from public.projects p where p.id = p_project_id for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.editorial_revision <> p_expected_revision then raise exception 'stale editorial form' using errcode = '40001'; end if;
  if v_project.publication_status not in ('draft', 'pending_review') then
    raise exception 'license verification requires a draft in review' using errcode = '55000';
  end if;
  select e.repository_id, e.source_observed_at, e.assessment_id, e.assessment_result
    into v_repo_id, v_observed_at, v_assessment_id, v_result
  from private.assert_current_project_evidence(p_project_id) e;
  if v_observed_at is distinct from p_expected_source_observed_at then
    raise exception 'source observation changed; reload the evidence before verifying the license' using errcode = '40001';
  end if;

  v_previous_state := v_project.license_status;
  update public.projects set license_status = 'verified_open_source',
    license_identifier = p_license_identifier, license_verified_at = v_now,
    editorial_revision = editorial_revision + 1
  where id = p_project_id returning editorial_revision into v_revision;
  insert into public.editorial_overrides (
    project_id, field_key, override_value, created_by, approved_by, approved_at
  ) values
    (p_project_id, 'license_status', to_jsonb('verified_open_source'::text), p_actor, p_actor, v_now),
    (p_project_id, 'license_identifier', to_jsonb(p_license_identifier), p_actor, p_actor, v_now)
  on conflict (project_id, field_key) do update set override_value = excluded.override_value,
    created_by = p_actor, approved_by = p_actor, approved_at = excluded.approved_at,
    updated_at = excluded.approved_at;
  insert into public.editorial_decisions (
    project_id, actor_user_id, action, previous_state, resulting_state, evidence, reason, resulting_revision, created_at
  ) values (p_project_id, p_actor, 'verify_license', v_previous_state, 'verified_open_source',
    jsonb_build_object('license_identifier', p_license_identifier, 'evidence_reference', p_evidence_reference,
      'human_confirmed_open_source', true, 'assessment_status', v_result->'license'->>'status',
      'repository_id', v_repo_id, 'source_observed_at', v_observed_at, 'assessment_id', v_assessment_id),
    p_reason, v_revision, v_now);
  return jsonb_build_object('revision', v_revision, 'license_status', 'verified_open_source');
end;
$function$;

create or replace function public.admin_verify_project_quality(
  p_actor uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_expected_source_observed_at timestamptz,
  p_reason text,
  p_confirm_review boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project public.projects%rowtype;
  v_repo_id uuid;
  v_observed_at timestamptz;
  v_assessment_id uuid;
  v_result jsonb;
  v_revision bigint;
  v_previous_state text;
  v_now timestamptz := clock_timestamp();
begin
  perform private.assert_editorial_admin(p_actor);
  if p_project_id is null or p_expected_revision is null or p_expected_source_observed_at is null
    or length(btrim(p_reason)) not between 20 and 1000
    or p_confirm_review is distinct from true then
    raise exception 'explicit quality review and reason are required' using errcode = '22023';
  end if;
  select p.* into v_project from public.projects p where p.id = p_project_id for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.editorial_revision <> p_expected_revision then raise exception 'stale editorial form' using errcode = '40001'; end if;
  if v_project.publication_status not in ('draft', 'pending_review') then
    raise exception 'quality review requires a draft in review' using errcode = '55000';
  end if;
  select e.repository_id, e.source_observed_at, e.assessment_id, e.assessment_result
    into v_repo_id, v_observed_at, v_assessment_id, v_result
  from private.assert_current_project_evidence(p_project_id) e;
  if v_observed_at is distinct from p_expected_source_observed_at then
    raise exception 'source observation changed; reload the evidence before verifying quality' using errcode = '40001';
  end if;
  v_previous_state := v_project.quality_status;
  update public.projects set quality_status = 'verified', last_verified_at = v_now,
    editorial_revision = editorial_revision + 1
  where id = p_project_id returning editorial_revision into v_revision;
  insert into public.editorial_decisions (
    project_id, actor_user_id, action, previous_state, resulting_state, evidence, reason, resulting_revision, created_at
  ) values (p_project_id, p_actor, 'verify_quality', v_previous_state, 'verified',
    jsonb_build_object('repository_id', v_repo_id, 'source_observed_at', v_observed_at,
      'assessment_id', v_assessment_id, 'assessment_flags', v_result->'quality'->'flags',
      'human_reviewed_current_repository', true, 'not_a_security_or_code_audit', true),
    p_reason, v_revision, v_now);
  return jsonb_build_object('revision', v_revision, 'quality_status', 'verified');
end;
$function$;

create or replace function public.admin_set_project_review_state(
  p_actor uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_action text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project public.projects%rowtype;
  v_next_status text;
  v_revision bigint;
  v_now timestamptz := clock_timestamp();
begin
  perform private.assert_editorial_admin(p_actor);
  if p_project_id is null or p_expected_revision is null
    or p_action not in ('keep_pending', 'mark_review_required', 'reject', 'return_to_review')
    or length(btrim(p_reason)) not between 8 and 1000 then
    raise exception 'invalid review decision or reason' using errcode = '22023';
  end if;
  select p.* into v_project from public.projects p where p.id = p_project_id for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.editorial_revision <> p_expected_revision then raise exception 'stale editorial form' using errcode = '40001'; end if;
  if p_action = 'return_to_review' then
    if v_project.publication_status <> 'rejected' then raise exception 'only a rejected project can be returned to review' using errcode = '55000'; end if;
    v_next_status := 'pending_review';
  elsif p_action = 'reject' then
    if v_project.publication_status not in ('draft', 'pending_review') then raise exception 'only a draft can be rejected' using errcode = '55000'; end if;
    v_next_status := 'rejected';
  elsif p_action = 'keep_pending' or p_action = 'mark_review_required' then
    if v_project.publication_status not in ('draft', 'pending_review') then raise exception 'only a draft can remain in review' using errcode = '55000'; end if;
    v_next_status := 'pending_review';
  end if;
  update public.projects set publication_status = v_next_status,
    quality_status = case when p_action = 'mark_review_required' then 'needs_review' else quality_status end,
    license_status = case when p_action = 'mark_review_required'
      and license_status <> 'verified_open_source' then 'needs_review' else license_status end,
    license_verified_at = case when p_action = 'mark_review_required'
      and license_status <> 'verified_open_source' then null else license_verified_at end,
    editorial_revision = editorial_revision + 1
  where id = p_project_id returning editorial_revision into v_revision;

  if p_action = 'mark_review_required' and v_project.license_status <> 'verified_open_source' then
    insert into public.editorial_overrides (
      project_id, field_key, override_value, created_by, approved_by, approved_at
    ) values (p_project_id, 'license_status', to_jsonb('needs_review'::text), p_actor, p_actor, v_now)
    on conflict (project_id, field_key) do update set override_value = excluded.override_value,
      created_by = p_actor, approved_by = p_actor, approved_at = excluded.approved_at,
      updated_at = excluded.approved_at;
  end if;

  if p_action = 'reject' then
    update public.review_queue set status = 'resolved', resolved_at = v_now, updated_at = v_now
    where status in ('open', 'in_review') and (project_id = p_project_id or repository_id = v_project.primary_repository_id
      or assessment_id in (select a.id from public.repository_assessments a where a.repository_id = v_project.primary_repository_id));
  elsif p_action in ('keep_pending', 'mark_review_required', 'return_to_review') then
    update public.review_queue set reason = left(p_reason, 1000), status = 'open',
      resolved_at = null, updated_at = v_now
    where id = (select q.id from public.review_queue q
      where q.project_id = p_project_id and q.status in ('open', 'in_review')
      order by q.created_at limit 1 for update);
    if not found then
      insert into public.review_queue (project_id, reason, status)
      values (p_project_id, left(p_reason, 1000), 'open');
    end if;
  end if;

  insert into public.editorial_decisions (
    project_id, actor_user_id, action, previous_state, resulting_state, evidence, reason, resulting_revision, created_at
  ) values (p_project_id, p_actor, p_action, v_project.publication_status, v_next_status,
    jsonb_build_object('previous_license_status', v_project.license_status,
      'previous_quality_status', v_project.quality_status), p_reason, v_revision, v_now);
  return jsonb_build_object('revision', v_revision, 'publication_status', v_next_status);
end;
$function$;

create or replace function public.admin_resolve_project_review_item(
  p_actor uuid,
  p_project_id uuid,
  p_queue_id uuid,
  p_expected_revision bigint,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project public.projects%rowtype;
  v_queue public.review_queue%rowtype;
  v_revision bigint;
begin
  perform private.assert_editorial_admin(p_actor);
  if p_project_id is null or p_queue_id is null or p_expected_revision is null
    or length(btrim(p_reason)) not between 8 and 1000 then
    raise exception 'invalid review item resolution' using errcode = '22023';
  end if;
  select p.* into v_project from public.projects p where p.id = p_project_id for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.editorial_revision <> p_expected_revision then raise exception 'stale editorial form' using errcode = '40001'; end if;
  select q.* into v_queue from public.review_queue q where q.id = p_queue_id for update;
  if not found or v_queue.status not in ('open', 'in_review')
    or not (v_queue.project_id = p_project_id
      or v_queue.repository_id = v_project.primary_repository_id
      or (v_queue.assessment_id is not null and exists (select 1 from public.repository_assessments a
        where a.id = v_queue.assessment_id and a.repository_id = v_project.primary_repository_id))) then
    raise exception 'review item is not open for this project' using errcode = '55000';
  end if;
  update public.review_queue set status = 'resolved', resolved_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_queue_id;
  update public.projects set editorial_revision = editorial_revision + 1
  where id = p_project_id returning editorial_revision into v_revision;
  insert into public.editorial_decisions (
    project_id, actor_user_id, action, previous_state, resulting_state, evidence, reason, resulting_revision
  ) values (p_project_id, p_actor, 'resolve_review_item', v_project.publication_status,
    v_project.publication_status, jsonb_build_object('review_queue_id', p_queue_id), p_reason, v_revision);
  return jsonb_build_object('revision', v_revision, 'resolved', true);
end;
$function$;

create or replace function public.admin_publish_project(
  p_actor uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project public.projects%rowtype;
  v_repo_id uuid;
  v_observed_at timestamptz;
  v_assessment_id uuid;
  v_revision bigint;
  v_now timestamptz := clock_timestamp();
begin
  perform private.assert_editorial_admin(p_actor);
  if p_project_id is null or p_expected_revision is null
    or length(btrim(p_reason)) not between 8 and 1000 then
    raise exception 'invalid publication decision' using errcode = '22023';
  end if;
  select p.* into v_project from public.projects p where p.id = p_project_id for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.publication_status = 'published' then
    return jsonb_build_object('revision', v_project.editorial_revision, 'published', true, 'idempotent', true);
  end if;
  if v_project.editorial_revision <> p_expected_revision then raise exception 'stale editorial form' using errcode = '40001'; end if;
  if v_project.publication_status <> 'pending_review' then
    raise exception 'project must be explicitly in pending review before publishing' using errcode = '55000';
  end if;
  if length(btrim(v_project.name)) not between 1 and 120
    or length(btrim(v_project.summary)) not between 10 and 280 then
    raise exception 'project name and summary are required before publishing' using errcode = '23514';
  end if;
  if v_project.license_status <> 'verified_open_source'
    or nullif(btrim(v_project.license_identifier), '') is null
    or v_project.license_verified_at is null
    or not exists (select 1 from public.editorial_decisions d where d.project_id = p_project_id
      and d.action = 'verify_license' and d.resulting_state = 'verified_open_source'
      and d.evidence->>'license_identifier' = v_project.license_identifier
      and d.evidence->>'human_confirmed_open_source' = 'true') then
    raise exception 'explicit human license verification with evidence is required' using errcode = '23514';
  end if;
  if v_project.quality_status <> 'verified'
    or v_project.last_verified_at is null
    or not exists (select 1 from public.editorial_decisions d where d.project_id = p_project_id
      and d.action = 'verify_quality' and d.resulting_state = 'verified'
      and d.evidence->>'human_reviewed_current_repository' = 'true'
      and d.evidence->>'not_a_security_or_code_audit' = 'true') then
    raise exception 'explicit human quality review is required' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.project_categories pc join public.categories c on c.id = pc.category_id
    where pc.project_id = p_project_id and c.is_active
  ) then raise exception 'at least one active category is required' using errcode = '23514'; end if;

  select e.repository_id, e.source_observed_at, e.assessment_id
    into v_repo_id, v_observed_at, v_assessment_id
  from private.assert_current_project_evidence(p_project_id) e;
  if not exists (select 1 from public.editorial_decisions d where d.project_id = p_project_id
    and d.action = 'verify_license' and (d.evidence->>'source_observed_at')::timestamptz = v_observed_at)
    or not exists (select 1 from public.editorial_decisions d where d.project_id = p_project_id
      and d.action = 'verify_quality' and (d.evidence->>'source_observed_at')::timestamptz = v_observed_at) then
    raise exception 'license and quality decisions must match the current source observation' using errcode = '23514';
  end if;
  if exists (select 1 from public.review_queue q where q.status in ('open', 'in_review')
    and (q.project_id = p_project_id or q.repository_id = v_repo_id or q.assessment_id in (
      select a.id from public.repository_assessments a where a.repository_id = v_repo_id
    ))) then
    raise exception 'unresolved blocking review items remain' using errcode = '23514';
  end if;

  update public.projects set publication_status = 'published', published_at = v_now,
    last_verified_at = greatest(coalesce(last_verified_at, v_now), v_now),
    editorial_revision = editorial_revision + 1
  where id = p_project_id returning editorial_revision into v_revision;
  update public.review_queue set status = 'resolved', resolved_at = v_now, updated_at = v_now
  where status in ('open', 'in_review') and (project_id = p_project_id
    or repository_id = v_repo_id or assessment_id = v_assessment_id);
  insert into public.editorial_decisions (
    project_id, actor_user_id, action, previous_state, resulting_state, evidence, reason, resulting_revision, created_at
  ) values (p_project_id, p_actor, 'publish', 'pending_review', 'published',
    jsonb_build_object('repository_id', v_repo_id, 'assessment_id', v_assessment_id,
      'source_observed_at', v_observed_at, 'license_identifier', v_project.license_identifier,
      'license_decision_at', v_project.license_verified_at, 'quality_decision_at', v_project.last_verified_at),
    p_reason, v_revision, v_now);
  return jsonb_build_object('revision', v_revision, 'published', true, 'idempotent', false);
end;
$function$;

revoke all on function public.admin_save_project_editorial(uuid, uuid, bigint, jsonb, uuid[], text[], text) from public, anon, authenticated;
revoke all on function public.admin_verify_project_license(uuid, uuid, bigint, timestamptz, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_verify_project_quality(uuid, uuid, bigint, timestamptz, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_set_project_review_state(uuid, uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.admin_resolve_project_review_item(uuid, uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.admin_publish_project(uuid, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.admin_save_project_editorial(uuid, uuid, bigint, jsonb, uuid[], text[], text) to service_role;
grant execute on function public.admin_verify_project_license(uuid, uuid, bigint, timestamptz, text, text, text, boolean) to service_role;
grant execute on function public.admin_verify_project_quality(uuid, uuid, bigint, timestamptz, text, boolean) to service_role;
grant execute on function public.admin_set_project_review_state(uuid, uuid, bigint, text, text) to service_role;
grant execute on function public.admin_resolve_project_review_item(uuid, uuid, uuid, bigint, text) to service_role;
grant execute on function public.admin_publish_project(uuid, uuid, bigint, text) to service_role;
