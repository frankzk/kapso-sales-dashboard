-- Manual ad -> promoted product mapping. This keeps product attribution useful
-- before Meta Marketing API is connected and remains the auditable override
-- afterwards.
alter table public.meta_ads
  add column if not exists promoted_product_name text,
  add column if not exists promoted_skus text[] not null default '{}',
  add column if not exists promoted_product_updated_at timestamptz;
