-- Make the historical Meta report auditable: expose the store, the actual
-- messaging-conversation action and the freshness of the synchronized rows.
-- Costs remain grouped by ad inside one store; the application never combines
-- amounts from different currencies.
drop function if exists public.meta_ad_performance(uuid, date, date);

create or replace function public.meta_ad_performance(
  p_store_id uuid,
  p_from date,
  p_to date
)
returns table (
  store_id uuid,
  ad_id text,
  account_id text,
  currency text,
  meta_conversations numeric,
  spend numeric,
  impressions bigint,
  reach bigint,
  clicks bigint,
  inline_link_clicks bigint,
  active_days bigint,
  first_date date,
  last_date date,
  synced_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with daily as (
    select
      i.*,
      coalesce((
        select max(
          case
            when jsonb_typeof(action -> 'value') = 'number'
              then (action ->> 'value')::numeric
            when (action ->> 'value') ~ '^[0-9]+(\.[0-9]+)?$'
              then (action ->> 'value')::numeric
            else 0
          end
        )
        from jsonb_array_elements(
          case when jsonb_typeof(i.actions) = 'array' then i.actions else '[]'::jsonb end
        ) action
        where action ->> 'action_type' in (
          'onsite_conversion.messaging_conversation_started_7d',
          'messaging_conversation_started_7d',
          'onsite_conversion.total_messaging_connection'
        )
      ), 0) as meta_conversations
    from public.meta_ad_insights_daily i
    where i.store_id = p_store_id
      and i.date between p_from and p_to
  )
  select
    p_store_id as store_id,
    d.ad_id,
    min(d.account_id) as account_id,
    case when count(distinct nullif(d.currency, '')) = 1 then min(nullif(d.currency, '')) end as currency,
    coalesce(sum(d.meta_conversations), 0) as meta_conversations,
    coalesce(sum(d.spend), 0) as spend,
    coalesce(sum(d.impressions), 0)::bigint as impressions,
    coalesce(sum(d.reach), 0)::bigint as reach,
    coalesce(sum(d.clicks), 0)::bigint as clicks,
    coalesce(sum(d.inline_link_clicks), 0)::bigint as inline_link_clicks,
    count(distinct d.date)::bigint as active_days,
    min(d.date) as first_date,
    max(d.date) as last_date,
    max(d.synced_at) as synced_at
  from daily d
  group by d.ad_id
  order by sum(d.spend) desc, d.ad_id;
$$;

revoke all on function public.meta_ad_performance(uuid, date, date) from public, anon;
grant execute on function public.meta_ad_performance(uuid, date, date) to authenticated, service_role;

comment on function public.meta_ad_performance(uuid, date, date) is
  'Meta Ads por anuncio y rango con conversaciones, moneda y frescura explícitas; conserva RLS mediante security invoker.';
