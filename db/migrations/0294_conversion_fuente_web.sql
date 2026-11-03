-- ============================================================================
-- 0294_conversion_fuente_web.sql — «Conversión por fuente»: la fuente `web`
-- (MOM §17.4, owner 01-11-2026).
--
-- QUÉ PASABA. Desde el 29-10-2026 el botón de WhatsApp de cada producto en la
-- web (WooCommerce) abre el chat con «Hola, quiero pedir <producto>. Soy de …».
-- Esos leads no traen señal de Meta y quedaban sin fuente: la tabla los
-- contaba como «Orgánico de WhatsApp» (~150 al día).
--
-- QUÉ CAMBIA. La sincronización los marca `source = 'web'` (lib/kapso.ts,
-- `extractReferral`), y esta función les da su fila: `web` entra en la lista
-- de fuentes con tasa. Solo `conversion_por_fuente`, con `create or replace`,
-- la misma firma y el mismo cuerpo de la 0268 salvo esa lista. Sin ella, un
-- lead `web` caería en `sin_tasa` y desaparecería de la tabla.
--
-- No toca datos, ni triggers, ni otra función. Permisos como la 0268. Es
-- idempotente. Se aplica a mano ANTES del código (DEPLOY.md).
-- ============================================================================

create or replace function public.conversion_por_fuente(
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
  with tiendas as materialized (
    -- materialized: así t_from/t_to llegan como valores y no como expresiones
    -- con coalesce, y bajo RLS el rango va por el índice (ver arriba).
    select s.id as store_id,
           p_from::timestamp at time zone coalesce(nullif(s.timezone, ''), 'UTC')       as t_from,
           (p_to + 1)::timestamp at time zone coalesce(nullif(s.timezone, ''), 'UTC')   as t_to
      from public.stores s
     where s.id = any(p_store_ids)
  ),
  nacidos as materialized (
    select b.id,
           b.store_id,
           b.phone,
           b.order_id,
           b.nace,
           b.nace <= now() - interval '7 days' as maduro,
           case
             -- web = el botón de WhatsApp de la web de la tienda (0294, 01-11-2026).
             when b.source in ('meta_ad', 'fb_web', 'web', 'cod_cart', 'abandoned_browse') then b.source
             -- whatsapp-bot = un lead orgánico que ganó (lib/leads-ingest.ts).
             when b.source is null or b.source = 'whatsapp-bot' then 'organico'
             -- manual (venta telefónica) y cualquier otra: sin tasa.
             else 'sin_tasa'
           end as fuente
      from (
        -- Nacer = coalesce(first_seen_at, created_at), en dos ramas de columnas
        -- simples para que bajo RLS cada rango vaya por su índice.
        select l.id, l.store_id, l.phone, l.order_id, l.source, l.first_seen_at as nace
          from tiendas t
          join public.leads l
            on l.store_id = t.store_id
           and l.first_seen_at >= t.t_from
           and l.first_seen_at <  t.t_to
        union all
        select l.id, l.store_id, l.phone, l.order_id, l.source, l.created_at as nace
          from tiendas t
          join public.leads l
            on l.store_id = t.store_id
           and l.first_seen_at is null
           and l.created_at >= t.t_from
           and l.created_at <  t.t_to
         -- Una fila que Kapta creó desde su propio pedido (llega sin
         -- first_seen_at y después del pedido) no es alguien que escribió: no
         -- nace en la cohorte. Medido: 120 de ~21.800 leads en 30 días.
         where not exists (select 1 from public.orders o
                            where o.id = l.order_id
                              and o.store_id = l.store_id
                              and o.created_at <= l.created_at)
      ) b
  ),
  marcados as materialized (
    -- «Ya era clienta»: un pedido activo de la misma tienda ANTES de nacer el
    -- lead. Solo importa para los maduros, que son los que entran a la tasa.
    -- Antes de ORDERS_SYNC_FROM `orders` solo tiene los pedidos del bot, así
    -- que una compra anterior por la web de esa época no se ve (MOM §17.4).
    select n.*,
           case when n.maduro then (
             exists (select 1 from public.orders o
                      where n.phone is not null
                        and o.store_id = n.store_id
                        and o.customer_phone = n.phone
                        and o.cancelled_at is null
                        and o.created_at < n.nace)
             or exists (select 1 from public.orders o
                         where n.order_id is not null
                           and o.id = n.order_id
                           and o.store_id = n.store_id
                           and o.cancelled_at is null
                           and o.created_at < n.nace)
           ) else false end as ya_clienta
      from nacidos n
  ),
  convertidos as (
    -- La compra que convierte: el primer pedido activo, misma tienda, mismo
    -- teléfono (o el del propio lead si no tiene teléfono), después de nacer
    -- el lead y antes de 7 días. Solo para los maduros que no eran clientas.
    -- Se lee de la vista: el canal se calcula solo para el pedido que
    -- convierte, nunca para todos los pedidos de la tienda.
    select m.store_id,
           m.fuente,
           m.maduro,
           m.ya_clienta,
           c.order_id as pedido_id,
           c.canal
      from marcados m
      left join lateral (
        select x.id as order_id, x.canal
          from (
            select o.id, o.created_at, o.canal
              from public.pedidos_canal o
             where m.maduro and not m.ya_clienta and m.phone is not null
               and o.store_id = m.store_id
               and o.customer_phone = m.phone
               and o.cancelled_at is null
               and o.created_at >  m.nace
               and o.created_at <  m.nace + interval '7 days'
            union all
            select o.id, o.created_at, o.canal
              from public.pedidos_canal o
             where m.maduro and not m.ya_clienta and m.order_id is not null
               and o.id = m.order_id
               and o.store_id = m.store_id
               and o.cancelled_at is null
               and o.created_at >  m.nace
               and o.created_at <  m.nace + interval '7 days'
          ) x
         order by x.created_at, x.id
         limit 1
      ) c on true
  ),
  por_fuente as (
    select c.store_id,
           c.fuente,
           count(*)                                                     as nacidos,
           count(*) filter (where not c.maduro)                         as por_madurar,
           count(*) filter (where c.maduro and c.ya_clienta)            as ya_clientas,
           count(*) filter (where c.maduro and not c.ya_clienta)        as prospectos,
           count(*) filter (where c.pedido_id is not null)              as convertidos
      from convertidos c
     group by c.store_id, c.fuente
  ),
  cierres as (
    select c.store_id, c.fuente, c.canal, count(*) as convertidos
      from convertidos c
     where c.pedido_id is not null
     group by c.store_id, c.fuente, c.canal
  ),
  trabajados as (
    -- Como Productividad: gestión firmada que no es del sistema ni del agente
    -- de voz. Leads DISTINTOS de la tienda (Productividad suma por asesora).
    select t.store_id, count(distinct c.lead_id) as leads
      from tiendas t
      join public.lead_calls c
        on c.store_id = t.store_id
       and c.occurred_at >= t.t_from
       and c.occurred_at <  t.t_to
     where c.vendedora is not null
       and btrim(c.kind) not in ('system', 'voice_agent')
     group by t.store_id
  ),
  ventas as (
    -- Como Productividad: la venta registrada por la hora del botón, también
    -- la que después se anuló (contada aparte).
    select t.store_id,
           count(*)                                            as ventas,
           count(*) filter (where o.cancelled_at is not null)  as canceladas
      from tiendas t
      join public.order_sales v
        on v.store_id = t.store_id
       and v.occurred_at >= t.t_from
       and v.occurred_at <  t.t_to
      left join public.orders o on o.id = v.order_id
     group by t.store_id
  )
  select jsonb_build_object(
           'version', 1,
           'fuentes', coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'store_id',    f.store_id,
                        'fuente',      f.fuente,
                        'nacidos',     f.nacidos,
                        'por_madurar', f.por_madurar,
                        'ya_clientas', f.ya_clientas,
                        'prospectos',  f.prospectos,
                        'convertidos', f.convertidos
                      )
                      order by f.store_id, f.fuente)
               from por_fuente f
           ), '[]'::jsonb),
           'cierres', coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'store_id',    x.store_id,
                        'fuente',      x.fuente,
                        'canal',       x.canal,
                        'convertidos', x.convertidos
                      )
                      order by x.store_id, x.fuente, x.canal)
               from cierres x
           ), '[]'::jsonb),
           'asesoras', coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'store_id',         t.store_id,
                        'leads_trabajados', coalesce(w.leads, 0),
                        'ventas',           coalesce(s.ventas, 0),
                        'canceladas',       coalesce(s.canceladas, 0)
                      )
                      order by t.store_id)
               from tiendas t
               left join trabajados w on w.store_id = t.store_id
               left join ventas s on s.store_id = t.store_id
           ), '[]'::jsonb)
         );
$$;

revoke all on function public.conversion_por_fuente(uuid[], date, date) from public, anon;
grant execute on function public.conversion_por_fuente(uuid[], date, date) to authenticated, service_role;

comment on function public.conversion_por_fuente(uuid[], date, date) is
  'Conversión de cada fuente de leads por cohorte de nacimiento (MOM §17.4): compra en 7 días por cualquier canal, con quién la cerró; y el % de cierre de las asesoras como en Productividad.';
