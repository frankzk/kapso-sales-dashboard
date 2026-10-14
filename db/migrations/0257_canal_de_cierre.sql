-- ============================================================================
-- 0257_canal_de_cierre.sql — quién cerró cada venta de la tienda, con TODOS
-- los pedidos y sin depender de etiquetas que la sincronización borra
-- (MOM §17.3, 14-10-2026).
--
-- QUÉ PASABA. «Canal de cierre» del Consolidado solo veía los pedidos con
-- etiqueta `kapso` y decidía «asesora» por las etiquetas `venta_manual` /
-- `carrito_recuperado`. El botón de venta escribía `kapso` solo en nuestra
-- copia del pedido —en Shopify el pedido nace con `venta_manual`, o con las
-- etiquetas del borrador de EasySell cuando se reusa el carrito— y la pasada
-- `shopify_all` del cron, cada 5 minutos, reescribe `tags` con lo que dice
-- Shopify. Medido del 14-09 al 13-10-2026: de 2.916 pedidos de asesoras, 1
-- conservaba `kapso`. El panel decía «0 % lo cerró una asesora» mientras
-- Productividad, que lee `order_sales`, les contaba S/ 484.645.
--
-- QUÉ CAMBIA. Una función de lectura que clasifica cada pedido de las tiendas
-- pedidas, en el día local de cada tienda, por hechos que nada sobrescribe:
--
--   1. asesora        — tiene fila en `order_sales` (la venta que registró una
--                       asesora al apretar el botón; MOM: «eso lo decide
--                       `order_sales`»).
--   2. recompra_auto  — es el pedido de una prueba de recompra automática
--                       (`auto_order_trials`, estado `generado`). Shopify no le
--                       deja su etiqueta: las tiendas no dieron `write_orders`.
--   3. bot_kapso      — etiqueta `kapso` en Shopify: lo creó el bot de Kapso.
--   4. bot_externo    — etiquetas del otro bot de carritos («BOT», «CARRITO
--                       RECUPERADO», «BOT (whatsapp_cloud)»).
--   5. web            — formulario contraentrega de EasySell (etiquetas que
--                       empiezan con `easysell`): la clienta compró sola.
--   6. otros          — todo lo demás (catálogo de WhatsApp, pedidos hechos a
--                       mano en Shopify…).
--
-- El orden importa solo en el borde: medido en el mismo mes, un pedido tenía
-- `kapso` y venta de asesora, y otro `kapso` y EasySell. Un pedido cae en UN
-- solo canal, así que los canales suman el total de la tienda.
--
-- Y una marca aparte, «ayudado por asesora», para lo que NO cerró una asesora:
-- una asesora gestionó a esa clienta —fila firmada de `lead_calls` de tipo
-- call, message o sale (la misma definición de «tocado» del MOM)— en el lead de
-- la MISMA tienda con el MISMO teléfono, en los 7 días previos al pedido.
-- Ayudar no es cerrar: la venta queda en su canal y la marca se cuenta aparte.
--
-- Igual que el resto del Consolidado: cancelados aparte (fuera de pedidos e
-- ingresos), ingreso = total − reembolsado, día local de la tienda.
--
-- POR QUÉ UNA FUNCIÓN Y NO TYPESCRIPT. Clasificar un mes de Kenku desde la app
-- era bajar ~7.000 pedidos y ~20.000 gestiones en cada carga de la página.
-- Aquí, con los índices que ya existen (orders por tienda y fecha, leads por
-- tienda y teléfono, lead_calls por lead y fecha, order_sales por pedido):
-- 0,15 s para 30 días en producción. Devuelve un solo jsonb agregado por tienda
-- y canal, así que no hay tope de filas de PostgREST que lo recorte.
--
-- SECURITY INVOKER a propósito, como 0252: las políticas de orders,
-- order_sales, auto_order_trials, leads, lead_calls y stores siguen mandando,
-- así que cada persona solo ve sus tiendas.
--
-- Solo lectura: no escribe nada. Si la app corre antes de que esto se aplique,
-- el panel muestra la vista anterior con un aviso (lib/access.ts).
-- ============================================================================

create or replace function public.canal_de_cierre(
  p_store_ids uuid[],
  p_from      date,
  p_to        date
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with tiendas as (
    -- Medianoche local de p_from y del día siguiente a p_to (exclusivo), por
    -- tienda: el mismo rango indexable que recompute_daily_rollups (0212).
    select s.id as store_id,
           p_from::timestamp at time zone coalesce(nullif(s.timezone, ''), 'UTC')       as t_from,
           (p_to + 1)::timestamp at time zone coalesce(nullif(s.timezone, ''), 'UTC')   as t_to
      from public.stores s
     where s.id = any(p_store_ids)
  ),
  pedidos as (
    select o.id,
           o.store_id,
           o.created_at,
           o.customer_phone,
           o.cancelled_at,
           coalesce(o.total_amount, 0) - coalesce(o.total_refunded, 0) as neto,
           case
             when exists (select 1 from public.order_sales v where v.order_id = o.id)
               then 'asesora'
             when exists (select 1 from public.auto_order_trials a
                           where a.store_id = o.store_id
                             and a.shopify_order_id = o.shopify_order_id
                             and a.status = 'generado')
               then 'recompra_auto'
             when exists (select 1 from unnest(o.tags) g where lower(g) = 'kapso')
               then 'bot_kapso'
             when exists (select 1 from unnest(o.tags) g
                           where lower(g) in ('bot', 'carrito recuperado', 'bot (whatsapp_cloud)'))
               then 'bot_externo'
             when exists (select 1 from unnest(o.tags) g where lower(g) like 'easysell%')
               then 'web'
             else 'otros'
           end as canal
      from tiendas t
      join public.orders o
        on o.store_id = t.store_id
       and o.created_at >= t.t_from
       and o.created_at <  t.t_to
  ),
  marcados as (
    -- CASE y no AND: Postgres no promete el orden de evaluación de un AND, y el
    -- EXISTS es lo único caro. Solo se busca la gestión cuando puede contar.
    select p.store_id,
           p.canal,
           p.cancelled_at,
           p.neto,
           case
             when p.canal = 'asesora' or p.cancelled_at is not null or p.customer_phone is null then false
             else exists (
               select 1
                 from public.leads l
                 join public.lead_calls c on c.lead_id = l.id
                where l.store_id = p.store_id
                  and l.phone = p.customer_phone
                  and c.vendedora is not null
                  and c.kind in ('call', 'message', 'sale')
                  and c.occurred_at <  p.created_at
                  and c.occurred_at >= p.created_at - interval '7 days'
             )
           end as ayudado
      from pedidos p
  ),
  por_canal as (
    select m.store_id,
           m.canal,
           count(*) filter (where m.cancelled_at is null)                     as pedidos,
           coalesce(sum(m.neto) filter (where m.cancelled_at is null), 0)     as ingresos,
           count(*) filter (where m.cancelled_at is not null)                 as cancelados,
           count(*) filter (where m.ayudado)                                   as ayudados,
           coalesce(sum(m.neto) filter (where m.ayudado), 0)                   as ingresos_ayudados
      from marcados m
     group by m.store_id, m.canal
  )
  select jsonb_build_object(
           'version', 1,
           'filas', coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'store_id',          c.store_id,
                 'canal',             c.canal,
                 'pedidos',           c.pedidos,
                 'ingresos',          c.ingresos,
                 'cancelados',        c.cancelados,
                 'ayudados',          c.ayudados,
                 'ingresos_ayudados', c.ingresos_ayudados
               )
               order by c.store_id, c.canal
             ),
             '[]'::jsonb
           )
         )
    from por_canal c;
$$;

revoke all on function public.canal_de_cierre(uuid[], date, date) from public, anon;
grant execute on function public.canal_de_cierre(uuid[], date, date) to authenticated, service_role;

comment on function public.canal_de_cierre(uuid[], date, date) is
  'Canal de cierre de todos los pedidos de las tiendas en el rango local (MOM §17.3): asesora > recompra_auto > bot_kapso > bot_externo > web > otros, con marca «ayudado por asesora».';
