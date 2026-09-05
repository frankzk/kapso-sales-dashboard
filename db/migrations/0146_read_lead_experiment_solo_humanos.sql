-- `read_lead_experiment` contaba los toques de MÁQUINA como llamadas.
--
-- CÓMO SE VIO. A las cinco horas de arrancar el experimento, 7 de las 100
-- asignaciones tenían `assigned_at` POSTERIOR a su "primera llamada", cosa que
-- el barrido no debería permitir —solo asigna leads en estado `nuevo`—. Al
-- mirarlos, las siete filas eran `kind='system'` con `new_status` nulo: no eran
-- llamadas, eran toques automáticos (drip, winback, secuencia de carrito).
--
-- EL TAMAÑO DEL PROBLEMA. El 51,3% de `lead_calls` es `kind='system'`. Sobre los
-- 26.346 leads con alguna fila:
--   • 8.400 tienen SOLO filas de máquina — nadie los llamó nunca;
--   • de los 17.946 con toque humano, 4.445 (24,8%) tenían una fila de máquina
--     ANTES, con 4,7 horas de desfase mediano.
--
-- POR QUÉ ROMPE EL EXPERIMENTO, y no solo lo ensucia. `pct_en_1h` no es un
-- resultado: es la medida de CUMPLIMIENTO, la que dice si el tratamiento llegó a
-- administrarse. Contando toques automáticos, un lead al que nadie llamó pero al
-- que le saltó un drip figura como "llamado dentro de la hora" — y eso pasa en
-- los DOS brazos, así que el cumplimiento saldría alto en ambos y la diferencia
-- entre ellos se aplanaría. O sea: el indicador que existe para detectar que el
-- experimento no se administró sería justo el que lo ocultaría.
--
-- Y el filtro `assigned_at <= first_call`, que está para descartar asignaciones
-- hechas conociendo el resultado, descartaba leads cuya única fila previa era una
-- máquina — leads perfectamente válidos.
--
-- LA FRONTERA YA ESTABA DEFINIDA en el código: lib/productivity.ts documenta que
-- `kind` es exactamente la línea persona/máquina («en 60 días `call`, `message` y
-- `sale` vienen firmados el 100% de las veces»). Esta función simplemente no la
-- estaba usando.
--
-- Comprobado que las conclusiones que motivaron el experimento NO cambian: con
-- toques humanos solamente, el cierre dentro de la primera hora sube en todos los
-- segmentos (carrito 40,7 → 41,2 %, interés 25,8 → 32,9 %, conversó 14,9 → 15,5 %,
-- frío 8,1 → 8,8 %) y el de +6 h se queda igual. El acantilado es más
-- pronunciado, no menos; contar máquinas lo hacía parecer más suave.

create or replace function public.read_lead_experiment(
  p_experiment text,
  p_maduracion_dias integer default 7
)
returns table (
  tienda text,
  arm text,
  leads bigint,
  llamados bigint,
  en_1h bigint,
  pct_en_1h numeric,
  ventas bigint,
  conversion numeric
)
language sql
stable
security definer
set search_path = public
as $fn$
  with fc as (
    select lead_id, min(occurred_at) as first_call
    from lead_calls
    -- SOLO PERSONAS. `system` son drip, winback y secuencias de carrito: contarlas
    -- convertiría el indicador de cumplimiento en uno que no distingue los brazos.
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
  group by 1, 2
  order by 1, 2;
$fn$;

grant execute on function public.read_lead_experiment(text, integer) to authenticated, service_role;
