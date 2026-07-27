-- apply_bundled.sql — full schema + RLS for the Supabase SQL Editor (generated).
-- Paste into Supabase → SQL Editor → Run. (psql: db/apply.sql)

-- ---- 0001 ----
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

-- ---- 0002 ----
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

-- ---- 0003 ----
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

-- ---- policies ----
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

-- ---- 0004 ----
-- ============================================================================
-- 0004_leads.sql — Leads + call-management module (replaces the "abandonos" Excel)
-- Adds the 'vendedora' role, a leads table (one per phone within a store) and a
-- lead_calls activity log. RLS: store-scoped reads; writes go through the
-- service role (server actions), like the rest of the ingested data.
-- Apply AFTER supabase/policies.sql (it uses auth_store_ids()).
-- ============================================================================

-- 1) New role for sales agents.
alter table memberships drop constraint if exists memberships_role_check;
alter table memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'viewer', 'vendedora'));

-- 1b) Customer phone on orders, so leads (keyed by phone) can link to orders.
alter table orders add column if not exists customer_phone text;
create index if not exists orders_store_customer_phone_idx on orders(store_id, customer_phone);

-- 2) Leads — deduped by phone within a store, ordered by last interaction.
create table if not exists leads (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete cascade,
  phone                 text not null,
  wa_id                 text,
  name                  text,
  email                 text,
  first_seen_at         timestamptz,
  last_interaction_at   timestamptz,
  kapso_conversation_id text,
  -- bot / CRM-derived signals
  bot_compra_state      text,                  -- Kapso "Compra realizada": no/iniciado/...
  handoff_reason        text,                  -- e.g. validacion_logistica
  handoff_context       text,                  -- bot context_summary
  handoff_at            timestamptz,
  -- our state machine
  category              text not null default 'open',   -- won | hot | open | lost
  status                text not null default 'nuevo',
  needs_attention       boolean not null default false,
  -- order linkage
  order_id              uuid references orders(id) on delete set null,
  has_order             boolean not null default false,
  -- assignment / claim lock
  claimed_by            uuid references auth.users(id) on delete set null,
  claimed_at            timestamptz,
  -- close / followup
  closed_by             uuid references auth.users(id) on delete set null,
  next_followup_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (store_id, phone)
);
create index if not exists leads_store_lastint_idx on leads(store_id, last_interaction_at desc);
create index if not exists leads_store_category_idx on leads(store_id, category);
create index if not exists leads_store_followup_idx on leads(store_id, next_followup_at);
create index if not exists leads_store_attention_idx on leads(store_id, needs_attention);

-- 3) lead_calls — activity log (calls, manual state changes, notes, sale).
create table if not exists lead_calls (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid not null references leads(id) on delete cascade,
  store_id          uuid not null references stores(id) on delete cascade,
  vendedora         uuid references auth.users(id) on delete set null,
  kind              text not null default 'call',   -- call | state_change | note | sale | system
  new_status        text,
  note              text,
  next_followup_at  timestamptz,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create index if not exists lead_calls_lead_idx on lead_calls(lead_id, occurred_at desc);
create index if not exists lead_calls_store_idx on lead_calls(store_id, occurred_at desc);
create index if not exists lead_calls_vendedora_idx on lead_calls(vendedora, occurred_at desc);

-- 4) RLS — store-scoped reads; writes via service role only.
alter table leads enable row level security;
alter table lead_calls enable row level security;

drop policy if exists leads_select on leads;
create policy leads_select on leads for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists lead_calls_select on lead_calls;
create policy lead_calls_select on lead_calls for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on leads to authenticated;
grant select on lead_calls to authenticated;
grant all privileges on leads to service_role;
grant all privileges on lead_calls to service_role;

-- 5) keep leads.updated_at fresh
create or replace function public.touch_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists leads_touch on leads;
create trigger leads_touch before update on leads
  for each row execute function public.touch_updated_at();


-- ============================================================================
-- 0005_message_timing.sql — first-response time + inbound message volume
--
-- Captures, per conversation, the inbound (customer→bot) message count and the
-- seconds from first inbound to first outbound reply. Rolled up daily as
-- sum + sample-count (never a pre-averaged value — averages aren't additive
-- across stores/days), so the dashboard computes avg first-response at read
-- time. Powers the "Tiempo de respuesta" KPI and the funnel's "Mensajes
-- entrantes" stage.
-- ============================================================================

alter table conversations
  add column if not exists inbound_count          integer,
  add column if not exists first_response_seconds integer;

alter table daily_rollups
  add column if not exists inbound_messages     integer not null default 0,
  add column if not exists response_seconds_sum bigint  not null default 0,
  add column if not exists response_samples     integer not null default 0;

-- Recompute now also aggregates the message-timing family from conversations.
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
           count(*)                                                          as conversations_count,
           coalesce(sum(inbound_count), 0)                                   as inbound_messages,
           coalesce(sum(first_response_seconds), 0)                          as response_seconds_sum,
           count(*) filter (where first_response_seconds is not null)        as response_samples
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
    agency_orders, cancelled_orders, refunded_amount,
    inbound_messages, response_seconds_sum, response_samples, updated_at
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
    coalesce(c.inbound_messages, 0),
    coalesce(c.response_seconds_sum, 0),
    coalesce(c.response_samples, 0),
    now()
  from days
  left join o on o.d = days.d
  left join c on c.d = days.d;
end;
$$;

revoke all on function public.recompute_daily_rollups(uuid, date, date) from public;
grant execute on function public.recompute_daily_rollups(uuid, date, date) to service_role;


-- ============================================================================
-- 0006_kapso_only_orders.sql — enforce the "orders = tag:kapso only" invariant
--
-- The dashboard must reflect ONLY orders generated through the Kapso bot, i.e.
-- Shopify orders tagged `kapso` (parity with the GraphQL reconciliation sync's
-- `tag:kapso` query and the Shopify "tag:kapso" view — see DEPLOY.md §7). The
-- webhook ingestion path historically upserted EVERY order Shopify delivered
-- (Shopify fires order webhooks shop-wide), polluting `orders` with non-Kapso
-- rows and inflating revenue / orders / AOV / conversion. This migration:
--   1) Adds a defensive tag:kapso filter to recompute_daily_rollups so the
--      headline KPIs only ever count Kapso orders, whatever sits in the table.
--   2) Purges existing non-Kapso order rows.
--   3) Recomputes every store's rollups over full history so the dashboard
--      reflects the cleaned data immediately (not only on the next sync).
-- The webhook code is fixed separately (lib/ingest.ts) to stop the bleeding.
-- ============================================================================

-- 0) Self-sufficiency guard: this migration's recompute_daily_rollups body
--    references the message-timing columns added in 0005. Add them idempotently
--    so 0006 can be applied standalone even if 0005 hasn't run yet (no-op when
--    it has, e.g. via db/apply.sql). Mirrors 0005_message_timing.sql; no data
--    is touched.
alter table conversations
  add column if not exists inbound_count          integer,
  add column if not exists first_response_seconds integer;
alter table daily_rollups
  add column if not exists inbound_messages     integer not null default 0,
  add column if not exists response_seconds_sum bigint  not null default 0,
  add column if not exists response_samples     integer not null default 0;

-- 1) Defensive filter: rollups only ever count Kapso orders.
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
       and exists (select 1 from unnest(tags) t where lower(t) = 'kapso')
     group by 1
  ),
  c as (
    select (started_at at time zone tz)::date as d,
           count(*)                                                          as conversations_count,
           coalesce(sum(inbound_count), 0)                                   as inbound_messages,
           coalesce(sum(first_response_seconds), 0)                          as response_seconds_sum,
           count(*) filter (where first_response_seconds is not null)        as response_samples
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
    agency_orders, cancelled_orders, refunded_amount,
    inbound_messages, response_seconds_sum, response_samples, updated_at
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
    coalesce(c.inbound_messages, 0),
    coalesce(c.response_seconds_sum, 0),
    coalesce(c.response_samples, 0),
    now()
  from days
  left join o on o.d = days.d
  left join c on c.d = days.d;
end;
$$;

revoke all on function public.recompute_daily_rollups(uuid, date, date) from public;
grant execute on function public.recompute_daily_rollups(uuid, date, date) to service_role;

-- 2) Purge existing non-Kapso orders. FK-safe: leads.order_id is
--    ON DELETE SET NULL; leads.has_order self-heals on the next lead sync.
delete from orders o
 where not exists (select 1 from unnest(o.tags) t where lower(t) = 'kapso');

-- 3) Recompute every store's rollups over full history so the cleaned figures
--    show up immediately for the ranges the dashboard queries.
do $$
declare
  s record;
begin
  for s in select id from stores loop
    perform public.recompute_daily_rollups(s.id, '2020-01-01'::date, current_date + 1);
  end loop;
end $$;


-- ============================================================================
-- 0007_lead_signals.sql — enrichment signals for sub-segmenting "Por llamar"
--
-- Adds structured signals so the leads queue can be split by buyer intent:
--   cart (from an OPEN Shopify draft order) · district (its shipping address) ·
--   interaction level (inbound message count). Populated by the lead sync
--   (lib/leads-ingest.ts) from Shopify draft orders + Kapso conversations.
-- Orthogonal to the won/hot/open/lost state machine — purely informational, so
-- it never changes a lead's category/status. Idempotent; touches no data.
-- (Cart/district require the Shopify token to have `read_draft_orders`; the
--  sync degrades gracefully without it — these columns just stay null.)
-- ============================================================================

alter table leads
  add column if not exists district        text,
  add column if not exists cart_value      numeric(14, 2),
  add column if not exists cart_item_count integer,
  add column if not exists cart_summary    text,
  add column if not exists draft_order_gid text,
  add column if not exists inbound_count   integer;

-- ---- 0008 ----
-- ============================================================================
-- 0008_lead_source.sql — lead source / channel attribution
-- Captures where a lead came from (CTWA ad campaigns vs organic) so conversion
-- can be measured per source. Populated from the WhatsApp `referral` object on
-- the first inbound message by the lead sync (first-touch, sticky).
-- ============================================================================
alter table leads add column if not exists source      text;
alter table leads add column if not exists ad_id       text;
alter table leads add column if not exists ad_headline text;
alter table leads add column if not exists ctwa_clid   text;

create index if not exists leads_store_source_idx on leads (store_id, source);

-- ---- 0009 ----
-- 0009_lead_inbound.sql — last inbound message time (24h session-window clock)
alter table leads add column if not exists last_inbound_at timestamptz;
create index if not exists leads_store_inbound_idx on leads (store_id, last_inbound_at);

-- ---- 0010 ----
-- 0010_sin_stock_open.sql — "Sin stock" recuperable: vuelve a la cola "Por llamar"
update leads set category = 'open' where status = 'sin_stock' and category <> 'open';

-- ---- 0011 ----
-- 0011_meta_ads.sql — Meta ad attribution lookup (resolved from the Marketing API).
-- Maps each Meta ad_id to its real ad / adset / campaign names so CTWA leads stop
-- collapsing under one shared headline. Global (ad_id is unique), read-only for
-- the app; self-contained RLS. Seed the names with
-- scripts/sql/seed_meta_ads_viaja_sin_maletas.sql.
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
alter table meta_ads enable row level security;
drop policy if exists meta_ads_select on meta_ads;
create policy meta_ads_select on meta_ads for select to authenticated
  using (true);
grant select on meta_ads to authenticated;
grant all privileges on meta_ads to service_role;

-- ---- 0012 ----
-- 0012_lead_wa_number.sql — which WhatsApp number a lead wrote to.
-- leads.wa_phone_number_id + a whatsapp_numbers lookup (phone_number_id → name /
-- phone / kind). Seed labels with scripts/sql/seed_whatsapp_numbers.sql.
alter table leads add column if not exists wa_phone_number_id text;
create index if not exists leads_store_wa_number_idx on leads (store_id, wa_phone_number_id);
create table if not exists whatsapp_numbers (
  phone_number_id text primary key,
  name            text,
  display_phone   text,
  kind            text,
  fetched_at      timestamptz not null default now()
);
alter table whatsapp_numbers enable row level security;
drop policy if exists whatsapp_numbers_select on whatsapp_numbers;
create policy whatsapp_numbers_select on whatsapp_numbers for select to authenticated
  using (true);
grant select on whatsapp_numbers to authenticated;
grant all privileges on whatsapp_numbers to service_role;
update leads l
   set wa_phone_number_id = c.phone_number_id
  from conversations c
 where c.store_id = l.store_id
   and c.kapso_conversation_id = l.kapso_conversation_id
   and l.wa_phone_number_id is null
   and c.phone_number_id is not null;

-- ---- 0013 ----
-- 0013_draft_orders.sql — Shopify Draft Orders (Releasit COD form abandoned carts).
-- OPEN draft = abandoned cart to work; COMPLETED = recovered. Mirrors `orders`.
-- Requires read_draft_orders (sync) + write_draft_orders ("Generar pedido").
create table if not exists draft_orders (
  id                     uuid primary key default gen_random_uuid(),
  store_id               uuid not null references stores(id) on delete cascade,
  shopify_draft_order_id text not null,
  draft_order_gid        text,
  name                   text,
  status                 text,
  created_at             timestamptz,
  updated_at             timestamptz,
  completed_at           timestamptz,
  invoice_url            text,
  total_amount           numeric(14, 2),
  currency               text,
  customer_phone         text,
  customer_name          text,
  district               text,
  province               text,
  region                 text,
  address1               text,
  referencia             text,
  tags                   text[] not null default '{}',
  note                   text,
  line_items             jsonb not null default '[]'::jsonb,
  order_gid              text,
  raw                    jsonb,
  ingested_at            timestamptz not null default now(),
  unique (store_id, shopify_draft_order_id)
);
create index if not exists draft_orders_store_phone_idx   on draft_orders(store_id, customer_phone);
create index if not exists draft_orders_store_status_idx  on draft_orders(store_id, status);
create index if not exists draft_orders_store_updated_idx on draft_orders(store_id, updated_at);
create index if not exists draft_orders_tags_gin          on draft_orders using gin (tags);
alter table draft_orders enable row level security;
drop policy if exists draft_orders_select on draft_orders;
create policy draft_orders_select on draft_orders for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on draft_orders to authenticated;
grant all privileges on draft_orders to service_role;
alter table leads
  add column if not exists draft_order_name   text,
  add column if not exists draft_order_status text,
  add column if not exists draft_order_url    text,
  add column if not exists province           text,
  add column if not exists region             text,
  add column if not exists referencia         text;

-- ---- 0014 ----
-- per-store secret for the Shopify Flow webhook (abandoned-browse source).
alter table stores add column if not exists flow_webhook_secret_enc text;

-- ---- 0015 ----
-- per-store WhatsApp template config for the abandoned-browse auto message.
alter table stores add column if not exists browse_template_enabled  boolean not null default false;
alter table stores add column if not exists browse_template_name      text;
alter table stores add column if not exists browse_template_language  text;

-- ---- 0016 ----
-- per-store canned WhatsApp messages (respuestas rápidas) for the lead drawer.
create table if not exists quick_replies (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores(id) on delete cascade,
  label       text not null,
  body        text not null,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists quick_replies_store_idx on quick_replies (store_id, sort);
alter table quick_replies enable row level security;
drop policy if exists quick_replies_select on quick_replies;
create policy quick_replies_select on quick_replies for select to authenticated
  using (store_id in (select auth_store_ids()));
drop policy if exists quick_replies_insert on quick_replies;
create policy quick_replies_insert on quick_replies for insert to authenticated
  with check (store_id in (select auth_store_ids()));
drop policy if exists quick_replies_update on quick_replies;
create policy quick_replies_update on quick_replies for update to authenticated
  using (store_id in (select auth_store_ids())) with check (store_id in (select auth_store_ids()));
drop policy if exists quick_replies_delete on quick_replies;
create policy quick_replies_delete on quick_replies for delete to authenticated
  using (store_id in (select auth_store_ids()));

-- ---- 0017 ----
-- per-store Telegram config for the daily sales summary.
alter table stores add column if not exists telegram_bot_token_enc text;
alter table stores add column if not exists telegram_chat_id        text;

-- ---- 0018 ----
-- Meta (Facebook) Marketing API connection per store (for ad-spend ↔ ROAS).
alter table stores add column if not exists meta_access_token_enc text;
alter table stores add column if not exists meta_ad_account_id     text;
alter table stores add column if not exists meta_ad_account_name   text;

-- ---- 0019 ----
-- Multi-account Meta Ads: a store can track spend across several ad accounts.
alter table stores add column if not exists meta_ad_accounts jsonb not null default '[]'::jsonb;
update stores
   set meta_ad_accounts = jsonb_build_array(
         jsonb_build_object('id', meta_ad_account_id, 'name', meta_ad_account_name)
       )
 where meta_ad_account_id is not null
   and (meta_ad_accounts is null or meta_ad_accounts = '[]'::jsonb);

-- ---- 0020 ----
-- v2 advisor routing for Yape/Shalom alerts: presence heartbeat + rotating offer.
create table if not exists user_presence (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
alter table user_presence enable row level security;
grant all privileges on user_presence to service_role;

alter table leads add column if not exists yape_offered_to uuid references auth.users(id) on delete set null;
alter table leads add column if not exists yape_offered_at timestamptz;
alter table leads add column if not exists yape_passed uuid[] not null default '{}';

create index if not exists leads_yape_offer_idx
  on leads(store_id) where status = 'yape_por_verificar';

-- ---- 0021 ----
-- Telegram alert for unattended Yapes: when we last pinged the channel (dedup).
alter table leads add column if not exists yape_alert_sent_at timestamptz;

-- ---- 0022 ----
-- ============================================================================
-- 0022_shipments.sql — Envíos module: one row per courier guide (Aliclik AUR5X
-- and Fenix sub-guides). Tracks the delivery state machine and carries an order
-- snapshot so unmatched / Kenku guides work before the store is connected.
--
-- The AUR5X guide pool is shared across stores ("multitienda"), so the guide
-- code is unique GLOBALLY by courier — NOT per store (the one deliberate
-- departure from leads' unique(store_id, phone)). store_id is still carried for
-- RLS scoping + per-store queue filters.
--
-- RLS: store-scoped reads; writes go through the service role (server actions),
-- like the rest of the ingested data. Apply AFTER supabase/policies.sql.
-- ============================================================================

create table if not exists shipments (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references stores(id) on delete cascade,
  -- identity: the courier + its guide code (AUR5X… for aliclik, tracking for fenix)
  courier            text not null default 'aliclik',     -- aliclik | fenix
  guide_code         text not null,
  -- delivery state machine (see lib/shipments.ts)
  delivery_status    text not null default 'por_preparar',
  status_category    text not null default 'in_transit',  -- in_transit | delivered | failure | rerouting | closed
  -- order linkage: auto-link to a synced order when matched; null for Kenku/unmatched
  order_id           uuid references orders(id) on delete set null,
  matched            boolean not null default false,
  match_method       text,                                -- order_name | phone | manual | none
  -- carried order snapshot (authoritative for Kenku + unmatched; cached for matched)
  order_name         text,                                -- "#KP114985" as imported
  customer_name      text,
  customer_phone     text,                                -- normalized via lib/phone.ts
  product            text,                                -- product/line summary from the report
  district           text,
  city               text,                                -- normalized city for Fenix coverage gating
  region             text,
  -- Fenix re-routing
  fenix_eligible     boolean not null default false,      -- city covered AND stock>0 at last eval
  fenix_shipment_id  uuid references shipments(id) on delete set null,  -- the Fenix sub-guide
  reroute_attempts   integer not null default 0,          -- 0..5
  reroute_outcome    text,                                -- reprogramado | entregado | devuelto | sin_cobertura | fin
  -- call queue / claim (mirror leads)
  claimed_by         uuid references auth.users(id) on delete set null,
  claimed_at         timestamptz,
  next_followup_at   timestamptz,
  -- provenance
  source_batch_id    uuid,                                -- references import_batches(id), added in 0024
  last_report_at     timestamptz,                         -- max report timestamp seen (monotonic guard)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Guide code is unique per courier across the whole multitienda pool.
create unique index if not exists shipments_guide_code_uniq on shipments(courier, guide_code);
create index if not exists shipments_store_status_idx   on shipments(store_id, delivery_status);
create index if not exists shipments_store_category_idx on shipments(store_id, status_category);
create index if not exists shipments_store_followup_idx on shipments(store_id, next_followup_at);
create index if not exists shipments_store_phone_idx    on shipments(store_id, customer_phone);
create index if not exists shipments_order_idx          on shipments(order_id);
create index if not exists shipments_reroute_idx        on shipments(store_id, fenix_eligible, status_category);

alter table shipments enable row level security;

drop policy if exists shipments_select on shipments;
create policy shipments_select on shipments for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on shipments to authenticated;
grant all privileges on shipments to service_role;

-- keep updated_at fresh (touch_updated_at() defined in 0004_leads.sql)
drop trigger if exists shipments_touch on shipments;
create trigger shipments_touch before update on shipments
  for each row execute function public.touch_updated_at();

-- ---- 0023 ----
-- ============================================================================
-- 0023_shipment_calls.sql — activity log for shipments (calls, state changes,
-- notes, re-routes). A near-verbatim copy of lead_calls, but a SEPARATE table:
-- lead_calls.lead_id is NOT NULL + FK to leads, and a shipment often has no lead
-- (Kenku/unmatched), so overloading lead_calls would break its schema + queries.
--
-- RLS: store-scoped reads; writes via service role. Apply after 0022.
-- ============================================================================

create table if not exists shipment_calls (
  id                uuid primary key default gen_random_uuid(),
  shipment_id       uuid not null references shipments(id) on delete cascade,
  store_id          uuid not null references stores(id) on delete cascade,
  agent             uuid references auth.users(id) on delete set null,  -- 'vendedora' equiv
  kind              text not null default 'call',  -- call | state_change | note | reroute | system
  new_status        text,                          -- delivery_status set, if any
  note              text,
  next_followup_at  timestamptz,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create index if not exists shipment_calls_shipment_idx on shipment_calls(shipment_id, occurred_at desc);
create index if not exists shipment_calls_store_idx     on shipment_calls(store_id, occurred_at desc);
create index if not exists shipment_calls_agent_idx     on shipment_calls(agent, occurred_at desc);

alter table shipment_calls enable row level security;

drop policy if exists shipment_calls_select on shipment_calls;
create policy shipment_calls_select on shipment_calls for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on shipment_calls to authenticated;
grant all privileges on shipment_calls to service_role;

-- ---- 0024 ----
-- ============================================================================
-- 0024_import_batches.sql — uploaded Aliclik delivery reports. import_batches is
-- one upload; import_rows are the parsed source rows (kept for audit, idempotent
-- re-import, and the manual-review queue: rows that didn't auto-match an order).
--
-- RLS: store-scoped reads; writes via service role. Apply after 0022/0023.
-- ============================================================================

create table if not exists import_batches (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,  -- default store for unmatched rows
  kind            text not null default 'aliclik_delivery',
  filename        text,
  uploaded_by     uuid references auth.users(id) on delete set null,
  row_count       integer not null default 0,
  matched_count   integer not null default 0,
  unmatched_count integer not null default 0,
  status          text not null default 'processed',  -- processing | processed | failed
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists import_batches_store_idx on import_batches(store_id, created_at desc);

create table if not exists import_rows (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references import_batches(id) on delete cascade,
  store_id      uuid not null references stores(id) on delete cascade,
  row_index     integer not null,
  raw           jsonb not null,                  -- the parsed source row (audit + re-match)
  parsed        jsonb,                           -- canonicalized {guide_code, order_name, phone, ...}
  match_status  text not null default 'pending', -- matched | unmatched | review | error
  shipment_id   uuid references shipments(id) on delete set null,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists import_rows_batch_idx  on import_rows(batch_id, row_index);
create index if not exists import_rows_review_idx  on import_rows(store_id, match_status);

alter table import_batches enable row level security;
alter table import_rows    enable row level security;

drop policy if exists import_batches_select on import_batches;
create policy import_batches_select on import_batches for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists import_rows_select on import_rows;
create policy import_rows_select on import_rows for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on import_batches to authenticated;
grant select on import_rows to authenticated;
grant all privileges on import_batches to service_role;
grant all privileges on import_rows to service_role;

-- ---- 0025 ----
-- ============================================================================
-- 0025_fenix_stock.sql — admin-maintained Fenix stock per city × product. Used
-- to gate whether a failed shipment can be re-routed to Fenix. Org-scoped (one
-- table serves the whole multitienda operation, not per store).
--
-- This is the ONE module table authenticated users WRITE directly: org admins
-- maintain it in-app (mirrors stores_admin_write in supabase/policies.sql).
-- Server actions may still write via service role for consistency.
-- ============================================================================

create table if not exists fenix_stock (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  city         text not null,            -- normalized: huancayo | juliaca | puno | cusco | arequipa | trujillo
  product      text not null,            -- product/variant label (loose-matched to shipment.product)
  sku          text,                     -- optional precise key for later
  quantity     integer not null default 0,
  updated_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (org_id, city, product)
);
create index if not exists fenix_stock_org_city_idx on fenix_stock(org_id, city);

alter table fenix_stock enable row level security;

drop policy if exists fenix_stock_select on fenix_stock;
create policy fenix_stock_select on fenix_stock for select to authenticated
  using (org_id in (select auth_org_ids()));

drop policy if exists fenix_stock_write on fenix_stock;
create policy fenix_stock_write on fenix_stock for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

grant select, insert, update, delete on fenix_stock to authenticated;
grant all privileges on fenix_stock to service_role;

drop trigger if exists fenix_stock_touch on fenix_stock;
create trigger fenix_stock_touch before update on fenix_stock
  for each row execute function public.touch_updated_at();


-- ---- 0026 ----
-- 0026_shipment_states_v2.sql — remap the shipment state model to the gestión +
-- Fenix flow (Pendiente / En ruta / Entregado / Anulado). Adds delivered_source
-- and rewrites old delivery_status / status_category codes. reroute_attempts kept
-- as the Intento counter; fenix_eligible recomputed on next import. Idempotent.

alter table shipments add column if not exists delivered_source text;

update shipments set delivered_source = 'aliclik'
  where delivery_status = 'entregado' and delivered_source is null;

update shipments set delivery_status = 'anulado' where delivery_status = 'devuelto';
update shipments set delivery_status = 'en_ruta' where delivery_status = 'reprogramado';
update shipments set delivery_status = 'pendiente'
  where delivery_status not in ('entregado', 'anulado', 'en_ruta', 'pendiente');

update shipments set status_category = 'delivered' where delivery_status = 'entregado';
update shipments set status_category = 'closed'    where delivery_status = 'anulado';
update shipments set status_category = 'in_route'  where delivery_status = 'en_ruta';
update shipments set status_category = 'pending'   where delivery_status = 'pendiente';


-- ---- 0027 ----
-- 0027_shipment_suggestions.sql — batch Shopify-search auto-match suggestions
-- for the "Revisión" queue. A suggestion is a high-confidence candidate found
-- by live-searching Shopify (order-reference + phone cross-validated), never
-- applied automatically — a human confirms via the existing
-- resolveShipmentMatch/linkShipmentToShopifyOrder actions. suggestion_checked_at
-- marks a shipment as already processed (skip on re-run) — resumable. Idempotent.

alter table shipments add column if not exists suggested_order_gid text;
alter table shipments add column if not exists suggested_store_id uuid references stores(id) on delete set null;
alter table shipments add column if not exists suggested_order_name text;
alter table shipments add column if not exists suggestion_checked_at timestamptz;

create index if not exists shipments_suggestion_pending_idx
  on shipments (created_at)
  where matched = false and suggestion_checked_at is null;


-- ---- 0028 ----
-- 0028_shipment_transferido.sql — new terminal status "transferido" (category
-- "transferred") for the Aliclik "parent" guide once a Fenix sub-guide is
-- created for it. No schema change needed — one-time backfill for guides
-- already transferred before this migration. Idempotent.

update shipments
set delivery_status = 'transferido', status_category = 'transferred'
where courier = 'aliclik'
  and fenix_shipment_id is not null
  and delivery_status <> 'transferido';


-- ---- 0029 ----
-- 0029_winback_template_config.sql — per-store WhatsApp template for the
-- "Recuperación de clientes" (60-day winback) message sent via Shopify Flow
-- (source "winback"). Off by default; no lead is created on send.

alter table stores add column if not exists winback_template_enabled  boolean not null default false;
alter table stores add column if not exists winback_template_name      text;
alter table stores add column if not exists winback_template_language  text;


-- ---- 0030 ----
-- 0030_attribution.sql — order-source attribution: orders.discount_codes (coupons)
-- + winback_sends (one row per winback template sent), for the order-centric
-- "ventas por fuente y cierre" module. RLS read-only, writes via service role.

alter table orders add column if not exists discount_codes text[] not null default '{}';
create index if not exists orders_discount_codes_gin on orders using gin (discount_codes);

create table if not exists winback_sends (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  phone          text not null,
  template_name  text,
  order_gid      text,
  sent_at        timestamptz not null default now(),
  ok             boolean not null default true
);
create index if not exists winback_sends_store_phone_idx on winback_sends(store_id, phone, sent_at);

alter table winback_sends enable row level security;
drop policy if exists winback_sends_select on winback_sends;
create policy winback_sends_select on winback_sends for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on winback_sends to authenticated;
grant all privileges on winback_sends to service_role;


-- ---- 0031 ----
-- 0031_yape_vision_checks.sql — audit + dedup for vision-based Yape voucher
-- detection. One row per inbound image analyzed (message_id = dedup key), so the
-- "Yape/Shalom por verificar" alert can be re-enabled for silent voucher images
-- while analyzing each image at most once. RLS read-only, writes via service role.

create table if not exists yape_vision_checks (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  message_id   text not null,
  is_voucher   boolean not null,
  indicators   jsonb not null default '{}'::jsonb,
  model        text,
  checked_at   timestamptz not null default now(),
  unique (store_id, message_id)
);
create index if not exists yape_vision_checks_store_idx on yape_vision_checks(store_id, checked_at);

alter table yape_vision_checks enable row level security;
drop policy if exists yape_vision_checks_select on yape_vision_checks;
create policy yape_vision_checks_select on yape_vision_checks for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on yape_vision_checks to authenticated;
grant all privileges on yape_vision_checks to service_role;


-- ---- 0032 ----
-- 0032_lead_ship_address.sql — surface the full shipping address on cart leads:
-- address1 (street) + ship_name (recipient) denormalized from the Shopify draft
-- (the rest — district/province/region/referencia — already landed in 0013).
-- Fills in on the next sync from data already in draft_orders (no re-fetch).

alter table leads add column if not exists address1  text;
alter table leads add column if not exists ship_name text;

-- ---- 0033 ----
-- 0033_kapso_webhook_secret.sql — per-store secret for the Kapso webhook.
-- Replaces the shared CRON_SECRET as the per-tenant auth for
-- /api/webhooks/kapso/[storeId] so one owner can't inject leads into another
-- store. Encrypted at rest (AES-256-GCM). CRON_SECRET stays as a legacy
-- fallback only for stores that have not set their own secret yet.

alter table stores add column if not exists kapso_webhook_secret_enc text;

-- ---- 0034 ----
-- 0034_scope_label_tables.sql — drop the `using(true)` SELECT policies on the
-- meta_ads and whatsapp_numbers label tables so they are no longer readable
-- across tenants. Labels are resolved server-side via the service-role client
-- for the caller's own lead ids (getAdNames/getWaNumbers), which bypasses RLS.

drop policy if exists meta_ads_select on meta_ads;
drop policy if exists whatsapp_numbers_select on whatsapp_numbers;

-- ---- 0035 ----
-- 0035_seguimiento_drip.sql — drip de seguimiento por WhatsApp para leads que
-- no contestan (no_responde/buzon/cuelga): config por tienda, contadores de
-- toque en leads y log drip_sends (RLS lectura por tienda, escribe service role).

alter table stores add column if not exists drip_template_enabled  boolean not null default false;
alter table stores add column if not exists drip_template_name      text;
alter table stores add column if not exists drip_template_language  text;

alter table leads add column if not exists drip_touches int not null default 0;
alter table leads add column if not exists last_drip_at timestamptz;

create table if not exists drip_sends (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  lead_id        uuid not null references leads(id) on delete cascade,
  phone          text not null,
  template_name  text,
  touch          int  not null,
  ok             boolean not null default true,
  error          text,
  sent_at        timestamptz not null default now()
);
create index if not exists drip_sends_store_sent_idx on drip_sends(store_id, sent_at);
create index if not exists drip_sends_lead_idx on drip_sends(lead_id);

alter table drip_sends enable row level security;
drop policy if exists drip_sends_select on drip_sends;
create policy drip_sends_select on drip_sends for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on drip_sends to authenticated;
grant all privileges on drip_sends to service_role;

-- ---- 0036 ----
-- 0036_attention_waves.sql — contador de olas de reencolado automático:
-- carritos en no_responde/buzon/cuelga quietos 48h suben con needs_attention,
-- máximo 2 veces por lead (evita el ping-pong infinito de reencolados).

alter table leads add column if not exists attention_waves int not null default 0;

-- ---- 0037 ----
-- 0037_whatsapp_outbox.sql — reliable lifecycle + idempotent retry for
-- advisor-initiated WhatsApp messages.

create table if not exists whatsapp_outbox (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references stores(id) on delete cascade,
  lead_id             uuid not null references leads(id) on delete cascade,
  client_token        text not null,
  retry_of            uuid references whatsapp_outbox(id) on delete set null,
  provider_message_id text,
  phone_number_id     text not null,
  to_phone            text not null,
  kind                text not null default 'text',
  body                text,
  status              text not null default 'pending'
                      check (status in ('pending','sent','delivered','read','failed','unknown')),
  retryable           boolean not null default false,
  error_code          text,
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  unique (store_id, client_token)
);
create unique index if not exists whatsapp_outbox_provider_id_idx
  on whatsapp_outbox(store_id, provider_message_id)
  where provider_message_id is not null;
create index if not exists whatsapp_outbox_lead_created_idx
  on whatsapp_outbox(lead_id, created_at desc);
alter table whatsapp_outbox enable row level security;
drop policy if exists whatsapp_outbox_select on whatsapp_outbox;
create policy whatsapp_outbox_select on whatsapp_outbox for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on whatsapp_outbox to authenticated;
grant all privileges on whatsapp_outbox to service_role;

-- ---- 0038 ----
-- 0038_aliclik_reprogramming.sql — source fields used to decide whether the
-- original Aliclik guide can still be reprogrammed before falling back to Fenix.
-- Kept separate from reroute_attempts, which is the dashboard's call counter.

alter table shipments add column if not exists aliclik_attempts integer;
alter table shipments add column if not exists aliclik_service_date date;
alter table shipments add column if not exists delivery_address text;
alter table shipments add column if not exists delivery_reference text;
alter table shipments add column if not exists latitude double precision;
alter table shipments add column if not exists longitude double precision;
alter table shipments add column if not exists address_override boolean not null default false;
alter table shipments add column if not exists address_updated_at timestamptz;
alter table shipments add column if not exists address_updated_by uuid references auth.users(id) on delete set null;

create index if not exists shipments_aliclik_reprogram_idx
  on shipments (courier, aliclik_service_date, aliclik_attempts)
  where courier = 'aliclik' and status_category in ('pending', 'in_route');


-- ---- 0039 ----
-- Preserve the administrative PROVINCIA from Aliclik independently from
-- shipments.city, which is a normalized key used only for Fenix coverage.

alter table shipments add column if not exists province text;

-- Recover the exact province for historical Aliclik guides from the latest
-- imported source row. Older parsed payloads did not include this field, so
-- the raw Excel object is used as the fallback.
with extracted_source as (
  select
    ir.shipment_id,
    coalesce(
      nullif(btrim(ir.parsed ->> 'province'), ''),
      (
        select nullif(btrim(entry.value), '')
        from jsonb_each_text(ir.raw) as entry(key, value)
        where lower(btrim(entry.key)) = 'provincia'
        limit 1
      )
    ) as province,
    ir.created_at,
    ir.id
  from import_rows ir
  where ir.shipment_id is not null
),
ranked_source as (
  select
    shipment_id,
    province,
    row_number() over (
      partition by shipment_id
      order by created_at desc, id desc
    ) as source_rank
  from extracted_source
  where province is not null
)
update shipments shipment
set province = source.province
from ranked_source source
where source.shipment_id = shipment.id
  and source.source_rank = 1
  and source.province is not null
  and nullif(btrim(shipment.province), '') is null;

-- Fenix children inherit the source guide's administrative province.
update shipments child
set province = parent.province
from shipments parent
where parent.fenix_shipment_id = child.id
  and nullif(btrim(child.province), '') is null
  and nullif(btrim(parent.province), '') is not null;

-- Last-resort compatibility for rows whose original report had no province:
-- show the department/region, never the Fenix city (which may be a district).
update shipments
set province = region
where nullif(btrim(province), '') is null
  and nullif(btrim(region), '') is not null;

comment on column shipments.province is
  'Administrative province imported from Aliclik; independent from the normalized Fenix coverage city.';


-- ---- 0040 ----
-- ============================================================================
-- 0040_cart_sequence.sql — secuencia de WhatsApp para CARRITOS ABANDONADOS
-- (drafts COD de Shopify). Dos plantillas aprobadas por Meta, ancladas a la
-- CREACIÓN del carrito (default: +3h y +24h), enviadas desde el cron de sync
-- solo en horario local configurable. Corre EN PARALELO a la gestión humana:
-- nunca toca status/category/next_followup_at del lead — solo sus columnas
-- propias — así no se cruza con el reencolado a "sin llamar" ni con las olas.
-- Se detiene si el lead ya tiene pedido / quedó won o lost / el carrito se
-- completó o borró / el cliente respondió después de crear el carrito.
--
--  1) stores.cart_seq_* — config por tienda (espejo del drip 0035, con horas
--     y ventana horaria configurables). OFF por defecto: nada se envía hasta
--     activar en Ajustes con las plantillas ya aprobadas.
--  2) leads.cart_seq_touches / last_cart_seq_at / cart_seq_gid — estado del
--     lead. cart_seq_gid ata el contador AL carrito: un carrito nuevo (gid
--     distinto) reinicia la secuencia (recompra = nueva conversación).
--  3) cart_seq_sends — un registro por intento (ok o fallido) para auditoría
--     y para medir recuperación (¿pedido después de sent_at?). RLS de solo
--     lectura para usuarios de la tienda; escribe el service role (espejo de
--     drip_sends / winback_sends).
-- ============================================================================

alter table stores add column if not exists cart_seq_enabled boolean not null default false;
alter table stores add column if not exists cart_seq_template_1_name     text;
alter table stores add column if not exists cart_seq_template_1_language text;
alter table stores add column if not exists cart_seq_template_2_name     text;
alter table stores add column if not exists cart_seq_template_2_language text;
alter table stores add column if not exists cart_seq_hours_1 integer not null default 3;
alter table stores add column if not exists cart_seq_hours_2 integer not null default 24;
alter table stores add column if not exists cart_seq_hour_start integer not null default 8;
alter table stores add column if not exists cart_seq_hour_end   integer not null default 21;

alter table leads add column if not exists cart_seq_touches int not null default 0;
alter table leads add column if not exists last_cart_seq_at timestamptz;
alter table leads add column if not exists cart_seq_gid text;

create table if not exists cart_seq_sends (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  lead_id        uuid not null references leads(id) on delete cascade,
  phone          text not null,              -- normalizePhone() applied
  draft_order_gid text,                      -- carrito al que pertenece el toque
  template_name  text,
  touch          int  not null,              -- 1 o 2
  ok             boolean not null default true, -- Meta/Kapso aceptó el envío
  error          text,                       -- motivo cuando ok = false
  sent_at        timestamptz not null default now()
);
create index if not exists cart_seq_sends_store_sent_idx on cart_seq_sends(store_id, sent_at);
create index if not exists cart_seq_sends_lead_idx on cart_seq_sends(lead_id);

alter table cart_seq_sends enable row level security;
drop policy if exists cart_seq_sends_select on cart_seq_sends;
create policy cart_seq_sends_select on cart_seq_sends for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on cart_seq_sends to authenticated;
grant all privileges on cart_seq_sends to service_role;


-- ---- 0041 ----
-- ============================================================================
-- 0041_fenix_stock_movements.sql — kardex del stock Fénix: cada cambio de
-- inventario es un movimiento con signo, tipo, motivo, quién y cuándo. El saldo
-- (fenix_stock.quantity) es la suma de los movimientos; esta tabla es el
-- historial auditable que permite cuadrar con el conteo real de Fénix.
--
--   entrada        (+N)  llega mercadería a la provincia (manual, admin)
--   salida_entrega (−1)  Fénix entregó un pedido (AUTOMÁTICO al marcar la guía
--                        Fénix como entregada; idempotente por shipment_id)
--   salida_merma   (−N)  daño / pérdida / robo (manual, admin, con motivo)
--   ajuste         (±N)  reconciliación: lleva el saldo al conteo real de Fénix
--
-- city/product se guardan como snapshot para que el historial sobreviva aunque
-- se borre el renglón de stock. balance_after es el saldo tras el movimiento.
-- RLS org-level espejo de fenix_stock (lectura: miembros; escritura: admins).
-- ============================================================================

create table if not exists fenix_stock_movements (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  fenix_stock_id uuid references fenix_stock(id) on delete set null,
  city           text not null,   -- snapshot (normalizado, como fenix_stock.city)
  product        text not null,   -- snapshot del rótulo del producto
  kind           text not null check (kind in ('entrada', 'salida_entrega', 'salida_merma', 'ajuste')),
  delta          integer not null,           -- con signo (+entrada, −salida, ±ajuste)
  balance_after  integer not null,           -- saldo del renglón tras aplicar delta
  note           text,
  shipment_id    uuid references shipments(id) on delete set null, -- guía Fénix de la salida_entrega
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists fenix_stock_movements_stock_idx
  on fenix_stock_movements(fenix_stock_id, created_at desc);
create index if not exists fenix_stock_movements_org_idx
  on fenix_stock_movements(org_id, city, created_at desc);
-- Idempotencia de la salida automática: una guía Fénix consume stock una sola
-- vez, aunque se re-marque entregada o se reintente.
create unique index if not exists fenix_stock_movements_delivery_uniq
  on fenix_stock_movements(shipment_id)
  where kind = 'salida_entrega';

alter table fenix_stock_movements enable row level security;

drop policy if exists fenix_stock_movements_select on fenix_stock_movements;
create policy fenix_stock_movements_select on fenix_stock_movements for select to authenticated
  using (org_id in (select auth_org_ids()));

drop policy if exists fenix_stock_movements_write on fenix_stock_movements;
create policy fenix_stock_movements_write on fenix_stock_movements for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

grant select, insert on fenix_stock_movements to authenticated;
grant all privileges on fenix_stock_movements to service_role;

-- ── 0042_shipment_call_note_edit ─────────────────────────────────────────────
-- Editar la nota de una gestión del historial con traza mínima (quién/cuándo).
alter table shipment_calls add column if not exists note_edited_at timestamptz;
alter table shipment_calls add column if not exists note_edited_by uuid references auth.users(id) on delete set null;

-- ── 0043_fenix_direct_guides ─────────────────────────────────────────────────
-- Guías Fenix directas (pedido Shopify sin guía Aliclik madre): marcador de
-- origen. El stock no se reserva al crear; se valida al crear y se descuenta
-- al entregar (salida_entrega), como toda guía Fénix.
alter table shipments add column if not exists created_via text; -- 'fenix_directo' | null
create index if not exists shipments_created_via_idx
  on shipments(created_via) where created_via is not null;

-- ── 0044_lead_first_inbound_text ─────────────────────────────────────────────
-- Primer mensaje del cliente, como contexto de apertura para la asesora.
alter table leads add column if not exists first_inbound_text text;

-- ── 0045_order_master ────────────────────────────────────────────────────────
-- Master de Pedidos: order_master (read-model materializado, una fila por
-- pedido) + order_events (línea de tiempo y auditoría, append-only). Las
-- gestiones por courier siguen en shipments/shipment_calls; no se duplican.
create table if not exists order_master (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references stores(id) on delete cascade,
  order_id           uuid not null references orders(id) on delete cascade,
  order_name         text,
  shopify_order_id   text not null,
  order_created_at   timestamptz,
  customer_name      text,
  customer_phone     text,
  region             text,
  province           text,
  district           text,
  shipping_mode      text,
  order_total        numeric(14, 2),
  general_status     text not null default 'pendiente'
                       check (general_status in
                         ('pendiente', 'en_proceso', 'entregado', 'anulado', 'devuelto')),
  operational_status text not null default 'sin_confirmar',
  status_since       timestamptz,
  status_source      text,
  status_locked      boolean not null default false,
  current_courier    text,
  last_courier       text,
  courier_count      integer not null default 0,
  attempt_count      integer not null default 0,
  guide_code         text,
  dispatched_at      timestamptz,
  delivered_at       timestamptz,
  delivered_courier  text,
  returned_at        timestamptz,
  last_movement_at   timestamptz,
  comment_count      integer not null default 0,
  logistics_cost     numeric(12, 2),
  recomputed_at      timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (order_id)
);
create index if not exists order_master_store_general_idx  on order_master(store_id, general_status);
create index if not exists order_master_store_oper_idx     on order_master(store_id, operational_status);
create index if not exists order_master_store_created_idx  on order_master(store_id, order_created_at desc);
create index if not exists order_master_store_movement_idx on order_master(store_id, last_movement_at desc);
create index if not exists order_master_store_district_idx on order_master(store_id, district);
create index if not exists order_master_store_province_idx on order_master(store_id, province);
create index if not exists order_master_store_region_idx   on order_master(store_id, region);
create index if not exists order_master_store_courier_idx  on order_master(store_id, current_courier);
create index if not exists order_master_phone_idx          on order_master(store_id, customer_phone);
create index if not exists order_master_guide_idx          on order_master(guide_code) where guide_code is not null;
create index if not exists order_master_multi_courier_idx  on order_master(store_id) where courier_count > 1;
create index if not exists order_master_multi_attempt_idx  on order_master(store_id) where attempt_count > 1;
create index if not exists order_master_recomputed_idx     on order_master(recomputed_at);
alter table order_master enable row level security;
drop policy if exists order_master_select on order_master;
create policy order_master_select on order_master for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on order_master to authenticated;
grant all privileges on order_master to service_role;
drop trigger if exists order_master_touch on order_master;
create trigger order_master_touch before update on order_master
  for each row execute function public.touch_updated_at();

create table if not exists order_events (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references stores(id) on delete cascade,
  order_id             uuid not null references orders(id) on delete cascade,
  kind                 text not null,
  occurred_at          timestamptz not null default now(),
  actor                uuid references auth.users(id) on delete set null,
  source               text not null default 'manual',
  courier              text,
  guide_code           text,
  previous_status      text,
  new_status           text,
  previous_operational text,
  new_operational      text,
  attempt_number       integer,
  reason               text,
  note                 text,
  comment_type         text,
  shipment_id          uuid references shipments(id) on delete set null,
  batch_id             uuid,
  payload              jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);
create index if not exists order_events_order_idx    on order_events(order_id, occurred_at desc);
create index if not exists order_events_store_idx    on order_events(store_id, occurred_at desc);
create index if not exists order_events_kind_idx     on order_events(store_id, kind);
create index if not exists order_events_shipment_idx on order_events(shipment_id) where shipment_id is not null;
alter table order_events enable row level security;
drop policy if exists order_events_select on order_events;
create policy order_events_select on order_events for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on order_events to authenticated;
grant select, insert on order_events to service_role;
create or replace function public.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'La tabla % es append-only: no admite % (auditoría inmutable).',
    tg_table_name, tg_op;
end;
$$;
drop trigger if exists order_events_append_only on order_events;
create trigger order_events_append_only before update or delete on order_events
  for each row execute function public.reject_mutation();

-- ── 0046_geo_peru ────────────────────────────────────────────────────────────
-- Distrito → provincia → departamento. Shopify Perú solo entrega distrito
-- (city) y departamento (province); la provincia intermedia se resuelve aquí.
create or replace function public.geo_key(raw text)
returns text
language sql
immutable
as $$
  select nullif(
    btrim(
      regexp_replace(
        lower(translate(coalesce(raw, ''),
                        'áéíóúüñÁÉÍÓÚÜÑàèìòùÀÈÌÒÙ',
                        'aeiouunAEIOUUNaeiouAEIOU')),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$$;
create table if not exists peru_districts (
  district_key text primary key,
  district     text not null,
  province     text not null,
  department   text,
  source       text not null default 'shipments',
  updated_at   timestamptz not null default now()
);
create index if not exists peru_districts_province_idx   on peru_districts(province);
create index if not exists peru_districts_department_idx on peru_districts(department);
alter table peru_districts enable row level security;
drop policy if exists peru_districts_select on peru_districts;
create policy peru_districts_select on peru_districts for select to authenticated
  using (true);
grant select on peru_districts to authenticated;
grant all privileges on peru_districts to service_role;
insert into peru_districts (district_key, district, province, department, source)
select
  public.geo_key(s.district)                as district_key,
  mode() within group (order by s.district) as district,
  mode() within group (order by s.province) as province,
  mode() within group (order by s.region)   as department,
  'shipments'
from shipments s
where public.geo_key(s.district) is not null
  and public.geo_key(s.province) is not null
group by public.geo_key(s.district)
on conflict (district_key) do nothing;

-- ── 0047_shipment_gestion ────────────────────────────────────────────────────
-- Campos de gestión logística (§8) y de agencia Shalom/Olva (§10) sobre las
-- guías. Se extiende `shipments` en vez de duplicarla: una gestión logística es
-- una guía asignada a un courier, que es lo que esa tabla ya modela.
alter table shipments
  add column if not exists assigned_at          timestamptz,
  add column if not exists dispatched_at        timestamptz,
  add column if not exists out_for_delivery_at  timestamptz,
  add column if not exists rescheduled_at       timestamptz,
  add column if not exists closed_at            timestamptz,
  add column if not exists returned_at          timestamptz,
  add column if not exists reported_status      text,
  add column if not exists non_delivery_reason  text,
  add column if not exists source               text,
  add column if not exists agency_branch        text,
  add column if not exists agency_arrived_at    timestamptz,
  add column if not exists agency_expires_at    timestamptz,
  add column if not exists pickup_state         text;
create index if not exists shipments_pickup_state_idx
  on shipments(store_id, pickup_state) where pickup_state is not null;
create index if not exists shipments_agency_expiry_idx
  on shipments(agency_expires_at) where agency_expires_at is not null;
create index if not exists shipments_returned_idx
  on shipments(store_id, returned_at) where returned_at is not null;
update shipments
   set assigned_at = coalesce(assigned_at, created_at),
       source      = coalesce(source, courier)
 where assigned_at is null or source is null;
alter table order_master
  add column if not exists pickup_state      text,
  add column if not exists agency_branch     text,
  add column if not exists agency_arrived_at timestamptz,
  add column if not exists agency_expires_at timestamptz;
create index if not exists order_master_pickup_idx
  on order_master(store_id, pickup_state) where pickup_state is not null;
create index if not exists order_master_expiry_idx
  on order_master(agency_expires_at) where agency_expires_at is not null;

-- ── 0048_courier_reports ─────────────────────────────────────────────────────
-- Cada carga de información como un reporte independiente, del courier que sea
-- (§6), conservando el archivo original (§19.8).
alter table import_batches
  add column if not exists courier            text,
  add column if not exists report_date        date,
  add column if not exists file_path          text,
  add column if not exists file_type          text,
  add column if not exists file_sha256        text,
  add column if not exists found_count        integer not null default 0,
  add column if not exists updated_count      integer not null default 0,
  add column if not exists unrecognized_count integer not null default 0,
  add column if not exists errors             jsonb not null default '[]'::jsonb;
create index if not exists import_batches_courier_idx
  on import_batches(store_id, courier, created_at desc);
create index if not exists import_batches_sha_idx
  on import_batches(file_sha256) where file_sha256 is not null;
update import_batches
   set courier = coalesce(courier, case when kind = 'aliclik_delivery' then 'aliclik' end)
 where courier is null;

-- ── 0049_yape_payments ───────────────────────────────────────────────────────
-- Validación de los dos Yapes (adelanto y diferencia) y clave de recojo de los
-- envíos por Shalom: unicidad global del comprobante, clave cifrada sin lectura
-- directa, auditoría append-only de cada visualización, y permisos finos.

-- ----------------------------------------------------------------------------
-- order_payments — un comprobante Yape, atado a UN pedido
-- ----------------------------------------------------------------------------

create table if not exists order_payments (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references stores(id) on delete cascade,
  order_id          uuid not null references orders(id) on delete cascade,
  kind              text not null check (kind in ('adelanto', 'diferencia')),
  amount            numeric(12, 2),
  -- Identificador natural del pago. Único en TODO el sistema cuando existe.
  operation_number  text,
  -- Fecha y hora exactas del movimiento, tal como aparecen en el comprobante.
  paid_at           timestamptz,
  payer_name        text,
  payer_phone       text,
  -- Imagen del comprobante en el bucket privado `yape-vouchers`.
  file_path         text,
  file_type         text,
  -- Huella del archivo: detecta la misma imagen re-subida con otro nombre.
  file_sha256       text,
  validation_status text not null default 'pendiente_revision'
                      check (validation_status in (
                        'pendiente_revision',
                        'validado',
                        'rechazado',
                        'posible_duplicado',
                        'info_incompleta',
                        'revision_admin'
                      )),
  registered_by     uuid references auth.users(id) on delete set null,
  registered_at     timestamptz not null default now(),
  validated_by      uuid references auth.users(id) on delete set null,
  validated_at      timestamptz,
  notes             text,
  -- Qué vio el lector de comprobantes (lib/vision.ts) en la imagen: auditoría de
  -- por qué el sistema aceptó o dudó del comprobante.
  vision            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Un pago rechazado deja de ocupar su sitio: pudo ser un error de carga, y su nº
-- de operación o su archivo tienen que poder volver a usarse en el pedido
-- correcto. Por eso los tres índices son PARCIALES.
create unique index if not exists order_payments_operation_uniq
  on order_payments(operation_number)
  where operation_number is not null and validation_status <> 'rechazado';

create unique index if not exists order_payments_file_uniq
  on order_payments(file_sha256)
  where file_sha256 is not null and validation_status <> 'rechazado';

-- Un solo adelanto y una sola diferencia vivos por pedido.
create unique index if not exists order_payments_kind_uniq
  on order_payments(order_id, kind)
  where validation_status <> 'rechazado';

create index if not exists order_payments_order_idx on order_payments(order_id);
create index if not exists order_payments_store_idx on order_payments(store_id, validation_status);
-- Búsqueda de posibles duplicados por coincidencia difusa (monto + fecha).
create index if not exists order_payments_fuzzy_idx on order_payments(amount, paid_at);

alter table order_payments enable row level security;

drop policy if exists order_payments_select on order_payments;
create policy order_payments_select on order_payments for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on order_payments to authenticated;
grant all privileges on order_payments to service_role;

drop trigger if exists order_payments_touch on order_payments;
create trigger order_payments_touch before update on order_payments
  for each row execute function public.touch_updated_at();

comment on column order_payments.operation_number is
  'Nº de operación del Yape. Único en todo el sistema: es lo que detecta un mismo comprobante recortado.';
comment on column order_payments.file_sha256 is
  'Huella del archivo: detecta la misma imagen re-subida con otro nombre.';

-- ----------------------------------------------------------------------------
-- shalom_pickup_keys — la clave, cifrada y sin lectura directa
-- ----------------------------------------------------------------------------

create table if not exists shalom_pickup_keys (
  order_id     uuid primary key references orders(id) on delete cascade,
  store_id     uuid not null references stores(id) on delete cascade,
  -- AES-256-GCM (lib/crypto.ts). NUNCA texto plano.
  key_enc      text not null,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  replaced_at  timestamptz,
  replaced_by  uuid references auth.users(id) on delete set null
);

alter table shalom_pickup_keys enable row level security;

-- SIN policy de select: RLS activo y sin policy = nadie con rol `authenticated`
-- puede leer esta tabla, ni siquiera un administrador. La clave solo se obtiene
-- a través del server action, que comprueba permisos y deja auditoría. Tampoco
-- se otorga `select` al rol authenticated, por si algún día se añadiera una
-- policy por error.
grant all privileges on shalom_pickup_keys to service_role;

-- ----------------------------------------------------------------------------
-- pickup_key_views — quién vio la clave. APPEND-ONLY.
-- ----------------------------------------------------------------------------

create table if not exists pickup_key_views (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  order_id       uuid not null references orders(id) on delete cascade,
  user_id        uuid references auth.users(id) on delete set null,
  viewed_at      timestamptz not null default now(),
  ip             text,
  user_agent     text,
  reason         text,
  -- Estado de los dos pagos EN EL MOMENTO de mostrarla: sin esto no se puede
  -- responder "¿ya estaban ambos validados cuando la vio?".
  payment_state  jsonb not null default '{}'::jsonb,
  -- true cuando un administrador la mostró saltándose alguna condición.
  override       boolean not null default false
);

create index if not exists pickup_key_views_order_idx on pickup_key_views(order_id, viewed_at desc);
create index if not exists pickup_key_views_user_idx  on pickup_key_views(user_id, viewed_at desc);

alter table pickup_key_views enable row level security;

drop policy if exists pickup_key_views_select on pickup_key_views;
create policy pickup_key_views_select on pickup_key_views for select to authenticated
  using (store_id in (select auth_store_ids()));

-- "La visualización de la clave no deberá poder eliminarse del historial."
grant select on pickup_key_views to authenticated;
grant select, insert on pickup_key_views to service_role;

drop trigger if exists pickup_key_views_append_only on pickup_key_views;
create trigger pickup_key_views_append_only before update or delete on pickup_key_views
  for each row execute function public.reject_mutation();

-- ----------------------------------------------------------------------------
-- pickup_key_shares — cuándo se le entregó la clave al cliente
-- ----------------------------------------------------------------------------

create table if not exists pickup_key_shares (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references stores(id) on delete cascade,
  order_id   uuid not null references orders(id) on delete cascade,
  shared_by  uuid references auth.users(id) on delete set null,
  shared_at  timestamptz not null default now(),
  channel    text not null default 'whatsapp',  -- whatsapp | llamada | mensaje | otro
  confirmed  boolean not null default false,
  note       text
);

create index if not exists pickup_key_shares_order_idx on pickup_key_shares(order_id, shared_at desc);

alter table pickup_key_shares enable row level security;

drop policy if exists pickup_key_shares_select on pickup_key_shares;
create policy pickup_key_shares_select on pickup_key_shares for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on pickup_key_shares to authenticated;
grant select, insert on pickup_key_shares to service_role;

-- ----------------------------------------------------------------------------
-- user_permissions — concesiones y revocaciones puntuales (§16)
-- ----------------------------------------------------------------------------

create table if not exists user_permissions (
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     uuid not null references organizations(id) on delete cascade,
  permission text not null,
  -- false = revocado aunque el rol lo conceda. Gana siempre sobre el rol.
  granted    boolean not null default true,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, org_id, permission)
);

alter table user_permissions enable row level security;

drop policy if exists user_permissions_select on user_permissions;
create policy user_permissions_select on user_permissions for select to authenticated
  using (user_id = auth.uid() or org_id in (select auth_admin_org_ids()));

grant select on user_permissions to authenticated;
grant all privileges on user_permissions to service_role;

-- ----------------------------------------------------------------------------
-- Indicadores de pago y clave en el Master (§"Información visible en el Master")
-- ----------------------------------------------------------------------------

alter table order_master
  -- sin_pago | adelanto_pendiente | adelanto_cargado | adelanto_validado
  -- | diferencia_pendiente | diferencia_cargada | pago_completo | posible_duplicado
  add column if not exists payment_state text,
  -- sin_clave | clave_bloqueada | clave_disponible | clave_enviada
  add column if not exists key_state     text;

create index if not exists order_master_payment_idx
  on order_master(store_id, payment_state) where payment_state is not null;

-- ── 0050_costs ───────────────────────────────────────────────────────────────
-- Módulo de Costos (§17): tarifas logísticas, costos de producto y adicionales,
-- todos con VIGENCIA — cambiar una tarifa cierra la anterior y abre otra, para
-- que los cálculos históricos no se muevan.

-- ----------------------------------------------------------------------------
-- Costos logísticos
-- ----------------------------------------------------------------------------

create table if not exists cost_tariffs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  -- Ámbito. Cuanto más campos rellenos, más específica es la tarifa y antes gana.
  -- Todos nulos = tarifa general de la organización.
  store_id       uuid references stores(id) on delete cascade,
  courier        text,
  region         text,
  province       text,
  district       text,
  concept        text not null check (concept in (
                   'primer_intento',
                   'intento_adicional',
                   'envio_agencia',
                   'devolucion',
                   'especial'
                 )),
  amount         numeric(12, 2) not null,
  currency       text not null default 'PEN',
  -- Vigencia. `effective_to` nulo = sigue vigente.
  effective_from date not null default current_date,
  effective_to   date,
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Una tarifa que termina antes de empezar sería invisible y silenciosa.
  constraint cost_tariffs_period_valid check (effective_to is null or effective_to >= effective_from)
);

create index if not exists cost_tariffs_lookup_idx
  on cost_tariffs(org_id, concept, effective_from desc);
create index if not exists cost_tariffs_store_idx on cost_tariffs(store_id);
-- Búsqueda por ámbito geográfico, que es como se consulta en la práctica.
create index if not exists cost_tariffs_geo_idx on cost_tariffs(org_id, district, province, region);

-- ----------------------------------------------------------------------------
-- Costos de producto
-- ----------------------------------------------------------------------------

create table if not exists product_costs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  store_id       uuid references stores(id) on delete cascade,
  sku            text not null,
  product_name   text,
  supplier       text,
  batch          text,
  unit_cost      numeric(12, 2) not null,
  currency       text not null default 'PEN',
  effective_from date not null default current_date,
  effective_to   date,
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint product_costs_period_valid check (effective_to is null or effective_to >= effective_from)
);

create index if not exists product_costs_lookup_idx
  on product_costs(org_id, sku, effective_from desc);

-- ----------------------------------------------------------------------------
-- Costos adicionales (empaque, materiales, preparación, comisiones…)
-- ----------------------------------------------------------------------------

create table if not exists additional_costs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  store_id       uuid references stores(id) on delete cascade,
  concept        text not null,          -- empaque | materiales | preparacion | comision | otro
  label          text,
  amount         numeric(12, 2) not null,
  currency       text not null default 'PEN',
  -- 'pedido' = importe fijo por pedido; 'porcentaje' = % sobre el total.
  basis          text not null default 'pedido' check (basis in ('pedido', 'porcentaje')),
  effective_from date not null default current_date,
  effective_to   date,
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint additional_costs_period_valid check (effective_to is null or effective_to >= effective_from)
);

create index if not exists additional_costs_lookup_idx
  on additional_costs(org_id, concept, effective_from desc);

-- ----------------------------------------------------------------------------
-- RLS: lectura para quien pertenece a la organización; escritura solo admins.
-- Mismo patrón que fenix_stock (0025).
-- ----------------------------------------------------------------------------

alter table cost_tariffs     enable row level security;
alter table product_costs    enable row level security;
alter table additional_costs enable row level security;

drop policy if exists cost_tariffs_select on cost_tariffs;
create policy cost_tariffs_select on cost_tariffs for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists cost_tariffs_write on cost_tariffs;
create policy cost_tariffs_write on cost_tariffs for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists product_costs_select on product_costs;
create policy product_costs_select on product_costs for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists product_costs_write on product_costs;
create policy product_costs_write on product_costs for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists additional_costs_select on additional_costs;
create policy additional_costs_select on additional_costs for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists additional_costs_write on additional_costs;
create policy additional_costs_write on additional_costs for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

grant select on cost_tariffs, product_costs, additional_costs to authenticated;
grant insert, update, delete on cost_tariffs, product_costs, additional_costs to authenticated;
grant all privileges on cost_tariffs, product_costs, additional_costs to service_role;

drop trigger if exists cost_tariffs_touch on cost_tariffs;
create trigger cost_tariffs_touch before update on cost_tariffs
  for each row execute function public.touch_updated_at();
drop trigger if exists product_costs_touch on product_costs;
create trigger product_costs_touch before update on product_costs
  for each row execute function public.touch_updated_at();
drop trigger if exists additional_costs_touch on additional_costs;
create trigger additional_costs_touch before update on additional_costs
  for each row execute function public.touch_updated_at();

comment on column cost_tariffs.effective_from is
  'Inicio de vigencia. Cambiar una tarifa NO edita la fila: se cierra la vigente y se abre otra, para que los cálculos históricos no se muevan.';

-- ── 0051_order_geo ───────────────────────────────────────────────────────────
-- Corrección manual de la ubicación de un pedido (dirección, distrito,
-- provincia, región y punto del mapa). Gana sobre Shopify, los reportes de
-- courier y el ubigeo, y sobrevive a la siguiente sincronización.

create table if not exists order_geo_overrides (
  order_id    uuid primary key references orders(id) on delete cascade,
  store_id    uuid not null references stores(id) on delete cascade,
  -- Cada campo es opcional: se corrige solo lo que está mal. Un nulo significa
  -- "esto no lo toco", no "bórralo".
  region      text,
  province    text,
  district    text,
  address     text,
  reference   text,
  -- Coordenadas corregidas a mano: son las que alimentan el enlace al mapa.
  latitude    double precision,
  longitude   double precision,
  note        text,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists order_geo_overrides_store_idx on order_geo_overrides(store_id);

alter table order_geo_overrides enable row level security;

drop policy if exists order_geo_overrides_select on order_geo_overrides;
create policy order_geo_overrides_select on order_geo_overrides for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on order_geo_overrides to authenticated;
grant all privileges on order_geo_overrides to service_role;

drop trigger if exists order_geo_overrides_touch on order_geo_overrides;
create trigger order_geo_overrides_touch before update on order_geo_overrides
  for each row execute function public.touch_updated_at();

comment on table order_geo_overrides is
  'Corrección manual de la ubicación de un pedido. Gana sobre Shopify, los reportes de courier y el ubigeo al recalcular order_master.';

-- ----------------------------------------------------------------------------
-- El Master carga la dirección y el punto del mapa en su propia fila, para que
-- el listado y el detalle no tengan que volver a resolverlos.
-- ----------------------------------------------------------------------------

alter table order_master
  add column if not exists address    text,
  add column if not exists reference  text,
  add column if not exists latitude   double precision,
  add column if not exists longitude  double precision,
  -- De dónde salió la ubicación vigente: manual | shopify | courier | ubigeo | draft
  add column if not exists geo_source text;

comment on column order_master.geo_source is
  'Origen de la ubicación vigente. "manual" = corregida por el equipo (order_geo_overrides).';

-- El ubigeo también se puede corregir: cuando el equipo arregla la provincia de
-- un distrito, se recuerda para los siguientes pedidos de ese distrito.
-- `source` distingue lo cargado del INEI de lo aprendido a mano.
comment on column peru_districts.source is
  'shipments = inferido de los reportes; inei = ubigeo oficial; manual = corregido por el equipo.';

-- ── 0052_store_anthropic_key ─────────────────────────────────────────────────
-- Clave de Anthropic por tienda (lectura de comprobantes Yape), cifrada. Así el
-- gasto de cada tienda es independiente. El entorno sigue como respaldo.

alter table stores
  add column if not exists anthropic_api_key_enc text,
  -- Modelo por tienda: permite abaratar una tienda sin tocar la otra ni
  -- redesplegar (p. ej. un modelo más económico para la clasificación simple).
  add column if not exists anthropic_model        text;

comment on column stores.anthropic_api_key_enc is
  'enc: API key de Anthropic de ESTA tienda (lectura de comprobantes Yape). Cifrada AES-256-GCM. Respaldo: ANTHROPIC_API_KEY del entorno.';
comment on column stores.anthropic_model is
  'Modelo de visión para esta tienda. Vacío = el valor por defecto del entorno.';

-- ── 0053_revoke_default_grants ───────────────────────────────────────────────
-- Supabase deja `alter default privileges ... grant all on tables to anon,
-- authenticated, service_role` en el esquema public, así que CADA tabla nueva
-- nace con TODOS los privilegios para los tres roles y un `grant select, insert`
-- no resta nada. Esto revoca y vuelve a conceder solo lo necesario.

revoke all on order_events     from anon, authenticated, service_role;
revoke all on pickup_key_views from anon, authenticated, service_role;

grant select         on order_events     to authenticated;
grant select, insert on order_events     to service_role;
grant select         on pickup_key_views to authenticated;
grant select, insert on pickup_key_views to service_role;

revoke all on shalom_pickup_keys from anon, authenticated;
grant all privileges on shalom_pickup_keys to service_role;

revoke all on order_payments     from anon, authenticated;
revoke all on pickup_key_shares  from anon, authenticated, service_role;
grant select on order_payments to authenticated;
grant all privileges on order_payments to service_role;
grant select         on pickup_key_shares to authenticated;
grant select, insert on pickup_key_shares to service_role;

revoke all on order_master from anon, authenticated;
grant select on order_master to authenticated;
grant all privileges on order_master to service_role;

revoke all on order_geo_overrides from anon, authenticated;
grant select on order_geo_overrides to authenticated;
grant all privileges on order_geo_overrides to service_role;

revoke all on peru_districts from anon, authenticated;
grant select on peru_districts to authenticated;
grant all privileges on peru_districts to service_role;

revoke all on user_permissions from anon, authenticated;
grant select on user_permissions to authenticated;
grant all privileges on user_permissions to service_role;

revoke all on cost_tariffs     from anon, authenticated;
revoke all on product_costs    from anon, authenticated;
revoke all on additional_costs from anon, authenticated;
grant select, insert, update, delete on cost_tariffs     to authenticated;
grant select, insert, update, delete on product_costs    to authenticated;
grant select, insert, update, delete on additional_costs to authenticated;
grant all privileges on cost_tariffs, product_costs, additional_costs to service_role;

-- ---- 0058 ----
-- ============================================================================
-- 0054_tanders.sql — Tanders como courier propio de Lima.
--
-- Tanders convive con Aliclik / Shalom / Olva: no los reemplaza. La diferencia
-- con todos ellos es la dirección del flujo. Los otros couriers ENTRAN al
-- sistema por reporte (un Excel que se sube y se ingesta); Tanders SALE — el
-- equipo crea el pedido desde el Master y su API devuelve el código de guía.
-- Por eso no hay adaptador en lib/couriers/ (esos parsean reportes) sino un
-- cliente en lib/tanders/.
--
-- Credenciales POR TIENDA: Tanders no emite API keys, solo el usuario y la
-- contraseña de la cuenta. Se guardan cifradas con AES-256-GCM (lib/crypto.ts),
-- igual que el token de Shopify y la API key de Kapso — se descifran solo en el
-- servidor y nunca viajan al cliente.
--
-- Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

alter table stores
  add column if not exists tanders_email            text,
  add column if not exists tanders_password_enc     text,
  -- Origen del despacho: el almacén desde el que sale el paquete. Tanders lo
  -- exige en cada pedido como texto + coordenadas, y no lo deriva de la cuenta,
  -- así que hay que llevarlo nosotros. Es el mismo para todos los envíos de la
  -- tienda hasta que el equipo lo cambie.
  add column if not exists tanders_origin_address   text,
  add column if not exists tanders_origin_lat       double precision,
  add column if not exists tanders_origin_lng       double precision;

comment on column stores.tanders_password_enc is
  'enc: contraseña de la cuenta Tanders de esta tienda. Cifrada AES-256-GCM. Tanders no emite API keys.';
comment on column stores.tanders_origin_address is
  'Dirección del almacén de origen tal como la reconoce Google Maps (Tanders la guarda literal).';

-- ----------------------------------------------------------------------------
-- La guía Tanders es un envío más: vive en `shipments` con courier='tanders' y
-- guide_code = el id que devuelve su API (un cuid, p. ej. cms2mftih0018...).
-- Solo hacen falta dos datos que ningún otro courier tiene.
-- ----------------------------------------------------------------------------

alter table shipments
  -- URL de la etiqueta PDF que devuelve Tanders. Nullable a propósito: al crear
  -- el pedido nace "Pendiente" y la etiqueta puede no estar lista todavía.
  add column if not exists label_url          text,
  -- Última respuesta cruda de su API. Tanders no tiene documentación: cuando un
  -- envío se comporte raro, esto es la única evidencia de qué contestó de verdad.
  add column if not exists tanders_raw        jsonb;

comment on column shipments.label_url is
  'Etiqueta PDF del courier (Tanders). Puede tardar en existir: la guía nace Pendiente.';
comment on column shipments.tanders_raw is
  'Respuesta cruda de la API de Tanders al crear la guía. Auditoría — su API no está documentada.';

-- ---- 0059 ----
-- ============================================================================
-- 0059_shalom_api.sql — crear guías de Shalom por API desde el Master.
--
-- Shalom ya estaba en el sistema, pero solo de ENTRADA: sus reportes Excel se
-- suben y los parsea el adaptador de agencia (lib/couriers/agency.ts). Esta
-- migración habilita la dirección contraria — crear la preguía por API, como ya
-- se hace con Tanders (0058) — usando el wrapper api.shalom-api-peru.com.
--
-- Las guías creadas así son envíos normales: viven en `shipments` con
-- courier='shalom' y se cruzan con el reporte del día siguiente por `guide_code`
-- como cualquier otra. No hay tabla nueva de envíos.
--
-- DOS credenciales por tienda, no una:
--   * la API key del wrapper (sk_…), que es de la cuenta de Kapso;
--   * el email + password de pro.shalom.pe DEL CLIENTE, que es lo que el
--     wrapper usa para entrar a su panel.
-- Ambas cifradas con AES-256-GCM (lib/crypto.ts), como el resto de secretos.
--
-- Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

alter table stores
  add column if not exists shalom_api_key_enc         text,
  add column if not exists shalom_pro_email           text,
  add column if not exists shalom_pro_password_enc    text,
  -- Agencia desde la que despacha esta tienda. Shalom la pide como
  -- `origin_terminal_id` en cada orden y no la deriva de la cuenta. El nombre se
  -- guarda al lado solo para poder mostrarlo sin llamar a la API.
  add column if not exists shalom_origin_terminal_id  integer,
  add column if not exists shalom_origin_terminal_name text,
  -- Tipo de paquete por defecto (id de GET /v1/products: 3 = Sobre). El
  -- catálogo es por cuenta, así que el id no se puede fijar en el código.
  add column if not exists shalom_default_product_id  integer,
  -- ── Caché de la sesión ────────────────────────────────────────────────────
  -- El wrapper hace un login REAL contra pro.shalom.pe la primera vez: ~90 s,
  -- hasta 2 min. El token `ssk_…` dura 2 horas, así que guardarlo evita pagar
  -- ese login en cada guía. En serverless la memoria del proceso no sobrevive
  -- entre invocaciones — por eso va en la base y no en un módulo.
  add column if not exists shalom_session_token_enc   text,
  add column if not exists shalom_session_expires_at  timestamptz;

comment on column stores.shalom_api_key_enc is
  'enc: API key (sk_…) de api.shalom-api-peru.com. Cifrada AES-256-GCM.';
comment on column stores.shalom_pro_password_enc is
  'enc: password de la cuenta pro.shalom.pe del cliente. El wrapper la canjea por un token de sesión.';
comment on column stores.shalom_origin_terminal_id is
  'id de agencia (GET /v1/agencies) desde la que despacha esta tienda: origin_terminal_id de la orden.';
comment on column stores.shalom_session_token_enc is
  'enc: token ssk_ de Shalom, TTL 2 h. Caché para no pagar el login de ~90 s en cada guía.';
comment on column stores.shalom_session_expires_at is
  'Vencimiento del token ssk_. Pasada esa hora se pide uno nuevo.';

-- ----------------------------------------------------------------------------
-- Identificadores del envío en Shalom
--
-- Shalom devuelve cuatro y NO son intercambiables (ver "Identificadores" en su
-- documentación). `guide_code` ya guarda la `guia`, que es la que va impresa y
-- la que trae el reporte Excel — así el cruce con la ingesta sigue funcionando.
-- Los otros tres necesitan columna propia porque cada uno abre una puerta
-- distinta y adivinarlos después es imposible.
-- ----------------------------------------------------------------------------

alter table shipments
  -- Alfanumérico de 4 caracteres que asigna Shalom. Va junto a la guia para
  -- rastrear en modo detallado.
  add column if not exists shalom_codigo        text,
  -- ID interno del envío en Shalom (OSE/SUNAT). Es el handle de /label,
  -- /voucher, /events y /grt: sin él no se puede descargar el rótulo.
  add column if not exists shalom_ose_id        bigint,
  -- ID de la orden DENTRO de la cuenta empresarial. Es el único que sirve para
  -- DELETE /v1/orders/{id}; se conoce recién al listar las órdenes.
  add column if not exists shalom_order_id      bigint,
  -- Prefijo del talonario ("v872"). Informativo, pero es lo que el cliente lee
  -- en el comprobante físico cuando reclama.
  add column if not exists shalom_serie         text,
  -- Respuesta cruda de la API al crear la guía. Auditoría: si un envío se
  -- comporta raro, esto es la evidencia de qué contestó de verdad.
  add column if not exists shalom_raw           jsonb;

comment on column shipments.shalom_ose_id is
  'ID OSE del envío en Shalom. Handle de /label, /voucher, /events y /grt.';
comment on column shipments.shalom_order_id is
  'ID de la orden en la cuenta Shalom Pro. El ÚNICO que acepta DELETE /v1/orders/{id}.';
comment on column shipments.shalom_raw is
  'Respuesta cruda de POST /v1/orders. Auditoría de la creación de la guía.';

-- La guía se busca por `codigo` cuando el cliente solo tiene el comprobante
-- físico a mano y no sabe leer cuál de los números es la guía.
create index if not exists shipments_shalom_codigo_idx
  on shipments(store_id, shalom_codigo) where shalom_codigo is not null;

-- ----------------------------------------------------------------------------
-- Sin tabla nueva para la clave de recojo: `shalom_pickup_keys` (0049) ya es
-- exactamente eso, y sigue siendo ilegible por RLS (0053). La diferencia es de
-- dónde sale la clave — antes la escribía un administrador a mano copiándola de
-- pro.shalom.pe, ahora la elegimos nosotros al crear la orden y la guardamos
-- cifrada en el mismo sitio. El flujo de Yape → validación → revelar la clave no
-- cambia ni una línea.
-- ----------------------------------------------------------------------------
