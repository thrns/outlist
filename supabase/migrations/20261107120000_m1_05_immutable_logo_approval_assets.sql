-- M1-05 corrective review: each approval attempt owns a distinct immutable
-- object identity. Database fencing cannot fence Storage API writes.

alter table public.project_logos
  add column approval_worker_id uuid,
  drop constraint project_logos_approval_lease_pair,
  add constraint project_logos_approval_lease_pair check (
    (approval_token is null and approval_worker_id is null and approval_lease_expires_at is null)
    or (verification_status = 'pending_review' and approval_token is not null
      and approval_worker_id is not null and approval_lease_expires_at is not null)
  ),
  drop constraint project_logos_storage_path_format,
  add constraint project_logos_storage_path_format check (
    storage_path is null or (
      storage_path like project_id::text || '/%'
      and (
        storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$'
        or storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
      )
    )
  ),
  drop constraint project_logos_approval_metadata,
  add constraint project_logos_approval_metadata check (
    (verification_status = 'approved'
      and storage_path is not null
      and verified_at is not null
      and approval_provenance is not null
      and (
        (content_digest is not null and content_digest ~ '^[a-f0-9]{64}$'
          and media_type = 'image/webp'
          and (
            storage_path = project_id::text || '/' || id::text || '.webp'
            or storage_path ~ ('^' || project_id::text || '/' || id::text || '/[0-9a-f-]{36}\.webp$')
          ))
        or (content_digest is null
          and approval_provenance->>'legacy_approved_before_m1_05' = 'true'
          and storage_path ~ ('^' || project_id::text || '/' || id::text || '\.(png|jpg|jpeg|webp)$'))
      ))
    or (verification_status <> 'approved'
      and storage_path is null
      and content_digest is null
      and verified_by is null
      and verified_at is null
      and approval_provenance is null)
  );

create table private.project_logo_storage_attempts (
  id uuid primary key default gen_random_uuid(),
  approval_token uuid unique,
  worker_id uuid,
  logo_id uuid not null references public.project_logos(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null unique,
  content_digest text,
  media_type text not null default 'image/webp' check (media_type in ('image/png', 'image/jpeg', 'image/webp')),
  state text not null check (state in ('claimed', 'cleanup_pending', 'approved')),
  lease_expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint project_logo_storage_attempt_identity check (
    (approval_token is null
      and worker_id is null
      and storage_path ~ ('^' || project_id::text || '/' || logo_id::text || '\.(png|jpg|jpeg|webp)$'))
    or (approval_token is not null
      and worker_id is not null
      and storage_path = project_id::text || '/' || logo_id::text || '/' || approval_token::text || '.webp')
  ),
  constraint project_logo_storage_attempt_digest check (
    content_digest is null or content_digest ~ '^[a-f0-9]{64}$'
  ),
  constraint project_logo_storage_attempt_lease check (
    (approval_token is null and lease_expires_at is null)
    or (approval_token is not null and lease_expires_at is not null)
  )
);

alter table private.project_logo_storage_attempts enable row level security;
revoke all on private.project_logo_storage_attempts from public, anon, authenticated, service_role;

-- Preserve legacy objects and their original paths so that revocation and
-- reconciliation can clean them only after the row stops referencing them.
insert into private.project_logo_storage_attempts (
  logo_id, project_id, storage_path, content_digest, media_type, state
)
select id, project_id, storage_path, content_digest, media_type, 'approved'
from public.project_logos
where verification_status = 'approved';

drop function public.claim_project_logo_approval(uuid);
create function public.claim_project_logo_approval(p_logo_id uuid, p_worker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_logo public.project_logos%rowtype;
  v_project public.projects%rowtype;
  v_token uuid;
  v_path text;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_worker_id is null then raise exception 'approval worker identity is required' using errcode = '22023'; end if;
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
    if not exists (
      select 1 from public.repositories r
      where r.id = v_logo.repository_id and r.project_id = v_logo.project_id and r.provider = 'github'
      and r.provider_repository_id = v_logo.source_provenance->>'stable_repository_id'
      and r.availability_status = 'available' and r.is_private is false and r.is_disabled is false
      and lower(btrim(coalesce(r.visibility, ''))) = 'public'
    ) then raise exception 'avatar repository is not eligible' using errcode = '22023'; end if;
  end if;
  if v_logo.approval_token is not null then
    update private.project_logo_storage_attempts
    set state = 'cleanup_pending'
    where approval_token = v_logo.approval_token and logo_id = v_logo.id and state <> 'approved';
  end if;
  v_token := gen_random_uuid();
  v_path := v_logo.project_id::text || '/' || v_logo.id::text || '/' || v_token::text || '.webp';
  insert into private.project_logo_storage_attempts (
    approval_token, worker_id, logo_id, project_id, storage_path, state, lease_expires_at
  ) values (v_token, p_worker_id, v_logo.id, v_logo.project_id, v_path, 'claimed', v_now + interval '10 minutes');
  update public.project_logos set approval_token = v_token, approval_worker_id = p_worker_id,
    approval_lease_expires_at = v_now + interval '10 minutes', updated_at = v_now
  where id = v_logo.id;
  return jsonb_build_object('status', 'claimed', 'logo_id', v_logo.id, 'worker_id', p_worker_id,
    'approval_token', v_token, 'storage_path', v_path);
end;
$function$;

drop function public.approve_project_logo_candidate(uuid, uuid, text, text, text, jsonb);
create function public.approve_project_logo_candidate(
  p_logo_id uuid,
  p_worker_id uuid,
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
  v_attempt private.project_logo_storage_attempts%rowtype;
  v_expected_path text;
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
  v_expected_path := v_logo.project_id::text || '/' || v_logo.id::text || '/' || p_approval_token::text || '.webp';
  select a.* into v_attempt from private.project_logo_storage_attempts a
  where a.approval_token = p_approval_token and a.logo_id = v_logo.id for update;
  if v_logo.verification_status = 'approved' then
    if v_logo.storage_path = p_storage_path and v_logo.content_digest = p_content_digest
      and p_storage_path = v_expected_path and v_attempt.state = 'approved'
      and v_attempt.worker_id = p_worker_id and v_attempt.storage_path = p_storage_path
      and v_attempt.content_digest = p_content_digest then
      return jsonb_build_object('status', 'already_approved', 'logo_id', v_logo.id,
        'storage_path', v_logo.storage_path, 'content_digest', v_logo.content_digest);
    end if;
    raise exception 'approved logo cannot be replaced through candidate approval' using errcode = '23514';
  end if;
  if v_logo.verification_status <> 'pending_review' then
    raise exception 'only pending logo candidates can be approved' using errcode = '23514';
  end if;
  if p_worker_id is null or v_logo.approval_worker_id is distinct from p_worker_id
    or v_attempt.worker_id is distinct from p_worker_id
    or p_approval_token is null or v_logo.approval_token is distinct from p_approval_token
    or v_logo.approval_lease_expires_at <= v_now
    or v_attempt.approval_token is null or v_attempt.state <> 'claimed'
    or v_attempt.storage_path is distinct from v_expected_path or v_attempt.lease_expires_at <= v_now then
    raise exception 'logo approval claim is missing, expired, or stale' using errcode = '40001';
  end if;
  if p_storage_path is distinct from v_expected_path
    or p_content_digest is null or p_content_digest !~ '^[a-f0-9]{64}$'
    or p_media_type is distinct from 'image/webp'
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
    approval_token = null, approval_worker_id = null, approval_lease_expires_at = null, updated_at = v_now
  where id = v_logo.id;
  update private.project_logo_storage_attempts set
    state = 'approved', content_digest = p_content_digest, media_type = p_media_type
  where approval_token = p_approval_token and logo_id = v_logo.id;
  update public.review_queue set status = 'resolved', resolved_at = v_now, updated_at = v_now
  where project_logo_id = v_logo.id and status in ('open', 'in_review');
  return jsonb_build_object('status', 'approved', 'logo_id', v_logo.id,
    'storage_path', p_storage_path, 'content_digest', p_content_digest);
end;
$function$;

create or replace function public.set_project_logo_review_status(
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
  v_cleanup_paths jsonb;
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
    approval_token = null, approval_worker_id = null, approval_lease_expires_at = null, is_primary = false, updated_at = v_now
  where id = v_logo.id;
  update private.project_logo_storage_attempts set state = 'cleanup_pending'
  where logo_id = v_logo.id;
  select coalesce(jsonb_agg(jsonb_build_object('storage_path', a.storage_path)
      order by a.created_at), '[]'::jsonb)
    into v_cleanup_paths
  from private.project_logo_storage_attempts a
  where a.logo_id = v_logo.id;
  update public.review_queue set status = 'dismissed', resolved_at = v_now, updated_at = v_now
  where project_logo_id = v_logo.id and status in ('open', 'in_review');
  return jsonb_build_object('status', p_status, 'logo_id', v_logo.id,
    'storage_path', v_storage_path, 'cleanup_paths', v_cleanup_paths);
end;
$function$;

drop function public.release_project_logo_approval(uuid, uuid);
create function public.release_project_logo_approval(p_logo_id uuid, p_approval_token uuid, p_worker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_logo public.project_logos%rowtype;
  v_attempt private.project_logo_storage_attempts%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select l.* into v_logo from public.project_logos l where l.id = p_logo_id for update;
  if not found then raise exception 'logo candidate not found' using errcode = 'P0002'; end if;
  select a.* into v_attempt from private.project_logo_storage_attempts a
  where a.approval_token = p_approval_token and a.logo_id = v_logo.id for update;
  if v_logo.verification_status = 'approved' then
    if v_logo.storage_path = v_attempt.storage_path and v_logo.content_digest = v_attempt.content_digest
      and v_attempt.state = 'approved' and v_attempt.worker_id = p_worker_id then
      return jsonb_build_object('status', 'already_approved', 'logo_id', v_logo.id,
        'storage_path', v_logo.storage_path, 'content_digest', v_logo.content_digest);
    end if;
    return jsonb_build_object('status', 'claim_not_owned', 'logo_id', v_logo.id);
  end if;
  if v_logo.verification_status <> 'pending_review' or v_logo.approval_token is distinct from p_approval_token
    or v_logo.approval_worker_id is distinct from p_worker_id or v_attempt.worker_id is distinct from p_worker_id then
    return jsonb_build_object('status', 'claim_not_owned', 'logo_id', v_logo.id);
  end if;
  update public.project_logos set approval_token = null, approval_worker_id = null,
    approval_lease_expires_at = null, updated_at = clock_timestamp()
  where id = v_logo.id;
  update private.project_logo_storage_attempts set state = 'cleanup_pending'
  where approval_token = p_approval_token and logo_id = v_logo.id and state <> 'approved';
  return jsonb_build_object('status', 'claim_released', 'logo_id', v_logo.id,
    'storage_path', v_attempt.storage_path);
end;
$function$;

drop function public.claim_project_logo_cleanup(uuid, uuid);
create function public.claim_project_logo_cleanup(p_logo_id uuid, p_approval_token uuid, p_worker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_logo public.project_logos%rowtype;
  v_attempt private.project_logo_storage_attempts%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select l.* into v_logo from public.project_logos l where l.id = p_logo_id for update;
  if not found then raise exception 'logo candidate not found' using errcode = 'P0002'; end if;
  select a.* into v_attempt from private.project_logo_storage_attempts a
  where a.approval_token = p_approval_token and a.logo_id = v_logo.id for update;
  if not found then
    return jsonb_build_object('status', 'claim_conflict', 'logo_id', v_logo.id);
  end if;
  if v_attempt.worker_id is distinct from p_worker_id then
    return jsonb_build_object('status', 'claim_conflict', 'logo_id', v_logo.id);
  end if;
  if v_logo.verification_status = 'approved' and v_logo.storage_path = v_attempt.storage_path then
    if v_logo.content_digest is not distinct from v_attempt.content_digest
      and v_attempt.state = 'approved' then
      return jsonb_build_object('status', 'already_approved', 'logo_id', v_logo.id,
        'storage_path', v_logo.storage_path, 'content_digest', v_logo.content_digest);
    end if;
    return jsonb_build_object('status', 'integrity_conflict', 'logo_id', v_logo.id,
      'storage_path', v_logo.storage_path, 'content_digest', v_logo.content_digest);
  end if;
  if exists (select 1 from public.project_logos l where l.storage_path = v_attempt.storage_path
    and l.verification_status = 'approved') then
    return jsonb_build_object('status', 'integrity_conflict', 'logo_id', v_logo.id,
      'storage_path', v_attempt.storage_path);
  end if;
  -- The attempt owns this path exclusively, so its worker may safely clean it
  -- even before the lease expires. Any late Storage write remains confined to
  -- this unreferenced attempt path and can be cleaned again during reconcile.
  update private.project_logo_storage_attempts set state = 'cleanup_pending'
  where id = v_attempt.id;
  if v_logo.approval_token = p_approval_token then
    update public.project_logos set approval_token = null, approval_worker_id = null,
      approval_lease_expires_at = null, updated_at = v_now
    where id = v_logo.id;
  end if;
  return jsonb_build_object('status', 'cleanup_claimed', 'logo_id', v_logo.id,
    'storage_path', v_attempt.storage_path, 'content_digest', v_attempt.content_digest);
end;
$function$;

create or replace function public.list_project_logo_cleanup_attempts(p_logo_id uuid)
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
  if not exists (select 1 from public.project_logos l where l.id = p_logo_id) then
    raise exception 'logo candidate not found' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'approval_token', a.approval_token, 'storage_path', a.storage_path,
      'content_digest', a.content_digest, 'state', a.state
    ) order by a.created_at), '[]'::jsonb)
  into v_result
  from private.project_logo_storage_attempts a
  where a.logo_id = p_logo_id
    and not exists (
      select 1 from public.project_logos l
      where l.verification_status = 'approved' and l.storage_path = a.storage_path
    )
    and (a.state <> 'claimed' or not exists (
      select 1 from public.project_logos l where l.id = a.logo_id
        and l.approval_token = a.approval_token and l.approval_lease_expires_at > clock_timestamp()
    ));
  return v_result;
end;
$function$;

revoke all on function public.claim_project_logo_approval(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_project_logo_approval(uuid, uuid) to service_role;
revoke all on function public.approve_project_logo_candidate(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.approve_project_logo_candidate(uuid, uuid, uuid, text, text, text, jsonb) to service_role;
revoke all on function public.release_project_logo_approval(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_project_logo_approval(uuid, uuid, uuid) to service_role;
revoke all on function public.claim_project_logo_cleanup(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_project_logo_cleanup(uuid, uuid, uuid) to service_role;
revoke all on function public.list_project_logo_cleanup_attempts(uuid) from public, anon, authenticated;
grant execute on function public.list_project_logo_cleanup_attempts(uuid) to service_role;

comment on table private.project_logo_storage_attempts is
  'Private durable ledger of immutable logo approval-attempt object paths. Cleanup only targets paths not referenced by an approved project_logos row.';
comment on column private.project_logo_storage_attempts.storage_path is
  'A legacy path or one unique to approval_token; immutable uploads use project_id/logo_id/approval_token.webp with upsert=false.';
