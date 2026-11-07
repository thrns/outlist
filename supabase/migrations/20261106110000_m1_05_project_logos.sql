-- M1-05: immutable logo candidates, reviewed approval, and public-bucket safety.

alter table public.project_logos
  add column candidate_key text,
  add column repository_id uuid references public.repositories(id) on delete set null,
  add column source_observed_at timestamptz,
  add column source_provenance jsonb not null default '{}'::jsonb,
  add column content_digest text,
  add column approval_provenance jsonb,
  add column approval_token uuid,
  add column approval_lease_expires_at timestamptz;

alter table public.project_logos
  add constraint project_logos_candidate_key_format check (
    candidate_key is null or candidate_key ~ '^[a-z0-9][a-z0-9:_-]{0,255}$'
  ),
  add constraint project_logos_source_provenance_object check (
    jsonb_typeof(source_provenance) = 'object' and pg_column_size(source_provenance) <= 8192
  ),
  add constraint project_logos_content_digest_format check (
    content_digest is null or content_digest ~ '^[a-f0-9]{64}$'
  ),
  add constraint project_logos_approval_provenance_object check (
    approval_provenance is null or (
      jsonb_typeof(approval_provenance) = 'object' and pg_column_size(approval_provenance) <= 8192
    )
  ),
  add constraint project_logos_approval_lease_pair check (
    (approval_token is null and approval_lease_expires_at is null)
    or (verification_status = 'pending_review' and approval_token is not null and approval_lease_expires_at is not null)
  );

alter table public.project_logos drop constraint project_logos_approval_metadata;
update public.project_logos set approval_provenance = jsonb_build_object(
  'legacy_approved_before_m1_05', true,
  'digest_unavailable_at_migration', true
)
where verification_status = 'approved' and approval_provenance is null;
alter table public.project_logos add constraint project_logos_approval_metadata check (
  (verification_status = 'approved'
    and storage_path is not null
    and verified_at is not null
    and approval_provenance is not null
    and (
      (content_digest is not null and content_digest ~ '^[a-f0-9]{64}$'
        and storage_path = project_id::text || '/' || id::text || '.webp'
        and media_type = 'image/webp')
      or (content_digest is null and approval_provenance->>'legacy_approved_before_m1_05' = 'true')
    ))
  or (verification_status <> 'approved'
    and storage_path is null
    and content_digest is null
    and verified_by is null
    and verified_at is null
    and approval_provenance is null)
);

with ranked_primary as (
  select l.id, l.is_primary, l.verification_status,
    row_number() over (partition by l.project_id order by l.is_primary desc,
      case when l.origin in ('official_site', 'editorial', 'submitted') then 0 else 1 end,
      l.verified_at desc nulls last, l.created_at, l.id) as position
  from public.project_logos l
)
update public.project_logos l set is_primary = false
from ranked_primary r
where r.id = l.id and (r.verification_status <> 'approved' or (r.is_primary and r.position > 1));

alter table public.project_logos add constraint project_logos_primary_approved check (
  not is_primary or verification_status = 'approved'
);

create unique index project_logos_candidate_identity_unique
  on public.project_logos (project_id, candidate_key) where candidate_key is not null;
-- The earlier project_logos_one_primary_per_project_idx already enforces one
-- is_primary row; project_logos_primary_approved narrows that to approved rows.
with ranked_logo_reviews as (
  select q.id, row_number() over (partition by q.project_logo_id
    order by case when q.status = 'in_review' then 0 else 1 end, q.created_at, q.id) as position
  from public.review_queue q
  where q.project_logo_id is not null and q.status in ('open', 'in_review')
)
update public.review_queue q set status = 'dismissed', resolved_at = clock_timestamp(), updated_at = clock_timestamp()
from ranked_logo_reviews r where r.id = q.id and r.position > 1;
create unique index review_queue_open_logo_unique
  on public.review_queue (project_logo_id)
  where project_logo_id is not null and status in ('open', 'in_review');
create index project_logos_project_approved_priority_idx
  on public.project_logos (project_id, origin, is_primary desc, verified_at desc)
  where verification_status = 'approved';

create or replace function private.guard_project_logo_metadata()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and row(
    new.project_id, new.origin, new.source_url,
    new.candidate_key, new.source_observed_at, new.source_provenance
  ) is distinct from row(
    old.project_id, old.origin, old.source_url,
    old.candidate_key, old.source_observed_at, old.source_provenance
  ) then
    raise exception 'logo source identity and provenance are immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
    (new.repository_id is distinct from old.repository_id and new.repository_id is not null)
    or (new.source_record_id is distinct from old.source_record_id and new.source_record_id is not null)
  ) then
    raise exception 'logo source references cannot be reassigned' using errcode = '42501';
  end if;

  if new.is_primary and new.verification_status <> 'approved' then
    raise exception 'only approved logos can be primary' using errcode = '23514';
  end if;
  if new.is_primary and new.origin = 'provider_avatar' and exists (
    select 1 from public.project_logos official
    where official.project_id = new.project_id
      and official.verification_status = 'approved'
      and official.origin in ('official_site', 'editorial', 'submitted')
  ) then
    raise exception 'an approved provider avatar cannot displace an official logo' using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function private.guard_project_logo_metadata() from public, anon, authenticated, service_role;
create trigger project_logos_metadata_guard
before insert or update on public.project_logos
for each row execute function private.guard_project_logo_metadata();

-- This RPC is the only supported path for registering machine-discovered or
-- operator-supplied candidates. In particular, it never stores image bytes.
create function public.register_project_logo_candidate(
  p_project_id uuid,
  p_origin text,
  p_source_url text,
  p_attribution_text text,
  p_candidate_key text,
  p_repository_id uuid,
  p_source_record_id uuid,
  p_source_observed_at timestamptz,
  p_source_provenance jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_logo_id uuid;
  v_existing public.project_logos%rowtype;
  v_repository public.repositories%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_origin is null or p_origin not in ('provider_avatar', 'official_site', 'editorial')
    or p_candidate_key is null or p_candidate_key !~ '^[a-z0-9][a-z0-9:_-]{0,255}$'
    or p_source_url is null or length(p_source_url) > 2048
    or p_attribution_text is null or nullif(btrim(p_attribution_text), '') is null or length(p_attribution_text) > 500
    or p_source_observed_at is null
    or (p_source_provenance->>'observed_at')::timestamptz is distinct from p_source_observed_at
    or jsonb_typeof(p_source_provenance) is distinct from 'object'
    or pg_column_size(p_source_provenance) > 8192 then
    raise exception 'invalid logo candidate metadata' using errcode = '22023';
  end if;
  if not private.is_safe_http_url(p_source_url) or lower(split_part(p_source_url, ':', 1)) <> 'https' then
    raise exception 'logo source must be a safe HTTPS URL' using errcode = '22023';
  end if;
  if p_origin = 'provider_avatar' then
    if p_repository_id is null
      or p_candidate_key !~ '^github-avatar:[1-9][0-9]{0,18}:[a-f0-9]{64}$'
      or p_source_url !~ '^https://avatars\.githubusercontent\.com/u/[1-9][0-9]{0,18}(\?v=[0-9]{1,4})?$'
      or p_source_provenance->>'provider' is distinct from 'github'
      or p_source_provenance->>'api_version' is distinct from '2022-11-28'
      or p_source_provenance->>'http_status' is distinct from '200'
      or p_source_provenance->>'source_api_url' is distinct from 'https://api.github.com/repositories/' || substring(p_candidate_key from '^github-avatar:([1-9][0-9]{0,18}):')
      or p_source_provenance->>'stable_repository_id' is distinct from substring(p_candidate_key from '^github-avatar:([1-9][0-9]{0,18}):')
      or p_source_provenance->>'owner_id' is distinct from substring(p_source_url from '/u/([1-9][0-9]{0,18})') then
      raise exception 'invalid GitHub avatar candidate identity' using errcode = '22023';
    end if;
    select r.* into v_repository from public.repositories r
    where r.id = p_repository_id and r.project_id = p_project_id and r.provider = 'github'
      and r.provider_repository_id = substring(p_candidate_key from '^github-avatar:([1-9][0-9]{0,18}):')
      and r.availability_status = 'available' and r.is_private is false
      and r.is_disabled is false and lower(btrim(coalesce(r.visibility, ''))) = 'public';
    if not found then raise exception 'repository is not eligible for avatar discovery' using errcode = '22023'; end if;
  else
    if p_repository_id is not null and not exists (
      select 1 from public.repositories r where r.id = p_repository_id and r.project_id = p_project_id
    ) then
      raise exception 'logo repository must belong to its project' using errcode = '22023';
    end if;
    if p_candidate_key !~ '^operator-official:[a-f0-9]{64}$'
      or p_source_provenance->>'provider' is distinct from 'operator'
      or p_source_provenance->>'operator_action' is distinct from 'true' then
      raise exception 'official logo candidates require trusted operator provenance' using errcode = '22023';
    end if;
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.publication_status not in ('rejected', 'archived')) then
    raise exception 'project is not eligible for a logo candidate' using errcode = '22023';
  end if;
  if p_source_record_id is null or not exists (
    select 1 from public.source_records s
    where s.id = p_source_record_id and s.fetched_at = p_source_observed_at
      and (s.repository_id = p_repository_id or (p_origin <> 'provider_avatar' and p_repository_id is null))
      and ((p_origin = 'provider_avatar' and s.provider = 'github' and s.record_kind = 'owner_avatar_observation'
          and s.http_status = 200 and s.source_url = p_source_provenance->>'source_api_url'
          and s.source_metadata->>'api_version' = '2022-11-28'
          and s.source_metadata->>'stable_repository_id' = p_source_provenance->>'stable_repository_id'
          and s.source_metadata->>'observed_at' = p_source_provenance->>'observed_at'
          and s.source_metadata->>'owner_id' = p_source_provenance->>'owner_id'
          and s.source_metadata->>'owner_login' = p_source_provenance->>'owner_login'
          and s.source_metadata->>'repository_full_name' = p_source_provenance->>'repository_full_name'
          and s.source_metadata->>'avatar_url' = p_source_url)
        or (p_origin in ('official_site', 'editorial') and s.provider = 'other'
          and s.record_kind = 'operator_logo_candidate' and s.source_url = p_source_url
          and s.source_metadata->>'operator_action' = 'true'
          and s.source_metadata->>'observed_at' = p_source_provenance->>'observed_at'
          and s.source_metadata->>'attribution' = p_attribution_text))
  ) then
    raise exception 'logo provenance does not match the source record' using errcode = '22023';
  end if;

  insert into public.project_logos (
    project_id, source_url, media_type, origin, verification_status, attribution_text,
    source_record_id, repository_id, candidate_key, source_observed_at, source_provenance
  ) values (
    p_project_id, p_source_url, 'image/webp', p_origin, 'pending_review', p_attribution_text,
    p_source_record_id, p_repository_id, p_candidate_key, p_source_observed_at, p_source_provenance
  ) on conflict (project_id, candidate_key) where candidate_key is not null do nothing
  returning id into v_logo_id;

  if v_logo_id is null then
    select l.* into v_existing from public.project_logos l
    where l.project_id = p_project_id and l.candidate_key = p_candidate_key for update;
    if not found or v_existing.source_url is distinct from p_source_url
      or v_existing.origin is distinct from p_origin then
      raise exception 'candidate identity conflicts with existing source metadata' using errcode = '23505';
    end if;
    v_logo_id := v_existing.id;
  end if;

  if exists (
    select 1 from public.project_logos l
    where l.id = v_logo_id and l.verification_status = 'pending_review'
  ) then
    insert into public.review_queue (project_logo_id, reason, status)
    values (v_logo_id, 'Review project logo candidate source and brand representation.', 'open')
    on conflict (project_logo_id) where project_logo_id is not null and status in ('open', 'in_review') do nothing;
  end if;
  return v_logo_id;
end;
$function$;

create function public.claim_project_logo_approval(p_logo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_logo public.project_logos%rowtype;
  v_project public.projects%rowtype;
  v_repository public.repositories%rowtype;
  v_token uuid;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select l.* into v_logo from public.project_logos l where l.id = p_logo_id for update;
  if not found then raise exception 'logo candidate not found' using errcode = 'P0002'; end if;
  if v_logo.verification_status = 'approved' then
    return jsonb_build_object('status', 'already_approved', 'logo_id', v_logo.id,
      'storage_path', v_logo.storage_path, 'content_digest', v_logo.content_digest);
  end if;
  if v_logo.verification_status <> 'pending_review' then
    raise exception 'only pending logo candidates can be approved' using errcode = '23514';
  end if;
  if v_logo.approval_token is not null and v_logo.approval_lease_expires_at > v_now then
    raise exception 'logo candidate already has an active approval operation' using errcode = '55P03';
  end if;
  select p.* into v_project from public.projects p where p.id = v_logo.project_id for update;
  if not found or v_project.publication_status in ('rejected', 'archived') then
    raise exception 'project is not eligible for logo approval' using errcode = '22023';
  end if;
  if v_logo.origin = 'provider_avatar' then
    select r.* into v_repository from public.repositories r
    where r.id = v_logo.repository_id and r.project_id = v_logo.project_id and r.provider = 'github'
      and r.provider_repository_id = v_logo.source_provenance->>'stable_repository_id'
      and r.availability_status = 'available' and r.is_private is false and r.is_disabled is false
      and lower(btrim(coalesce(r.visibility, ''))) = 'public';
    if not found then raise exception 'avatar repository is not eligible' using errcode = '22023'; end if;
  end if;
  v_token := gen_random_uuid();
  update public.project_logos set approval_token = v_token,
    approval_lease_expires_at = v_now + interval '10 minutes', updated_at = v_now
  where id = v_logo.id;
  return jsonb_build_object('status', 'claimed', 'logo_id', v_logo.id, 'approval_token', v_token);
end;
$function$;

create function public.approve_project_logo_candidate(
  p_logo_id uuid,
  p_approval_token uuid,
  p_storage_path text,
  p_content_digest text,
  p_media_type text,
  p_approval_provenance jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_logo public.project_logos%rowtype;
  v_project public.projects%rowtype;
  v_primary_official uuid;
  v_has_official boolean;
  v_make_primary boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select l.* into v_logo from public.project_logos l where l.id = p_logo_id for update;
  if not found then raise exception 'logo candidate not found' using errcode = 'P0002'; end if;
  select p.* into v_project from public.projects p where p.id = v_logo.project_id for update;
  if not found or v_project.publication_status in ('rejected', 'archived') then
    raise exception 'project is not eligible for logo approval' using errcode = '22023';
  end if;
  if v_logo.verification_status = 'approved' then
    if v_logo.storage_path = p_storage_path and v_logo.content_digest = p_content_digest then
      return jsonb_build_object('status', 'already_approved', 'logo_id', v_logo.id, 'storage_path', v_logo.storage_path);
    end if;
    raise exception 'approved logo cannot be replaced through candidate approval' using errcode = '23514';
  end if;
  if v_logo.verification_status <> 'pending_review' then
    raise exception 'only pending logo candidates can be approved' using errcode = '23514';
  end if;
  if p_approval_token is null or v_logo.approval_token is distinct from p_approval_token
    or v_logo.approval_lease_expires_at <= v_now then
    raise exception 'logo approval claim is missing, expired, or stale' using errcode = '40001';
  end if;
  if p_storage_path is distinct from v_logo.project_id::text || '/' || v_logo.id::text || '.webp'
    or p_content_digest !~ '^[a-f0-9]{64}$' or p_media_type is distinct from 'image/webp'
    or jsonb_typeof(p_approval_provenance) is distinct from 'object'
    or p_approval_provenance->>'operator_action' is distinct from 'true'
    or pg_column_size(p_approval_provenance) > 8192 then
    raise exception 'invalid approved asset metadata' using errcode = '22023';
  end if;
  if v_logo.origin = 'provider_avatar' then
    if not exists (
      select 1 from public.repositories r
      where r.id = v_logo.repository_id and r.project_id = v_logo.project_id and r.provider = 'github'
        and r.provider_repository_id = v_logo.source_provenance->>'stable_repository_id'
        and r.availability_status = 'available' and r.is_private is false and r.is_disabled is false
        and lower(btrim(coalesce(r.visibility, ''))) = 'public'
    ) then raise exception 'avatar repository is no longer eligible' using errcode = '22023'; end if;
  end if;

  select l.id into v_primary_official from public.project_logos l
  where l.project_id = v_logo.project_id and l.verification_status = 'approved'
    and l.origin in ('official_site', 'editorial', 'submitted') and l.is_primary
  limit 1;
  select exists (
    select 1 from public.project_logos l where l.project_id = v_logo.project_id
      and l.verification_status = 'approved'
      and l.origin in ('official_site', 'editorial', 'submitted')
  ) into v_has_official;
  if v_logo.origin in ('official_site', 'editorial', 'submitted') then
    if v_primary_official is null then
      update public.project_logos set is_primary = false, updated_at = v_now
      where project_id = v_logo.project_id and is_primary;
      v_make_primary := true;
    else
      update public.project_logos set is_primary = false, updated_at = v_now
      where project_id = v_logo.project_id and is_primary and id <> v_primary_official;
    end if;
  elsif v_has_official then
    update public.project_logos set is_primary = false, updated_at = v_now
    where project_id = v_logo.project_id and origin = 'provider_avatar' and is_primary;
  else
    v_make_primary := not exists (
      select 1 from public.project_logos l
      where l.project_id = v_logo.project_id and l.verification_status = 'approved' and l.is_primary
    );
  end if;

  update public.project_logos set
    verification_status = 'approved', storage_path = p_storage_path, media_type = p_media_type,
    content_digest = p_content_digest, verified_at = v_now, verified_by = null,
    approval_provenance = p_approval_provenance, is_primary = v_make_primary,
    approval_token = null, approval_lease_expires_at = null, updated_at = v_now
  where id = v_logo.id;
  update public.review_queue set status = 'resolved', resolved_at = v_now, updated_at = v_now
  where project_logo_id = v_logo.id and status in ('open', 'in_review');
  return jsonb_build_object('status', 'approved', 'logo_id', v_logo.id, 'storage_path', p_storage_path);
end;
$function$;

create function public.set_project_logo_review_status(
  p_logo_id uuid,
  p_status text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_logo public.project_logos%rowtype;
  v_storage_path text;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_status not in ('rejected', 'revoked') then
    raise exception 'logo review status must be rejected or revoked' using errcode = '22023';
  end if;
  select l.* into v_logo from public.project_logos l where l.id = p_logo_id for update;
  if not found then raise exception 'logo candidate not found' using errcode = 'P0002'; end if;
  if p_status = 'rejected' and v_logo.verification_status not in ('pending_review', 'rejected') then
    raise exception 'only pending candidates can be rejected' using errcode = '23514';
  end if;
  if p_status = 'revoked' and v_logo.verification_status not in ('approved', 'revoked') then
    raise exception 'only approved logos can be revoked' using errcode = '23514';
  end if;
  if v_logo.approval_token is not null and v_logo.approval_lease_expires_at > v_now then
    raise exception 'logo candidate has an active approval operation' using errcode = '55P03';
  end if;
  v_storage_path := v_logo.storage_path;
  update public.project_logos set
    verification_status = p_status, storage_path = null, content_digest = null,
    verified_at = null, verified_by = null, approval_provenance = null,
    approval_token = null, approval_lease_expires_at = null, is_primary = false, updated_at = v_now
  where id = v_logo.id;
  update public.review_queue set status = 'dismissed', resolved_at = v_now, updated_at = v_now
  where project_logo_id = v_logo.id and status in ('open', 'in_review');
  return jsonb_build_object('status', p_status, 'logo_id', v_logo.id, 'storage_path', v_storage_path);
end;
$function$;

create function public.release_project_logo_approval(p_logo_id uuid, p_approval_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_logo public.project_logos%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select l.* into v_logo from public.project_logos l where l.id = p_logo_id for update;
  if not found then raise exception 'logo candidate not found' using errcode = 'P0002'; end if;
  if v_logo.verification_status = 'approved' then
    return jsonb_build_object('status', 'already_approved', 'logo_id', v_logo.id, 'storage_path', v_logo.storage_path);
  end if;
  if v_logo.verification_status <> 'pending_review' or v_logo.approval_token is distinct from p_approval_token then
    return jsonb_build_object('status', 'claim_not_owned', 'logo_id', v_logo.id);
  end if;
  update public.project_logos set approval_token = null, approval_lease_expires_at = null, updated_at = clock_timestamp()
  where id = v_logo.id;
  return jsonb_build_object('status', 'claim_released', 'logo_id', v_logo.id);
end;
$function$;

-- Fence cleanup after an ambiguous Storage or database response. The caller
-- must own the previous claim; rotating the token prevents another approval
-- from racing with removal of the deterministic public object path.
create function public.claim_project_logo_cleanup(p_logo_id uuid, p_approval_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_logo public.project_logos%rowtype;
  v_token uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select l.* into v_logo from public.project_logos l where l.id = p_logo_id for update;
  if not found then raise exception 'logo candidate not found' using errcode = 'P0002'; end if;
  if v_logo.verification_status = 'approved' then
    return jsonb_build_object('status', 'already_approved', 'logo_id', v_logo.id, 'storage_path', v_logo.storage_path);
  end if;
  if v_logo.verification_status <> 'pending_review' or v_logo.approval_token is distinct from p_approval_token then
    return jsonb_build_object('status', 'claim_conflict', 'logo_id', v_logo.id);
  end if;
  v_token := gen_random_uuid();
  update public.project_logos set approval_token = v_token,
    approval_lease_expires_at = clock_timestamp() + interval '10 minutes', updated_at = clock_timestamp()
  where id = v_logo.id;
  return jsonb_build_object('status', 'cleanup_claimed', 'logo_id', v_logo.id, 'approval_token', v_token);
end;
$function$;

revoke all on function public.register_project_logo_candidate(uuid, text, text, text, text, uuid, uuid, timestamptz, jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_project_logo_approval(uuid)
  from public, anon, authenticated;
revoke all on function public.release_project_logo_approval(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_project_logo_cleanup(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.approve_project_logo_candidate(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.set_project_logo_review_status(uuid, text)
  from public, anon, authenticated;
grant execute on function public.register_project_logo_candidate(uuid, text, text, text, text, uuid, uuid, timestamptz, jsonb)
  to service_role;
grant execute on function public.claim_project_logo_approval(uuid)
  to service_role;
grant execute on function public.release_project_logo_approval(uuid, uuid)
  to service_role;
grant execute on function public.claim_project_logo_cleanup(uuid, uuid)
  to service_role;
grant execute on function public.approve_project_logo_candidate(uuid, uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.set_project_logo_review_status(uuid, text)
  to service_role;

-- The service role reads candidates, but all metadata writes go through the
-- validation and transaction boundaries above. Public clients remain read-only.
revoke insert, update, delete on public.project_logos from public, anon, authenticated, service_role;
grant select on public.project_logos to service_role;

comment on table public.project_logos is
  'Reviewed logo candidates. provider_avatar is an owner avatar candidate, never a claim that the avatar is the project brand.';
comment on column public.project_logos.source_provenance is
  'Immutable source observation metadata. Never contains downloaded image bytes.';
comment on column public.project_logos.approval_provenance is
  'Trusted operator action and normalization metadata recorded atomically with approval.';
