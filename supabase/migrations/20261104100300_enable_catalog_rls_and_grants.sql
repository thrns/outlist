-- Every application table has RLS enabled. Client roles receive only the
-- public read columns and operations; canonical writes stay server-side.

alter table public.projects enable row level security;
alter table public.repositories enable row level security;
alter table public.categories enable row level security;
alter table public.project_categories enable row level security;
alter table public.tags enable row level security;
alter table public.project_tags enable row level security;
alter table public.source_records enable row level security;
alter table public.releases enable row level security;
alter table public.repository_snapshots enable row level security;
alter table public.repository_topics enable row level security;
alter table public.repository_languages enable row level security;
alter table public.project_logos enable row level security;
alter table public.project_alternatives enable row level security;
alter table public.discovery_queries enable row level security;
alter table public.repository_candidates enable row level security;
alter table public.ingestion_jobs enable row level security;
alter table public.ingestion_items enable row level security;
alter table public.submissions enable row level security;
alter table public.review_queue enable row level security;
alter table public.editorial_overrides enable row level security;
alter table public.admin_users enable row level security;

revoke all on schema public from public, anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;
revoke all on all tables in schema public from public, anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;

-- Public catalog columns are explicitly listed to keep operational and review
-- metadata out of anonymous and ordinary authenticated queries.
grant select (
  id, slug, name, summary, description, official_website_url,
  primary_repository_id, license_status, license_identifier,
  publication_status, featured, editorial_rank, created_at, updated_at,
  published_at, last_verified_at
) on public.projects to anon, authenticated;

grant select (
  id, project_id, provider, provider_repository_id, full_name, canonical_url,
  description, default_branch, primary_language, stars, forks, is_archived,
  is_fork, provider_created_at, provider_updated_at, provider_pushed_at,
  availability_status, created_at, updated_at
) on public.repositories to anon, authenticated;

grant select (id, slug, name, description, icon_identifier, sort_order, is_active, created_at, updated_at)
  on public.categories to anon, authenticated;
grant select (project_id, category_id, created_at)
  on public.project_categories to anon, authenticated;
grant select (id, slug, name, created_at) on public.tags to anon, authenticated;
grant select (project_id, tag_id, created_at) on public.project_tags to anon, authenticated;
grant select (id, repository_id, provider_release_id, version, release_name, release_url, published_at, is_prerelease, is_draft, created_at)
  on public.releases to anon, authenticated;
grant select (id, repository_id, snapshot_date, captured_at, stars, forks, created_at)
  on public.repository_snapshots to anon, authenticated;
grant select (repository_id, source_topic, topic_key, observed_at)
  on public.repository_topics to anon, authenticated;
grant select (repository_id, language_name, language_key, bytes, measured_at)
  on public.repository_languages to anon, authenticated;
grant select (
  id, project_id, storage_path, media_type, origin,
  verification_status, attribution_text, is_primary, verified_at, created_at
) on public.project_logos to anon, authenticated;
grant select (
  id, project_id, alternative_project_id, software_name, software_url,
  relationship_type, review_status, created_at
) on public.project_alternatives to anon, authenticated;

create policy projects_public_read on public.projects
  for select to anon, authenticated
  using (publication_status = 'published');

create policy repositories_public_read on public.repositories
  for select to anon, authenticated
  using (
    project_id is not null
    and availability_status = 'available'
    and exists (
      select 1 from public.projects p
      where p.id = repositories.project_id and p.publication_status = 'published'
    )
  );

create policy categories_public_read on public.categories
  for select to anon, authenticated
  using (is_active);

create policy project_categories_public_read on public.project_categories
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_categories.project_id and p.publication_status = 'published'
    )
    and exists (
      select 1 from public.categories c
      where c.id = project_categories.category_id and c.is_active
    )
  );

create policy tags_public_read on public.tags
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.project_tags pt
      join public.projects p on p.id = pt.project_id
      where pt.tag_id = tags.id and p.publication_status = 'published'
    )
  );

create policy project_tags_public_read on public.project_tags
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_tags.project_id and p.publication_status = 'published'
    )
  );

create policy releases_public_read on public.releases
  for select to anon, authenticated
  using (
    not is_draft
    and
    exists (
      select 1
      from public.repositories r
      join public.projects p on p.id = r.project_id
      where r.id = releases.repository_id
        and r.availability_status = 'available'
        and p.publication_status = 'published'
    )
  );

create policy repository_snapshots_public_read on public.repository_snapshots
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.repositories r
      join public.projects p on p.id = r.project_id
      where r.id = repository_snapshots.repository_id
        and r.availability_status = 'available'
        and p.publication_status = 'published'
    )
  );

create policy repository_topics_public_read on public.repository_topics
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.repositories r
      join public.projects p on p.id = r.project_id
      where r.id = repository_topics.repository_id
        and r.availability_status = 'available'
        and p.publication_status = 'published'
    )
  );

create policy repository_languages_public_read on public.repository_languages
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.repositories r
      join public.projects p on p.id = r.project_id
      where r.id = repository_languages.repository_id
        and r.availability_status = 'available'
        and p.publication_status = 'published'
    )
  );

create policy project_logos_public_read on public.project_logos
  for select to anon, authenticated
  using (
    verification_status = 'approved'
    and exists (
      select 1 from public.projects p
      where p.id = project_logos.project_id and p.publication_status = 'published'
    )
  );

create policy project_alternatives_public_read on public.project_alternatives
  for select to anon, authenticated
  using (
    review_status = 'approved'
    and exists (
      select 1 from public.projects p
      where p.id = project_alternatives.project_id and p.publication_status = 'published'
    )
    and (
      alternative_project_id is null
      or exists (
        select 1 from public.projects target
        where target.id = project_alternatives.alternative_project_id
          and target.publication_status = 'published'
      )
    )
  );

-- No client policies exist for source payloads, ingestion state, submissions,
-- moderation, overrides, or administrator identities. Service role bypasses
-- RLS and has the explicit table privileges needed by future server workers.
