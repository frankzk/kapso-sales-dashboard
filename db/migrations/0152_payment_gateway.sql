-- 0152 — Por dónde entró el dinero de un pedido pagado en Shopify.
--
-- POR QUÉ. «Pagado en Shopify» se deducía como pagado por web cuando no había
-- comprobantes cargados (lib/order-paid.ts). Dos fallos de esa deducción:
--   * #KP132708 nació pagado en el checkout (EasySell + PREPAID), alguien subió
--     la captura de Shopify como comprobante, y la regla se apagó: el pedido se
--     quedó pidiendo un adelanto ya cobrado;
--   * al revés, un pedido marcado «pagado» A MANO en Shopify sin comprobante
--     contaba como cobrado por la pasarela.
-- La operación fijó la regla (10-09-2026): solo la pasarela del checkout nace
-- pagada y se salta las constancias; «manual» y COD siguen el conducto regular.
--
-- Shopify lo expone (`paymentGatewayNames` / `payment_gateway_names`); la
-- sincronización no lo pedía. Desde ahora se pide y se clasifica al ingerir
-- (lib/payment-gateway.ts): 'checkout' | 'manual' | 'cod'. NULL = no se sabe,
-- y con NULL manda la regla indirecta de antes: nada cambia para lo viejo.
--
-- Se copia a `order_master` en cada recálculo por lo mismo que 0128: los que
-- deciden si hay cobro leen el Master, y tres lecturas separadas de la misma
-- verdad terminan discrepando — y acá discrepar es cobrar dos veces.
--
-- SIN BACKFILL A PROPÓSITO. Traer la pasarela de los pedidos viejos es una
-- decisión de la operación: 388 pedidos vivos marcados «pagado» sin constancia
-- validada pasarían a exigirla. Se hace aparte, cuando se decida.

alter table orders
  add column if not exists payment_gateway text;
alter table order_master
  add column if not exists payment_gateway text;

comment on column orders.payment_gateway is
  'Por dónde entró el dinero según Shopify (lib/payment-gateway.ts): checkout | manual | cod. '
  'NULL si se sincronizó antes de pedir el dato. Solo checkout se salta las constancias.';
comment on column order_master.payment_gateway is
  'Copiado de orders en cada recálculo (0152). NULL: manda la regla indirecta de order-paid.';
