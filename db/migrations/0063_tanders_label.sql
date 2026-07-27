-- ============================================================================
-- 0063_tanders_label.sql — cuándo se generó el rótulo de una guía Tanders.
--
-- Tanders no tiene endpoint de PDF: su panel arma el rótulo en el navegador.
-- Lo único que expone su API es `PATCH /orders/me/{id}/label {generated:true}`,
-- que enciende el "✓ Rótulo generado" de su interfaz.
--
-- Ese flag es el guardarraíl contra imprimir dos etiquetas del mismo paquete, y
-- solo sirve si los dos sistemas coinciden. Se guarda también acá para poder
-- avisar en el Master —"este rótulo ya se imprimió"— sin ir a preguntárselo a
-- su API en cada carga del listado.
--
-- `label_url` (0058) se queda: si algún día publican el PDF, ahí va.
-- ============================================================================

alter table shipments
  add column if not exists label_generated_at timestamptz;

comment on column shipments.label_generated_at is
  'Cuándo se compuso el rótulo de esta guía. Espeja el flag "generado" de Tanders.';
