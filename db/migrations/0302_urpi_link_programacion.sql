-- ============================================================================
-- 0302_urpi_link_programacion.sql — un intento del reporte de Urpi también se
-- vincula por la programación enviada (MOM §30.10, §30.11; owner 03-11-2026).
--
-- POR QUÉ. El reporte de Urpi no trae código de pedido y se vincula por
-- teléfono (0229). Cuando el teléfono tiene varios pedidos en los 45 días, o
-- ninguno, el intento queda «por vincular». La programación que enviamos a Urpi
-- sí trae el código exacto, con su teléfono y su día: auditoría del 26/10 al
-- 02/11, 13 de los 15 pedidos programados sin vínculo estaban «por vincular»
-- por teléfono repetido, y uno (#KP130409) no tenía pedido en la ventana.
--
-- QUÉ CAMBIA. Solo el vocabulario de `urpi_report_rows.link_method`: se suma
-- `programacion`, el vínculo que sale de una fila programada el mismo día con
-- el mismo teléfono y un solo pedido. No cambia datos, funciones ni permisos:
-- `save_urpi_report_batch` ya guarda el método que le llega y respeta el manual.
--
-- Correrla otra vez no cambia nada.
-- ============================================================================

alter table public.urpi_report_rows drop constraint if exists urpi_report_rows_link_method_check;
alter table public.urpi_report_rows add constraint urpi_report_rows_link_method_check
  check (link_method in ('telefono','cadena','manual','programacion'));
