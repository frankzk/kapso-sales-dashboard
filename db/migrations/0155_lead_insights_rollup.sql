-- ============================================================================
-- 0155_lead_insights_rollup.sql — el panel de gráficos de Leads deja de
-- descargar la semana entera para contar siete números.
--
-- QUÉ PASABA. `getLeadsInsights` (lib/leads-insights.ts) reconstruía el
-- burndown, el flujo de 7 días, los sin llamar y la conversión DRENANDO filas
-- por páginas de 1.000: los leads entrados en la semana, todas las gestiones
-- que sacaron a un lead de «Sin llamar», los leads sin gestionar, las llamadas
-- de asesora y las ventas. Unas 17.000 filas por carga. Y se cargaba en cada
-- refresco del tablero, por cada asesora con Leads abierto. Medido el
-- 10-09-2026 en 24 horas: 8,2 M filas de `leads(created_at,first_seen_at)`,
-- 10,2 M de `lead_calls(lead_id,occurred_at)`, 9,7 M de
-- `lead_calls(lead_id,kind,occurred_at)`. Segunda partida del egress de
-- Supabase, que cerró el ciclo en 333 GB sobre 250.
--
-- QUÉ HACE. Los mismos conteos, agrupados en la base: una fila por (cubo, día)
-- o (cubo, hora), unas cuarenta en total. Los predicados son copia EXACTA de
-- los del código de TypeScript, que se conserva como respaldo mientras la
-- función no esté aplicada:
--   * entran      = leads con first_seen_at en la ventana (o created_at si no
--                   tiene first_seen), por día; y por hora del día de hoy;
--   * cierran     = PRIMERA gestión en la ventana que sacó al lead de `nuevo`
--                   (new_status distinto de null y de 'nuevo'), excluyendo a
--                   los que ya tenían una así ANTES de la ventana; por día y
--                   por hora de hoy;
--   * sin_llamar  = leads open/hot con status 'nuevo', por día de última
--                   interacción (o de primer contacto);
--   * contactos   = llamadas (kind = 'call') de asesora en la ventana, por día;
--   * pedidos     = ventas registradas (order_sales) en la ventana, por día.
--
-- El día y la hora se calculan en la zona horaria de la tienda, igual que
-- `tzParts`. `p_today` viene del código para que «hoy» sea el mismo día que ve
-- la pantalla y no dependa del reloj del servidor.
--
-- `security invoker`: la RLS de leads, lead_calls y order_sales sigue mandando.
-- Idempotente. No toca datos.
-- ============================================================================

create or replace function public.lead_insights_rollup(
  p_store_ids    uuid[],
  p_window_start timestamptz,
  p_tz           text,
  p_today        text
)
returns table (bucket text, key text, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with entrants as (
    select coalesce(first_seen_at, created_at) as at
    from public.leads
    where store_id = any(p_store_ids)
      and (first_seen_at >= p_window_start
           or (first_seen_at is null and created_at >= p_window_start))
  ),
  calls as (
    select lead_id, occurred_at
    from public.lead_calls
    where store_id = any(p_store_ids)
      and new_status is not null
      and new_status <> 'nuevo'
  ),
  first_in as (
    select lead_id, min(occurred_at) as at
    from calls
    where occurred_at >= p_window_start
    group by lead_id
  ),
  leavers as (
    select f.at
    from first_in f
    where not exists (
      select 1 from calls c
      where c.lead_id = f.lead_id and c.occurred_at < p_window_start
    )
  ),
  sin_llamar as (
    select coalesce(last_interaction_at, first_seen_at) as at
    from public.leads
    where store_id = any(p_store_ids)
      and category in ('open', 'hot')
      and status = 'nuevo'
  ),
  contactos as (
    select occurred_at as at
    from public.lead_calls
    where store_id = any(p_store_ids)
      and vendedora is not null
      and kind = 'call'
      and occurred_at >= p_window_start
  ),
  pedidos as (
    select occurred_at as at
    from public.order_sales
    where store_id = any(p_store_ids)
      and occurred_at >= p_window_start
  )
  select 'entran', to_char(at at time zone p_tz, 'YYYY-MM-DD'), count(*)
    from entrants where at is not null group by 2
  union all
  select 'entran_hora', extract(hour from at at time zone p_tz)::int::text, count(*)
    from entrants where at is not null and to_char(at at time zone p_tz, 'YYYY-MM-DD') = p_today group by 2
  union all
  select 'cierran', to_char(at at time zone p_tz, 'YYYY-MM-DD'), count(*)
    from leavers where at is not null group by 2
  union all
  select 'cierran_hora', extract(hour from at at time zone p_tz)::int::text, count(*)
    from leavers where at is not null and to_char(at at time zone p_tz, 'YYYY-MM-DD') = p_today group by 2
  union all
  select 'sin_llamar', to_char(at at time zone p_tz, 'YYYY-MM-DD'), count(*)
    from sin_llamar where at is not null group by 2
  union all
  select 'contactos', to_char(at at time zone p_tz, 'YYYY-MM-DD'), count(*)
    from contactos where at is not null group by 2
  union all
  select 'pedidos', to_char(at at time zone p_tz, 'YYYY-MM-DD'), count(*)
    from pedidos where at is not null group by 2
$$;

comment on function public.lead_insights_rollup(uuid[], timestamptz, text, text) is
  'Conteos del panel de gráficos de Leads agrupados en la base (una fila por cubo y día/hora), en vez de drenar ~17.000 filas por carga. security invoker: la RLS sigue mandando.';

revoke all on function public.lead_insights_rollup(uuid[], timestamptz, text, text) from public, anon;
grant execute on function public.lead_insights_rollup(uuid[], timestamptz, text, text) to authenticated, service_role;
