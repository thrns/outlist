-- Provenance, repository measurements, editorial workflows, and restartable
-- ingestion state. None of these rows are seeded from the illustrative demo.

create table public.source_records (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('github', 'gitlab', 'codeberg', 'sourcehut', 'other')),
  record_kind text not null check (nullif(btrim(record_kind), '') is not null),
  source_key text not null check (nullif(btrim(source_key), '') is not null),
  source_url text not null check (source_url ~* '^https?://[^[:space:]]+$'),
  fetched_at timestamptz not null,
  http_status integer check (http_status between 100 and 599),
  raw_payload jsonb,
  reuse_context text,
  repository_id uuid references public.repositories(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint source_records_fetch_identity_unique unique (provider, source_key, fetched_at),
  constraint source_records_raw_payload_object check (
    raw_payload is null or jsonb_typeof(raw_payload) in ('object', 'array')
  )
);

create table public.releases (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references public.repositories(id) on delete cascade,
  provider_release_id text not null check (nullif(btrim(provider_release_id), '') is not null),
  version text not null check (nullif(btrim(version), '') is not null),
  release_name text,
  release_url text not null check (release_url ~* '^https?://[^[:space:]]+$'),
  published_at timestamptz,
  is_prerelease boolean not null default false,
  is_draft boolean not null default false,
  source_record_id uuid references public.source_records(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint releases_provider_identity_unique unique (repository_id, provider_release_id),
  constraint releases_updated_after_created check (updated_at >= created_at)
);

create table public.repository_snapshots (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references public.repositories(id) on delete cascade,
  snapshot_date date not null,
  captured_at timestamptz not null,
  stars bigint not null check (stars >= 0),
  forks bigint not null check (forks >= 0),
  source_record_id uuid references public.source_records(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint repository_snapshots_one_per_day unique (repository_id, snapshot_date)
);

create table public.repository_topics (
  repository_id uuid not null references public.repositories(id) on delete cascade,
  source_topic text not null check (nullif(btrim(source_topic), '') is not null),
  topic_key text generated always as (lower(btrim(source_topic))) stored,
  source_record_id uuid references public.source_records(id) on delete set null,
  observed_at timestamptz not null default now(),
  primary key (repository_id, topic_key)
);

create table public.repository_languages (
  repository_id uuid not null references public.repositories(id) on delete cascade,
  language_name text not null check (nullif(btrim(language_name), '') is not null),
  language_key text generated always as (lower(btrim(language_name))) stored,
  bytes bigint not null check (bytes >= 0),
  measured_at timestamptz not null,
  source_record_id uuid references public.source_records(id) on delete set null,
  primary key (repository_id, language_key)
);

create table public.project_logos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_url text not null check (source_url ~* '^https?://[^[:space:]]+$'),
  storage_path text,
  media_type text not null check (media_type in ('image/png', 'image/jpeg', 'image/webp')),
  origin text not null check (origin in ('official_site', 'provider_avatar', 'submitted', 'editorial')),
  verification_status text not null default 'pending_review'
    check (verification_status in ('pending_review', 'approved', 'rejected', 'revoked')),
  attribution_text text,
  source_record_id uuid references public.source_records(id) on delete set null,
  is_primary boolean not null default false,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_logos_storage_path_format check (
    storage_path is null or (
      storage_path like project_id::text || '/%'
      and storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$'
    )
  ),
  constraint project_logos_approval_metadata check (
    (verification_status = 'approved' and storage_path is not null and verified_at is not null)
    or (verification_status <> 'approved' and storage_path is null)
  ),
  constraint project_logos_updated_after_created check (updated_at >= created_at)
);

create table public.project_alternatives (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  alternative_project_id uuid references public.projects(id) on delete restrict,
  software_name text,
  software_url text check (software_url is null or software_url ~* '^https?://[^[:space:]]+$'),
  relationship_type text not null default 'alternative',
  review_status text not null default 'pending_review'
    check (review_status in ('pending_review', 'approved', 'rejected')),
  source_record_id uuid references public.source_records(id) on delete set null,
  review_notes text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_alternatives_not_self check (
    alternative_project_id is null or alternative_project_id <> project_id
  ),
  constraint project_alternatives_target_required check (
    (alternative_project_id is not null and software_name is null)
    or (alternative_project_id is null and nullif(btrim(software_name), '') is not null)
  ),
  constraint project_alternatives_updated_after_created check (updated_at >= created_at)
);

create table public.discovery_queries (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('github', 'gitlab', 'codeberg', 'sourcehut', 'other')),
  partition_key text not null check (nullif(btrim(partition_key), '') is not null),
  query_text text not null check (nullif(btrim(query_text), '') is not null),
  cursor jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'paused')),
  pages_fetched integer not null default 0 check (pages_fetched >= 0),
  candidates_found integer not null default 0 check (candidates_found >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_queries_partition_unique unique (provider, partition_key),
  constraint discovery_queries_started_when_running check (status <> 'running' or started_at is not null),
  constraint discovery_queries_terminal_timestamp check (
    status not in ('completed', 'failed') or finished_at is not null
  ),
  constraint discovery_queries_timestamp_order check (
    started_at is null or finished_at is null or finished_at >= started_at
  ),
  constraint discovery_queries_updated_after_created check (updated_at >= created_at)
);

create table public.repository_candidates (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('github', 'gitlab', 'codeberg', 'sourcehut', 'other')),
  provider_repository_id text not null check (nullif(btrim(provider_repository_id), '') is not null),
  full_name text not null check (nullif(btrim(full_name), '') is not null),
  canonical_url text not null check (canonical_url ~* '^https?://[^[:space:]]+$'),
  source_record_id uuid not null references public.source_records(id) on delete restrict,
  discovery_query_id uuid references public.discovery_queries(id) on delete set null,
  repository_id uuid unique references public.repositories(id) on delete set null,
  queue_status text not null default 'queued'
    check (queue_status in ('queued', 'processing', 'retry_wait', 'succeeded', 'dead_letter', 'discarded')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  lock_owner text,
  last_error text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repository_candidates_provider_identity_unique unique (provider, provider_repository_id),
  constraint repository_candidates_lock_state check (
    (queue_status = 'processing' and locked_at is not null and nullif(btrim(lock_owner), '') is not null)
    or (queue_status <> 'processing' and locked_at is null and lock_owner is null)
  ),
  constraint repository_candidates_seen_order check (last_seen_at >= first_seen_at),
  constraint repository_candidates_updated_after_created check (updated_at >= created_at)
);

create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null check (nullif(btrim(job_type), '') is not null),
  provider text check (provider is null or provider in ('github', 'gitlab', 'codeberg', 'sourcehut', 'other')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  started_at timestamptz,
  finished_at timestamptz,
  items_discovered integer not null default 0 check (items_discovered >= 0),
  items_processed integer not null default 0 check (items_processed >= 0),
  items_created integer not null default 0 check (items_created >= 0),
  items_updated integer not null default 0 check (items_updated >= 0),
  items_skipped integer not null default 0 check (items_skipped >= 0),
  items_failed integer not null default 0 check (items_failed >= 0),
  error_summary text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingestion_jobs_running_has_start check (status <> 'running' or started_at is not null),
  constraint ingestion_jobs_terminal_has_finish check (
    status not in ('succeeded', 'partial', 'failed', 'cancelled') or finished_at is not null
  ),
  constraint ingestion_jobs_timestamp_order check (
    started_at is null or finished_at is null or finished_at >= started_at
  ),
  constraint ingestion_jobs_updated_after_created check (updated_at >= created_at)
);

create table public.ingestion_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ingestion_jobs(id) on delete cascade,
  item_key text not null check (nullif(btrim(item_key), '') is not null),
  item_type text not null check (nullif(btrim(item_type), '') is not null),
  candidate_id uuid references public.repository_candidates(id) on delete set null,
  repository_id uuid references public.repositories(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry_wait', 'succeeded', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  lock_owner text,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingestion_items_job_key_unique unique (job_id, item_key),
  constraint ingestion_items_target_required check (candidate_id is not null or repository_id is not null),
  constraint ingestion_items_lock_state check (
    (status = 'processing' and locked_at is not null and nullif(btrim(lock_owner), '') is not null)
    or (status <> 'processing' and locked_at is null and lock_owner is null)
  ),
  constraint ingestion_items_terminal_has_finish check (
    status not in ('succeeded', 'failed', 'skipped') or finished_at is not null
  ),
  constraint ingestion_items_timestamp_order check (
    started_at is null or finished_at is null or finished_at >= started_at
  ),
  constraint ingestion_items_updated_after_created check (updated_at >= created_at)
);

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  request_type text not null check (request_type in ('suggestion', 'correction')),
  project_id uuid references public.projects(id) on delete set null,
  suggested_name text,
  repository_url text check (repository_url is null or repository_url ~* '^https?://[^[:space:]]+$'),
  category_id uuid references public.categories(id) on delete set null,
  proposed_values jsonb not null default '{}'::jsonb check (jsonb_typeof(proposed_values) = 'object'),
  requester_contact text,
  validation_status text not null default 'pending'
    check (validation_status in ('pending', 'valid', 'invalid')),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'in_review', 'accepted', 'rejected', 'needs_information')),
  validation_error text,
  reviewer_notes text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint submissions_payload_present check (
    project_id is not null or nullif(btrim(suggested_name), '') is not null or proposed_values <> '{}'::jsonb
  ),
  constraint submissions_updated_after_created check (updated_at >= created_at)
);

create table public.review_queue (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  repository_id uuid references public.repositories(id) on delete cascade,
  submission_id uuid references public.submissions(id) on delete cascade,
  project_logo_id uuid references public.project_logos(id) on delete cascade,
  project_alternative_id uuid references public.project_alternatives(id) on delete cascade,
  reason text not null check (nullif(btrim(reason), '') is not null),
  status text not null default 'open' check (status in ('open', 'in_review', 'resolved', 'dismissed')),
  assigned_to uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint review_queue_one_target check (
    num_nonnulls(project_id, repository_id, submission_id, project_logo_id, project_alternative_id) = 1
  ),
  constraint review_queue_updated_after_created check (updated_at >= created_at)
);

create table public.editorial_overrides (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  field_key text not null check (field_key in (
    'name', 'summary', 'description', 'official_website_url',
    'license_status', 'license_identifier', 'featured', 'editorial_rank'
  )),
  override_value jsonb not null,
  source_record_id uuid references public.source_records(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid not null references auth.users(id) on delete restrict,
  approved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint editorial_overrides_one_value_per_field unique (project_id, field_key),
  constraint editorial_overrides_updated_after_created check (updated_at >= created_at)
);

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
