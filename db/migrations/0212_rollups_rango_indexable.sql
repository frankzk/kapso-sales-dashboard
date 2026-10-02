-- 0212_rollups_rango_indexable.sql — `recompute_daily_rollups` deja de leer
-- toda la tabla de la tienda en cada webhook.
--
-- QUÉ PASABA (02-10-2026). El filtro era `(created_at at time zone tz)::date
-- between p_from and p_to`: una expresión sobre la columna, que ningún índice
-- puede servir. Cada llamada —una por cada pedido Kapso y por cada carrito
-- recuperado que entra por webhook, normalmente para UN día— recorría todos los
-- `orders` y todas las `conversations` de la tienda. Medido en
-- pg_stat_statements: 66.420 llamadas, 627 ms de media y 48 millones de bloques
-- leídos de disco, la consulta que más disco gastaba de toda la base. En el
-- cómputo Micro eso agota el presupuesto de lectura y la app entera se arrastra.
--
-- QUÉ CAMBIA. El mismo día local se expresa como un rango de instantes:
--   local ∈ [p_from 00:00, p_to + 1 00:00)  ⇔
--   created_at ∈ [p_from::timestamp at time zone tz, (p_to + 1)::timestamp at time zone tz)
-- y ese rango sí lo sirven `orders_store_created_idx (store_id, created_at)` y
-- `conversations_store_started_idx (store_id, started_at)`. Los números que
-- escribe son idénticos; solo cambia cuánto lee para llegar a ellos.

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
  t_from timestamptz;
  t_to   timestamptz;
begin
  select timezone into tz from stores where id = p_store_id;
  if tz is null then
    tz := 'UTC';
  end if;
  -- Límites del rango en instantes: medianoche local de p_from y del día
  -- siguiente a p_to (exclusivo).
  t_from := p_from::timestamp at time zone tz;
  t_to   := (p_to + 1)::timestamp at time zone tz;

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
       and created_at >= t_from
       and created_at <  t_to
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
       and started_at >= t_from
       and started_at <  t_to
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
