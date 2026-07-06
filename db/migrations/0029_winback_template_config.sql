-- ============================================================================
-- 0029_winback_template_config.sql — per-store WhatsApp template for the
-- "Recuperación de clientes" (60-day winback) message. A Shopify Flow (order
-- created → wait 60 days → no new order) posts the customer to the dashboard's
-- Flow webhook with source "winback"; when enabled, the Meta-approved template
-- (discount coupon + store link button) is sent from the store's number.
-- No lead is created — a reply enters through the normal Kapso inbound flow.
-- Off by default so nothing sends until a store opts in from Settings.
-- All plain columns (template name + language are public identifiers).
-- ============================================================================
alter table stores add column if not exists winback_template_enabled  boolean not null default false;
alter table stores add column if not exists winback_template_name      text;
alter table stores add column if not exists winback_template_language  text;
