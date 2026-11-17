-- Repro Lima: la caja puede estar con otro courier (owner, 17-11-2026; MOM §9.5, 0339). Kapta ya calcula
-- `con_courier` (la salida viva de GF Courier, Aliclik, etc. manda sobre la caja), pero las columnas solo aceptaban
-- con_motorizado / en_oficina / volviendo_courier / desconocida, y guardar el acuerdo fallaba con
-- «lima_repro_calls_box_location_check». Se agrega `con_courier` a las dos tablas; no cambia ningún dato.
alter table public.lima_repro_calls drop constraint if exists lima_repro_calls_box_location_check;
alter table public.lima_repro_calls add constraint lima_repro_calls_box_location_check
  check (box_location in ('con_motorizado', 'en_oficina', 'volviendo_courier', 'con_courier', 'desconocida'));
alter table public.lima_repro_cases drop constraint if exists lima_repro_cases_box_location_check;
alter table public.lima_repro_cases add constraint lima_repro_cases_box_location_check
  check (box_location in ('con_motorizado', 'en_oficina', 'volviendo_courier', 'con_courier', 'desconocida'));
