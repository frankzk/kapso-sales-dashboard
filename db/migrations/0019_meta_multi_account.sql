-- Multi-account Meta Ads: a store can track spend across SEVERAL ad accounts.
-- `meta_ad_accounts` is a jsonb array of { id, name }. Supersedes the single
-- meta_ad_account_id/name (kept for back-compat reads + the backfill below).
alter table stores add column if not exists meta_ad_accounts jsonb not null default '[]'::jsonb;

update stores
   set meta_ad_accounts = jsonb_build_array(
         jsonb_build_object('id', meta_ad_account_id, 'name', meta_ad_account_name)
       )
 where meta_ad_account_id is not null
   and (meta_ad_accounts is null or meta_ad_accounts = '[]'::jsonb);
