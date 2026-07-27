-- 0057 — La ruta deja de ser de una tienda, y cerrarla mueve el Master.
--
-- Dos correcciones a 0056, ambas descubiertas al contrastar el diseño con cómo
-- se reparte de verdad:
--
--   1. UN MOTORIZADO MEZCLA TIENDAS EN LA MISMA VUELTA. Sale con paquetes de
--      Aurela y de Kenku a la vez. Con una ruta por tienda habría que armarle
--      dos y él vería dos listas para un solo viaje — inservible. La ruta pasa a
--      ser del MOTORIZADO y del DÍA; la tienda vive en cada parada, que es donde
--      de verdad está (viene del pedido).
--
--      La liquidación sigue siendo POR TIENDA, porque el dinero y el cuadre lo
--      son: cerrar una ruta mixta produce una liquidación por cada tienda que
--      aparezca en sus paradas. Un viaje, varias cuentas.
--
--   2. NADIE MOVÍA EL MASTER. Con un courier externo el estado real lo trae su
--      reporte; con motorizado propio no viene nadie detrás. Tal como estaba,
--      un pedido entregado por un motorizado propio se quedaba "pendiente" para
--      siempre y el cuadre lo marcaba como "cobro sin entrega" — en TODAS sus
--      paradas. Al cerrar la ruta, las entregas confirmadas pasan al Master por
--      el camino de siempre (`order_events`), con un humano revisando antes.

-- ----------------------------------------------------------------------------
-- La ruta es del motorizado y del día, no de la tienda.
-- ----------------------------------------------------------------------------

alter table delivery_routes drop constraint if exists delivery_routes_unique_day;
alter table delivery_routes alter column store_id drop not null;

comment on column delivery_routes.store_id is
  'Tienda principal, solo informativa. Una ruta puede mezclar tiendas: la de '
  'cada entrega vive en delivery_stops.store_id.';

-- Un motorizado tiene UNA ruta por día, mezcle lo que mezcle.
create unique index if not exists delivery_routes_rider_day_idx
  on delivery_routes(org_id, rider_id, route_date);

-- ----------------------------------------------------------------------------
-- La tienda vive en la parada.
-- ----------------------------------------------------------------------------

alter table delivery_stops
  add column if not exists store_id uuid references stores(id) on delete cascade;

-- Relleno de lo que ya hubiera: la tienda de la parada es la del pedido.
update delivery_stops s
   set store_id = o.store_id
  from orders o
 where o.id = s.order_id and s.store_id is null;

create index if not exists delivery_stops_store_idx on delivery_stops(store_id);

comment on column delivery_stops.store_id is
  'Tienda del pedido. Es lo que agrupa las liquidaciones al cerrar una ruta '
  'mixta, y lo que filtran las políticas de lectura.';

-- ----------------------------------------------------------------------------
-- Una ruta produce VARIAS liquidaciones (una por tienda), así que el vínculo
-- vive en la liquidación y no en la ruta.
-- ----------------------------------------------------------------------------

alter table rider_settlements
  add column if not exists route_id uuid references delivery_routes(id) on delete set null;

create index if not exists rider_settlements_route_idx
  on rider_settlements(route_id) where route_id is not null;

-- Se conserva `delivery_routes.settlement_id` de 0056 por compatibilidad, pero
-- deja de ser la fuente: con rutas mixtas no hay UNA liquidación que apuntar.
comment on column delivery_routes.settlement_id is
  'OBSOLETO desde 0057: una ruta mixta genera varias liquidaciones. Usa '
  'rider_settlements.route_id.';

-- ----------------------------------------------------------------------------
-- RLS: las paradas se filtran por SU tienda, no por la de la ruta.
-- ----------------------------------------------------------------------------

drop policy if exists delivery_routes_select on delivery_routes;
create policy delivery_routes_select on delivery_routes for select to authenticated
  using (
    org_id in (select auth_org_ids())
    or (rider_id = auth_rider_id() and status in ('en_curso', 'cerrada'))
  );

drop policy if exists delivery_stops_select on delivery_stops;
create policy delivery_stops_select on delivery_stops for select to authenticated
  using (
    store_id in (select auth_store_ids())
    or route_id in (
      select id from delivery_routes
       where rider_id = auth_rider_id() and status in ('en_curso', 'cerrada')
    )
  );
