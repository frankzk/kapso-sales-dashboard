-- ============================================================================
-- 0276_shopify_history_imports.sql — traer el historial de Shopify por API
-- (MOM §37.5, 23-10-2026, pedido de Frankz).
--
-- POR QUÉ. «Probar acceso a pedidos antiguos» dio que el token de Aurela tiene
-- `read_all_orders` y ve los pedidos desde el #1001 (13-04-2021). Entonces el
-- historial se puede traer completo sin exportar CSV a mano: Shopify arma un
-- solo archivo con todos los pedidos (una «bulk operation») y Kapta lo lee por
-- tandas y lo guarda en las MISMAS tablas de la 0273.
--
-- QUÉ NO ES. Igual que la 0273: no son pedidos de Kapta, no entran a `orders`
-- ni a `order_master`, no tienen etapa ni disparan nada.
--
-- shopify_history_imports: una por cada traída (pedidos o clientes de una
-- tienda): la operación de Shopify, su archivo, hasta qué byte se leyó y
-- cuántos registros dejó. Solo una en curso por tienda y tipo.
--
-- Escritura solo con el service role. Lectura: quien ve la tienda.
-- ============================================================================

create table if not exists shopify_history_imports (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references stores(id) on delete cascade,
  kind              text not null check (kind in ('pedidos', 'clientes')),
  -- gid://shopify/BulkOperation/…
  bulk_operation_id text,
  status            text not null default 'preparando'
    check (status in ('preparando', 'importando', 'listo', 'error')),
  -- El archivo JSONL que arma Shopify (vence a los 7 días).
  url               text,
  file_size         bigint,
  object_count      bigint,
  -- Hasta dónde se leyó: la próxima tanda sigue desde aquí.
  bytes_done        bigint not null default 0,
  records           integer not null default 0,
  first_at          timestamptz,
  last_at           timestamptz,
  error             text,
  -- Una tanda a la vez: quien la toma la reserva hasta aquí.
  lease_until       timestamptz,
  started_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create index if not exists shopify_history_imports_store_idx
  on shopify_history_imports (store_id, created_at desc);

create unique index if not exists shopify_history_imports_active_uidx
  on shopify_history_imports (store_id, kind)
  where status in ('preparando', 'importando');

alter table shopify_history_orders add column if not exists import_id uuid
  references shopify_history_imports(id) on delete set null;
alter table shopify_history_customers add column if not exists import_id uuid
  references shopify_history_imports(id) on delete set null;

alter table shopify_history_imports enable row level security;

drop policy if exists shopify_history_imports_select on shopify_history_imports;
create policy shopify_history_imports_select on shopify_history_imports for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on shopify_history_imports to authenticated;
