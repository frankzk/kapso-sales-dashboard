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
