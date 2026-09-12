-- ============================================================================
-- 0158_order_payments_cobro_courier.sql — el cobro que hace el courier entra a
-- la cola de «Validar pagos», donde lo confirma una PERSONA.
--
-- POR QUÉ. El lector de imágenes de los cobros Tanders sabe decir «este yape es
-- de S/ 198 y va a Grupo GF SAC», pero no sabe si el dinero llegó a la cuenta:
-- valida UNA IMAGEN, no un depósito. Mientras no haya conexión con el estado de
-- cuenta del banco, quien declara que el dinero entró tiene que ser una
-- persona. Y esa persona ya tiene su sitio: `order_payments` y la pantalla de
-- validación, que existen desde 0049.
--
-- LO QUE SE HEREDA AL ENTRAR AQUÍ, y que la vía paralela de Tanders no tenía:
--   · nº de operación ÚNICO en todo el sistema (índice de 0049);
--   · huella sha256 del archivo, que atrapa la misma imagen renombrada —es lo
--     que habría cazado el «198yape.png» reusado sin depender de leer bien el
--     número—;
--   · la coincidencia difusa de monto + fecha + pagador (lib/yape-dedup.ts);
--   · el campo `vision` para auditar qué leyó el modelo;
--   · y `validated_by` / `validated_at`: quién dio el dinero por recibido.
--
-- `cobro_courier` es un tipo NUEVO y no se reusa `total` a propósito: «la
-- clienta transfirió todo» y «el motorizado cobró en efectivo y lo remitió» son
-- procedencias distintas, con riesgos distintos, y quien revisa necesita saber
-- cuál de las dos tiene delante. Además el índice único (order_id, kind) las
-- deja convivir en un mismo pedido.
-- ============================================================================

alter table order_payments drop constraint if exists order_payments_kind_check;
alter table order_payments add constraint order_payments_kind_check
  check (kind in ('adelanto', 'diferencia', 'total', 'cobro_courier'));

comment on column order_payments.kind is
  'adelanto | diferencia | total (los paga la clienta) | cobro_courier (lo cobró el motorizado y lo remitió a Grupo GF SAC).';
