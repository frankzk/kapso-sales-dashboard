-- ============================================================================
-- 0011_meta_ads.sql — Meta ad attribution lookup (resolved from the Marketing API)
-- A Click-to-WhatsApp lead only carries ad_id + a shared creative headline
-- (referral.headline), so many distinct creatives collapse to one identical
-- on-screen label ("✈️ Viaja Sin Maletas"). This table maps each Meta ad_id to
-- its real ad / adset / campaign names (+ objective, a status snapshot, and the
-- owning account for an Ads Manager deep link) so "Rendimiento por campaña" and
-- the lead drawer can show the actual creative instead of the repeated headline.
--
-- Keyed by the globally-unique Meta ad_id (NOT store-scoped); creative names are
-- not store-sensitive. Populated out-of-band from the Meta API; read-only for
-- the app. Apply AFTER supabase/policies.sql (this file self-contains its RLS,
-- like 0004_leads.sql, since policies.sql runs before the later migrations).
-- ============================================================================
create table if not exists meta_ads (
  ad_id         text primary key,
  account_id    text,
  campaign_id   text,
  campaign_name text,
  objective     text,
  adset_id      text,
  adset_name    text,
  ad_name       text,
  status        text,
  fetched_at    timestamptz not null default now()
);

-- RLS: non-sensitive creative metadata — any authenticated user may read all
-- rows (the app only ever looks up ad_ids that appear in its own leads). Writes
-- happen only via the service role (BYPASSRLS) / the psql seed.
alter table meta_ads enable row level security;

drop policy if exists meta_ads_select on meta_ads;
create policy meta_ads_select on meta_ads for select to authenticated
  using (true);

grant select on meta_ads to authenticated;
grant all privileges on meta_ads to service_role;
