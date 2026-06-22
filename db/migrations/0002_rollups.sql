-- ============================================================================
-- 0002_rollups.sql — authoritative daily rollup recompute
-- Rebuilds daily_rollups for a store over a date range from orders +
-- conversations. Dates are bucketed in the store's own timezone so that
-- "today" matches what the merchant sees. Called by /api/cron/sync via RPC.
-- ============================================================================

create or replace function public.recompute_daily_rollups(
  p_store_id uuid,
  p_from     date,
  p_to       date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tz text;
begin
  select timezone into tz from stores where id = p_store_id;
  if tz is null then
    tz := 'UTC';
  end if;

  delete from daily_rollups
   where store_id = p_store_id
     and date between p_from and p_to;

  with o as (
    select (created_at at time zone tz)::date as d,
           count(*)                                        as orders_count,
           coalesce(sum(total_amount), 0)                  as revenue,
           count(*) filter (where promo_applied)           as promo_orders,
           count(*) filter (where stock_por_validar)       as stock_validar_orders,
           count(*) filter (where shipping_mode = 'cod')   as cod_orders,
           count(*) filter (where shipping_mode = 'agency') as agency_orders
      from orders
     where store_id = p_store_id
       and created_at is not null
       and (created_at at time zone tz)::date between p_from and p_to
     group by 1
  ),
  c as (
    select (started_at at time zone tz)::date as d,
           count(*) as conversations_count
      from conversations
     where store_id = p_store_id
       and started_at is not null
       and (started_at at time zone tz)::date between p_from and p_to
     group by 1
  ),
  days as (
    select d from o
    union
    select d from c
  )
  insert into daily_rollups (
    store_id, date, orders_count, revenue, aov, conversations_count,
    conversion_rate, promo_orders, stock_validar_orders, cod_orders,
    agency_orders, updated_at
  )
  select
    p_store_id,
    days.d,
    coalesce(o.orders_count, 0),
    coalesce(o.revenue, 0),
    case when coalesce(o.orders_count, 0) > 0
         then round(coalesce(o.revenue, 0) / o.orders_count, 2)
         else 0 end,
    coalesce(c.conversations_count, 0),
    case when coalesce(c.conversations_count, 0) > 0
         then round(coalesce(o.orders_count, 0)::numeric / c.conversations_count, 4)
         else 0 end,
    coalesce(o.promo_orders, 0),
    coalesce(o.stock_validar_orders, 0),
    coalesce(o.cod_orders, 0),
    coalesce(o.agency_orders, 0),
    now()
  from days
  left join o on o.d = days.d
  left join c on c.d = days.d;
end;
$$;

-- Only the ingestion path (service role) may recompute rollups.
revoke all on function public.recompute_daily_rollups(uuid, date, date) from public;
grant execute on function public.recompute_daily_rollups(uuid, date, date) to service_role;
