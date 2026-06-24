-- ============================================================================
-- 0009_lead_inbound.sql — last inbound (customer) message time per lead
-- Powers the 24h WhatsApp session-window clock: the window is measured from the
-- customer's last inbound message, so this is what tells us how long is left
-- before the chat closes (and we can no longer send free text). Synced from
-- Kapso's conversation summary (kapso.last_inbound_at); refreshed each run.
-- ============================================================================
alter table leads add column if not exists last_inbound_at timestamptz;
create index if not exists leads_store_inbound_idx on leads (store_id, last_inbound_at);
