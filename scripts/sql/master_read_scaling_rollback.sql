-- Roll back ONLY the read implementation introduced by migration 0198.
-- Run AFTER reverting/draining application versions that read the summary
-- tables directly. They intentionally become stale after these triggers stop.
-- psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --file=.../master_read_scaling_rollback.sql
-- No orders, operational history, summary tables, helper functions or indexes
-- are deleted. Applying 0198 again rebuilds summaries before reinstalling it.
-- The lock is explicit because DROP TRIGGER needs ACCESS EXCLUSIVE. If a long
-- reader/writer prevents acquisition within 5s, the ENTIRE transaction fails;
-- inspect the blocker and retry in a quiet window, never remove the timeouts.
-- Legacy function bodies/signatures are copied exactly from 0089 and 0078.
-- ACL exception: keep 0198's tighter authenticated/service_role-only execution.
-- In particular, DO NOT restore 0078's implicit PUBLIC EXECUTE grant.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = public, pg_catalog;
lock table public.order_master in access exclusive mode;

drop trigger if exists order_master_read_insert on public.order_master;
drop trigger if exists order_master_read_update on public.order_master;
drop trigger if exists order_master_read_delete on public.order_master;

-- Exact function definition from 0089_order_master_mom_counts.sql.
create or replace function public.order_master_mom_counts(p_store_ids uuid[])
returns table (
  macro_stage text,
  macro_substage text,
  total bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    om.macro_stage,
    om.macro_substage,
    count(*)::bigint as total
  from public.order_master as om
  where om.store_id = any(p_store_ids)
  group by om.macro_stage, om.macro_substage;
$$;

-- Exact function definition from 0078_order_coverage.sql.
create or replace function master_facets(p_store_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'operational', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct operational_status as v
        from order_master where store_id = any(p_store_ids) and operational_status is not null
      ) q
    ), '[]'::jsonb),
    'courier', coalesce((
      select jsonb_agg(v order by v) from (
        select current_courier as v from order_master
        where store_id = any(p_store_ids) and current_courier is not null
        union
        select last_courier as v from order_master
        where store_id = any(p_store_ids) and last_courier is not null
      ) q
    ), '[]'::jsonb),
    'region', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct region as v from order_master
        where store_id = any(p_store_ids) and region is not null
      ) q
    ), '[]'::jsonb),
    'province', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct province as v from order_master
        where store_id = any(p_store_ids) and province is not null
      ) q
    ), '[]'::jsonb),
    'district', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct district as v from order_master
        where store_id = any(p_store_ids) and district is not null
      ) q
    ), '[]'::jsonb),
    'coverage', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct coverage as v from order_master
        where store_id = any(p_store_ids) and coverage is not null
      ) q
    ), '[]'::jsonb),
    'pickup', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct pickup_state as v from order_master
        where store_id = any(p_store_ids) and pickup_state is not null
      ) q
    ), '[]'::jsonb)
  );
$$;

-- Preserve restrictive access while restoring the old source-table queries.
revoke all on function public.order_master_mom_counts(uuid[]), public.master_facets(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.order_master_mom_counts(uuid[]), public.master_facets(uuid[])
  to authenticated, service_role;
commit;
