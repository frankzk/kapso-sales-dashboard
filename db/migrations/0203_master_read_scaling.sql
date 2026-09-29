-- 0203 — Master: exact counts and facet values without reading order history.
--
-- The aggregates below are derived data. Every change to order_master updates
-- them in the SAME transaction; a read never sees the order without its delta.
-- Each PostgreSQL backend writes its own counter partition. Backend slots are
-- unique among live sessions and are reused after disconnect (PostgreSQL 16+).
-- This prevents counter locks between independent writers, including mixed
-- UPSERT and multi-statement transactions. The public views sum signed parts
-- in the reader's MVCC snapshot: no asynchronous lag or background job.
-- The number of parts per key is bounded by backend slots, not order history.
-- Historical distinct facet values can leave cancelling parts; reinstallation
-- compacts them. Facet cardinality still requires monitoring/normalization.
--
-- PRODUCTION: first build these four indexes separately with CREATE INDEX
-- CONCURRENTLY (outside a transaction), using the definitions at the bottom.
-- Then apply this file. The installation/backfill DO block is atomic and takes
-- SHARE ROW EXCLUSIVE on order_master: SELECT remains available, but writers
-- wait while the initial historical scan runs. Schedule that one-time scan in
-- a quiet window. Reapplying repairs derived totals under the same lock; it
-- never changes orders or operational facts. Do not TRUNCATE order_master:
-- statement DELETE triggers maintain the aggregates, TRUNCATE does not.

do $requirements$ begin
  if current_setting('server_version_num')::int < 160000 then
    raise exception 'Master counters require PostgreSQL 16+ stable backend slots';
  end if;
  if current_setting('max_prepared_transactions')::int <> 0 then
    raise exception 'Master counters require max_prepared_transactions=0: a prepared transaction could outlive its backend slot';
  end if;
  if exists(select 1 from pg_class where oid in (
    to_regclass('public.order_master_stage_totals'),to_regclass('public.order_master_facet_totals')) and relkind <> 'v') then
    raise exception 'Earlier unpublished counter candidate installed: restore previous application and migrate derived objects explicitly';
  end if;
end $requirements$;

create table if not exists public.order_master_stage_parts (
  store_id uuid not null references public.stores(id) on delete cascade,
  writer_slot integer not null check (writer_slot >= -1),
  macro_stage text not null,
  macro_substage text not null,
  total bigint not null,
  primary key (store_id, writer_slot, macro_stage, macro_substage)
);

create table if not exists public.order_master_facet_parts (
  store_id uuid not null references public.stores(id) on delete cascade,
  writer_slot integer not null check (writer_slot >= -1),
  dimension text not null check (dimension in (
    'operational', 'courier', 'region', 'province', 'district', 'coverage', 'pickup'
  )),
  value text not null,
  total bigint not null,
  primary key (store_id, writer_slot, dimension, value)
);

alter table public.order_master_stage_parts enable row level security;
alter table public.order_master_facet_parts enable row level security;
drop policy if exists order_master_stage_parts_select on public.order_master_stage_parts;
create policy order_master_stage_parts_select on public.order_master_stage_parts
  for select to authenticated using (store_id in (select public.auth_store_ids()));
drop policy if exists order_master_facet_parts_select on public.order_master_facet_parts;
create policy order_master_facet_parts_select on public.order_master_facet_parts
  for select to authenticated using (store_id in (select public.auth_store_ids()));

-- Even service_role writes the source, never the derived counters directly.
revoke all on public.order_master_stage_parts, public.order_master_facet_parts
  from public, anon, authenticated, service_role;
grant select on public.order_master_stage_parts, public.order_master_facet_parts
  to authenticated, service_role;

-- Invoker views preserve the previous API shape AND the caller's store RLS.
-- Parts may be negative: a different writer can decrement the writer that
-- originally inserted an order. Only their sum is a business count.
create or replace view public.order_master_stage_totals with (security_invoker=true) as
  select store_id,macro_stage,macro_substage,sum(total)::bigint as total
  from public.order_master_stage_parts group by store_id,macro_stage,macro_substage
  having sum(total) <> 0;
create or replace view public.order_master_facet_totals with (security_invoker=true) as
  select store_id,dimension,value,sum(total)::bigint as total
  from public.order_master_facet_parts group by store_id,dimension,value
  having sum(total) <> 0;
revoke all on public.order_master_stage_totals,public.order_master_facet_totals
  from public,anon,authenticated,service_role;
grant select on public.order_master_stage_totals,public.order_master_facet_totals
  to authenticated,service_role;

create or replace function public.maintain_order_master_read_totals()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  changes text;
  writer integer;
begin
  -- Never use PID modulo N or a client-settable GUC: concurrent sessions must
  -- never share a partition. These are actual backend slots, not row numbers.
  select backend into strict writer
  from pg_catalog.pg_stat_get_backend_idset() backend
  where pg_catalog.pg_stat_get_backend_pid(backend) = pg_catalog.pg_backend_pid();
  -- Relation names are fixed trigger transition tables, never user input.
  -- UNION ALL, then GROUP BY, also handles an id/store change without relying
  -- on a mutable key to pair OLD and NEW rows.
  if tg_op = 'INSERT' then
    changes := 'select store_id, macro_stage, macro_substage, operational_status,
      current_courier, last_courier, region, province, district, coverage,
      pickup_state, 1::bigint as delta from new_rows';
  elsif tg_op = 'DELETE' then
    changes := 'select store_id, macro_stage, macro_substage, operational_status,
      current_courier, last_courier, region, province, district, coverage,
      pickup_state, -1::bigint as delta from old_rows';
  elsif tg_op = 'UPDATE' then
    changes := 'select store_id, macro_stage, macro_substage, operational_status,
      current_courier, last_courier, region, province, district, coverage,
      pickup_state, 1::bigint as delta from new_rows union all
      select store_id, macro_stage, macro_substage, operational_status,
      current_courier, last_courier, region, province, district, coverage,
      pickup_state, -1::bigint as delta from old_rows';
  else
    raise exception 'Unsupported Master aggregate operation: %', tg_op;
  end if;

  -- Set-based writes: two statements per transition, independent of the
  -- number of keys. Parent existence handles a cascading store deletion.
  execute format('
    insert into public.order_master_stage_parts as target
      (store_id,writer_slot,macro_stage,macro_substage,total)
    select c.store_id,$1,c.macro_stage,c.macro_substage,sum(c.delta)::bigint
    from (%s) c join public.stores s on s.id=c.store_id
    group by c.store_id,c.macro_stage,c.macro_substage
    having sum(c.delta) <> 0
    order by c.store_id,c.macro_stage,c.macro_substage
    on conflict (store_id,writer_slot,macro_stage,macro_substage) do update
      set total=target.total+excluded.total',changes) using writer;

  execute format('
    insert into public.order_master_facet_parts as target
      (store_id,writer_slot,dimension,value,total)
    select c.store_id,$1,v.dimension,v.value,sum(c.delta)::bigint
    from (%s) c
    join public.stores s on s.id=c.store_id
    cross join lateral (
      select distinct dimension, value from (values
        (''operational'', c.operational_status),
        (''courier'', c.current_courier), (''courier'', c.last_courier),
        (''region'', c.region), (''province'', c.province),
        (''district'', c.district), (''coverage'', c.coverage),
        (''pickup'', c.pickup_state)
      ) values_by_dimension(dimension, value) where value is not null
    ) v
    group by c.store_id, v.dimension, v.value
    having sum(c.delta) <> 0
    order by c.store_id,v.dimension,v.value
    on conflict (store_id,writer_slot,dimension,value) do update
      set total=target.total+excluded.total',changes) using writer;
  return null;
end;
$function$;

revoke all on function public.maintain_order_master_read_totals()
  from public, anon, authenticated, service_role;

-- This block is one transaction even when psql applies the file without -1.
-- No writer can slip between the backfill snapshot and trigger installation.
do $install$
begin
  lock table public.order_master in share row exclusive mode;
  -- DELETE, not TRUNCATE: concurrent readers keep their prior MVCC snapshot.
  delete from public.order_master_stage_parts;
  insert into public.order_master_stage_parts
    (store_id, writer_slot, macro_stage, macro_substage, total)
  select store_id, -1, macro_stage, macro_substage, count(*)
  from public.order_master group by store_id, macro_stage, macro_substage;

  delete from public.order_master_facet_parts;
  insert into public.order_master_facet_parts (store_id, writer_slot, dimension, value, total)
  select m.store_id, -1, v.dimension, v.value, count(*)
  from public.order_master m
  cross join lateral (
    select distinct dimension, value from (values
      ('operational', m.operational_status),
      ('courier', m.current_courier), ('courier', m.last_courier),
      ('region', m.region), ('province', m.province),
      ('district', m.district), ('coverage', m.coverage), ('pickup', m.pickup_state)
    ) values_by_dimension(dimension, value) where value is not null
  ) v
  group by m.store_id, v.dimension, v.value;

  drop trigger if exists order_master_read_insert on public.order_master;
  drop trigger if exists order_master_read_update on public.order_master;
  drop trigger if exists order_master_read_delete on public.order_master;
  create trigger order_master_read_insert after insert on public.order_master
    referencing new table as new_rows for each statement
    execute function public.maintain_order_master_read_totals();
  create trigger order_master_read_update after update on public.order_master
    referencing old table as old_rows new table as new_rows for each statement
    execute function public.maintain_order_master_read_totals();
  create trigger order_master_read_delete after delete on public.order_master
    referencing old table as old_rows for each statement
    execute function public.maintain_order_master_read_totals();
end;
$install$;

-- Keep the rider-only function out of service-role query plans. PostgreSQL 16
-- checks its EXECUTE ACL even inside a non-taken SQL CASE/subquery branch.
-- PL/pgSQL plans only the executed branch, without expanding anyone's grants.
create or replace function public.master_visible_rider_order_ids()
returns setof uuid
language plpgsql stable security invoker set search_path = pg_catalog
as $function$
begin
  if current_user = 'authenticated' then
    return query select distinct public.auth_rider_order_ids();
  end if;
end;
$function$;
revoke all on function public.master_visible_rider_order_ids() from public, anon;
grant execute on function public.master_visible_rider_order_ids() to authenticated, service_role;

create or replace function public.order_master_mom_counts(p_store_ids uuid[])
returns table (macro_stage text, macro_substage text, total bigint)
language plpgsql stable security invoker set search_path = public
as $function$
begin
  -- 0186 grants riders selected orders without granting their entire store.
  -- Keep those RPC semantics without exposing another store's full counters.
  return query with rider_ids as materialized (
    select public.master_visible_rider_order_ids() as order_id
  ), visible as (
    select t.macro_stage,t.macro_substage,t.total
    from public.order_master_stage_totals t where t.store_id=any(p_store_ids)
    union all
    select m.macro_stage,m.macro_substage,count(*)::bigint
    from rider_ids r join public.order_master m on m.order_id=r.order_id
    where m.store_id=any(p_store_ids)
      and m.store_id not in (select public.auth_store_ids())
    group by m.macro_stage,m.macro_substage
  )
  select v.macro_stage,v.macro_substage,sum(v.total)::bigint
  from visible v group by v.macro_stage,v.macro_substage;
end;
$function$;

create or replace function public.master_facets(p_store_ids uuid[])
returns jsonb
language plpgsql stable security invoker set search_path = public
as $function$
declare result jsonb;
begin
  with rider_ids as materialized (
    select public.master_visible_rider_order_ids() as order_id
  ), visible as materialized (
    select distinct t.dimension, t.value
    from public.order_master_facet_totals t
    where t.store_id = any(p_store_ids) and t.total > 0
    union
    select v.dimension,v.value
    from rider_ids r join public.order_master m on m.order_id=r.order_id
    cross join lateral (values
      ('operational',m.operational_status),('courier',m.current_courier),
      ('courier',m.last_courier),('region',m.region),('province',m.province),
      ('district',m.district),('coverage',m.coverage),('pickup',m.pickup_state)
    ) v(dimension,value)
    where m.store_id=any(p_store_ids) and v.value is not null
      and m.store_id not in (select public.auth_store_ids())
  )
  select jsonb_object_agg(d.dimension, coalesce((
    select jsonb_agg(v.value order by v.value)
    from visible v where v.dimension = d.dimension
  ), '[]'::jsonb)) into result
  from (values ('operational'), ('courier'), ('region'), ('province'),
    ('district'), ('coverage'), ('pickup')) d(dimension);
  return result;
end;
$function$;

revoke all on function public.order_master_mom_counts(uuid[]), public.master_facets(uuid[])
  from public, anon;
grant execute on function public.order_master_mom_counts(uuid[]), public.master_facets(uuid[])
  to authenticated, service_role;

comment on view public.order_master_stage_totals is
  'Exact transactional Master counts, summed across bounded backend-slot partitions; caller RLS applies.';
comment on view public.order_master_facet_totals is
  'Exact facet reference counts summed across backend-slot partitions. Nulls omitted; courier deduplicated per order/value; zero sums omitted.';

-- Match the actual created DESC NULLS LAST, id ASC page order. The stage
-- variants support the two primary queue filters, not every optional filter.
-- A consolidated multi-store read still needs a bounded merge or a measured
-- global plan; a store-leading index alone does not supply global date order.
create index if not exists order_master_store_created_page_idx
  on public.order_master (store_id, order_created_at desc nulls last, id asc);
create index if not exists order_master_stage_created_page_idx
  on public.order_master (store_id, macro_stage, order_created_at desc nulls last, id asc);
create index if not exists order_master_substage_created_page_idx
  on public.order_master (store_id, macro_substage, order_created_at desc nulls last, id asc);
create index if not exists leads_order_id_idx
  on public.leads (order_id) where order_id is not null;
