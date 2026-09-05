-- lead_experiments — a qué brazo de qué experimento pertenece un lead.
--
-- POR QUÉ EXISTE. El peso de `frio` en la cola es 1 (Kenku) y 0 (Aurela): el
-- último de la escala. Está mal, y NO se puede corregir con otra consulta al
-- histórico, porque el histórico está contaminado por construcción.
--
-- El segmento se calcula con el estado de HOY. Una llamada que funciona hace que
-- el cliente dé su distrito o arme un carrito, con lo cual el lead deja de ser
-- frío. Medido: de 1.259 leads sin ninguna señal al entrar, llamados dentro de
-- la hora, hoy quedan etiquetados frío solo 101 (8%) — y esos cierran 4,0%. Los
-- otros 1.158 se fueron a interés, conversó y carrito. O sea que "la tasa del
-- frío" mide el residuo donde la llamada NO funcionó. Es una tautología.
--
-- Reconstruyendo el segmento con lo único que una llamada no puede reescribir
-- —`source='cod_cart'`, draft orders anteriores a la llamada, y
-- `first_inbound_text`, que se escribe una sola vez—, un lead sin señal llamado
-- dentro de la hora cierra 19,4% (Kenku) y 5,9% (Aurela), contra 1,7% y 0,8%
-- pasadas seis horas.
--
-- Pero eso sigue sin ser causal: quien se llama en veinte minutos es quien
-- estaba disponible, y estar disponible correlaciona con comprar. Asignar AL
-- AZAR antes de conocer el resultado es lo único que rompe esa correlación, y
-- para eso hace falta guardar la asignación.
--
-- APPEND-ONLY, y aquí es lo esencial del método, no una convención. Si el brazo
-- se pudiera reescribir, cualquiera —o cualquier bug— podría moverlo después de
-- ver el resultado, y el experimento dejaría de probar nada sin dejar rastro. La
-- PK (lead_id, experiment) remata: la primera asignación es la definitiva y un
-- segundo intento choca en vez de sobrescribir.
--
-- LA PK ES COMPUESTA para que un lead pueda entrar en experimentos distintos más
-- adelante. Con la PK solo en `lead_id`, el segundo experimento chocaría contra
-- las filas del primero y quedaría sin asignar en silencio.

create table if not exists lead_experiments (
  lead_id     uuid not null references leads(id) on delete cascade,
  -- Qué experimento. Va en la fila y no implícito en la tabla: las filas viejas
  -- tienen que seguir diciendo a cuál pertenecen cuando haya un segundo.
  experiment  text not null,
  arm         text not null check (arm in ('tratamiento','control')),
  -- La tienda, copiada: el análisis se parte por tienda (Kenku cierra 19,4% y
  -- Aurela 5,9% en el mismo balde) y sin esto habría que unir con `leads`, que
  -- es mutable. Y la RLS necesita la columna aquí.
  store_id    uuid not null references stores(id) on delete cascade,
  -- Cuándo se asignó. Es el instante que define "antes de saber el resultado":
  -- si alguna fila estuviera fechada después de su primera llamada, esa fila
  -- habría que descartarla del análisis. La consulta de abajo lo comprueba.
  assigned_at timestamptz not null default now(),
  primary key (lead_id, experiment)
);

-- El análisis pregunta siempre lo mismo: los leads de un experimento, por brazo,
-- en un rango.
create index if not exists lead_experiments_exp_arm_idx
  on lead_experiments (experiment, arm, assigned_at desc);
-- Y la cola pregunta lo contrario: el brazo de los leads que está pintando.
create index if not exists lead_experiments_store_idx
  on lead_experiments (store_id, experiment);

alter table lead_experiments enable row level security;

drop policy if exists lead_experiments_select on lead_experiments;
create policy lead_experiments_select on lead_experiments for select to authenticated
  using (store_id in (select auth_store_ids()));

-- REVOKE ANTES DE GRANT, y no es ceremonia. Supabase trae
-- `alter default privileges ... grant all on tables to anon, authenticated,
-- service_role`, así que la tabla NACE con update, delete y truncate para todos;
-- un `grant select` posterior SUMA y no quita nada. `order_sales` (0132) lleva
-- así desde que se creó, prometiendo en su cabecera dos capas de defensa cuando
-- solo tenía una (ver 0145).
--
-- Y no es cosmético: el trigger de abajo es de FILA sobre update/delete, y
-- TRUNCATE no dispara triggers de fila. Con el permiso puesto, la garantía de
-- "esto no se puede reescribir" se saltaba entera con un truncate.
revoke all on lead_experiments from anon, authenticated, service_role;
grant select on lead_experiments to authenticated;
grant select, insert on lead_experiments to service_role;

drop trigger if exists lead_experiments_append_only on lead_experiments;
create trigger lead_experiments_append_only before update or delete on lead_experiments
  for each row execute function public.reject_mutation();

-- ----------------------------------------------------------------------------
-- Lectura del experimento
-- ----------------------------------------------------------------------------
-- Va en una función y no en un cuaderno suelto por la misma razón que
-- `backfill_order_sales`: lo que se prueba tiene que ser lo que corre. Aquí
-- además importa más, porque una consulta de análisis escrita a mano cada vez es
-- una invitación a mirar los cortes hasta que salga el resultado que uno quería.
--
-- INTENCIÓN DE TRATAR. Se agrupa por el brazo ASIGNADO, no por quién acabó
-- llamándose dentro de la hora. Agrupar por cumplimiento volvería a meter la
-- selección: los tratados que sí se alcanzaron serían otra vez "los
-- disponibles", que es exactamente el sesgo del que huimos.
--
-- Por eso se devuelve `pct_en_1h` de cada brazo: no es el resultado, es el
-- CUMPLIMIENTO. Si el tratamiento no llega a llamarse mucho más rápido que el
-- control, el experimento no llegó a administrarse y la diferencia de
-- conversión no significa nada — hay que arreglar el empuje antes que leer nada.
--
-- `maduracion_dias` (7 por defecto) deja fuera los leads demasiado nuevos para
-- haber cerrado. Sin eso, los últimos días entran con conversión artificialmente
-- baja en LOS DOS brazos y diluyen la diferencia.
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
    from lead_calls group by 1
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
    -- Solo filas asignadas ANTES de la primera llamada. Con la tabla
    -- append-only y la asignación en el ingreso esto debería ser siempre cierto;
    -- comprobarlo aquí hace que una regresión futura se note como leads que
    -- faltan, en vez de contaminar el resultado en silencio.
    and (f.first_call is null or e.assigned_at <= f.first_call)
    and l.first_seen_at <= now() - make_interval(days => p_maduracion_dias)
  group by 1, 2
  order by 1, 2;
$fn$;

grant execute on function public.read_lead_experiment(text, integer) to authenticated, service_role;
