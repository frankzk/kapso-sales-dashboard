-- 0076_payment_total.sql — permite registrar un único comprobante por el total
-- del pedido, como alternativa al flujo adelanto + diferencia.

alter table order_payments
  drop constraint if exists order_payments_kind_check;

alter table order_payments
  add constraint order_payments_kind_check
  check (kind in ('adelanto', 'diferencia', 'total'));

comment on column order_payments.kind is
  'Tipo de pago: adelanto y diferencia forman un flujo parcial; total cancela el pedido en un solo comprobante.';
