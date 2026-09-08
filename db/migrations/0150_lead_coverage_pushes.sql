-- v2 del experimento sobre leads sin señal: entrega y lectura.
--
-- QUÉ CAMBIA RESPECTO DE v1. El tratamiento de v1 era "llámalo dentro de su
-- primera hora", señalado EN LA COLA. Nunca se administró. Dos mecanismos, los
-- dos fallaron en la misma dirección:
--
--                 % llamado en 1h    % llamado alguna vez
--   empujón        42,1 vs 35,0       (mediana 47 min contra 17 del control)
--   aviso 🧪        22,0 vs 29,7       23,5 vs 34,3   (p ≈ 0,04)
--
-- Marcar un lead como "de la prueba" hace que se llame MENOS: la etiqueta se lee
-- como "esto no es un pedido de verdad". Y de paso v1 enseñó que la pregunta
-- estaba mal elegida — dentro de su población aleatorizada, llamado dentro de la
-- hora cerraba 15,2%, llamado después 13,3% y nunca llamado 0,0%. La hora vale
-- ~2 puntos; llamar o no llamar vale ~15.
--
-- Así que v2 mide LA COBERTURA: ¿vale la pena llamar a un lead sin señal, aunque
-- sea tarde? Y entrega el tratamiento fuera de la pantalla, como una lista de
-- trabajo por Telegram, sin decir que es una prueba (lib/coverage-push.ts).

-- ----------------------------------------------------------------------------
-- lead_coverage_pushes — qué leads se entregaron ya
-- ----------------------------------------------------------------------------
-- POR QUÉ HACE FALTA UNA TABLA Y NO BASTA CON MIRAR `lead_calls`. Sin registro,
-- un lead del tratamiento que nadie llama vuelve a salir en la lista cada dos
-- horas, para siempre. Eso no es insistir: es enseñar a ignorar el canal, que es
-- exactamente el fracaso que ya costó v1 por otra vía. Con este registro cada
-- lead sale UNA vez y la lista siempre trae trabajo nuevo.
--
-- Y SEPARA ENTREGA DE CUMPLIMIENTO, que es lo que en v1 no se pudo hacer hasta
-- tarde. `empujados` contra `llamados` responde a dos preguntas distintas: si el
-- tratamiento salió, y si alguien lo trabajó. Cuando en v1 los dos brazos
-- salieron iguales hubo que reconstruir a mano si el tratamiento había llegado a
-- administrarse; aquí se lee en la misma fila.
--
-- LA PK ES LA GARANTÍA de "una sola vez", no una convención de la consulta: dos
-- pasadas del cron en paralelo chocan en vez de mandar el lead dos veces.
create table if not exists lead_coverage_pushes (
  lead_id    uuid not null references leads(id) on delete cascade,
  -- El experimento, igual que en lead_experiments: las filas viejas tienen que
  -- seguir diciendo a cuál pertenecen cuando llegue v3.
  experiment text not null,
  store_id   uuid not null references stores(id) on delete cascade,
  -- Cuándo salió. El análisis lo usa para comprobar que la entrega precede a la
  -- llamada: si un lead se llamó ANTES de que su lista saliera, esa llamada no
  -- la causó el tratamiento.
  pushed_at  timestamptz not null default now(),
  primary key (lead_id, experiment)
);

-- El cron pregunta "de estos leads, ¿cuáles ya salieron?" acotado al experimento.
create index if not exists lead_coverage_pushes_exp_idx
  on lead_coverage_pushes (experiment, store_id, pushed_at desc);

alter table lead_coverage_pushes enable row level security;

drop policy if exists lead_coverage_pushes_select on lead_coverage_pushes;
create policy lead_coverage_pushes_select on lead_coverage_pushes for select to authenticated
  using (store_id in (select auth_store_ids()));

-- REVOKE ANTES DE GRANT. Supabase trae `alter default privileges ... grant all
-- on tables`, así que la tabla NACE con update, delete y truncate para todos y
-- un `grant select` posterior SUMA sin quitar nada. Y el trigger de abajo es de
-- FILA: no dispara con TRUNCATE, así que sin revocar el permiso la garantía se
-- salta entera con un truncate. Es el fallo que `order_sales` arrastró desde
-- 0132 hasta que lo barrió 0145.
revoke all on lead_coverage_pushes from anon, authenticated, service_role;
grant select on lead_coverage_pushes to authenticated;
grant select, insert on lead_coverage_pushes to service_role;

drop trigger if exists lead_coverage_pushes_append_only on lead_coverage_pushes;
create trigger lead_coverage_pushes_append_only before update or delete on lead_coverage_pushes
  for each row execute function public.reject_mutation();

-- ----------------------------------------------------------------------------
-- read_lead_experiment — la franja de v1 deja de aplicarse a todo
-- ----------------------------------------------------------------------------
-- 0147 le metió `between 7 and 18` fijo porque v1 solo repartía leads que
-- entraban en horario de trabajo (su hora dorada tenía que caer donde hubiera
-- alguien). v2 no tiene franja: el tratamiento es "que se llame", sin prisa, así
-- que un lead de las 3 de la madrugada se llama a las 9 y la recibe igual.
--
-- Dejar el literal como estaba haría que leer v2 con esta función descartara el
-- 57% de su población EN SILENCIO, y encima descartándola por una regla que a v2
-- no se le aplicó al repartir. El filtro pasa a depender del experimento que se
-- lee, que es de donde nunca debió salir.
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
    -- SOLO v1. Su reparto exigía que el lead entrara entre las 7 y las 18, y sus
    -- filas son append-only: las 131 de 167 asignadas antes de que existiera ese
    -- filtro siguen en la tabla y hay que descartarlas al leer. Los experimentos
    -- que no tienen esa regla no deben pagarla.
    and (
      p_experiment <> 'frio_hora_dorada_v1'
      or extract(hour from l.first_seen_at at time zone 'America/Lima')::int between 7 and 18
    )
  group by 1, 2
  order by 1, 2;
$fn$;

grant execute on function public.read_lead_experiment(text, integer) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- read_lead_coverage — la lectura de v2
-- ----------------------------------------------------------------------------
-- Función aparte y no un parámetro más de la anterior porque miden cosas
-- distintas: v1 preguntaba por la VELOCIDAD (`pct_en_1h`) y v2 pregunta por la
-- COBERTURA (`pct_llamado`). Meterlas en una sola devolvería columnas que no
-- significan nada en la mitad de las llamadas, y una columna que a veces no
-- significa nada acaba leyéndose igual.
--
-- INTENCIÓN DE TRATAR, igual que en v1: se agrupa por el brazo ASIGNADO, no por
-- quién acabó llamándose. Agrupar por cumplimiento devolvería la selección que
-- el sorteo existe para eliminar — los tratados alcanzados volverían a ser "los
-- disponibles", y estar disponible correlaciona con comprar.
--
-- `empujados` es el control de que el tratamiento SALIÓ. Si sale bajo, la
-- diferencia de conversión no significa nada todavía: no hay que leer el
-- resultado, hay que arreglar la entrega. Es la lección cara de v1, donde los
-- dos brazos salieron iguales porque el tratamiento nunca llegó a la asesora.
-- En el control tiene que ser 0 — si no, la entrega está regando a los dos
-- brazos y el experimento no compara nada.
create or replace function public.read_lead_coverage(
  p_experiment text,
  p_maduracion_dias integer default 7
)
returns table (
  tienda text,
  arm text,
  leads bigint,
  empujados bigint,
  llamados bigint,
  pct_llamado numeric,
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
    -- Solo toques de PERSONA. El 51,3% de la tabla es `kind='system'` —drip,
    -- winback, secuencias de carrito— y a esos les llegan a los dos brazos por
    -- igual: contarlos pondría `pct_llamado` cerca del 100% en ambos y borraría
    -- justo el contraste que este experimento fabrica.
    where kind in ('call', 'message', 'sale')
    group by 1
  ),
  w as (select distinct lead_id from order_sales where lead_id is not null)
  select
    s.name as tienda,
    e.arm,
    count(*) as leads,
    count(p.lead_id) as empujados,
    count(f.first_call) as llamados,
    round(100.0 * count(f.first_call) / nullif(count(*), 0), 1) as pct_llamado,
    count(w.lead_id) as ventas,
    round(100.0 * count(w.lead_id) / nullif(count(*), 0), 1) as conversion
  from lead_experiments e
  join leads l on l.id = e.lead_id
  join stores s on s.id = e.store_id
  left join fc f on f.lead_id = e.lead_id
  left join w on w.lead_id = e.lead_id
  left join lead_coverage_pushes p
    on p.lead_id = e.lead_id and p.experiment = e.experiment
  where e.experiment = p_experiment
    -- Asignado ANTES de la primera llamada. Con la tabla append-only y el
    -- reparto en el ingreso debería ser siempre cierto; comprobarlo hace que una
    -- regresión se note como leads que faltan en vez de contaminar el resultado.
    and (f.first_call is null or e.assigned_at <= f.first_call)
    -- Maduración: un lead de ayer no ha tenido tiempo de cerrar. Sin esto los
    -- últimos días entran con conversión artificialmente baja en LOS DOS brazos
    -- y diluyen la diferencia que se busca.
    and l.first_seen_at <= now() - make_interval(days => p_maduracion_dias)
  group by 1, 2
  order by 1, 2;
$fn$;

grant execute on function public.read_lead_coverage(text, integer) to authenticated, service_role;
