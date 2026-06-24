-- ============================================================================
-- seed_meta_ads_viaja_sin_maletas.sql
-- Real Meta attribution for the "✈️ Viaja Sin Maletas" / TravelersBackpack
-- creatives, resolved from the Meta Marketing API on 2026-06-24
-- (account 1253056442078246 "Aurela 10 ACC 2 usd"). These 7 ads share one
-- campaign + adset and the same CTWA headline, so they were indistinguishable
-- in the dashboard until now. Re-runnable (upserts on ad_id).
--
-- To refresh for other ads: query the Meta Marketing API for the ad_ids that
-- appear in `select distinct ad_id from leads where source='meta_ad'` and upsert
-- the same columns here.
-- ============================================================================
insert into meta_ads
  (ad_id, account_id, campaign_id, campaign_name, objective, adset_id, adset_name, ad_name, status)
values
  ('120246655557300657', '1253056442078246', '120246653018520657', 'CBO Msj | TravelersBackpack | 2306 Campaña', 'OUTCOME_ENGAGEMENT', '120246653018510657', 'CBO Msj | TravelersBackpack | 2306 Conjunto de anuncios', 'mochila viral 81 9:16', 'ACTIVE'),
  ('120246653018500657', '1253056442078246', '120246653018520657', 'CBO Msj | TravelersBackpack | 2306 Campaña', 'OUTCOME_ENGAGEMENT', '120246653018510657', 'CBO Msj | TravelersBackpack | 2306 Conjunto de anuncios', 'mochila viral 33', 'ACTIVE'),
  ('120246655504730657', '1253056442078246', '120246653018520657', 'CBO Msj | TravelersBackpack | 2306 Campaña', 'OUTCOME_ENGAGEMENT', '120246653018510657', 'CBO Msj | TravelersBackpack | 2306 Conjunto de anuncios', 'mochila viral 81', 'ACTIVE'),
  ('120246655617860657', '1253056442078246', '120246653018520657', 'CBO Msj | TravelersBackpack | 2306 Campaña', 'OUTCOME_ENGAGEMENT', '120246653018510657', 'CBO Msj | TravelersBackpack | 2306 Conjunto de anuncios', 'mochila viral 82 9:16', 'ACTIVE'),
  ('120246653255450657', '1253056442078246', '120246653018520657', 'CBO Msj | TravelersBackpack | 2306 Campaña', 'OUTCOME_ENGAGEMENT', '120246653018510657', 'CBO Msj | TravelersBackpack | 2306 Conjunto de anuncios', 'mochila viral 31', 'ACTIVE'),
  ('120246653238060657', '1253056442078246', '120246653018520657', 'CBO Msj | TravelersBackpack | 2306 Campaña', 'OUTCOME_ENGAGEMENT', '120246653018510657', 'CBO Msj | TravelersBackpack | 2306 Conjunto de anuncios', 'mochila viral 30', 'ACTIVE'),
  ('120246655545580657', '1253056442078246', '120246653018520657', 'CBO Msj | TravelersBackpack | 2306 Campaña', 'OUTCOME_ENGAGEMENT', '120246653018510657', 'CBO Msj | TravelersBackpack | 2306 Conjunto de anuncios', 'mochila viral 81 9:16', 'ACTIVE')
on conflict (ad_id) do update set
  account_id    = excluded.account_id,
  campaign_id   = excluded.campaign_id,
  campaign_name = excluded.campaign_name,
  objective     = excluded.objective,
  adset_id      = excluded.adset_id,
  adset_name    = excluded.adset_name,
  ad_name       = excluded.ad_name,
  status        = excluded.status,
  fetched_at    = now();
