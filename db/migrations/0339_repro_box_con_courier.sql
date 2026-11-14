-- ============================================================================
-- 0339_repro_box_con_courier.sql — Repro Lima reconoce la salida viva de otro
-- courier (owner, 13-11-2026: «cablea todas las conexiones para que no vuelva
-- a suceder»).
--
-- POR QUÉ. Un acuerdo «Sale sáb 14/11 con Swayp» seguía pidiendo «crea la
-- salida en la Mesa de ruta» con la salida de Swayp ya creada (#KP205892,
-- #KP205878), y la caja salía «No consta» aunque estuviera armada en oficina.
-- Kapta ahora dice dónde está la caja también cuando la tiene otro courier
-- (`con_courier`, lib/repro-lima.ts). La fila del acuerdo guarda esa
-- ubicación al registrar la llamada (`lima_repro_cases.box_location`), así que
-- el CHECK la admite.
--
-- No toca filas. Correrla otra vez no cambia nada.
-- ============================================================================

alter table public.lima_repro_cases drop constraint if exists lima_repro_cases_box_location_check;
alter table public.lima_repro_cases add constraint lima_repro_cases_box_location_check
  check (box_location = any (array['con_motorizado'::text, 'en_oficina'::text, 'volviendo_courier'::text, 'con_courier'::text, 'desconocida'::text]));
