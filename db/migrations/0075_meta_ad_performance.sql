-- Aggregated Meta performance for the decision table.
--
-- Keeping the aggregation in Postgres avoids downloading tens of thousands of
-- daily rows on every dashboard request. SECURITY INVOKER is intentional: the
-- existing RLS policy on meta_ad_insights_daily remains authoritative.
create or replace function public.meta_ad_performance(
  p_store_id uuid,
  p_from date,
  p_to date
)
returns table (
  ad_id text,
  account_id text,
  currency text,
  spend numeric,
  impressions bigint,
  reach bigint,
  clicks bigint,
  inline_link_clicks bigint,
  active_days bigint,
  first_date date,
  last_date date
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    i.ad_id,
    min(i.account_id) as account_id,
    case when count(distinct nullif(i.currency, '')) = 1 then min(nullif(i.currency, '')) end as currency,
    coalesce(sum(i.spend), 0) as spend,
    coalesce(sum(i.impressions), 0)::bigint as impressions,
    coalesce(sum(i.reach), 0)::bigint as reach,
    coalesce(sum(i.clicks), 0)::bigint as clicks,
    coalesce(sum(i.inline_link_clicks), 0)::bigint as inline_link_clicks,
    count(distinct i.date)::bigint as active_days,
    min(i.date) as first_date,
    max(i.date) as last_date
  from public.meta_ad_insights_daily i
  where i.store_id = p_store_id
    and i.date between p_from and p_to
  group by i.ad_id
  order by sum(i.spend) desc, i.ad_id;
$$;

revoke all on function public.meta_ad_performance(uuid, date, date) from public, anon;
grant execute on function public.meta_ad_performance(uuid, date, date) to authenticated, service_role;

comment on function public.meta_ad_performance(uuid, date, date) is
  'Meta Ads por anuncio y rango. Totales crudos para calcular CPM y frecuencia ponderados; conserva RLS mediante security invoker.';
