-- ============================================================================
-- 0032_lead_ship_address.sql — surface the full shipping address on cart leads.
--
-- The abandoned-cart card (lead drawer) showed only distrito + referencia, even
-- though the Shopify draft carries the whole address. `district`, `province`,
-- `region` and `referencia` were already denormalized onto the lead (0013); this
-- adds the two remaining pieces so an advisor sees where/whom to ship to without
-- opening Shopify:
--   - address1   — the street line (e.g. "Felipe Sassone 183").
--   - ship_name  — the recipient on the shipping address (draft customer_name),
--                  which can differ from the lead's own name (someone ordering
--                  for a relative).
-- Both come from data already captured in draft_orders, so they fill in on the
-- next sync for every open cart — no Shopify re-fetch. RLS: covered by the
-- existing leads policies (no new grants needed).
-- ============================================================================

alter table leads add column if not exists address1  text;
alter table leads add column if not exists ship_name text;
