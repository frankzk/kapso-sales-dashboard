-- apply_bundled.sql — esquema completo + RLS para el SQL Editor de Supabase (generado).
-- Pegar en Supabase → SQL Editor → Run. (psql: db/apply.sql)
--
-- NO EDITAR A MANO: lo regenera `node scripts/gen-apply.mjs`.

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

-- ---- 0005 ----
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

-- ---- 0006 ----
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

-- ---- 0007 ----
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

-- ---- 0009 ----
-- ============================================================================
-- 0009_lead_inbound.sql — last inbound (customer) message time per lead
-- Powers the 24h WhatsApp session-window clock: the window is measured from the
-- customer's last inbound message, so this is what tells us how long is left
-- before the chat closes (and we can no longer send free text). Synced from
-- Kapso's conversation summary (kapso.last_inbound_at); refreshed each run.
-- ============================================================================
alter table leads add column if not exists last_inbound_at timestamptz;
create index if not exists leads_store_inbound_idx on leads (store_id, last_inbound_at);

-- ---- 0010 ----
-- ============================================================================
-- 0010_sin_stock_open.sql — "Sin stock" becomes recoverable (stays in the queue)
-- The disposition no longer marks a lead as lost: it returns to "Por llamar" so
-- the team can re-contact when stock is back (filterable under Gestión → 📦 Sin
-- stock, and no longer counted as a loss). Move existing rows accordingly.
-- ============================================================================
update leads set category = 'open' where status = 'sin_stock' and category <> 'open';

-- ---- 0011 ----
-- ============================================================================
-- 0011_meta_ads.sql — Meta ad attribution lookup (resolved from the Marketing API)
-- A Click-to-WhatsApp lead only carries ad_id + a shared creative headline
-- (referral.headline), so many distinct creatives collapse to one identical
-- on-screen label ("✈️ Viaja Sin Maletas"). This table maps each Meta ad_id to
-- its real ad / adset / campaign names (+ objective, a status snapshot, and the
-- owning account for an Ads Manager deep link) so "Rendimiento por campaña" and
-- the lead drawer can show the actual creative instead of the repeated headline.
--
-- Keyed by the globally-unique Meta ad_id (NOT store-scoped); creative names are
-- not store-sensitive. Populated out-of-band from the Meta API; read-only for
-- the app. Apply AFTER supabase/policies.sql (this file self-contains its RLS,
-- like 0004_leads.sql, since policies.sql runs before the later migrations).
-- ============================================================================
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

-- RLS: non-sensitive creative metadata — any authenticated user may read all
-- rows (the app only ever looks up ad_ids that appear in its own leads). Writes
-- happen only via the service role (BYPASSRLS) / the psql seed.
alter table meta_ads enable row level security;

drop policy if exists meta_ads_select on meta_ads;
create policy meta_ads_select on meta_ads for select to authenticated
  using (true);

grant select on meta_ads to authenticated;
grant all privileges on meta_ads to service_role;

-- ---- 0012 ----
-- ============================================================================
-- 0012_lead_wa_number.sql — which WhatsApp number a lead wrote to
-- A business can connect several WhatsApp numbers to one Kapso project (e.g. an
-- API/Cloud number + a Business-app "coexistence" number). Kapso stamps every
-- conversation with the destination `phone_number_id`; we already store that on
-- `conversations`. This migration surfaces it per LEAD so the queue + dashboard
-- can split by number:
--   1) leads.wa_phone_number_id — the number the lead came in on.
--   2) whatsapp_numbers — phone_number_id → friendly name / display phone / kind
--      (resolved from Kapso; seed with scripts/sql/seed_whatsapp_numbers.sql).
--   3) backfill existing leads from their conversation.
-- whatsapp_numbers self-contains its RLS (applied after policies.sql, like 0004).
-- ============================================================================
alter table leads add column if not exists wa_phone_number_id text;
create index if not exists leads_store_wa_number_idx on leads (store_id, wa_phone_number_id);

create table if not exists whatsapp_numbers (
  phone_number_id text primary key,
  name            text,
  display_phone   text,
  kind            text,            -- 'api' | 'business' (coexistence) | 'sandbox'
  fetched_at      timestamptz not null default now()
);

-- Non-sensitive label metadata: any authenticated user may read; writes only via
-- the service role (or the psql seed).
alter table whatsapp_numbers enable row level security;
drop policy if exists whatsapp_numbers_select on whatsapp_numbers;
create policy whatsapp_numbers_select on whatsapp_numbers for select to authenticated
  using (true);
grant select on whatsapp_numbers to authenticated;
grant all privileges on whatsapp_numbers to service_role;

-- Backfill the number onto existing leads from their conversation (idempotent).
update leads l
   set wa_phone_number_id = c.phone_number_id
  from conversations c
 where c.store_id = l.store_id
   and c.kapso_conversation_id = l.kapso_conversation_id
   and l.wa_phone_number_id is null
   and c.phone_number_id is not null;

-- ---- 0013 ----
-- ============================================================================
-- 0013_draft_orders.sql — Shopify Draft Orders (Releasit COD form abandoned carts)
--
-- An OPEN draft = an abandoned cart to work (the Releasit contraentrega form was
-- filled but no order placed); COMPLETED = recovered (the draft was completed
-- into a real order). Mirrors `orders`: store-scoped, idempotent upsert on
-- (store_id, shopify_draft_order_id), RLS read-only for authenticated users,
-- writes via the service role. Linked to leads by normalized phone
-- (lib/leads-ingest.ts → linkDraftOrdersToLeads).
--
-- Requires the Shopify token to have `read_draft_orders` (sync) and
-- `write_draft_orders` (the "Generar pedido" recovery action). The sync degrades
-- gracefully without the scope — the table just stays empty.
-- Apply AFTER supabase/policies.sql (it uses auth_store_ids()), like 0004_leads.
-- ============================================================================

create table if not exists draft_orders (
  id                     uuid primary key default gen_random_uuid(),
  store_id               uuid not null references stores(id) on delete cascade,
  shopify_draft_order_id text not null,             -- numeric id as text (from GID)
  draft_order_gid        text,                       -- gid://shopify/DraftOrder/...
  name                   text,                       -- draft name, e.g. "#D123"
  status                 text,                       -- open | invoice_sent | completed
  created_at             timestamptz,                -- Shopify createdAt
  updated_at             timestamptz,                -- Shopify updatedAt (cursor)
  completed_at           timestamptz,
  invoice_url            text,                       -- "Ver borrador" link
  total_amount           numeric(14, 2),
  currency               text,
  customer_phone         text,
  customer_name          text,
  district               text,                       -- shippingAddress.city
  province               text,                       -- shippingAddress.province
  region                 text,                       -- shippingAddress.province (PE has no 3rd level)
  address1               text,
  referencia             text,                       -- shippingAddress.address2
  tags                   text[] not null default '{}',
  note                   text,
  line_items             jsonb not null default '[]'::jsonb,
  order_gid              text,                       -- resulting order GID once completed
  raw                    jsonb,                      -- raw source payload (audit)
  ingested_at            timestamptz not null default now(),
  unique (store_id, shopify_draft_order_id)
);
create index if not exists draft_orders_store_phone_idx   on draft_orders(store_id, customer_phone);
create index if not exists draft_orders_store_status_idx  on draft_orders(store_id, status);
create index if not exists draft_orders_store_updated_idx on draft_orders(store_id, updated_at);
create index if not exists draft_orders_tags_gin          on draft_orders using gin (tags);

-- RLS — store-scoped reads; writes via service role only (mirrors 0004_leads).
alter table draft_orders enable row level security;
drop policy if exists draft_orders_select on draft_orders;
create policy draft_orders_select on draft_orders for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on draft_orders to authenticated;
grant all privileges on draft_orders to service_role;

-- Denormalized lead columns the board reads directly (district & draft_order_gid
-- already exist from 0007). Keeps the queue from having to join draft_orders.
alter table leads
  add column if not exists draft_order_name   text,
  add column if not exists draft_order_status text,   -- open | invoice_sent | completed
  add column if not exists draft_order_url    text,
  add column if not exists province           text,
  add column if not exists region             text,
  add column if not exists referencia         text;

-- ---- 0014 ----
-- ============================================================================
-- 0014_flow_webhook_secret.sql — per-store secret for the Shopify Flow webhook
-- A new inbound source ("Búsquedas abandonadas" / abandoned browse) is delivered
-- by a Shopify Flow "Send HTTP request" action to /api/webhooks/flow/[storeId].
-- It authenticates with a shared secret in the X-RecoverOps-Secret header, stored
-- encrypted at rest (AES-256-GCM, like the other store secrets). No leads change:
-- `leads.source` is free text, so the new "abandoned_browse" value needs no DDL.
-- ============================================================================
alter table stores add column if not exists flow_webhook_secret_enc text;

-- ---- 0015 ----
-- ============================================================================
-- 0015_browse_template_config.sql — per-store WhatsApp template for the
-- "Búsquedas abandonadas" (abandoned browse) auto re-engagement message.
-- When enabled, a freshly-created abandoned_browse lead triggers an approved
-- WhatsApp template send (cold outreach, outside the 24h window) from the
-- store's number. Off by default so nothing sends until a store opts in from
-- Settings with a Meta-approved template. All plain columns (template name +
-- language are public identifiers, not secrets).
-- ============================================================================
alter table stores add column if not exists browse_template_enabled  boolean not null default false;
alter table stores add column if not exists browse_template_name      text;
alter table stores add column if not exists browse_template_language  text;

-- ---- 0016 ----
-- ============================================================================
-- 0016_quick_replies.sql — per-store canned WhatsApp messages ("respuestas
-- rápidas") that an advisor inserts from the lead drawer. Shared across the
-- store's advisors. (Image sends use a PUBLIC Storage bucket "whatsapp-media"
-- created lazily by the server action — no DDL needed here.)
-- ============================================================================
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
  using (store_id in (select auth_store_ids()))
  with check (store_id in (select auth_store_ids()));
drop policy if exists quick_replies_delete on quick_replies;
create policy quick_replies_delete on quick_replies for delete to authenticated
  using (store_id in (select auth_store_ids()));

-- ---- 0017 ----
-- ============================================================================
-- 0017_telegram_summary.sql — per-store Telegram config for the daily sales
-- summary (sent at 08:00 America/Lima for the previous day). The bot token is a
-- secret (AES-256-GCM at rest, like the other store secrets); the chat id is a
-- plain identifier.
-- ============================================================================
alter table stores add column if not exists telegram_bot_token_enc text;
alter table stores add column if not exists telegram_chat_id        text;

-- ---- 0018 ----
-- Meta (Facebook) Marketing API connection per store, so ad SPEND can later be
-- matched to closed COD sales (ROAS). The access token is a secret (encrypted at
-- rest like the other *_enc columns); the selected ad account id/name are plain.
alter table stores add column if not exists meta_access_token_enc text;
alter table stores add column if not exists meta_ad_account_id     text;
alter table stores add column if not exists meta_ad_account_name   text;

-- ---- 0019 ----
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

-- ---- 0020 ----
-- ============================================================================
-- 0020_yape_routing.sql — v2 advisor routing for Yape/Shalom alerts.
--   * user_presence: heartbeat from the dashboard poll → who's online.
--   * leads.yape_offered_to / _at / _passed: the rotating offer state, advanced
--     lazily on each poll (no cron). Server-only (service role) reads/writes.
-- ============================================================================

create table if not exists user_presence (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
-- Only the service role touches presence (from server actions). RLS on with no
-- policies = deny for anon/authenticated; service_role bypasses RLS.
alter table user_presence enable row level security;
grant all privileges on user_presence to service_role;

-- Rotating offer state on the lead itself (one offer travels with each Yape).
alter table leads add column if not exists yape_offered_to uuid references auth.users(id) on delete set null;
alter table leads add column if not exists yape_offered_at timestamptz;
alter table leads add column if not exists yape_passed uuid[] not null default '{}';

create index if not exists leads_yape_offer_idx
  on leads(store_id) where status = 'yape_por_verificar';

-- ---- 0021 ----
-- ============================================================================
-- 0021_yape_alert_sent.sql — Telegram alert for unattended Yapes.
-- Tracks the last time we pinged the store's channel about a still-pending Yape,
-- so the 5-min cron doesn't spam (re-alerts at most every few hours).
-- ============================================================================

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
-- ============================================================================
-- 0026_shipment_states_v2.sql — remap the shipment state model to the gestión +
-- Fenix flow (Pendiente / En ruta / Entregado / Anulado). Adds delivered_source
-- (sub-state of Entregado: 'aliclik' from the report vs 'fenix' from gestión) and
-- rewrites the old delivery_status / status_category codes:
--   entregado                                   → entregado / delivered  (source aliclik)
--   devuelto                                    → anulado   / closed
--   reprogramado                                → en_ruta   / in_route
--   everything else (por_preparar…validado,     → pendiente / pending
--     por_devolver, dejado_almacen, remanente…)
-- reroute_attempts is kept as-is (becomes the Intento counter). fenix_eligible is
-- left untouched here — it is recomputed on the next report import.
-- Idempotent: safe to re-run (already-new codes are excluded from the catch-all).
-- ============================================================================

alter table shipments add column if not exists delivered_source text;

update shipments set delivered_source = 'aliclik'
  where delivery_status = 'entregado' and delivered_source is null;

update shipments set delivery_status = 'anulado' where delivery_status = 'devuelto';
update shipments set delivery_status = 'en_ruta' where delivery_status = 'reprogramado';
update shipments set delivery_status = 'pendiente'
  where delivery_status not in ('entregado', 'anulado', 'en_ruta', 'pendiente');

-- normalize the category to the new 4-state set
update shipments set status_category = 'delivered' where delivery_status = 'entregado';
update shipments set status_category = 'closed'    where delivery_status = 'anulado';
update shipments set status_category = 'in_route'  where delivery_status = 'en_ruta';
update shipments set status_category = 'pending'   where delivery_status = 'pendiente';

-- ---- 0027 ----
-- ============================================================================
-- 0027_shipment_suggestions.sql — batch Shopify-search auto-match suggestions
-- for the "Revisión" queue. A suggestion is a HIGH-CONFIDENCE candidate found
-- by live-searching Shopify (order-reference + phone cross-validated), but it
-- is never applied automatically — a human must confirm it via the existing
-- resolveShipmentMatch/linkShipmentToShopifyOrder actions. suggestion_checked_at
-- marks a shipment as already processed by the batch job (skip on re-run),
-- regardless of whether a suggestion was found, so the job is resumable.
-- Idempotent: safe to re-run.
-- ============================================================================

alter table shipments add column if not exists suggested_order_gid text;
alter table shipments add column if not exists suggested_store_id uuid references stores(id) on delete set null;
alter table shipments add column if not exists suggested_order_name text;
alter table shipments add column if not exists suggestion_checked_at timestamptz;

-- Drives "next N unchecked" selection for the batch job — partial index keeps
-- it small/fast since the vast majority of shipments (delivered/closed/already
-- matched) are never candidates for this scan.
create index if not exists shipments_suggestion_pending_idx
  on shipments (created_at)
  where matched = false and suggestion_checked_at is null;

-- ---- 0028 ----
-- ============================================================================
-- 0028_shipment_transferido.sql — new terminal status "transferido" (category
-- "transferred") for the Aliclik "parent" guide once a Fenix sub-guide is
-- created for it. Without this, the parent kept its old category (usually
-- en_ruta) and showed up duplicated alongside its Fenix child in the same
-- active tabs/counts. No schema change needed (delivery_status/status_category
-- are free-text columns, no CHECK constraint) — this is a one-time backfill
-- for guides that were already transferred before this migration. Going
-- forward, createFenixGuide sets these columns directly when the child is
-- created. Idempotent.
-- ============================================================================

update shipments
set delivery_status = 'transferido', status_category = 'transferred'
where courier = 'aliclik'
  and fenix_shipment_id is not null
  and delivery_status <> 'transferido';

-- ---- 0029 ----
-- ============================================================================
-- 0029_winback_template_config.sql — per-store WhatsApp template for the
-- "Recuperación de clientes" (60-day winback) message. A Shopify Flow (order
-- created → wait 60 days → no new order) posts the customer to the dashboard's
-- Flow webhook with source "winback"; when enabled, the Meta-approved template
-- (discount coupon + store link button) is sent from the store's number.
-- No lead is created — a reply enters through the normal Kapso inbound flow.
-- Off by default so nothing sends until a store opts in from Settings.
-- All plain columns (template name + language are public identifiers).
-- ============================================================================
alter table stores add column if not exists winback_template_enabled  boolean not null default false;
alter table stores add column if not exists winback_template_name      text;
alter table stores add column if not exists winback_template_language  text;

-- ---- 0030 ----
-- ============================================================================
-- 0030_attribution.sql — order-source attribution plumbing.
--
-- Two additions so every sale can be traced to ONE acquisition source and ONE
-- closing channel (the "ventas por fuente y cierre" module, order-centric so
-- the buckets reconcile to headline revenue):
--
--  1) orders.discount_codes — the coupon codes applied to the order (e.g.
--     AURELA10). Lets the winback (recuperación 60d) source be detected by
--     "used a winback coupon AND received the template within 30 days".
--
--  2) winback_sends — one row per WhatsApp winback template actually sent
--     (lib/leads-ingest.ts → processWinback), so an order can be matched to a
--     prior winback message by phone + time window. Store-scoped, RLS read-only
--     for authenticated users, writes via the service role (mirrors 0013).
-- ============================================================================

alter table orders add column if not exists discount_codes text[] not null default '{}';
create index if not exists orders_discount_codes_gin on orders using gin (discount_codes);

create table if not exists winback_sends (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  phone          text not null,              -- normalizePhone() applied
  template_name  text,
  order_gid      text,                       -- the order whose 60-day wait triggered the send
  sent_at        timestamptz not null default now(),
  ok             boolean not null default true  -- Meta/Kapso accepted the send
);
create index if not exists winback_sends_store_phone_idx on winback_sends(store_id, phone, sent_at);

alter table winback_sends enable row level security;
drop policy if exists winback_sends_select on winback_sends;
create policy winback_sends_select on winback_sends for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on winback_sends to authenticated;
grant all privileges on winback_sends to service_role;

-- ---- 0031 ----
-- ============================================================================
-- 0031_yape_vision_checks.sql — audit + dedup for vision-based Yape voucher
-- detection.
--
-- The "Yape/Shalom por verificar" alert must fire on a REAL voucher, not on any
-- screenshot the customer sends. Text/caption signals catch the explicit cases
-- ("ya pagué", "nº de operación"); a silent voucher IMAGE needs its content read
-- (Yape logo/interfaz, monto, fecha/hora, destinatario "Grupo GF SAC", estado
-- "Pago realizado/Transferencia exitosa/Yapeaste", nº de operación) — i.e. a
-- vision check (Claude), which runs at most once per image thanks to this table.
--
-- One row per inbound image analyzed:
--  - message_id  — the Kapso message id (dedup key; an image is checked once).
--  - is_voucher  — the verdict that (re)promotes the lead to yape_por_verificar.
--  - indicators  — which signals the model saw (audit / tuning), e.g.
--                  {"logo":true,"monto":true,"grupo_gf_sac":false,...}.
--  - model       — which model produced the verdict (audit).
--
-- Store-scoped, RLS read-only for authenticated users; writes via the service
-- role (the sync/cron path), mirroring winback_sends (0030) / draft_orders (0013).
-- ============================================================================

create table if not exists yape_vision_checks (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  message_id   text not null,             -- Kapso message id (globally unique)
  is_voucher   boolean not null,
  indicators   jsonb not null default '{}'::jsonb,
  model        text,
  checked_at   timestamptz not null default now(),
  unique (store_id, message_id)           -- analyze each image at most once
);
create index if not exists yape_vision_checks_store_idx on yape_vision_checks(store_id, checked_at);

alter table yape_vision_checks enable row level security;
drop policy if exists yape_vision_checks_select on yape_vision_checks;
create policy yape_vision_checks_select on yape_vision_checks for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on yape_vision_checks to authenticated;
grant all privileges on yape_vision_checks to service_role;

-- ---- 0032 ----
-- ============================================================================
-- 0032_lead_ship_address.sql — surface the full shipping address on cart leads.
--
-- The abandoned-cart card (lead drawer) showed only distrito + referencia, even
-- though the Shopify draft carries the whole address. `district`, `province`,
-- `region` and `referencia` were already denormalized onto the lead (0013); this
-- adds the two remaining pieces so an advisor sees where/whom to ship to without
-- opening Shopify:
--   - address1   — the street line (e.g. "Felipe Sassone 183").
--   - ship_name  — the recipient on the shipping address (draft customer_name),
--                  which can differ from the lead's own name (someone ordering
--                  for a relative).
-- Both come from data already captured in draft_orders, so they fill in on the
-- next sync for every open cart — no Shopify re-fetch. RLS: covered by the
-- existing leads policies (no new grants needed).
-- ============================================================================

alter table leads add column if not exists address1  text;
alter table leads add column if not exists ship_name text;

-- ---- 0033 ----
-- ============================================================================
-- 0033_kapso_webhook_secret.sql — per-store secret for the Kapso webhook
-- The Kapso lead webhook (/api/webhooks/kapso/[storeId]) used to authenticate
-- with the GLOBAL CRON_SECRET, shared across every tenant — so any store owner
-- who knew it could POST leads/conversations into ANY other store. This adds a
-- per-store secret (AES-256-GCM encrypted at rest, like the other store
-- secrets); once a store sets it, only that secret is accepted for its webhook
-- and the shared CRON_SECRET no longer authorizes writes to it. Stores that
-- have not set one yet keep the legacy CRON_SECRET fallback so nothing breaks
-- mid-migration.
-- ============================================================================
alter table stores add column if not exists kapso_webhook_secret_enc text;

-- ---- 0034 ----
-- ============================================================================
-- 0034_scope_label_tables.sql — stop leaking label tables across tenants.
-- `meta_ads` (0011) and `whatsapp_numbers` (0012) had a SELECT policy of
-- `using (true)`, so ANY authenticated user could read every tenant's Meta
-- campaign/ad names and WhatsApp business numbers. Low sensitivity (metadata,
-- no spend/tokens) but still a cross-tenant read.
--
-- The dashboard resolves these labels server-side (getAdNames/getWaNumbers) for
-- ids that already belong to the caller's own RLS-scoped leads, so we can drop
-- the public SELECT entirely: with RLS enabled and no permissive policy,
-- `authenticated` default-denies, while the service-role label lookup (and
-- ingestion) bypasses RLS. No cross-tenant leak, labels still resolve.
-- ============================================================================
drop policy if exists meta_ads_select on meta_ads;
drop policy if exists whatsapp_numbers_select on whatsapp_numbers;

-- ---- 0035 ----
-- ============================================================================
-- 0035_seguimiento_drip.sql — drip de seguimiento por WhatsApp para leads que
-- NO CONTESTAN (status no_responde / buzon / cuelga — y solo esos: contactados
-- ya tiene conversación humana, sin_llamar aún no fue tocado y sin_stock no
-- tiene novedad que ofrecer). El cron de sync (cada 5 min) envía la plantilla
-- aprobada por Meta — única vía fuera de la ventana de 24h — con máximo 2
-- toques por lead (~6h tras la gestión y +24h después), solo en horario
-- laboral de Lima, y se detiene si el cliente respondió, si la asesora agendó
-- seguimiento manual (next_followup_at) o si el lead tiene atención pendiente.
--
--  1) stores.drip_template_*  — config por tienda (mismo trío que browse /
--     winback). OFF por defecto: nada se envía hasta activar en Ajustes.
--  2) leads.drip_touches / last_drip_at — targeting barato en el selector
--     (tope de toques + espaciado de 24h) sin joins.
--  3) drip_sends — un registro por intento de envío (ok o fallido) para
--     auditoría y para medir si el drip recupera ventas (¿last_inbound_at o
--     pedido DESPUÉS de sent_at?). RLS de solo lectura para usuarios de la
--     tienda; escribe el service role (espejo de winback_sends / 0030).
-- ============================================================================

alter table stores add column if not exists drip_template_enabled  boolean not null default false;
alter table stores add column if not exists drip_template_name      text;
alter table stores add column if not exists drip_template_language  text;

alter table leads add column if not exists drip_touches int not null default 0;
alter table leads add column if not exists last_drip_at timestamptz;

create table if not exists drip_sends (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  lead_id        uuid not null references leads(id) on delete cascade,
  phone          text not null,              -- normalizePhone() applied
  template_name  text,
  touch          int  not null,              -- 1 o 2
  ok             boolean not null default true, -- Meta/Kapso aceptó el envío
  error          text,                       -- motivo cuando ok = false
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
-- ============================================================================
-- 0036_attention_waves.sql — contador de "olas" de reencolado automático por
-- lead. Un CARRITO en seguimiento cuyo último resultado fue "no logré
-- contactar" (no_responde/buzon/cuelga) y lleva 48h sin actividad vuelve a
-- subir con needs_attention — máximo 2 veces (ola 1 ≈ día 2, ola 2 ≈ día 4).
-- Sin tope sería un ping-pong infinito: cada gestión apaga la atención y
-- reinicia el reloj de 48h. Tras la ola 2, o la asesora agenda/dispone, o el
-- auto-archivado de 7 días lo saca. Los estados de "sí hablé" (contactado,
-- otros productos) y los cierres (cancelado, solo miraba…) NUNCA se reencolan.
-- ============================================================================

alter table leads add column if not exists attention_waves int not null default 0;

-- ---- 0037 ----
-- Reliable outbound WhatsApp lifecycle. One row per explicit send attempt;
-- client_token prevents double sends and provider_message_id joins status webhooks.

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

-- ---- 0042 ----
-- Permitir editar la nota de una gestión del historial dejando traza mínima de
-- que fue modificada (quién y cuándo). No se toca el estado, la fecha ni el
-- tipo de gestión: solo el texto libre de la nota.

alter table shipment_calls add column if not exists note_edited_at timestamptz;
alter table shipment_calls add column if not exists note_edited_by uuid references auth.users(id) on delete set null;

comment on column shipment_calls.note_edited_at is
  'When the free-text note was last edited (null = original, never edited).';
comment on column shipment_calls.note_edited_by is
  'User who last edited the note.';

-- ---- 0043 ----
-- ============================================================================
-- 0043_fenix_direct_guides.sql — Guías Fenix DIRECTAS: creadas desde un pedido
-- Shopify sin guía Aliclik madre (urgencias que salen del almacén regional de
-- Fénix en vez de esperar 2–3 días de Aliclik).
--
-- Marcador permanente de origen en shipments (created_via='fenix_directo').
-- No se usa reroute_outcome porque el resultado del courier lo sobreescribe.
-- El stock NO se reserva al crear: la validación (cobertura + stock de todos
-- los productos del pedido) es un gate de creación, y el descuento sigue
-- ocurriendo al entregar (salida_entrega −1, como toda guía Fénix).
-- ============================================================================

alter table shipments add column if not exists created_via text; -- 'fenix_directo' | null
create index if not exists shipments_created_via_idx
  on shipments(created_via) where created_via is not null;

-- ---- 0044 ----
-- Guardar el PRIMER mensaje que escribió el cliente (texto o caption), para que
-- la asesora tenga un anzuelo concreto con el que abrir la conversación en vez
-- de un "hola" en blanco. Es un extracto corto (no un transcript): la fuente de
-- verdad de la conversación sigue siendo Kapso.

alter table leads add column if not exists first_inbound_text text;

comment on column leads.first_inbound_text is
  'First inbound message the customer sent (text or media caption), trimmed. Opener context for the advisor.';

-- ---- 0045 ----
-- ============================================================================
-- 0045_order_master.sql — Master de Pedidos: la vista central de control de la
-- operación logística de las dos tiendas.
--
-- Dos tablas, con responsabilidades distintas:
--
--   * order_master — UNA fila por pedido, materializada. Es el read-model del
--     listado: lleva denormalizado todo lo que la tabla filtra y ordena (estado
--     general + operativo, antigüedad, rollup de couriers/intentos, dirección).
--     Se materializa porque PostgREST no hace joins ni agregados filtrables: sin
--     esta tabla, filtrar por "más de un courier" o por distrito obligaría a
--     traer todos los pedidos a memoria en cada carga. Mismo criterio con el que
--     `shipments` ya carga un snapshot del pedido (0022).
--     Se recalcula desde lib/order-master.ts; NADIE la edita a mano.
--
--   * order_events — la línea de tiempo + la auditoría. APPEND-ONLY: guarda lo
--     que no cuelga de una guía (comentarios, cambios manuales de estado,
--     anulación en Shopify, importaciones). Las gestiones por courier siguen
--     viviendo en shipments/shipment_calls (0022/0023) — el Master NO las
--     duplica, las mezcla en lectura dentro del detalle del pedido.
--
-- La dirección se denormaliza aquí porque `orders` no tiene columnas de
-- dirección: hoy solo vive dentro de orders.raw (jsonb sin indexar), que se
-- parsea con lib/shopify-address.ts.
--
-- RLS: lecturas por tienda accesible; escrituras por service role (server
-- actions), como el resto de la data ingestada. Aplicar DESPUÉS de
-- supabase/policies.sql (usa auth_store_ids()).
-- ============================================================================

create table if not exists order_master (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references stores(id) on delete cascade,
  order_id           uuid not null references orders(id) on delete cascade,

  -- ── snapshot del pedido (denormalizado: una sola tabla = una sola consulta)
  order_name         text,                       -- "#KP114985"
  shopify_order_id   text not null,
  order_created_at   timestamptz,
  customer_name      text,
  customer_phone     text,                       -- normalizado (lib/phone.ts)
  region             text,                       -- departamento (shippingAddress.province)
  province           text,                       -- provincia (derivada vía peru_districts)
  district           text,                       -- distrito (shippingAddress.city)
  shipping_mode      text,                       -- cod | agency
  order_total        numeric(14, 2),

  -- ── estado resuelto (lib/order-status.ts)
  general_status     text not null default 'pendiente'
                       check (general_status in
                         ('pendiente', 'en_proceso', 'entregado', 'anulado', 'devuelto')),
  operational_status text not null default 'sin_confirmar',
  status_since       timestamptz,                -- desde cuándo está en este estado
  status_source      text,                       -- shopify | aliclik | fenix | shalom | olva | manual
  -- Un cambio manual auditado congela el estado: el recálculo automático deja
  -- de pisarlo. Es el mecanismo del §4 de la especificación ("los cambios
  -- posteriores sobre un pedido entregado requieren modificación manual").
  status_locked      boolean not null default false,

  -- ── rollup logístico (agregado de shipments + order_events)
  current_courier    text,
  last_courier       text,
  courier_count      integer not null default 0,
  attempt_count      integer not null default 0,
  guide_code         text,                       -- guía/tracking vigente
  dispatched_at      timestamptz,
  delivered_at       timestamptz,
  delivered_courier  text,                       -- a quién se atribuye la entrega
  returned_at        timestamptz,
  last_movement_at   timestamptz,
  comment_count      integer not null default 0,
  logistics_cost     numeric(12, 2),             -- resuelto en el recálculo (fase 4)

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
-- Filtros "con más de un courier" / "con más de un intento": índices parciales
-- para que la cola no escanee toda la tabla.
create index if not exists order_master_multi_courier_idx  on order_master(store_id) where courier_count > 1;
create index if not exists order_master_multi_attempt_idx  on order_master(store_id) where attempt_count > 1;
-- Barrido de reconciliación del cron: pedidos con el rollup desfasado.
create index if not exists order_master_recomputed_idx     on order_master(recomputed_at);

alter table order_master enable row level security;

drop policy if exists order_master_select on order_master;
create policy order_master_select on order_master for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on order_master to authenticated;
grant all privileges on order_master to service_role;

-- touch_updated_at() se define en 0004_leads.sql
drop trigger if exists order_master_touch on order_master;
create trigger order_master_touch before update on order_master
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- order_events — línea de tiempo + auditoría, APPEND-ONLY
-- ----------------------------------------------------------------------------

create table if not exists order_events (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references stores(id) on delete cascade,
  order_id             uuid not null references orders(id) on delete cascade,
  -- created | confirmed | cancelled_shopify | courier_assigned | guide_registered
  -- | dispatched | out_for_delivery | attempt_failed | comment | reschedule
  -- | courier_change | delivered | return_started | returned | status_override
  -- | import | payment | key_view | key_shared
  kind                 text not null,
  occurred_at          timestamptz not null default now(),
  actor                uuid references auth.users(id) on delete set null,
  -- shopify | aliclik | fenix | shalom | olva | repro_provincia | report | manual | system
  source               text not null default 'manual',
  courier              text,
  guide_code           text,
  previous_status      text,
  new_status           text,
  previous_operational text,
  new_operational      text,
  attempt_number       integer,
  reason               text,   -- motivo de no entrega / motivo obligatorio de una excepción
  note                 text,
  comment_type         text,   -- solo para kind = 'comment'
  shipment_id          uuid references shipments(id) on delete set null,
  batch_id             uuid,   -- import_batches(id) cuando el evento vino de un reporte
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

-- APPEND-ONLY. El historial de auditoría no debe poder eliminarse ni editarse
-- (§16 y §"Auditoría de visualización" de la especificación). service_role NO es
-- superusuario: basta con no otorgarle update/delete para que sea imposible por
-- la API. El trigger es defensa en profundidad y deja la intención documentada
-- para quien entre por psql con otro rol.
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

-- ---- 0046 ----
-- ============================================================================
-- 0046_geo_peru.sql — tabla de referencia distrito → provincia → departamento.
--
-- Por qué hace falta: el Master exige un filtro MULTI-SELECT por provincia
-- (§13), pero Shopify Perú solo entrega dos niveles de dirección:
--   shippingAddress.city     = distrito
--   shippingAddress.province = departamento / región
-- La provincia (el nivel intermedio del ubigeo) NO llega de Shopify. Hoy solo
-- aparece cuando la trae el Excel de Aliclik (shipments.province, 0039), así que
-- para Lima y para cualquier pedido sin guía Aliclik quedaría en NULL y el
-- filtro sería inservible.
--
-- Esta tabla resuelve la provincia a partir del distrito normalizado. Se siembra
-- de dos formas, complementarias:
--   1) BACKFILL automático (abajo) desde los pares distrito+provincia que los
--      reportes de Aliclik ya dejaron en `shipments` — cubre de entrada toda la
--      geografía donde la operación ya despachó.
--   2) Carga del ubigeo completo del INEI vía scripts/seed-ubigeo.ts, para
--      cubrir también los distritos a los que todavía no se ha despachado.
--
-- La tabla es de referencia (no lleva store_id): legible por cualquier usuario
-- autenticado, escrita por el service role.
-- ============================================================================

-- Clave de comparación: minúsculas, sin acentos, espacios colapsados. IMMUTABLE
-- para poder usarla en índices y en columnas generadas. Deliberadamente sin la
-- extensión `unaccent` (no está garantizada en el proyecto Supabase): translate()
-- cubre las vocales acentuadas y la ñ, que es todo lo que aparece en el ubigeo.
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
  district_key text primary key,          -- geo_key(distrito)
  district     text not null,             -- etiqueta legible
  province     text not null,
  department   text,
  source       text not null default 'shipments',  -- shipments | inei | manual
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

-- ── Backfill desde los reportes de Aliclik ya ingestados ─────────────────────
-- Un distrito puede aparecer escrito de varias formas; nos quedamos con el par
-- (provincia, departamento) más frecuente por distrito, y con la etiqueta más
-- vista. Idempotente: on conflict do nothing, para no pisar una fila del INEI
-- (que es más fiable) con una inferida de un Excel.
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

-- ---- 0047 ----
-- ============================================================================
-- 0047_shipment_gestion.sql — campos de gestión logística y de agencia sobre
-- `shipments`.
--
-- La especificación (§8) pide registrar, POR CADA gestión logística: courier,
-- nº de intento, fecha de asignación, de despacho, de salida a reparto, estado
-- reportado, resultado, motivo de no entrega, fecha de reprogramación, fecha de
-- cierre, guía, observaciones, usuario y fuente del reporte.
--
-- Una "gestión logística" es, en la práctica, una guía asignada a un courier —
-- que es exactamente lo que `shipments` ya modela (0022). Por eso se extiende
-- esa tabla en vez de crear una paralela: duplicar las guías obligaría a
-- sincronizar dos fuentes de verdad y rompería Repro Provincia, que es su dueño.
--
-- Hasta esta migración, lib/order-master.ts DERIVA estas fechas del historial de
-- `shipment_calls` (el primer paso a "en_ruta" es el despacho, etc.). Con las
-- columnas explícitas, el dato reportado por el courier manda sobre lo derivado;
-- el código ya contempla ambos casos con el patrón de "column step-down", así
-- que esta migración se puede aplicar antes o después del deploy.
--
-- También abre `shipments` al flujo de AGENCIA (Shalom / Olva, §10), que hasta
-- ahora no existía en el sistema: esos couriers solo aparecían como texto libre
-- en el módulo de Leads.
-- ============================================================================

alter table shipments
  -- Fechas de la gestión, tal como las reporta el courier.
  add column if not exists assigned_at          timestamptz,
  add column if not exists dispatched_at        timestamptz,
  add column if not exists out_for_delivery_at  timestamptz,
  add column if not exists rescheduled_at       timestamptz,
  add column if not exists closed_at            timestamptz,
  add column if not exists returned_at          timestamptz,
  -- Qué dijo el reporte, literal, antes de normalizarlo a delivery_status. Es lo
  -- que permite auditar por qué el sistema decidió lo que decidió.
  add column if not exists reported_status      text,
  add column if not exists non_delivery_reason  text,
  -- De dónde salió el último dato: aliclik | fenix | shalom | olva | manual | api
  add column if not exists source               text,
  -- Flujo de agencia (§10).
  add column if not exists agency_branch        text,
  add column if not exists agency_arrived_at    timestamptz,
  add column if not exists agency_expires_at    timestamptz,
  -- Sub-estado del recojo; los valores válidos son los del catálogo de estados
  -- operativos de lib/order-status.ts (enviado_a_agencia, registrado_en_agencia,
  -- en_transito, disponible_para_recojo, cliente_notificado, pendiente_de_recojo,
  -- proximo_a_vencer, retorno_iniciado). Sin CHECK, igual que delivery_status
  -- (ver 0028): el catálogo vive en el código, que es donde se puede versionar.
  add column if not exists pickup_state         text;

comment on column shipments.reported_status is
  'Estado tal como lo reportó el courier, sin normalizar (auditoría).';
comment on column shipments.pickup_state is
  'Sub-estado del flujo de agencia (Shalom/Olva). Catálogo en lib/order-status.ts.';
comment on column shipments.agency_expires_at is
  'Fecha límite de recojo en agencia; pasada, el pedido pasa a "próximo a vencer".';

-- El monitoreo de agencia (§10) es una cola por sí misma: pedidos disponibles
-- para recojo y próximos a vencer. Índice parcial para no escanear las guías de
-- reparto normal, que son la mayoría.
create index if not exists shipments_pickup_state_idx
  on shipments(store_id, pickup_state) where pickup_state is not null;
create index if not exists shipments_agency_expiry_idx
  on shipments(agency_expires_at) where agency_expires_at is not null;
create index if not exists shipments_returned_idx
  on shipments(store_id, returned_at) where returned_at is not null;

-- Backfill de lo que ya se puede saber sin inventar nada:
--   * assigned_at — cuándo entró la guía al sistema.
--   * source      — el courier que la trajo.
update shipments
   set assigned_at = coalesce(assigned_at, created_at),
       source      = coalesce(source, courier)
 where assigned_at is null or source is null;

-- ----------------------------------------------------------------------------
-- El rollup del Master también necesita el dato de agencia: el listado filtra y
-- ordena por "disponible para recojo", "días en agencia" y "próximo a vencer"
-- (§10), y eso se resuelve en una sola tabla o no se resuelve.
-- ----------------------------------------------------------------------------

alter table order_master
  add column if not exists pickup_state      text,
  add column if not exists agency_branch     text,
  add column if not exists agency_arrived_at timestamptz,
  add column if not exists agency_expires_at timestamptz;

create index if not exists order_master_pickup_idx
  on order_master(store_id, pickup_state) where pickup_state is not null;
create index if not exists order_master_expiry_idx
  on order_master(agency_expires_at) where agency_expires_at is not null;

-- ---- 0048 ----
-- ============================================================================
-- 0048_courier_reports.sql — cada carga de información como un reporte
-- independiente, sea del courier que sea (§6).
--
-- `import_batches` (0024) ya registraba las cargas del Excel de Aliclik. En vez
-- de crear una tabla paralela, se generaliza: mismo registro, más metadatos, y
-- `kind`/`courier` distinguen la fuente. Así la cola de revisión manual que ya
-- existe (`import_rows.match_status = 'review'`, UI en components/import-review)
-- sirve para todos los couriers sin reescribir nada.
--
-- Novedad importante: **los reportes originales se conservan** (§19.8). Hasta
-- ahora el Excel se parseaba en memoria y se descartaba; `file_path` apunta al
-- archivo tal cual en el bucket privado `courier-reports`.
-- ============================================================================

alter table import_batches
  -- Courier o fuente del reporte: aliclik | fenix | shalom | olva | manual | api
  add column if not exists courier            text,
  -- Fecha a la que se refiere el reporte (distinta de la fecha de carga).
  add column if not exists report_date        date,
  -- Ruta del archivo original en el bucket privado `courier-reports`.
  add column if not exists file_path          text,
  add column if not exists file_type          text,
  add column if not exists file_sha256        text,
  -- Contadores que pide la especificación, además de los de 0024
  -- (row_count = registros procesados, matched_count, unmatched_count).
  add column if not exists found_count        integer not null default 0,
  add column if not exists updated_count      integer not null default 0,
  add column if not exists unrecognized_count integer not null default 0,
  -- Errores e inconsistencias detectadas, para poder revisarlas después.
  add column if not exists errors             jsonb not null default '[]'::jsonb;

comment on column import_batches.courier is
  'Courier o fuente del reporte. Determina qué adaptador lo parseó (lib/couriers).';
comment on column import_batches.file_path is
  'Archivo original en el bucket privado `courier-reports`. Se conserva por auditoría.';
comment on column import_batches.found_count is
  'Registros del reporte que se pudieron vincular a un pedido.';
comment on column import_batches.updated_count is
  'Pedidos cuyo estado cambió efectivamente con este reporte.';

create index if not exists import_batches_courier_idx
  on import_batches(store_id, courier, created_at desc);
-- El mismo archivo cargado dos veces es casi siempre un error del operador; el
-- índice permite avisarlo sin bloquear (una re-carga deliberada es legítima:
-- reconcileDeliveryStatus solo avanza el estado, nunca lo retrocede).
create index if not exists import_batches_sha_idx
  on import_batches(file_sha256) where file_sha256 is not null;

-- Los lotes existentes son todos de Aliclik.
update import_batches
   set courier = coalesce(courier, case when kind = 'aliclik_delivery' then 'aliclik' end)
 where courier is null;

-- ---- 0049 ----
-- ============================================================================
-- 0049_yape_payments.sql — validación de los pagos Yape y clave de recojo de
-- los envíos por Shalom.
--
-- El proceso real: el cliente paga un ADELANTO para que el pedido se despache y,
-- antes de recibir la clave con la que recoge el paquete en la agencia, paga la
-- DIFERENCIA. La clave es la llave del paquete: si se entrega antes de cobrar,
-- el dinero se pierde.
--
-- De ahí las tres cosas que esta migración hace cumplir a nivel de base de datos:
--
--  1. UN COMPROBANTE, UN PAGO. Un mismo Yape no puede registrarse dos veces, ni
--     asociarse a dos pedidos, ni servir de adelanto y de diferencia a la vez, ni
--     volver a subirse desde otra tienda o por otro usuario. Se garantiza con
--     índices únicos GLOBALES (no por tienda) sobre el nº de operación y sobre la
--     huella del archivo.
--  2. LA CLAVE VA CIFRADA. `pickup_key_enc` guarda AES-256-GCM (lib/crypto.ts,
--     la misma ENCRYPTION_KEY que cifra los tokens de tienda). Nunca hay texto
--     plano en la base. La tabla NO tiene policy de select para `authenticated`:
--     RLS activo sin policy = denegado. La clave solo sale por un server action
--     que comprueba permisos y condiciones.
--  3. VER LA CLAVE DEJA RASTRO IMBORRABLE. `pickup_key_views` es append-only,
--     como `order_events` (0045): quién la vio, cuándo, con qué pagos validados.
--
-- Aplicar DESPUÉS de supabase/policies.sql (usa auth_store_ids()).
-- ============================================================================

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

-- ---- 0050 ----
-- ============================================================================
-- 0050_costs.sql — módulo de Costos (§17).
--
-- Sección propia, no una pestaña dentro de Ajustes: la especificación anticipa
-- que crecerá hacia una sección financiera más amplia.
--
-- Lo que decide toda la forma de estas tablas es la VIGENCIA. Una tarifa no es
-- un número, es un número con fecha de inicio: si mañana sube el costo de
-- reparto en Huancayo, los pedidos de la semana pasada tienen que seguir
-- costando lo que costaron. Por eso nada se edita en su sitio — se cierra la
-- tarifa vigente y se abre otra.
--
-- La resolución (qué tarifa aplica a un pedido concreto) es pura y vive en
-- lib/costs.ts, con un orden de especificidad de distrito → provincia → región →
-- courier → tienda.
--
-- Escritura para administradores de la organización, siguiendo el patrón de
-- fenix_stock (0025) — es la única forma de tabla que el dashboard edita
-- directamente bajo RLS en vez de por service role.
-- ============================================================================

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

-- ---- 0051 ----
-- ============================================================================
-- 0051_order_geo.sql — corrección manual de la ubicación de un pedido.
--
-- El problema real: la dirección que llega de Shopify viene del formulario que
-- llenó el cliente, y Shopify mismo la marca con "Revisa los problemas con la
-- dirección" bastante seguido. El punto del mapa ("Ver mapa") apunta a donde
-- Shopify cree, que no es donde está. Y la provincia se infiere del distrito, que
-- también puede venir mal escrito.
--
-- Nada de eso se puede arreglar reescribiendo `orders`: esa tabla es el reflejo
-- de Shopify y la siguiente sincronización lo pisaría. Así que la corrección vive
-- aparte y GANA sobre todo lo demás al recalcular — el mismo criterio que
-- `shipments.address_override` (0038) usa para que un re-import no borre la
-- dirección que el equipo arregló a mano.
--
-- Aplicar DESPUÉS de supabase/policies.sql (usa auth_store_ids()).
-- ============================================================================

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

-- ---- 0052 ----
-- ============================================================================
-- 0052_store_anthropic_key.sql — clave de Anthropic POR TIENDA.
--
-- Hasta ahora la lectura de comprobantes Yape usaba una única
-- `ANTHROPIC_API_KEY` de entorno, así que el gasto de las dos tiendas caía en la
-- misma cuenta y no había forma de separarlo. Con la clave en la tienda, cada
-- una consume (y paga) lo suyo.
--
-- Se guarda cifrada con AES-256-GCM (lib/crypto.ts), igual que el token de
-- Shopify, el secreto de sus webhooks, la API key de Kapso y el token de Meta:
-- se descifra solo en el servidor y nunca viaja al cliente.
--
-- La variable de entorno sigue funcionando como RESPALDO para las tiendas que
-- no tengan clave propia — así nada deja de funcionar al aplicar esto.
-- ============================================================================

alter table stores
  add column if not exists anthropic_api_key_enc text,
  -- Modelo por tienda: permite abaratar una tienda sin tocar la otra ni
  -- redesplegar (p. ej. un modelo más económico para la clasificación simple).
  add column if not exists anthropic_model        text;

comment on column stores.anthropic_api_key_enc is
  'enc: API key de Anthropic de ESTA tienda (lectura de comprobantes Yape). Cifrada AES-256-GCM. Respaldo: ANTHROPIC_API_KEY del entorno.';
comment on column stores.anthropic_model is
  'Modelo de visión para esta tienda. Vacío = el valor por defecto del entorno.';

-- ---- 0053 ----
-- ============================================================================
-- 0053_revoke_default_grants.sql — quitar los privilegios que Supabase concede
-- por defecto sobre las tablas sensibles.
--
-- QUÉ PASÓ. Supabase deja configurado, en el esquema `public`:
--     alter default privileges ... grant all on tables to anon, authenticated, service_role;
-- así que CADA tabla nueva nace con TODOS los privilegios para los tres roles.
-- Un `grant select, insert to service_role` no resta nada: solo añade sobre un
-- permiso que ya era total.
--
-- Por eso 0045 y 0049 no lograron lo que documentaban:
--   * `order_events` y `pickup_key_views` se declaran APPEND-ONLY, pero
--     conservaban UPDATE/DELETE por privilegio. (El trigger `reject_mutation`
--     sí los bloqueaba — la inmutabilidad nunca estuvo rota, pero la segunda
--     cerradura no existía.)
--   * `shalom_pickup_keys` se declara ilegible, y aunque RLS activo SIN policy
--     ya deniega a `authenticated`, el privilegio de SELECT seguía concedido:
--     a una policy de distancia de exponer la clave de recojo.
--
-- Esta migración revoca todo y vuelve a conceder solo lo necesario. Es
-- idempotente y no toca datos.
--
-- POR QUÉ NO LO DETECTARON LAS PRUEBAS: el Postgres desechable de
-- scripts/verify-db.sh no traía las default privileges de Supabase, así que la
-- comprobación pasaba. `scripts/sql/test_prelude.sql` ahora las replica, para
-- que este tipo de fallo se vea en CI y no en producción.
-- ============================================================================

-- ── Auditoría append-only ────────────────────────────────────────────────────
-- Solo leer e insertar. Ni el rol con el que escriben los server actions puede
-- reescribir el historial.
revoke all on order_events     from anon, authenticated, service_role;
revoke all on pickup_key_views from anon, authenticated, service_role;

grant select         on order_events     to authenticated;
grant select, insert on order_events     to service_role;
grant select         on pickup_key_views to authenticated;
grant select, insert on pickup_key_views to service_role;

-- ── Clave de recojo ──────────────────────────────────────────────────────────
-- NADIE salvo el service role la toca, y aun así solo a través del server action
-- que comprueba permisos y deja auditoría. Sin privilegio y sin policy: dos
-- cerraduras independientes.
revoke all on shalom_pickup_keys from anon, authenticated;
grant all privileges on shalom_pickup_keys to service_role;

-- ── Comprobantes y entregas de clave ─────────────────────────────────────────
-- Lectura para el equipo (acotada por RLS), escritura solo por el service role.
revoke all on order_payments     from anon, authenticated;
revoke all on pickup_key_shares  from anon, authenticated, service_role;
grant select on order_payments to authenticated;
grant all privileges on order_payments to service_role;
grant select         on pickup_key_shares to authenticated;
grant select, insert on pickup_key_shares to service_role;

-- ── Read-model del Master ────────────────────────────────────────────────────
-- `order_master` se deriva por completo del recálculo; que un cliente pudiera
-- escribirla directamente no tendría sentido (y RLS no lo impide por sí solo:
-- su policy es solo de SELECT).
revoke all on order_master from anon, authenticated;
grant select on order_master to authenticated;
grant all privileges on order_master to service_role;

revoke all on order_geo_overrides from anon, authenticated;
grant select on order_geo_overrides to authenticated;
grant all privileges on order_geo_overrides to service_role;

-- ── Referencia geográfica ────────────────────────────────────────────────────
revoke all on peru_districts from anon, authenticated;
grant select on peru_districts to authenticated;
grant all privileges on peru_districts to service_role;

-- ── Permisos por usuario ─────────────────────────────────────────────────────
-- Que un usuario pudiera concederse permisos a sí mismo vaciaría el modelo.
revoke all on user_permissions from anon, authenticated;
grant select on user_permissions to authenticated;
grant all privileges on user_permissions to service_role;

-- ── Costos ───────────────────────────────────────────────────────────────────
-- Aquí SÍ escribe el usuario autenticado: la policy `..._write` lo acota a los
-- administradores de la organización (patrón de fenix_stock, 0025). Se quitan
-- TRUNCATE y REFERENCES, que nunca hacen falta desde la API.
revoke all on cost_tariffs     from anon, authenticated;
revoke all on product_costs    from anon, authenticated;
revoke all on additional_costs from anon, authenticated;
grant select, insert, update, delete on cost_tariffs     to authenticated;
grant select, insert, update, delete on product_costs    to authenticated;
grant select, insert, update, delete on additional_costs to authenticated;
grant all privileges on cost_tariffs, product_costs, additional_costs to service_role;

-- ---- 0054 ----
-- ============================================================================
-- 0054_aliclik_api.sql — credenciales y campos de la API de integración de
-- Aliclik.
--
-- Hasta aquí la relación con Aliclik era de UNA sola dirección y por archivo:
-- alguien descargaba un Excel del panel y lo subía (lib/aliclik-import.ts →
-- lib/aliclik-ingest.ts). Esta migración abre la dirección contraria: crear el
-- pedido en Aliclik desde el Master y recibir sus estados.
--
-- Las credenciales siguen el patrón de todo el repo — columna cifrada en
-- `stores` (lib/crypto.ts, AES-256-GCM), NO una tabla de integraciones. Ver
-- 0052 (clave de Anthropic) para el precedente más reciente.
--
-- LA DECISIÓN QUE IMPORTA está en `shipments.external_order_number`.
-- Aliclik tiene DOS identificadores para el mismo envío físico:
--   * `orderNumber` — "ALC000123456789", lo devuelve la API al crear.
--   * el código de guía — "AUR5X…", el que aparece en el Excel y va impreso
--     en el paquete; es el que el equipo busca y el que ya vive en `guide_code`
--     (único por courier, ver 0022).
-- Guardarlos en la misma columna crearía DOS filas para un solo envío en cuanto
-- se importe el Excel, y el Master contaría dos guías (courier_count,
-- attempt_count) para el mismo pedido. Así que son dos columnas: al crear por
-- API el `guide_code` lleva el ALC… de forma PROVISIONAL, y cuando el reporte
-- traiga el AUR5X… lib/aliclik-reconcile.ts lo promueve sobre la MISMA fila,
-- que conserva sus llamadas, su vínculo al pedido y su historial.
--
-- El ALC… provisional es seguro frente al detector por valor del importador
-- (`GUIDE_RE = /AUR5X[A-Za-z0-9]+/i`, lib/aliclik-import.ts:66): nunca puede
-- confundir uno con otro.
--
-- Aplicar DESPUÉS de supabase/policies.sql. Idempotente; no toca datos.
-- ============================================================================

-- ── Credenciales por tienda ──────────────────────────────────────────────────
alter table stores
  -- Bearer token de integración entregado por Aliclik. Cifrado.
  add column if not exists aliclik_api_token_enc      text,
  -- Secreto propio que viaja en la URL del webhook. La API de Aliclik NO firma
  -- sus notificaciones (ver 0057), así que este secreto es la única barrera.
  add column if not exists aliclik_webhook_secret_enc text,
  -- Interruptor por tienda. Junto con ALICLIK_WRITE_ENABLED del entorno, hacen
  -- falta DOS llaves deliberadas para que salga una sola petición de escritura.
  add column if not exists aliclik_enabled            boolean not null default false;

comment on column stores.aliclik_enabled is
  'Habilita la creación de guías en Aliclik para esta tienda. Junto con ALICLIK_WRITE_ENABLED.';

-- ── Identidad y costos de la guía ────────────────────────────────────────────
alter table shipments
  -- El orderNumber de Aliclik (ALC000…). Es la clave con la que se consulta
  -- GET /integration/order y con la que llegan los webhooks.
  add column if not exists external_order_number  text,
  -- Lo que Aliclik cotizó para ESTA guía. Es mejor dato que cualquier tarifa
  -- resuelta por cuadro, porque es el precio real de este envío concreto.
  add column if not exists quoted_delivery_cost   numeric(12, 2),
  add column if not exists quoted_return_cost     numeric(12, 2),
  add column if not exists aliclik_transport_id   integer,
  add column if not exists aliclik_transport_name text;

comment on column shipments.external_order_number is
  'orderNumber de Aliclik (ALC000…). Distinto de guide_code (AUR5X…): ver la cabecera de 0054.';

-- Único por courier, igual que guide_code (0022) y por la misma razón: el pool
-- de guías es multitienda. Parcial, porque solo las guías creadas por API lo
-- tienen — las importadas del Excel lo dejan nulo y no deben colisionar entre sí.
create unique index if not exists shipments_external_order_uniq
  on shipments(courier, external_order_number)
  where external_order_number is not null;

-- El webhook y el cron de reconciliación buscan SIEMPRE por este número, sin
-- conocer la tienda: el payload de Aliclik solo trae el orderNumber.
create index if not exists shipments_external_order_idx
  on shipments(external_order_number)
  where external_order_number is not null;

-- ---- 0055 ----
-- ============================================================================
-- 0055_aliclik_catalog.sql — espejo del catálogo de Aliclik y mapeo de SKUs.
--
-- EL PROBLEMA. `POST /integration/order` exige `products[].ean` — el EAN del
-- catálogo de Aliclik — y que TODOS los productos del pedido salgan del MISMO
-- almacén (`warehouseId`, que además es obligatorio para cotizar el envío).
-- Nosotros solo tenemos el `sku` de Shopify que viene en `orders.line_items`.
-- No existía ninguna tabla de catálogo: `product_costs` (0050) tiene `sku` pero
-- es una tabla de costos, sin EAN ni almacén.
--
-- POR QUÉ UN ESPEJO Y NO CONSULTAR EN VIVO. El catálogo hace falta en cada
-- validación previa (¿este pedido es creable?), y esa pregunta se responde para
-- listas enteras de pedidos, no de uno en uno. Consultar la API por cada fila
-- sería insostenible. Además el directorio de agencias de Aliclik se sirve de un
-- cache en memoria que puede responder 502 si Shalom no contesta: cachearlo aquí
-- evita que una caída de Shalom bloquee una creación.
--
-- POR QUÉ DOS TABLAS Y NO UNA. `aliclik_skus` es un espejo: se reescribe entero
-- en cada sincronización y no contiene ninguna decisión nuestra. `aliclik_sku_map`
-- SÍ es una decisión del equipo (qué SKU de Shopify corresponde a qué EAN) y
-- debe sobrevivir a cualquier resincronización. Mezclarlas perdería el mapeo
-- manual en el primer sync.
--
-- Aplicar DESPUÉS de supabase/policies.sql (usa auth_store_ids()).
-- Nota 0053: Supabase concede TODO por defecto sobre cada tabla nueva, así que
-- hay que revocar antes de conceder.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Espejo del catálogo público (GET /integration/product/public)
-- ----------------------------------------------------------------------------

create table if not exists aliclik_skus (
  store_id            uuid not null references stores(id) on delete cascade,
  -- El EAN es el identificador que viaja en products[].ean. Es la clave.
  ean                 text not null,
  sku                 text,
  product_id          integer,
  product_name        text,
  sku_name            text,
  category            text,
  url_image           text,
  regular_price       numeric(12, 2),
  drop_price          numeric(12, 2),
  -- Ojo: stock RESERVABLE, no físico. Aliclik lo dice explícitamente. Sirve
  -- para avisar, y como bloqueo duro solo en agencia (donde el servidor lo exige).
  stock_virtual       integer,
  warehouse_id        integer,
  warehouse_name      text,
  -- Solo llegan con isAgency=true. `format_time_agency` es la hora de corte del
  -- almacén, contra la que se valida shipping.scheduleDate.
  format_time_agency  text,
  shalom_origin_in    text,
  -- ¿Apareció en la pasada con isAgency=true? Es lo que decide si este SKU se
  -- puede despachar por agencia Shalom.
  is_agency_eligible  boolean not null default false,
  synced_at           timestamptz not null default now(),
  primary key (store_id, ean)
);

create index if not exists aliclik_skus_sku_idx       on aliclik_skus(store_id, sku);
create index if not exists aliclik_skus_warehouse_idx on aliclik_skus(store_id, warehouse_id);

alter table aliclik_skus enable row level security;

drop policy if exists aliclik_skus_select on aliclik_skus;
create policy aliclik_skus_select on aliclik_skus for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_skus from anon, authenticated, service_role;
grant select         on aliclik_skus to authenticated;
grant all privileges on aliclik_skus to service_role;

-- ----------------------------------------------------------------------------
-- Mapeo SKU de Shopify → EAN de Aliclik. Decisión del equipo; sobrevive al sync.
-- ----------------------------------------------------------------------------

create table if not exists aliclik_sku_map (
  store_id     uuid not null references stores(id) on delete cascade,
  -- SKU tal y como llega en orders.line_items[].sku, ya normalizado (trim+upper)
  -- por lib/aliclik-catalog.ts. Normalizar aquí evita que "ABC " y "abc" sean
  -- dos entradas distintas para el mismo producto.
  shopify_sku  text not null,
  ean          text not null,
  -- 'auto' = sembrado por igualdad exacta de SKU en el sync; 'manual' = lo
  -- decidió una persona. El sync solo puede pisar los 'auto'.
  source       text not null default 'manual' check (source in ('auto', 'manual')),
  note         text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (store_id, shopify_sku)
);

create index if not exists aliclik_sku_map_ean_idx on aliclik_sku_map(store_id, ean);

alter table aliclik_sku_map enable row level security;

drop policy if exists aliclik_sku_map_select on aliclik_sku_map;
create policy aliclik_sku_map_select on aliclik_sku_map for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_sku_map from anon, authenticated, service_role;
grant select         on aliclik_sku_map to authenticated;
grant all privileges on aliclik_sku_map to service_role;

drop trigger if exists aliclik_sku_map_touch on aliclik_sku_map;
create trigger aliclik_sku_map_touch before update on aliclik_sku_map
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Directorio de agencias Shalom (GET /integration/order/agencies)
--
-- Cacheado en local a propósito: el endpoint se sirve de un cache en memoria de
-- Aliclik y responde 502 si Shalom no contesta y no hay cache. Un despacho no
-- puede depender de eso.
-- ----------------------------------------------------------------------------

create table if not exists aliclik_agencies (
  store_id   uuid not null references stores(id) on delete cascade,
  -- La API lo declara number | string | null y pide enviarlo como string.
  agency_id  text not null,
  name       text,
  address    text,
  department text,
  province   text,
  district   text,
  synced_at  timestamptz not null default now(),
  primary key (store_id, agency_id)
);

create index if not exists aliclik_agencies_name_idx on aliclik_agencies(store_id, name);

alter table aliclik_agencies enable row level security;

drop policy if exists aliclik_agencies_select on aliclik_agencies;
create policy aliclik_agencies_select on aliclik_agencies for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_agencies from anon, authenticated, service_role;
grant select         on aliclik_agencies to authenticated;
grant all privileges on aliclik_agencies to service_role;

-- ----------------------------------------------------------------------------
-- Tamaños de paquete (GET /integration/order/package-sizes)
-- ----------------------------------------------------------------------------

create table if not exists aliclik_package_sizes (
  store_id  uuid not null references stores(id) on delete cascade,
  title     text not null,
  position  integer,
  synced_at timestamptz not null default now(),
  primary key (store_id, title)
);

alter table aliclik_package_sizes enable row level security;

drop policy if exists aliclik_package_sizes_select on aliclik_package_sizes;
create policy aliclik_package_sizes_select on aliclik_package_sizes for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_package_sizes from anon, authenticated, service_role;
grant select         on aliclik_package_sizes to authenticated;
grant all privileges on aliclik_package_sizes to service_role;

comment on table aliclik_skus is
  'Espejo del catálogo público de Aliclik. Se reescribe en cada sync; no contiene decisiones nuestras.';
comment on table aliclik_sku_map is
  'SKU de Shopify → EAN de Aliclik. Decisión del equipo: el sync NO pisa las filas source=manual.';

-- ---- 0056 ----
-- ============================================================================
-- 0056_aliclik_order_requests.sql — registro de intención de creación.
--
-- POR QUÉ EXISTE ESTA TABLA. Crear un pedido en Aliclik es una escritura hacia
-- afuera, irreversible, con ventanas de cancelación estrictas — y la API NO
-- tiene idempotency key. Sin protección propia:
--   * un doble clic crea DOS pedidos reales;
--   * dos operadoras sobre el mismo pedido crean DOS pedidos reales;
--   * un timeout de red deja al equipo sin saber si el pedido existe o no
--     (Aliclik pudo haberlo creado igual), y el reintento crea el segundo.
--
-- La fila se escribe ANTES del POST. El índice único parcial es el candado: dos
-- intentos vivos sobre el mismo pedido chocan en la base (23505) en lugar de
-- convertirse en dos guías. Es el mismo criterio que `createDirectFenixGuide`
-- aplica al rechazar un pedido que ya tiene guía activa.
--
-- `status = 'failed'` queda FUERA del único a propósito: un intento que falló
-- de verdad debe poder reintentarse. Los 'pending' NO se excluyen — un pending
-- es justamente el caso peligroso (¿se creó o no?), y lo resuelve el cron de
-- reconciliación buscando el pedido huérfano por teléfono, no un reintento a
-- ciegas.
--
-- Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

create table if not exists aliclik_order_requests (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  order_id     uuid not null references orders(id) on delete cascade,
  modality     text not null check (modality in ('cod', 'agency')),
  -- pending  → escrito antes del POST; no sabemos el resultado
  -- sent     → 201 recibido, tenemos orderNumber
  -- failed   → la API rechazó; se puede reintentar
  -- duplicate→ el guard detectó que ya existía
  status       text not null default 'pending'
                 check (status in ('pending', 'sent', 'failed', 'duplicate')),
  order_number text,
  -- El cuerpo enviado, ya redactado (sin la clave de recojo). Sirve para
  -- reportar una incidencia a Aliclik: su soporte pide request y response.
  request      jsonb not null default '{}'::jsonb,
  response     jsonb,
  http_status  integer,
  error        text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- EL CANDADO. Un solo intento vivo por pedido.
create unique index if not exists aliclik_order_requests_live_uniq
  on aliclik_order_requests(order_id)
  where status <> 'failed';

create index if not exists aliclik_order_requests_store_idx
  on aliclik_order_requests(store_id, created_at desc);
-- Para que el cron encuentre los huérfanos: intentos que quedaron en 'pending'.
create index if not exists aliclik_order_requests_pending_idx
  on aliclik_order_requests(store_id, created_at)
  where status = 'pending';

alter table aliclik_order_requests enable row level security;

drop policy if exists aliclik_order_requests_select on aliclik_order_requests;
create policy aliclik_order_requests_select on aliclik_order_requests for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_order_requests from anon, authenticated, service_role;
grant select         on aliclik_order_requests to authenticated;
grant all privileges on aliclik_order_requests to service_role;

comment on table aliclik_order_requests is
  'Intención de creación en Aliclik, escrita ANTES del POST. El único parcial impide dos guías por pedido.';

-- ---- 0057 ----
-- ============================================================================
-- 0057_aliclik_webhook_events.sql — bitácora de notificaciones de Aliclik.
--
-- CONTEXTO DE SEGURIDAD. El webhook de Aliclik NO viene firmado: la
-- documentación define el payload
--   { orderNumber, dispatchStatus, status, callStatus }
-- y ninguna cabecera de autenticación, ni HMAC, ni lista de IPs. Tampoco trae
-- timestamp, y la propia documentación avisa de que "los estados pueden llegar
-- en desorden".
--
-- La respuesta a eso es doble, y solo la primera mitad vive aquí:
--
--   1) Autenticación por secreto en la URL (?secret=…), comparado en tiempo
--      constante — el mismo patrón que el webhook de Kapso. El panel de Aliclik
--      acepta una URL libre, así que cabe.
--
--   2) EL PAYLOAD NO SE CREE. El handler no escribe el estado que llega en el
--      cuerpo: registra el evento aquí y vuelve a preguntar por
--      `GET /integration/order?orderNumber=…`, escribiendo ESA respuesta, que sí
--      trae `updatedAt` real y sirve de guarda monotónica. Así el desorden
--      desaparece y una notificación falsificada, como mucho, nos hace releer la
--      verdad desde Aliclik.
--
-- La idempotencia que pide la documentación es el índice único sobre el
-- fingerprint: reenviar el mismo estado no vuelve a disparar la lectura.
--
-- APPEND-ONLY, como order_events (0045) y pickup_key_views (0049): trigger
-- `reject_mutation` + privilegios recortados (ver 0053 — Supabase concede todo
-- por defecto, así que hay que revocar primero).
--
-- Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

create table if not exists aliclik_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  -- Puede ser nulo: el payload solo trae el orderNumber, y si todavía no
  -- conocemos esa guía no hay tienda a la que atribuirlo. Se registra igual —
  -- un evento que no supimos ubicar es justo lo que hay que poder investigar.
  store_id      uuid references stores(id) on delete cascade,
  order_number  text not null,
  -- sha256 de orderNumber|status|callStatus|dispatchStatus. Ver lib/aliclik-track.ts.
  fingerprint   text not null,
  status        text,
  call_status   text,
  dispatch_status text,
  payload       jsonb not null default '{}'::jsonb,
  -- Qué hicimos con él: applied | duplicate | unknown_order | error
  outcome       text,
  received_at   timestamptz not null default now()
);

-- LA IDEMPOTENCIA. El mismo estado reenviado choca aquí y no releemos la API.
create unique index if not exists aliclik_webhook_events_fingerprint_uniq
  on aliclik_webhook_events(fingerprint);

create index if not exists aliclik_webhook_events_order_idx
  on aliclik_webhook_events(order_number, received_at desc);
create index if not exists aliclik_webhook_events_store_idx
  on aliclik_webhook_events(store_id, received_at desc);

alter table aliclik_webhook_events enable row level security;

drop policy if exists aliclik_webhook_events_select on aliclik_webhook_events;
create policy aliclik_webhook_events_select on aliclik_webhook_events for select to authenticated
  using (store_id in (select auth_store_ids()));

-- Append-only: ni el rol con el que escriben los server actions reescribe esto.
revoke all on aliclik_webhook_events from anon, authenticated, service_role;
grant select         on aliclik_webhook_events to authenticated;
grant select, insert on aliclik_webhook_events to service_role;

-- Segunda cerradura, además de los privilegios (reject_mutation() se define en
-- 0045_order_master.sql junto a order_events).
drop trigger if exists aliclik_webhook_events_immutable on aliclik_webhook_events;
create trigger aliclik_webhook_events_immutable
  before update or delete on aliclik_webhook_events
  for each row execute function public.reject_mutation();

comment on table aliclik_webhook_events is
  'Notificaciones de Aliclik, append-only. El payload es un disparador, no un hecho: el estado se relee de la API.';

-- ---- 0058 ----
-- ============================================================================
-- 0058_tanders.sql — Tanders como courier propio de Lima.
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
-- 0059_lead_queue_counts.sql — que abrir Leads deje de costar ocho recorridos
-- de la tabla.
--
-- QUÉ PASABA. Cada carga de /dashboard/leads (y cada refresco en vivo, que era
-- cada 30 s) lanzaba SIETE `count(*)` exactos sobre `leads` — uno por pestaña —
-- más el recorrido de la cola. Con ~2.500 leads por tienda eso es ocho pasadas
-- por lo mismo, en paralelo pero todas compitiendo por el mismo disco, cada
-- medio minuto y por cada asesora con la pestaña abierta. El panel se sentía
-- "reeeelento" sin que ninguna consulta fuera, por sí sola, lenta.
--
-- QUÉ HACE. `lead_queue_counts` calcula los siete conteos en UN solo recorrido
-- con `count(*) filter (...)`, y de paso devuelve la FIRMA de la cola
-- (`total` + `last_change`). La firma es lo que permite que el refresco en vivo
-- pregunte "¿cambió algo?" en una consulta barata en vez de recargar la página
-- entera cada 30 s cuando casi nunca hay nada nuevo.
--
-- Los filtros son copia EXACTA de los de lib/leads-access.ts, incluida la
-- semántica de `status <> 'yape_por_verificar'` (que en SQL, y en PostgREST,
-- deja fuera las filas con status NULL). Si divergen, las pestañas mienten.
--
-- `security invoker` (el valor por defecto, explícito aquí porque importa): la
-- función se ejecuta con los privilegios de quien llama, así que la RLS de
-- `leads` sigue aplicando y nadie cuenta leads de tiendas que no puede ver.
--
-- Los índices son para que ese único recorrido —y el orden de la cola— no
-- tengan que ordenar la tabla entera en memoria. Se crean sin CONCURRENTLY:
-- `leads` es de miles de filas, no de millones, y el bloqueo dura milisegundos.
--
-- Idempotente. No toca datos. Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Índices de la cola
-- ----------------------------------------------------------------------------

-- "Por llamar" ordena por needs_attention desc, last_interaction_at desc, id.
-- Sin este índice cada página del drenado re-ordenaba TODA la cola de la tienda.
-- El predicado parcial es el mismo `category in ('open','hot')` de la vista.
create index if not exists leads_queue_order_idx
  on leads (store_id, needs_attention desc, last_interaction_at desc, id)
  where category in ('open', 'hot');

-- "⚡ Atender ahora": needs_attention + handoff_at dentro de la ventana fresca.
create index if not exists leads_store_handoff_idx
  on leads (store_id, handoff_at desc)
  where needs_attention;

-- `status` participa en cuatro de los siete conteos (yape, sin llamar, y las dos
-- exclusiones), y no tenía índice propio por tienda.
create index if not exists leads_store_status_idx
  on leads (store_id, status);

-- ----------------------------------------------------------------------------
-- Conteos + firma en una sola consulta
-- ----------------------------------------------------------------------------

create or replace function public.lead_queue_counts(
  p_store_id       uuid,
  p_handoff_cutoff timestamptz,
  p_now            timestamptz
)
returns table (
  por_llamar   bigint,
  handoff      bigint,
  yape         bigint,
  seguimientos bigint,
  ganados      bigint,
  perdidos     bigint,
  sin_llamar   bigint,
  -- Firma de la cola: con estos dos el cliente sabe si merece la pena recargar.
  -- `total` capta altas y bajas; `last_change` (que mantiene el trigger
  -- `leads_touch`) capta cualquier edición de una fila existente.
  total        bigint,
  last_change  timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (
      where category in ('open', 'hot') and status <> 'yape_por_verificar'
    ),
    count(*) filter (
      where needs_attention and handoff_at >= p_handoff_cutoff
    ),
    count(*) filter (where status = 'yape_por_verificar'),
    count(*) filter (
      where next_followup_at is not null and next_followup_at <= p_now
    ),
    count(*) filter (where category = 'won'),
    count(*) filter (where category = 'lost'),
    count(*) filter (where category in ('open', 'hot') and status = 'nuevo'),
    count(*),
    max(updated_at)
  from public.leads
  where store_id = p_store_id;
$$;

comment on function public.lead_queue_counts(uuid, timestamptz, timestamptz) is
  'Los 7 conteos de las pestañas de Leads + la firma de la cola, en un solo recorrido. security invoker: la RLS de leads sigue mandando.';

-- Supabase concede EXECUTE a public por defecto en cada función nueva; se quita
-- y se concede solo a quien la necesita (mismo criterio que 0053).
revoke all on function public.lead_queue_counts(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.lead_queue_counts(uuid, timestamptz, timestamptz) to authenticated, service_role;

-- ---- 0060 ----
-- 0060 — Lo que Aliclik dice que va a cobrar en la puerta.
--
-- POR QUÉ. La primera guía creada por API quedó cobrando S/447 cuando la
-- clienta debía pagar S/298: los precios que mandábamos eran los de LISTA de
-- Shopify, sin descuentos. El fallo se descubrió a ojo, mirando una captura del
-- panel de Aliclik. Nada en el dashboard lo habría detectado.
--
-- `GET /integration/order` ya devuelve `total`, y el cron de reconciliación ya
-- lo consulta cada 20 minutos — pero lo tiraba a la basura y guardaba solo los
-- estados. Persistirlo convierte esa pasada en un detector permanente:
--
--   * cuadra lo que Aliclik cobrará contra el total real del pedido;
--   * pilla también las ediciones hechas A MANO en el panel de Aliclik, de las
--     que hoy el dashboard no se entera de nada.
--
-- Se guarda el dato crudo, sin interpretar. La regla de qué cuenta como
-- descuadre vive en `lib/aliclik-money.ts` (`collectAmountMismatch`), donde se
-- puede probar y cambiar sin tocar la base.

alter table shipments
  add column if not exists reported_collect_amount numeric;

comment on column shipments.reported_collect_amount is
  'Monto que Aliclik declara que cobrará en la entrega (GET /integration/order → total). '
  'Lo escribe el cron de reconciliación en cada pasada. Comparado con orders.total_amount '
  'delata guías creadas o editadas con el importe equivocado.';

-- Índice parcial: las consultas de descuadre solo miran las guías que ya tienen
-- monto reportado, que son una fracción del total de envíos.
create index if not exists shipments_collect_amount_idx
  on shipments (store_id, reported_collect_amount)
  where reported_collect_amount is not null;

-- ---- 0061 ----
-- ============================================================================
-- 0061_shalom_api.sql — crear guías de Shalom por API desde el Master.
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
-- DOS credenciales, en DOS sitios distintos y a propósito:
--   * la API key del wrapper (sk_…) es de la cuenta de Kapso y una sola sirve
--     para todas las tiendas ⇒ va en el entorno (SHALOM_API_KEY), no acá. Vence,
--     y renovarla no debe obligar a tocar la configuración de N tiendas.
--   * el email + password de pro.shalom.pe DEL CLIENTE identifican la cuenta que
--     emite la guía ⇒ van por tienda, acá, cifrados con AES-256-GCM. Pueden
--     repetirse entre tiendas: dos tiendas de la misma empresa suelen despachar
--     con la misma cuenta de Shalom.
--
-- Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

alter table stores
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
  --
  -- Es por tienda aunque el token sea de la CUENTA de Shalom: cuando dos tiendas
  -- comparten cuenta, la segunda reutiliza el token de la primera en vez de
  -- volver a pagar el login (ver connectShalomSession).
  add column if not exists shalom_session_token_enc   text,
  add column if not exists shalom_session_expires_at  timestamptz;

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

-- ---- 0062 ----
-- ============================================================================
-- 0062_tanders_tracking.sql — el código de guía de Tanders es el N° de
-- seguimiento, no su id interno.
--
-- La 0058 guardaba en `guide_code` el `id` que devuelve su API: un cuid
-- ("cms3ov8db00080mxdbvigryzy"). Pero ese identificador no aparece en ninguna
-- parte de la interfaz de Tanders ni lo conoce el cliente. Lo que su panel
-- muestra como "N° SEGUIMIENTO" —y lo único por lo que se puede buscar un
-- envío— es otro campo: `aliclikOrderNumber` ("TANDER17851846826402032").
--
-- El nombre del campo delata cómo funciona Tanders por dentro: sincroniza cada
-- pedido hacia Aliclik (`aliclikSyncStatus: "SYNCED"`) y adopta como número de
-- seguimiento el que genera en ese sistema.
--
-- Con el cuid en `guide_code`, buscar el envío en el Master por el número que
-- el equipo ve en Tanders no devolvía nada. El cuid sigue haciendo falta —es la
-- clave de `GET /orders/{id}`— así que se muda a su propia columna en vez de
-- perderse.
-- ============================================================================

alter table shipments
  add column if not exists tanders_order_id text;

comment on column shipments.tanders_order_id is
  'Id interno del pedido en Tanders (cuid). Clave para su API; el N° de seguimiento visible va en guide_code.';

-- Índice para resolver una guía desde su id de Tanders (consultas de estado).
create index if not exists shipments_tanders_order_idx
  on shipments(tanders_order_id) where tanders_order_id is not null;

-- ----------------------------------------------------------------------------
-- Corrección de las guías ya creadas con el cuid como código.
--
-- Solo se tocan las filas cuya respuesta cruda trae el número de seguimiento y
-- cuyo `guide_code` sigue siendo el cuid — así reaplicar esto no hace nada. El
-- índice único es (courier, guide_code): si el número ya lo lleva otra fila, esa
-- se deja como está y se revisa a mano, en vez de romper la migración.
-- ----------------------------------------------------------------------------

update shipments s
set tanders_order_id = s.guide_code,
    guide_code       = s.tanders_raw ->> 'aliclikOrderNumber'
where s.courier = 'tanders'
  and s.tanders_order_id is null
  and s.tanders_raw ->> 'aliclikOrderNumber' is not null
  and s.guide_code = s.tanders_raw ->> 'id'
  and not exists (
    select 1 from shipments other
    where other.courier = 'tanders'
      and other.guide_code = s.tanders_raw ->> 'aliclikOrderNumber'
      and other.id <> s.id
  );

-- `order_events` es append-only (0045): los movimientos ya escritos conservan el
-- cuid en su `guide_code`. Es correcto — son el registro de lo que pasó en ese
-- momento— y el envío se sigue encontrando por la fila de `shipments`.

-- ---- 0063 ----
-- ============================================================================
-- 0063_tanders_label.sql — cuándo se generó el rótulo de una guía Tanders.
--
-- Tanders no tiene endpoint de PDF: su panel arma el rótulo en el navegador.
-- Lo único que expone su API es `PATCH /orders/me/{id}/label {generated:true}`,
-- que enciende el "✓ Rótulo generado" de su interfaz.
--
-- Ese flag es el guardarraíl contra imprimir dos etiquetas del mismo paquete, y
-- solo sirve si los dos sistemas coinciden. Se guarda también acá para poder
-- avisar en el Master —"este rótulo ya se imprimió"— sin ir a preguntárselo a
-- su API en cada carga del listado.
--
-- `label_url` (0058) se queda: si algún día publican el PDF, ahí va.
-- ============================================================================

alter table shipments
  add column if not exists label_generated_at timestamptz;

comment on column shipments.label_generated_at is
  'Cuándo se compuso el rótulo de esta guía. Espeja el flag "generado" de Tanders.';

-- ---- 0064 ----
-- 0064 — Liquidaciones de motorizados.
--
-- El motorizado entrega pedidos contra reembolso y al final del día "liquida":
-- declara qué guías entregó y cuánta plata recaudó, y deposita lo cobrado. Hasta
-- ahora eso vivía en papel y en WhatsApp. Esta migración le da tres tablas.
--
-- Tres decisiones que gobiernan el diseño:
--
--   1. LO DECLARADO NO PISA LO REAL. `declared_*` es lo que dijo el motorizado;
--      el estado de la guía y el monto del pedido siguen viniendo del Master. El
--      cuadre COMPARA ambos y expone la diferencia; nunca sobrescribe el Master
--      con lo que diga una hoja. Un descuadre es información, no una corrección.
--
--   2. LO QUE NO SE PUEDE VINCULAR NO SE ADIVINA. Igual que en la ingesta de
--      reportes (0048), una línea que no encuentra su pedido queda en
--      `match_status = 'review'` y la resuelve una persona. Las liquidaciones
--      llegan en foto de cuaderno: adivinar aquí es inventar plata.
--
--   3. CERRAR ES IRREVERSIBLE POR DISEÑO. Una liquidación cerrada congela el
--      pago al motorizado (`payout_amount`). Si luego cambia una tarifa o se
--      corrige una guía, el número pagado ese día no se reescribe solo: se abre
--      otra liquidación de ajuste. Mismo principio de vigencia que 0050.

-- ----------------------------------------------------------------------------
-- Motorizados.
-- ----------------------------------------------------------------------------

create table if not exists riders (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  -- Nulo = trabaja para todas las tiendas de la organización.
  store_id       uuid references stores(id) on delete cascade,
  -- Courier al que pertenece, cuando viene de uno (Aliclik, Fenix…). Nulo = propio.
  courier        text,
  full_name      text not null,
  doc_number     text,
  phone          text,
  active         boolean not null default true,
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Un mismo DNI no puede estar dos veces en la organización: es lo que evita que
-- se dupliquen las liquidaciones de una persona escrita de dos maneras.
create unique index if not exists riders_doc_idx
  on riders(org_id, doc_number) where doc_number is not null;
create index if not exists riders_name_idx on riders(org_id, lower(full_name));

comment on table riders is
  'Motorizados que reparten contra reembolso y liquidan lo cobrado.';

-- ----------------------------------------------------------------------------
-- Liquidaciones.
-- ----------------------------------------------------------------------------

create table if not exists rider_settlements (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  store_id       uuid not null references stores(id) on delete cascade,
  -- Nulo mientras nadie haya confirmado de quién es la hoja: el nombre leído de
  -- la foto es una pista, no una identidad.
  rider_id       uuid references riders(id) on delete set null,
  rider_name_raw text,
  settlement_date date not null,
  -- De dónde salió: foto de cuaderno leída por visión, u hoja del courier.
  source         text not null check (source in ('foto', 'hoja', 'manual')),
  file_path      text,
  file_sha256    text,
  -- Lo que el motorizado DECLARA haber recaudado y depositado.
  declared_cash  numeric(12, 2) not null default 0,
  declared_yape  numeric(12, 2) not null default 0,
  status         text not null default 'borrador' check (status in (
                   'borrador',      -- recién subida, sin revisar
                   'cuadrada',      -- revisada y sin diferencias
                   'con_descuadre', -- revisada y con diferencias abiertas
                   'cerrada'        -- congelada, con el pago fijado
                 )),
  -- Lo que se le paga al motorizado por este día. Se congela al cerrar.
  payout_amount  numeric(12, 2),
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  closed_at      timestamptz,
  closed_by      uuid references auth.users(id) on delete set null,
  -- Cerrar exige haber fijado el pago: una liquidación cerrada sin número no
  -- sirve de nada y sería un agujero silencioso en el módulo de Costos.
  constraint rider_settlements_closed_has_payout
    check (status <> 'cerrada' or (payout_amount is not null and closed_at is not null))
);

-- Subir dos veces el mismo archivo es el error más común; se corta por hash.
create unique index if not exists rider_settlements_sha_idx
  on rider_settlements(org_id, file_sha256) where file_sha256 is not null;
create index if not exists rider_settlements_lookup_idx
  on rider_settlements(store_id, settlement_date desc);
create index if not exists rider_settlements_rider_idx
  on rider_settlements(rider_id, settlement_date desc);

comment on column rider_settlements.declared_cash is
  'Efectivo declarado por el motorizado. Lo real se compara contra el Master.';
comment on column rider_settlements.payout_amount is
  'Pago al motorizado, congelado al cerrar. No se recalcula si cambia la tarifa.';

-- ----------------------------------------------------------------------------
-- Líneas de la liquidación: una por guía declarada.
-- ----------------------------------------------------------------------------

create table if not exists rider_settlement_lines (
  id              uuid primary key default gen_random_uuid(),
  settlement_id   uuid not null references rider_settlements(id) on delete cascade,
  -- Nulo mientras no se vincule con un pedido real.
  order_id        uuid references orders(id) on delete set null,
  guide_code      text,
  order_name      text,
  -- Lo que dice la hoja, literal y normalizado.
  declared_status text,
  declared_amount numeric(12, 2),
  match_status    text not null default 'review' check (match_status in (
                    'ok',         -- vinculada a un pedido
                    'review',     -- no se pudo vincular: la resuelve una persona
                    'sin_pedido'  -- alguien decidió que no corresponde a ninguno
                  )),
  raw             jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists rider_settlement_lines_batch_idx
  on rider_settlement_lines(settlement_id);
create index if not exists rider_settlement_lines_order_idx
  on rider_settlement_lines(order_id) where order_id is not null;
-- La misma guía no puede declararse dos veces en la misma liquidación: sería
-- cobrar dos veces por una entrega.
create unique index if not exists rider_settlement_lines_guide_idx
  on rider_settlement_lines(settlement_id, lower(guide_code)) where guide_code is not null;

comment on column rider_settlement_lines.declared_amount is
  'Monto que el motorizado dice haber cobrado por esta guía.';

-- ----------------------------------------------------------------------------
-- Tarifas de pago al motorizado: se apoyan en cost_tariffs (0050), con su
-- vigencia y su especificidad ya probadas. Solo hay que abrir los conceptos.
-- ----------------------------------------------------------------------------

alter table cost_tariffs drop constraint if exists cost_tariffs_concept_check;
alter table cost_tariffs add constraint cost_tariffs_concept_check
  check (concept in (
    'primer_intento',
    'intento_adicional',
    'envio_agencia',
    'devolucion',
    'especial',
    -- Pago AL motorizado (0064). Son costos como cualquier otro: llevan fecha de
    -- vigencia y ámbito, así que viven en la misma tabla en vez de duplicar el
    -- motor de resolución.
    'motorizado_entrega',
    'motorizado_visita',
    'motorizado_devolucion'
  ));

-- ----------------------------------------------------------------------------
-- RLS. Lectura para quien ve la tienda; escritura para admins de la
-- organización. Las líneas heredan el permiso de su liquidación.
-- ----------------------------------------------------------------------------

alter table riders                 enable row level security;
alter table rider_settlements      enable row level security;
alter table rider_settlement_lines enable row level security;

drop policy if exists riders_select on riders;
create policy riders_select on riders for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists riders_write on riders;
create policy riders_write on riders for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists rider_settlements_select on rider_settlements;
create policy rider_settlements_select on rider_settlements for select to authenticated
  using (store_id in (select auth_store_ids()));
drop policy if exists rider_settlements_write on rider_settlements;
create policy rider_settlements_write on rider_settlements for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists rider_settlement_lines_select on rider_settlement_lines;
create policy rider_settlement_lines_select on rider_settlement_lines for select to authenticated
  using (settlement_id in (
    select id from rider_settlements where store_id in (select auth_store_ids())
  ));
drop policy if exists rider_settlement_lines_write on rider_settlement_lines;
create policy rider_settlement_lines_write on rider_settlement_lines for all to authenticated
  using (settlement_id in (
    select id from rider_settlements where org_id in (select auth_admin_org_ids())
  ))
  with check (settlement_id in (
    select id from rider_settlements where org_id in (select auth_admin_org_ids())
  ));

grant select on riders, rider_settlements, rider_settlement_lines to authenticated;
grant insert, update, delete on riders, rider_settlements, rider_settlement_lines to authenticated;
grant all privileges on riders, rider_settlements, rider_settlement_lines to service_role;

-- ---- 0065 ----
-- 0065 — La liquidación también trae la comisión del courier, y a veces no trae guía.
--
-- Con el primer reporte real en la mano (Axel Courier, Lima Metropolitana) salen
-- dos cosas que 0064 no previó:
--
--   1. LA HOJA DECLARA LO QUE EL COURIER SE QUEDA. La columna GANANCIA es la
--      tarifa que Axel cobra POR ENTREGA y que descuenta del depósito: cobran
--      S/ 2,219.73 y depositan S/ 2,073.73, quedándose S/ 146.00. Es un costo
--      logístico declarado fila a fila, así que se guarda fila a fila. Sin esto
--      el cuadre del depósito daría siempre un faltante igual a la comisión.
--
--   2. NO SIEMPRE HAY GUÍA. El reporte de Axel identifica cada entrega por
--      NOMBRE del cliente y DISTRITO, sin guía ni nº de pedido. Se guardan
--      ambos para poder emparejar por ahí y, sobre todo, para que la cola de
--      revisión muestre a un humano de quién es la fila que no se pudo vincular.
--      Un nombre no es un identificador: lo que empata por nombre y distrito
--      queda igual sujeto a revisión cuando hay más de un candidato.

alter table rider_settlement_lines
  add column if not exists declared_fee   numeric(12, 2),
  add column if not exists customer_name  text,
  add column if not exists district       text;

comment on column rider_settlement_lines.declared_fee is
  'Comisión que el courier declara cobrarse por esta entrega (columna GANANCIA). '
  'Se descuenta del depósito esperado; no es un pago al motorizado.';
comment on column rider_settlement_lines.customer_name is
  'Nombre del cliente tal como lo escribe el courier. Pista de emparejamiento '
  'cuando la hoja no trae guía ni nº de pedido, nunca un identificador.';

-- Emparejar por nombre dentro de la tienda es una búsqueda frecuente en cuanto
-- la hoja no trae guía; sin índice se convierte en un escaneo por liquidación.
create index if not exists rider_settlement_lines_name_idx
  on rider_settlement_lines(settlement_id, lower(customer_name))
  where customer_name is not null;

-- El courier de la liquidación: hasta ahora se deducía del motorizado, pero una
-- hoja como la de Axel es del COURIER entero, no de una persona.
alter table rider_settlements
  add column if not exists courier      text,
  add column if not exists pos_fee      numeric(12, 2) not null default 0;

comment on column rider_settlements.courier is
  'Courier que emite la liquidación (axel, aliclik…). Nulo = motorizado propio.';
comment on column rider_settlements.pos_fee is
  'Comisión de POS declarada aparte en la hoja (fila COMISION). Se descuenta '
  'del depósito esperado igual que las comisiones por entrega.';

-- ---- 0066 ----
-- 0066 — Rutas de reparto: el motorizado propio reporta desde su teléfono.
--
-- Hasta ahora la liquidación se RECONSTRUÍA a posteriori, leyendo una hoja o un
-- cuaderno (0064/0065). Con motorizados propios se puede hacer al revés: que la
-- entrega se declare en el momento y la liquidación caiga sola al cerrar el día.
-- La carga por archivo sigue viva para los couriers externos, que es donde no
-- hay más remedio.
--
-- Cuatro decisiones gobiernan el diseño:
--
--   1. EL MOTORIZADO ES UN USUARIO DE VERDAD, no un enlace con token. Entra con
--      el mismo correo y enlace mágico que el equipo, y `riders.user_id` lo ata
--      a su ficha. Así el acceso se revoca como cualquier otro y no hay una
--      segunda autenticación casera que mantener y auditar.
--
--   2. SOLO VE SUS PARADAS, y lo garantiza la base, no la interfaz. Las
--      políticas de abajo filtran por `riders.user_id = auth.uid()`: aunque
--      alguien manipule la petición, no existe una consulta que le devuelva la
--      ruta de otro.
--
--   3. LO QUE REPORTA ES UNA DECLARACIÓN, no la verdad. Escribe en la parada,
--      NO en el Master. El pedido lo sigue moviendo el flujo de siempre, y el
--      cuadre compara ambos — igual que con la hoja de un courier. Un motorizado
--      que marca "entregado" no cierra un pedido por su cuenta.
--
--   4. UNA PARADA REPORTADA NO SE BORRA. Se puede corregir, y cada corrección
--      queda con su autor y su hora. Es dinero: hace falta saber quién dijo qué.

-- ----------------------------------------------------------------------------
-- El motorizado entra al sistema.
-- ----------------------------------------------------------------------------

alter table memberships drop constraint if exists memberships_role_check;
alter table memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'viewer', 'vendedora', 'motorizado'));

-- Ata la ficha del motorizado (0064) con su usuario. Nulo = todavía no tiene
-- acceso a la web; se le da de alta y liquida igual.
alter table riders
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create unique index if not exists riders_user_idx
  on riders(user_id) where user_id is not null;

comment on column riders.user_id is
  'Usuario con el que entra a /reparto. Nulo = no reporta desde la web.';

-- ----------------------------------------------------------------------------
-- La ruta del día.
-- ----------------------------------------------------------------------------

create table if not exists delivery_routes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  store_id     uuid not null references stores(id) on delete cascade,
  rider_id     uuid not null references riders(id) on delete cascade,
  route_date   date not null,
  status       text not null default 'planificada' check (status in (
                 'planificada', -- se está armando; el motorizado aún no la ve
                 'en_curso',    -- entregada al motorizado, ya reporta
                 'cerrada'      -- terminó el día; generó su liquidación
               )),
  -- Liquidación que generó al cerrarse. Es el puente con 0064: la ruta cerrada
  -- no vuelve a calcularse, se convierte en una liquidación como cualquier otra.
  settlement_id uuid references rider_settlements(id) on delete set null,
  note         text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  started_at   timestamptz,
  closed_at    timestamptz,
  -- Un motorizado no puede tener dos rutas el mismo día en la misma tienda: si
  -- se le añaden paradas, se añaden a la que ya tiene.
  constraint delivery_routes_unique_day unique (store_id, rider_id, route_date)
);

create index if not exists delivery_routes_rider_idx
  on delivery_routes(rider_id, route_date desc);
create index if not exists delivery_routes_store_idx
  on delivery_routes(store_id, route_date desc);

-- ----------------------------------------------------------------------------
-- Las paradas: un pedido que hay que entregar.
-- ----------------------------------------------------------------------------

create table if not exists delivery_stops (
  id             uuid primary key default gen_random_uuid(),
  route_id       uuid not null references delivery_routes(id) on delete cascade,
  order_id       uuid not null references orders(id) on delete cascade,
  -- Orden en que se le muestran. No es una ruta optimizada: es el orden que el
  -- coordinador decide, y el motorizado puede saltárselo.
  seq            int not null default 0,
  status         text not null default 'pendiente' check (status in (
                   'pendiente',
                   'entregado',
                   'no_entregado'
                 )),
  /* Lo que el motorizado declara al reportar. */
  payment_method text check (payment_method in ('efectivo', 'yape', 'pos', 'sin_cobro')),
  collected_amount numeric(12, 2),
  -- Motivo cuando no entregó, del catálogo de la interfaz (no contestó,
  -- rechazó, dirección errada, reprogramado…).
  outcome_reason text,
  note           text,
  /* Respaldos en bucket privado. */
  photo_path     text,   -- foto de la entrega
  voucher_path   text,   -- captura del Yape, cuando cobró así
  reported_at    timestamptz,
  reported_by    uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- El mismo pedido no puede estar dos veces en la misma ruta.
  constraint delivery_stops_unique_order unique (route_id, order_id),
  -- Una parada entregada tiene que decir CÓMO se cobró. Sin esto, una entrega
  -- sin método de pago dejaría un agujero silencioso en la liquidación.
  constraint delivery_stops_delivered_has_method
    check (status <> 'entregado' or payment_method is not null),
  -- Y una parada reportada tiene que decir cuándo se reportó.
  constraint delivery_stops_reported_has_time
    check (status = 'pendiente' or reported_at is not null)
);

create index if not exists delivery_stops_route_idx on delivery_stops(route_id, seq);
create index if not exists delivery_stops_order_idx on delivery_stops(order_id);

comment on column delivery_stops.collected_amount is
  'Lo que el motorizado declara haber cobrado. NO toca el Master: el cuadre de '
  'la liquidación lo compara con el total del pedido.';

-- ----------------------------------------------------------------------------
-- Historial de reportes: una parada se corrige, no se reescribe en silencio.
-- ----------------------------------------------------------------------------

create table if not exists delivery_stop_events (
  id          uuid primary key default gen_random_uuid(),
  stop_id     uuid not null references delivery_stops(id) on delete cascade,
  status      text not null,
  payment_method text,
  collected_amount numeric(12, 2),
  outcome_reason text,
  note        text,
  occurred_at timestamptz not null default now(),
  actor       uuid references auth.users(id) on delete set null
);

create index if not exists delivery_stop_events_stop_idx
  on delivery_stop_events(stop_id, occurred_at desc);

comment on table delivery_stop_events is
  'Cada reporte de una parada, incluidas las correcciones. Append-only: es '
  'dinero, y hace falta saber quién dijo qué y cuándo.';

-- ----------------------------------------------------------------------------
-- La liquidación puede nacer de una ruta.
-- ----------------------------------------------------------------------------

alter table rider_settlements drop constraint if exists rider_settlements_source_check;
alter table rider_settlements add constraint rider_settlements_source_check
  check (source in ('foto', 'hoja', 'manual', 'ruta'));

-- ----------------------------------------------------------------------------
-- RLS.
--
-- Dos públicos con reglas distintas sobre las mismas tablas:
--   - el equipo (admin/coordinador) ve y arma las rutas de sus tiendas;
--   - el motorizado ve SOLO las suyas, y solo cuando ya se le entregaron
--     ('en_curso' o 'cerrada'): una ruta que aún se está armando no debe
--     aparecerle a medio hacer.
-- ----------------------------------------------------------------------------

alter table delivery_routes      enable row level security;
alter table delivery_stops       enable row level security;
alter table delivery_stop_events enable row level security;

-- ¿La ruta es de quien pregunta, como motorizado?
create or replace function public.auth_rider_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from riders where user_id = auth.uid() limit 1;
$$;

revoke all on function public.auth_rider_id() from public, anon;
grant execute on function public.auth_rider_id() to authenticated;

drop policy if exists delivery_routes_select on delivery_routes;
create policy delivery_routes_select on delivery_routes for select to authenticated
  using (
    store_id in (select auth_store_ids())
    or (rider_id = auth_rider_id() and status in ('en_curso', 'cerrada'))
  );

drop policy if exists delivery_routes_write on delivery_routes;
create policy delivery_routes_write on delivery_routes for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists delivery_stops_select on delivery_stops;
create policy delivery_stops_select on delivery_stops for select to authenticated
  using (
    route_id in (
      select id from delivery_routes
       where store_id in (select auth_store_ids())
          or (rider_id = auth_rider_id() and status in ('en_curso', 'cerrada'))
    )
  );

-- El motorizado SÍ escribe, pero solo en las paradas de SU ruta en curso. No
-- puede crear paradas ni borrarlas: eso es armar la ruta, y no es suyo.
drop policy if exists delivery_stops_report on delivery_stops;
create policy delivery_stops_report on delivery_stops for update to authenticated
  using (
    route_id in (
      select id from delivery_routes
       where rider_id = auth_rider_id() and status = 'en_curso'
    )
  )
  with check (
    route_id in (
      select id from delivery_routes
       where rider_id = auth_rider_id() and status = 'en_curso'
    )
  );

drop policy if exists delivery_stops_write on delivery_stops;
create policy delivery_stops_write on delivery_stops for all to authenticated
  using (
    route_id in (
      select id from delivery_routes where org_id in (select auth_admin_org_ids())
    )
  )
  with check (
    route_id in (
      select id from delivery_routes where org_id in (select auth_admin_org_ids())
    )
  );

drop policy if exists delivery_stop_events_select on delivery_stop_events;
create policy delivery_stop_events_select on delivery_stop_events for select to authenticated
  using (
    stop_id in (
      select s.id from delivery_stops s join delivery_routes r on r.id = s.route_id
       where r.store_id in (select auth_store_ids())
          or (r.rider_id = auth_rider_id() and r.status in ('en_curso', 'cerrada'))
    )
  );

drop policy if exists delivery_stop_events_insert on delivery_stop_events;
create policy delivery_stop_events_insert on delivery_stop_events for insert to authenticated
  with check (
    stop_id in (
      select s.id from delivery_stops s join delivery_routes r on r.id = s.route_id
       where r.org_id in (select auth_admin_org_ids())
          or (r.rider_id = auth_rider_id() and r.status = 'en_curso')
    )
  );

-- El historial no se corrige: es el registro de las correcciones.
drop policy if exists delivery_stop_events_immutable on delivery_stop_events;
create policy delivery_stop_events_immutable on delivery_stop_events for update to authenticated
  using (false);

-- El motorizado necesita leer su propia ficha para que la app sepa quién es.
drop policy if exists riders_select on riders;
create policy riders_select on riders for select to authenticated
  using (org_id in (select auth_org_ids()) or user_id = auth.uid());

grant select on delivery_routes, delivery_stops, delivery_stop_events to authenticated;
grant insert, update, delete on delivery_routes, delivery_stops to authenticated;
grant insert on delivery_stop_events to authenticated;
grant all privileges on delivery_routes, delivery_stops, delivery_stop_events to service_role;

-- ---- 0067 ----
-- 0067 — La ruta deja de ser de una tienda, y cerrarla mueve el Master.
--
-- Dos correcciones a 0066, ambas descubiertas al contrastar el diseño con cómo
-- se reparte de verdad:
--
--   1. UN MOTORIZADO MEZCLA TIENDAS EN LA MISMA VUELTA. Sale con paquetes de
--      Aurela y de Kenku a la vez. Con una ruta por tienda habría que armarle
--      dos y él vería dos listas para un solo viaje — inservible. La ruta pasa a
--      ser del MOTORIZADO y del DÍA; la tienda vive en cada parada, que es donde
--      de verdad está (viene del pedido).
--
--      La liquidación sigue siendo POR TIENDA, porque el dinero y el cuadre lo
--      son: cerrar una ruta mixta produce una liquidación por cada tienda que
--      aparezca en sus paradas. Un viaje, varias cuentas.
--
--   2. NADIE MOVÍA EL MASTER. Con un courier externo el estado real lo trae su
--      reporte; con motorizado propio no viene nadie detrás. Tal como estaba,
--      un pedido entregado por un motorizado propio se quedaba "pendiente" para
--      siempre y el cuadre lo marcaba como "cobro sin entrega" — en TODAS sus
--      paradas. Al cerrar la ruta, las entregas confirmadas pasan al Master por
--      el camino de siempre (`order_events`), con un humano revisando antes.

-- ----------------------------------------------------------------------------
-- La ruta es del motorizado y del día, no de la tienda.
-- ----------------------------------------------------------------------------

alter table delivery_routes drop constraint if exists delivery_routes_unique_day;
alter table delivery_routes alter column store_id drop not null;

comment on column delivery_routes.store_id is
  'Tienda principal, solo informativa. Una ruta puede mezclar tiendas: la de '
  'cada entrega vive en delivery_stops.store_id.';

-- Un motorizado tiene UNA ruta por día, mezcle lo que mezcle.
create unique index if not exists delivery_routes_rider_day_idx
  on delivery_routes(org_id, rider_id, route_date);

-- ----------------------------------------------------------------------------
-- La tienda vive en la parada.
-- ----------------------------------------------------------------------------

alter table delivery_stops
  add column if not exists store_id uuid references stores(id) on delete cascade;

-- Relleno de lo que ya hubiera: la tienda de la parada es la del pedido.
update delivery_stops s
   set store_id = o.store_id
  from orders o
 where o.id = s.order_id and s.store_id is null;

create index if not exists delivery_stops_store_idx on delivery_stops(store_id);

comment on column delivery_stops.store_id is
  'Tienda del pedido. Es lo que agrupa las liquidaciones al cerrar una ruta '
  'mixta, y lo que filtran las políticas de lectura.';

-- ----------------------------------------------------------------------------
-- Una ruta produce VARIAS liquidaciones (una por tienda), así que el vínculo
-- vive en la liquidación y no en la ruta.
-- ----------------------------------------------------------------------------

alter table rider_settlements
  add column if not exists route_id uuid references delivery_routes(id) on delete set null;

create index if not exists rider_settlements_route_idx
  on rider_settlements(route_id) where route_id is not null;

-- Se conserva `delivery_routes.settlement_id` de 0066 por compatibilidad, pero
-- deja de ser la fuente: con rutas mixtas no hay UNA liquidación que apuntar.
comment on column delivery_routes.settlement_id is
  'OBSOLETO desde 0067: una ruta mixta genera varias liquidaciones. Usa '
  'rider_settlements.route_id.';

-- ----------------------------------------------------------------------------
-- RLS: las paradas se filtran por SU tienda, no por la de la ruta.
-- ----------------------------------------------------------------------------

drop policy if exists delivery_routes_select on delivery_routes;
create policy delivery_routes_select on delivery_routes for select to authenticated
  using (
    org_id in (select auth_org_ids())
    or (rider_id = auth_rider_id() and status in ('en_curso', 'cerrada'))
  );

drop policy if exists delivery_stops_select on delivery_stops;
create policy delivery_stops_select on delivery_stops for select to authenticated
  using (
    store_id in (select auth_store_ids())
    or route_id in (
      select id from delivery_routes
       where rider_id = auth_rider_id() and status in ('en_curso', 'cerrada')
    )
  );

-- ---- 0068 ----
-- 0068 — Separar lo cobrado que NO pasa por las manos de quien liquida.
--
-- El Yape del cliente cae a la cuenta de la empresa (Grupo GF SAC), y el POS lo
-- cobra el terminal: ninguna de las dos es plata que el motorizado tenga que
-- devolver. Yo las estaba sumando a lo que debía depositar, así que su cuadre
-- habría salido corto TODOS los días por el importe exacto de lo que cobró por
-- esos canales — un descuadre inventado que le habría costado explicaciones a
-- alguien que no hizo nada malo.
--
-- La confusión venía de mezclar dos preguntas distintas en los mismos campos:
--
--   `declared_cash` / `declared_yape`  →  CÓMO DEPOSITA lo que debe.
--   `direct_collected` (esta columna)  →  QUÉ COBRÓ QUE YA ESTÁ EN CASA.
--
-- Con las dos separadas, las dos formas de trabajar cuadran con la misma regla:
--
--   Axel cobra todo en la calle y deposita por transferencia:
--     cobrado 2,219.73 − comisión 146.00 − directo 0 = deposita 2,073.73 ✓
--
--   Un motorizado propio cobra 1,000 en efectivo, 200 por Yape a la empresa y
--   100 por POS:
--     cobrado 1,300 − comisión 0 − directo 300 = entrega 1,000 en la mano ✓

alter table rider_settlements
  add column if not exists direct_collected numeric(12, 2) not null default 0;

comment on column rider_settlements.direct_collected is
  'Cobrado que fue DIRECTO a la empresa (Yape a la cuenta, POS) y por tanto '
  'nunca pasó por las manos de quien liquida. Se descuenta de lo que debe '
  'depositar; no es un descuadre.';

-- ---- 0069 ----
-- 0069 — Buscar en el Master deja de escanear la tabla entera.
--
-- La búsqueda usa `ilike '%texto%'`: con el comodín al principio NINGÚN índice
-- corriente sirve, así que Postgres leía las 10.000 filas y descartaba 10.327
-- para devolver 11. Medido: 42 ms de escaneo, en cada tecla.
--
-- Los índices de trigramas sí indexan subcadenas —parten cada texto en grupos de
-- tres letras—, que es justo lo que hace falta para un "contiene". La misma
-- consulta pasó a 0,46 ms, y ahora el coste ya no crece con cada pedido nuevo.
-- Necesitan al menos 3 caracteres para aprovecharse.

create extension if not exists pg_trgm;

create index if not exists order_master_search_name_idx
  on order_master using gin (order_name gin_trgm_ops);
create index if not exists order_master_search_customer_idx
  on order_master using gin (customer_name gin_trgm_ops);
create index if not exists order_master_search_phone_idx
  on order_master using gin (customer_phone gin_trgm_ops);
create index if not exists order_master_search_guide_idx
  on order_master using gin (guide_code gin_trgm_ops);

analyze order_master;

-- ---- 0070 ----
-- 0070 — De dónde salió cada tarifa logística.
--
-- POR QUÉ. El cron de tarifas de Aliclik cotiza cada distrito y escribe lo que
-- ALIDRIVER cobra allí. Sin marcar la procedencia, esas filas y las que pone una
-- persona a mano son indistinguibles, y `resolveTariff` desempata por
-- `effective_from`: la más reciente gana. Como el cron corre a diario, SIEMPRE
-- ganaría — y pisaría en silencio cualquier acuerdo que el equipo hubiera
-- registrado. Una tarifa negociada tiene que sobrevivir al robot.
--
-- Con esta columna el cron solo mira y toca lo suyo (`source='aliclik'`), y
-- deja intacto lo de `source='manual'`. Es el mismo criterio que ya usa
-- `aliclik_sku_map.source` para no pisar los mapeos hechos a mano.

alter table cost_tariffs
  add column if not exists source text not null default 'manual';

comment on column cost_tariffs.source is
  'manual = la puso una persona y nada automático la toca. aliclik = la escribió el '
  'cron cotizando GET /integration/order/shipping/cost para ese distrito.';

-- El cron busca sus propias filas vigentes por ámbito en cada pasada.
create index if not exists cost_tariffs_source_idx
  on cost_tariffs (org_id, source, concept, district)
  where effective_to is null;

-- ----------------------------------------------------------------------------
-- Qué distritos cotizar en la próxima pasada
-- ----------------------------------------------------------------------------

-- Un punto representativo por distrito, tomado de un pedido REAL que espera.
--
-- Va en SQL y no en la aplicación porque el conjunto de partida son ~6.600
-- pedidos: agrupar eso en el servidor significa traérselos todos por la red para
-- quedarse con 60 filas. Aquí se resuelve con un índice y devuelve solo lo justo.
--
-- El orden decide qué se cotiza primero y por qué:
--   1. lo que NUNCA se ha cotizado, para ir cubriendo el mapa;
--   2. dentro de eso, los distritos con más pedidos esperando, que son los que
--      más mueven el margen;
--   3. lo ya cotizado va al final y por antigüedad, para que los precios viejos
--      se refresquen sin bloquear a los que aún no tienen tarifa.
create or replace function aliclik_tariff_probes(p_store_id uuid, p_limit int)
returns table (district text, lat double precision, lng double precision, pending bigint)
language sql
stable
security definer
set search_path = public
as $$
  with pend as (
    select om.district,
           om.latitude,
           om.longitude,
           row_number() over (partition by om.district order by om.order_created_at desc) as rn,
           count(*) over (partition by om.district) as pending
    from order_master om
    where om.store_id = p_store_id
      and om.guide_code is null
      and om.general_status in ('pendiente', 'en_proceso')
      and om.district is not null
      and om.latitude is not null
      and om.longitude is not null
  ),
  quoted as (
    select lower(btrim(t.district)) as district, max(t.effective_from) as last_quoted
    from cost_tariffs t
    where t.source = 'aliclik' and t.district is not null
    group by 1
  )
  select p.district, p.latitude, p.longitude, p.pending
  from pend p
  left join quoted q on q.district = lower(btrim(p.district))
  where p.rn = 1
  order by (q.last_quoted is not null), q.last_quoted asc nulls first, p.pending desc
  limit p_limit;
$$;

revoke all on function aliclik_tariff_probes(uuid, int) from public, anon, authenticated;

-- ---- 0071 ----
-- Manual ad -> promoted product mapping. This keeps product attribution useful
-- before Meta Marketing API is connected and remains the auditable override
-- afterwards.
alter table public.meta_ads
  add column if not exists promoted_product_name text,
  add column if not exists promoted_skus text[] not null default '{}',
  add column if not exists promoted_product_updated_at timestamptz;

-- ---- 0072 ----
-- 0062 — Tarifas derivadas de los reportes Excel ya importados.
--
-- POR QUÉ ESTA FUENTE Y NO LA COTIZACIÓN. El Excel de Aliclik guarda la fila
-- completa en `import_rows.raw`, y ahí viene `COSTO ENTREGA`: lo que REALMENTE
-- costó ese envío. Es mejor dato que una cotización —es el cobro, no la
-- estimación—, cubre 80 distritos de golpe en vez de 60 por día, trae
-- `intento_adicional` (que su API no devuelve) y no depende de que Aliclik
-- responda: el día que se escribió esto llevaban 45 minutos devolviendo 500.
--
-- LA CLAVE QUE COSTÓ ENTENDER: `COSTO ENTREGA` NO es una tarifa, es el costo
-- REALIZADO, y depende del desenlace del envío. El mismo distrito el mismo día
-- tiene dos importes — Trujillo el 05/07 cobró S/16,50 en los 57 ENTREGADO y
-- S/9,50 en los 12 CANCELADO. Encaja con lo que su API cotiza ("Entrega S/16,50
-- · No entregado S/10,50"). Por eso cada estado alimenta un concepto distinto y
-- NO se promedian entre sí: hacerlo daba 89 de 103 distritos con "varios
-- precios" y parecía ruido cuando era señal.
--
-- Se toma la MODA y no la media: los precios se revisan (Arequipa pasó de
-- S/15,50 en junio a S/16,50 en julio) y una media entre la vieja y la nueva
-- daría un número que nunca se cobró.
create or replace function aliclik_tariffs_from_reports(p_days int default 30)
returns table (org_id uuid, district text, concept text, amount numeric, samples bigint)
language sql
stable
security definer
set search_path = public
as $$
  with filas as (
    select st.org_id,
           btrim(r.raw->>'DISTRITO')                                as district,
           upper(btrim(r.raw->>'ESTADO ENTREGA'))                   as estado,
           nullif(btrim(r.raw->>'COSTO ENTREGA'), '')::numeric      as costo,
           nullif(btrim(r.raw->>'COSTO ENTREGA ADICIONAL'), '')::numeric as adicional,
           to_timestamp(btrim(r.raw->>'FECHA CREACIÓN ALICLIK'), 'DD/MM/YYYY HH24:MI:SS') as creado
    from import_rows r
    join stores st on st.id = r.store_id
    where r.raw ? 'COSTO ENTREGA'
      and nullif(btrim(r.raw->>'DISTRITO'), '') is not null
  ),
  reciente as (
    select * from filas
    where creado is not null
      and creado >= now() - make_interval(days => p_days)
  ),
  observaciones as (
    -- Entregado: es la tarifa de la entrega efectiva.
    select org_id, district, 'primer_intento' as concept, costo as amount
    from reciente where estado = 'ENTREGADO' and costo > 0
    union all
    -- No entregado TERMINAL: es lo que cuesta el retorno. Se excluyen los
    -- estados en curso (POR ENTREGAR, NO CONTESTA, REPROGRAMADO): todavía
    -- pueden acabar entregados y su costo actual no es el definitivo.
    select org_id, district, 'devolucion', costo
    from reciente where estado in ('CANCELADO', 'RECHAZADO', 'ANULADO') and costo > 0
    union all
    -- Reintento: solo se cobra cuando hubo más de una visita, así que las filas
    -- con adicional en cero no dicen nada y no cuentan como muestra.
    select org_id, district, 'intento_adicional', adicional
    from reciente where adicional > 0
  )
  select o.org_id,
         o.district,
         o.concept,
         mode() within group (order by o.amount) as amount,
         count(*) as samples
  from observaciones o
  group by o.org_id, o.district, o.concept
  -- Una sola observación puede ser un caso raro; con tres ya hay señal.
  having count(*) >= 3;
$$;

revoke all on function aliclik_tariffs_from_reports(int) from public, anon, authenticated;

-- ---- 0073 ----
-- ============================================================================
-- 0073_shalom_order_draft.sql — adelantar el destinatario y la agencia de Shalom.
--
-- QUÉ PROBLEMA RESUELVE. Crear la guía de Shalom exige dos datos que el pedido
-- de Shopify NO trae: el DOCUMENTO del destinatario (Shopify no pide DNI) y la
-- AGENCIA de destino. Hoy los escribe quien crea la guía, en ese momento, y a
-- menudo es una persona distinta de la que habló con la clienta — que es
-- justamente quien tiene el DNI a mano, porque acaba de pedírselo para el Yape.
--
-- Así que se pueden dejar apuntados ANTES, al registrar el pago, de forma
-- OPCIONAL: no condicionan el pago —bloquear un cobro por falta de un DNI sería
-- peor que el problema que resuelve— pero si están, quien luego crea la guía ya
-- los encuentra puestos y solo tiene que cotizar y crear.
--
-- POR QUÉ UNA TABLA Y NO COLUMNAS EN `orders`. `orders` es el espejo de Shopify:
-- lo que hay ahí viene de Shopify y se sobrescribe con cada sincronización. Esto
-- es una nota operativa nuestra sobre un pedido, no un dato del pedido.
--
-- POR QUÉ NO EN `shipments`. Porque el envío todavía no existe: el sentido de
-- esta tabla es apuntar los datos antes de que haya guía.
-- ============================================================================

create table if not exists shalom_order_drafts (
  order_id                uuid primary key references orders(id) on delete cascade,
  store_id                uuid not null references stores(id) on delete cascade,

  -- Destinatario. El tipo por defecto es DNI porque es el 99% de los casos.
  document_type           text check (document_type in ('DNI', 'RUC', 'CE')),
  document                text,

  -- Agencia de destino. Se guarda también el nombre: el id no dice nada al
  -- leerlo, y sin el nombre habría que ir a la API solo para pintar la pantalla.
  destiny_terminal_id     bigint,
  destiny_terminal_name   text,

  updated_by              uuid references auth.users(id) on delete set null,
  updated_at              timestamptz not null default now()
);

comment on table shalom_order_drafts is
  'Datos de Shalom apuntados por adelantado (documento del destinatario, agencia de destino) para que quien cree la guía no tenga que buscarlos. Opcionales: no bloquean nada.';

-- No lleva índice por `store_id`: se lee siempre por `order_id`, que es la clave
-- primaria, y la tabla tiene como mucho una fila por pedido.

alter table shalom_order_drafts enable row level security;

-- Misma postura que `order_payments` (0049): se LEE si tienes acceso a la
-- tienda, y se ESCRIBE solo desde el servidor con el rol de servicio, después de
-- comprobar permisos. Aquí no hay secreto que proteger —el documento del
-- destinatario lo ve cualquiera que lea el pedido— pero escribir por el cliente
-- saltaría la comprobación de permisos, y no hay razón para abrir esa puerta.
-- La clave de recojo, que sí es secreta, vive aparte en `shalom_pickup_keys` y
-- sigue siendo ilegible incluso para un administrador (0049 + 0053).
drop policy if exists shalom_order_drafts_select on shalom_order_drafts;
create policy shalom_order_drafts_select on shalom_order_drafts
  for select to authenticated
  using (store_id in (select auth_store_ids()));

-- Se revoca también a `authenticated`, no solo a `anon`: Supabase concede ALL a
-- ese rol en cada tabla nueva del esquema public, así que sin este revoke la
-- tabla nacería con permiso de escritura para cualquier usuario logueado. RLS lo
-- taparía —no hay policy de insert— pero el privilegio sobra igual, y es el
-- mismo criterio de 0053.
revoke all on shalom_order_drafts from public, anon, authenticated;
grant select on shalom_order_drafts to authenticated;
grant all privileges on shalom_order_drafts to service_role;

-- ---- 0074 ----
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

-- ---- 0075 ----
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

-- ---- 0076 ----
-- 0076_payment_total.sql — permite registrar un único comprobante por el total
-- del pedido, como alternativa al flujo adelanto + diferencia.

alter table order_payments
  drop constraint if exists order_payments_kind_check;

alter table order_payments
  add constraint order_payments_kind_check
  check (kind in ('adelanto', 'diferencia', 'total'));

comment on column order_payments.kind is
  'Tipo de pago: adelanto y diferencia forman un flujo parcial; total cancela el pedido en un solo comprobante.';

-- ---- 0077 ----
-- 0077 — Cotejo multitienda de liquidaciones.
--
-- Axel no entrega guía ni código de pedido. Sí entrega la tienda (CLIENTE) y,
-- cuando hubo entrega, la forma de pago. Se conservan como columnas auditables
-- para que el cotejo nunca mezcle Aurela con Kenku y para que el resultado
-- financiero pueda revisarse sin volver a abrir el Excel original.

alter table rider_settlement_lines
  add column if not exists store_hint text,
  add column if not exists payment_method text;

comment on column rider_settlement_lines.store_hint is
  'Tienda declarada por la fila del courier; limita el cotejo automático.';

comment on column rider_settlement_lines.payment_method is
  'Forma de pago declarada por el courier para una entrega (efectivo, POS, transferencia…).';

-- ---- 0078 ----
-- 0078 — Clasificación operativa de cobertura en el Master de Pedidos.
--
-- Lima significa únicamente Lima Metropolitana y Callao. Las provincias del
-- departamento de Lima (Huaral, Cañete, Barranca, etc.) siguen la misma regla
-- que el resto del país: Provincia COD si una tarifa vigente demuestra
-- cobertura contraentrega; Agencia en caso contrario.

alter table order_master
  add column if not exists coverage text;

alter table order_master drop constraint if exists order_master_coverage_check;
alter table order_master
  add constraint order_master_coverage_check
  check (coverage in ('lima', 'provincia_cod', 'agencia', 'por_revisar'));

create index if not exists order_master_store_coverage_idx
  on order_master(store_id, coverage);

create or replace function coverage_norm(value text)
returns text
language sql
immutable
parallel safe
as $$
  select trim(regexp_replace(
    translate(lower(coalesce(value, '')), 'áéíóúüñ', 'aeiouun'),
    '[^a-z0-9]+', ' ', 'g'
  ));
$$;

create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_day date default current_date
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_region text := coverage_norm(p_region);
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
begin
  if v_region = '' or v_province = '' or v_district = '' then
    return 'por_revisar';
  end if;

  if (
    v_region = 'lima'
    and v_province = any(array['lima', 'lima metropolitana'])
    and v_district = any(array[
      'ancon','ate','barranco','brena','carabayllo','chaclacayo','chorrillos',
      'cieneguilla','comas','el agustino','independencia','jesus maria',
      'la molina','la victoria','lima','lince','los olivos','lurigancho','lurigancho chosica',
      'lurin','magdalena del mar','miraflores','pachacamac','pucusana',
      'pueblo libre','puente piedra','punta hermosa','punta negra','rimac',
      'san bartolo','san borja','san isidro','san juan de lurigancho',
      'san juan de miraflores','san luis','san martin de porres','san miguel',
      'santa anita','santa maria del mar','santa rosa','santiago de surco',
      'surquillo','villa el salvador','villa maria del triunfo'
    ])
  ) or (
    (v_region like '%callao%' or v_province like '%callao%')
    and v_district = any(array[
      'bellavista','callao','carmen de la legua reynoso','la perla','la punta',
      'mi peru','ventanilla'
    ])
  ) then
    return 'lima';
  end if;

  select org_id into v_org_id from stores where id = p_store_id;

  if exists (
    select 1
    from cost_tariffs t
    where t.org_id = v_org_id
      and t.concept = 'primer_intento'
      and t.courier is not null
      and coverage_norm(t.courier) not in ('shalom', 'olva', 'olva courier')
      and (t.region is not null or t.province is not null or t.district is not null)
      and t.effective_from <= p_day
      and (t.effective_to is null or t.effective_to >= p_day)
      and (t.store_id is null or t.store_id = p_store_id)
      and (t.region is null or coverage_norm(t.region) = v_region)
      and (t.province is null or coverage_norm(t.province) = v_province)
      and (t.district is null or coverage_norm(t.district) = v_district)
  ) then
    return 'provincia_cod';
  end if;

  return 'agencia';
end;
$$;

create or replace function refresh_order_coverage(p_org_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update order_master om
  set coverage = order_coverage_for(
    om.store_id, om.region, om.province, om.district, current_date
  )
  where p_org_id is null
     or exists (
       select 1 from stores s
       where s.id = om.store_id and s.org_id = p_org_id
     );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function order_coverage_for(uuid, text, text, text, date)
  from public, anon, authenticated;
revoke all on function refresh_order_coverage(uuid)
  from public, anon, authenticated;
grant execute on function order_coverage_for(uuid, text, text, text, date)
  to service_role;
grant execute on function refresh_order_coverage(uuid)
  to service_role;

-- Autocompletado conservador: solo tienda + teléfono con un único antecedente
-- geográfico y al menos dos pedidos coincidentes, o una corrección manual.
with eligible as (
  select
    store_id,
    customer_phone,
    min(region) as region,
    min(province) as province,
    min(district) as district
  from order_master
  where customer_phone is not null
    and region is not null
    and province is not null
    and district is not null
  group by store_id, customer_phone
  having count(distinct (
    coverage_norm(region) || '|' ||
    coverage_norm(province) || '|' ||
    coverage_norm(district)
  )) = 1
  and (count(*) >= 2 or bool_or(geo_source = 'manual'))
)
update order_master om
set
  region = coalesce(om.region, e.region),
  province = coalesce(om.province, e.province),
  district = coalesce(om.district, e.district),
  geo_source = case
    when om.region is null or om.province is null or om.district is null
      then 'history'
    else om.geo_source
  end
from eligible e
where om.store_id = e.store_id
  and om.customer_phone = e.customer_phone
  and (om.region is null or om.province is null or om.district is null);

select refresh_order_coverage(null);

-- Facetas del Master, ahora también con cobertura.
create or replace function master_facets(p_store_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'operational', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct operational_status as v
        from order_master where store_id = any(p_store_ids) and operational_status is not null
      ) q
    ), '[]'::jsonb),
    'courier', coalesce((
      select jsonb_agg(v order by v) from (
        select current_courier as v from order_master
        where store_id = any(p_store_ids) and current_courier is not null
        union
        select last_courier as v from order_master
        where store_id = any(p_store_ids) and last_courier is not null
      ) q
    ), '[]'::jsonb),
    'region', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct region as v from order_master
        where store_id = any(p_store_ids) and region is not null
      ) q
    ), '[]'::jsonb),
    'province', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct province as v from order_master
        where store_id = any(p_store_ids) and province is not null
      ) q
    ), '[]'::jsonb),
    'district', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct district as v from order_master
        where store_id = any(p_store_ids) and district is not null
      ) q
    ), '[]'::jsonb),
    'coverage', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct coverage as v from order_master
        where store_id = any(p_store_ids) and coverage is not null
      ) q
    ), '[]'::jsonb),
    'pickup', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct pickup_state as v from order_master
        where store_id = any(p_store_ids) and pickup_state is not null
      ) q
    ), '[]'::jsonb)
  );
$$;

grant execute on function master_facets(uuid[]) to authenticated;

-- ---- 0079 ----
-- 0079 — La cobertura se decide por REGIÓN, no por provincia.
--
-- Qué estaba mal en la 0078:
--
--   1. Perú tiene DOS subdivisiones llamadas Lima y Shopify manda su nombre
--      completo: "Lima (provincia)" (PE-LMA, = Lima Metropolitana) y
--      "Lima (departamento)" (PE-LIM, = Huaral, Cañete, Yauyos, Barranca…).
--      `coverage_norm` las deja en 'lima provincia' y 'lima departamento', y la
--      regla exigía region = 'lima' exacto: NINGÚN pedido de Lima podía salir
--      clasificado como Lima. Un pedido Lima (provincia) / Lima / San Isidro
--      terminaba en "Provincia COD".
--
--   2. Exigir las tres columnas mandaba a "Por revisar" pedidos que ya se
--      sabían: Shopify Perú solo entrega distrito (city) y departamento
--      (province). La provincia del ubigeo se completa desde `peru_districts`,
--      que está sembrada solo con lo que dejaron los Excels de Aliclik, así que
--      para media Lima Metropolitana está vacía → Pueblo Libre y Chorrillos con
--      región "Lima (provincia)" quedaban Por revisar.
--
--   3. `peru_districts` tiene el nombre del distrito como clave primaria, pero
--      en Perú los nombres se repiten entre departamentos: Independencia existe
--      en Lima, en Huaraz (Áncash) y en Pisco (Ica). El backfill se queda con
--      la provincia más frecuente, así que a un pedido de Independencia con
--      región "Lima (provincia)" le pegaba provincia "Huaraz" y lo clasificaba
--      Provincia COD contradiciendo su propia región.
--
-- Regla nueva, en orden de fiabilidad: región → provincia → distrito. La
-- provincia deja de ser requisito; solo desempata cuando la región dice "Lima"
-- a secas. "Por revisar" queda para lo que de verdad no se puede ubicar: sin
-- región utilizable y sin distrito.

-- Clasifica la región respecto de Lima:
--   'metropolitana' | 'callao' | 'departamento' | 'lima' (ambigua) | null
create or replace function lima_region_kind(p_region text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when coverage_norm(p_region) = '' then null
    when coverage_norm(p_region) in ('cal', 'pe cal') then 'callao'
    when coverage_norm(p_region) in ('lma', 'pe lma') then 'metropolitana'
    when coverage_norm(p_region) in ('lim', 'pe lim') then 'departamento'
    when coverage_norm(p_region) like '%callao%' then 'callao'
    when coverage_norm(p_region) not like '%lima%' then null
    when coverage_norm(p_region) like '%provincia%'
      or coverage_norm(p_region) like '%metropolitan%' then 'metropolitana'
    when coverage_norm(p_region) like '%departamento%'
      or coverage_norm(p_region) like '%depto%'
      or coverage_norm(p_region) like '%dpto%'
      or coverage_norm(p_region) like '%region%' then 'departamento'
    else 'lima'
  end;
$$;

create or replace function is_lima_metropolitana(
  p_region text,
  p_province text,
  p_district text
)
returns boolean
language plpgsql
immutable
parallel safe
as $$
declare
  v_kind text := lima_region_kind(p_region);
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
  v_in_lima boolean;
begin
  if v_kind in ('metropolitana', 'callao') then
    return true;
  end if;
  if v_kind = 'departamento' then
    return false;
  end if;

  v_in_lima := v_district = any(array[
    -- Lima Metropolitana (43 distritos)
    'ancon','ate','barranco','brena','carabayllo','chaclacayo','chorrillos',
    'cieneguilla','comas','el agustino','independencia','jesus maria',
    'la molina','la victoria','lima','lince','los olivos','lurigancho','lurigancho chosica',
    'lurin','magdalena del mar','miraflores','pachacamac','pucusana',
    'pueblo libre','puente piedra','punta hermosa','punta negra','rimac',
    'san bartolo','san borja','san isidro','san juan de lurigancho',
    'san juan de miraflores','san luis','san martin de porres','san miguel',
    'santa anita','santa maria del mar','santa rosa','santiago de surco',
    'surquillo','villa el salvador','villa maria del triunfo',
    -- Callao (7 distritos)
    'bellavista','callao','carmen de la legua reynoso','la perla','la punta',
    'mi peru','ventanilla'
  ]);

  -- Región "Lima" a secas: el distrito desempata entre la metropolitana y el
  -- resto del departamento.
  if v_kind = 'lima' then
    return v_in_lima;
  end if;

  -- Región de otro departamento: no es Lima aunque el distrito se llame igual
  -- que uno de Lima (Independencia/Huaraz, La Victoria/Chiclayo…).
  if coverage_norm(p_region) <> '' then
    return false;
  end if;

  -- Sin región: la provincia manda si es concluyente.
  if (v_province in ('lima', 'lima metropolitana') or v_province like '%callao%') and v_in_lima then
    return true;
  end if;

  -- Último recurso: un distrito cuyo nombre NO se repita en otro departamento.
  return v_in_lima and v_district <> all(array[
    'bellavista','independencia','la victoria','miraflores','pueblo libre',
    'san luis','san miguel','santa rosa'
  ]);
end;
$$;

create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_day date default current_date
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_region text := coverage_norm(p_region);
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
begin
  if is_lima_metropolitana(p_region, p_province, p_district) then
    return 'lima';
  end if;

  -- Sin distrito no hay a dónde despachar ni tarifa que consultar.
  if v_district = '' then
    return 'por_revisar';
  end if;

  select org_id into v_org_id from stores where id = p_store_id;

  if exists (
    select 1
    from cost_tariffs t
    where t.org_id = v_org_id
      and t.concept = 'primer_intento'
      and t.courier is not null
      and coverage_norm(t.courier) not in ('shalom', 'olva', 'olva courier')
      and (t.region is not null or t.province is not null or t.district is not null)
      and t.effective_from <= p_day
      and (t.effective_to is null or t.effective_to >= p_day)
      and (t.store_id is null or t.store_id = p_store_id)
      and (t.region is null or coverage_norm(t.region) = v_region)
      and (t.province is null or coverage_norm(t.province) = v_province)
      and (t.district is null or coverage_norm(t.district) = v_district)
  ) then
    return 'provincia_cod';
  end if;

  return 'agencia';
end;
$$;

revoke all on function lima_region_kind(text) from public, anon, authenticated;
revoke all on function is_lima_metropolitana(text, text, text) from public, anon, authenticated;
revoke all on function order_coverage_for(uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function lima_region_kind(text) to service_role;
grant execute on function is_lima_metropolitana(text, text, text) to service_role;
grant execute on function order_coverage_for(uuid, text, text, text, date)
  to service_role;

-- Reclasifica todo lo ya materializado con la regla nueva.
select refresh_order_coverage(null);

-- ---- 0080 ----
-- Guías creadas por la API de Swayp (el courier antes llamado Fenix).
--
-- `guide_code` sigue siendo el identificador que ve y usa el operador. Estas
-- columnas guardan lo que aporta la API y que antes no existía:
--
--   swayp_guide  — el número de guía que EMITE Swayp (ej. 10000022753). Hasta
--                  ahora el código de guía se inventaba localmente
--                  (autoFenixGuideCode); con la API el número lo asigna Swayp y
--                  es el identificador permanente para consultar, imprimir,
--                  cancelar y resolver novedades. Único: dos envíos no pueden
--                  compartir guía, y el webhook busca por acá.
--
--   swayp_state  — el estado CRUDO de Swayp (1..12). El modelo de la app tiene
--                  5 estados y ninguno significa "en devolución", así que
--                  mapSwaypState() es lossy a propósito. Guardar el original
--                  evita perder información (p. ej. distinguir 8 Revisión de 6
--                  Novedad, que mapean ambos a 'pendiente').
--
--   swayp_synced_at — cuándo se recibió la última notificación de Swayp. Sirve
--                  para detectar guías que dejaron de reportar.

alter table shipments add column if not exists swayp_guide text;
alter table shipments add column if not exists swayp_state smallint;
alter table shipments add column if not exists swayp_synced_at timestamptz;

-- El webhook llega con {guide_number} y nada más: sin este índice cada
-- notificación haría un scan de shipments. Único porque una guía de Swayp
-- pertenece a un solo envío — protege además contra la doble creación que
-- provocaría un reintento del POST /v2/guias (la API no tiene idempotencia).
create unique index if not exists shipments_swayp_guide_uniq
  on shipments(swayp_guide) where swayp_guide is not null;

comment on column shipments.swayp_guide is
  'Guide number issued by Swayp (permanent id for their API). Null for manual guides.';
comment on column shipments.swayp_state is
  'Raw Swayp state id 1..12; delivery_status holds the lossy mapping of it.';
comment on column shipments.swayp_synced_at is
  'Last time a Swayp webhook updated this shipment.';

-- ---- 0081 ----
-- 0081 — El distrito de Lima como lo escribe la gente, no como lo llama el INEI.
--
-- Un pedido con región "Lima" y distrito "Surco" salía Provincia COD. La lista
-- de la 0079 tiene los 43 nombres oficiales, y "Santiago de Surco" es uno de
-- ellos; "Surco" a secas no existe en el ubigeo. Como el distrito casi nunca se
-- elige de una lista —lo escribe la clienta por WhatsApp o la asesora al armar
-- el pedido— llegan siglas (SJL, SMP, VMT), nombres viejos (Ate Vitarte,
-- Cercado de Lima), centros poblados tratados como distrito (Huachipa, que es
-- Lurigancho) y referencias enteras ("A 2 cuadras del mercado de Magdalena").
--
-- Y un segundo caso, más frecuente todavía: región "Lima (departamento)" con un
-- distrito de Lima Metropolitana (Miraflores, Los Olivos, San Isidro…). Es una
-- contradicción, y la gana el distrito: el desplegable de Shopify ofrece
-- "Lima (provincia)" y "Lima (departamento)" sin explicar cuál es cuál, mientras
-- que el distrito lo escribe la clienta. Ninguno de esos nombres existe en el
-- departamento de Lima fuera de la metropolitana — salvo San Luis, que también
-- es un distrito de Cañete, y por eso queda excluido.

-- Los 43 distritos de Lima Metropolitana + los 7 del Callao, en un solo lugar.
create or replace function lima_districts()
returns text[]
language sql
immutable
parallel safe
as $$
  select array[
    'ancon','ate','barranco','brena','carabayllo','chaclacayo','chorrillos',
    'cieneguilla','comas','el agustino','independencia','jesus maria',
    'la molina','la victoria','lima','lince','los olivos','lurigancho','lurigancho chosica',
    'lurin','magdalena del mar','miraflores','pachacamac','pucusana',
    'pueblo libre','puente piedra','punta hermosa','punta negra','rimac',
    'san bartolo','san borja','san isidro','san juan de lurigancho',
    'san juan de miraflores','san luis','san martin de porres','san miguel',
    'santa anita','santa maria del mar','santa rosa','santiago de surco',
    'surquillo','villa el salvador','villa maria del triunfo',
    'bellavista','callao','carmen de la legua reynoso','la perla','la punta',
    'mi peru','ventanilla'
  ];
$$;

-- Cómo escribe la gente cada distrito.
create or replace function lima_district_aliases()
returns table(term text, district text)
language sql
immutable
parallel safe
as $$
  values
    ('agustino', 'el agustino'),
    ('ate vitarte', 'ate'),
    ('cercado', 'lima'),
    ('cercado de lima', 'lima'),
    ('carmen de la legua', 'carmen de la legua reynoso'),
    ('chosica', 'lurigancho'),
    ('colonial', 'lima'),
    ('el cercado', 'lima'),
    ('huachipa', 'lurigancho'),
    ('jesus', 'jesus maria'),
    ('la colonial', 'lima'),
    ('lima cercado', 'lima'),
    ('magdalena', 'magdalena del mar'),
    ('molina', 'la molina'),
    ('pantanos de villa', 'chorrillos'),
    ('puente de piedra', 'puente piedra'),
    ('s j l', 'san juan de lurigancho'),
    ('s j m', 'san juan de miraflores'),
    ('s m p', 'san martin de porres'),
    ('san juan de lurigancho sjl', 'san juan de lurigancho'),
    ('san martin de porras', 'san martin de porres'),
    ('sanjuan de lurigancho', 'san juan de lurigancho'),
    ('sanjuan de miraflores', 'san juan de miraflores'),
    ('santa beatriz', 'lima'),
    ('santa maria de huachipa', 'lurigancho'),
    ('sjl', 'san juan de lurigancho'),
    ('sjm', 'san juan de miraflores'),
    ('smp', 'san martin de porres'),
    ('surco', 'santiago de surco'),
    ('surco viejo', 'santiago de surco'),
    ('ves', 'villa el salvador'),
    ('villa maria', 'villa maria del triunfo'),
    ('vitarte', 'ate'),
    ('vmt', 'villa maria del triunfo');
$$;

/*
 * Términos reconocibles DENTRO de una frase más larga, del más largo al más
 * corto para que "san juan de lurigancho" gane antes de que "lurigancho" —que
 * también está en la lista— se lo lleve.
 *
 * Quedan fuera los demasiado genéricos: aparecen en cualquier dirección
 * ("Av. Colonial", "casa de Jesús", "Zárate"). Como distrito exacto se siguen
 * resolviendo; solo no se buscan sueltos.
 */
create or replace function lima_search_terms()
returns table(term text, district text)
language sql
immutable
parallel safe
as $$
  select t.term, t.district
  from (
    select d as term, d as district from unnest(lima_districts()) as d
    union all
    select a.term, a.district from lima_district_aliases() a
  ) t
  where t.term <> all(array[
    'ancon','ate','brena','cercado','comas','jesus','lima','lince','lurin','rimac'
  ])
  order by length(t.term) desc;
$$;

/*
 * El distrito de Lima Metropolitana / Callao al que apunta el texto, o null.
 *
 * `p_search_in_text` busca el nombre dentro de una frase y solo se activa cuando
 * la región ya sitúa el pedido en Lima: fuera de ahí, "Independencia" o
 * "La Victoria" dentro de una referencia mandarían un pedido de Áncash o de
 * Chiclayo al reparto propio.
 */
create or replace function resolve_lima_district(
  p_district text,
  p_search_in_text boolean default false
)
returns text
language plpgsql
immutable
parallel safe
as $$
declare
  v_district text := coverage_norm(p_district);
  v_alias text;
  v_hit text;
begin
  if v_district = '' then
    return null;
  end if;
  if v_district = any(lima_districts()) then
    return v_district;
  end if;

  select a.district into v_alias from lima_district_aliases() a where a.term = v_district;
  if v_alias is not null then
    return v_alias;
  end if;

  if not p_search_in_text then
    return null;
  end if;

  select s.district into v_hit
  from lima_search_terms() s
  where v_district like s.term || ' %'
     or v_district like '% ' || s.term
     or v_district like '% ' || s.term || ' %'
  limit 1;

  return v_hit;
end;
$$;

create or replace function is_lima_metropolitana(
  p_region text,
  p_province text,
  p_district text
)
returns boolean
language plpgsql
immutable
parallel safe
as $$
declare
  v_kind text := lima_region_kind(p_region);
  v_province text := coverage_norm(p_province);
  v_district text;
begin
  if v_kind in ('metropolitana', 'callao') then
    return true;
  end if;

  -- Con la región ya dentro del departamento de Lima, el texto del distrito se
  -- puede leer con confianza: no hay otro departamento con el que confundirlo.
  v_district := resolve_lima_district(p_district, v_kind is not null);

  -- "Lima (departamento)" con un distrito metropolitano: gana el distrito.
  -- San Luis es la excepción — también es un distrito de Cañete.
  if v_kind = 'departamento' then
    return v_district is not null and v_district <> 'san luis';
  end if;

  -- Región "Lima" a secas: el distrito desempata entre la metropolitana y el
  -- resto del departamento (Huaral, Cañete, Yauyos…).
  if v_kind = 'lima' then
    return v_district is not null;
  end if;

  -- Región de otro departamento: no es Lima, aunque el distrito se llame igual
  -- que uno de Lima (Independencia/Huaraz, La Victoria/Chiclayo…).
  if coverage_norm(p_region) <> '' then
    return false;
  end if;

  -- Sin región: la provincia manda si es concluyente; si no, solo un distrito
  -- cuyo nombre no se repita en otro departamento.
  if v_district is null then
    return false;
  end if;
  if v_province in ('lima', 'lima metropolitana') or v_province like '%callao%' then
    return true;
  end if;
  return v_district <> all(array[
    'bellavista','independencia','la victoria','miraflores','pueblo libre',
    'san luis','san miguel','santa rosa'
  ]);
end;
$$;

revoke all on function lima_districts() from public, anon, authenticated;
revoke all on function lima_district_aliases() from public, anon, authenticated;
revoke all on function lima_search_terms() from public, anon, authenticated;
revoke all on function resolve_lima_district(text, boolean) from public, anon, authenticated;
revoke all on function is_lima_metropolitana(text, text, text) from public, anon, authenticated;
grant execute on function lima_districts() to service_role;
grant execute on function lima_district_aliases() to service_role;
grant execute on function lima_search_terms() to service_role;
grant execute on function resolve_lima_district(text, boolean) to service_role;
grant execute on function is_lima_metropolitana(text, text, text) to service_role;

select refresh_order_coverage(null);

-- ---- 0082 ----
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

-- ---- 0083 ----
-- 0083 — La cobertura la decide la BASE, no el build que esté desplegado.
--
-- Por qué: `order_master.coverage` la escribía solo la aplicación
-- (`classifyOrderCoverage` en lib/order-coverage.ts) y la pasada del Master
-- reescribe la tabla entera cada vez. Eso deja la columna a merced de QUÉ build
-- está sirviendo producción: un deploy desde una rama vieja —hecho con
-- `vercel --prod` desde la CLI, sin pasar por main ni por CI— vuelve a la regla
-- anterior a la 0079, que exigía las tres columnas:
--
--     if (!location.region || !location.province || !location.district)
--       return "por_revisar";
--
-- Shopify Perú no manda la provincia (solo distrito y departamento), así que con
-- esa regla TODO pedido cuya provincia esté vacía cae en "Por revisar": Arequipa
-- / Camaná, La Libertad / Huamachuco y Lima (provincia) / Chorrillos por igual.
-- Ha pasado dos veces, y las dos la base tenía la clasificación correcta
-- mientras la columna materializada decía lo contrario.
--
-- Arreglo: `order_coverage_for` ya es la definición canónica y vive aquí, así
-- que la columna pasa a ser derivada de verdad. Un trigger la recalcula en cada
-- insert/update y descarta el valor que mande la aplicación. La pasada del
-- Master sigue enviando su `coverage` —no hace falta cambiarla— pero ya no puede
-- corromper la columna, venga del build que venga.
--
-- No sustituye a desactivar los deploys de CLI a producción; es la red debajo.

create or replace function order_master_set_coverage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Sin cambios en la geografía ni en la cobertura no hay nada que recalcular:
  -- la pasada del Master reescribe las ~10k filas cada vez y `order_coverage_for`
  -- cuesta ~0,3 ms por fila. Si la aplicación manda una cobertura distinta a la
  -- guardada, sí se recalcula: es justo el caso que esta migración ataja.
  if tg_op = 'UPDATE'
    and new.store_id is not distinct from old.store_id
    and new.region   is not distinct from old.region
    and new.province is not distinct from old.province
    and new.district is not distinct from old.district
    and new.coverage is not distinct from old.coverage
  then
    return new;
  end if;

  new.coverage := order_coverage_for(
    new.store_id, new.region, new.province, new.district, current_date
  );
  return new;
end;
$$;

drop trigger if exists order_master_coverage on order_master;
create trigger order_master_coverage
  before insert or update on order_master
  for each row
  execute function order_master_set_coverage();

revoke all on function order_master_set_coverage() from public, anon, authenticated;

-- Repara lo que el build viejo dejó escrito.
select refresh_order_coverage(null);

-- ---- 0084 ----
-- ============================================================================
-- 0084_tanders_payment_check.sql — validar la constancia de PAGO de cada
-- entrega Tanders antes de dar el pedido por cobrado.
--
-- Tanders sube dos evidencias por entrega: la foto del paquete y el comprobante
-- del pago, que el repartidor yapea a Grupo GF SAC. Ese segundo comprobante es
-- el que dice si el dinero llegó, y hasta ahora nadie lo miraba una por una.
--
-- Se pasa por el lector de comprobantes que ya existe (lib/vision.ts, el mismo
-- de los Yape de adelanto) y se comprueban dos cosas: que el Yape vaya a Grupo
-- GF SAC y que el monto sea el de la guía. Un pago a otra cuenta es dinero que
-- no llegó; un monto distinto es un cobro mal hecho.
--
-- El estado BLOQUEA: mientras no sea 'validado' o 'revisado', el pedido no se
-- da por cobrado. `pendiente` y `rechazado` son distintos a propósito —
-- pendiente es "todavía no lo sé", rechazado es "esto está mal": marcar un
-- fallo del lector como rechazo mandaría a investigar un fraude inexistente.
-- ============================================================================

alter table shipments
  -- pendiente | validado | rechazado | revisado. Null = no aplica (no es Tanders
  -- entregado todavía).
  add column if not exists payment_check_state text;

comment on column shipments.payment_check_state is
  'Validación de la constancia de pago (Tanders). Solo validado/revisado dan el cobro por bueno.';

create index if not exists shipments_payment_check_idx
  on shipments(store_id, payment_check_state)
  where payment_check_state is not null;

-- ----------------------------------------------------------------------------
-- Cada intento de comprobación, con lo que el lector leyó. Es la evidencia de
-- POR QUÉ se aceptó o se rechazó un cobro: sin esto, un rechazo es una palabra
-- sin respaldo y un administrador no puede revisarlo con criterio.
-- ----------------------------------------------------------------------------

create table if not exists tanders_payment_checks (
  id               uuid primary key default gen_random_uuid(),
  shipment_id      uuid not null references shipments(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  -- La imagen que se analizó, tal como la sirve Tanders.
  image_url        text,
  state            text not null,
  reasons          text[] not null default '{}',
  -- Lo que el lector transcribió (para que el revisor no tenga que abrir la
  -- imagen para entender el veredicto).
  recipient_name   text,
  amount           numeric(14, 2),
  operation_number text,
  expected_amount  numeric(14, 2),
  model            text,
  -- Respuesta cruda de la API de evidencias: su forma no está documentada.
  raw              jsonb,
  checked_at       timestamptz not null default now(),
  -- Revisión manual: quién dio por bueno un rechazo, y por qué.
  reviewed_by      uuid references auth.users(id) on delete set null,
  reviewed_at      timestamptz,
  review_note      text
);

create index if not exists tanders_payment_checks_shipment_idx
  on tanders_payment_checks(shipment_id, checked_at desc);
create index if not exists tanders_payment_checks_store_idx
  on tanders_payment_checks(store_id, state);

-- Un mismo nº de operación en dos entregas es un comprobante reutilizado: el
-- índice lo hace barato de detectar.
create index if not exists tanders_payment_checks_operation_idx
  on tanders_payment_checks(operation_number)
  where operation_number is not null;

alter table tanders_payment_checks enable row level security;

drop policy if exists tanders_payment_checks_select on tanders_payment_checks;
create policy tanders_payment_checks_select on tanders_payment_checks for select to authenticated
  using (store_id in (select auth_store_ids()));

-- Tabla nueva en `public`: revocar explícitamente lo que no se quiere conceder
-- (ver 5m del DEPLOY — las default privileges de Supabase conceden de más).
revoke all on tanders_payment_checks from anon, authenticated;
grant select on tanders_payment_checks to authenticated;
grant all privileges on tanders_payment_checks to service_role;

comment on table tanders_payment_checks is
  'Comprobaciones de la constancia de pago de entregas Tanders: qué leyó el lector y por qué se aceptó o rechazó.';

-- ---- 0085 ----
-- Aliclik registra la tarifa de la capital de Ayacucho con distrito
-- "Ayacucho", mientras los pedidos de Shopify/ubigeo llegan como:
--   región Ayacucho / provincia Huamanga / distrito Huamanga.
--
-- No se duplica una fila de S/16.50: se declara una equivalencia operativa para
-- que el pedido herede siempre la tarifa vigente de Aliclik y sus futuros
-- cambios de precio.

create or replace function cost_tariff_district_matches(
  p_tariff_district text,
  p_region text,
  p_province text,
  p_district text
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select
    coverage_norm(p_tariff_district) = coverage_norm(p_district)
    or (
      coverage_norm(p_region) = 'ayacucho'
      and coverage_norm(p_province) = 'huamanga'
      and coverage_norm(p_district) = 'huamanga'
      and coverage_norm(p_tariff_district) = 'ayacucho'
    );
$$;

create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_day date default current_date
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_region text := coverage_norm(p_region);
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
begin
  if is_lima_metropolitana(p_region, p_province, p_district) then
    return 'lima';
  end if;

  if v_district = '' then
    return 'por_revisar';
  end if;

  select org_id into v_org_id from stores where id = p_store_id;

  if exists (
    select 1
    from cost_tariffs t
    where t.org_id = v_org_id
      and t.concept = 'primer_intento'
      and t.courier is not null
      and coverage_norm(t.courier) not in ('shalom', 'olva', 'olva courier')
      and (t.region is not null or t.province is not null or t.district is not null)
      and t.effective_from <= p_day
      and (t.effective_to is null or t.effective_to >= p_day)
      and (t.store_id is null or t.store_id = p_store_id)
      and (t.region is null or coverage_norm(t.region) = v_region)
      and (t.province is null or coverage_norm(t.province) = v_province)
      and (
        t.district is null
        or cost_tariff_district_matches(
          t.district,
          p_region,
          p_province,
          p_district
        )
      )
  ) then
    return 'provincia_cod';
  end if;

  return 'agencia';
end;
$$;

revoke all on function cost_tariff_district_matches(text, text, text, text)
  from public, anon, authenticated;
grant execute on function cost_tariff_district_matches(text, text, text, text)
  to service_role;

revoke all on function order_coverage_for(uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function order_coverage_for(uuid, text, text, text, date)
  to service_role;

-- Corrige solo los pedidos afectados. Evita recalcular todo el histórico
-- durante la migración; el trigger de 0083 conservará la clasificación en
-- las sincronizaciones siguientes.
update order_master
set coverage = order_coverage_for(
  store_id,
  region,
  province,
  district,
  current_date
)
where coverage_norm(region) = 'ayacucho'
  and coverage_norm(province) = 'huamanga'
  and coverage_norm(district) = 'huamanga';

-- ---- 0086 ----
-- ============================================================================
-- 0086_mom_phase1.sql — Fundaciones del Master Operations Map.
--
-- Modo sombra: general_status/operational_status siguen siendo las pestañas
-- productivas. Las macroetapas nuevas se calculan en paralelo para validarlas
-- antes de promoverlas a navegación principal.
--
-- También formaliza que UNA guía es UNA salida física. Cada salida recibe un
-- consecutivo dentro del pedido y un QR opaco estable. El courier y la fecha son
-- metadatos: cambiar de courier nunca cambia el token de una salida existente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Identidad y custodia de cada salida
-- ----------------------------------------------------------------------------

alter table shipments
  add column if not exists output_number integer,
  add column if not exists output_code text,
  add column if not exists qr_token uuid not null default gen_random_uuid(),
  -- no_iniciado | rotulo_generado | en_armado | listo_despacho | incidencia
  add column if not exists preparation_state text not null default 'no_iniciado',
  -- empresa | courier | retorno | devuelto
  add column if not exists custody_state text not null default 'empresa',
  add column if not exists ready_at timestamptz,
  add column if not exists ready_by uuid references auth.users(id) on delete set null,
  add column if not exists custody_transferred_at timestamptz,
  add column if not exists custody_transferred_by uuid references auth.users(id) on delete set null;

comment on column shipments.output_number is
  'Consecutivo inmutable de la salida física dentro del pedido: 1, 2, 3…';
comment on column shipments.output_code is
  'Identidad humana estable de salida, p. ej. KP123-S02. El courier se muestra aparte.';
comment on column shipments.qr_token is
  'Token opaco y estable del QR. No incluye pedido, courier, fecha ni datos del cliente.';
comment on column shipments.preparation_state is
  'Estado de preparación MOM: no_iniciado, rotulo_generado, en_armado, listo_despacho, incidencia.';
comment on column shipments.custody_state is
  'Custodia física MOM: empresa, courier, retorno o devuelto.';

-- Backfill determinista por pedido. En una base ya parcialmente migrada, los
-- nulos continúan después del máximo existente para no reutilizar consecutivos.
with existing as (
  select order_id, coalesce(max(output_number), 0) as max_number
    from shipments
   where order_id is not null and output_number is not null
   group by order_id
), pending as (
  select s.id,
         coalesce(e.max_number, 0) + row_number() over (
           partition by s.order_id
           order by coalesce(s.assigned_at, s.created_at), s.created_at, s.id
         ) as next_number
    from shipments s
    left join existing e on e.order_id = s.order_id
   where s.order_id is not null and s.output_number is null
)
update shipments s
   set output_number = p.next_number
  from pending p
 where s.id = p.id;

update shipments s
   set output_code = concat(
         regexp_replace(
           upper(trim(leading '#' from coalesce(nullif(s.order_name, ''), o.name, ''))),
           '[^A-Z0-9_-]+',
           '',
           'g'
         ),
         '-S',
         lpad(s.output_number::text, 2, '0')
       )
  from orders o
 where o.id = s.order_id
   and s.output_number is not null
   and s.output_code is null
   and coalesce(nullif(s.order_name, ''), o.name) is not null;

-- Una guía ya despachada estaba necesariamente armada y fuera de la oficina.
-- Para guías nuevas, la mera existencia de la guía prueba que el rótulo existe.
update shipments
   set preparation_state = case
         when dispatched_at is not null
           or out_for_delivery_at is not null
           or delivery_status in ('en_ruta', 'entregado', 'transferido')
           then 'listo_despacho'
         else 'rotulo_generado'
       end,
       ready_at = case
         when dispatched_at is not null
           or out_for_delivery_at is not null
           or delivery_status in ('en_ruta', 'entregado', 'transferido')
           then coalesce(dispatched_at, out_for_delivery_at, assigned_at, created_at)
         else ready_at
       end
 where preparation_state = 'no_iniciado';

update shipments
   set custody_state = case
         when returned_at is not null then 'devuelto'
         when dispatched_at is not null
           or out_for_delivery_at is not null
           or delivery_status in ('en_ruta', 'entregado', 'transferido')
           then 'courier'
         else custody_state
       end,
       custody_transferred_at = case
         when returned_at is null and (
           dispatched_at is not null
           or out_for_delivery_at is not null
           or delivery_status in ('en_ruta', 'entregado', 'transferido')
         ) then coalesce(dispatched_at, out_for_delivery_at, assigned_at, created_at)
         else custody_transferred_at
       end;

create unique index if not exists shipments_order_output_number_uniq
  on shipments(order_id, output_number)
  where order_id is not null and output_number is not null;
create unique index if not exists shipments_store_output_code_uniq
  on shipments(store_id, output_code)
  where output_code is not null;
create unique index if not exists shipments_qr_token_uniq on shipments(qr_token);
create index if not exists shipments_preparation_idx
  on shipments(store_id, preparation_state, created_at);
create index if not exists shipments_custody_idx
  on shipments(store_id, custody_state, created_at);

-- Asigna la identidad a toda nueva guía y también cuando una guía sin pedido se
-- vincula. Una corrección de vínculo conserva el qr_token, pero recalcula el
-- código humano/consecutivo para el pedido correcto.
create or replace function public.assign_shipment_output_identity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  base_code text;
begin
  if new.order_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.order_id is distinct from old.order_id then
    new.output_number := null;
    new.output_code := null;
  end if;

  -- Serializa únicamente las asignaciones del mismo pedido. Evita dos S02 si
  -- dos integraciones crean guías simultáneamente.
  perform pg_advisory_xact_lock(hashtextextended(new.order_id::text, 0));

  if new.output_number is null then
    select coalesce(max(s.output_number), 0) + 1
      into new.output_number
      from shipments s
     where s.order_id = new.order_id
       and s.id is distinct from new.id;
  end if;

  if new.output_code is null then
    select regexp_replace(
             upper(trim(leading '#' from coalesce(nullif(new.order_name, ''), o.name, ''))),
             '[^A-Z0-9_-]+',
             '',
             'g'
           )
      into base_code
      from orders o
     where o.id = new.order_id;
    if coalesce(base_code, '') <> '' then
      new.output_code := concat(base_code, '-S', lpad(new.output_number::text, 2, '0'));
    end if;
  end if;

  if new.qr_token is null then
    new.qr_token := gen_random_uuid();
  end if;
  return new;
end;
$$;

drop trigger if exists shipments_output_identity on shipments;
create trigger shipments_output_identity
before insert or update of order_id, order_name on shipments
for each row execute function public.assign_shipment_output_identity();

-- ----------------------------------------------------------------------------
-- Read-model MOM en modo sombra
-- ----------------------------------------------------------------------------

alter table order_master
  add column if not exists macro_stage text not null default 'por_confirmar'
    check (macro_stage in (
      'por_confirmar', 'preparacion', 'por_despachar',
      'en_curso', 'por_cerrar', 'finalizado'
    )),
  add column if not exists macro_substage text not null default 'sin_llamar',
  add column if not exists macro_reasons text[] not null default '{}'::text[],
  add column if not exists macro_operation text,
  add column if not exists macro_version text not null default 'mom-v1',
  add column if not exists macro_since timestamptz;

comment on column order_master.macro_stage is
  'Macroetapa MOM calculada en paralelo a general_status (modo sombra durante Fase 1).';
comment on column order_master.macro_reasons is
  'Motivos abiertos, especialmente en Por cerrar; pueden coexistir varios.';

create index if not exists order_master_macro_stage_idx
  on order_master(store_id, macro_stage, macro_since);
create index if not exists order_master_macro_substage_idx
  on order_master(store_id, macro_substage, macro_since);
create index if not exists order_master_macro_reasons_idx
  on order_master using gin(macro_reasons);

-- ---- 0087 ----
-- ============================================================================
-- 0087_mom_phase2_dispatch.sql — Mesa de despacho y transferencia de custodia.
--
-- Una ruta es un manifiesto de un courier en una fecha. La oficina coteja el
-- 100 % de los paquetes y el motorizado vuelve a cotejar el 100 %. Crear o
-- enviar la ruta jamás prueba custodia: esta cambia únicamente en la función
-- atómica finalize_dispatch_manifest().
-- ============================================================================

create table if not exists dispatch_manifests (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id) on delete cascade,
  courier               text not null,
  route_date            date not null default current_date,
  route_label           text not null,
  driver_name           text,
  state                 text not null default 'draft'
    check (state in (
      'draft', 'office_check', 'ready_for_pickup',
      'pickup_check', 'in_custody', 'cancelled'
    )),
  created_by            uuid references auth.users(id) on delete set null,
  office_completed_at   timestamptz,
  office_completed_by   uuid references auth.users(id) on delete set null,
  custody_completed_at  timestamptz,
  custody_completed_by  uuid references auth.users(id) on delete set null,
  cancelled_at          timestamptz,
  cancelled_by          uuid references auth.users(id) on delete set null,
  cancellation_reason   text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (length(trim(courier)) > 0),
  check (length(trim(route_label)) > 0)
);

create index if not exists dispatch_manifests_active_idx
  on dispatch_manifests(org_id, route_date desc, state)
  where state not in ('in_custody', 'cancelled');
create index if not exists dispatch_manifests_history_idx
  on dispatch_manifests(org_id, route_date desc, created_at desc);
create unique index if not exists dispatch_manifest_route_uniq
  on dispatch_manifests(org_id, route_date, lower(trim(courier)), lower(trim(route_label)))
  where state <> 'cancelled';

drop trigger if exists dispatch_manifests_touch on dispatch_manifests;
create trigger dispatch_manifests_touch before update on dispatch_manifests
  for each row execute function public.touch_updated_at();

create table if not exists dispatch_manifest_items (
  id                 uuid primary key default gen_random_uuid(),
  manifest_id        uuid not null references dispatch_manifests(id) on delete cascade,
  shipment_id        uuid not null references shipments(id) on delete restrict,
  store_id           uuid not null references stores(id) on delete cascade,
  added_by           uuid references auth.users(id) on delete set null,
  added_at           timestamptz not null default now(),
  office_checked_by  uuid references auth.users(id) on delete set null,
  office_checked_at  timestamptz,
  pickup_checked_by  uuid references auth.users(id) on delete set null,
  pickup_checked_at  timestamptz,
  removed_by         uuid references auth.users(id) on delete set null,
  removed_at         timestamptz,
  removal_reason     text,
  created_at         timestamptz not null default now(),
  unique (manifest_id, shipment_id),
  check (
    (removed_at is null and removal_reason is null)
    or (removed_at is not null and length(trim(coalesce(removal_reason, ''))) > 0)
  )
);

-- Una salida física no puede estar activa en dos rutas a la vez. Si se retira
-- expresamente, puede incorporarse a una ruta posterior conservando el rastro.
create unique index if not exists dispatch_item_active_shipment_uniq
  on dispatch_manifest_items(shipment_id) where removed_at is null;
create index if not exists dispatch_items_manifest_idx
  on dispatch_manifest_items(manifest_id, removed_at, added_at);
create index if not exists dispatch_items_store_idx
  on dispatch_manifest_items(store_id, added_at desc);

-- Auditoría propia de la ruta. Es append-only igual que order_events.
create table if not exists dispatch_events (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  manifest_id  uuid references dispatch_manifests(id) on delete set null,
  shipment_id  uuid references shipments(id) on delete set null,
  actor        uuid references auth.users(id) on delete set null,
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now()
);

create index if not exists dispatch_events_manifest_idx
  on dispatch_events(manifest_id, occurred_at desc);
create index if not exists dispatch_events_org_idx
  on dispatch_events(org_id, occurred_at desc);

alter table dispatch_manifests enable row level security;
alter table dispatch_manifest_items enable row level security;
alter table dispatch_events enable row level security;

drop policy if exists dispatch_manifests_select on dispatch_manifests;
create policy dispatch_manifests_select on dispatch_manifests for select to authenticated
  using (org_id in (select auth_org_ids()));

drop policy if exists dispatch_manifest_items_select on dispatch_manifest_items;
create policy dispatch_manifest_items_select on dispatch_manifest_items for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists dispatch_events_select on dispatch_events;
create policy dispatch_events_select on dispatch_events for select to authenticated
  using (org_id in (select auth_org_ids()));

revoke all on dispatch_manifests, dispatch_manifest_items, dispatch_events
  from anon, authenticated, service_role;
grant select on dispatch_manifests, dispatch_manifest_items, dispatch_events
  to authenticated;
grant all privileges on dispatch_manifests, dispatch_manifest_items to service_role;
grant select, insert on dispatch_events to service_role;

drop trigger if exists dispatch_events_append_only on dispatch_events;
create trigger dispatch_events_append_only before update or delete on dispatch_events
  for each row execute function public.reject_mutation();

-- Última cerradura: bloquea la ruta, vuelve a comprobar ambos cotejos y mueve
-- todos sus paquetes en una sola transacción. Devuelve los pedidos afectados
-- para que el server action refresque el read-model del Master.
create or replace function public.finalize_dispatch_manifest(
  p_manifest_id uuid,
  p_actor uuid
)
returns uuid[]
language plpgsql
set search_path = public
as $$
declare
  v_manifest dispatch_manifests%rowtype;
  v_total integer;
  v_office integer;
  v_pickup integer;
  v_order_ids uuid[];
begin
  select * into v_manifest
    from dispatch_manifests
   where id = p_manifest_id
   for update;

  if not found then
    raise exception 'Ruta no encontrada.';
  end if;
  if v_manifest.state = 'cancelled' then
    raise exception 'La ruta está cancelada.';
  end if;
  if v_manifest.state = 'in_custody' then
    return coalesce((
      select array_agg(distinct s.order_id) filter (where s.order_id is not null)
        from dispatch_manifest_items i
        join shipments s on s.id = i.shipment_id
       where i.manifest_id = p_manifest_id and i.removed_at is null
    ), '{}'::uuid[]);
  end if;

  select count(*),
         count(*) filter (where office_checked_at is not null),
         count(*) filter (where pickup_checked_at is not null)
    into v_total, v_office, v_pickup
    from dispatch_manifest_items
   where manifest_id = p_manifest_id and removed_at is null;

  if v_total = 0 then
    raise exception 'La ruta no tiene paquetes activos.';
  end if;
  if v_office <> v_total then
    raise exception 'El cotejo de oficina no está completo (%/%).', v_office, v_total;
  end if;
  if v_pickup <> v_total then
    raise exception 'El cotejo del motorizado no está completo (%/%).', v_pickup, v_total;
  end if;

  select coalesce(array_agg(distinct s.order_id) filter (where s.order_id is not null), '{}'::uuid[])
    into v_order_ids
    from dispatch_manifest_items i
    join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id and i.removed_at is null;

  update shipments s
     set custody_state = 'courier',
         custody_transferred_at = now(),
         custody_transferred_by = p_actor,
         dispatched_at = coalesce(s.dispatched_at, now())
    from dispatch_manifest_items i
   where i.manifest_id = p_manifest_id
     and i.removed_at is null
     and s.id = i.shipment_id;

  update dispatch_manifests
     set state = 'in_custody',
         custody_completed_at = now(),
         custody_completed_by = p_actor
   where id = p_manifest_id;

  insert into order_events (
    store_id, order_id, kind, occurred_at, actor, source, courier,
    guide_code, shipment_id, note, payload
  )
  select s.store_id, s.order_id, 'custody_transferred', now(), p_actor,
         'dispatch', s.courier, s.guide_code, s.id,
         'Paquete cotejado y recibido por el motorizado.',
         jsonb_build_object(
           'manifest_id', p_manifest_id,
           'route_label', v_manifest.route_label,
           'route_date', v_manifest.route_date,
           'driver_name', v_manifest.driver_name
         )
    from dispatch_manifest_items i
    join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id
     and i.removed_at is null
     and s.order_id is not null;

  insert into dispatch_events (org_id, manifest_id, actor, kind, payload)
  values (
    v_manifest.org_id, p_manifest_id, p_actor, 'custody_transferred',
    jsonb_build_object('packages', v_total, 'driver_name', v_manifest.driver_name)
  );

  return v_order_ids;
end;
$$;

revoke all on function public.finalize_dispatch_manifest(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_dispatch_manifest(uuid, uuid)
  to service_role;

-- ---- 0088 ----
-- 0088_mom_macro_navigation.sql
-- Activa el MOM como navegación principal y clasifica una sola vez las filas
-- históricas que 0059 dejó con el valor inicial de modo sombra. Las fuentes
-- originales no cambian; los recálculos TypeScript posteriores siguen siendo
-- la resolución autoritativa y reemplazan esta inferencia conservadora.

with base as (
  select
    id,
    general_status,
    operational_status,
    shipping_mode,
    payment_state,
    pickup_state,
    dispatched_at,
    returned_at,
    status_since,
    order_created_at,
    updated_at,
    lower(coalesce(region, '')) as region_key,
    lower(coalesce(province, '')) as province_key
  from order_master
  where macro_since is null
), classified as (
  select
    base.*,
    case
      when shipping_mode = 'agency' then 'agencia'
      when region_key in ('lima', 'callao') or province_key in ('lima', 'callao') then 'lima'
      else 'provincia_cod'
    end as inferred_operation,
    case
      when general_status = 'entregado'
        and shipping_mode = 'agency'
        and payment_state = 'pago_completo' then 'finalizado'
      when general_status = 'entregado' then 'por_cerrar'
      when general_status = 'anulado' and dispatched_at is null then 'finalizado'
      when general_status in ('anulado', 'devuelto') then 'por_cerrar'
      when general_status = 'en_proceso' and operational_status = 'asignado_a_courier'
        and dispatched_at is null then 'preparacion'
      when general_status = 'en_proceso' then 'en_curso'
      when operational_status in ('preparado_sin_despachar', 'sin_asignar_courier', 'nunca_salio_a_reparto')
        then 'por_despachar'
      when operational_status in ('confirmado_sin_preparar', 'pendiente_de_envio', 'detenido_sin_informacion')
        then 'preparacion'
      when region_key in ('lima', 'callao') or province_key in ('lima', 'callao')
        then 'preparacion'
      else 'por_confirmar'
    end as inferred_stage
  from base
), resolved as (
  select
    classified.*,
    case inferred_stage
      when 'finalizado' then
        case
          when general_status = 'entregado' and inferred_operation = 'agencia' then 'recogido_cerrado'
          when general_status = 'entregado' then 'entregado_cerrado'
          when general_status = 'devuelto' then 'devuelto_cerrado'
          else 'anulado_cerrado'
        end
      when 'por_cerrar' then
        case
          when general_status = 'entregado' and inferred_operation = 'agencia'
            and payment_state is distinct from 'pago_completo' then 'recogido_sin_pago_completo'
          when general_status = 'entregado' then 'pendiente_liquidacion'
          when returned_at is not null then 'devolucion_pendiente_inventario'
          else 'devolucion_fisica_pendiente'
        end
      when 'en_curso' then
        case
          when operational_status in ('en_reparto', 'intento_de_entrega') then 'en_reparto'
          when operational_status in ('disponible_para_recojo', 'cliente_notificado', 'pendiente_de_recojo', 'proximo_a_vencer')
            and payment_state is distinct from 'pago_completo' then 'pendiente_pago_diferencia'
          when operational_status in ('disponible_para_recojo', 'cliente_notificado', 'pendiente_de_recojo', 'proximo_a_vencer')
            then 'disponible_para_recojo'
          when operational_status in ('pendiente_de_reprogramacion', 'reprogramado', 'pendiente_nuevo_courier', 'espera_respuesta_cliente')
            and inferred_operation = 'lima' then 'por_reprogramar_lima'
          when operational_status in ('pendiente_de_reprogramacion', 'reprogramado', 'pendiente_nuevo_courier', 'espera_respuesta_cliente')
            then 'gestion_reproprovincia'
          when operational_status in ('retorno_iniciado', 'en_proceso_de_retorno') then 'en_retorno'
          when operational_status in ('registrado_en_agencia') then 'en_destino'
          when operational_status in ('en_ruta', 'enviado_a_agencia', 'en_transito', 'en_traslado', 'despachado')
            then 'en_transito'
          else 'recibido_por_courier'
        end
      when 'por_despachar' then 'listo_para_asignar'
      when 'preparacion' then
        case
          when operational_status = 'detenido_sin_informacion' then 'incidencia_preparacion'
          when operational_status = 'asignado_a_courier' then 'por_armar'
          else 'por_generar_rotulo'
        end
      else 'sin_llamar'
    end as inferred_substage
  from classified
)
update order_master as target
set
  macro_stage = resolved.inferred_stage,
  macro_substage = resolved.inferred_substage,
  macro_reasons = case resolved.inferred_stage
    when 'por_cerrar' then array[resolved.inferred_substage]::text[]
    else '{}'::text[]
  end,
  macro_operation = resolved.inferred_operation,
  macro_version = 'mom-v1',
  macro_since = coalesce(resolved.status_since, resolved.order_created_at, resolved.updated_at, now())
from resolved
where target.id = resolved.id;

comment on column order_master.macro_stage is
  'Macroetapa MOM usada por la navegación principal del Master; general_status se conserva como compatibilidad.';

-- ---- 0089 ----
-- 0089_order_master_mom_counts.sql
-- Devuelve todos los conteos del MOM en una sola consulta agrupada. La función
-- respeta el RLS de order_master porque usa SECURITY INVOKER.

create or replace function public.order_master_mom_counts(p_store_ids uuid[])
returns table (
  macro_stage text,
  macro_substage text,
  total bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    om.macro_stage,
    om.macro_substage,
    count(*)::bigint as total
  from public.order_master as om
  where om.store_id = any(p_store_ids)
  group by om.macro_stage, om.macro_substage;
$$;

revoke all on function public.order_master_mom_counts(uuid[]) from public, anon;
grant execute on function public.order_master_mom_counts(uuid[]) to authenticated, service_role;

comment on function public.order_master_mom_counts(uuid[]) is
  'Conteos agrupados por macroetapa y subetapa del MOM, respetando RLS.';

create or replace function public.order_master_agency_summary(p_store_ids uuid[])
returns table (
  total bigint,
  disponibles bigint,
  proximos_a_vencer bigint,
  retorno_iniciado bigint,
  devueltos bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*)::bigint,
    count(*) filter (
      where om.general_status <> 'devuelto'
        and om.pickup_state in ('disponible_para_recojo', 'pendiente_de_recojo')
    )::bigint,
    count(*) filter (
      where om.general_status <> 'devuelto'
        and om.agency_expires_at is not null
        and om.agency_expires_at <= now() + interval '3 days'
    )::bigint,
    count(*) filter (
      where om.general_status <> 'devuelto'
        and om.pickup_state = 'retorno_iniciado'
    )::bigint,
    count(*) filter (where om.general_status = 'devuelto')::bigint
  from public.order_master as om
  where om.store_id = any(p_store_ids)
    and (om.pickup_state is not null or om.shipping_mode = 'agency');
$$;

revoke all on function public.order_master_agency_summary(uuid[]) from public, anon;
grant execute on function public.order_master_agency_summary(uuid[]) to authenticated, service_role;

comment on function public.order_master_agency_summary(uuid[]) is
  'Resumen exacto de pedidos en agencia para el encabezado del Master.';

create index if not exists order_master_mom_stage_movement_idx
  on public.order_master(store_id, macro_stage, last_movement_at desc nulls first, order_created_at desc);

create index if not exists order_master_mom_substage_movement_idx
  on public.order_master(store_id, macro_substage, last_movement_at desc nulls first, order_created_at desc);

-- ---- 0090 ----
-- ============================================================================
-- 0090_mom_phase3_routing.sql — Activación del motor de modalidades del MOM.
--
-- Los pedidos históricos de Shopify no siempre traen `shipping_mode`. Si su
-- geografía es conocida y no corresponde a Lima/Callao, la operación normal es
-- Provincia COD. Agencia continúa siendo explícita: la determina shipping_mode
-- o una salida Shalom/Olva al siguiente recálculo.
-- ============================================================================

update order_master
   set macro_operation = 'provincia_cod',
       macro_version = 'mom-v1',
       updated_at = now()
 where coalesce(macro_operation, 'desconocida') = 'desconocida'
   and nullif(trim(concat_ws(' ', region, province)), '') is not null
   and lower(concat_ws(' ', region, province)) !~ '(^|[^a-z])(lima|callao)([^a-z]|$)';

comment on column shipments.created_via is
  'Origen técnico de la salida: integraciones existentes, fenix_directo o mom_manual_route.';

-- ---- 0091 ----
-- 0091 — Cañete es operación Agencia, nunca reparto Lima.
--
-- Shopify puede guardar una dirección de Cañete bajo "Lima (provincia)". Esa
-- etiqueta normalmente significa Lima Metropolitana, por lo que la regla
-- general clasificaba el pedido como Lima y habilitaba couriers como Tanders.
-- La decisión operativa del MOM es explícita: Cañete siempre se atiende por
-- agencia, incluso si existe una tarifa COD histórica que coincida.

create or replace function is_lima_metropolitana(
  p_region text,
  p_province text,
  p_district text
)
returns boolean
language plpgsql
immutable
parallel safe
as $$
declare
  v_kind text := lima_region_kind(p_region);
  v_province text := coverage_norm(p_province);
  v_raw_district text := coverage_norm(p_district);
  v_district text;
begin
  -- Una provincia del departamento de Lima no puede transformarse en Lima
  -- Metropolitana solo porque Shopify haya elegido "Lima (provincia)".
  if v_province = any(array[
    'barranca','cajatambo','canete','canta','huaral','huarochiri','huaura','oyon','yauyos'
  ]) or v_raw_district = 'canete' or v_raw_district like '% canete' then
    return false;
  end if;

  if v_kind in ('metropolitana', 'callao') then
    return true;
  end if;

  v_district := resolve_lima_district(p_district, v_kind is not null);

  if v_kind = 'departamento' then
    return v_district is not null and v_district <> 'san luis';
  end if;
  if v_kind = 'lima' then
    return v_district is not null;
  end if;
  if coverage_norm(p_region) <> '' then
    return false;
  end if;
  if v_district is null then
    return false;
  end if;
  if v_province in ('lima', 'lima metropolitana') or v_province like '%callao%' then
    return true;
  end if;
  return v_district <> all(array[
    'bellavista','independencia','la victoria','miraflores','pueblo libre',
    'san luis','san miguel','santa rosa'
  ]);
end;
$$;

create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_day date default current_date
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_region text := coverage_norm(p_region);
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
begin
  -- Regla comercial explícita. Debe ganar incluso a una tarifa histórica.
  if v_province = 'canete' or v_district = 'canete' or v_district like '% canete' then
    return 'agencia';
  end if;

  if is_lima_metropolitana(p_region, p_province, p_district) then
    return 'lima';
  end if;
  if v_district = '' then
    return 'por_revisar';
  end if;

  select org_id into v_org_id from stores where id = p_store_id;

  if exists (
    select 1
    from cost_tariffs t
    where t.org_id = v_org_id
      and t.concept = 'primer_intento'
      and t.courier is not null
      and coverage_norm(t.courier) not in ('shalom', 'olva', 'olva courier')
      and (t.region is not null or t.province is not null or t.district is not null)
      and t.effective_from <= p_day
      and (t.effective_to is null or t.effective_to >= p_day)
      and (t.store_id is null or t.store_id = p_store_id)
      and (t.region is null or coverage_norm(t.region) = v_region)
      and (t.province is null or coverage_norm(t.province) = v_province)
      and (t.district is null or coverage_norm(t.district) = v_district)
  ) then
    return 'provincia_cod';
  end if;

  return 'agencia';
end;
$$;

revoke all on function is_lima_metropolitana(text, text, text) from public, anon, authenticated;
revoke all on function order_coverage_for(uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function is_lima_metropolitana(text, text, text) to service_role;
grant execute on function order_coverage_for(uuid, text, text, text, date) to service_role;

select refresh_order_coverage(null);

-- ---- 0092 ----
-- 0092_multiple_payment_differences.sql
-- El primer comprobante es Adelanto o Pago total. Después de un adelanto se
-- permiten tantas diferencias como pagos reales haga el cliente hasta cubrir
-- el monto del pedido. La operación y la huella del archivo siguen siendo
-- únicas, por lo que repetir diferencias no relaja la protección anti-duplicado.

drop index if exists order_payments_kind_uniq;

create unique index if not exists order_payments_initial_payment_uniq
  on order_payments(order_id)
  where validation_status <> 'rechazado'
    and kind in ('adelanto', 'total');

comment on index order_payments_initial_payment_uniq is
  'Un pedido tiene un único primer pago vivo: adelanto o pago total. Diferencia admite varios comprobantes.';

-- ---- 0093 ----
-- 0093 — Correcciones auditadas de transcripciones en liquidaciones.
--
-- La foto o el Excel original siguen siendo evidencia inmutable. Cuando visión
-- omite una comisión o una persona corrige un monto, se actualiza el valor
-- operativo de la fila y se registra aquí el antes, el después, quién y por qué.

create table if not exists rider_settlement_line_corrections (
  id              uuid primary key default gen_random_uuid(),
  settlement_id   uuid not null references rider_settlements(id) on delete cascade,
  line_id          uuid not null references rider_settlement_lines(id) on delete cascade,
  field_name       text not null check (field_name in ('declared_amount', 'declared_fee')),
  previous_value   numeric(12, 2),
  new_value        numeric(12, 2),
  reason           text not null check (length(btrim(reason)) >= 3),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists rider_settlement_line_corrections_line_idx
  on rider_settlement_line_corrections(line_id, created_at desc);
create index if not exists rider_settlement_line_corrections_settlement_idx
  on rider_settlement_line_corrections(settlement_id, created_at desc);

alter table rider_settlement_line_corrections enable row level security;

drop policy if exists rider_settlement_line_corrections_select
  on rider_settlement_line_corrections;
create policy rider_settlement_line_corrections_select
  on rider_settlement_line_corrections for select to authenticated
  using (settlement_id in (
    select id from rider_settlements where store_id in (select auth_store_ids())
  ));

-- Solo el servidor escribe. Nadie puede reescribir o borrar la auditoría.
revoke all on rider_settlement_line_corrections from anon, authenticated, service_role;
grant select on rider_settlement_line_corrections to authenticated;
grant select, insert on rider_settlement_line_corrections to service_role;

drop trigger if exists rider_settlement_line_corrections_immutable
  on rider_settlement_line_corrections;
create trigger rider_settlement_line_corrections_immutable
  before update or delete on rider_settlement_line_corrections
  for each row execute function public.reject_mutation();

comment on table rider_settlement_line_corrections is
  'Historial append-only de correcciones humanas a montos transcritos de una liquidación.';

-- Actualiza monto y comisión en una sola transacción. El raw original de la
-- fila no se toca, por lo que siempre puede cotejarse contra la imagen.
create or replace function public.correct_rider_settlement_line_values(
  p_settlement_id uuid,
  p_line_id uuid,
  p_declared_amount numeric,
  p_declared_fee numeric,
  p_reason text,
  p_actor uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_previous_amount numeric(12, 2);
  v_previous_fee numeric(12, 2);
  v_changes integer := 0;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Escribe un motivo breve para la corrección.';
  end if;
  if p_declared_amount is not null and p_declared_amount < 0 then
    raise exception 'El monto reportado no puede ser negativo.';
  end if;
  if p_declared_fee is not null and p_declared_fee < 0 then
    raise exception 'La comisión no puede ser negativa.';
  end if;

  select s.status, l.declared_amount, l.declared_fee
    into v_status, v_previous_amount, v_previous_fee
  from rider_settlement_lines l
  join rider_settlements s on s.id = l.settlement_id
  where l.id = p_line_id and l.settlement_id = p_settlement_id
  for update of l;

  if not found then
    raise exception 'La fila no pertenece a esta liquidación.';
  end if;
  if v_status = 'cerrada' then
    raise exception 'La liquidación está cerrada; abre una liquidación de ajuste.';
  end if;

  if v_previous_amount is distinct from p_declared_amount then
    insert into rider_settlement_line_corrections (
      settlement_id, line_id, field_name, previous_value, new_value, reason, created_by
    ) values (
      p_settlement_id, p_line_id, 'declared_amount', v_previous_amount,
      p_declared_amount, btrim(p_reason), p_actor
    );
    v_changes := v_changes + 1;
  end if;

  if v_previous_fee is distinct from p_declared_fee then
    insert into rider_settlement_line_corrections (
      settlement_id, line_id, field_name, previous_value, new_value, reason, created_by
    ) values (
      p_settlement_id, p_line_id, 'declared_fee', v_previous_fee,
      p_declared_fee, btrim(p_reason), p_actor
    );
    v_changes := v_changes + 1;
  end if;

  if v_changes = 0 then
    return 0;
  end if;

  update rider_settlement_lines
  set declared_amount = p_declared_amount,
      declared_fee = p_declared_fee,
      updated_at = now()
  where id = p_line_id;

  update rider_settlements
  set status = 'borrador', updated_at = now()
  where id = p_settlement_id;

  return v_changes;
end;
$$;

revoke all on function public.correct_rider_settlement_line_values(
  uuid, uuid, numeric, numeric, text, uuid
) from public, anon, authenticated;
grant execute on function public.correct_rider_settlement_line_values(
  uuid, uuid, numeric, numeric, text, uuid
) to service_role;

-- ---- 0094 ----
-- 0094_org_shopify_products.sql — catálogo de productos derivado de Shopify.
--
-- Kapta no crea productos: son siempre los de Shopify (principios 1 y 3). No hay
-- tabla de catálogo propia; el SKU y el título llegan embebidos en
-- `orders.line_items` (ver 0055_aliclik_catalog). La pestaña «Costos de
-- productos» necesita esa lista real para asignar costo a lo que existe, en vez
-- de que un administrador teclee el SKU a mano.
--
-- Esta función deriva, por organización, los SKU distintos vistos en pedidos,
-- con un nombre representativo (el título más reciente) y en cuántos pedidos
-- aparecen. La agrupación es case-insensitive (lower) para no partir el mismo
-- producto en dos por diferencias de mayúsculas; devuelve un SKU representativo.
-- La resolución de costo (lib/costs.ts) ya compara SKU sin distinguir mayúsculas
-- ni acentos, así que el costo asignado calza con el SKU del pedido igual.

create or replace function public.org_shopify_products(p_org_id uuid)
returns table (sku text, product_name text, order_count bigint)
language sql
stable
set search_path = public
as $$
  with valid as (
    select
      o.id as order_id,
      o.created_at,
      btrim(elem->>'sku') as sku,
      nullif(btrim(elem->>'title'), '') as title
    from orders o
    join stores s on s.id = o.store_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
    ) as elem
    where s.org_id = p_org_id
      and btrim(elem->>'sku') <> ''
  ),
  names as (
    select distinct on (lower(sku))
      lower(sku) as sku_key,
      title
    from valid
    where title is not null
    order by lower(sku), created_at desc nulls last
  ),
  counts as (
    select
      lower(sku) as sku_key,
      min(sku) as sku_display,
      count(distinct order_id) as order_count
    from valid
    group by lower(sku)
  )
  select c.sku_display as sku, n.title as product_name, c.order_count
  from counts c
  left join names n on n.sku_key = c.sku_key
  order by c.order_count desc, c.sku_display;
$$;

-- Solo el service role la invoca, desde la acción de servidor que ya exige rol
-- de administrador de la organización antes de pasarle el org_id.
revoke all on function public.org_shopify_products(uuid) from public;
grant execute on function public.org_shopify_products(uuid) to service_role;

-- ---- 0095 ----
-- 0095_dispatch_manifest_rider.sql — vincular el manifiesto con la ficha del
-- motorizado, conservando el nombre histórico.
--
-- Hasta ahora `dispatch_manifests.courier` y `driver_name` eran texto libre (0087):
-- el "motorizado" del despacho no tenía relación con la tabla `riders` (0064).
-- Ahora la Mesa de despacho elige el motorizado de una lista. Guardamos:
--   - `rider_id`: a qué ficha corresponde (nullable → "Sin asignar", p. ej. Urpi
--     o Swayp cuando no se conoce al conductor).
--   - `driver_name`: se conserva como COPIA HISTÓRICA del nombre al crear la ruta.
--     Si luego se renombra o desactiva al motorizado, las rutas viejas no cambian
--     (MOM §6.3: el segundo cotejo identifica quién recibió los paquetes).
--
-- `on delete set null`: borrar/limpiar una ficha no rompe el historial; el nombre
-- ya quedó copiado en `driver_name`.

alter table dispatch_manifests
  add column if not exists rider_id uuid references riders(id) on delete set null;

create index if not exists dispatch_manifests_rider_idx
  on dispatch_manifests(rider_id)
  where rider_id is not null;

-- ---- 0096 ----
-- 0096 — Dos tipos de ruta en la Mesa de despacho.
--
-- POR QUÉ. La Mesa trataba igual dos cosas distintas:
--
--   * una CAJA QUE SE LE ENTREGA A UN MOTORIZADO, donde el doble cotejo tiene
--     sentido porque hay alguien del otro lado que confirma lo que recibe; y
--   * una ENTREGA AL COURIER (Aliclik recoge, o la caja se lleva a Shalom/Olva),
--     donde el segundo cotejo no puede ocurrir: nadie del otro lado escanea.
--
-- Con un solo tipo, las rutas de Aliclik y agencia se quedaban trabadas para
-- siempre en `ready_for_pickup` esperando un cotejo que nunca iba a llegar, y la
-- custodia no pasaba nunca al courier.
--
-- `kind` separa los dos casos. `received_by` guarda quién recogió físicamente
-- cuando no hay motorizado que coteje: es la única prueba de la entrega, así que
-- finalizar una ruta de ese tipo lo exige.

alter table dispatch_manifests
  add column if not exists kind text not null default 'reparto',
  add column if not exists received_by text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'dispatch_manifests_kind_check'
  ) then
    alter table dispatch_manifests
      add constraint dispatch_manifests_kind_check
      check (kind in ('reparto', 'entrega_courier'));
  end if;
end $$;

comment on column dispatch_manifests.kind is
  'reparto = caja para un motorizado, con doble cotejo. '
  'entrega_courier = Aliclik recoge o se lleva a agencia: cotejo de oficina y '
  'nombre de quien recoge, sin segundo cotejo (MOM §5, Fase 2).';
comment on column dispatch_manifests.received_by is
  'Quién recogió físicamente los paquetes cuando la ruta no tiene motorizado que '
  'coteje. Obligatorio para cerrar una ruta entrega_courier.';

-- Las rutas ya creadas son todas de reparto salvo las de couriers que no
-- reparten con motorizado nuestro. Se corrige el histórico abierto para que no
-- quede esperando un cotejo imposible.
update dispatch_manifests
   set kind = 'entrega_courier'
 where kind = 'reparto'
   and lower(trim(courier)) in ('aliclik', 'shalom', 'olva');

-- ---------------------------------------------------------------------------
-- finalize_dispatch_manifest: el segundo cotejo solo se exige donde existe.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_dispatch_manifest(
  p_manifest_id uuid,
  p_actor uuid
)
returns uuid[]
language plpgsql
set search_path = public
as $$
declare
  v_manifest dispatch_manifests%rowtype;
  v_total integer;
  v_office integer;
  v_pickup integer;
  v_order_ids uuid[];
  v_note text;
begin
  select * into v_manifest
    from dispatch_manifests
   where id = p_manifest_id
   for update;

  if not found then
    raise exception 'Ruta no encontrada.';
  end if;
  if v_manifest.state = 'cancelled' then
    raise exception 'La ruta está cancelada.';
  end if;
  if v_manifest.state = 'in_custody' then
    return coalesce((
      select array_agg(distinct s.order_id) filter (where s.order_id is not null)
        from dispatch_manifest_items i
        join shipments s on s.id = i.shipment_id
       where i.manifest_id = p_manifest_id and i.removed_at is null
    ), '{}'::uuid[]);
  end if;

  select count(*),
         count(*) filter (where office_checked_at is not null),
         count(*) filter (where pickup_checked_at is not null)
    into v_total, v_office, v_pickup
    from dispatch_manifest_items
   where manifest_id = p_manifest_id and removed_at is null;

  if v_total = 0 then
    raise exception 'La ruta no tiene paquetes activos.';
  end if;
  if v_office <> v_total then
    raise exception 'El cotejo de oficina no está completo (%/%).', v_office, v_total;
  end if;

  if v_manifest.kind = 'reparto' then
    if v_pickup <> v_total then
      raise exception 'El cotejo del motorizado no está completo (%/%).', v_pickup, v_total;
    end if;
    v_note := 'Paquete cotejado y recibido por el motorizado.';
  else
    -- Sin motorizado que coteje, la prueba de la entrega es el nombre de quien
    -- recogió. Sin eso no hay a quién reclamarle una caja que no llegó.
    if length(trim(coalesce(v_manifest.received_by, ''))) = 0 then
      raise exception 'Anota quién recoge antes de cerrar la entrega al courier.';
    end if;
    v_note := 'Paquete entregado al courier: ' || v_manifest.received_by || '.';
  end if;

  select coalesce(array_agg(distinct s.order_id) filter (where s.order_id is not null), '{}'::uuid[])
    into v_order_ids
    from dispatch_manifest_items i
    join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id and i.removed_at is null;

  update shipments s
     set custody_state = 'courier',
         custody_transferred_at = now(),
         custody_transferred_by = p_actor,
         dispatched_at = coalesce(s.dispatched_at, now())
    from dispatch_manifest_items i
   where i.manifest_id = p_manifest_id
     and i.removed_at is null
     and s.id = i.shipment_id;

  update dispatch_manifests
     set state = 'in_custody',
         custody_completed_at = now(),
         custody_completed_by = p_actor
   where id = p_manifest_id;

  insert into order_events (
    store_id, order_id, kind, occurred_at, actor, source, courier,
    guide_code, shipment_id, note, payload
  )
  select s.store_id, s.order_id, 'custody_transferred', now(), p_actor,
         'dispatch', s.courier, s.guide_code, s.id,
         v_note,
         jsonb_build_object(
           'manifest_id', p_manifest_id,
           'route_label', v_manifest.route_label,
           'route_date', v_manifest.route_date,
           'route_kind', v_manifest.kind,
           'driver_name', v_manifest.driver_name,
           'received_by', v_manifest.received_by
         )
    from dispatch_manifest_items i
    join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id
     and i.removed_at is null
     and s.order_id is not null;

  insert into dispatch_events (org_id, manifest_id, actor, kind, payload)
  values (
    v_manifest.org_id, p_manifest_id, p_actor, 'custody_transferred',
    jsonb_build_object(
      'packages', v_total,
      'route_kind', v_manifest.kind,
      'driver_name', v_manifest.driver_name,
      'received_by', v_manifest.received_by
    )
  );

  return v_order_ids;
end;
$$;

-- `create or replace` conserva los permisos, pero se repiten para que la
-- migración sea válida también aplicada sola sobre una base limpia.
revoke all on function public.finalize_dispatch_manifest(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_dispatch_manifest(uuid, uuid)
  to service_role;

-- ---- 0097 ----
-- 0097 — Una ruta por motorizado y día; una por courier y día.
--
-- REGLA DEL NEGOCIO (Frankz): un motorizado tiene UNA ruta al día, y un courier
-- también. Partir la carga de alguien en dos rutas el mismo día no ocurre, y
-- cuando aparece una segunda es un error: los paquetes quedan repartidos entre
-- dos manifiestos y el cotejo de ninguno cuadra.
--
-- POR QUÉ CAMBIA EL ÍNDICE. El anterior era (org, fecha, courier, NOMBRE de la
-- ruta), y el nombre dejó de identificar nada: ahora es opcional y por defecto
-- se copia del motorizado. Con ese índice, dos rutas de Roy el mismo día pasaban
-- si alguien escribía nombres distintos ("Surco" y "Surco tarde"), que es
-- justamente el error que hay que impedir.
--
-- La identidad de una ruta es la MISMA que su nombre visible: la persona si la
-- hay, y si no el courier.
--
--   * Con motorizado  → único por (org, fecha, motorizado). Así Johnny, Roy y
--     Douglas tienen cada uno su ruta aunque los tres sean "motorizados
--     propios" — si el índice fuera por courier, los tres competirían por una
--     sola ruta al día y la operación de Lima se rompería.
--   * Sin motorizado   → único por (org, fecha, courier). Es el caso de Aliclik,
--     las agencias y las rutas "Sin asignar" de Urpi, Swayp o Tanders.

drop index if exists dispatch_manifest_route_uniq;

create unique index if not exists dispatch_manifest_rider_day_uniq
  on dispatch_manifests(org_id, route_date, rider_id)
  where rider_id is not null and state <> 'cancelled';

create unique index if not exists dispatch_manifest_courier_day_uniq
  on dispatch_manifests(org_id, route_date, lower(trim(courier)))
  where rider_id is null and state <> 'cancelled';

-- ---- 0098 ----
-- 0098 — La nota del pedido de Shopify, como columna.
--
-- POR QUÉ. La nota es donde el asesor escribe las instrucciones reales del
-- pedido: «enviar con Tanders», «antes de la 1 y 30», «llamar al llegar». Va
-- impresa en el rótulo, junto al QR, porque quien arma la caja no la tenía en
-- ninguna parte del papel — había que abrir Shopify para enterarse. Hoy la traen
-- 700 de cada 1.430 pedidos de la semana, así que no es un caso marginal.
--
-- POR QUÉ GENERADA Y NO UNA COLUMNA NORMAL. El dato ya está en `raw`, el JSON
-- crudo de Shopify que se guarda en cada sincronización. Una columna generada:
--
--   * cubre los 11.579 pedidos ya cargados sin backfill ni script aparte;
--   * no puede desincronizarse de `raw`, porque la calcula la base;
--   * no obliga a tocar el mapeo ni el upsert de la ingesta, que es el camino
--     por el que entra CADA pedido — un cambio ahí se paga en riesgo.
--
-- Se lee como una columna más (`select ... , shopify_note`), sin depender de la
-- sintaxis JSON de PostgREST, que no se puede probar desde el entorno de
-- desarrollo y fallaría recién en producción tumbando la impresión entera.

alter table orders
  add column if not exists shopify_note text
  generated always as (nullif(btrim(raw ->> 'note'), '')) stored;

comment on column orders.shopify_note is
  'Nota del pedido en Shopify (raw->>note), ya recortada; NULL si viene vacía. '
  'Se imprime en el rótulo junto al QR.';

-- ---- 0099 ----
-- 0099 — «Pago requerido pendiente» deja de ser subetapa y pasa a ser motivo.
--
-- Competía con «Volver a contactar» por el mismo pedido: una Agencia sin abono
-- validado se mostraba como pago pendiente hasta que alguien agendaba el
-- próximo contacto, y ahí saltaba a «Volver a contactar» sin que el pago
-- hubiera cambiado. Ahora la subetapa describe la gestión de la llamada y el
-- abono viaja en `macro_reasons`.
--
-- `macro_substage` es texto libre sin check: la subetapa la calcula
-- `resolveOrderMacroStage` en TypeScript y se escribe en cada recálculo. Esta
-- migración solo adelanta la conversión de las filas ya materializadas, que si
-- no quedarían contadas bajo una subetapa que la interfaz ya no ofrece —
-- pedidos invisibles en Por confirmar hasta su próximo barrido.
--
-- El destino es `por_confirmar` y no `volver_a_contactar` porque el código
-- anterior evaluaba el seguimiento ANTES del pago: una fila con este valor es,
-- por construcción, un pedido con contacto registrado y sin próximo contacto
-- pactado.

-- `recomputed_at` no se toca: nadie recalculó desde la fuente, solo se movió la
-- etiqueta. Marcarlo mentiría sobre la frescura de la fila.

update order_master
   set macro_substage = 'por_confirmar',
       macro_reasons = case
         when macro_reasons @> array['pago_requerido_pendiente'] then macro_reasons
         -- El tipo explícito no es adorno: sin él Postgres resuelve el literal
         -- como text[] y falla con «malformed array literal».
         else macro_reasons || 'pago_requerido_pendiente'::text
       end
 where macro_substage = 'pago_requerido_pendiente';

-- ---- 0100 ----
-- 0100 — La cobertura COD se decide por COORDENADA, no solo por nombre.
--
-- EL PROBLEMA. `order_coverage_for` probaba cobertura COD casando el nombre del
-- distrito del pedido contra `cost_tariffs`. Pero el nombre no es de fiar:
-- Shopify guarda "Puerto Maldonado" (la ciudad) y Aliclik factura "Tambopata"
-- (el distrito). Nunca casan, y 130 pedidos de Puerto Maldonado —con cobertura
-- COD real (18,50, 161 envíos)— caían a "agencia", mandando al cliente a
-- recoger cuando se le podía entregar en la puerta. El mismo choque afecta a
-- Coronel Portillo (Pucallpa), San Román (Juliaca) y otras capitales.
--
-- LA IDEA. Aliclik resuelve la ubicación por lat/lng, no por texto. Nosotros
-- tenemos coordenada en el 99,6% de los pedidos. Así que además del match por
-- nombre, se comprueba si el pedido cae CERCA de un punto donde Aliclik ya
-- entregó COD. Validado con datos: los casos cubiertos están a <2 km de un
-- punto COD; los que son de verdad agencia (Huanta, Nazca, Camaná), a >20 km.
-- El hueco es tan limpio que un umbral de 10 km no se equivoca.
--
-- SIN PostGIS. La base solo tiene pg_trgm, así que la distancia va con haversine
-- a mano y un pre-filtro por caja (lat/lng ± grados) que el índice sí aprovecha.

-- ---------------------------------------------------------------------------
-- 1. El mapa de puntos COD: dónde Aliclik ya entregó a domicilio.
-- ---------------------------------------------------------------------------
create table if not exists aliclik_cod_points (
  org_id uuid not null,
  lat double precision not null,
  lng double precision not null,
  primary key (org_id, lat, lng)
);

-- El pre-filtro por caja filtra por (org_id, lat) y luego acota lng; este índice
-- lo cubre. Los puntos están redondeados a ~1,1 km (2 decimales), así que la
-- tabla es pequeña y la búsqueda toca un puñado de filas por pedido.
create index if not exists aliclik_cod_points_org_lat_lng
  on aliclik_cod_points (org_id, lat, lng);

-- Reconstruye el mapa desde las guías Aliclik con coordenada que son COD:
-- o bien tuvieron una cotización COD (quoted_delivery_cost), o bien su distrito
-- tiene una tarifa COD viva. Se redondea a 2 decimales para deduplicar por zona.
create or replace function refresh_aliclik_cod_points(p_org_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from aliclik_cod_points p
  where p_org_id is null or p.org_id = p_org_id;

  insert into aliclik_cod_points (org_id, lat, lng)
  select distinct
    st.org_id,
    round(s.latitude::numeric, 2)::double precision,
    round(s.longitude::numeric, 2)::double precision
  from shipments s
  join stores st on st.id = s.store_id
  where s.latitude is not null
    and s.longitude is not null
    and coverage_norm(s.courier) like '%ali%'
    and (p_org_id is null or st.org_id = p_org_id)
    and (
      s.quoted_delivery_cost is not null
      or exists (
        select 1
        from cost_tariffs t
        where t.org_id = st.org_id
          and t.concept = 'primer_intento'
          and coverage_norm(t.courier) not in ('shalom', 'olva', 'olva courier')
          and t.district is not null
          and (t.effective_to is null or t.effective_to >= current_date)
          and coverage_norm(t.district) = coverage_norm(s.district)
      )
    )
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ¿Hay algún punto COD a menos de p_km de (p_lat, p_lng)?
-- Caja de bounding primero (barata, indexada), haversine después (exacta).
create or replace function aliclik_cod_point_near(
  p_org_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_km double precision
)
returns boolean
language sql
stable
parallel safe
set search_path = public
as $$
  select case
    when p_org_id is null or p_lat is null or p_lng is null or abs(p_lat) >= 89 then false
    else exists (
      select 1
      from aliclik_cod_points p
      where p.org_id = p_org_id
        and p.lat between p_lat - (p_km / 111.0) and p_lat + (p_km / 111.0)
        and p.lng between p_lng - (p_km / (111.0 * cos(radians(p_lat))))
                      and p_lng + (p_km / (111.0 * cos(radians(p_lat))))
        and 6371.0 * acos(least(1.0, greatest(-1.0,
              sin(radians(p_lat)) * sin(radians(p.lat)) +
              cos(radians(p_lat)) * cos(radians(p.lat)) * cos(radians(p.lng - p_lng))
            ))) <= p_km
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. La clasificación, ahora con coordenada.
-- ---------------------------------------------------------------------------
create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_lat double precision,
  p_lng double precision,
  p_day date default current_date
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_region text := coverage_norm(p_region);
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
begin
  -- Regla comercial explícita. Gana incluso a una tarifa o a un punto cercano.
  if v_province = 'canete' or v_district = 'canete' or v_district like '% canete' then
    return 'agencia';
  end if;

  if is_lima_metropolitana(p_region, p_province, p_district) then
    return 'lima';
  end if;

  select org_id into v_org_id from stores where id = p_store_id;

  -- COD por nombre: la tarifa casa por región/provincia/distrito.
  if exists (
    select 1
    from cost_tariffs t
    where t.org_id = v_org_id
      and t.concept = 'primer_intento'
      and t.courier is not null
      and coverage_norm(t.courier) not in ('shalom', 'olva', 'olva courier')
      and (t.region is not null or t.province is not null or t.district is not null)
      and t.effective_from <= p_day
      and (t.effective_to is null or t.effective_to >= p_day)
      and (t.store_id is null or t.store_id = p_store_id)
      and (t.region is null or coverage_norm(t.region) = v_region)
      and (t.province is null or coverage_norm(t.province) = v_province)
      and (t.district is null or coverage_norm(t.district) = v_district)
  ) then
    return 'provincia_cod';
  end if;

  -- COD por coordenada: cae cerca de donde Aliclik ya entregó COD. Resuelve el
  -- choque de nombres (Puerto Maldonado ≡ Tambopata) sin listas que mantener.
  -- Funciona incluso sin distrito legible, porque la coordenada no lo necesita.
  if aliclik_cod_point_near(v_org_id, p_lat, p_lng, 10.0) then
    return 'provincia_cod';
  end if;

  -- Sin distrito ni coordenada útil no hay a dónde despachar ni cómo ubicarlo.
  if v_district = '' then
    return 'por_revisar';
  end if;

  return 'agencia';
end;
$$;

-- La firma vieja (sin coordenada) queda como envoltorio: cualquier llamador
-- externo sigue funcionando, solo que sin el desempate por cercanía.
create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_day date default current_date
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select order_coverage_for(
    p_store_id, p_region, p_province, p_district,
    null::double precision, null::double precision, p_day
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Recalculo y trigger pasan la coordenada.
-- ---------------------------------------------------------------------------
create or replace function refresh_order_coverage(p_org_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update order_master om
  set coverage = order_coverage_for(
    om.store_id, om.region, om.province, om.district,
    om.latitude, om.longitude, current_date
  )
  where p_org_id is null
     or exists (
       select 1 from stores s
       where s.id = om.store_id and s.org_id = p_org_id
     );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function order_master_set_coverage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Igual que antes, se evita recalcular si nada relevante cambió — pero ahora
  -- la COORDENADA también cuenta: corregir el pin puede cambiar la cobertura.
  if tg_op = 'UPDATE'
    and new.store_id is not distinct from old.store_id
    and new.region   is not distinct from old.region
    and new.province is not distinct from old.province
    and new.district is not distinct from old.district
    and new.latitude  is not distinct from old.latitude
    and new.longitude is not distinct from old.longitude
    and new.coverage is not distinct from old.coverage
  then
    return new;
  end if;

  new.coverage := order_coverage_for(
    new.store_id, new.region, new.province, new.district,
    new.latitude, new.longitude, current_date
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Permisos.
-- ---------------------------------------------------------------------------
revoke all on function refresh_aliclik_cod_points(uuid) from public, anon, authenticated;
revoke all on function aliclik_cod_point_near(uuid, double precision, double precision, double precision)
  from public, anon, authenticated;
revoke all on function order_coverage_for(uuid, text, text, text, double precision, double precision, date)
  from public, anon, authenticated;
grant execute on function refresh_aliclik_cod_points(uuid) to service_role;
grant execute on function aliclik_cod_point_near(uuid, double precision, double precision, double precision)
  to service_role;
grant execute on function order_coverage_for(uuid, text, text, text, double precision, double precision, date)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Construir el mapa y reclasificar todo.
-- ---------------------------------------------------------------------------
select refresh_aliclik_cod_points(null);
select refresh_order_coverage(null);

-- ---- 0101 ----
-- 0101 — Índice para el historial del cliente por teléfono.
--
-- La ficha previa a la llamada (§8) busca los pedidos anteriores del MISMO
-- teléfono, sin filtrar por tienda: el cliente es la misma persona compre en
-- Kenku o en Aurela, y unos anulados en una tienda son un antecedente en la
-- otra. La RLS ya limita lo que cada quien puede ver.
--
-- El índice que existía —`order_master(store_id, customer_phone)`, de 0045— no
-- sirve para esa consulta: el teléfono no es su primera columna, así que buscar
-- solo por teléfono recorre la tabla entera. Con ~11.500 pedidos hoy pasa
-- desapercibido; se paga en cada apertura de un pedido en confirmación, que es
-- la pantalla donde más se abre y cerrar.
--
-- Parcial: un pedido sin teléfono no tiene historial que buscar, y son
-- suficientes para que valga la pena no indexarlos.

create index if not exists order_master_phone_history_idx
  on order_master(customer_phone)
  where customer_phone is not null;

comment on index order_master_phone_history_idx is
  'Historial del cliente por teléfono, entre tiendas (MOM §8.1).';

-- ---- 0102 ----
-- 0102 — Semáforo de salud de la API de Aliclik.
--
-- Un cron sondea la API de cotización cada 5 min (solo 7am–11pm Perú) y deja
-- aquí el resultado. El drawer lee la última fila por org y pinta un foco:
-- verde (operativo), rojo (fallos) o gris (sin sonda reciente = de noche o cron
-- caído). Es append-only: sirve para el foco hoy y para un histórico/uptime
-- mañana sin cambiar nada.

create table if not exists aliclik_health_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  checked_at timestamptz not null default now(),
  -- 'operativo' | 'fallos'. El gris NO se guarda: se deduce de la frescura.
  status text not null check (status in ('operativo', 'fallos')),
  probes_total integer not null,
  probes_ok integer not null,
  latency_ms integer,
  -- Resultado por punto de referencia, para el histórico.
  detail jsonb not null default '[]'::jsonb
);

-- El drawer pide "la última de esta org": este índice la sirve directo.
create index if not exists aliclik_health_checks_org_recent
  on aliclik_health_checks (org_id, checked_at desc);

revoke all on table aliclik_health_checks from public, anon, authenticated;
grant select on table aliclik_health_checks to authenticated;
grant all on table aliclik_health_checks to service_role;

alter table aliclik_health_checks enable row level security;

-- Lectura: un miembro de la org ve la salud de SU org. La salud no es un dato
-- sensible, pero se cierra por org con el mismo helper que el resto del esquema.
drop policy if exists aliclik_health_read on aliclik_health_checks;
create policy aliclik_health_read on aliclik_health_checks
  for select
  using (org_id in (select auth_org_ids()));

-- Escritura: solo el cron (service_role), que salta RLS. Nadie más inserta.

-- ---- 0103 ----
-- Identificadores nuevos de WhatsApp en `leads`: BSUID y username.
--
-- Meta está migrando la identidad de WhatsApp del teléfono al BSUID (Business
-- Scoped User ID). Desde abril de 2026 los webhooks traen `user_id` junto al
-- teléfono; desde el rollout de usernames, un usuario que adopta uno puede dejar
-- de compartir su número, y `wa_id`/`from` pasan a venir AUSENTES (no vacíos).
--
-- Esto NO es urgente para nosotros: Kapso persiste teléfono y BSUID juntos en el
-- registro de la conversación, así que el mapeo se puede reconstruir desde ahí en
-- cualquier momento (los leads guardan `kapso_conversation_id`). Se guarda igual
-- para no depender de un tercero para reconstruir nuestra propia base.
--
-- Por ahora SOLO se escriben. Nada empareja ni deduplica por estos campos: la
-- clave sigue siendo (store_id, phone). Cambiar esa clave es el paso caro y
-- riesgoso, y no compra nada hasta que exista el primer lead sin teléfono — que
-- es justo lo que mide el contador `sinTelefono` del reporte de sync.
--
-- OJO al empezar a usarlos: un BSUID está scopeado a un BUSINESS PORTFOLIO, no a
-- un número ni a una WABA. La misma persona tiene un BSUID distinto en Aurela que
-- en Kenku, y no son comparables entre sí. Por eso la unicidad, cuando llegue el
-- momento, va por (store_id, bsuid) y nunca por bsuid solo.

alter table leads
  add column if not exists bsuid text,
  add column if not exists username text;

-- Formato: PE.xxxx… / US.xxxx…, con el segmento ENT en la variante "parent"
-- (US.ENT.xxxx…). Se valida la FORMA, no el contenido, para que un teléfono mal
-- ruteado a esta columna falle de entrada en vez de emparejar con la persona
-- equivocada más adelante. 135 caracteres: un parent BSUID es más largo de lo que
-- uno espera.
alter table leads
  drop constraint if exists leads_bsuid_format;
alter table leads
  add constraint leads_bsuid_format
  check (bsuid is null or bsuid ~ '^[A-Za-z]{2}\.(ENT\.)?[A-Za-z0-9]{1,128}$');

-- Búsqueda por BSUID dentro de una tienda: el orden de columnas es el de la clave
-- futura (store_id, bsuid). Parcial porque hoy casi todas las filas son null.
create index if not exists leads_store_bsuid
  on leads (store_id, bsuid)
  where bsuid is not null;

-- ---- 0104 ----
-- 0104 — Bitácora cruda del "Live Chat Webhook" de Chatby.
--
-- POR QUÉ UNA BITÁCORA Y NO LA TABLA DEFINITIVA
--
-- La API de Chatby (white-label de uChat) NO expone lectura de mensajes: sus
-- endpoints de conversación devuelven agregados (`in_messages`, `agent_messages`,
-- tiempos) y el modelo `Subscriber` solo trae `last_message_at` y
-- `last_message_type` — nunca el cuerpo. La única fuente del texto es este
-- webhook, que empuja los mensajes ENTRANTES cuando el bot está pausado.
--
-- Como no hay forma de pedir el histórico, TODO lo que no se guarde mientras el
-- webhook está apagado se pierde para siempre. Por eso esta tabla existe antes
-- que el diseño definitivo: primero se deja de perder historia, después se
-- modela con payloads reales en la mano en vez de suposiciones.
--
-- Es APPEND-ONLY y SIN PÉRDIDA a propósito: guarda el JSON completo tal como
-- llegó. Cuando exista `chatby_messages`, se rellena DESDE ACÁ — nada de lo
-- capturado en el período de aprendizaje se tira.
--
-- MEDIDO EN PRODUCCIÓN (2026-08-05): ESTE WEBHOOK NO CUBRE WHATSAPP.
--
-- La prueba: con el bot pausado se mandaron dos mensajes ENTRANTES de WhatsApp.
-- Cero entregas — y en los logs de Vercel no hay NINGUNA petición a esta ruta en
-- ese minuto. No es un 401 ni un error de configuración: Chatby no lo intentó.
-- La configuración estaba bien, porque el ping de validación del Save sí llegó y
-- sí escribió fila con esa misma URL y esa misma cabecera.
--
-- O sea que "Live Chat" en Chatby significa su WIDGET WEB, no WhatsApp. Encaja
-- con el resto de esa zona de ajustes (el Secret Key y `window.$chatbot.setUser`
-- son del widget del navegador).
--
-- LA TABLA Y EL RECEPTOR SE CONSERVAN, y no por optimismo: el paso "External
-- Request" del flow builder — que sí corre sobre las conversaciones de WhatsApp —
-- puede POSTear a esta misma ruta con la misma cabecera. El receptor no está
-- atado a la integración que lo motivó.
--
-- OJO CON EL ALCANCE (limitaciones del propio webhook, no nuestras):
--   · Solo dispara con el bot PAUSADO. La fase en que el bot conversa no llega.
--   · Solo mensajes ENTRANTES. Los salientes los emitimos nosotros vía
--     `POST /subscriber/send-content`, y quedan en nuestra outbox.
--   · Se configura POR CUENTA, no por bot: un solo webhook para Aurela y Kenku.
--     Por eso NO hay `store_id` todavía — resolver la tienda exige saber qué trae
--     el payload (¿id de bot?, ¿número de WhatsApp de destino?), que es
--     justamente lo que esta bitácora viene a averiguar. Escribirlo a ciegas
--     sería peor que dejarlo nulo: mandaría mensajes a la tienda equivocada.

create table if not exists chatby_webhook_log (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  -- Extracción best-effort: `user_ns` es la clave del subscriber en la API de
  -- Chatby (aparece en el modelo Subscriber y la piden todos sus endpoints), así
  -- que buscarla no es adivinar, es su propio vocabulario. Nula si no viene: el
  -- objetivo es no perder la entrega, nunca rechazarla.
  user_ns text,
  -- Nombres de las cabeceras recibidas, SIN valores. Sirve para descubrir si
  -- Chatby manda alguna firma o id de idempotencia que convenga verificar más
  -- adelante. Los valores no se guardan nunca: uno de ellos es nuestro secreto.
  header_names text[] not null default '{}',
  -- ¿El cuerpo era JSON válido? Si no, `payload` lo conserva como {"_raw": "..."}
  -- en vez de descartarlo.
  parsed boolean not null default true,
  payload jsonb not null
);

-- El uso es "las últimas N entregas" mientras se diseña, y más adelante "todo lo
-- de este subscriber" para el backfill.
create index if not exists chatby_webhook_log_recent
  on chatby_webhook_log (received_at desc);
create index if not exists chatby_webhook_log_user_ns
  on chatby_webhook_log (user_ns, received_at desc)
  where user_ns is not null;

revoke all on table chatby_webhook_log from public, anon, authenticated;
grant all on table chatby_webhook_log to service_role;

alter table chatby_webhook_log enable row level security;

-- SIN POLÍTICAS A PROPÓSITO: RLS activo y cero policies = nadie lee salvo
-- service_role, que salta RLS. Acá hay texto de conversaciones de clientes y
-- todavía no se puede acotar por organización (no sabemos de qué tienda es cada
-- fila). Hasta que exista esa columna, cerrado del todo es la única postura
-- defendible; abrirlo por `authenticated` expondría los mensajes de una tienda a
-- los usuarios de la otra.
