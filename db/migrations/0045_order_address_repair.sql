-- Marca de cuándo se reconsultó por última vez la dirección de un pedido a
-- Shopify. La usa el cron de reparación (/api/cron/repair-addresses) para dos
-- cosas: atender primero lo que nunca se intentó, y no quedarse girando sobre
-- los pedidos que en Shopify tampoco tienen calle — esos se reintentan recién
-- a la semana en vez de en cada corrida.

alter table orders add column if not exists address_repair_attempted_at timestamptz;

comment on column orders.address_repair_attempted_at is
  'Last time the address was re-fetched from Shopify to repair a missing one. Drives the repair cron order and its retry backoff.';

-- El cron pide los pedidos menos recientemente intentados. Índice con nulls
-- primero para que "nunca intentado" salga sin escanear la tabla.
create index if not exists orders_address_repair_attempted_at_idx
  on orders (address_repair_attempted_at nulls first);
