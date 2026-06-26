-- ============================================================================
-- 0014_flow_webhook_secret.sql — per-store secret for the Shopify Flow webhook
-- A new inbound source ("Búsquedas abandonadas" / abandoned browse) is delivered
-- by a Shopify Flow "Send HTTP request" action to /api/webhooks/flow/[storeId].
-- It authenticates with a shared secret in the X-RecoverOps-Secret header, stored
-- encrypted at rest (AES-256-GCM, like the other store secrets). No leads change:
-- `leads.source` is free text, so the new "abandoned_browse" value needs no DDL.
-- ============================================================================
alter table stores add column if not exists flow_webhook_secret_enc text;
