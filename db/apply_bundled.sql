-- ============================================================================
-- apply_bundled.sql — full schema + RLS for the Supabase SQL Editor.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- (Generated from db/migrations/0001+0002+0003 + supabase/policies.sql.)
-- If you have psql instead, prefer:  psql "$DATABASE_URL" -f db/apply.sql
-- ============================================================================

-- ---- 0001_init.sql ----
-- ============================================================================
-- 0001_init.sql — core schema for the Kapso multi-store sales dashboard
-- Apply with:  psql "$DATABASE_URL" -f db/migrations/0001_init.sql
-- RLS policies live in supabase/policies.sql (apply after migrations).
-- ============================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Tenancy
-- ----------------------------------------------------------------------------
create table if not exists organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- A user belongs to an organization with a role. Owners/admins implicitly
-- get access to every store in the org; viewers only to explicitly granted ones.
create table if not exists memberships (
  user_id     uuid not null references auth.users(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (user_id, org_id)
);
create index if not exists memberships_org_idx on memberships(org_id);

-- A Shopify store wired to a Kapso WhatsApp bot. Per-store API credentials are
-- stored AES-256-GCM encrypted (see lib/crypto.ts); they are entered at runtime
-- in the "Connect store" screen and never committed or exposed to the client.
create table if not exists stores (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations(id) on delete cascade,
  name                      text not null,
  shopify_domain            text not null,           -- e.g. aurela.myshopify.com
  shopify_token_enc         text,                    -- enc: Admin API access token
  shopify_webhook_secret_enc text,                   -- enc: API secret key for HMAC
  kapso_project_id          text,
  kapso_api_key_enc         text,                    -- enc: Kapso Platform API key
  whatsapp_phone_number_id  text,
  currency                  text not null default 'PEN',
  timezone                  text not null default 'America/Lima',
  status                    text not null default 'active'
                              check (status in ('active', 'paused', 'disabled')),
  created_at                timestamptz not null default now(),
  unique (org_id, shopify_domain)
);
create index if not exists stores_org_idx on stores(org_id);

-- Explicit per-user, per-store grants (the fine-grained access layer).
create table if not exists user_store_access (
  user_id     uuid not null references auth.users(id) on delete cascade,
  store_id    uuid not null references stores(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, store_id)
);
create index if not exists user_store_access_store_idx on user_store_access(store_id);

-- ----------------------------------------------------------------------------
-- Ingested business data
-- ----------------------------------------------------------------------------

-- Orders created by the WhatsApp bot in Shopify (tag:kapso). Upserted by both
-- the webhook handler and the reconciliation cron; idempotent on (store, order).
create table if not exists orders (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references stores(id) on delete cascade,
  shopify_order_id    text not null,             -- numeric id as text
  name                text,                      -- order name, e.g. "#1001"
  created_at          timestamptz,               -- Shopify created_at
  processed_at        timestamptz,
  updated_at          timestamptz,               -- Shopify updated_at (cursor)
  total_amount        numeric(14, 2),
  currency            text,
  financial_status    text,
  tags                text[] not null default '{}',
  promo_applied       boolean not null default false,   -- tag promo-whatsapp
  stock_por_validar   boolean not null default false,   -- tag/attr stock-por-validar
  shipping_mode       text,                      -- 'cod' (contraentrega) | 'agency'
  kapso_conversation_id text,                    -- from note_attributes
  line_items          jsonb not null default '[]'::jsonb,
  raw                 jsonb,                     -- raw source payload (audit)
  ingested_at         timestamptz not null default now(),
  unique (store_id, shopify_order_id)
);
create index if not exists orders_store_created_idx on orders(store_id, created_at);
create index if not exists orders_store_conv_idx on orders(store_id, kapso_conversation_id);
create index if not exists orders_tags_gin on orders using gin (tags);

-- WhatsApp conversations pulled from the Kapso Platform API.
create table if not exists conversations (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete cascade,
  kapso_conversation_id text not null,
  phone_number_id       text,
  started_at            timestamptz,
  status                text,
  message_count         integer not null default 0,
  last_message_at       timestamptz,
  raw                   jsonb,
  ingested_at           timestamptz not null default now(),
  unique (store_id, kapso_conversation_id)
);
create index if not exists conversations_store_started_idx on conversations(store_id, started_at);

-- Pre-aggregated per-day metrics (rebuilt by recompute_daily_rollups()).
create table if not exists daily_rollups (
  store_id              uuid not null references stores(id) on delete cascade,
  date                  date not null,
  orders_count          integer not null default 0,
  revenue               numeric(14, 2) not null default 0,
  aov                   numeric(14, 2) not null default 0,
  conversations_count   integer not null default 0,
  conversion_rate       numeric(6, 4) not null default 0,
  promo_orders          integer not null default 0,
  stock_validar_orders  integer not null default 0,
  cod_orders            integer not null default 0,
  agency_orders         integer not null default 0,
  updated_at            timestamptz not null default now(),
  primary key (store_id, date)
);

-- ----------------------------------------------------------------------------
-- Operational + sync bookkeeping
-- ----------------------------------------------------------------------------

-- Point-in-time operational snapshots for the Kapso "operativo" family
-- (number health, api_logs errors/latency, 24h activity). best-effort payload.
create table if not exists ops_snapshots (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  captured_at  timestamptz not null default now(),
  payload      jsonb not null default '{}'::jsonb
);
create index if not exists ops_snapshots_store_time_idx on ops_snapshots(store_id, captured_at desc);

-- Per-source ingestion cursor + status.
create table if not exists sync_state (
  store_id     uuid not null references stores(id) on delete cascade,
  source       text not null,               -- 'shopify' | 'kapso' | 'ops'
  cursor       text,
  last_run_at  timestamptz,
  status       text,
  error        text,
  primary key (store_id, source)
);

-- Webhook delivery log for idempotency + audit. webhook_id is the Shopify
-- delivery id (X-Shopify-Webhook-Id) or, if absent, a hash of the body.
create table if not exists webhook_events (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  topic        text not null,
  shopify_id   text,                         -- resource (order) id
  webhook_id   text not null,                -- idempotency key
  received_at  timestamptz not null default now(),
  processed    boolean not null default false,
  error        text,
  unique (store_id, webhook_id)
);
create index if not exists webhook_events_store_idx on webhook_events(store_id, received_at desc);

-- ---- 0002_rollups.sql ----
-- ============================================================================
-- 0002_rollups.sql — authoritative daily rollup recompute
-- Rebuilds daily_rollups for a store over a date range from orders +
-- conversations. Dates are bucketed in the store's own timezone so that
-- "today" matches what the merchant sees. Called by /api/cron/sync via RPC.
-- ============================================================================

create or replace function public.recompute_daily_rollups(
  p_store_id uuid,
  p_from     date,
  p_to       date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tz text;
begin
  select timezone into tz from stores where id = p_store_id;
  if tz is null then
    tz := 'UTC';
  end if;

  delete from daily_rollups
   where store_id = p_store_id
     and date between p_from and p_to;

  with o as (
    select (created_at at time zone tz)::date as d,
           count(*)                                        as orders_count,
           coalesce(sum(total_amount), 0)                  as revenue,
           count(*) filter (where promo_applied)           as promo_orders,
           count(*) filter (where stock_por_validar)       as stock_validar_orders,
           count(*) filter (where shipping_mode = 'cod')   as cod_orders,
           count(*) filter (where shipping_mode = 'agency') as agency_orders
      from orders
     where store_id = p_store_id
       and created_at is not null
       and (created_at at time zone tz)::date between p_from and p_to
     group by 1
  ),
  c as (
    select (started_at at time zone tz)::date as d,
           count(*) as conversations_count
      from conversations
     where store_id = p_store_id
       and started_at is not null
       and (started_at at time zone tz)::date between p_from and p_to
     group by 1
  ),
  days as (
    select d from o
    union
    select d from c
  )
  insert into daily_rollups (
    store_id, date, orders_count, revenue, aov, conversations_count,
    conversion_rate, promo_orders, stock_validar_orders, cod_orders,
    agency_orders, updated_at
  )
  select
    p_store_id,
    days.d,
    coalesce(o.orders_count, 0),
    coalesce(o.revenue, 0),
    case when coalesce(o.orders_count, 0) > 0
         then round(coalesce(o.revenue, 0) / o.orders_count, 2)
         else 0 end,
    coalesce(c.conversations_count, 0),
    case when coalesce(c.conversations_count, 0) > 0
         then round(coalesce(o.orders_count, 0)::numeric / c.conversations_count, 4)
         else 0 end,
    coalesce(o.promo_orders, 0),
    coalesce(o.stock_validar_orders, 0),
    coalesce(o.cod_orders, 0),
    coalesce(o.agency_orders, 0),
    now()
  from days
  left join o on o.d = days.d
  left join c on c.d = days.d;
end;
$$;

-- Only the ingestion path (service role) may recompute rollups.
revoke all on function public.recompute_daily_rollups(uuid, date, date) from public;
grant execute on function public.recompute_daily_rollups(uuid, date, date) to service_role;

-- ---- 0003_refunds.sql ----
-- ============================================================================
-- 0003_refunds.sql — cancellations + refunds → net revenue
--
-- COD stores cancel a meaningful share of orders; counting them as revenue
-- overstates sales. We track per-order cancellation + refunded amount and make
-- revenue NET: revenue = Σ(total_amount − total_refunded) over non-cancelled
-- orders; cancelled orders are excluded from revenue and the breakdown counts.
-- ============================================================================

alter table orders
  add column if not exists cancelled_at    timestamptz,
  add column if not exists total_refunded  numeric(14, 2) not null default 0;

alter table daily_rollups
  add column if not exists cancelled_orders integer not null default 0,
  add column if not exists refunded_amount  numeric(14, 2) not null default 0;

-- Recompute now nets refunds and excludes cancelled orders from sales metrics.
create or replace function public.recompute_daily_rollups(
  p_store_id uuid,
  p_from     date,
  p_to       date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tz text;
begin
  select timezone into tz from stores where id = p_store_id;
  if tz is null then
    tz := 'UTC';
  end if;

  delete from daily_rollups
   where store_id = p_store_id
     and date between p_from and p_to;

  with o as (
    select (created_at at time zone tz)::date as d,
           count(*) filter (where cancelled_at is null)                                  as orders_count,
           coalesce(sum(total_amount - total_refunded) filter (where cancelled_at is null), 0) as revenue,
           coalesce(sum(total_refunded) filter (where cancelled_at is null), 0)          as refunded_amount,
           count(*) filter (where cancelled_at is not null)                              as cancelled_orders,
           count(*) filter (where cancelled_at is null and promo_applied)                as promo_orders,
           count(*) filter (where cancelled_at is null and stock_por_validar)            as stock_validar_orders,
           count(*) filter (where cancelled_at is null and shipping_mode = 'cod')        as cod_orders,
           count(*) filter (where cancelled_at is null and shipping_mode = 'agency')     as agency_orders
      from orders
     where store_id = p_store_id
       and created_at is not null
       and (created_at at time zone tz)::date between p_from and p_to
     group by 1
  ),
  c as (
    select (started_at at time zone tz)::date as d,
           count(*) as conversations_count
      from conversations
     where store_id = p_store_id
       and started_at is not null
       and (started_at at time zone tz)::date between p_from and p_to
     group by 1
  ),
  days as (
    select d from o
    union
    select d from c
  )
  insert into daily_rollups (
    store_id, date, orders_count, revenue, aov, conversations_count,
    conversion_rate, promo_orders, stock_validar_orders, cod_orders,
    agency_orders, cancelled_orders, refunded_amount, updated_at
  )
  select
    p_store_id,
    days.d,
    coalesce(o.orders_count, 0),
    coalesce(o.revenue, 0),
    case when coalesce(o.orders_count, 0) > 0
         then round(coalesce(o.revenue, 0) / o.orders_count, 2)
         else 0 end,
    coalesce(c.conversations_count, 0),
    case when coalesce(c.conversations_count, 0) > 0
         then round(coalesce(o.orders_count, 0)::numeric / c.conversations_count, 4)
         else 0 end,
    coalesce(o.promo_orders, 0),
    coalesce(o.stock_validar_orders, 0),
    coalesce(o.cod_orders, 0),
    coalesce(o.agency_orders, 0),
    coalesce(o.cancelled_orders, 0),
    coalesce(o.refunded_amount, 0),
    now()
  from days
  left join o on o.d = days.d
  left join c on c.d = days.d;
end;
$$;

revoke all on function public.recompute_daily_rollups(uuid, date, date) from public;
grant execute on function public.recompute_daily_rollups(uuid, date, date) to service_role;

-- ---- policies.sql ----
-- ============================================================================
-- policies.sql — Row Level Security for the Kapso sales dashboard
-- Apply AFTER db/migrations/*.sql:
--   psql "$DATABASE_URL" -f supabase/policies.sql
--
-- Model: a user can read a store's data when either
--   (a) they have an explicit user_store_access grant, OR
--   (b) they are owner/admin of the store's organization.
-- All WRITES to ingested data happen via the service role (which bypasses
-- RLS); authenticated users only ever READ under these policies.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper functions. SECURITY DEFINER so policies that call them do not recurse
-- back through RLS on memberships / user_store_access / stores.
-- ----------------------------------------------------------------------------
create or replace function public.auth_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select org_id from memberships where user_id = auth.uid()
$$;

create or replace function public.auth_admin_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select org_id from memberships
   where user_id = auth.uid() and role in ('owner', 'admin')
$$;

-- Stores the current user may access: explicit grants UNION all stores in any
-- org where the user is owner/admin.
create or replace function public.auth_store_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select store_id from user_store_access where user_id = auth.uid()
  union
  select s.id from stores s
   where s.org_id in (
     select org_id from memberships
      where user_id = auth.uid() and role in ('owner', 'admin')
   )
$$;

grant execute on function public.auth_org_ids() to authenticated;
grant execute on function public.auth_admin_org_ids() to authenticated;
grant execute on function public.auth_store_ids() to authenticated;

-- ----------------------------------------------------------------------------
-- Enable RLS everywhere
-- ----------------------------------------------------------------------------
alter table organizations     enable row level security;
alter table memberships       enable row level security;
alter table stores            enable row level security;
alter table user_store_access enable row level security;
alter table orders            enable row level security;
alter table conversations     enable row level security;
alter table daily_rollups     enable row level security;
alter table ops_snapshots     enable row level security;
alter table sync_state        enable row level security;
alter table webhook_events    enable row level security;

-- ----------------------------------------------------------------------------
-- Tenancy tables
-- ----------------------------------------------------------------------------
drop policy if exists organizations_select on organizations;
create policy organizations_select on organizations
  for select to authenticated
  using (id in (select auth_org_ids()));

drop policy if exists memberships_select on memberships;
create policy memberships_select on memberships
  for select to authenticated
  using (user_id = auth.uid() or org_id in (select auth_admin_org_ids()));

drop policy if exists stores_select on stores;
create policy stores_select on stores
  for select to authenticated
  using (id in (select auth_store_ids()));

-- Admins/owners may create & edit stores in their own org from the app.
-- (Token columns are written by the server action via the service role.)
drop policy if exists stores_admin_write on stores;
create policy stores_admin_write on stores
  for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists user_store_access_select on user_store_access;
create policy user_store_access_select on user_store_access
  for select to authenticated
  using (user_id = auth.uid() or store_id in (select auth_store_ids()));

-- ----------------------------------------------------------------------------
-- Ingested data — read-only for authenticated users, scoped by accessible store
-- ----------------------------------------------------------------------------
drop policy if exists orders_select on orders;
create policy orders_select on orders
  for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists conversations_select on conversations;
create policy conversations_select on conversations
  for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists daily_rollups_select on daily_rollups;
create policy daily_rollups_select on daily_rollups
  for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists ops_snapshots_select on ops_snapshots;
create policy ops_snapshots_select on ops_snapshots
  for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists sync_state_select on sync_state;
create policy sync_state_select on sync_state
  for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists webhook_events_select on webhook_events;
create policy webhook_events_select on webhook_events
  for select to authenticated
  using (store_id in (select auth_store_ids()));

-- NOTE: no INSERT/UPDATE/DELETE policies are defined for the ingested-data
-- tables. With RLS enabled and no permissive write policy, authenticated/anon
-- clients cannot write them; only the service-role ingestion path can.

-- ----------------------------------------------------------------------------
-- Table privileges. On Supabase these are granted to the managed roles by
-- default; we include them so the schema also enforces correctly on a vanilla
-- Postgres. RLS still restricts WHICH ROWS each role may read.
-- service_role is expected to have BYPASSRLS (the Supabase default) so the
-- ingestion path can write tables that intentionally have no write policy.
-- ----------------------------------------------------------------------------
grant usage on schema public to authenticated, service_role;
grant select on all tables in schema public to authenticated;
grant all privileges on all tables in schema public to service_role;
grant execute on all functions in schema public to authenticated, service_role;
