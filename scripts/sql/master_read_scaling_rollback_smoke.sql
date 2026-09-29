-- THROWAWAY database only: apply the real migrations THROUGH 0197 first.
-- This smoke intentionally commits: rollback.sql owns its atomic transaction.
-- The PGlite caller destroys the isolated in-memory database afterward.
create temp table rollback_legacy_definitions as
select oid::regprocedure::text as signature, pg_get_functiondef(oid) as definition
from pg_proc where oid in (
  'public.order_master_mom_counts(uuid[])'::regprocedure,
  'public.master_facets(uuid[])'::regprocedure
);
do $test$ begin
  if exists (select 1 from rollback_legacy_definitions
    where definition like '%order_master_stage_totals%'
       or definition like '%order_master_facet_totals%') then
    raise exception 'Rollback smoke must start on migrations through 0197';
  end if;
end $test$;

\ir ../../db/migrations/0198_master_read_scaling.sql

insert into auth.users(id,email) values
  ('01570000-0000-4000-8000-000000000021','rollback-viewer@test.invalid'),
  ('01570000-0000-4000-8000-000000000022','rollback-no-access@test.invalid');
insert into organizations(id,name) values
  ('01570000-0000-4000-8000-000000000001','Rollback smoke');
insert into stores(id,org_id,name,shopify_domain) values
  ('01570000-0000-4000-8000-000000000011','01570000-0000-4000-8000-000000000001','Rollback A','rollback-a.test.invalid'),
  ('01570000-0000-4000-8000-000000000012','01570000-0000-4000-8000-000000000001','Rollback B','rollback-b.test.invalid');
insert into user_store_access(user_id,store_id) values
  ('01570000-0000-4000-8000-000000000021','01570000-0000-4000-8000-000000000011');
insert into orders(id,store_id,shopify_order_id)
select ('01570000-0000-4000-9000-' || lpad(n::text,12,'0'))::uuid,
  case when n = 3 then '01570000-0000-4000-8000-000000000012'::uuid
    else '01570000-0000-4000-8000-000000000011'::uuid end,
  'rollback-' || n from generate_series(1,5) n;
insert into order_master(order_id,store_id,shopify_order_id,region,current_courier,last_courier)
select id,store_id,shopify_order_id,
  case when shopify_order_id = 'rollback-3' then 'Secret region' else 'Visible region' end,
  'same_courier','same_courier' from orders where shopify_order_id in ('rollback-1','rollback-2','rollback-3');

create function pg_temp.assert_rollback_rpc(p_ids uuid[]) returns void
language plpgsql as $test$
declare expected_facets jsonb;
begin
  if exists (
    with expected as (
      select macro_stage,macro_substage,count(*)::bigint as total
      from public.order_master where store_id = any(p_ids)
      group by macro_stage,macro_substage
    ), actual as (select * from public.order_master_mom_counts(p_ids))
    (select * from expected except select * from actual)
    union all (select * from actual except select * from expected)
  ) then raise exception 'Rollback MOM RPC parity failed'; end if;

  with source_values as (
    select distinct v.dimension,v.value from public.order_master m
    cross join lateral (values
      ('operational',m.operational_status),('courier',m.current_courier),('courier',m.last_courier),
      ('region',m.region),('province',m.province),('district',m.district),
      ('coverage',m.coverage),('pickup',m.pickup_state)
    ) v(dimension,value) where m.store_id = any(p_ids) and v.value is not null
  )
  select jsonb_object_agg(d.dimension,coalesce((
    select jsonb_agg(s.value order by s.value) from source_values s where s.dimension = d.dimension
  ),'[]'::jsonb)) into expected_facets
  from (values ('operational'),('courier'),('region'),('province'),('district'),('coverage'),('pickup')) d(dimension);
  if public.master_facets(p_ids) is distinct from expected_facets then
    raise exception 'Rollback facets RPC parity failed';
  end if;
end;
$test$;

create function pg_temp.assert_rebuilt_totals() returns void
language plpgsql as $test$
begin
  if exists (
    with expected as (
      select store_id,macro_stage,macro_substage,count(*)::bigint as total
      from public.order_master group by store_id,macro_stage,macro_substage
    ), actual as (select * from public.order_master_stage_totals)
    (select * from expected except select * from actual)
    union all (select * from actual except select * from expected)
  ) then raise exception 'Rebuilt MOM summaries do not match source'; end if;
  if exists (
    with expected as (
      select m.store_id,v.dimension,v.value,count(*)::bigint as total
      from public.order_master m cross join lateral (
        select distinct dimension,value from (values
          ('operational',m.operational_status),('courier',m.current_courier),('courier',m.last_courier),
          ('region',m.region),('province',m.province),('district',m.district),
          ('coverage',m.coverage),('pickup',m.pickup_state)
        ) v(dimension,value) where value is not null
      ) v group by m.store_id,v.dimension,v.value
    ), actual as (select * from public.order_master_facet_totals)
    (select * from expected except select * from actual)
    union all (select * from actual except select * from expected)
  ) then raise exception 'Rebuilt facet summaries do not match source'; end if;
end;
$test$;

create temp table rollback_preserved_objects as
select 'trigger' as kind,oid::text as object_id,pg_get_triggerdef(oid) as definition
from pg_trigger where tgrelid = 'public.order_master'::regclass and not tgisinternal
  and tgname not in ('order_master_read_insert','order_master_read_update','order_master_read_delete')
union all
select 'index',indexrelid::text,pg_get_indexdef(indexrelid) from pg_index
where indrelid in ('public.order_master'::regclass,'public.leads'::regclass);
create temp table rollback_source_before as select to_jsonb(m) as value from public.order_master m;
create temp table rollback_summaries_before as
select 'stage' as kind,to_jsonb(t) as value from public.order_master_stage_totals t
union all select 'facet',to_jsonb(t) from public.order_master_facet_totals t;

\ir master_read_scaling_rollback.sql

do $test$ begin
  if exists (select 1 from rollback_legacy_definitions d
    where pg_get_functiondef(d.signature::regprocedure) is distinct from d.definition) then
    raise exception 'Rollback did not restore exact legacy RPC definitions';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.order_master'::regclass
    and tgname in ('order_master_read_insert','order_master_read_update','order_master_read_delete')) then
    raise exception 'Maintenance trigger remains after rollback';
  end if;
  if exists (
    with current_objects as (
      select 'trigger' as kind,oid::text as object_id,pg_get_triggerdef(oid) as definition
      from pg_trigger where tgrelid = 'public.order_master'::regclass and not tgisinternal
      union all select 'index',indexrelid::text,pg_get_indexdef(indexrelid)
      from pg_index where indrelid in ('public.order_master'::regclass,'public.leads'::regclass)
    )
    (select * from rollback_preserved_objects except select * from current_objects)
    union all (select * from current_objects except select * from rollback_preserved_objects)
  ) then raise exception 'Rollback changed another trigger or index'; end if;
  if exists (
    (select value from rollback_source_before except select to_jsonb(m) from public.order_master m)
    union all (select to_jsonb(m) from public.order_master m except select value from rollback_source_before)
  ) then raise exception 'Rollback changed source orders'; end if;
  if has_function_privilege('anon','public.order_master_mom_counts(uuid[])','EXECUTE')
    or has_function_privilege('anon','public.master_facets(uuid[])','EXECUTE') then
    raise exception 'Rollback reopened anonymous RPC execution';
  end if;
  if exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) a
    where p.oid in ('public.master_facets(uuid[])'::regprocedure,'public.order_master_mom_counts(uuid[])'::regprocedure)
      and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'Rollback reopened PUBLIC RPC execution';
  end if;
end $test$;

-- Real application writer role: changing source data must succeed even though
-- summary rows remain deliberately stale, and RPCs must immediately reflect it.
set role service_role;
select pg_temp.assert_rollback_rpc(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);
insert into order_master(order_id,store_id,shopify_order_id,region,current_courier)
select id,store_id,shopify_order_id,'New after rollback','new_courier' from orders where shopify_order_id = 'rollback-4';
update order_master set macro_stage = 'preparacion',macro_substage = 'por_armar',region = '',last_courier = null
where shopify_order_id = 'rollback-1';
delete from order_master where shopify_order_id = 'rollback-2';
select pg_temp.assert_rollback_rpc(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);
reset role;

do $test$ begin
  if exists (
    with current_summaries as (
      select 'stage' as kind,to_jsonb(t) as value from public.order_master_stage_totals t
      union all select 'facet',to_jsonb(t) from public.order_master_facet_totals t
    )
    (select * from rollback_summaries_before except select * from current_summaries)
    union all (select * from current_summaries except select * from rollback_summaries_before)
  ) then raise exception 'Disabled maintenance still changed summary rows'; end if;
end $test$;

set request.test_uid = '01570000-0000-4000-8000-000000000021';
set role authenticated;
select pg_temp.assert_rollback_rpc(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);
do $test$ begin
  if (select sum(total) from public.order_master_mom_counts(array[
    '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid])) <> 2 then
    raise exception 'Viewer received another store count';
  end if;
  if public.master_facets(array['01570000-0000-4000-8000-000000000012'::uuid])->'region' <> '[]'::jsonb then
    raise exception 'Viewer received another store facets';
  end if;
end $test$;
reset role;
set request.test_uid = '01570000-0000-4000-8000-000000000022';
set role authenticated;
select pg_temp.assert_rollback_rpc(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);
reset role;

-- Rollback is repeatable. Reinstallation repairs deliberately stale summaries
-- and reinstates maintenance without replaying or deleting operational orders.
\ir master_read_scaling_rollback.sql
\ir ../../db/migrations/0198_master_read_scaling.sql
select pg_temp.assert_rebuilt_totals();
set role service_role;
insert into order_master(order_id,store_id,shopify_order_id,region)
select id,store_id,shopify_order_id,'After reinstall' from orders where shopify_order_id = 'rollback-5';
reset role;
select pg_temp.assert_rebuilt_totals();
select pg_temp.assert_rollback_rpc(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);
\echo 'master_read_scaling_rollback: legacy definitions, data preservation, source reads, RLS, repeat/reinstall OK'
