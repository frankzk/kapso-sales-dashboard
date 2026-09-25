-- ============================================================================
-- 0192_gf_stop_retry_same_shipment.sql — un paquete «no entregado» puede
-- volver a salir otro día con el mismo envío (MOM §29.5).
--
-- 0159 creó `delivery_stop_shipment_uniq` sobre `delivery_stops(shipment_id)`
-- para TODA la historia: un envío solo podía tener una parada, jamás. Pero el
-- reintento es la operación normal: el paquete que el 23-09 quedó «no
-- entregado» sale de nuevo el 25-09 con el mismo `shipment_id` (ni la guía ni
-- el QR cambian). Al completar la recepción de la caja, el disparador
-- `gf_received_load_to_delivery` inserta la parada de la ruta de hoy y chocaba
-- con la del 23-09: el motorizado veía «duplicate key value violates unique
-- constraint "delivery_stop_shipment_uniq"» al escanear el último paquete y la
-- caja no le llegaba nunca (25-09-2026: Yhoni 21/22, Roy 16/17).
--
-- Regla: lo que no puede existir son dos paradas ABIERTAS (`pendiente`) del
-- mismo envío, es decir, el mismo paquete en dos rutas a la vez. Las paradas
-- ya reportadas son historia y se conservan tal cual; un reintento suma una
-- parada nueva en la ruta del día, nunca sustituye la anterior.
-- ============================================================================
drop index if exists delivery_stop_shipment_uniq;
create unique index if not exists delivery_stop_shipment_open_uniq
  on delivery_stops(shipment_id) where shipment_id is not null and status = 'pendiente';
