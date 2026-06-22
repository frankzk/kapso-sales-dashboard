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
