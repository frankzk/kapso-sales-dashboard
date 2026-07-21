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
