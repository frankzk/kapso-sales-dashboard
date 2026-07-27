-- 0058 — Separar lo cobrado que NO pasa por las manos de quien liquida.
--
-- El Yape del cliente cae a la cuenta de la empresa (Grupo GF SAC), y el POS lo
-- cobra el terminal: ninguna de las dos es plata que el motorizado tenga que
-- devolver. Yo las estaba sumando a lo que debía depositar, así que su cuadre
-- habría salido corto TODOS los días por el importe exacto de lo que cobró por
-- esos canales — un descuadre inventado que le habría costado explicaciones a
-- alguien que no hizo nada malo.
--
-- La confusión venía de mezclar dos preguntas distintas en los mismos campos:
--
--   `declared_cash` / `declared_yape`  →  CÓMO DEPOSITA lo que debe.
--   `direct_collected` (esta columna)  →  QUÉ COBRÓ QUE YA ESTÁ EN CASA.
--
-- Con las dos separadas, las dos formas de trabajar cuadran con la misma regla:
--
--   Axel cobra todo en la calle y deposita por transferencia:
--     cobrado 2,219.73 − comisión 146.00 − directo 0 = deposita 2,073.73 ✓
--
--   Un motorizado propio cobra 1,000 en efectivo, 200 por Yape a la empresa y
--   100 por POS:
--     cobrado 1,300 − comisión 0 − directo 300 = entrega 1,000 en la mano ✓

alter table rider_settlements
  add column if not exists direct_collected numeric(12, 2) not null default 0;

comment on column rider_settlements.direct_collected is
  'Cobrado que fue DIRECTO a la empresa (Yape a la cuenta, POS) y por tanto '
  'nunca pasó por las manos de quien liquida. Se descuenta de lo que debe '
  'depositar; no es un descuadre.';
