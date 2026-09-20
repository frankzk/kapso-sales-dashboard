-- 0171_voucher_intake_switch.sql — el interruptor de la ingesta de comprobantes.
--
-- QUÉ ENCIENDE. Que una imagen llegada al número de cobranza, dentro de las
-- 48 h de un aviso de Shalom, se intente registrar sola como comprobante en
-- `order_payments` (ver lib/shalom/voucher-intake.ts).
--
-- POR QUÉ NACE APAGADO, Y POR QUÉ TIENE INTERRUPTOR PROPIO. Esto escribe filas
-- de DINERO sin que una persona haya mirado la imagen, que es un control que
-- hasta hoy tenía todo comprobante. El control que queda es que entra sin
-- validar y que la clave sigue necesitando validación humana — suficiente para
-- que un error no suelte un paquete, pero no para encenderlo en todas las
-- tiendas a la vez y mirar después.
--
-- Es aparte del interruptor del aviso a propósito: una tienda puede querer
-- avisar sin querer que se le registren pagos solos.

alter table stores
  add column if not exists shalom_voucher_intake_enabled boolean not null default false;

comment on column stores.shalom_voucher_intake_enabled is
  'Registrar solos los comprobantes que llegan por WhatsApp tras un aviso de '
  'Shalom. Apagado: la imagen se queda en el chat, como antes. Nace apagado '
  'porque escribe filas de dinero sin que una persona mire la imagen.';
