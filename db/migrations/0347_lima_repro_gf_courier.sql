-- ============================================================================
-- 0347_lima_repro_gf_courier.sql — Repro Lima acuerda con GF Courier por API
-- (MOM §9.5 y §29.17; decisión del owner, 15-11-2026: «Sí, haz lo de GF
-- Courier en los acuerdos. En el caso de GF Courier la guía ya podría quedar
-- generada para esa fecha.»).
--
-- En una tienda con GF Courier por API (`stores.gf_courier_enabled`, 0344) la
-- hoja de Repro Lima ofrece GF Courier primero y por defecto, sin Grupo GF, y
-- al guardar el acuerdo Kapta crea la guía GF para el día acordado. El acuerdo
-- guarda el courier como `gf_courier`, el mismo token de la salida
-- (`shipments.courier`), así que `lima_repro_cases.agreed_courier` y
-- `lima_repro_calls.courier` tienen que admitirlo. Es lo mismo que hizo la 0283
-- con Aliclik.
--
-- Solo cambian los dos CHECK; no toca filas, sin drop de datos. Correrla otra
-- vez no cambia nada. Sin ella, guardar un acuerdo con GF Courier falla con el
-- error del CHECK y los demás couriers siguen igual.
-- Se aplica a mano ANTES del código (DEPLOY.md).
-- ============================================================================

alter table public.lima_repro_cases
  drop constraint if exists lima_repro_cases_agreed_courier_check;

alter table public.lima_repro_cases
  add constraint lima_repro_cases_agreed_courier_check
  check (agreed_courier in ('propio', 'gf_courier', 'aliclik', 'tanders', 'fenix', 'urpi', 'axel'));

-- La llamada que cerró el acuerdo guarda el mismo courier.
alter table public.lima_repro_calls
  drop constraint if exists lima_repro_calls_courier_check;

alter table public.lima_repro_calls
  add constraint lima_repro_calls_courier_check
  check (courier in ('propio', 'gf_courier', 'aliclik', 'tanders', 'fenix', 'urpi', 'axel'));
