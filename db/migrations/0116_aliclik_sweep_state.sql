-- ============================================================================
-- 0116_aliclik_sweep_state.sql — el barrido de Aliclik deja constancia de sí
-- mismo, para que el cierre no dependa de terminarlo en la misma invocación.
--
-- QUÉ SE ROMPIÓ. El cron de reconciliación hacía tres cosas seguidas dentro de
-- una sola invocación: recorrer el listado por fechas, caducar las intenciones
-- huérfanas y perseguir a las guías vivas rezagadas. En ese orden. El recorrido
-- creció hasta agotar `maxDuration` y la invocación empezó a morir dentro del
-- bucle: las nueve pasadas de las últimas tres horas del 10-08-2026 terminaron
-- en 504. Todo lo que iba DESPUÉS del bucle dejó de ejecutarse — no de vez en
-- cuando, sino siempre.
--
-- El síntoma visible fue un candado eterno: `#KP127355` quedó 'pending' más de
-- diez horas porque la caducidad (§10.2) nunca llegó a correr. El daño mayor era
-- más silencioso: el pase de rezagadas tampoco corría, y con él caído 515 guías
-- `en_ruta` acumulaban una media de 8 días sin noticias y hasta 40 — justo las
-- devoluciones que el MOM §11 convierte en entrada a Reproprovincia.
--
-- POR QUÉ HACE FALTA PERSISTIR. La condición que protege la caducidad —«solo se
-- caduca si el listado se recorrió ENTERO», §10.2— vivía en una variable local
-- del bucle. Mientras las tres tareas compartían invocación eso bastaba; en
-- cuanto se separan en dos crones, la evidencia tiene que sobrevivir a la
-- invocación que la produjo. Esta tabla es esa evidencia: cuándo empezó el
-- último barrido que se recorrió entero, cuándo terminó y qué ventana de fechas
-- cubrió.
--
-- Las tres marcas se usan para cosas distintas y por eso están las tres:
--   * `last_full_sweep_started_at` — el barrido tiene que haber EMPEZADO después
--     de que naciera la intención. Si empezó antes, pudo pasar de largo por la
--     zona del listado donde estaría, y su ausencia no prueba nada.
--   * `last_full_sweep_at` — cuándo terminó. Una evidencia vieja no vale: si
--     hace horas que no se completa un barrido, se vuelve a estar a ciegas y no
--     se caduca nada, igual que durante una caída de Aliclik.
--   * `last_full_sweep_from` — el borde antiguo de la ventana consultada. Es lo
--     que distingue una ausencia COMPROBADA de una caducidad por antigüedad a
--     secas, que es la diferencia que el motivo escrito tiene que registrar.
--
-- `last_sweep_attempt_at` no participa en ninguna decisión: queda para poder ver
-- desde SQL que el cron corre aunque no llegue a completar el recorrido.
-- ============================================================================
create table if not exists aliclik_sweep_state (
  store_id uuid primary key references stores(id) on delete cascade,
  last_full_sweep_started_at timestamptz,
  last_full_sweep_at timestamptz,
  last_full_sweep_from timestamptz,
  last_sweep_attempt_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table aliclik_sweep_state is
  'Constancia del barrido de Aliclik por tienda. La caducidad de intenciones huérfanas (MOM §10.2) se apoya en estas marcas, porque corre en otro cron que el barrido.';
comment on column aliclik_sweep_state.last_full_sweep_started_at is
  'Inicio del último barrido que se recorrió ENTERO. Una intención nacida después de este instante no fue buscada por él.';
comment on column aliclik_sweep_state.last_full_sweep_at is
  'Fin del último barrido completo. Si queda vieja, se deja de caducar: sin barrido reciente no hay ausencia demostrada.';
comment on column aliclik_sweep_state.last_full_sweep_from is
  'Borde antiguo de la ventana de fechas que cubrió ese barrido. Una intención anterior no es verificable.';
comment on column aliclik_sweep_state.last_sweep_attempt_at is
  'Último intento de barrido, completo o no. Solo para diagnóstico.';

-- Los permisos van como en sus hermanas (0056, 0057): la tabla la escribe SOLO
-- el cron con el rol de servicio, y quien tiene la tienda puede mirarla. Sin
-- esto quedaría legible por PostgREST para cualquiera con la clave pública —
-- no guarda nada sensible, pero sí dice a qué hora barre cada tienda, y una
-- excepción sin motivo en la única tabla nueva es como empiezan los agujeros.
alter table aliclik_sweep_state enable row level security;

drop policy if exists aliclik_sweep_state_select on aliclik_sweep_state;
create policy aliclik_sweep_state_select on aliclik_sweep_state for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_sweep_state from anon, authenticated, service_role;
grant select                         on aliclik_sweep_state to authenticated;
grant select, insert, update, delete on aliclik_sweep_state to service_role;

-- ----------------------------------------------------------------------------
-- La duda por teléfono ambiguo también tiene que sobrevivir a la invocación.
--
-- Cuando el barrido ve un pedido sin registrar cuyo teléfono señala a VARIAS
-- intenciones a la vez, ninguna de ellas puede caducarse: el pedido podría ser
-- el suyo (§10.2). Esa duda se acumulaba en un Set en memoria, que es
-- exactamente lo que deja de existir al separar los crones. Se estampa en la
-- propia intención, que es de quien es el hecho.
--
-- Es una marca de tiempo y no un booleano a propósito: la duda vale para el
-- barrido que la vio, no para siempre. El cierre la compara contra el inicio del
-- último barrido completo — si ese barrido no la volvió a marcar, la duda quedó
-- atrás y la intención vuelve a ser caducable.
-- ----------------------------------------------------------------------------
alter table aliclik_order_requests
  add column if not exists ambiguous_at timestamptz;

comment on column aliclik_order_requests.ambiguous_at is
  'Cuándo el barrido dejó esta intención en duda: vio un pedido sin registrar cuyo teléfono señalaba a varias candidatas. Retiene la caducidad mientras sea posterior al inicio del último barrido completo.';

-- ----------------------------------------------------------------------------
-- Y el pase de rezagadas necesita saber a quién YA le preguntó.
--
-- La cola se ordenaba por `last_report_at` —la guía más callada primero—, y eso
-- se atasca solo: preguntar por una guía que no se ha movido devuelve un
-- snapshot igual o más viejo que el que tenemos, la guarda monotónica lo
-- descarta sin escribir nada, y `last_report_at` se queda donde estaba. La misma
-- guía vuelve a encabezar la cola en la pasada siguiente, para siempre. Con 179
-- guías vivas fuera de la ventana y un tope de consultas por pasada, las
-- primeras se consultaban una y otra vez y el resto no llegaba a tener turno.
--
-- Esta columna registra cuándo se PREGUNTÓ, que es lo único que siempre avanza,
-- y pasa a ser el orden de la cola. La rotación queda garantizada: nunca
-- preguntadas primero, y entre iguales, la más callada.
-- ----------------------------------------------------------------------------
alter table shipments
  add column if not exists aliclik_followup_at timestamptz;

comment on column shipments.aliclik_followup_at is
  'Cuándo el pase de rezagadas consultó esta guía de una en una, responda lo que responda Aliclik. Ordena la cola para que rote; no dice nada sobre el estado.';

-- El parcial cubre exactamente lo que la cola consulta, y por eso incluye
-- `anulado`: desde 0d961d9 una guía anulada se sigue persiguiendo, porque el
-- paquete vuelve DESPUÉS de anularse. Dejarla fuera del índice sería dejar sin
-- cubrir justo a la familia con reserva propia en cada pasada. Sigue siendo
-- parcial para que el índice tenga el tamaño del problema (cientos de filas) y
-- no el de la tabla (miles).
create index if not exists shipments_aliclik_followup_queue_idx
  on shipments (store_id, aliclik_followup_at nulls first, last_report_at nulls first)
  where courier = 'aliclik' and delivery_status in ('pendiente', 'en_ruta', 'anulado');
