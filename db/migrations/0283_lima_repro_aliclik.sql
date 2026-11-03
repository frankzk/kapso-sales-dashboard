-- ============================================================================
-- 0283_lima_repro_aliclik.sql — Repro Lima acuerda con Aliclik en lugar de
-- Tanders (MOM §9, «Aliclik en Lima», 26-10-2026, decisión del owner).
--
-- Desde el 26-10-2026 Tanders no crea guías nuevas y Aliclik entra a Lima, solo
-- con AUTOECOM. La hoja de Repro Lima ofrece Aliclik donde ofrecía Tanders, y
-- `lima_repro_cases.agreed_courier` y `lima_repro_calls.courier` tienen que
-- admitirlo. `tanders` se queda en la lista: hay acuerdos guardados con él.
--
-- Solo cambian los dos CHECK; no toca filas. Sin ella, elegir Aliclik en la hoja
-- falla con el error del CHECK y los demás couriers siguen igual.
-- ============================================================================

alter table public.lima_repro_cases
  drop constraint if exists lima_repro_cases_agreed_courier_check;

alter table public.lima_repro_cases
  add constraint lima_repro_cases_agreed_courier_check
  check (agreed_courier in ('propio', 'aliclik', 'tanders', 'fenix', 'urpi', 'axel'));

-- La llamada que cerró el acuerdo guarda el mismo courier.
alter table public.lima_repro_calls
  drop constraint if exists lima_repro_calls_courier_check;

alter table public.lima_repro_calls
  add constraint lima_repro_calls_courier_check
  check (courier in ('propio', 'aliclik', 'tanders', 'fenix', 'urpi', 'axel'));
