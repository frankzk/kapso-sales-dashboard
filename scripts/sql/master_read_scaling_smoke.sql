-- THROWAWAY database only, after all migrations + test_prelude.sql.
-- Self-contained fixtures; everything, including the reapplication, rolls back.
begin;

insert into auth.users(id,email) values
  ('01570000-0000-4000-8000-000000000021','master-scaling-viewer@test.invalid'),
  ('01570000-0000-4000-8000-000000000022','master-scaling-owner@test.invalid'),
  ('01570000-0000-4000-8000-000000000023','master-scaling-no-access@test.invalid');
insert into organizations(id,name) values
  ('01570000-0000-4000-8000-000000000001','Master scaling smoke');
insert into stores(id,org_id,name,shopify_domain) values
  ('01570000-0000-4000-8000-000000000011','01570000-0000-4000-8000-000000000001','Scaling A','scaling-a.test.invalid'),
  ('01570000-0000-4000-8000-000000000012','01570000-0000-4000-8000-000000000001','Scaling B','scaling-b.test.invalid'),
  ('01570000-0000-4000-8000-000000000013','01570000-0000-4000-8000-000000000001','Scaling cascade','scaling-c.test.invalid');
insert into user_store_access(user_id,store_id) values
  ('01570000-0000-4000-8000-000000000021','01570000-0000-4000-8000-000000000011');
insert into memberships(user_id,org_id,role) values
  ('01570000-0000-4000-8000-000000000022','01570000-0000-4000-8000-000000000001','owner'),
  ('01570000-0000-4000-8000-000000000023','01570000-0000-4000-8000-000000000001','viewer');

create function pg_temp.assert_master_read_scaling(p_ids uuid[])
returns void language plpgsql as $test$
declare
  expected_facets jsonb;
  actual_facets jsonb;
begin
  -- Check reference COUNTS, not just distinct values: this detects a drift
  -- hidden until the last order for a facet is deleted.
  if exists (
    with expected as (
      select store_id, macro_stage, macro_substage, count(*)::bigint as total
      from public.order_master where store_id = any(p_ids)
      group by store_id, macro_stage, macro_substage
    ), actual as (
      select store_id, macro_stage, macro_substage, total
      from public.order_master_stage_totals where store_id = any(p_ids)
    )
    (select * from expected except select * from actual)
    union all (select * from actual except select * from expected)
  ) then raise exception 'Master stage aggregate parity failed'; end if;

  if exists (
    with expected as (
      select macro_stage, macro_substage, count(*)::bigint as total
      from public.order_master where store_id = any(p_ids)
      group by macro_stage, macro_substage
    ), actual as (select * from public.order_master_mom_counts(p_ids))
    (select * from expected except select * from actual)
    union all (select * from actual except select * from expected)
  ) then raise exception 'Master stage RPC parity failed'; end if;

  if exists (
    with expected as (
      select m.store_id, v.dimension, v.value, count(*)::bigint as total
      from public.order_master m
      cross join lateral (
        select distinct dimension, value from (values
          ('operational', m.operational_status),
          ('courier', m.current_courier), ('courier', m.last_courier),
          ('region', m.region), ('province', m.province), ('district', m.district),
          ('coverage', m.coverage), ('pickup', m.pickup_state)
        ) vals(dimension,value) where value is not null
      ) v
      where m.store_id = any(p_ids)
      group by m.store_id, v.dimension, v.value
    ), actual as (
      select store_id, dimension, value, total
      from public.order_master_facet_totals where store_id = any(p_ids)
    )
    (select * from expected except select * from actual)
    union all (select * from actual except select * from expected)
  ) then raise exception 'Master facet reference parity failed'; end if;

  -- The original RPC's null and distinct semantics, independently constructed
  -- from source columns rather than from the new aggregate table.
  with source_values as (
    select 'operational' as dimension, operational_status as value from public.order_master where store_id = any(p_ids)
    union select 'courier', current_courier from public.order_master where store_id = any(p_ids)
    union select 'courier', last_courier from public.order_master where store_id = any(p_ids)
    union select 'region', region from public.order_master where store_id = any(p_ids)
    union select 'province', province from public.order_master where store_id = any(p_ids)
    union select 'district', district from public.order_master where store_id = any(p_ids)
    union select 'coverage', coverage from public.order_master where store_id = any(p_ids)
    union select 'pickup', pickup_state from public.order_master where store_id = any(p_ids)
  )
  select jsonb_object_agg(d.dimension, coalesce((
    select jsonb_agg(s.value order by s.value) from source_values s
    where s.dimension = d.dimension and s.value is not null
  ), '[]'::jsonb)) into expected_facets
  from (values ('operational'), ('courier'), ('region'), ('province'),
    ('district'), ('coverage'), ('pickup')) d(dimension);
  actual_facets := public.master_facets(p_ids);
  if actual_facets is distinct from expected_facets then
    raise exception 'Master facet RPC parity failed (role %, uid %): % vs %', current_user, auth.uid(), actual_facets, expected_facets;
  end if;
end;
$test$;

-- Include repeated/null/empty facets, two couriers on one row, and the same
-- courier in both columns. The latter must contribute ONE reference per order.
insert into orders(id,store_id,shopify_order_id,created_at)
select ('01570000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  case when n = 104 then '01570000-0000-4000-8000-000000000012'::uuid
       when n = 106 then '01570000-0000-4000-8000-000000000013'::uuid
       else '01570000-0000-4000-8000-000000000011'::uuid end,
  'scaling-' || n, now()
from generate_series(101,109) n;
insert into order_master(order_id,store_id,shopify_order_id,macro_stage,macro_substage,
  current_courier,last_courier,region,province,district,pickup_state)
select o.id,o.store_id,o.shopify_order_id,v.stage,v.substage,
  v.courier,v.last_courier,v.region,v.province,v.district,v.pickup
from (values
  ('scaling-101','por_confirmar','sin_llamar','aliclik','aliclik','Visible',null,'',null),
  ('scaling-102','por_confirmar','sin_llamar',null,'aliclik',null,null,'Visible district',null),
  ('scaling-103','en_curso','en_transito','shalom','aliclik','Visible','Visible province',null,'en_transito'),
  ('scaling-104','finalizado','historico','secret_courier',null,'Secret region',null,null,null),
  ('scaling-105','preparacion','por_armar',null,null,null,null,null,null),
  ('scaling-106','por_confirmar','sin_llamar','cascade_courier',null,null,null,null,null)
) v(order_code,stage,substage,courier,last_courier,region,province,district,pickup)
join orders o on o.shopify_order_id = v.order_code
  and o.store_id in ('01570000-0000-4000-8000-000000000011','01570000-0000-4000-8000-000000000012','01570000-0000-4000-8000-000000000013');

select pg_temp.assert_master_read_scaling(array[
  '01570000-0000-4000-8000-000000000011'::uuid,
  '01570000-0000-4000-8000-000000000012'::uuid,
  '01570000-0000-4000-8000-000000000013'::uuid]);
select pg_temp.assert_master_read_scaling('{}'::uuid[]);

-- No-effect source updates must not rewrite aggregate rows (ctid catches
-- writes even when all these statements share the same transaction xid).
create temp table totals_before as
  select 'stage' as kind, ctid::text as row_pointer, to_jsonb(t) as row_value
  from public.order_master_stage_parts t
  union all select 'facet',ctid::text,to_jsonb(t) from public.order_master_facet_parts t;
update order_master set comment_count = comment_count + 1
where store_id in ('01570000-0000-4000-8000-000000000011','01570000-0000-4000-8000-000000000012');
do $test$ begin
  if exists (
    with after_totals as (
      select 'stage' as kind,ctid::text as row_pointer,to_jsonb(t) as row_value from public.order_master_stage_parts t
      union all select 'facet',ctid::text,to_jsonb(t) from public.order_master_facet_parts t
    )
    (select * from totals_before except select * from after_totals)
    union all (select * from after_totals except select * from totals_before)
  ) then raise exception 'Irrelevant source update rewrote Master aggregates'; end if;
end $test$;

-- Multi-row change: merge old stage buckets, add/remove facet references.
update order_master set macro_stage = 'preparacion', macro_substage = 'por_armar',
  region = 'Changed region', current_courier = 'fenix', last_courier = null,
  pickup_state = null
where shopify_order_id in ('scaling-101','scaling-102');
-- Store move exercises subtraction from one tenant and addition to another.
update order_master set store_id = '01570000-0000-4000-8000-000000000012'
where shopify_order_id = 'scaling-103';
update orders set store_id = '01570000-0000-4000-8000-000000000012'
where shopify_order_id = 'scaling-103';
select pg_temp.assert_master_read_scaling(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);

-- A mixed upsert fires both transition-table triggers; each source row must
-- contribute once, whether inserted or updated.
insert into order_master(order_id,store_id,shopify_order_id,current_courier)
select id,store_id,shopify_order_id,'upsert_courier' from orders
where shopify_order_id in ('scaling-101','scaling-107')
on conflict(order_id) do update set current_courier = excluded.current_courier;
select pg_temp.assert_master_read_scaling(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);

-- Requested store IDs are not authorization. Both RPCs and direct aggregate
-- reads must respect the same RLS as order_master.
set request.test_uid = '01570000-0000-4000-8000-000000000021';
set role authenticated;
select pg_temp.assert_master_read_scaling(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);
do $test$ begin
  if exists(select 1 from public.order_master_mom_counts(array['01570000-0000-4000-8000-000000000012'::uuid])) then
    raise exception 'Stage RPC leaked unauthorized store';
  end if;
  if public.master_facets(array['01570000-0000-4000-8000-000000000012'::uuid]) -> 'courier' <> '[]'::jsonb then
    raise exception 'Facet RPC leaked unauthorized store';
  end if;
  if exists(select 1 from public.order_master_stage_totals where store_id = '01570000-0000-4000-8000-000000000012')
    or exists(select 1 from public.order_master_facet_totals where store_id = '01570000-0000-4000-8000-000000000012') then
    raise exception 'Aggregate table leaked unauthorized store';
  end if;
  if has_table_privilege(current_user,'public.order_master_stage_totals','UPDATE')
    or has_table_privilege(current_user,'public.order_master_facet_totals','INSERT') then
    raise exception 'Authenticated can mutate Master aggregates';
  end if;
end $test$;
reset role;
set request.test_uid = '01570000-0000-4000-8000-000000000022';
set role authenticated;
select pg_temp.assert_master_read_scaling(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);
reset role;
set request.test_uid = '01570000-0000-4000-8000-000000000023';
set role authenticated;
do $test$ begin
  if exists(select 1 from public.order_master_mom_counts(array['01570000-0000-4000-8000-000000000011'::uuid])) then
    raise exception 'Viewer without grants received counts';
  end if;
  if public.master_facets(array['01570000-0000-4000-8000-000000000011'::uuid]) -> 'region' <> '[]'::jsonb then
    raise exception 'Viewer without grants received facets';
  end if;
end $test$;
reset role;
do $test$ begin
  if has_function_privilege('anon','public.master_facets(uuid[])','EXECUTE')
    or has_function_privilege('anon','public.order_master_mom_counts(uuid[])','EXECUTE')
    or has_function_privilege('authenticated','public.maintain_order_master_read_totals()','EXECUTE') then
    raise exception 'Unexpected public access to Master aggregate functions';
  end if;
end $test$;

-- Simulate a pre-migration row and reapply over populated tables. This verifies
-- the backfill and guards against double counting on repeated installation.
alter table order_master disable trigger order_master_read_insert;
insert into order_master(order_id,store_id,shopify_order_id,region)
select id,store_id,shopify_order_id,'Backfilled region' from orders where shopify_order_id = 'scaling-108';
\ir ../../db/migrations/0202_master_read_scaling.sql
select pg_temp.assert_master_read_scaling(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);
insert into order_master(order_id,store_id,shopify_order_id,region)
select id,store_id,shopify_order_id,'After reinstall' from orders where shopify_order_id = 'scaling-109';
select pg_temp.assert_master_read_scaling(array['01570000-0000-4000-8000-000000000011'::uuid]);

-- Production writes use service_role. It has no direct aggregate write grant;
-- the restricted SECURITY DEFINER trigger still updates both tables atomically.
set role service_role;
update order_master set current_courier = 'service_courier'
where shopify_order_id = 'scaling-109';
reset role;
select pg_temp.assert_master_read_scaling(array['01570000-0000-4000-8000-000000000011'::uuid]);

-- Failed transactions must roll back source and aggregate deltas together.
-- Preserve 0186's partial rider visibility, including direct source reads and
-- both legacy RPCs. Store-wide views must not expose other customers to riders.
insert into auth.users(id,email) values
  ('01570000-0000-4000-8000-000000000024','master-rider@test.invalid');
insert into riders(id,org_id,full_name,user_id) values
  ('01570000-0000-4000-8000-000000000025','01570000-0000-4000-8000-000000000001',
   'Synthetic rider','01570000-0000-4000-8000-000000000024');
insert into delivery_routes(id,org_id,store_id,rider_id,route_date,status) values
  ('01570000-0000-4000-8000-000000000026','01570000-0000-4000-8000-000000000001',
   '01570000-0000-4000-8000-000000000011','01570000-0000-4000-8000-000000000025','2026-09-28','en_curso');
insert into delivery_stops(route_id,order_id)
  select '01570000-0000-4000-8000-000000000026',id from orders where shopify_order_id='scaling-109';
-- The same order can appear in multiple historical routes; IN/RLS counts it once.
insert into delivery_routes(id,org_id,store_id,rider_id,route_date,status) values
  ('01570000-0000-4000-8000-000000000027','01570000-0000-4000-8000-000000000001',
   '01570000-0000-4000-8000-000000000011','01570000-0000-4000-8000-000000000025','2026-09-27','cerrada');
insert into delivery_stops(route_id,order_id)
  select '01570000-0000-4000-8000-000000000027',id from orders where shopify_order_id='scaling-109';
set request.test_uid='01570000-0000-4000-8000-000000000024';
set role authenticated;
do $rider$ declare stores uuid[] := array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid];
begin
  if (select count(*) from order_master where store_id=any(stores)) <> 1
    or (select sum(total) from order_master_mom_counts(stores)) is distinct from 1::numeric
    or master_facets(stores)->'courier' <> '["service_courier"]'::jsonb then
    raise exception 'Rider partial-order RPC visibility changed';
  end if;
  if exists(select 1 from order_master_stage_totals where store_id=any(stores))
    or exists(select 1 from order_master_facet_parts where store_id=any(stores)) then
    raise exception 'Store-wide summaries leaked to a rider';
  end if;
end $rider$;
reset role;

do $test$ begin
  begin
    update order_master set region = 'Must roll back' where shopify_order_id = 'scaling-109';
    raise exception using errcode = 'P0157', message = 'rollback probe';
  exception when sqlstate 'P0157' then null;
  end;
  perform pg_temp.assert_master_read_scaling(array['01570000-0000-4000-8000-000000000011'::uuid]);
  if exists(select 1 from public.order_master_facet_totals where value = 'Must roll back') then
    raise exception 'Rolled-back facet delta survived';
  end if;
end $test$;

-- Single then multi-row deletes remove the final reference and zero buckets.
delete from order_master where shopify_order_id = 'scaling-101';
select pg_temp.assert_master_read_scaling(array['01570000-0000-4000-8000-000000000011'::uuid]);
delete from order_master where store_id = '01570000-0000-4000-8000-000000000011';
select pg_temp.assert_master_read_scaling(array[
  '01570000-0000-4000-8000-000000000011'::uuid,'01570000-0000-4000-8000-000000000012'::uuid]);
delete from stores where id = '01570000-0000-4000-8000-000000000013';
select pg_temp.assert_master_read_scaling(array['01570000-0000-4000-8000-000000000013'::uuid]);

rollback;
\echo 'master_read_scaling: mutation/backfill/reapply/rollback/RLS parity OK'
