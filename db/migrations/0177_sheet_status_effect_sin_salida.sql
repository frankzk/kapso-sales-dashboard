-- ============================================================================
-- 0185_sheet_status_effect_sin_salida.sql — un efecto más para los estados de
-- dominio de Liquidaciones 2: «sin_salida».
--
-- La operación explicó (16-09-2026) qué es «LO DEJA» en el cuaderno del
-- motorizado: el paquete se puso en su caja de reparto pero se quedó en
-- almacén, no salió. No es un intento de entrega, y contarlo como tal (efecto
-- `informa` → marca T) inflaría «# Motos Lima». Por eso un efecto propio que
-- aporta 0 al Consolidado y equivale al operativo `nunca_salio_a_reparto`.
-- ============================================================================
alter table sheet_domain_statuses drop constraint if exists sheet_domain_statuses_effect_check;
alter table sheet_domain_statuses
  add constraint sheet_domain_statuses_effect_check
  check (effect in ('informa', 'entrega', 'devolucion', 'anulacion', 'sin_salida'));
