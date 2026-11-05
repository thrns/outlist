create extension if not exists pg_trgm with schema extensions;

alter table public.projects
  add column search_document tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'C')
  ) stored;

create index projects_search_document_gin_idx on public.projects using gin (search_document);
create index projects_name_trgm_idx on public.projects using gin (name extensions.gin_trgm_ops);
create index projects_summary_trgm_idx on public.projects using gin (summary extensions.gin_trgm_ops);
create index projects_publication_date_idx on public.projects (published_at desc)
  where publication_status = 'published';
create index projects_publication_status_created_idx on public.projects (publication_status, created_at desc);
create index projects_featured_rank_idx on public.projects (editorial_rank, published_at desc)
  where publication_status = 'published' and featured;
create index projects_license_status_published_idx on public.projects (license_status, published_at desc)
  where publication_status = 'published';

create index repositories_project_id_idx on public.repositories (project_id);
create index repositories_available_stars_idx on public.repositories (stars desc, provider_pushed_at desc)
  where availability_status = 'available';
create index repositories_primary_language_idx on public.repositories (lower(primary_language))
  where primary_language is not null;
create index repositories_activity_idx on public.repositories (provider_pushed_at desc nulls last);
create index repositories_availability_status_idx on public.repositories (availability_status);

create index categories_active_sort_idx on public.categories (sort_order, name) where is_active;
create index project_categories_category_project_idx on public.project_categories (category_id, project_id);
create index project_tags_tag_project_idx on public.project_tags (tag_id, project_id);
create index repository_topics_topic_idx on public.repository_topics (topic_key, repository_id);
create index repository_languages_language_idx on public.repository_languages (language_key, repository_id);

create index source_records_repository_fetched_idx on public.source_records (repository_id, fetched_at desc)
  where repository_id is not null;
create index releases_repository_published_idx on public.releases (repository_id, published_at desc nulls last);
create index repository_snapshots_date_repository_idx on public.repository_snapshots (snapshot_date desc, repository_id);
create index project_logos_approved_project_idx on public.project_logos (project_id, is_primary desc, verified_at desc)
  where verification_status = 'approved';
create unique index project_logos_one_primary_per_project_idx on public.project_logos (project_id)
  where is_primary;
create unique index project_logos_storage_path_unique_idx on public.project_logos (storage_path)
  where storage_path is not null;
create index project_alternatives_approved_project_idx on public.project_alternatives (project_id, created_at desc)
  where review_status = 'approved';

create index discovery_queries_status_updated_idx on public.discovery_queries (status, updated_at desc);
create index repository_candidates_queue_eligibility_idx
  on public.repository_candidates (queue_status, next_attempt_at, created_at)
  where queue_status in ('queued', 'retry_wait');
create index repository_candidates_processing_lease_idx
  on public.repository_candidates (locked_at)
  where queue_status = 'processing';
create index ingestion_jobs_history_idx on public.ingestion_jobs (created_at desc, status);
create index ingestion_items_due_idx on public.ingestion_items (status, next_attempt_at, created_at)
  where status in ('queued', 'retry_wait');
create index ingestion_items_job_status_idx on public.ingestion_items (job_id, status);
create index submissions_review_status_created_idx on public.submissions (review_status, created_at);
create index review_queue_open_created_idx on public.review_queue (created_at)
  where status in ('open', 'in_review');
create index editorial_overrides_project_idx on public.editorial_overrides (project_id, field_key);

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.guard_project_publication()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.publication_status = 'published' then
    if nullif(btrim(new.name), '') is null or nullif(btrim(new.summary), '') is null then
      raise exception using errcode = '23514', message = 'Published projects require a non-empty name and summary';
    end if;

    if new.quality_status <> 'verified' then
      raise exception using errcode = '23514', message = 'Published projects require verified quality status';
    end if;

    if new.license_status <> 'verified_open_source'
       or nullif(btrim(new.license_identifier), '') is null
       or new.license_verified_at is null then
      raise exception using errcode = '23514', message = 'Published projects require a verified open-source license';
    end if;

    if new.primary_repository_id is null or not exists (
      select 1
      from public.repositories r
      where r.id = new.primary_repository_id
        and r.project_id = new.id
        and r.availability_status = 'available'
    ) then
      raise exception using errcode = '23514', message = 'Published projects require an available primary repository';
    end if;

    if not exists (
      select 1 from public.project_categories pc where pc.project_id = new.id
    ) then
      raise exception using errcode = '23514', message = 'Published projects require at least one category';
    end if;

    new.published_at := coalesce(new.published_at, now());
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create or replace function private.guard_published_primary_repository()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  affected_project_id uuid;
  primary_repository_id uuid;
  project_is_published boolean;
  repository_will_be_available boolean;
begin
  affected_project_id := old.project_id;
  if affected_project_id is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select p.primary_repository_id, p.publication_status = 'published'
    into primary_repository_id, project_is_published
  from public.projects p
  where p.id = affected_project_id;

  if not coalesce(project_is_published, false) or primary_repository_id <> old.id then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'A published project primary repository cannot be deleted';
  end if;

  repository_will_be_available := new.availability_status = 'available'
    and new.project_id = affected_project_id;
  if not repository_will_be_available then
    raise exception using errcode = '23514', message = 'A published project must retain an available primary repository';
  end if;
  return new;
end;
$$;

create or replace function private.guard_published_project_category()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_project_id uuid;
begin
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  old_project_id := old.project_id;
  if exists (
    select 1 from public.projects p
    where p.id = old_project_id and p.publication_status = 'published'
  ) and (
    (tg_op = 'DELETE' and (
      select count(*) from public.project_categories pc where pc.project_id = old_project_id
    ) <= 1)
    or (tg_op = 'UPDATE' and new.project_id is distinct from old.project_id and not exists (
    select 1 from public.project_categories pc
    where pc.project_id = old_project_id
      and (pc.project_id, pc.category_id) <> (old.project_id, old.category_id)
    ))
  ) then
    raise exception using errcode = '23514', message = 'A published project must retain at least one category';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.touch_updated_at() from public, anon, authenticated;
revoke all on function private.guard_project_publication() from public, anon, authenticated;
revoke all on function private.guard_published_primary_repository() from public, anon, authenticated;
revoke all on function private.guard_published_project_category() from public, anon, authenticated;
grant execute on function private.touch_updated_at() to service_role;
grant execute on function private.guard_project_publication() to service_role;
grant execute on function private.guard_published_primary_repository() to service_role;
grant execute on function private.guard_published_project_category() to service_role;

create trigger projects_00_publication_guard
  before insert or update on public.projects
  for each row execute function private.guard_project_publication();

create trigger repositories_00_published_primary_guard
  before update of project_id, availability_status or delete on public.repositories
  for each row execute function private.guard_published_primary_repository();

create trigger project_categories_00_published_guard
  before update or delete on public.project_categories
  for each row execute function private.guard_published_project_category();

create trigger projects_90_touch_updated_at before update on public.projects
  for each row execute function private.touch_updated_at();
create trigger repositories_90_touch_updated_at before update on public.repositories
  for each row execute function private.touch_updated_at();
create trigger categories_90_touch_updated_at before update on public.categories
  for each row execute function private.touch_updated_at();
create trigger releases_90_touch_updated_at before update on public.releases
  for each row execute function private.touch_updated_at();
create trigger project_logos_90_touch_updated_at before update on public.project_logos
  for each row execute function private.touch_updated_at();
create trigger project_alternatives_90_touch_updated_at before update on public.project_alternatives
  for each row execute function private.touch_updated_at();
create trigger discovery_queries_90_touch_updated_at before update on public.discovery_queries
  for each row execute function private.touch_updated_at();
create trigger repository_candidates_90_touch_updated_at before update on public.repository_candidates
  for each row execute function private.touch_updated_at();
create trigger ingestion_jobs_90_touch_updated_at before update on public.ingestion_jobs
  for each row execute function private.touch_updated_at();
create trigger ingestion_items_90_touch_updated_at before update on public.ingestion_items
  for each row execute function private.touch_updated_at();
create trigger submissions_90_touch_updated_at before update on public.submissions
  for each row execute function private.touch_updated_at();
create trigger review_queue_90_touch_updated_at before update on public.review_queue
  for each row execute function private.touch_updated_at();
create trigger editorial_overrides_90_touch_updated_at before update on public.editorial_overrides
  for each row execute function private.touch_updated_at();
