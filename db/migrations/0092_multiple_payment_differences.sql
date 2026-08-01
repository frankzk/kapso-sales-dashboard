-- 0092_multiple_payment_differences.sql
-- El primer comprobante es Adelanto o Pago total. Después de un adelanto se
-- permiten tantas diferencias como pagos reales haga el cliente hasta cubrir
-- el monto del pedido. La operación y la huella del archivo siguen siendo
-- únicas, por lo que repetir diferencias no relaja la protección anti-duplicado.

drop index if exists order_payments_kind_uniq;

create unique index if not exists order_payments_initial_payment_uniq
  on order_payments(order_id)
  where validation_status <> 'rechazado'
    and kind in ('adelanto', 'total');

comment on index order_payments_initial_payment_uniq is
  'Un pedido tiene un único primer pago vivo: adelanto o pago total. Diferencia admite varios comprobantes.';
