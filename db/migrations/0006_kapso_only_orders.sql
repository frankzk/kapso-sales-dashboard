-- ============================================================================
-- 0006_kapso_only_orders.sql — enforce the "orders = tag:kapso only" invariant
--
-- The dashboard must reflect ONLY orders generated through the Kapso bot, i.e.
-- Shopify orders tagged `kapso` (parity with the GraphQL reconciliation sync's
-- `tag:kapso` query and the Shopify "tag:kapso" view — see DEPLOY.md §7). The
-- webhook ingestion path historically upserted EVERY order Shopify delivered
-- (Shopify fires order webhooks shop-wide), polluting `orders` with non-Kapso
-- rows and inflating revenue / orders / AOV / conversion. This migration:
--   1) Adds a defensive tag:kapso filter to recompute_daily_rollups so the
--      headline KPIs only ever count Kapso orders, whatever sits in the table.
--   2) Purges existing non-Kapso order rows.
--   3) Recomputes every store's rollups over full history so the dashboard
--      reflects the cleaned data immediately (not only on the next sync).
-- The webhook code is fixed separately (lib/ingest.ts) to stop the bleeding.
-- ============================================================================

-- 0) Self-sufficiency guard: this migration's recompute_daily_rollups body
--    references the message-timing columns added in 0005. Add them idempotently
--    so 0006 can be applied standalone even if 0005 hasn't run yet (no-op when
--    it has, e.g. via db/apply.sql). Mirrors 0005_message_timing.sql; no data
--    is touched.
alter table conversations
  add column if not exists inbound_count          integer,
  add column if not exists first_response_seconds integer;
alter table daily_rollups
  add column if not exists inbound_messages     integer not null default 0,
  add column if not exists response_seconds_sum bigint  not null default 0,
  add column if not exists response_samples     integer not null default 0;

-- 1) Defensive filter: rollups only ever count Kapso orders.
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
           count(*) filter (where cancelled_at is null)                                  as orders_count,
           coalesce(sum(total_amount - total_refunded) filter (where cancelled_at is null), 0) as revenue,
           coalesce(sum(total_refunded) filter (where cancelled_at is null), 0)          as refunded_amount,
           count(*) filter (where cancelled_at is not null)                              as cancelled_orders,
           count(*) filter (where cancelled_at is null and promo_applied)                as promo_orders,
           count(*) filter (where cancelled_at is null and stock_por_validar)            as stock_validar_orders,
           count(*) filter (where cancelled_at is null and shipping_mode = 'cod')        as cod_orders,
           count(*) filter (where cancelled_at is null and shipping_mode = 'agency')     as agency_orders
      from orders
     where store_id = p_store_id
       and created_at is not null
       and (created_at at time zone tz)::date between p_from and p_to
       and exists (select 1 from unnest(tags) t where lower(t) = 'kapso')
     group by 1
  ),
  c as (
    select (started_at at time zone tz)::date as d,
           count(*)                                                          as conversations_count,
           coalesce(sum(inbound_count), 0)                                   as inbound_messages,
           coalesce(sum(first_response_seconds), 0)                          as response_seconds_sum,
           count(*) filter (where first_response_seconds is not null)        as response_samples
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
    agency_orders, cancelled_orders, refunded_amount,
    inbound_messages, response_seconds_sum, response_samples, updated_at
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
    coalesce(o.cancelled_orders, 0),
    coalesce(o.refunded_amount, 0),
    coalesce(c.inbound_messages, 0),
    coalesce(c.response_seconds_sum, 0),
    coalesce(c.response_samples, 0),
    now()
  from days
  left join o on o.d = days.d
  left join c on c.d = days.d;
end;
$$;

revoke all on function public.recompute_daily_rollups(uuid, date, date) from public;
grant execute on function public.recompute_daily_rollups(uuid, date, date) to service_role;

-- 2) Purge existing non-Kapso orders. FK-safe: leads.order_id is
--    ON DELETE SET NULL; leads.has_order self-heals on the next lead sync.
delete from orders o
 where not exists (select 1 from unnest(o.tags) t where lower(t) = 'kapso');

-- 3) Recompute every store's rollups over full history so the cleaned figures
--    show up immediately for the ranges the dashboard queries.
do $$
declare
  s record;
begin
  for s in select id from stores loop
    perform public.recompute_daily_rollups(s.id, '2020-01-01'::date, current_date + 1);
  end loop;
end $$;
