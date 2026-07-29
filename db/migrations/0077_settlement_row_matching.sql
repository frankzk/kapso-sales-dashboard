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

