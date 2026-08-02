-- 0097 — Una ruta por motorizado y día; una por courier y día.
--
-- REGLA DEL NEGOCIO (Frankz): un motorizado tiene UNA ruta al día, y un courier
-- también. Partir la carga de alguien en dos rutas el mismo día no ocurre, y
-- cuando aparece una segunda es un error: los paquetes quedan repartidos entre
-- dos manifiestos y el cotejo de ninguno cuadra.
--
-- POR QUÉ CAMBIA EL ÍNDICE. El anterior era (org, fecha, courier, NOMBRE de la
-- ruta), y el nombre dejó de identificar nada: ahora es opcional y por defecto
-- se copia del motorizado. Con ese índice, dos rutas de Roy el mismo día pasaban
-- si alguien escribía nombres distintos ("Surco" y "Surco tarde"), que es
-- justamente el error que hay que impedir.
--
-- La identidad de una ruta es la MISMA que su nombre visible: la persona si la
-- hay, y si no el courier.
--
--   * Con motorizado  → único por (org, fecha, motorizado). Así Johnny, Roy y
--     Douglas tienen cada uno su ruta aunque los tres sean "motorizados
--     propios" — si el índice fuera por courier, los tres competirían por una
--     sola ruta al día y la operación de Lima se rompería.
--   * Sin motorizado   → único por (org, fecha, courier). Es el caso de Aliclik,
--     las agencias y las rutas "Sin asignar" de Urpi, Swayp o Tanders.

drop index if exists dispatch_manifest_route_uniq;

create unique index if not exists dispatch_manifest_rider_day_uniq
  on dispatch_manifests(org_id, route_date, rider_id)
  where rider_id is not null and state <> 'cancelled';

create unique index if not exists dispatch_manifest_courier_day_uniq
  on dispatch_manifests(org_id, route_date, lower(trim(courier)))
  where rider_id is null and state <> 'cancelled';
