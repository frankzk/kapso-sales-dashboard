-- ============================================================================
-- 0180_stop_written_status.sql — la parada de reparto es la única verdad;
-- la hoja de Reparto propio de Liquidaciones 2 pasa a ser una vista con
-- vocabulario encima de ella.
--
-- POR QUÉ (informe del 19-09-2026, §5). El mismo hecho físico —«Roy fue a la
-- casa de la clienta y cobró S/ 89»— se escribía dos veces en dos modelos que
-- no se hablaban: `delivery_stops` (fila tipada con FK a `orders`, evidencia
-- obligatoria y validación contra el saldo real, que es lo que Rutas y Grupo GF
-- Courier ya usan) y `sheet_rows` de la hoja cuaderno (texto libre + alias +
-- observaciones, que es lo que la operación sabe leer). Dos pantallas del
-- motorizado en la misma URL base y dos puertas al Master con guardas
-- distintas. La decisión: Rutas manda porque su lógica se usa; Liquidaciones 2
-- es la capa de vocabulario, observaciones y cuadre ENCIMA, no una copia.
--
-- QUÉ CAMBIA AQUÍ.
--   * `delivery_stops` aprende lo que solo la hoja sabía decir: el estado
--     ESCRITO literal por el motorizado (`written_status`), el código del
--     estado del dominio Reparto propio al que resolvió (`written_status_code`,
--     null = sin equivalente, la fila queda a revisión) y el método de pago
--     escrito (`written_payment`). El enum de tres estados y el motivo del
--     catálogo siguen mandando para el cierre de ruta y el Master; el detalle
--     («LO DEJA», «DESARMAR», «CEL APAGADO») ya no se pierde.
--   * `sheet_rows.stop_id`: la fila del cuaderno apunta a su parada. Única por
--     parada: una parada, una fila. Las filas importadas del Excel histórico
--     no tienen parada y siguen valiendo tal cual (MOM §30.7).
--   * `sheet_observation_gate` queda reservado (sin uso todavía) para marcar
--     desde la parada que una observación abierta la retiene.
-- ============================================================================

alter table delivery_stops
  add column if not exists written_status text,
  add column if not exists written_status_code text,
  add column if not exists written_payment text,
  add column if not exists sheet_observation_gate boolean not null default false;

alter table sheet_rows
  add column if not exists stop_id uuid references delivery_stops(id) on delete set null;

create unique index if not exists sheet_rows_stop_idx
  on sheet_rows(stop_id) where stop_id is not null;
