-- ============================================================================
-- 0263_lead_insights_rollup_sin_llamar.sql — el RPC del «Tablero de hoy» de
-- Leads cuenta solo lo que el tablero todavía usa: los sin llamar.
--
-- QUÉ PASABA. Desde el 15-10-2026 el «Tablero de hoy» es la opción K (el equipo
-- como ranking contra ayer, sin llamar por día y la carrera de pedidos). De los
-- siete cubos de `lead_insights_rollup` (0155) solo lee `sin_llamar`; los otros
-- seis eran del burndown, del flujo de 7 días y de la conversión que ya no
-- existen. Y seguían calculándose en cada carga: el más caro, `cierran`,
-- recorre TODO el historial de gestiones de la tienda (sin límite de fechas)
-- para descartar a quien ya había salido de la cola antes de la ventana.
-- Medido en producción el 15-10-2026 con las dos tiendas: 162 ms y 15.290
-- bloques por llamada; solo `sin_llamar`, 15 ms y 2.287 bloques.
--
-- QUÉ CAMBIA. La misma función, con la MISMA firma y el mismo tipo de retorno
-- (create or replace): el código que ya corre la llama igual y filtra el cubo
-- `sin_llamar` (`sinLlamarFromRollup`), así que da lo mismo cuál de las dos
-- versiones encuentre. `p_window_start` y `p_today` se quedan en la firma sin
-- usarse por eso mismo: cambiarla exigiría salir con el código a la vez.
--
-- El predicado es copia EXACTA del de la 0155 y del drenado de respaldo en
-- lib/leads-insights.ts (`drainSinLlamar`): leads open/hot con status 'nuevo',
-- por día local de su última interacción (o de su primer contacto).
--
-- `security invoker`: la RLS de leads sigue mandando. Idempotente. No toca
-- datos. Se puede aplicar antes o después del código.
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
  with sin_llamar as (
    select coalesce(last_interaction_at, first_seen_at) as at
    from public.leads
    where store_id = any(p_store_ids)
      and category in ('open', 'hot')
      and status = 'nuevo'
  )
  select 'sin_llamar', to_char(at at time zone p_tz, 'YYYY-MM-DD'), count(*)
    from sin_llamar where at is not null group by 2
$$;

comment on function public.lead_insights_rollup(uuid[], timestamptz, text, text) is
  'Leads sin llamar por día local de su última interacción, agrupados en la base para el «Tablero de hoy» de Leads (0263; antes, 0155, siete cubos). p_window_start y p_today siguen en la firma sin usarse. security invoker: la RLS sigue mandando.';

revoke all on function public.lead_insights_rollup(uuid[], timestamptz, text, text) from public, anon;
grant execute on function public.lead_insights_rollup(uuid[], timestamptz, text, text) to authenticated, service_role;
