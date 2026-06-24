-- ============================================================================
-- 0008_lead_source.sql — lead source / channel attribution
-- Captures where a lead came from so conversion can be measured per source
-- without removing anything from the shared WhatsApp flow. For Click-to-WhatsApp
-- (CTWA) ad campaigns, Meta puts a `referral` object on the FIRST inbound
-- message; we read it during conversation enrichment and stamp it here
-- (first-touch, sticky — never overwritten once set).
--   source       'meta_ad' for ad/post referrals; NULL = organic / not yet classified
--   ad_id        Meta ad id (referral.source_id) — for grouping by campaign/ad
--   ad_headline  ad creative headline (human-readable label, e.g. "✈️ Viaja Sin Maletas")
--   ctwa_clid    click id (for future Meta Conversions API matching)
-- ============================================================================
alter table leads add column if not exists source      text;
alter table leads add column if not exists ad_id       text;
alter table leads add column if not exists ad_headline text;
alter table leads add column if not exists ctwa_clid   text;

create index if not exists leads_store_source_idx on leads (store_id, source);
