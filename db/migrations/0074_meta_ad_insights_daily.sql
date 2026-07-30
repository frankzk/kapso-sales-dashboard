-- Histórico diario de Meta Ads por tienda, cuenta y anuncio.
--
-- Meta puede ajustar atribución y métricas después del día original, por eso el
-- sincronizador hace UPSERT de una ventana móvil en lugar de insertar una sola
-- vez. La clave compuesta evita duplicados incluso al rehacer el backfill.
create table if not exists public.meta_ad_insights_daily (
  store_id                 uuid not null references public.stores(id) on delete cascade,
  account_id               text not null,
  account_name             text,
  currency                 text,
  date                     date not null,
  campaign_id              text,
  campaign_name            text,
  adset_id                 text,
  adset_name               text,
  ad_id                    text not null,
  ad_name                  text,
  spend                    numeric(16, 4) not null default 0,
  impressions              bigint not null default 0,
  reach                    bigint not null default 0,
  frequency                numeric(12, 6),
  clicks                    bigint not null default 0,
  inline_link_clicks        bigint not null default 0,
  ctr                      numeric(12, 6),
  cpm                      numeric(16, 6),
  cpc                      numeric(16, 6),
  actions                  jsonb not null default '[]'::jsonb,
  cost_per_action_type     jsonb not null default '[]'::jsonb,
  synced_at                timestamptz not null default now(),
  primary key (store_id, account_id, ad_id, date)
);

create index if not exists meta_ad_insights_store_date_idx
  on public.meta_ad_insights_daily (store_id, date desc);
create index if not exists meta_ad_insights_store_ad_date_idx
  on public.meta_ad_insights_daily (store_id, ad_id, date desc);
create index if not exists meta_ad_insights_store_campaign_date_idx
  on public.meta_ad_insights_daily (store_id, campaign_id, date desc);

alter table public.meta_ad_insights_daily enable row level security;

drop policy if exists meta_ad_insights_daily_select on public.meta_ad_insights_daily;
create policy meta_ad_insights_daily_select
  on public.meta_ad_insights_daily
  for select to authenticated
  using (store_id in (select public.auth_store_ids()));

grant select on public.meta_ad_insights_daily to authenticated;
grant all privileges on public.meta_ad_insights_daily to service_role;
