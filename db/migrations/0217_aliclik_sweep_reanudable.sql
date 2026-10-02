-- 0217_aliclik_sweep_reanudable.sql — el barrido de Aliclik sigue donde se
-- quedó en vez de volver a la página 1.
--
-- QUÉ PASÓ (02-10-2026). El barrido recorre ~13 páginas de 100 pedidos (14 días)
-- con un presupuesto de 230 s repartido entre las dos tiendas: 115 s cada una.
-- El último recorrido completo, el 29-09, tardó 112 s — al filo. Desde entonces
-- ninguna pasada terminó: cada una se cortaba por tiempo y la siguiente volvía a
-- empezar por la página 1, así que las últimas páginas no se leían NUNCA. Sin
-- barrido completo tampoco hay evidencia para caducar candados (§10.2), y el
-- pase de rezagadas excluía a 531 de 608 guías vivas por una marca de tres días.
--
-- QUÉ CAMBIA. Una pasada cortada deja anotado el CICLO en curso: cuándo empezó,
-- qué ventana consulta y por qué página sigue. La siguiente pasada continúa ahí
-- con la misma ventana. Cuando se lee la última página, el ciclo cuenta como un
-- barrido completo que EMPEZÓ cuando empezó el ciclo, no la última pasada: así
-- la regla de §10.2 —el barrido tiene que haber empezado después de que naciera
-- la intención— sigue siendo verdad aunque el recorrido se reparta en varias
-- invocaciones. Un ciclo demasiado viejo se descarta y se vuelve a la página 1.

alter table aliclik_sweep_state
  add column if not exists cycle_started_at timestamptz,
  add column if not exists cycle_from timestamptz,
  add column if not exists resume_page integer;

comment on column aliclik_sweep_state.cycle_started_at is
  'Inicio del ciclo de barrido en curso (puede abarcar varias pasadas). Al completarse pasa a last_full_sweep_started_at.';
comment on column aliclik_sweep_state.cycle_from is
  'Borde antiguo de la ventana de fechas del ciclo en curso. Las pasadas que lo continúan consultan esta misma ventana.';
comment on column aliclik_sweep_state.resume_page is
  'Página por la que sigue el ciclo en curso. NULL: el próximo barrido empieza un ciclo nuevo desde la página 1.';
