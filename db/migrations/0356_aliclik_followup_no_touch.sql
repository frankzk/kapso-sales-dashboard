-- ============================================================================
-- 0356_aliclik_followup_no_touch.sql — anotar que el cierre de Aliclik revisó
-- una guía no es cambiar la guía (MOM §19.2, owner 25-11-2026).
--
-- LO QUE SE MIDIÓ (25-11-2026, producción, solo lectura). El cierre de Aliclik
-- (`/api/cron/aliclik-close`, minutos 10, 30 y 50) persigue las guías que se
-- quedaron sin desenlace. A cada una que pregunta le sella el turno
-- (`aliclik_followup_at`, 0116), responda Aliclik lo que responda, y a las
-- devueltas sin motivo les sella la consulta (`reason_probed_at`, 0119).
--
--   * De 1.219 guías de Aliclik tocadas en tres horas, 997 (el 82 %) tenían su
--     `updated_at` en el mismo segundo que su `aliclik_followup_at`: lo único
--     que les pasó fue el sello.
--   * 2.308 guías distintas selladas en 24 horas.
--   * La cadena es la de la 0204: el sello sube `shipments.updated_at` →
--     `order_master_stale` da el pedido por desfasado (MOM §19.1) → el barrido
--     del Master lo recalcula → la fila del Master cambia → cada pestaña del
--     Master abierta recarga la página entera.
--
-- LA REGLA. La misma de la 0204 (`api_report_at`, `api_updated_at`) y de la
-- 0321 (los tres sellos del rastreo de Shalom): un sello dice CUÁNDO miramos,
-- no QUÉ vimos. Una escritura que solo toca sellos deja `updated_at` como
-- estaba. Cualquier otra columna distinta lo sigue moviendo, también junto con
-- un sello. `last_report_at` sigue fuera de la lista, por lo que explica la
-- 0204.
--
-- Ninguna de las dos columnas se lee fuera del cierre de Aliclik: ordenan su
-- propia cola (`lib/aliclik-followup.ts`). El Master no las mira, así que
-- dejar de recalcular por ellas no esconde nada.
--
-- Sin columnas, índices ni datos nuevos: solo la función del trigger. Se puede
-- desplegar el código antes o después; correrla otra vez no cambia nada.
-- ============================================================================

-- ⚠️ AL APLICAR EN PRODUCCIÓN: `create or replace function` toma un bloqueo
-- corto. Es cuestión de milisegundos, pero mejor fuera de horario, como la
-- 0204 y la 0321.

create or replace function public.shipments_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - array['updated_at', 'api_report_at', 'api_updated_at',
                            'shalom_checked_at', 'shalom_not_found_since', 'shalom_not_found_count',
                            'aliclik_followup_at', 'reason_probed_at'])
     is not distinct from
     (to_jsonb(old) - array['updated_at', 'api_report_at', 'api_updated_at',
                            'shalom_checked_at', 'shalom_not_found_since', 'shalom_not_found_count',
                            'aliclik_followup_at', 'reason_probed_at']) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end
$$;
