-- ============================================================================
-- 0256_lima_open_counts.sql
-- «Todos» de Repro Lima (MOM §9.5): los pedidos de Lima sin estado final, por
-- tienda, macroetapa y subetapa del Master, con cuántos llevan más de 7 y de 30
-- días de Lima en la etapa. Una lectura agrupada (PostgREST no agrega en
-- producción). Solo para el cliente de servicio, después de requireReproLima.
--
-- DECISIÓN DEL OWNER (13-10 y 14-10-2026): Repro Lima suma una quinta tarjeta,
-- «Todos · por entregar», con lo que todavía no se entrega (Por confirmar,
-- Preparación, Por despachar y En curso) y, aparte y con su total, lo que falta
-- cerrar (Por cerrar). No crea estados: agrupa por `macro_stage` y
-- `macro_substage`, que escribe el resolver; `MOM_RESOLUTION_VERSION` no cambia.
--
-- QUÉ PEDIDOS. Los de las tiendas que se piden (`p_store_ids`, el alcance que
-- ya resolvió el servidor con getAccessibleStores) con cobertura Lima
-- (`order_master.coverage = 'lima'`, la columna que escribe el trigger
-- `order_master_coverage`, 0083) en cualquier macroetapa menos «Finalizado».
-- Es el mismo filtro que aplica el Master con la cobertura «Lima»
-- (`in("coverage", …)`), así que cada cifra coincide con la lista que abre.
--
-- ANTIGÜEDAD. Días de Lima desde `macro_since`: la fecha de Lima de hoy
-- (`p_today`, la manda el servidor con limaClock) menos la fecha de Lima en
-- que entró a la etapa, estrictamente más de 7 y más de 30. Un pedido sin
-- `macro_since` cuenta solo en el total.
--
-- COSTO. Usa `order_master_store_coverage_idx` (0078): unos 18 ms sobre ~8,3k
-- filas abiertas de Lima el 14-10-2026, y devuelve a lo más unas 40 filas. Sin
-- índice nuevo.
--
-- Idempotente: `create or replace` y permisos que se pueden repetir. Sin
-- sentencias destructivas, que dejan colgado `apply_migration` de Supabase.
-- ============================================================================

create or replace function public.order_master_lima_open_counts(p_store_ids uuid[], p_today date)
returns table (store_id uuid, macro_stage text, macro_substage text, total bigint, over_7 bigint, over_30 bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select om.store_id, om.macro_stage, om.macro_substage,
         count(*)::bigint,
         count(*) filter (where p_today - (om.macro_since at time zone 'America/Lima')::date > 7)::bigint,
         count(*) filter (where p_today - (om.macro_since at time zone 'America/Lima')::date > 30)::bigint
  from public.order_master as om
  where om.store_id = any(p_store_ids)
    and om.coverage = 'lima'
    and om.macro_stage is not null
    and om.macro_stage <> 'finalizado'
  group by om.store_id, om.macro_stage, om.macro_substage;
$$;

revoke all on function public.order_master_lima_open_counts(uuid[], date) from public, anon, authenticated;
grant execute on function public.order_master_lima_open_counts(uuid[], date) to service_role;

comment on function public.order_master_lima_open_counts(uuid[], date) is
  'Repro Lima «Todos»: pedidos de Lima (coverage) sin Finalizado, por tienda, macroetapa y subetapa, con más de 7 y 30 días de Lima en la etapa.';
