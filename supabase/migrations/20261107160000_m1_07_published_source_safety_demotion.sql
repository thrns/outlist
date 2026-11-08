-- M1-07 correction: a validated GitHub visibility restriction is a safety
-- transition, including when the canonical repository is currently published.

-- A safety-demoted project can be explicitly published again after current
-- evidence and human review. Preserve each human publication decision.
drop index public.editorial_decisions_one_publish_per_project_idx;

create table public.project_safety_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  repository_id uuid not null references public.repositories(id) on delete restrict,
  candidate_id uuid not null references public.repository_candidates(id) on delete restrict,
  event_type text not null check (event_type = 'published_source_access_restricted'),
  origin text not null default 'system' check (origin = 'system'),
  provider text not null default 'github' check (provider = 'github'),
  provider_repository_id text not null check (provider_repository_id ~ '^[1-9][0-9]{0,18}$'),
  source_url text not null check (source_url ~* '^https://api\.github\.com/repositories/[1-9][0-9]{0,18}$'),
  source_observed_at timestamptz not null,
  visibility_signal text not null check (visibility_signal in (
    'private_flag', 'non_public_visibility', 'contradictory_visibility'
  )),
  previous_publication_status text not null check (previous_publication_status = 'published'),
  resulting_publication_status text not null check (resulting_publication_status = 'pending_review'),
  resulting_revision bigint not null check (resulting_revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  constraint project_safety_events_revision_unique unique (project_id, repository_id, resulting_revision, event_type)
);

alter table public.project_safety_events enable row level security;
revoke all on public.project_safety_events from public, anon, authenticated, service_role;
grant select on public.project_safety_events to service_role;

create or replace function private.guard_project_safety_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'project safety events are append-only' using errcode = '42501';
end;
$function$;

revoke all on function private.guard_project_safety_events_append_only() from public, anon, authenticated, service_role;
grant execute on function private.guard_project_safety_events_append_only() to service_role;

create trigger project_safety_events_append_only
  before update or delete on public.project_safety_events
  for each row execute function private.guard_project_safety_events_append_only();

create unique index review_queue_open_source_access_restriction_repository_unique
  on public.review_queue (repository_id)
  where repository_id is not null
    and reason = 'GitHub repository access is restricted; review current public source evidence before republishing.'
    and status in ('open', 'in_review');

-- Keep the original, fully validated failure transaction as the final writer.
-- This wrapper locks the candidate first, then the project, then lets the
-- original transaction lock/update the canonical repository. Publication
-- already locks the project before making its visibility decision, so both
-- flows serialize on the same project row without weakening the repository
-- guard. Any later validation or write failure rolls back this entire call.
alter function public.fail_github_repository_enrichment(uuid, text, uuid, text, boolean, bigint, jsonb)
  set schema private;
alter function private.fail_github_repository_enrichment(uuid, text, uuid, text, boolean, bigint, jsonb)
  rename to fail_github_repository_enrichment_v1;
revoke all on function private.fail_github_repository_enrichment_v1(uuid, text, uuid, text, boolean, bigint, jsonb)
  from public, anon, authenticated, service_role;

create function public.fail_github_repository_enrichment(
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
  v_project public.projects%rowtype;
  v_project_id uuid;
  v_repository_id uuid;
  v_safety_queue_id uuid;
  v_safety_queue_status text;
  v_safety_queue_created_at timestamptz;
  v_access_restricted boolean := false;
  v_fetched_at timestamptz;
  v_revision bigint;
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
  v_safety_reason constant text := 'GitHub repository access is restricted; review current public source evidence before republishing.';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select c.* into v_candidate
  from public.repository_candidates c
  where c.id = p_candidate_id
  for update;
  if not found or v_candidate.enrichment_status <> 'processing'
    or v_candidate.enrichment_lock_owner is distinct from p_worker_id
    or v_candidate.enrichment_lease_token is distinct from p_lease_token
    or v_candidate.enrichment_lease_expires_at <= v_now then
    raise exception 'enrichment claim is stale' using errcode = '40001';
  end if;

  if p_failure_provenance is not null then
    if jsonb_typeof(p_failure_provenance) is distinct from 'object'
      or (p_failure_provenance->>'source_url') !~* '^https://api\.github\.com/[^[:space:]]+$'
      or (p_failure_provenance->>'http_status') is not null
        and (p_failure_provenance->>'http_status') !~ '^[1-5][0-9][0-9]$'
      or p_failure_provenance->>'outcome' is not null
        and p_failure_provenance->>'outcome' <> 'access_restricted' then
      raise exception 'invalid failure provenance' using errcode = '22023';
    end if;
    v_access_restricted := p_failure_provenance->>'outcome' = 'access_restricted';
    if v_access_restricted and (
      p_retryable is distinct from false
      or p_failure_provenance->>'http_status' is distinct from '200'
      or p_failure_provenance->>'error_kind' is distinct from 'visibility_restricted'
      or nullif(p_failure_provenance->>'fetched_at', '') is null
      or coalesce(p_failure_provenance->>'visibility_signal', '') not in (
        'private_flag', 'non_public_visibility', 'contradictory_visibility'
      )
      or p_failure_provenance->>'source_url' is distinct from
        ('https://api.github.com/repositories/' || v_candidate.provider_repository_id)
    ) then
      raise exception 'invalid structured access-restriction outcome' using errcode = '22023';
    end if;
    if v_access_restricted then
      begin
        v_fetched_at := (p_failure_provenance->>'fetched_at')::timestamptz;
        if v_fetched_at > v_now + interval '5 minutes' then
          raise exception 'access-restriction observation is in the future';
        end if;
      exception when others then
        raise exception 'invalid structured access-restriction outcome' using errcode = '22023';
      end;

      -- The stable provider ID is authoritative. Do not trust a candidate's
      -- cached repository UUID to select a project for demotion.
      select r.id, r.project_id into v_repository_id, v_project_id
      from public.repositories r
      where r.provider = 'github'
        and r.provider_repository_id = v_candidate.provider_repository_id;

      if found and v_project_id is not null then
        -- Take the project lock before the canonical repository is updated.
        -- This serializes against admin_publish_project and revalidates that
        -- this stable repository is still the project's primary repository.
        select p.* into v_project
        from public.projects p
        where p.id = v_project_id and p.primary_repository_id = v_repository_id
        for update;

        if found then
          if v_project.publication_status = 'published' then
            update public.projects p set
              publication_status = 'pending_review',
              editorial_revision = p.editorial_revision + 1,
              updated_at = v_now
            where p.id = v_project.id
            returning p.editorial_revision into v_revision;
            insert into public.project_safety_events (
              project_id, repository_id, candidate_id, event_type, origin,
              provider, provider_repository_id, source_url, source_observed_at,
              visibility_signal, previous_publication_status,
              resulting_publication_status, resulting_revision, created_at
            ) values (
              v_project.id, v_repository_id, v_candidate.id,
              'published_source_access_restricted', 'system', 'github',
              v_candidate.provider_repository_id, p_failure_provenance->>'source_url',
              v_fetched_at, p_failure_provenance->>'visibility_signal',
              'published', 'pending_review', v_revision, v_now
            );
          end if;

          -- A pending project can also be in a publication race. The open
          -- item makes publication fail after this transaction commits.
          if v_project.publication_status in ('published', 'pending_review') then
            select q.id, q.status, q.created_at
            into v_safety_queue_id, v_safety_queue_status, v_safety_queue_created_at
            from public.review_queue q
            where q.repository_id = v_repository_id and q.reason = v_safety_reason
            order by q.created_at, q.id
            limit 1
            for update;

            if found and v_safety_queue_status not in ('open', 'in_review') then
              update public.review_queue q set
                status = 'open', resolved_at = null,
                updated_at = greatest(v_now, v_safety_queue_created_at)
              where q.id = v_safety_queue_id;
            elsif not found then
              insert into public.review_queue (repository_id, reason, status, created_at, updated_at)
              values (v_repository_id, v_safety_reason, 'open', v_now, v_now);
            end if;
          end if;
        end if;
      end if;

      -- The legacy failure writer skips canonical mutation when editorial
      -- candidate state changed mid-claim. A validated source restriction is
      -- still authoritative for the canonical stable ID, even in that case.
      if v_repository_id is not null then
        update public.repositories r set
          availability_status = 'access_restricted', updated_at = v_now
        where r.id = v_repository_id;
      end if;
    end if;
  end if;

  -- The legacy transaction rechecks the claim and complete failure contract,
  -- persists allowlisted provenance, updates availability, and closes the
  -- candidate/job item. Any error rolls back the safety transition above.
  v_result := private.fail_github_repository_enrichment_v1(
    p_candidate_id, p_worker_id, p_lease_token, p_error_summary,
    p_retryable, p_retry_after_ms, p_failure_provenance
  );
  return v_result;
end;
$function$;

revoke all on function public.fail_github_repository_enrichment(uuid, text, uuid, text, boolean, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.fail_github_repository_enrichment(uuid, text, uuid, text, boolean, bigint, jsonb)
  to service_role;
