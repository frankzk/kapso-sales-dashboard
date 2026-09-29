-- Release gate AFTER 0198, BEFORE the new application. Read-only; no PII output.
-- Run as a database owner with visibility of every store, never an end-user JWT.
-- This deliberately checks all history once; do not run it on every page/request.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/master_read_scaling_preflight.sql
begin isolation level repeatable read read only;
set local lock_timeout = '3s';
set local statement_timeout = '120s';
set local application_name = 'master-scaling-preflight';

do $gate$
declare
  expected record;
  relation_oid oid;
begin
  if current_setting('server_version_num')::int < 160000
    or current_setting('max_prepared_transactions')::int <> 0 then
    raise exception 'Master counter backend-slot prerequisites not satisfied';
  end if;
  if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Preflight requires an administrative role with full-store visibility';
  end if;

  for expected in select * from (values
    ('order_master_store_created_page_idx', 'order_master'),
    ('order_master_stage_created_page_idx', 'order_master'),
    ('order_master_substage_created_page_idx', 'order_master'),
    ('leads_order_id_idx', 'leads')
  ) e(index_name, table_name)
  loop
    if not exists (
      select 1 from pg_index i
      join pg_class idx on idx.oid = i.indexrelid
      join pg_namespace n on n.oid = idx.relnamespace
      where n.nspname = 'public' and idx.relname = expected.index_name
        and i.indrelid = to_regclass('public.' || expected.table_name)
        and i.indisvalid and i.indisready
    ) then raise exception 'Required Master index missing or invalid: %', expected.index_name;
    end if;
  end loop;

  for expected in select * from (values
    ('order_master_read_insert', 4),
    ('order_master_read_update', 16),
    ('order_master_read_delete', 8)
  ) e(trigger_name, trigger_type)
  loop
    if not exists (
      select 1 from pg_trigger t
      where t.tgrelid = 'public.order_master'::regclass
        and t.tgname = expected.trigger_name and not t.tgisinternal
        and t.tgenabled in ('O', 'A') and t.tgtype = expected.trigger_type
        and t.tgfoid = 'public.maintain_order_master_read_totals()'::regprocedure
    ) then raise exception 'Required Master maintenance trigger missing or disabled: %', expected.trigger_name;
    end if;
  end loop;

  for expected in select * from (values
    ('order_master_stage_parts'), ('order_master_facet_parts')
  ) e(table_name)
  loop
    relation_oid := to_regclass('public.' || expected.table_name);
    if relation_oid is null or not exists (
      select 1 from pg_class where oid = relation_oid and relrowsecurity
    ) then raise exception 'Master summary table missing or RLS disabled'; end if;
    if not has_table_privilege('authenticated', relation_oid, 'SELECT')
      or not has_table_privilege('service_role', relation_oid, 'SELECT')
      or not exists (
        select 1 from pg_policy p where p.polrelid = relation_oid
          and p.polname = expected.table_name || '_select' and p.polcmd = 'r'
          and (select oid from pg_roles where rolname = 'authenticated') = any(p.polroles)
      ) then raise exception 'Required summary read grant or policy missing'; end if;
    if has_table_privilege('authenticated', relation_oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
      or has_table_privilege('service_role', relation_oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
      or has_table_privilege('anon', relation_oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
      raise exception 'Unexpected direct permissions on Master summaries';
    end if;
  end loop;

  for expected in select * from (values
    ('order_master_stage_totals'), ('order_master_facet_totals')
  ) e(view_name)
  loop
    relation_oid := to_regclass('public.' || expected.view_name);
    if relation_oid is null or not exists (
      select 1 from pg_class where oid=relation_oid and relkind='v'
        and coalesce(reloptions,'{}') @> array['security_invoker=true']
    ) then raise exception 'Required Master invoker view missing or unsafe'; end if;
    if not has_table_privilege('authenticated',relation_oid,'SELECT')
      or not has_table_privilege('service_role',relation_oid,'SELECT') then
      raise exception 'Required summary read grant or policy missing';
    end if;
    if has_table_privilege('authenticated',relation_oid,'INSERT,UPDATE,DELETE,TRUNCATE')
      or has_table_privilege('service_role',relation_oid,'INSERT,UPDATE,DELETE,TRUNCATE')
      or has_table_privilege('anon',relation_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
      raise exception 'Unexpected direct permissions on Master summaries';
    end if;
  end loop;

  if exists (
    with expected_counts as (
      select store_id, macro_stage, macro_substage, count(*)::bigint as total
      from public.order_master group by store_id, macro_stage, macro_substage
    ), actual as (
      select store_id, macro_stage, macro_substage, total from public.order_master_stage_totals
    )
    (select * from expected_counts except select * from actual)
    union all (select * from actual except select * from expected_counts)
  ) then raise exception 'Master stage totals differ from source; do not deploy'; end if;

  if exists (
    with expected_counts as (
      select m.store_id, v.dimension, v.value, count(*)::bigint as total
      from public.order_master m
      cross join lateral (
        select distinct dimension, value from (values
          ('operational', m.operational_status),
          ('courier', m.current_courier), ('courier', m.last_courier),
          ('region', m.region), ('province', m.province), ('district', m.district),
          ('coverage', m.coverage), ('pickup', m.pickup_state)
        ) source_values(dimension, value) where value is not null
      ) v group by m.store_id, v.dimension, v.value
    ), actual as (
      select store_id, dimension, value, total from public.order_master_facet_totals
    )
    (select * from expected_counts except select * from actual)
    union all (select * from actual except select * from expected_counts)
  ) then raise exception 'Master facet totals differ from source; do not deploy'; end if;
end;
$gate$;

select 'Master read scaling preflight passed' as result;
commit;
