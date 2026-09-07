-- `read_lead_experiment` tiene que analizar la MISMA población que el reparto
-- selecciona, y desde 0147 el reparto solo entra leads que llegan entre las 7 y
-- las 18 hora de Lima (ver lib/lead-experiment.ts: fuera de esa franja ocurre
-- solo el 10,7% de los toques humanos, así que el tratamiento no se puede
-- administrar).
--
-- POR QUÉ HACE FALTA TOCARLA. Las asignaciones hechas ANTES de ese cambio no
-- llevan el filtro, y la tabla es append-only: no se pueden borrar ni corregir,
-- que es exactamente la garantía que se quiso. En el momento de escribir esto son
-- 131 de 167 — el 78%. Sin este filtro, la lectura mezclaría dos poblaciones con
-- reglas de elegibilidad distintas y arrastraría el resultado hacia abajo con
-- leads que nadie podía tratar.
--
-- NO SESGA. El corte es por HORA DE LLEGADA del lead: un dato anterior al sorteo
-- y ajeno al brazo, así que descarta la misma proporción de tratamiento y de
-- control. Lo que hace es dejar la pregunta bien planteada — para los leads que
-- entran cuando podemos actuar, ¿vale la pena llamarlos rápido?
--
-- La franja se escribe aquí como literal en vez de leerla de la aplicación
-- porque el SQL no puede importar TREATABLE_HOUR_START/END. Si algún día se
-- mueven allí, hay que moverlos aquí: el test `la franja del SQL coincide con la
-- del código` lo comprueba.

create or replace function public.read_lead_experiment(
  p_experiment text,
  p_maduracion_dias integer default 7
)
returns table (
  tienda text, arm text, leads bigint, llamados bigint,
  en_1h bigint, pct_en_1h numeric, ventas bigint, conversion numeric
)
language sql
stable
security definer
set search_path = public
as $fn$
  with fc as (
    select lead_id, min(occurred_at) as first_call
    from lead_calls
    -- Solo personas: `system` son drip, winback y secuencias de carrito, y
    -- contarlas convertiría `pct_en_1h` —el indicador de cumplimiento— en uno
    -- que no distingue los brazos (ver 0146).
    where kind in ('call', 'message', 'sale')
    group by 1
  ),
  w as (select distinct lead_id from order_sales where lead_id is not null)
  select
    s.name as tienda,
    e.arm,
    count(*) as leads,
    count(f.first_call) as llamados,
    count(*) filter (where f.first_call - l.first_seen_at <= interval '1 hour') as en_1h,
    round(100.0 * count(*) filter (where f.first_call - l.first_seen_at <= interval '1 hour')
          / nullif(count(*), 0), 1) as pct_en_1h,
    count(w.lead_id) as ventas,
    round(100.0 * count(w.lead_id) / nullif(count(*), 0), 1) as conversion
  from lead_experiments e
  join leads l on l.id = e.lead_id
  join stores s on s.id = e.store_id
  left join fc f on f.lead_id = e.lead_id
  left join w on w.lead_id = e.lead_id
  where e.experiment = p_experiment
    and (f.first_call is null or e.assigned_at <= f.first_call)
    and l.first_seen_at <= now() - make_interval(days => p_maduracion_dias)
    -- La franja tratable. Deja fuera las asignaciones anteriores al filtro, que
    -- por ser append-only no se pueden quitar de la tabla.
    and extract(hour from l.first_seen_at at time zone 'America/Lima')::int between 7 and 18
  group by 1, 2
  order by 1, 2;
$fn$;

grant execute on function public.read_lead_experiment(text, integer) to authenticated, service_role;
