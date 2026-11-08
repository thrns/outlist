-- Read-only operator check. Run with `supabase db query --read-only` after migration.
-- The deliberate cast raises on a failed check so the CLI exits nonzero while
-- the whole statement remains an ordinary SELECT in a read-only transaction.
with checks(check_name, passed) as (values
  ('canonical projects RLS enabled', coalesce((select relrowsecurity from pg_class where oid = 'public.projects'::regclass), false)),
  ('repositories RLS enabled', coalesce((select relrowsecurity from pg_class where oid = 'public.repositories'::regclass), false)),
  ('categories RLS enabled', coalesce((select relrowsecurity from pg_class where oid = 'public.categories'::regclass), false)),
  ('administrator allowlist RLS enabled', coalesce((select relrowsecurity from pg_class where oid = 'public.admin_users'::regclass), false)),
  ('anonymous search uses invoker security', exists (
    select 1 from pg_proc p where p.oid = 'public.search_public_projects(text,text[],text[],text[],text,integer,integer,text)'::regprocedure
      and not p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')
  )),
  ('anonymous role cannot mutate canonical projects', not has_table_privilege('anon', 'public.projects', 'INSERT')
    and not has_table_privilege('anon', 'public.projects', 'UPDATE') and not has_table_privilege('anon', 'public.projects', 'DELETE')),
  ('anonymous role cannot mutate repositories', not has_table_privilege('anon', 'public.repositories', 'INSERT')
    and not has_table_privilege('anon', 'public.repositories', 'UPDATE') and not has_table_privilege('anon', 'public.repositories', 'DELETE')),
  ('anonymous role cannot read administrator allowlist', not has_table_privilege('anon', 'public.admin_users', 'SELECT')),
  ('authenticated role cannot read administrator allowlist', not has_table_privilege('authenticated', 'public.admin_users', 'SELECT')),
  ('project publication RPC is service-role only', exists (
    select 1 from pg_proc p where p.oid = 'public.admin_publish_project(uuid,uuid,bigint,text)'::regprocedure
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
  )),
  ('source, review, logo, and safety tables have RLS enabled', (
    select count(*) = 10 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any(array[
      'source_records', 'repository_candidates', 'ingestion_jobs', 'ingestion_items',
      'discovery_queries', 'review_queue', 'editorial_overrides', 'project_logos', 'submissions',
      'project_safety_events'
    ]) and c.relrowsecurity
  ))
), summary as (
  select coalesce(bool_and(passed), false) as all_passed,
    string_agg(check_name, '; ' order by check_name) filter (where not passed) as failures
  from checks
)
select case when all_passed then 1 else failures::integer end as launch_security_checks
from summary;
