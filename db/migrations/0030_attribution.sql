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
