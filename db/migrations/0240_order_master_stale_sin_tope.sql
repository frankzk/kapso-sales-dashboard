-- ============================================================================
-- 0240_order_master_stale_sin_tope.sql — el detector de desfase del Master
-- vuelve a ver la tienda entera.
--
-- QUÉ PASABA (medido el 10-10-2026, tienda Kenku). `order_master_stale` (0123)
-- recorría las filas del Master del recálculo más viejo al más nuevo con un tope
-- de 20.000 (`p_scan`). Kenku ya tiene 23.946: las ~3.900 recalculadas más
-- recientemente quedaban FUERA del recorrido. Y esas no son «lo que menos falta
-- hace mirar», como suponía la 0123: son los pedidos vivos, los que los barridos
-- de los couriers tocan cada hora. A las 18:00 había 293 pedidos desfasados en
-- Kenku y la función devolvía 7; a las 17:00, 1.433 desfasados y 37 vistos. Un
-- desfasado fuera del recorrido solo volvía a entrar cuando otros ~3.900 se
-- recalculaban después de él: horas con la etapa vieja en pantalla. Fue el caso
-- de #KP136038, descartado a las 15:40 y todavía en «Gestión Reproprovincia»
-- a las 18:00.
--
-- Es la misma trampa que la 0123 vino a cerrar —una ventana con fondo, por la
-- que un pedido podía no volver a entrar—, abierta por el otro extremo.
--
-- POR QUÉ SE PUEDE QUITAR EL TOPE. La 0123 lo justificaba con el índice
-- (store_id, recomputed_at): con él la base recorría en orden y paraba al juntar
-- `p_limit`. La 0204 borró ese índice (medido: la consulta iba más rápida sin
-- él, y el índice impedía las escrituras HOT), así que la base ya ordenaba la
-- tienda entera en cada pasada; el tope solo recortaba qué filas se miraban
-- después. Medido en producción con las 23.946 filas de Kenku:
--
--     función de la 0123 (tope 20.000) ........ 84 ms, 7 de 293 desfasados
--     esta función (sin tope) .................. 90 ms, los 293
--
-- El `lateral` calcula UNA vez la última escritura de las guías de cada pedido;
-- la forma anterior la calculaba dos veces por fila (filtro y columna), y por
-- eso recorrer todo con ella costaba 223 ms.
--
-- LO QUE NO CAMBIA. La regla (MOM §19.1): un pedido está desfasado si alguna de
-- sus guías se escribió después de su último recálculo. El orden: del recálculo
-- más viejo al más nuevo, para que un atraso se drene empezando por lo que lleva
-- más tiempo mintiendo. Y la firma: `p_scan` se conserva para no romper a
-- nadie, pero por defecto ya no recorta (`limit null` es «sin límite» en
-- Postgres). Quien lo pase a mano sigue recortando como antes.
-- ============================================================================

create or replace function order_master_stale(
  p_store_id uuid,
  p_limit int default 1000,
  p_scan int default null
)
returns table (order_id uuid, recomputed_at timestamptz, guide_updated_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select m.order_id, m.recomputed_at, g.guide_updated_at
  from (
    select om.order_id, om.recomputed_at
    from order_master om
    where om.store_id = p_store_id
    order by om.recomputed_at asc
    limit p_scan
  ) m
  cross join lateral (
    select max(s.updated_at) as guide_updated_at
    from shipments s
    where s.order_id = m.order_id
  ) g
  where g.guide_updated_at > m.recomputed_at
  order by m.recomputed_at asc
  limit p_limit;
$function$;

comment on function order_master_stale(uuid, int, int) is
  'Pedidos cuya fila del Master es anterior a la última escritura de sus guías. Definición canónica del desfase (0123, MOM §19.1): del recálculo más viejo al más nuevo y, desde la 0240, sobre la tienda entera (p_scan solo recorta si se pasa).';

grant execute on function order_master_stale(uuid, int, int) to service_role;
