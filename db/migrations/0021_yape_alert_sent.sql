-- ============================================================================
-- 0021_yape_alert_sent.sql — Telegram alert for unattended Yapes.
-- Tracks the last time we pinged the store's channel about a still-pending Yape,
-- so the 5-min cron doesn't spam (re-alerts at most every few hours).
-- ============================================================================

alter table leads add column if not exists yape_alert_sent_at timestamptz;
