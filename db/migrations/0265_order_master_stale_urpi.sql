-- ============================================================================
-- 0265_order_master_stale_urpi.sql — el desfase del Master también mira el
-- reporte de Urpi (MOM §9.3 «Intentos de entrega», §30.11, 15-10-2026).
--
-- POR QUÉ. Desde el 15-10-2026 la columna de intentos del Master suma los que
-- reporta Urpi en su export (`urpi_report_rows`): #KP131545, cancelado por Urpi
-- el 01/09, decía «0 intentos». Cargar el reporte escribe esas filas, pero no
-- toca guías ni eventos del pedido, así que el barrido no se enteraba y la
-- columna se quedaba con el número viejo hasta que otra cosa moviera el pedido.
--
-- QUÉ CAMBIA. La misma función de la 0241 —misma firma, mismos permisos—, con
-- una fuente más: la última escritura de una fila de Urpi vinculada al pedido
-- (`updated_at`, que cambia al guardar un intento nuevo o cambiado y al
-- vincular a mano) cuenta igual que la de una guía. Se ancla en el dato, no en
-- que la carga se acuerde de recalcular, que es la regla de la 0123.
--
-- Correrla otra vez no cambia nada (`create or replace`).
-- ============================================================================

create or replace function order_master_stale(
  p_store_id uuid,
  p_limit int default 1000
)
returns table (order_id uuid, recomputed_at timestamptz, guide_updated_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select m.order_id, m.recomputed_at, g.guide_updated_at
  from order_master m
  join (
    select x.order_id, max(x.touched_at) as guide_updated_at
    from (
      select s.order_id, s.updated_at as touched_at from shipments s
      union all
      select r.order_id, r.updated_at from urpi_report_rows r where r.order_id is not null
    ) x
    group by x.order_id
  ) g on g.order_id = m.order_id
  where m.store_id = p_store_id
    and g.guide_updated_at > m.recomputed_at
  order by m.recomputed_at asc
  limit p_limit;
$function$;

comment on function order_master_stale(uuid, int) is
  'Pedidos cuya fila del Master es anterior a la última escritura de sus guías o de sus filas del reporte de Urpi (0265). Definición canónica del desfase (0123); sin tope de recorrido desde la 0240.';

revoke all on function order_master_stale(uuid, int) from public, anon, authenticated;
grant execute on function order_master_stale(uuid, int) to service_role;
