-- ============================================================================
-- 0017_telegram_summary.sql — per-store Telegram config for the daily sales
-- summary (sent at 08:00 America/Lima for the previous day). The bot token is a
-- secret (AES-256-GCM at rest, like the other store secrets); the chat id is a
-- plain identifier.
-- ============================================================================
alter table stores add column if not exists telegram_bot_token_enc text;
alter table stores add column if not exists telegram_chat_id        text;
