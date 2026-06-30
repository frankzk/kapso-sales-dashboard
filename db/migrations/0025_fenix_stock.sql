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
