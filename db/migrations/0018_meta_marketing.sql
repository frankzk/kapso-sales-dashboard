-- Meta (Facebook) Marketing API connection per store, so ad SPEND can later be
-- matched to closed COD sales (ROAS). The access token is a secret (encrypted at
-- rest like the other *_enc columns); the selected ad account id/name are plain.
alter table stores add column if not exists meta_access_token_enc text;
alter table stores add column if not exists meta_ad_account_id     text;
alter table stores add column if not exists meta_ad_account_name   text;
