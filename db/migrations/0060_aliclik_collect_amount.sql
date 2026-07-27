-- 0060 — Lo que Aliclik dice que va a cobrar en la puerta.
--
-- POR QUÉ. La primera guía creada por API quedó cobrando S/447 cuando la
-- clienta debía pagar S/298: los precios que mandábamos eran los de LISTA de
-- Shopify, sin descuentos. El fallo se descubrió a ojo, mirando una captura del
-- panel de Aliclik. Nada en el dashboard lo habría detectado.
--
-- `GET /integration/order` ya devuelve `total`, y el cron de reconciliación ya
-- lo consulta cada 20 minutos — pero lo tiraba a la basura y guardaba solo los
-- estados. Persistirlo convierte esa pasada en un detector permanente:
--
--   * cuadra lo que Aliclik cobrará contra el total real del pedido;
--   * pilla también las ediciones hechas A MANO en el panel de Aliclik, de las
--     que hoy el dashboard no se entera de nada.
--
-- Se guarda el dato crudo, sin interpretar. La regla de qué cuenta como
-- descuadre vive en `lib/aliclik-money.ts` (`collectAmountMismatch`), donde se
-- puede probar y cambiar sin tocar la base.

alter table shipments
  add column if not exists reported_collect_amount numeric;

comment on column shipments.reported_collect_amount is
  'Monto que Aliclik declara que cobrará en la entrega (GET /integration/order → total). '
  'Lo escribe el cron de reconciliación en cada pasada. Comparado con orders.total_amount '
  'delata guías creadas o editadas con el importe equivocado.';

-- Índice parcial: las consultas de descuadre solo miran las guías que ya tienen
-- monto reportado, que son una fracción del total de envíos.
create index if not exists shipments_collect_amount_idx
  on shipments (store_id, reported_collect_amount)
  where reported_collect_amount is not null;
