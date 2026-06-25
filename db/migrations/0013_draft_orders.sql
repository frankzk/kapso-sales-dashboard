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
