-- 0095_dispatch_manifest_rider.sql — vincular el manifiesto con la ficha del
-- motorizado, conservando el nombre histórico.
--
-- Hasta ahora `dispatch_manifests.courier` y `driver_name` eran texto libre (0087):
-- el "motorizado" del despacho no tenía relación con la tabla `riders` (0064).
-- Ahora la Mesa de despacho elige el motorizado de una lista. Guardamos:
--   - `rider_id`: a qué ficha corresponde (nullable → "Sin asignar", p. ej. Urpi
--     o Swayp cuando no se conoce al conductor).
--   - `driver_name`: se conserva como COPIA HISTÓRICA del nombre al crear la ruta.
--     Si luego se renombra o desactiva al motorizado, las rutas viejas no cambian
--     (MOM §6.3: el segundo cotejo identifica quién recibió los paquetes).
--
-- `on delete set null`: borrar/limpiar una ficha no rompe el historial; el nombre
-- ya quedó copiado en `driver_name`.

alter table dispatch_manifests
  add column if not exists rider_id uuid references riders(id) on delete set null;

create index if not exists dispatch_manifests_rider_idx
  on dispatch_manifests(rider_id)
  where rider_id is not null;
