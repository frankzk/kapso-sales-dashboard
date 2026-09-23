-- 0173_pickup_key_autosend.sql — enviar la clave de recojo al validar el pago.
--
-- QUÉ ENCIENDE. Que al validar el comprobante que termina de cubrir el pedido,
-- Kapta le mande la clave de recojo a la clienta por WhatsApp, en el mismo
-- clic, y registre la entrega (ver lib/pickup-key-message.ts y la acción
-- `validatePayment` con `sendKey`).
--
-- POR QUÉ NACE. Medido el 21-09-2026: 786 pedidos pagados con clave registrada,
-- 770 con la clave ya consultada por alguien y **3** con la entrega registrada.
-- O sea que la clave se entrega —si no habría cientos de reclamos— pero el paso
-- de «registrar que la entregué» es un clic que nadie da, al 0,4 %. El estado
-- «Clave enviada al cliente» del Master era, en la práctica, ficción.
--
-- Mandarla al validar arregla las dos cosas a la vez: se ahorra el copiar y
-- pegar, y el ENVÍO ES EL REGISTRO — no hay un segundo clic que olvidar.
--
-- POR QUÉ NACE APAGADO Y TIENE INTERRUPTOR PROPIO. Esto manda la llave del
-- paquete sin que nadie vuelva a mirar nada después del clic. El control que
-- queda es el de siempre —`canRevealPickupKey` se comprueba otra vez en el
-- servidor, con los datos frescos, antes de descifrar— y que quien valida es
-- una persona que tiene el comprobante delante. Suficiente para encenderlo
-- donde se mira, no para encenderlo en todas las tiendas a la vez.

alter table stores
  add column if not exists shalom_pickup_key_autosend_enabled boolean not null default false;

comment on column stores.shalom_pickup_key_autosend_enabled is
  'Enviar la clave de recojo por WhatsApp al validar el pago que termina de '
  'cubrir el pedido, y registrar esa entrega. Apagado: la clave se consulta y '
  'se entrega a mano, como hasta ahora. Nace apagado porque manda la llave del '
  'paquete sin que nadie vuelva a mirar después del clic.';
