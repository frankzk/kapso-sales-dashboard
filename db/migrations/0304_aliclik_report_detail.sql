-- ============================================================================
-- 0304_aliclik_report_detail.sql — el detalle que el Excel de Aliclik trae y
-- Kapta no guardaba: «SUB ESTADO» y «ÚLTIMO COMENTARIO MOTORIZADO» (MOM §11,
-- owner 03-11-2026).
--
-- POR QUÉ. La API de Aliclik solo da tres estados (entrega, despacho,
-- llamada): «CANCEL · TO_RETURN · CONFIRMED» no dice por qué. El Excel del
-- portal sí: CANCELADO · DE VIAJE, · POR CLIENTE, · NO CONFIRMADO,
-- · DEVOLUCIÓN EXCESIVA, · FUERA DE COBERTURA, y el último comentario del
-- motorizado («Cliente desea la entrega el próximo sábado»). En 30 días de
-- imports: 311 cancelados con subestado y 169 de 174 «no contesta» con
-- comentario.
--
-- QUÉ CAMBIA. Dos columnas en `shipments`, que escribe la importación del
-- Excel (lib/aliclik-ingest.ts) con lo que trae el reporte más reciente. No
-- cambia datos. Correrla otra vez no cambia nada.
-- ============================================================================

alter table public.shipments
  add column if not exists aliclik_sub_status text,
  add column if not exists aliclik_rider_comment text;

comment on column public.shipments.aliclik_sub_status is
  'SUB ESTADO del Excel de Aliclik (DE VIAJE, POR CLIENTE, NO CONFIRMADO…), del reporte más reciente.';
comment on column public.shipments.aliclik_rider_comment is
  'ÚLTIMO COMENTARIO MOTORIZADO del Excel de Aliclik, limpio (sin «-», «.» ni letras sueltas), del reporte más reciente.';
