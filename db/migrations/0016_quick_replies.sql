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
