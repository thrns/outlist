-- M1-10: keep the read-only pipeline report aligned with the complete launch schema.
-- The previous report stopped at M1-07 and made M1-08/M1-09 databases appear incomplete.

alter function public.pipeline_operator_report() rename to pipeline_operator_report_v2;
revoke all on function public.pipeline_operator_report_v2() from public, anon, authenticated, service_role;

create function public.pipeline_operator_report()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_report jsonb;
  v_schema jsonb;
  v_expected text[] := array[
    '20261104100000', '20261104100100', '20261104100200', '20261104100300',
    '20261104100400', '20261104100500', '20261105100000', '20261105110000',
    '20261105120000', '20261105130000', '20261106100000', '20261106110000',
    '20261107120000', '20261107130000', '20261107140000', '20261107150000',
    '20261107160000', '20261108120000', '20261108130000', '20261108140000'
  ];
  v_applied text[] := array[]::text[];
  v_missing text[] := array[]::text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  v_report := public.pipeline_operator_report_v2();
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select coalesce(array_agg(version::text order by version::text), array[]::text[]) from supabase_migrations.schema_migrations where version::text = any($1)'
      into v_applied using v_expected;
  end if;
  select coalesce(array_agg(expected.version order by expected.version), array[]::text[])
    into v_missing
  from unnest(v_expected) expected(version)
  where not (expected.version = any(v_applied));

  v_schema := v_report->'schema';
  v_schema := jsonb_set(v_schema, '{expected_migrations}', to_jsonb(v_expected), true);
  v_schema := jsonb_set(v_schema, '{applied_migrations}', to_jsonb(v_applied), true);
  v_schema := jsonb_set(v_schema, '{missing_migrations}', to_jsonb(v_missing), true);
  v_schema := jsonb_set(v_schema, '{ready}',
    to_jsonb(coalesce((v_schema->>'ready')::boolean, false)
      and cardinality(v_missing) = 0
      and to_regclass('supabase_migrations.schema_migrations') is not null), true);
  v_report := jsonb_set(v_report, '{report_version}', '"m1-10-v3"'::jsonb, true);
  v_report := jsonb_set(v_report, '{schema}', v_schema, true);
  return v_report;
end;
$function$;

revoke all on function public.pipeline_operator_report() from public, anon, authenticated;
grant execute on function public.pipeline_operator_report() to service_role;
