-- ============================================================================
-- 0165_fenix_stock_unlimited.sql — stock SIN CONTROL DE CANTIDAD por renglón.
--
-- Lima entró a la cobertura Swayp el 14-09-2026 y la operación decidió no
-- contar unidades ahí: la bodega de Lima repone sola y lo que importa es QUÉ
-- productos despacha, no cuántos hay. Un renglón con `unlimited = true` dice
-- «este producto existe en esa bodega» y nada más:
--
--   - la reja de elegibilidad lo trata como disponible sin mirar `quantity`;
--   - la entrega no lo descuenta (no hay saldo que llevar);
--   - el reporte de demanda nunca lo marca como faltante;
--   - el importador del Excel de Swayp no lo pisa ni lo pone en 0.
--
-- Es por renglón y no por ciudad a propósito: mañana un producto de Lima puede
-- pasar a contarse sin tocar a los demás, y una ciudad contada puede tener un
-- producto que no se cuenta.
-- ============================================================================

alter table fenix_stock
  add column if not exists unlimited boolean not null default false;

comment on column fenix_stock.unlimited is
  'Sin control de cantidad: el producto existe en la bodega y se considera siempre disponible. quantity se ignora.';
