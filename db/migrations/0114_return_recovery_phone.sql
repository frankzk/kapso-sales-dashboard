-- ============================================================================
-- 0114_return_recovery_phone.sql — número propio para la recuperación de
-- devueltos.
--
-- La recuperación es el ÚNICO envío que puede querer salir de otro número. El
-- resto sigue como está y no se toca:
--
--   drip y carritos  → ya salen del número por el que escribió la clienta
--                      (`leads.wa_phone_number_id`), con respaldo al de la
--                      tienda. Esta columna no los afecta.
--   browse, winback  → número de la tienda.
--   drawer           → número del hilo activo.
--
-- Por qué la recuperación es distinta: su mensaje pide **dinero por adelantado**
-- a clientas cuya entrega ya falló. Es el envío con más riesgo de reporte del
-- sistema, y un reporte le baja la calidad a la WABA entera —MOM §11.1: «le
-- cuesta la plantilla a TODA la tienda»—. Poder aislarlo en una línea aparte
-- evita que un mal lote arrastre al número que sostiene el drip, los carritos y
-- las confirmaciones.
--
-- El aislamiento solo es sano si esa línea ATIENDE la respuesta: la clienta
-- acepta y alguien tiene que mandarle el número de cuenta (MOM §11.1). Un número
-- que solo dispara y no escucha rompe el circuito en el paso que lo hacía
-- rentable. Por eso nace NULL: sin decisión explícita, todo sigue saliendo del
-- número de la tienda, exactamente como hasta ahora.
-- ============================================================================
alter table stores
  add column if not exists return_recovery_phone_number_id text;

comment on column stores.return_recovery_phone_number_id is
  'Número (phone_number_id de Meta) desde el que sale la plantilla de recuperación de devueltos. NULL = el de la tienda. Solo afecta a este envío. La plantilla debe estar aprobada en la WABA de ESTE número, y esa línea debe atender la respuesta.';
