-- ============================================================================
-- 0259_ventas_por_origen.sql — el Consolidado cuenta TODAS las ventas de la
-- tienda, por origen, y la conversión de cada fuente de leads (MOM §17.4,
-- 14-10-2026).
--
-- QUÉ PASABA. Las cifras de cabecera del Consolidado (Ingresos, Pedidos,
-- Ticket), «Ventas por día» y «Por tienda» salían de `daily_rollups`, que solo
-- cuenta los pedidos con etiqueta `kapso`: del 14-09 al 13-10-2026, unos 590
-- pedidos y S/ 104.000 de los ~6.600 y S/ 1.180.000 que vendieron las tiendas.
-- La «Conversión» de arriba (pedidos ÷ conversaciones) era la del bot sin
-- decirlo, y no había ninguna tasa para las demás fuentes de leads.
--
-- QUÉ CAMBIA.
--
--   1. `pedidos_canal`: la regla del canal de cierre (MOM §17.3) en UN solo
--      lugar. Es una vista con la sesión de quien mira (security_invoker): las
--      políticas de orders, order_sales y auto_order_trials siguen mandando.
--      Antes la regla vivía dentro de `canal_de_cierre` (0258); una segunda
--      copia en las funciones nuevas podía separarse sin que nadie lo notara.
--
--   2. `canal_de_cierre` lee la vista. Mismo resultado que 0258 (su smoke lo
--      vuelve a probar), sin copia propia de la regla.
--
--   3. `ventas_por_origen(tiendas, desde, hasta)`: por tienda, día LOCAL y
--      canal, los pedidos activos, el ingreso (total − reembolsado) y los
--      cancelados aparte. De ahí salen la cabecera, «Ventas por día», «Por
--      tienda», el pedido del bot de «Conversión del bot» y la comparación con
--      el periodo anterior.
--
--   4. `conversion_por_fuente(tiendas, desde, hasta)`: de los leads que
--      NACIERON en el periodo (`coalesce(first_seen_at, created_at)`, día
--      local), cuántos compraron en sus primeros 7 días, por cualquier canal, y
--      quién cerró esa compra. Solo cuentan los leads con 7 días o más («por
--      madurar», aparte) y quedan fuera, contadas aparte, las que ya eran
--      clientas antes de nacer el lead. La compra es un pedido activo de la
--      MISMA tienda con el mismo teléfono o el pedido del propio lead
--      (`order_id`; un lead sin teléfono solo convierte por ahí), creado
--      después de nacer el lead y antes de 7 días.
--      `whatsapp-bot` es la marca que reciben los leads orgánicos que ganaron
--      (lib/leads-ingest.ts): va con los de fuente vacía a «orgánico».
--      `leads.has_order` NO sirve: se prende con cualquier pedido del teléfono,
--      también con uno anterior al lead o cancelado, y nunca se apaga.
--      Además, el cierre de las asesoras, parecido al de Productividad: ventas
--      registradas (`order_sales`, por la hora del botón, anuladas incluidas y
--      contadas aparte) sobre leads DISTINTOS trabajados (`lead_calls` firmadas
--      que no son del sistema ni del agente de voz). Productividad suma los
--      leads por asesora; aquí son los distintos de la tienda.
--
--   5. Dos índices para el nacimiento del lead, que `leads` no tenía por fecha:
--      `leads_store_first_seen_idx` (store_id, first_seen_at) y
--      `leads_store_created_sin_first_seen_idx` (store_id, created_at) donde
--      `first_seen_at` es null. Son de columnas simples a propósito: la app
--      consulta como `authenticated`, bajo la política de `leads`, y Postgres
--      no lleva al índice un rango sobre `coalesce(...)` (coalesce no es
--      leakproof): con un índice de expresión leía todos los leads de la tienda.
--      Por eso `conversion_por_fuente` parte el nacimiento en dos ramas.
--      EN PRODUCCIÓN SE CREAN A MANO Y ANTES, con `create index concurrently`
--      (DEPLOY.md): un `create index` normal bloquea las escrituras en `leads`
--      mientras se construye. Aquí quedan con `if not exists` para la base de
--      CI y las bases nuevas.
--
--   Las tres funciones materializan `tiendas`: si Postgres la incrusta en la
--   consulta, los límites del rango llegan como `timezone(coalesce(...))`, que
--   tampoco es leakproof, y bajo RLS el rango de `orders` deja de ir por su
--   índice (medido: 400.000 pedidos leídos en vez de los de la tienda).
--
-- QUÉ NO CAMBIA. `daily_rollups` sigue contando solo `kapso`: alimenta
-- «Primera respuesta», las conversaciones de «Conversión del bot» y lo que el
-- MOM §17.4 lista como «solo pedidos del bot». La cobertura (desde cuándo cada
-- tienda tiene todas sus ventas) la decide la aplicación, no estas funciones:
-- reciben una tienda y su rango ya recortado (lib/sales-coverage.ts).
--
-- Solo lectura: no escribe nada. Si la app corre antes de que esto se aplique,
-- la cabecera vuelve a la vista anterior (solo el bot) con un aviso, nunca
-- ceros (lib/access.ts).
-- ============================================================================

-- 5. Nacimiento del lead, por tienda. En producción: concurrently, a mano, antes.
create index if not exists leads_store_first_seen_idx
  on public.leads (store_id, first_seen_at);
create index if not exists leads_store_created_sin_first_seen_idx
  on public.leads (store_id, created_at)
  where first_seen_at is null;

-- 1. La regla del canal, en un solo lugar (movida tal cual de 0258).
create or replace view public.pedidos_canal with (security_invoker = true) as
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
  from public.orders o;

-- Una vista nueva nace con todos los permisos para anon y authenticated en
-- Supabase (0213) y es actualizable en sus columnas simples: solo lectura, y
-- solo para quien ya ve los pedidos.
revoke all on public.pedidos_canal from public, anon, authenticated;
grant select on public.pedidos_canal to authenticated, service_role;

comment on view public.pedidos_canal is
  'Cada pedido con su canal de cierre (MOM §17.3): asesora > recompra_auto > bot_kapso > bot_externo > web > otros. Única copia de la regla.';

-- 2. canal_de_cierre sobre la vista: mismo resultado que 0258.
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
  with tiendas as materialized (
    -- materialized: así t_from/t_to llegan como valores y no como expresiones
    -- con coalesce, y bajo RLS el rango va por el índice (ver arriba).
    select s.id as store_id,
           p_from::timestamp at time zone coalesce(nullif(s.timezone, ''), 'UTC')       as t_from,
           (p_to + 1)::timestamp at time zone coalesce(nullif(s.timezone, ''), 'UTC')   as t_to
      from public.stores s
     where s.id = any(p_store_ids)
  ),
  pedidos as materialized (
    -- materialized: el canal se usa dos veces abajo y no debe calcularse dos.
    select v.id, v.store_id, v.created_at, v.customer_phone, v.cancelled_at, v.neto, v.canal
      from tiendas t
      join public.pedidos_canal v
        on v.store_id = t.store_id
       and v.created_at >= t.t_from
       and v.created_at <  t.t_to
  ),
  marcados as (
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

-- 3. Todas las ventas por tienda, día local y canal.
create or replace function public.ventas_por_origen(
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
           coalesce(nullif(s.timezone, ''), 'UTC')                                         as tz,
           p_from::timestamp at time zone coalesce(nullif(s.timezone, ''), 'UTC')       as t_from,
           (p_to + 1)::timestamp at time zone coalesce(nullif(s.timezone, ''), 'UTC')   as t_to
      from public.stores s
     where s.id = any(p_store_ids)
  ),
  por_dia as (
    select v.store_id,
           (v.created_at at time zone t.tz)::date                               as dia,
           v.canal,
           count(*) filter (where v.cancelled_at is null)                       as pedidos,
           coalesce(sum(v.neto) filter (where v.cancelled_at is null), 0)       as ingresos,
           count(*) filter (where v.cancelled_at is not null)                   as cancelados
      from tiendas t
      join public.pedidos_canal v
        on v.store_id = t.store_id
       and v.created_at >= t.t_from
       and v.created_at <  t.t_to
     group by v.store_id, (v.created_at at time zone t.tz)::date, v.canal
  )
  select jsonb_build_object(
           'version', 1,
           'filas', coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'store_id',   d.store_id,
                 'dia',        d.dia,
                 'canal',      d.canal,
                 'pedidos',    d.pedidos,
                 'ingresos',   d.ingresos,
                 'cancelados', d.cancelados
               )
               order by d.store_id, d.dia, d.canal
             ),
             '[]'::jsonb
           )
         )
    from por_dia d;
$$;

revoke all on function public.ventas_por_origen(uuid[], date, date) from public, anon;
grant execute on function public.ventas_por_origen(uuid[], date, date) to authenticated, service_role;

comment on function public.ventas_por_origen(uuid[], date, date) is
  'Todas las ventas de las tiendas por día local y canal de cierre (MOM §17.4): pedidos activos, ingreso neto y cancelados aparte.';

-- 4. Conversión de cada fuente de leads, por cohorte de nacimiento.
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
             when b.source in ('meta_ad', 'fb_web', 'cod_cart', 'abandoned_browse') then b.source
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
