-- ============================================================================
-- 0026_shipment_states_v2.sql — remap the shipment state model to the gestión +
-- Fenix flow (Pendiente / En ruta / Entregado / Anulado). Adds delivered_source
-- (sub-state of Entregado: 'aliclik' from the report vs 'fenix' from gestión) and
-- rewrites the old delivery_status / status_category codes:
--   entregado                                   → entregado / delivered  (source aliclik)
--   devuelto                                    → anulado   / closed
--   reprogramado                                → en_ruta   / in_route
--   everything else (por_preparar…validado,     → pendiente / pending
--     por_devolver, dejado_almacen, remanente…)
-- reroute_attempts is kept as-is (becomes the Intento counter). fenix_eligible is
-- left untouched here — it is recomputed on the next report import.
-- Idempotent: safe to re-run (already-new codes are excluded from the catch-all).
-- ============================================================================

alter table shipments add column if not exists delivered_source text;

update shipments set delivered_source = 'aliclik'
  where delivery_status = 'entregado' and delivered_source is null;

update shipments set delivery_status = 'anulado' where delivery_status = 'devuelto';
update shipments set delivery_status = 'en_ruta' where delivery_status = 'reprogramado';
update shipments set delivery_status = 'pendiente'
  where delivery_status not in ('entregado', 'anulado', 'en_ruta', 'pendiente');

-- normalize the category to the new 4-state set
update shipments set status_category = 'delivered' where delivery_status = 'entregado';
update shipments set status_category = 'closed'    where delivery_status = 'anulado';
update shipments set status_category = 'in_route'  where delivery_status = 'en_ruta';
update shipments set status_category = 'pending'   where delivery_status = 'pendiente';
