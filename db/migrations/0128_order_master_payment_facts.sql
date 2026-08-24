-- 0128 — Cómo se cobró el pedido, en el read-model del Master.
--
-- POR QUÉ. Desde que entran pedidos pagados en el checkout, «ya está cobrado»
-- tiene dos vías (ver lib/order-paid.ts) y la de la pasarela vive en `orders`,
-- no en `order_master`. Tres consumidores la necesitan y los tres leen el Master:
--
--   * la compuerta de la clave de recojo — sin esto, un pedido por Agencia
--     pagado con tarjeta no puede recibir NUNCA su clave: no tiene ni una fila
--     en `order_payments`, así que «falta el adelanto» sería cierto para siempre;
--   * el panel de cobro del drawer, que le pedía comprobante de Yape a un pedido
--     ya pagado;
--   * el rótulo, que imprimía el total a cobrar de algo ya cobrado.
--
-- Repetir la consulta a `orders` en cada uno era la alternativa. Se descarta por
-- lo de siempre en este repositorio: tres lecturas separadas de la misma verdad
-- terminan discrepando, y acá discrepar significa cobrar dos veces.
--
-- `financial_status` ya lo leía el recálculo (está en ORDER_COLUMNS); solo no se
-- escribía. `total_refunded` se añade a esa lectura porque un reembolso deshace
-- el prepago.
--
-- SIN BACKFILL A PROPÓSITO. Las filas viejas quedan en NULL hasta que el
-- recálculo las toque, y NULL no cuenta como pagado — o sea, exactamente el
-- comportamiento de hoy. El barrido las irá poniendo al día sin una pasada
-- masiva sobre 15.000 filas, y el lado seguro del error es el de partida.

alter table order_master
  add column if not exists financial_status text,
  add column if not exists total_refunded   numeric(14, 2) not null default 0;

comment on column order_master.financial_status is
  'Estado de cobro de Shopify (`paid` = cobrado en el checkout). Copiado de '
  'orders en cada recálculo. NULL en filas aún no recalculadas: no cuenta como pagado.';
comment on column order_master.total_refunded is
  'Reembolsado según Shopify. Un reembolso deshace el prepago (lib/order-paid.ts).';

-- Los pedidos prepagados son una fracción pequeña y se buscan por sí solos
-- («cuáles están pagados y siguen con cobro»), así que el índice va parcial.
create index if not exists order_master_prepaid_idx
  on order_master (store_id)
  where financial_status = 'paid';
