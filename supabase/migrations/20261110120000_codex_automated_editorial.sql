-- M2-06 adds an explicitly authorized, auditable Codex CLI editorial path.
-- It leaves the existing human-admin RPCs and attestation rules intact.

create extension if not exists pgcrypto with schema extensions;

create table private.codex_editorial_authorization (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  policy_version text not null default 'outlist-codex-editorial-v2'
    check (policy_version = 'outlist-codex-editorial-v2'),
  authorization_id uuid,
  enabled_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint codex_editorial_authorization_state check (
    (enabled and authorization_id is not null and enabled_at is not null and disabled_at is null)
    or (not enabled and disabled_at is not null)
  )
);
alter table private.codex_editorial_authorization enable row level security;
revoke all on private.codex_editorial_authorization from public, anon, authenticated, service_role;
insert into private.codex_editorial_authorization (singleton, enabled, disabled_at)
values (true, false, clock_timestamp());

create table private.codex_editorial_authorization_events (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid,
  event_type text not null check (event_type in ('enabled', 'disabled')),
  policy_version text not null check (policy_version = 'outlist-codex-editorial-v2'),
  created_at timestamptz not null default clock_timestamp()
);
alter table private.codex_editorial_authorization_events enable row level security;
revoke all on private.codex_editorial_authorization_events from public, anon, authenticated, service_role;

create function private.guard_codex_authorization_events_append_only()
returns trigger language plpgsql set search_path = '' as $function$
begin
  raise exception 'Codex authorization events are append-only' using errcode = '42501';
end;
$function$;
revoke all on function private.guard_codex_authorization_events_append_only() from public, anon, authenticated, service_role;
create trigger codex_authorization_events_append_only
before update or delete on private.codex_editorial_authorization_events
for each row execute function private.guard_codex_authorization_events_append_only();

create table private.codex_approved_license_ids (
  identifier text primary key check (identifier ~ '^[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$'),
  spdx_list_version text not null check (spdx_list_version = '3.29.0')
);
alter table private.codex_approved_license_ids enable row level security;
revoke all on private.codex_approved_license_ids from public, anon, authenticated, service_role;
insert into private.codex_approved_license_ids (identifier, spdx_list_version) values
  ('0BSD', '3.29.0'), ('AAL', '3.29.0'), ('AFL-1.1', '3.29.0'), ('AFL-1.2', '3.29.0'),
  ('AFL-2.0', '3.29.0'), ('AFL-2.1', '3.29.0'), ('AFL-3.0', '3.29.0'),
  ('AGPL-3.0-only', '3.29.0'), ('AGPL-3.0-or-later', '3.29.0'), ('ALGLIB-Documentation', '3.29.0'),
  ('Apache-1.1', '3.29.0'), ('Apache-2.0', '3.29.0'), ('APL-1.0', '3.29.0'),
  ('APSL-1.0', '3.29.0'), ('APSL-1.1', '3.29.0'), ('APSL-1.2', '3.29.0'), ('APSL-2.0', '3.29.0'),
  ('Artistic-1.0', '3.29.0'), ('Artistic-1.0-cl8', '3.29.0'), ('Artistic-1.0-Perl', '3.29.0'),
  ('Artistic-2.0', '3.29.0'), ('BlueOak-1.0.0', '3.29.0'), ('BSD-1-Clause', '3.29.0'),
  ('BSD-2-Clause', '3.29.0'), ('BSD-2-Clause-Patent', '3.29.0'), ('BSD-3-Clause', '3.29.0'),
  ('BSD-3-Clause-LBNL', '3.29.0'), ('BSD-3-Clause-Open-MPI', '3.29.0'), ('BSD-ask-to-endorse', '3.29.0'),
  ('BSL-1.0', '3.29.0'), ('CAL-1.0', '3.29.0'), ('CAL-1.0-Combined-Work-Exception', '3.29.0'),
  ('CATOSL-1.1', '3.29.0'), ('CDDL-1.0', '3.29.0'), ('CDDL-1.1', '3.29.0'), ('CECILL-2.1', '3.29.0'),
  ('CERN-OHL-P-2.0', '3.29.0'), ('CERN-OHL-S-2.0', '3.29.0'), ('CERN-OHL-W-2.0', '3.29.0'),
  ('CNRI-Python', '3.29.0'), ('CNRI-Python-GPL-Compatible', '3.29.0'), ('CPAL-1.0', '3.29.0'),
  ('CPL-1.0', '3.29.0'), ('CUA-OPL-1.0', '3.29.0'), ('curl', '3.29.0'), ('ECL-1.0', '3.29.0'),
  ('ECL-2.0', '3.29.0'), ('EFL-1.0', '3.29.0'), ('EFL-2.0', '3.29.0'), ('Entessa', '3.29.0'),
  ('EPL-1.0', '3.29.0'), ('EPL-2.0', '3.29.0'), ('EUDatagrid', '3.29.0'), ('EUPL-1.1', '3.29.0'),
  ('EUPL-1.2', '3.29.0'), ('Fair', '3.29.0'), ('Frameworx-1.0', '3.29.0'), ('GPL-2.0-only', '3.29.0'),
  ('GPL-2.0-or-later', '3.29.0'), ('GPL-3.0-only', '3.29.0'), ('GPL-3.0-or-later', '3.29.0'),
  ('HPND', '3.29.0'), ('ICU', '3.29.0'), ('Intel', '3.29.0'), ('IPA', '3.29.0'), ('IPL-1.0', '3.29.0'),
  ('ISC', '3.29.0'), ('Jam', '3.29.0'), ('LGPL-2.0-only', '3.29.0'), ('LGPL-2.0-or-later', '3.29.0'),
  ('LGPL-2.1-only', '3.29.0'), ('LGPL-2.1-or-later', '3.29.0'), ('LGPL-3.0-only', '3.29.0'),
  ('LGPL-3.0-or-later', '3.29.0'), ('LiLiQ-P-1.1', '3.29.0'), ('LiLiQ-R-1.1', '3.29.0'),
  ('LiLiQ-Rplus-1.1', '3.29.0'), ('LPL-1.0', '3.29.0'), ('LPL-1.02', '3.29.0'), ('LPPL-1.3c', '3.29.0'),
  ('MirOS', '3.29.0'), ('MIT', '3.29.0'), ('MIT-0', '3.29.0'), ('MIT-Modern-Variant', '3.29.0'),
  ('Motosoto', '3.29.0'), ('MPL-1.0', '3.29.0'), ('MPL-1.1', '3.29.0'), ('MPL-2.0', '3.29.0'),
  ('MPL-2.0-no-copyleft-exception', '3.29.0'), ('MS-PL', '3.29.0'), ('MS-RL', '3.29.0'),
  ('MulanPSL-2.0', '3.29.0'), ('Multics', '3.29.0'), ('NASA-1.3', '3.29.0'), ('Naumen', '3.29.0'),
  ('NCSA', '3.29.0'), ('NGPL', '3.29.0'), ('Nokia', '3.29.0'), ('NPOSL-3.0', '3.29.0'), ('NTP', '3.29.0'),
  ('OCLC-2.0', '3.29.0'), ('OFL-1.1', '3.29.0'), ('OFL-1.1-no-RFN', '3.29.0'), ('OFL-1.1-RFN', '3.29.0'),
  ('OGTSL', '3.29.0'), ('OLDAP-2.8', '3.29.0'), ('OLFL-1.3', '3.29.0'), ('OSC-1.0', '3.29.0'),
  ('OSET-PL-2.1', '3.29.0'), ('OSL-1.0', '3.29.0'), ('OSL-2.0', '3.29.0'), ('OSL-2.1', '3.29.0'),
  ('OSL-3.0', '3.29.0'), ('PHP-3.0', '3.29.0'), ('PHP-3.01', '3.29.0'), ('PostgreSQL', '3.29.0'),
  ('Python-2.0', '3.29.0'), ('Python-2.0.1', '3.29.0'), ('QPL-1.0', '3.29.0'), ('RPL-1.1', '3.29.0'),
  ('RPL-1.5', '3.29.0'), ('RPSL-1.0', '3.29.0'), ('RSCPL', '3.29.0'), ('SimPL-2.0', '3.29.0'),
  ('SISSL', '3.29.0'), ('Sleepycat', '3.29.0'), ('SPL-1.0', '3.29.0'), ('UCL-1.0', '3.29.0'),
  ('Unicode-3.0', '3.29.0'), ('Unicode-DFS-2016', '3.29.0'), ('Unlicense', '3.29.0'), ('UPL-1.0', '3.29.0'),
  ('VSL-1.0', '3.29.0'), ('W3C', '3.29.0'), ('W3C-20150513', '3.29.0'), ('Watcom-1.0', '3.29.0'),
  ('WordNet', '3.29.0'), ('Xnet', '3.29.0'), ('Zlib', '3.29.0'), ('ZPL-2.0', '3.29.0'), ('ZPL-2.1', '3.29.0');

create table public.codex_editorial_reviews (
  review_id text primary key check (review_id ~ '^codex_[a-f0-9]{40}$'),
  candidate_id uuid not null references public.repository_candidates(id) on delete restrict,
  provider_repository_id text not null check (provider_repository_id ~ '^[1-9][0-9]{0,18}$'),
  full_name text not null check (full_name ~ '^[^/[:space:]]+/[^/[:space:]]+$'),
  reviewer_type text not null default 'codex_automated' check (reviewer_type = 'codex_automated'),
  reviewer_identity text not null default 'codex-cli' check (reviewer_identity = 'codex-cli'),
  codex_version text not null check (length(btrim(codex_version)) between 1 and 120),
  review_policy_version text not null check (review_policy_version = 'outlist-codex-editorial-v2'),
  execution_status text not null default 'completed' check (execution_status = 'completed'),
  evidence_observed_at timestamptz not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  license_identifier text,
  license_file_url text check (license_file_url is null or private.is_safe_http_url(license_file_url)),
  license_file_sha256 text check (license_file_sha256 is null or license_file_sha256 ~ '^[a-f0-9]{64}$'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 524288),
  codex_review jsonb not null check (jsonb_typeof(codex_review) = 'object' and pg_column_size(codex_review) <= 65536),
  policy_decision jsonb not null check (jsonb_typeof(policy_decision) = 'object' and pg_column_size(policy_decision) <= 8192),
  decision text not null check (decision in ('approve', 'reject', 'investigate')),
  publication_eligible boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  constraint codex_review_decision_matches_json check (
    codex_review->>'outcome' in ('approve', 'reject', 'investigate')
    and policy_decision->>'accepted_outcome' = decision
    and (policy_decision->>'publication_eligible')::boolean = publication_eligible
  ),
  constraint codex_review_not_future check (evidence_observed_at <= created_at + interval '5 minutes')
);
create index codex_editorial_reviews_candidate_created_idx on public.codex_editorial_reviews (candidate_id, created_at desc);
create index codex_editorial_reviews_observed_idx on public.codex_editorial_reviews (evidence_observed_at desc);
alter table public.codex_editorial_reviews enable row level security;
revoke all on public.codex_editorial_reviews from public, anon, authenticated, service_role;
grant select on public.codex_editorial_reviews to service_role;

create function private.guard_codex_editorial_reviews_append_only()
returns trigger language plpgsql set search_path = '' as $function$
begin
  raise exception 'Codex editorial reviews are append-only' using errcode = '42501';
end;
$function$;
revoke all on function private.guard_codex_editorial_reviews_append_only() from public, anon, authenticated, service_role;
create trigger codex_editorial_reviews_append_only
before update or delete on public.codex_editorial_reviews
for each row execute function private.guard_codex_editorial_reviews_append_only();

create table public.codex_review_applications (
  id uuid primary key default gen_random_uuid(),
  review_id text not null references public.codex_editorial_reviews(review_id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  resulting_state text not null check (resulting_state in ('pending_review', 'rejected')),
  resulting_revision bigint not null check (resulting_revision > 0),
  applied_at timestamptz not null default clock_timestamp(),
  unique (review_id, project_id)
);
alter table public.codex_review_applications enable row level security;
revoke all on public.codex_review_applications from public, anon, authenticated, service_role;
grant select on public.codex_review_applications to service_role;

create function private.guard_codex_review_applications_append_only()
returns trigger language plpgsql set search_path = '' as $function$
begin
  raise exception 'Codex review applications are append-only' using errcode = '42501';
end;
$function$;
revoke all on function private.guard_codex_review_applications_append_only() from public, anon, authenticated, service_role;
create trigger codex_review_applications_append_only
before update or delete on public.codex_review_applications
for each row execute function private.guard_codex_review_applications_append_only();

alter table public.editorial_decisions alter column actor_user_id drop not null;
alter table public.editorial_decisions add column reviewer_type text not null default 'human_admin'
  check (reviewer_type in ('human_admin', 'codex_automated', 'system_policy'));
alter table public.editorial_decisions drop constraint editorial_decisions_action_check;
alter table public.editorial_decisions add constraint editorial_decisions_action_check check (action in (
  'save_editorial', 'verify_license', 'verify_quality', 'keep_pending', 'mark_review_required', 'reject',
  'return_to_review', 'resolve_review_item', 'publish',
  'codex_automated_review', 'codex_verify_license', 'codex_verify_quality', 'codex_publish',
  'codex_revoke_publication', 'system_revoke_publication'
));
alter table public.editorial_decisions add constraint editorial_decisions_reviewer_identity_check check (
  (reviewer_type = 'human_admin' and actor_user_id is not null
    and action in ('save_editorial', 'verify_license', 'verify_quality', 'keep_pending', 'mark_review_required', 'reject', 'return_to_review', 'resolve_review_item', 'publish'))
  or (reviewer_type = 'codex_automated' and actor_user_id is null
    and action in ('codex_automated_review', 'codex_verify_license', 'codex_verify_quality', 'codex_publish', 'codex_revoke_publication'))
  or (reviewer_type = 'system_policy' and actor_user_id is null and action = 'system_revoke_publication')
);
revoke insert, update, delete on public.editorial_decisions from public, anon, authenticated, service_role;
grant select on public.editorial_decisions to service_role;

alter table public.editorial_overrides alter column approved_by drop not null;
alter table public.editorial_overrides alter column approved_at drop not null;
alter table public.editorial_overrides add column reviewer_type text not null default 'human_admin'
  check (reviewer_type in ('human_admin', 'codex_automated', 'system_policy'));
alter table public.editorial_overrides add column codex_review_id text
  references public.codex_editorial_reviews(review_id) on delete restrict;
alter table public.editorial_overrides add constraint editorial_overrides_reviewer_identity_check check (
  (reviewer_type = 'human_admin' and approved_by is not null and approved_at is not null and codex_review_id is null)
  or (reviewer_type = 'codex_automated' and approved_by is null and approved_at is null and codex_review_id is not null)
  or (reviewer_type = 'system_policy' and approved_by is null and approved_at is null and codex_review_id is null)
);
revoke all on public.editorial_overrides from public, anon, authenticated, service_role;
grant select on public.editorial_overrides to service_role;

create table public.project_publication_revocations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  repository_id uuid not null references public.repositories(id) on delete restrict,
  review_id text references public.codex_editorial_reviews(review_id) on delete restrict,
  source_observed_at timestamptz,
  reason text not null check (length(btrim(reason)) between 8 and 1000),
  origin text not null check (origin in ('codex_automated', 'system_policy')),
  resulting_revision bigint not null check (resulting_revision > 0),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.project_publication_revocations enable row level security;
revoke all on public.project_publication_revocations from public, anon, authenticated, service_role;
grant select on public.project_publication_revocations to service_role;

create function private.guard_project_publication_revocations_append_only()
returns trigger language plpgsql set search_path = '' as $function$
begin
  raise exception 'project publication revocations are append-only' using errcode = '42501';
end;
$function$;
revoke all on function private.guard_project_publication_revocations_append_only() from public, anon, authenticated, service_role;
create trigger project_publication_revocations_append_only
before update or delete on public.project_publication_revocations
for each row execute function private.guard_project_publication_revocations_append_only();

create function public.authorize_codex_editorial_policy(p_enabled boolean, p_policy_version text, p_confirmation text)
returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_id uuid := case when p_enabled then gen_random_uuid() else null end;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_policy_version is distinct from 'outlist-codex-editorial-v2'
    or p_confirmation is distinct from (case when p_enabled then 'ENABLE OUTLIST CODEX EDITORIAL V2' else 'DISABLE OUTLIST CODEX EDITORIAL V2' end) then
    raise exception 'explicit policy authorization confirmation is required' using errcode = '42501';
  end if;
  update private.codex_editorial_authorization set
    enabled = p_enabled,
    authorization_id = case when p_enabled then v_id else authorization_id end,
    enabled_at = case when p_enabled then v_now else enabled_at end,
    disabled_at = case when p_enabled then null else v_now end,
    updated_at = v_now
  where singleton
  returning authorization_id into v_id;
  insert into private.codex_editorial_authorization_events (authorization_id, event_type, policy_version, created_at)
  values (v_id, case when p_enabled then 'enabled' else 'disabled' end, p_policy_version, v_now);
  return jsonb_build_object('enabled', p_enabled, 'authorization_id', v_id, 'policy_version', p_policy_version, 'changed_at', v_now);
end;
$function$;
revoke all on function public.authorize_codex_editorial_policy(boolean, text, text) from public, anon, authenticated;
grant execute on function public.authorize_codex_editorial_policy(boolean, text, text) to service_role;

create function public.codex_editorial_policy_status()
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_policy private.codex_editorial_authorization%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select * into v_policy from private.codex_editorial_authorization where singleton;
  return jsonb_build_object('enabled', v_policy.enabled, 'authorization_id', v_policy.authorization_id,
    'policy_version', v_policy.policy_version, 'enabled_at', v_policy.enabled_at, 'disabled_at', v_policy.disabled_at);
end;
$function$;
revoke all on function public.codex_editorial_policy_status() from public, anon, authenticated;
grant execute on function public.codex_editorial_policy_status() to service_role;

create function private.assert_codex_editorial_authorized(p_authorization_id uuid)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_authorization_id is null or not exists (
    select 1 from private.codex_editorial_authorization a
    where a.singleton and a.enabled and a.policy_version = 'outlist-codex-editorial-v2'
      and a.authorization_id = p_authorization_id
  ) then raise exception 'Codex editorial policy is not explicitly enabled for this authorization ID' using errcode = '42501'; end if;
end;
$function$;
revoke all on function private.assert_codex_editorial_authorized(uuid) from public, anon, authenticated, service_role;

create function public.codex_record_editorial_review(
  p_authorization_id uuid,
  p_review_id text,
  p_candidate_id uuid,
  p_provider_repository_id text,
  p_full_name text,
  p_codex_version text,
  p_evidence_observed_at timestamptz,
  p_evidence_sha256 text,
  p_license_identifier text,
  p_license_file_url text,
  p_license_file_sha256 text,
  p_evidence jsonb,
  p_codex_review jsonb,
  p_policy_decision jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_candidate public.repository_candidates%rowtype;
  v_repository public.repositories%rowtype;
  v_existing public.codex_editorial_reviews%rowtype;
  v_license_source jsonb;
  v_source jsonb;
  v_now timestamptz := clock_timestamp();
  v_decision text;
  v_publication_eligible boolean;
begin
  perform private.assert_codex_editorial_authorized(p_authorization_id);
  if p_review_id is null or p_review_id !~ '^codex_[a-f0-9]{40}$' or p_candidate_id is null
    or p_provider_repository_id !~ '^[1-9][0-9]{0,18}$'
    or p_full_name !~ '^[^/[:space:]]+/[^/[:space:]]+$'
    or length(btrim(p_codex_version)) not between 1 and 120
    or p_evidence_observed_at is null or p_evidence_observed_at > v_now + interval '5 minutes'
    or p_evidence_observed_at < v_now - interval '7 days'
    or p_evidence_sha256 !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_evidence) is distinct from 'object' or pg_column_size(p_evidence) > 524288
    or jsonb_typeof(p_codex_review) is distinct from 'object' or pg_column_size(p_codex_review) > 65536
    or jsonb_typeof(p_policy_decision) is distinct from 'object' or pg_column_size(p_policy_decision) > 8192
    or jsonb_typeof(p_policy_decision->'publication_eligible') is distinct from 'boolean'
    or p_evidence->>'schema' is distinct from 'outlist.catalog.codex-evidence.v1'
    or p_evidence->>'candidate_id' is distinct from p_candidate_id::text
    or p_evidence->>'repository_id' is distinct from p_provider_repository_id
    or lower(p_evidence->>'full_name') is distinct from lower(p_full_name)
    or (p_evidence->>'collected_at')::timestamptz is distinct from p_evidence_observed_at
    or jsonb_typeof(p_codex_review->'reviewer') is distinct from 'object'
    or p_codex_review->'reviewer'->>'identity' is distinct from 'codex-cli'
    or p_codex_review->'reviewer'->>'policy_version' is distinct from 'outlist-codex-editorial-v2'
    or jsonb_typeof(p_codex_review->'eligibility') is distinct from 'object'
    or jsonb_typeof(p_codex_review->'listing') is distinct from 'object'
    or jsonb_typeof(p_codex_review->'supporting_sources') is distinct from 'array'
    or jsonb_typeof(p_codex_review->'uncertainties') is distinct from 'array'
    or jsonb_typeof(p_codex_review->'material_blockers') is distinct from 'array'
    or jsonb_typeof(p_codex_review->'informational_uncertainties') is distinct from 'array'
    or jsonb_typeof(p_codex_review->'confidence') is distinct from 'number'
    or jsonb_typeof(p_codex_review->'eligibility'->'genuine_software_product') is distinct from 'boolean'
    or jsonb_typeof(p_codex_review->'eligibility'->'publicly_accessible') is distinct from 'boolean'
    or jsonb_typeof(p_codex_review->'eligibility'->'meaningfully_open_source') is distinct from 'boolean'
    or jsonb_typeof(p_codex_review->'eligibility'->'security_or_trust_concerns') is distinct from 'array'
    or jsonb_typeof(p_policy_decision->'reasons') is distinct from 'array'
    or p_policy_decision->>'accepted_outcome' is null
    or p_policy_decision->>'accepted_outcome' not in ('approve', 'reject', 'investigate')
    or p_codex_review->>'outcome' is null
    or p_codex_review->>'outcome' not in ('approve', 'reject', 'investigate')
    or (p_policy_decision->>'accepted_outcome' is distinct from p_codex_review->>'outcome'
      and p_policy_decision->>'accepted_outcome' is distinct from 'investigate')
    or p_policy_decision->>'publication_eligible' is distinct from (p_policy_decision->>'accepted_outcome' = 'approve')::text
    or (p_policy_decision->>'publication_eligible')::boolean is distinct from true
      and p_policy_decision->>'accepted_outcome' = 'approve' then
    raise exception 'invalid or stale Codex review record' using errcode = '22023';
  end if;
  v_decision := p_policy_decision->>'accepted_outcome';
  v_publication_eligible := coalesce((p_policy_decision->>'publication_eligible')::boolean, false);
  if v_decision = 'approve' and v_publication_eligible and (
    p_license_identifier is null
    or p_codex_review->'eligibility'->>'meaningfully_open_source' is distinct from 'true'
    or not exists (select 1 from private.codex_approved_license_ids l where l.identifier = p_license_identifier and l.spdx_list_version = '3.29.0')
  ) then
    raise exception 'approved Codex result does not satisfy the independent license policy' using errcode = '23514';
  end if;
  if v_decision = 'approve' and (
    p_codex_review->'material_blockers' <> '[]'::jsonb
    or p_codex_review->'eligibility'->'security_or_trust_concerns' <> '[]'::jsonb
    or not exists (
      select 1 from jsonb_array_elements(coalesce(p_evidence->'sources', '[]'::jsonb)) source
      where source->>'kind' = 'repository_metadata' and source->>'status' = 'available'
        and source->'metadata'->>'id' = p_provider_repository_id
        and lower(source->'metadata'->>'full_name') = lower(p_full_name)
        and source->'metadata'->>'visibility' = 'public'
        and source->'metadata'->>'private' = 'false'
        and source->'metadata'->>'disabled' = 'false'
        and source->'metadata'->>'archived' = 'false'
        and exists (select 1 from jsonb_array_elements(coalesce(p_codex_review->'supporting_sources', '[]'::jsonb)) citation
          where citation->>'evidence_id' = source->>'id' and citation->>'source_url' = source->>'url')
    )
    or not exists (
      select 1 from jsonb_array_elements(coalesce(p_evidence->'sources', '[]'::jsonb)) source
      where source->>'kind' = 'readme' and source->>'status' = 'available'
        and (source->'metadata'->>'complete_file' = 'true'
          or (source->'metadata'->>'relevant_sections_complete' = 'true'
            and source->'metadata'->'relevance_coverage'->>'product_identity' = 'true'
            and source->'metadata'->'relevance_coverage'->>'capabilities' = 'true'
            and source->'metadata'->'relevance_coverage'->>'usage' = 'true'))
        and exists (select 1 from jsonb_array_elements(coalesce(p_codex_review->'supporting_sources', '[]'::jsonb)) citation
          where citation->>'evidence_id' = source->>'id' and citation->>'source_url' = source->>'url')
    )
    or not exists (
      select 1 from jsonb_array_elements(coalesce(p_evidence->'sources', '[]'::jsonb)) source
      where ((source->>'kind' = 'manifest' and source->>'status' = 'available'
          and (source->'metadata'->>'complete_file' = 'true' or source->'metadata'->>'relevant_sections_complete' = 'true'))
        or (source->>'kind' = 'root_contents' and source->>'status' = 'available'
          and source->'metadata'->>'source_tree_complete' = 'true'
          and (source->'metadata'->'software_signals'->>'source_code' = 'true'
            or source->'metadata'->'software_signals'->>'test_or_build_files' = 'true')))
        and exists (select 1 from jsonb_array_elements(coalesce(p_codex_review->'supporting_sources', '[]'::jsonb)) citation
          where citation->>'evidence_id' = source->>'id' and citation->>'source_url' = source->>'url')
    )
    or not exists (
      select 1 from jsonb_array_elements(coalesce(p_evidence->'sources', '[]'::jsonb)) source
      where source->>'kind' = 'license' and source->>'status' = 'available'
        and source->'metadata'->>'complete_file' = 'true'
        and source->'metadata'->>'truncated' = 'false'
        and source->'metadata'->>'content_sha256' = source->>'sha256'
        and source->>'sha256' ~ '^[a-f0-9]{64}$'
        and source->'metadata'->'duplicate_check'->>'snapshot_data_sha256' ~ '^[a-f0-9]{64}$'
        and p_codex_review->'eligibility'->>'license_identifier' = p_license_identifier
        and exists (select 1 from jsonb_array_elements(coalesce(p_codex_review->'supporting_sources', '[]'::jsonb)) citation
          where citation->>'evidence_id' = source->>'id' and citation->>'source_url' = source->>'url')
    )
    or exists (
      select 1 from jsonb_array_elements(coalesce(p_evidence->'sources', '[]'::jsonb)) source
      where source->>'kind' = 'license' and source->>'status' = 'available'
        and (source->'metadata'->>'complete_file' is distinct from 'true'
          or source->'metadata'->>'truncated' is distinct from 'false'
          or source->'metadata'->>'content_sha256' is distinct from source->>'sha256'
          or not exists (select 1 from jsonb_array_elements(coalesce(p_codex_review->'supporting_sources', '[]'::jsonb)) citation
            where citation->>'evidence_id' = source->>'id' and citation->>'source_url' = source->>'url'))
    )
    or not exists (
      select 1 from jsonb_array_elements(coalesce(p_evidence->'sources', '[]'::jsonb)) source
      where source->>'kind' = 'outlist_catalog' and source->>'status' = 'available'
        and source->>'sha256' ~ '^[a-f0-9]{64}$'
        and source->'metadata'->'duplicate_check'->>'snapshot_sha256' = source->>'sha256'
        and (source->>'url') = ('urn:outlist:catalog-snapshot:' || (source->>'sha256'))
        and source->'metadata'->'duplicate_check'->>'candidate_id' = p_candidate_id::text
        and source->'metadata'->'duplicate_check'->>'candidate_repository_id' = p_provider_repository_id
        and lower(source->'metadata'->'duplicate_check'->>'candidate_full_name') = lower(p_full_name)
        and source->'metadata'->'duplicate_check'->>'snapshot_complete' = 'true'
        and source->'metadata'->'duplicate_check'->>'snapshot_fresh' = 'true'
        and case
          when coalesce(source->'metadata'->'duplicate_check'->>'snapshot_captured_at', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(Z|[+-][0-9]{2}:[0-9]{2})$'
          then (source->'metadata'->'duplicate_check'->>'snapshot_captured_at')::timestamptz between v_now - interval '24 hours' and v_now + interval '5 minutes'
          else false
        end
        and source->'metadata'->'duplicate_check'->>'candidate_identity_verified' = 'true'
        and source->'metadata'->'duplicate_check'->>'has_material_duplicate_conflict' = 'false'
        and source->'metadata'->'duplicate_check'->'duplicate_imported_candidates' = '[]'::jsonb
        and source->'metadata'->'duplicate_check'->'candidate_canonical_identity_conflicts' = '[]'::jsonb
        and source->'metadata'->'duplicate_check'->'canonical_identity_conflicts' = '[]'::jsonb
        and source->'metadata'->'duplicate_check'->'duplicate_public_product_listings' = '[]'::jsonb
        and exists (select 1 from jsonb_array_elements(coalesce(p_codex_review->'supporting_sources', '[]'::jsonb)) citation
          where citation->>'evidence_id' = source->>'id' and citation->>'source_url' = source->>'url')
    )
  ) then
    raise exception 'approved Codex result lacks complete, conflict-free evidence' using errcode = '23514';
  end if;

  select c.* into v_candidate from public.repository_candidates c where c.id = p_candidate_id for share;
  if not found or v_candidate.provider <> 'github'
    or v_candidate.provider_repository_id is distinct from p_provider_repository_id
    or lower(v_candidate.full_name) is distinct from lower(p_full_name)
    or v_candidate.review_status = 'rejected' or v_candidate.queue_status = 'discarded' then
    raise exception 'Codex review does not match a current eligible candidate' using errcode = '23514';
  end if;
  if v_candidate.repository_id is not null then
    select r.* into v_repository from public.repositories r where r.id = v_candidate.repository_id for share;
    if not found or v_repository.provider_repository_id is distinct from p_provider_repository_id
      or lower(v_repository.full_name) is distinct from lower(p_full_name) then
      raise exception 'candidate repository identity does not match current repository data' using errcode = '23514';
    end if;
  end if;

  v_license_source := null;
  for v_source in select item from jsonb_array_elements(coalesce(p_evidence->'sources', '[]'::jsonb)) item loop
    if v_source->>'kind' = 'license' and v_source->>'status' = 'available' then v_license_source := v_source; end if;
    if v_source->>'kind' = 'repository_metadata' and v_source->>'status' = 'available'
      and (v_source->'metadata'->>'id') is distinct from p_provider_repository_id then
      raise exception 'repository metadata evidence has a mismatched stable identity' using errcode = '23514';
    end if;
  end loop;
  if p_license_identifier is not null then
    if v_license_source is null or p_license_file_url is distinct from v_license_source->>'url'
      or p_license_file_sha256 is distinct from v_license_source->>'sha256'
      or p_license_file_sha256 !~ '^[a-f0-9]{64}$'
      or p_codex_review->'eligibility'->>'license_identifier' is distinct from p_license_identifier then
      raise exception 'Codex license decision lacks complete, matching license-file evidence' using errcode = '23514';
    end if;
  elsif p_license_file_url is not null or p_license_file_sha256 is not null then
    raise exception 'license file metadata cannot be attached without a reviewed license identifier' using errcode = '22023';
  end if;
  for v_source in select item from jsonb_array_elements(coalesce(p_codex_review->'supporting_sources', '[]'::jsonb)) item loop
    if not exists (select 1 from jsonb_array_elements(coalesce(p_evidence->'sources', '[]'::jsonb)) e
      where e->>'id' = v_source->>'evidence_id' and e->>'url' = v_source->>'source_url' and e->>'status' = 'available') then
      raise exception 'Codex review cites a source outside its evidence package' using errcode = '23514';
    end if;
  end loop;

  select r.* into v_existing from public.codex_editorial_reviews r where r.review_id = p_review_id;
  if found then
    if v_existing.candidate_id = p_candidate_id and v_existing.evidence_sha256 = p_evidence_sha256
      and v_existing.review_policy_version = 'outlist-codex-editorial-v2'
      and v_existing.codex_review = p_codex_review and v_existing.policy_decision = p_policy_decision then
      return jsonb_build_object('review_id', p_review_id, 'decision', v_existing.decision, 'idempotent', true);
    end if;
    raise exception 'review ID already exists for different evidence or policy' using errcode = '23505';
  end if;

  insert into public.codex_editorial_reviews (
    review_id, candidate_id, provider_repository_id, full_name, codex_version, review_policy_version,
    evidence_observed_at, evidence_sha256, license_identifier, license_file_url,
    license_file_sha256, evidence, codex_review, policy_decision, decision,
    publication_eligible, created_at
  ) values (
    p_review_id, p_candidate_id, p_provider_repository_id, p_full_name, p_codex_version, 'outlist-codex-editorial-v2',
    p_evidence_observed_at, p_evidence_sha256, p_license_identifier, p_license_file_url,
    p_license_file_sha256, p_evidence, p_codex_review, p_policy_decision, v_decision,
    v_publication_eligible, v_now
  );
  return jsonb_build_object('review_id', p_review_id, 'decision', v_decision, 'idempotent', false);
end;
$function$;
revoke all on function public.codex_record_editorial_review(uuid, text, uuid, text, text, text, timestamptz, text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.codex_record_editorial_review(uuid, text, uuid, text, text, text, timestamptz, text, text, text, text, jsonb, jsonb, jsonb) to service_role;

create function public.codex_apply_editorial_review(
  p_authorization_id uuid,
  p_project_id uuid,
  p_review_id text,
  p_expected_revision bigint
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_review public.codex_editorial_reviews%rowtype;
  v_project public.projects%rowtype;
  v_candidate public.repository_candidates%rowtype;
  v_repository public.repositories%rowtype;
  v_source jsonb;
  v_license_source jsonb;
  v_readme_source jsonb;
  v_manifest_source jsonb;
  v_repository_source jsonb;
  v_listing jsonb;
  v_source_result jsonb;
  v_observed_at timestamptz;
  v_assessment_id uuid;
  v_repository_id uuid;
  v_revision bigint;
  v_now timestamptz := clock_timestamp();
  v_reason text;
  v_next_status text;
  v_category_ids uuid[];
  v_category_slugs text[];
  v_tags text[];
  v_tag text;
  v_slug text;
  v_slugs text[] := array[]::text[];
  v_website text;
  v_approved boolean := false;
begin
  perform private.assert_codex_editorial_authorized(p_authorization_id);
  if p_project_id is null or p_expected_revision is null or p_review_id is null then
    raise exception 'project, review, and expected revision are required' using errcode = '22023';
  end if;
  select p.* into v_project from public.projects p where p.id = p_project_id for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.editorial_revision <> p_expected_revision then raise exception 'stale editorial revision' using errcode = '40001'; end if;
  if v_project.publication_status not in ('draft', 'pending_review') then
    raise exception 'automated review requires an unpublished project in review' using errcode = '55000';
  end if;

  select r.* into v_review from public.codex_editorial_reviews r where r.review_id = p_review_id for share;
  if not found or v_review.execution_status <> 'completed' or v_review.review_policy_version <> 'outlist-codex-editorial-v2'
    or v_review.evidence_observed_at < v_now - interval '7 days'
    or v_review.decision not in ('approve', 'reject', 'investigate') then
    raise exception 'completed current Codex review is required' using errcode = '23514';
  end if;
  select c.* into v_candidate from public.repository_candidates c where c.id = v_review.candidate_id for share;
  select r.* into v_repository from public.repositories r
  where r.id = v_project.primary_repository_id and r.project_id = v_project.id for share;
  if not found or v_candidate.id is null or v_candidate.repository_id is distinct from v_repository.id
    or v_candidate.provider_repository_id is distinct from v_review.provider_repository_id
    or lower(v_candidate.full_name) is distinct from lower(v_review.full_name)
    or v_repository.provider <> 'github' or v_repository.provider_repository_id is distinct from v_review.provider_repository_id
    or lower(v_repository.full_name) is distinct from lower(v_review.full_name) then
    raise exception 'Codex review candidate is not the project''s current primary repository' using errcode = '23514';
  end if;

  select e.repository_id, e.source_observed_at, e.assessment_id, e.assessment_result
    into v_repository_id, v_observed_at, v_assessment_id, v_source_result
  from private.assert_current_project_evidence(p_project_id) e;
  if v_repository_id is distinct from v_repository.id then
    raise exception 'current project evidence resolves to a different repository' using errcode = '23514';
  end if;
  if v_observed_at is null or v_observed_at < v_now - interval '7 days'
    or v_review.evidence_observed_at < v_now - interval '7 days' then
    raise exception 'current production evidence is stale relative to the Codex review' using errcode = '23514';
  end if;

  v_listing := v_review.codex_review->'listing';
  if jsonb_typeof(v_listing) is distinct from 'object'
    or length(btrim(v_listing->>'name')) not between 1 and 120
    or length(btrim(v_listing->>'summary')) not between 10 and 280
    or length(v_listing->>'description') > 10000
    or jsonb_typeof(v_listing->'categories') is distinct from 'array'
    or jsonb_array_length(v_listing->'categories') not between 1 and 8
    or jsonb_typeof(v_listing->'tags') is distinct from 'array'
    or jsonb_array_length(v_listing->'tags') > 20 then
    raise exception 'Codex listing fields do not meet catalog constraints' using errcode = '22023';
  end if;
  v_website := nullif(btrim(v_listing->>'official_website_url'), '');
  if v_listing->'official_website_url' <> 'null'::jsonb and v_website is not null
    and not private.is_safe_http_url(v_website) then
    raise exception 'Codex listing contains an unsafe website URL' using errcode = '22023';
  end if;

  select array_agg(category.slug order by requested.ordinality), array_agg(category.id order by requested.ordinality)
  into v_category_slugs, v_category_ids
  from jsonb_array_elements_text(v_listing->'categories') with ordinality requested(slug, ordinality)
  join public.categories category on category.slug = requested.slug and category.is_active;
  if coalesce(cardinality(v_category_ids), 0) <> jsonb_array_length(v_listing->'categories')
    or cardinality(v_category_ids) <> (select count(distinct value) from unnest(v_category_ids) value) then
    raise exception 'Codex listing categories must be unique and active' using errcode = '22023';
  end if;

  select array_agg(value) into v_tags from jsonb_array_elements_text(v_listing->'tags') item(value);
  foreach v_tag in array coalesce(v_tags, array[]::text[]) loop
    if length(btrim(v_tag)) not between 2 and 40 or v_tag !~ '^[A-Za-z0-9][A-Za-z0-9 -]*$' then
      raise exception 'Codex tags contain invalid text' using errcode = '22023';
    end if;
    v_slug := trim(both '-' from regexp_replace(lower(btrim(v_tag)), '[^a-z0-9]+', '-', 'g'));
    if v_slug = '' or v_slug = any(v_slugs) then raise exception 'Codex tags must be unique after normalization' using errcode = '22023'; end if;
    v_slugs := array_append(v_slugs, v_slug);
  end loop;

  for v_source in select item from jsonb_array_elements(v_review.evidence->'sources') item loop
    if v_source->>'kind' = 'license' and v_source->>'status' = 'available' then v_license_source := v_source; end if;
    if v_source->>'kind' = 'readme' and v_source->>'status' = 'available' then v_readme_source := v_source; end if;
    if v_source->>'kind' = 'manifest' and v_source->>'status' = 'available' then v_manifest_source := v_source; end if;
    if v_source->>'kind' = 'repository_metadata' and v_source->>'status' = 'available' then v_repository_source := v_source; end if;
  end loop;

  v_approved := v_review.decision = 'approve' and v_review.publication_eligible;
  if v_review.decision = 'approve' and not v_approved then
    raise exception 'policy did not authorize the model approval; investigate instead' using errcode = '23514';
  end if;
  if v_approved then
    if v_review.codex_review->>'confidence' is null or (v_review.codex_review->>'confidence')::numeric < 0.92
      or v_review.codex_review->'eligibility'->>'license_confidence' is null
      or (v_review.codex_review->'eligibility'->>'license_confidence')::numeric < 0.95
      or v_review.codex_review->'eligibility'->>'genuine_software_product' is distinct from 'true'
      or v_review.codex_review->'eligibility'->>'publicly_accessible' is distinct from 'true'
      or v_review.codex_review->'eligibility'->>'meaningfully_open_source' is distinct from 'true'
      or coalesce(v_review.codex_review->'eligibility'->>'product_status', '') not in ('functional', 'likely_functional')
      or coalesce(v_review.codex_review->'eligibility'->>'documentation_status', '') not in ('sufficient', 'limited')
      or coalesce(v_review.codex_review->'eligibility'->>'maintenance_status', '') not in ('active', 'maintained')
      or v_review.codex_review->'eligibility'->>'duplicate_status' is distinct from 'distinct'
      or v_review.evidence->>'collector_status' is distinct from 'complete'
      or jsonb_typeof(v_review.codex_review->'uncertainties') is distinct from 'array'
      or jsonb_array_length(v_review.codex_review->'uncertainties') <> 0
      or jsonb_typeof(v_review.codex_review->'eligibility'->'security_or_trust_concerns') is distinct from 'array'
      or jsonb_array_length(v_review.codex_review->'eligibility'->'security_or_trust_concerns') <> 0
      or v_readme_source is null or v_manifest_source is null or v_license_source is null
      or v_readme_source->'metadata'->>'truncated' = 'true'
      or v_license_source->'metadata'->>'truncated' = 'true'
      or v_license_source->>'text' is null
      or v_review.license_identifier is null
      or v_review.license_identifier is distinct from v_review.codex_review->'eligibility'->>'license_identifier'
      or v_review.license_identifier is distinct from v_repository.source_license_metadata->>'spdx_id'
      or v_review.license_file_sha256 is distinct from v_license_source->>'sha256'
      or v_repository_source is null
      or v_repository_source->'metadata'->>'private' is distinct from 'false'
      or v_repository_source->'metadata'->>'disabled' is distinct from 'false'
      or lower(v_repository_source->'metadata'->>'visibility') is distinct from 'public'
      or v_repository_source->'metadata'->>'archived' is distinct from 'false'
      or v_manifest_source->'metadata'->>'truncated' = 'true'
      or v_repository_source->'metadata'->>'full_name' is distinct from v_review.full_name
      or encode(extensions.digest(convert_to(v_license_source->>'text', 'UTF8'), 'sha256'), 'hex') is distinct from v_review.license_file_sha256
      or encode(extensions.digest(convert_to(v_readme_source->>'text', 'UTF8'), 'sha256'), 'hex') is distinct from v_readme_source->>'sha256'
      or encode(extensions.digest(convert_to(v_manifest_source->>'text', 'UTF8'), 'sha256'), 'hex') is distinct from v_manifest_source->>'sha256'
      or not exists (select 1 from private.codex_approved_license_ids l where l.identifier = v_review.license_identifier and l.spdx_list_version = '3.29.0') then
      raise exception 'automated quality or license evidence did not satisfy publication policy' using errcode = '23514';
    end if;
    if v_website is not null and v_repository_source->'metadata'->>'homepage' is distinct from v_website
      and not exists (
        select 1 from jsonb_array_elements(v_review.evidence->'sources') s
        where s->>'kind' = 'readme' and s->>'status' = 'available'
          and lower(s->>'text') like '%' || lower(regexp_replace(v_website, '^https?://([^/?#]+).*$','\1')) || '%'
      ) then
      raise exception 'official website is not corroborated by current source evidence' using errcode = '23514';
    end if;
    if not exists (
      select 1 from jsonb_array_elements(v_review.codex_review->'supporting_sources') cite
      where cite->>'evidence_id' = v_readme_source->>'id'
    ) or not exists (
      select 1 from jsonb_array_elements(v_review.codex_review->'supporting_sources') cite
      where cite->>'evidence_id' = v_license_source->>'id'
    ) or not exists (
      select 1 from jsonb_array_elements(v_review.codex_review->'supporting_sources') cite
      where cite->>'evidence_id' = (select source->>'id' from jsonb_array_elements(v_review.evidence->'sources') source where source->>'kind' = 'repository_metadata' and source->>'status' = 'available' limit 1)
    ) then
      raise exception 'automated approval citations are incomplete' using errcode = '23514';
    end if;
  end if;
  if v_review.decision is distinct from v_review.codex_review->>'outcome'
    and v_review.decision is distinct from 'investigate' then
    raise exception 'deterministic policy cannot upgrade or reverse the Codex outcome' using errcode = '23514';
  end if;
  if v_review.decision = 'reject' and (
    (v_review.codex_review->>'confidence')::numeric < 0.9
    or jsonb_array_length(v_review.codex_review->'uncertainties') <> 0
    or jsonb_array_length(v_review.codex_review->'supporting_sources') < 2
    or not (
      v_review.codex_review->'eligibility'->>'genuine_software_product' = 'false'
      or v_review.codex_review->'eligibility'->>'publicly_accessible' = 'false'
      or v_review.codex_review->'eligibility'->>'meaningfully_open_source' = 'false'
      or v_review.codex_review->'eligibility'->>'product_status' = 'not_functional'
      or v_review.codex_review->'eligibility'->>'duplicate_status' in ('mirror', 'duplicate', 'unsuitable_fork')
    )
  ) then
    raise exception 'rejection lacks a high-confidence, source-supported disqualifier' using errcode = '23514';
  end if;
  if v_review.decision = 'reject' and not exists (
    select 1 from jsonb_array_elements(v_review.codex_review->'supporting_sources') cite
    join jsonb_array_elements(v_review.evidence->'sources') source
      on source->>'id' = cite->>'evidence_id' and source->>'url' = cite->>'source_url'
    where source->>'kind' in ('readme', 'repository_metadata', 'license')
  ) then
    raise exception 'rejection does not cite inspected repository evidence' using errcode = '23514';
  end if;

  v_next_status := case when v_review.decision = 'reject' then 'rejected' else 'pending_review' end;
  v_reason := left(coalesce(v_review.codex_review->>'rationale', 'Codex automated editorial review.'), 1000);
  update public.projects set
    name = btrim(v_listing->>'name'),
    summary = btrim(v_listing->>'summary'),
    description = v_listing->>'description',
    official_website_url = v_website,
    publication_status = v_next_status,
    quality_status = case when v_approved then 'verified' when v_review.decision = 'reject' then 'rejected' else 'needs_review' end,
    license_status = case when v_approved then 'verified_open_source' else 'needs_review' end,
    license_identifier = case when v_approved then v_review.license_identifier else null end,
    license_verified_at = case when v_approved then v_now else null end,
    last_verified_at = case when v_approved then v_now else null end,
    published_at = null,
    editorial_revision = editorial_revision + 1,
    updated_at = greatest(v_now, updated_at)
  where id = p_project_id returning editorial_revision into v_revision;

  insert into public.editorial_overrides (
    project_id, field_key, override_value, created_by, approved_by, approved_at,
    reviewer_type, codex_review_id, created_at, updated_at
  ) values
    (p_project_id, 'name', to_jsonb(btrim(v_listing->>'name')), null, null, null, 'codex_automated', p_review_id, v_now, v_now),
    (p_project_id, 'summary', to_jsonb(btrim(v_listing->>'summary')), null, null, null, 'codex_automated', p_review_id, v_now, v_now),
    (p_project_id, 'description', to_jsonb(v_listing->>'description'), null, null, null, 'codex_automated', p_review_id, v_now, v_now),
    (p_project_id, 'official_website_url', coalesce(to_jsonb(v_website), 'null'::jsonb), null, null, null, 'codex_automated', p_review_id, v_now, v_now),
    (p_project_id, 'tags', to_jsonb(coalesce(v_tags, array[]::text[])), null, null, null, 'codex_automated', p_review_id, v_now, v_now),
    (p_project_id, 'license_status', to_jsonb(case when v_approved then 'verified_open_source' else 'needs_review' end), null, null, null, 'codex_automated', p_review_id, v_now, v_now),
    (p_project_id, 'license_identifier', coalesce(to_jsonb(case when v_approved then v_review.license_identifier end), 'null'::jsonb), null, null, null, 'codex_automated', p_review_id, v_now, v_now)
  on conflict (project_id, field_key) do update set
    override_value = excluded.override_value, created_by = null, approved_by = null, approved_at = null,
    reviewer_type = 'codex_automated', codex_review_id = p_review_id, updated_at = v_now;

  delete from public.project_categories where project_id = p_project_id;
  insert into public.project_categories (project_id, category_id)
  select p_project_id, category_id from unnest(v_category_ids) category_id;
  delete from public.project_tags where project_id = p_project_id;
  foreach v_tag in array coalesce(v_tags, array[]::text[]) loop
    v_slug := trim(both '-' from regexp_replace(lower(btrim(v_tag)), '[^a-z0-9]+', '-', 'g'));
    insert into public.tags (slug, name) values (v_slug, btrim(v_tag)) on conflict (slug) do nothing;
  end loop;
  insert into public.project_tags (project_id, tag_id)
  select p_project_id, t.id from public.tags t where t.slug = any(v_slugs);

  update public.review_queue set status = 'resolved', resolved_at = v_now, updated_at = v_now
  where status in ('open', 'in_review') and (
    project_id = p_project_id or repository_id = v_repository.id
    or assessment_id in (select a.id from public.repository_assessments a where a.repository_id = v_repository.id)
  ) and v_review.decision in ('approve', 'reject');
  if v_review.decision = 'investigate' then
    update public.review_queue set reason = left(v_reason, 1000), updated_at = v_now
    where id = (select q.id from public.review_queue q where q.project_id = p_project_id and q.status in ('open', 'in_review') order by q.created_at limit 1 for update);
    if not found then insert into public.review_queue (project_id, reason, status) values (p_project_id, left(v_reason, 1000), 'open'); end if;
  end if;

  insert into public.codex_review_applications (review_id, project_id, resulting_state, resulting_revision, applied_at)
  values (p_review_id, p_project_id, v_next_status, v_revision, v_now);
  insert into public.editorial_decisions (
    project_id, actor_user_id, reviewer_type, action, previous_state, resulting_state,
    evidence, reason, resulting_revision, created_at
  ) values (
    p_project_id, null, 'codex_automated', 'codex_automated_review', v_project.publication_status, v_next_status,
    jsonb_build_object('review_id', p_review_id, 'evidence_sha256', v_review.evidence_sha256,
      'evidence_observed_at', v_review.evidence_observed_at, 'codex_version', v_review.codex_version,
      'review_policy_version', v_review.review_policy_version, 'confidence', v_review.codex_review->>'confidence',
      'citations', v_review.codex_review->'supporting_sources', 'uncertainties', v_review.codex_review->'uncertainties'),
    v_reason, v_revision, v_now
  );
  if v_approved then
    insert into public.editorial_decisions (
      project_id, actor_user_id, reviewer_type, action, previous_state, resulting_state, evidence, reason, resulting_revision, created_at
    ) values
      (p_project_id, null, 'codex_automated', 'codex_verify_license', v_project.license_status, 'verified_open_source',
       jsonb_build_object('review_id', p_review_id, 'license_identifier', v_review.license_identifier,
         'license_file_url', v_review.license_file_url, 'license_file_sha256', v_review.license_file_sha256,
         'spdx_list_version', '3.29.0', 'source_observed_at', v_observed_at,
         'evidence_observed_at', v_review.evidence_observed_at), v_reason, v_revision, v_now),
      (p_project_id, null, 'codex_automated', 'codex_verify_quality', v_project.quality_status, 'verified',
       jsonb_build_object('review_id', p_review_id, 'repository_id', v_repository.id,
         'assessment_id', v_assessment_id, 'source_observed_at', v_observed_at,
         'readme_sha256', v_readme_source->>'sha256', 'manifest_sha256', v_manifest_source->>'sha256',
         'not_a_security_or_code_audit', true), v_reason, v_revision, v_now);
  end if;
  return jsonb_build_object('review_id', p_review_id, 'project_id', p_project_id,
    'revision', v_revision, 'publication_status', v_next_status,
    'quality_verified', v_approved, 'license_verified', v_approved);
end;
$function$;
revoke all on function public.codex_apply_editorial_review(uuid, uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.codex_apply_editorial_review(uuid, uuid, text, bigint) to service_role;

create function public.codex_create_reviewed_draft(
  p_authorization_id uuid,
  p_candidate_id uuid,
  p_review_id text
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_review public.codex_editorial_reviews%rowtype;
  v_candidate public.repository_candidates%rowtype;
  v_repository public.repositories%rowtype;
  v_project public.projects%rowtype;
  v_project_id uuid;
  v_slug text;
  v_revision bigint;
  v_status text;
  v_now timestamptz := clock_timestamp();
begin
  perform private.assert_codex_editorial_authorized(p_authorization_id);
  if p_candidate_id is null or p_review_id is null then
    raise exception 'candidate and approved review are required' using errcode = '22023';
  end if;
  select r.* into v_review from public.codex_editorial_reviews r
  where r.review_id = p_review_id for share;
  if not found or v_review.candidate_id is distinct from p_candidate_id
    or v_review.decision <> 'approve' or not v_review.publication_eligible
    or v_review.execution_status <> 'completed' or v_review.review_policy_version <> 'outlist-codex-editorial-v2'
    or v_review.evidence_observed_at < v_now - interval '7 days' then
    raise exception 'a current, completed, publication-eligible Codex approval is required to restore a draft' using errcode = '23514';
  end if;
  select c.* into v_candidate from public.repository_candidates c where c.id = p_candidate_id for update;
  if not found or v_candidate.provider <> 'github' or v_candidate.repository_id is null
    or v_candidate.provider_repository_id is distinct from v_review.provider_repository_id
    or lower(v_candidate.full_name) is distinct from lower(v_review.full_name)
    or v_candidate.queue_status <> 'succeeded' or v_candidate.enrichment_status <> 'succeeded'
    or v_candidate.review_status = 'rejected' or v_candidate.queue_status = 'discarded' then
    raise exception 'candidate is not a successfully enriched, unrejected recovery target' using errcode = '23514';
  end if;
  select r.* into v_repository from public.repositories r
  where r.id = v_candidate.repository_id for update;
  if not found or v_repository.provider <> 'github'
    or v_repository.provider_repository_id is distinct from v_review.provider_repository_id
    or lower(v_repository.full_name) is distinct from lower(v_review.full_name)
    or v_repository.availability_status <> 'available' or v_repository.is_private is distinct from false
    or lower(btrim(coalesce(v_repository.visibility, ''))) <> 'public'
    or v_repository.is_disabled is distinct from false or v_repository.is_archived is distinct from false then
    raise exception 'current repository is unavailable, restricted, or does not match the reviewed identity' using errcode = '23514';
  end if;

  v_project_id := v_repository.project_id;
  if v_project_id is null then
    v_slug := 'github-' || v_repository.provider_repository_id || '-' || substring(p_candidate_id::text from 1 for 8);
    insert into public.projects (
      slug, name, summary, description, publication_status, quality_status, license_status
    ) values (
      v_slug, coalesce(nullif(btrim(v_repository.repository_name), ''), 'Project'),
      'Pending independent editorial review.', '', 'draft', 'unreviewed', 'unknown'
    ) returning id into v_project_id;
    update public.repositories set project_id = v_project_id, updated_at = greatest(updated_at, v_now)
    where id = v_repository.id;
    update public.projects set primary_repository_id = v_repository.id where id = v_project_id;
  else
    select p.* into v_project from public.projects p
    where p.id = v_project_id and p.primary_repository_id = v_repository.id for update;
    if not found or v_project.publication_status not in ('draft', 'pending_review') then
      raise exception 'existing repository project is not an unpublished draft' using errcode = '23514';
    end if;
    if exists (select 1 from public.codex_review_applications a
      where a.project_id = v_project_id and a.review_id = p_review_id) then
      return jsonb_build_object('candidate_id', p_candidate_id, 'project_id', v_project.id, 'slug', v_project.slug,
        'editorial_revision', v_project.editorial_revision, 'publication_status', v_project.publication_status,
        'review_applied', true, 'idempotent', true);
    end if;
  end if;

  select p.* into v_project from public.projects p where p.id = v_project_id for update;
  perform public.codex_apply_editorial_review(p_authorization_id, v_project_id, p_review_id, v_project.editorial_revision);
  select p.slug, p.editorial_revision, p.publication_status into v_slug, v_revision, v_status
  from public.projects p where p.id = v_project_id;
  return jsonb_build_object('candidate_id', p_candidate_id, 'project_id', v_project_id, 'slug', v_slug,
    'editorial_revision', v_revision, 'publication_status', v_status,
    'review_applied', true, 'idempotent', false);
end;
$function$;
revoke all on function public.codex_create_reviewed_draft(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.codex_create_reviewed_draft(uuid, uuid, text) to service_role;

create function public.codex_project_review_state(
  p_authorization_id uuid,
  p_project_id uuid,
  p_review_id text
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_project public.projects%rowtype;
  v_application public.codex_review_applications%rowtype;
begin
  perform private.assert_codex_editorial_authorized(p_authorization_id);
  select p.* into v_project from public.projects p where p.id = p_project_id;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  select a.* into v_application from public.codex_review_applications a
  where a.project_id = p_project_id and a.review_id = p_review_id;
  return jsonb_build_object('project_id', v_project.id, 'slug', v_project.slug, 'editorial_revision', v_project.editorial_revision,
    'publication_status', v_project.publication_status, 'review_applied', found,
    'application_revision', v_application.resulting_revision, 'application_state', v_application.resulting_state);
end;
$function$;
revoke all on function public.codex_project_review_state(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.codex_project_review_state(uuid, uuid, text) to service_role;

create function public.codex_publish_project(
  p_authorization_id uuid,
  p_project_id uuid,
  p_review_id text,
  p_expected_revision bigint
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_project public.projects%rowtype;
  v_review public.codex_editorial_reviews%rowtype;
  v_repository_id uuid;
  v_observed_at timestamptz;
  v_assessment_id uuid;
  v_revision bigint;
  v_now timestamptz := clock_timestamp();
  v_reason text;
begin
  perform private.assert_codex_editorial_authorized(p_authorization_id);
  if p_project_id is null or p_review_id is null or p_expected_revision is null then
    raise exception 'project, review, and expected revision are required' using errcode = '22023';
  end if;
  select p.* into v_project from public.projects p where p.id = p_project_id for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.publication_status = 'published' and exists (
    select 1 from public.editorial_decisions d
    where d.project_id = p_project_id and d.reviewer_type = 'codex_automated'
      and d.action = 'codex_publish' and d.evidence->>'review_id' = p_review_id
  ) then
    return jsonb_build_object('review_id', p_review_id, 'project_id', p_project_id,
      'revision', v_project.editorial_revision, 'published', true, 'idempotent', true);
  end if;
  if v_project.editorial_revision <> p_expected_revision then raise exception 'stale editorial revision' using errcode = '40001'; end if;
  if v_project.publication_status <> 'pending_review' then
    raise exception 'project must be pending review before publication' using errcode = '55000';
  end if;
  if length(btrim(v_project.name)) not between 1 and 120
    or length(btrim(v_project.summary)) not between 10 and 280 then
    raise exception 'project name and summary are required before publication' using errcode = '23514';
  end if;
  if v_project.quality_status <> 'verified' or v_project.license_status <> 'verified_open_source'
    or nullif(btrim(v_project.license_identifier), '') is null
    or v_project.license_verified_at is null or v_project.last_verified_at is null then
    raise exception 'automated quality and license checks must both be verified' using errcode = '23514';
  end if;
  select r.* into v_review from public.codex_editorial_reviews r
  where r.review_id = p_review_id for share;
  if not found or v_review.decision <> 'approve' or not v_review.publication_eligible
    or v_review.review_policy_version <> 'outlist-codex-editorial-v2'
    or v_review.evidence_observed_at < v_now - interval '7 days'
    or v_review.license_identifier is distinct from v_project.license_identifier
    or not exists (
      select 1 from public.codex_review_applications a
      where a.review_id = p_review_id and a.project_id = p_project_id
        and a.resulting_state = 'pending_review'
        and a.resulting_revision = v_project.editorial_revision
        and not exists (
          select 1 from public.codex_review_applications later
          where later.project_id = p_project_id and later.applied_at > a.applied_at
        )
    ) then
    raise exception 'latest completed approved Codex application is required' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.editorial_decisions d where d.project_id = p_project_id
      and d.reviewer_type = 'codex_automated' and d.action = 'codex_verify_license'
      and d.resulting_state = 'verified_open_source' and d.evidence->>'review_id' = p_review_id
      and d.evidence->>'license_identifier' = v_project.license_identifier
      and d.evidence->>'license_file_sha256' = v_review.license_file_sha256
  ) or not exists (
    select 1 from public.editorial_decisions d where d.project_id = p_project_id
      and d.reviewer_type = 'codex_automated' and d.action = 'codex_verify_quality'
      and d.resulting_state = 'verified' and d.evidence->>'review_id' = p_review_id
  ) then
    raise exception 'independent automated license and quality evidence is missing' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.project_categories pc join public.categories c on c.id = pc.category_id
    where pc.project_id = p_project_id and c.is_active
  ) then raise exception 'at least one active category is required' using errcode = '23514'; end if;

  select e.repository_id, e.source_observed_at, e.assessment_id
    into v_repository_id, v_observed_at, v_assessment_id
  from private.assert_current_project_evidence(p_project_id) e;
  if v_observed_at is null or v_observed_at < v_now - interval '7 days'
    or v_review.evidence_observed_at < v_now - interval '7 days'
    or not exists (
      select 1 from public.repositories r where r.id = v_repository_id
        and r.source_license_metadata->>'spdx_id' = v_project.license_identifier
        and exists (select 1 from private.codex_approved_license_ids l
          where l.identifier = r.source_license_metadata->>'spdx_id' and l.spdx_list_version = '3.29.0')
    ) then
    raise exception 'current source evidence or approved license is stale or mismatched' using errcode = '23514';
  end if;
  if not exists (select 1 from public.editorial_decisions d where d.project_id = p_project_id
    and d.reviewer_type = 'codex_automated' and d.action = 'codex_verify_license'
    and d.evidence->>'review_id' = p_review_id and (d.evidence->>'source_observed_at')::timestamptz = v_observed_at)
    or not exists (select 1 from public.editorial_decisions d where d.project_id = p_project_id
      and d.reviewer_type = 'codex_automated' and d.action = 'codex_verify_quality'
      and d.evidence->>'review_id' = p_review_id and (d.evidence->>'source_observed_at')::timestamptz = v_observed_at) then
    raise exception 'license and quality decisions do not match current repository evidence' using errcode = '23514';
  end if;
  if exists (select 1 from public.review_queue q where q.status in ('open', 'in_review')
    and (q.project_id = p_project_id or q.repository_id = v_repository_id
      or q.assessment_id = v_assessment_id)) then
    raise exception 'unresolved blocking review items remain' using errcode = '23514';
  end if;

  v_reason := 'Codex CLI review ' || p_review_id || ' met the current evidence, quality, and license gates.';
  update public.projects set publication_status = 'published', published_at = v_now,
    last_verified_at = greatest(coalesce(last_verified_at, v_now), v_now),
    editorial_revision = editorial_revision + 1,
    updated_at = greatest(updated_at, v_now)
  where id = p_project_id returning editorial_revision into v_revision;
  insert into public.editorial_decisions (
    project_id, actor_user_id, reviewer_type, action, previous_state, resulting_state,
    evidence, reason, resulting_revision, created_at
  ) values (
    p_project_id, null, 'codex_automated', 'codex_publish', 'pending_review', 'published',
    jsonb_build_object('review_id', p_review_id, 'repository_id', v_repository_id,
      'assessment_id', v_assessment_id, 'source_observed_at', v_observed_at,
      'evidence_sha256', v_review.evidence_sha256, 'license_identifier', v_project.license_identifier,
      'license_file_sha256', v_review.license_file_sha256),
    v_reason, v_revision, v_now
  );
  return jsonb_build_object('review_id', p_review_id, 'project_id', p_project_id,
    'revision', v_revision, 'published', true, 'idempotent', false);
end;
$function$;
revoke all on function public.codex_publish_project(uuid, uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.codex_publish_project(uuid, uuid, text, bigint) to service_role;

create function public.codex_revoke_publication(
  p_authorization_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_project public.projects%rowtype;
  v_repository public.repositories%rowtype;
  v_review_id text;
  v_revision bigint;
  v_now timestamptz := clock_timestamp();
begin
  perform private.assert_codex_editorial_authorized(p_authorization_id);
  if p_project_id is null or p_expected_revision is null or length(btrim(p_reason)) not between 8 and 1000 then
    raise exception 'project, expected revision, and a concrete reason are required' using errcode = '22023';
  end if;
  select p.* into v_project from public.projects p where p.id = p_project_id for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.editorial_revision <> p_expected_revision then raise exception 'stale editorial revision' using errcode = '40001'; end if;
  if v_project.publication_status <> 'published' then
    raise exception 'only a published project can be revoked' using errcode = '55000';
  end if;
  select r.* into v_repository from public.repositories r where r.id = v_project.primary_repository_id and r.project_id = v_project.id;
  select a.review_id into v_review_id from public.codex_review_applications a
  where a.project_id = p_project_id order by a.applied_at desc limit 1;
  update public.projects set publication_status = 'pending_review', quality_status = 'needs_review',
    license_status = 'needs_review', license_identifier = null, license_verified_at = null,
    last_verified_at = null, published_at = null,
    editorial_revision = editorial_revision + 1, updated_at = greatest(updated_at, v_now)
  where id = p_project_id returning editorial_revision into v_revision;
  update public.editorial_overrides set override_value = to_jsonb('needs_review'::text),
    reviewer_type = 'system_policy', codex_review_id = null, created_by = null, approved_by = null,
    approved_at = null, updated_at = v_now
  where project_id = p_project_id and field_key = 'license_status';
  update public.editorial_overrides set override_value = 'null'::jsonb,
    reviewer_type = 'system_policy', codex_review_id = null, created_by = null, approved_by = null,
    approved_at = null, updated_at = v_now
  where project_id = p_project_id and field_key = 'license_identifier';
  insert into public.project_publication_revocations (
    project_id, repository_id, review_id, source_observed_at, reason, origin, resulting_revision, created_at
  ) values (
    p_project_id, v_project.primary_repository_id, v_review_id, v_repository.source_observed_at,
    btrim(p_reason), 'codex_automated', v_revision, v_now
  );
  insert into public.editorial_decisions (
    project_id, actor_user_id, reviewer_type, action, previous_state, resulting_state,
    evidence, reason, resulting_revision, created_at
  ) values (
    p_project_id, null, 'codex_automated', 'codex_revoke_publication', 'published', 'pending_review',
    jsonb_build_object('review_id', v_review_id, 'repository_id', v_project.primary_repository_id,
      'source_observed_at', v_repository.source_observed_at, 'license_identifier_before_revocation', v_project.license_identifier),
    btrim(p_reason), v_revision, v_now
  );
  update public.review_queue set reason = left(btrim(p_reason), 1000), status = 'open', resolved_at = null,
    updated_at = v_now
  where id = (select q.id from public.review_queue q where q.project_id = p_project_id
    and q.status in ('open', 'in_review') order by q.created_at limit 1 for update);
  if not found then
    insert into public.review_queue (project_id, reason, status, created_at, updated_at)
    values (p_project_id, left(btrim(p_reason), 1000), 'open', v_now, v_now);
  end if;
  return jsonb_build_object('project_id', p_project_id, 'revision', v_revision,
    'publication_status', 'pending_review', 'revoked', true, 'review_id', v_review_id);
end;
$function$;
revoke all on function public.codex_revoke_publication(uuid, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.codex_revoke_publication(uuid, uuid, bigint, text) to service_role;

create function private.hold_published_project_on_invalid_source()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_project public.projects%rowtype;
  v_review_id text;
  v_revision bigint;
  v_now timestamptz := clock_timestamp();
  v_reason text;
begin
  if new.project_id is null then return new; end if;
  if not (
      new.availability_status = 'available'
      and new.is_private is false and lower(btrim(coalesce(new.visibility, ''))) = 'public'
      and new.is_disabled is false and new.is_archived is false
      and exists (select 1 from private.codex_approved_license_ids l
        where l.identifier = new.source_license_metadata->>'spdx_id' and l.spdx_list_version = '3.29.0')
    ) then
    v_reason := 'Authoritative repository evidence is no longer eligible; refresh source data and repeat the editorial review.';
  elsif new.source_observed_at is distinct from old.source_observed_at
    or new.source_license_metadata is distinct from old.source_license_metadata
    or new.source_field_states is distinct from old.source_field_states then
    v_reason := 'Authoritative repository evidence changed after publication; repeat the editorial review against the refreshed source.';
  else
    return new;
  end if;

  if v_reason is not null then
    select p.* into v_project from public.projects p
    where p.id = new.project_id and p.primary_repository_id = new.id and p.publication_status = 'published'
    for update;
    if found then
      select a.review_id into v_review_id from public.codex_review_applications a
      where a.project_id = v_project.id order by a.applied_at desc limit 1;
      update public.projects set publication_status = 'pending_review', quality_status = 'needs_review',
        license_status = 'needs_review', license_identifier = null, license_verified_at = null,
        last_verified_at = null, published_at = null,
        editorial_revision = editorial_revision + 1, updated_at = greatest(updated_at, v_now)
      where id = v_project.id returning editorial_revision into v_revision;
      update public.editorial_overrides set override_value = to_jsonb('needs_review'::text),
        reviewer_type = 'system_policy', codex_review_id = null, created_by = null, approved_by = null,
        approved_at = null, updated_at = v_now
      where project_id = v_project.id and field_key = 'license_status';
      update public.editorial_overrides set override_value = 'null'::jsonb,
        reviewer_type = 'system_policy', codex_review_id = null, created_by = null, approved_by = null,
        approved_at = null, updated_at = v_now
      where project_id = v_project.id and field_key = 'license_identifier';
      insert into public.project_publication_revocations (
        project_id, repository_id, review_id, source_observed_at, reason, origin, resulting_revision, created_at
      ) values (
        v_project.id, new.id, v_review_id, new.source_observed_at, v_reason,
        'system_policy', v_revision, v_now
      );
      insert into public.editorial_decisions (
        project_id, actor_user_id, reviewer_type, action, previous_state, resulting_state,
        evidence, reason, resulting_revision, created_at
      ) values (
        v_project.id, null, 'system_policy', 'system_revoke_publication', 'published', 'pending_review',
        jsonb_build_object('repository_id', new.id, 'provider_repository_id', new.provider_repository_id,
          'source_observed_at', new.source_observed_at, 'availability_status', new.availability_status,
          'is_private', new.is_private, 'visibility', new.visibility, 'is_disabled', new.is_disabled,
          'is_archived', new.is_archived, 'license_spdx_id', new.source_license_metadata->>'spdx_id'),
        v_reason, v_revision, v_now
      );
      update public.review_queue set reason = v_reason, status = 'open', resolved_at = null, updated_at = v_now
      where id = (select q.id from public.review_queue q where q.project_id = v_project.id
        and q.status in ('open', 'in_review') order by q.created_at limit 1 for update);
      if not found then
        insert into public.review_queue (project_id, reason, status, created_at, updated_at)
        values (v_project.id, v_reason, 'open', v_now, v_now);
      end if;
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function private.hold_published_project_on_invalid_source() from public, anon, authenticated, service_role;
create trigger repositories_hold_published_project_on_invalid_source
after update of availability_status, is_private, visibility, is_disabled, is_archived,
  source_license_metadata, source_observed_at, source_field_states
on public.repositories for each row execute function private.hold_published_project_on_invalid_source();
