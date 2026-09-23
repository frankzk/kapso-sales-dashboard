-- ============================================================================
-- 0186_order_master_rider_select.sql — un motorizado lee del Master los
-- pedidos de SUS rutas.
--
-- La pantalla del motorizado (/reparto, MOM §29.12) pinta cada parada con el
-- nombre, el celular, la dirección y el monto del pedido, que salen de
-- `order_master`. Esa tabla solo dejaba leer por tienda (`auth_store_ids()`),
-- y un usuario cuyo único rol es `motorizado` (0066, 0179) no tiene acceso a
-- ninguna tienda: veía sus paradas como «Sin nombre — · —». Mientras la ficha
-- de Roy estuvo atada a un usuario owner no se notó.
--
-- Regla: además de lo que ya permite la política por tienda, un usuario lee
-- las filas del Master cuyos pedidos son paradas de una ruta suya en curso o
-- cerrada, lo mismo que ya le abre `delivery_stops_select` (0067). Nada más:
-- ni pedidos de otros motorizados ni de otras rutas. La escritura del Master
-- sigue cerrada; el motorizado reporta por `delivery_stops` y el RPC.
--
-- Las paradas se resuelven en una función SECURITY DEFINER, como
-- `auth_sheet_ids()` (0179), para que la política no dependa de las políticas
-- de rutas y paradas ni las evalúe fila a fila.
-- ============================================================================

create or replace function public.auth_rider_order_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.order_id
    from delivery_stops s
    join delivery_routes r on r.id = s.route_id
   where r.rider_id = auth_rider_id()
     and r.status in ('en_curso', 'cerrada')
     and s.order_id is not null;
$$;
revoke all on function public.auth_rider_order_ids() from public, anon;
grant execute on function public.auth_rider_order_ids() to authenticated;

drop policy if exists order_master_select_rider on order_master;
create policy order_master_select_rider on order_master for select to authenticated
  using (order_id in (select auth_rider_order_ids()));
