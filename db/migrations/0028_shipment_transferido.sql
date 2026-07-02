-- ============================================================================
-- 0028_shipment_transferido.sql — new terminal status "transferido" (category
-- "transferred") for the Aliclik "parent" guide once a Fenix sub-guide is
-- created for it. Without this, the parent kept its old category (usually
-- en_ruta) and showed up duplicated alongside its Fenix child in the same
-- active tabs/counts. No schema change needed (delivery_status/status_category
-- are free-text columns, no CHECK constraint) — this is a one-time backfill
-- for guides that were already transferred before this migration. Going
-- forward, createFenixGuide sets these columns directly when the child is
-- created. Idempotent.
-- ============================================================================

update shipments
set delivery_status = 'transferido', status_category = 'transferred'
where courier = 'aliclik'
  and fenix_shipment_id is not null
  and delivery_status <> 'transferido';
