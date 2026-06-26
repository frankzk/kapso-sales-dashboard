-- ============================================================================
-- 0015_browse_template_config.sql — per-store WhatsApp template for the
-- "Búsquedas abandonadas" (abandoned browse) auto re-engagement message.
-- When enabled, a freshly-created abandoned_browse lead triggers an approved
-- WhatsApp template send (cold outreach, outside the 24h window) from the
-- store's number. Off by default so nothing sends until a store opts in from
-- Settings with a Meta-approved template. All plain columns (template name +
-- language are public identifiers, not secrets).
-- ============================================================================
alter table stores add column if not exists browse_template_enabled  boolean not null default false;
alter table stores add column if not exists browse_template_name      text;
alter table stores add column if not exists browse_template_language  text;
