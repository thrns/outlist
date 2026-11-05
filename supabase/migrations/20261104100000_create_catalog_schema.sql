-- Canonical catalog tables. JSON demo records remain separate and are not
-- promoted into production listings by this migration.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null default '',
  summary text not null default '',
  description text not null default '',
  official_website_url text,
  primary_repository_id uuid,
  license_status text not null default 'unknown'
    check (license_status in (
      'unknown', 'unverified', 'verified_open_source', 'not_open_source',
      'proprietary', 'needs_review'
    )),
  license_identifier text,
  license_verified_at timestamptz,
  publication_status text not null default 'draft'
    check (publication_status in (
      'draft', 'pending_review', 'published', 'rejected', 'archived'
    )),
  quality_status text not null default 'unreviewed'
    check (quality_status in ('unreviewed', 'needs_review', 'verified', 'rejected')),
  featured boolean not null default false,
  editorial_rank integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  last_verified_at timestamptz,
  constraint projects_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint projects_website_url_format check (
    official_website_url is null
    or official_website_url ~* '^https?://[^[:space:]]+$'
  ),
  constraint projects_license_verification check (
    license_status <> 'verified_open_source'
    or (nullif(btrim(license_identifier), '') is not null and license_verified_at is not null)
  ),
  constraint projects_updated_after_created check (updated_at >= created_at)
);

create table public.repositories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  provider text not null check (provider in ('github', 'gitlab', 'codeberg', 'sourcehut', 'other')),
  provider_repository_id text not null check (nullif(btrim(provider_repository_id), '') is not null),
  full_name text not null check (nullif(btrim(full_name), '') is not null),
  canonical_url text not null check (canonical_url ~* '^https?://[^[:space:]]+$'),
  description text,
  default_branch text,
  primary_language text,
  stars bigint not null default 0 check (stars >= 0),
  forks bigint not null default 0 check (forks >= 0),
  is_archived boolean not null default false,
  is_fork boolean not null default false,
  provider_created_at timestamptz,
  provider_updated_at timestamptz,
  provider_pushed_at timestamptz,
  last_successful_sync_at timestamptz,
  availability_status text not null default 'unknown'
    check (availability_status in (
      'unknown', 'available', 'temporarily_unavailable', 'not_found',
      'access_restricted', 'removed'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repositories_provider_identity_unique unique (provider, provider_repository_id),
  constraint repositories_project_and_id_unique unique (project_id, id),
  constraint repositories_updated_after_created check (updated_at >= created_at)
);

-- The project owns the single primary-repository pointer. This makes it
-- impossible to select multiple primary repositories and the composite FK
-- prevents pointing at a repository owned by another project.
alter table public.projects
  add constraint projects_primary_repository_same_project_fk
  foreign key (id, primary_repository_id)
  references public.repositories (project_id, id)
  on delete no action deferrable initially deferred;

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null check (nullif(btrim(name), '') is not null),
  description text not null default '',
  icon_identifier text not null default 'grid',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint categories_updated_after_created check (updated_at >= created_at)
);

create table public.project_categories (
  project_id uuid not null references public.projects(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (project_id, category_id)
);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null check (nullif(btrim(name), '') is not null),
  created_at timestamptz not null default now(),
  constraint tags_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

create table public.project_tags (
  project_id uuid not null references public.projects(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (project_id, tag_id)
);
