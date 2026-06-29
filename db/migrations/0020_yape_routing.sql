-- ============================================================================
-- 0020_yape_routing.sql — v2 advisor routing for Yape/Shalom alerts.
--   * user_presence: heartbeat from the dashboard poll → who's online.
--   * leads.yape_offered_to / _at / _passed: the rotating offer state, advanced
--     lazily on each poll (no cron). Server-only (service role) reads/writes.
-- ============================================================================

create table if not exists user_presence (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
-- Only the service role touches presence (from server actions). RLS on with no
-- policies = deny for anon/authenticated; service_role bypasses RLS.
alter table user_presence enable row level security;
grant all privileges on user_presence to service_role;

-- Rotating offer state on the lead itself (one offer travels with each Yape).
alter table leads add column if not exists yape_offered_to uuid references auth.users(id) on delete set null;
alter table leads add column if not exists yape_offered_at timestamptz;
alter table leads add column if not exists yape_passed uuid[] not null default '{}';

create index if not exists leads_yape_offer_idx
  on leads(store_id) where status = 'yape_por_verificar';
