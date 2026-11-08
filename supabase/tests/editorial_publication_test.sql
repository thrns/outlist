begin;
select no_plan();

select has_table('public', 'editorial_decisions', 'append-only editorial decision audit table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.editorial_decisions'::regclass),
  'editorial decision audit has RLS enabled');
select ok(not has_table_privilege('anon', 'public.editorial_decisions', 'SELECT'),
  'anonymous users cannot read editorial decisions');
select ok(not has_table_privilege('authenticated', 'public.editorial_decisions', 'SELECT'),
  'ordinary authenticated users cannot read editorial decisions');
select ok(not has_table_privilege('anon', 'public.editorial_decisions', 'INSERT,UPDATE,DELETE'),
  'anonymous users cannot mutate editorial decisions');

select ok(has_function_privilege('service_role', 'public.admin_publish_project(uuid,uuid,bigint,text)', 'EXECUTE'),
  'service role can invoke the narrow publication RPC');
select ok(not has_function_privilege('anon', 'public.admin_publish_project(uuid,uuid,bigint,text)', 'EXECUTE'),
  'anonymous clients cannot invoke the publication RPC');
select ok(not has_function_privilege('authenticated', 'public.admin_publish_project(uuid,uuid,bigint,text)', 'EXECUTE'),
  'ordinary authenticated clients cannot invoke the publication RPC');
select ok(not has_function_privilege('anon', 'public.admin_save_project_editorial(uuid,uuid,bigint,jsonb,uuid[],text[],text)', 'EXECUTE'),
  'anonymous clients cannot invoke editorial write RPCs');
select ok(not has_function_privilege('authenticated', 'public.admin_verify_project_license(uuid,uuid,bigint,timestamptz,text,text,text,boolean)', 'EXECUTE'),
  'ordinary authenticated clients cannot verify licenses');
select ok(not has_function_privilege('authenticated', 'public.admin_verify_project_quality(uuid,uuid,bigint,timestamptz,text,boolean)', 'EXECUTE'),
  'ordinary authenticated clients cannot verify quality');

set local "request.jwt.claims" = '{"role":"service_role"}';
select throws_ok(
  $$select public.admin_publish_project(
    '00000000-0000-4000-8000-000000000099',
    '00000000-0000-4000-8000-000000000098', 0, 'A sufficiently long attempted publication reason.')$$,
  '42501', null, 'service role must still identify a currently allowlisted administrator'
);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000097', 'authenticated', 'authenticated',
  'editorial-audit-test@example.com', '', now(), now(), now());
insert into public.admin_users (user_id) values ('00000000-0000-4000-8000-000000000097');
insert into public.projects (id, slug, name, summary, publication_status)
values ('00000000-0000-4000-8000-000000000096', 'editorial-audit-fixture', 'Audit Fixture',
  'A sufficiently clear fixture summary.', 'pending_review');
insert into public.editorial_decisions (
  project_id, actor_user_id, action, previous_state, resulting_state, evidence, reason, resulting_revision
) values (
  '00000000-0000-4000-8000-000000000096', '00000000-0000-4000-8000-000000000097',
  'keep_pending', 'pending_review', 'pending_review', '{}'::jsonb,
  'Keep the project pending for an audit test.', 0
);
select throws_ok(
  $$update public.editorial_decisions set reason = 'changed' where project_id = '00000000-0000-4000-8000-000000000096'$$,
  '42501', 'editorial decisions are append-only', 'audit rows cannot be updated'
);
select throws_ok(
  $$delete from public.editorial_decisions where project_id = '00000000-0000-4000-8000-000000000096'$$,
  '42501', 'editorial decisions are append-only', 'audit rows cannot be deleted'
);

select * from finish();
rollback;
