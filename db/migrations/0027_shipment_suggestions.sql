-- ============================================================================
-- 0027_shipment_suggestions.sql — batch Shopify-search auto-match suggestions
-- for the "Revisión" queue. A suggestion is a HIGH-CONFIDENCE candidate found
-- by live-searching Shopify (order-reference + phone cross-validated), but it
-- is never applied automatically — a human must confirm it via the existing
-- resolveShipmentMatch/linkShipmentToShopifyOrder actions. suggestion_checked_at
-- marks a shipment as already processed by the batch job (skip on re-run),
-- regardless of whether a suggestion was found, so the job is resumable.
-- Idempotent: safe to re-run.
-- ============================================================================

alter table shipments add column if not exists suggested_order_gid text;
alter table shipments add column if not exists suggested_store_id uuid references stores(id) on delete set null;
alter table shipments add column if not exists suggested_order_name text;
alter table shipments add column if not exists suggestion_checked_at timestamptz;

-- Drives "next N unchecked" selection for the batch job — partial index keeps
-- it small/fast since the vast majority of shipments (delivered/closed/already
-- matched) are never candidates for this scan.
create index if not exists shipments_suggestion_pending_idx
  on shipments (created_at)
  where matched = false and suggestion_checked_at is null;
