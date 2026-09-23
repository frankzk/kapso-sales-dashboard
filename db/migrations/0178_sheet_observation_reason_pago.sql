-- ============================================================================
-- 0186_sheet_observation_reason_pago.sql — cuarta causa de observación
-- automática en Liquidaciones 2: pago digital sin comprobante validado.
--
-- Una fila del cuaderno que declara entrega cobrada por Yape, Plin, link o
-- transferencia, cuyo pedido en Kapta no tiene ni un comprobante validado
-- (order_payments.validation_status = 'validado') ni está pagado en Shopify
-- (orders.financial_status = 'paid'), abre una observación «pago» con este
-- motivo (MOM §30.8). Como toda observación abierta, bloquea el cruce al
-- Master hasta que quien liquida la lea y la acepte.
-- ============================================================================
insert into sheet_observation_reasons (code, label, description, position) values
  ('pago_sin_comprobante', 'Pago digital sin comprobante validado', 'La hoja dice Yape, Plin, link o transferencia, pero Kapta no tiene un comprobante validado ni el pedido pagado en Shopify.', 85)
on conflict (code) do nothing;
