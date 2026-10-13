-- ============================================================================
-- 0251_lima_repro.sql — «Repro Lima»: la tienda llama al cliente de Lima que no
-- recibió su pedido, confirma fecha y courier, y Kapta programa la salida. Y la
-- fecha que el cliente le pidió al motorizado queda guardada sin programar nada.
--
-- DECISIÓN DEL OWNER (12-10-2026, D1-D13; fase 1, entrega 1a; MOM §9.5, §11.4,
-- §29.7): la fecha que el cliente da en la puerta se confirma con él antes de
-- programarla, NUNCA de forma automática. Quien despacha (`dispatch.manage`)
-- atiende cada pedido de Lima en `en_curso / por_reprogramar_lima` desde una
-- pantalla propia, con un candado de 10 minutos para que dos personas no llamen
-- al mismo cliente. «Por decidir», «Llamar después», «Programados» y
-- «Cerrados» son etiquetas de esa pantalla, no subetapas del Master: el
-- resolver no lee nada de esto y `MOM_RESOLUTION_VERSION` no sube.
--
-- QUÉ CAMBIA:
--
--   a) `delivery_stops.requested_date`: la fecha que pidió el cliente
--      (motorizado, coordinación o cuaderno). Es informativa: nunca programa.
--      Solo existe en un «No entregado · Reprogramado» (CHECK); la escribe solo
--      `writeStopReport`. Sin CHECK contra la fecha de hoy: el cuaderno se carga
--      días después.
--   b) `lima_repro_cases`: un caso ABIERTO por pedido (índice único parcial).
--      Nace perezoso al primer gesto (tomar, llamar, decidir): sin trigger ni
--      backfill. Guarda el episodio (el fallo de entrega que se está
--      atendiendo, `episode_key` + `episode_at`), el candado, los contadores de
--      llamadas, la próxima llamada y el acuerdo vigente (fecha, courier,
--      cambios declarados, qué hacer con la caja). Se cierra con «Desarmar y
--      cerrar», al salir de la etapa (`fuera_de_etapa`) o con un fallo nuevo
--      (`nuevo_intento`).
--   c) `lima_repro_calls`: cada llamada, append-only. Cuatro resultados
--      (§11.4): confirma, llamar después, no contesta, no quiere. «Desarmar y
--      cerrar» sin llamada es un `no_quiere` por el canal `sin_contacto`.
--   d) `lima_repro_claim` y `lima_repro_record`: las dos únicas RPC. Tomar el
--      caso (y abrirlo si no hay) y registrar una llamada son una transacción
--      cada una, con candado de fila; el evento del pedido (`lima_repro_call`,
--      `lima_repro_agreed`, `lima_repro_closed`) se escribe junto con la llamada.
--      Kinds nuevos: nunca `call`, `confirmation_contact` ni `contact_attempt`,
--      que consumen el cupo de confirmación.
--
-- Lecturas por tienda (`auth_store_ids()`); escrituras solo del servidor.
-- Aplicar a mano ANTES del código (DEPLOY.md): sin la columna, `/reparto`
-- carga la ruta vacía. Sin `begin`/`commit` propios, como el resto de
-- migraciones. Idempotente.
-- ============================================================================

-- a) La fecha que pidió el cliente --------------------------------------------

alter table public.delivery_stops add column if not exists requested_date date;

comment on column public.delivery_stops.requested_date is
  'Fecha que pidió el cliente (motorizado, coordinación o cuaderno). Informativa: nunca programa; la tienda la confirma en Repro Lima (MOM §9.5, §29.7). Solo la escribe writeStopReport.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'delivery_stops_requested_date_ck') then
    alter table public.delivery_stops add constraint delivery_stops_requested_date_ck
      check (requested_date is null or (status = 'no_entregado' and outcome_reason = 'reprogramado')) not valid;
  end if;
end $$;

alter table public.delivery_stops validate constraint delivery_stops_requested_date_ck;
-- Sin CHECK contra current_date: el cuaderno se carga días después.

-- b) El caso ------------------------------------------------------------------

create table if not exists public.lima_repro_cases (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores(id) on delete cascade,
  order_id          uuid not null references public.orders(id) on delete cascade,
  -- El fallo que se atiende: la última parada «No entregado» y la salida
  -- fallida. Un fallo nuevo es otro episodio y cierra el caso (`nuevo_intento`).
  episode_key       text not null check (char_length(episode_key) between 3 and 160),
  -- Cuándo pasó ese fallo. Decide qué episodio es el más nuevo.
  episode_at        timestamptz not null,
  opened_at         timestamptz not null default now(),
  opened_by         uuid references auth.users(id) on delete set null,
  claimed_by        uuid references auth.users(id) on delete set null,
  claimed_until     timestamptz,
  call_count        int not null default 0,
  no_answer_count   int not null default 0,
  last_call_at      timestamptz,
  last_outcome      text check (last_outcome in ('confirma', 'llamar_despues', 'no_contesta', 'no_quiere')),
  next_call_at      timestamptz,
  -- El acuerdo vigente. `agreement_call_id` es a la vez el rastro (la llamada
  -- que lo fijó) y la ficha de la escritura condicional que lo programa.
  agreement_call_id uuid,
  agreed_on         date,
  agreed_courier    text check (agreed_courier in ('propio', 'tanders', 'fenix', 'urpi', 'axel')),
  changes           jsonb not null default '{}'::jsonb check (jsonb_typeof(changes) = 'object'),
  box_action        text check (box_action in (
                      'mantener', 'reimprimir_misma_salida', 'salida_nueva_rearmar',
                      'desarmar_rearmar', 'caja_nueva_stock', 'desarmar_cerrar')),
  box_location      text check (box_location in ('con_motorizado', 'en_oficina', 'volviendo_courier', 'desconocida')),
  decided_by        uuid references auth.users(id) on delete set null,
  decided_at        timestamptz,
  materialized_at   timestamptz,
  materialized_on   date,
  closed_at         timestamptz,
  closed_by         uuid references auth.users(id) on delete set null,
  close_reason      text check (close_reason in ('desarmar_cerrar', 'fuera_de_etapa', 'nuevo_intento')),
  close_note        text check (close_note is null or char_length(close_note) <= 500),
  updated_at        timestamptz not null default now(),
  constraint lima_repro_cases_claim_pair check ((claimed_by is null) = (claimed_until is null)),
  constraint lima_repro_cases_close_pair check ((closed_at is null) = (close_reason is null)),
  constraint lima_repro_cases_closed_free check (closed_at is null or claimed_by is null),
  constraint lima_repro_cases_agreement_whole check (
    (agreement_call_id is null) = (agreed_on is null) and (agreed_on is null) = (agreed_courier is null)
    and (agreed_on is null or (box_action is not null and decided_at is not null))),
  constraint lima_repro_cases_mat_pair check ((materialized_at is null) = (materialized_on is null))
);

comment on table public.lima_repro_cases is
  'Repro Lima (MOM §9.5): un caso abierto por pedido y episodio de «No entregado». Lleva el candado, la próxima llamada y el acuerdo vigente; nunca se reescribe por lo que haga Grupo GF después (la pantalla muestra la diferencia).';
comment on column public.lima_repro_cases.episode_at is
  'Momento del fallo que define el episodio: reported_at de la parada «No entregado» más reciente, o el de la salida fallida; si no hay, opened_at. Un caso de otro episodio solo se cierra si el nuevo es posterior.';

create unique index if not exists lima_repro_cases_open_uniq
  on public.lima_repro_cases(order_id) where closed_at is null;
create index if not exists lima_repro_cases_store_open_idx
  on public.lima_repro_cases(store_id) where closed_at is null;
create index if not exists lima_repro_cases_order_idx
  on public.lima_repro_cases(order_id, opened_at desc);

-- touch_updated_at() se define en 0004_leads.sql
drop trigger if exists lima_repro_cases_touch on public.lima_repro_cases;
create trigger lima_repro_cases_touch before update on public.lima_repro_cases
  for each row execute function public.touch_updated_at();

-- c) Las llamadas (append-only) -----------------------------------------------

create table if not exists public.lima_repro_calls (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references public.lima_repro_cases(id) on delete cascade,
  store_id     uuid not null references public.stores(id) on delete cascade,
  order_id     uuid not null references public.orders(id) on delete cascade,
  -- Un gesto de la pantalla = una llamada: un doble clic o un reintento de red
  -- devuelve la misma fila.
  operation_id uuid not null unique,
  outcome      text not null check (outcome in ('confirma', 'llamar_despues', 'no_contesta', 'no_quiere')),
  -- `sin_contacto`: «Desarmar y cerrar» sin llamada (solo con `no_quiere`).
  channel      text not null check (channel in ('llamada', 'whatsapp', 'sin_contacto')),
  next_call_at timestamptz,
  agreed_on    date,
  courier      text check (courier in ('propio', 'tanders', 'fenix', 'urpi', 'axel')),
  changes      jsonb not null default '{}'::jsonb check (jsonb_typeof(changes) = 'object'),
  box_action   text check (box_action in (
                 'mantener', 'reimprimir_misma_salida', 'salida_nueva_rearmar',
                 'desarmar_rearmar', 'caja_nueva_stock', 'desarmar_cerrar')),
  box_location text check (box_location in ('con_motorizado', 'en_oficina', 'volviendo_courier', 'desconocida')),
  note         text check (note is null or char_length(note) <= 1000),
  actor        uuid references auth.users(id) on delete set null,
  occurred_at  timestamptz not null default now(),
  constraint lima_repro_calls_shape check (
       (outcome = 'confirma' and agreed_on is not null and courier is not null and box_action is not null
          and box_action <> 'desarmar_cerrar' and next_call_at is null)
    or (outcome = 'llamar_despues' and next_call_at is not null and agreed_on is null and box_action is null)
    or (outcome = 'no_contesta' and agreed_on is null and box_action is null)
    -- `is not distinct from`: con `=` un box_action nulo daba NULL y el CHECK
    -- lo dejaba pasar.
    or (outcome = 'no_quiere' and box_action is not distinct from 'desarmar_cerrar' and agreed_on is null
          and next_call_at is null and char_length(btrim(coalesce(note, ''))) >= 8)),
  constraint lima_repro_calls_sin_contacto check (channel <> 'sin_contacto' or outcome = 'no_quiere')
);

comment on table public.lima_repro_calls is
  'Repro Lima: cada llamada al cliente con su resultado (MOM §11.4). Append-only; el caso guarda solo lo vigente.';

create index if not exists lima_repro_calls_case_idx
  on public.lima_repro_calls(case_id, occurred_at desc);

drop trigger if exists lima_repro_calls_append_only on public.lima_repro_calls;
create trigger lima_repro_calls_append_only before update or delete on lima_repro_calls
  for each row execute function public.reject_mutation();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lima_repro_cases_agreement_fk') then
    alter table public.lima_repro_cases add constraint lima_repro_cases_agreement_fk
      foreign key (agreement_call_id) references public.lima_repro_calls(id);
  end if;
end $$;

-- Lecturas por tienda; escrituras solo del servidor. Supabase concede todo a
-- los tres roles al crear la tabla: sin el revoke, el grant no restringe nada.

alter table public.lima_repro_cases enable row level security;
alter table public.lima_repro_calls enable row level security;

revoke all on public.lima_repro_cases from anon, authenticated, service_role;
revoke all on public.lima_repro_calls from anon, authenticated, service_role;
grant select on public.lima_repro_cases to authenticated;
grant select on public.lima_repro_calls to authenticated;
grant select, insert, update on public.lima_repro_cases to service_role;
grant select, insert on public.lima_repro_calls to service_role;

drop policy if exists lima_repro_cases_select on public.lima_repro_cases;
create policy lima_repro_cases_select on public.lima_repro_cases for select to authenticated
  using (store_id in (select public.auth_store_ids()));
drop policy if exists lima_repro_calls_select on public.lima_repro_calls;
create policy lima_repro_calls_select on public.lima_repro_calls for select to authenticated
  using (store_id in (select public.auth_store_ids()));

-- d1) Tomar el caso -----------------------------------------------------------
--
-- Abre el caso si no hay (D1) y entrega el candado por `p_ttl_minutes`. El
-- candado solo vale dentro de Repro Lima: no bloquea a Grupo GF.
--   · Caso abierto de OTRO episodio: se cierra como `nuevo_intento` solo si el
--     episodio que trae quien llama es posterior (`p_episode_at`). Si es más
--     viejo, quien llama leyó hechos de antes: no cierra el caso bueno.
--   · Pedido fuera de «Por reprogramar Lima»: no se toma. El cierre
--     `fuera_de_etapa` lo hace la carga de la pantalla (`after()`): un `raise`
--     aquí desharía cualquier escritura de esta misma llamada.
--   · Candado vivo de otra persona: `claimed:false` con quién y hasta cuándo.
--   · Sin caso abierto, si el último cerrado del pedido es «Desarmar y cerrar»
--     de ESTE episodio, no se abre otro: `needs_reopen:true`, salvo
--     `p_reopen` («Volver a atender», segundo clic, E29). Se mira aquí, dentro
--     del candado: un cierre que llega entre la lectura del servidor y esta
--     llamada no se reabre solo.
-- Con un parámetro más, `create or replace` crearía otra función al lado de
-- la vieja (y la llamada por nombre sería ambigua): se borra la firma vieja.
drop function if exists public.lima_repro_claim(uuid, uuid, uuid, text, timestamptz, integer);

create or replace function public.lima_repro_claim(
  p_order uuid,
  p_store uuid,
  p_actor uuid,
  p_episode text,
  p_episode_at timestamptz default null,
  p_ttl_minutes integer default 10,
  p_reopen boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case lima_repro_cases%rowtype;
  v_open boolean;
  v_until timestamptz;
  v_last lima_repro_cases%rowtype;
begin
  if p_actor is null then
    raise exception 'Falta quién atiende el caso.';
  end if;
  if p_ttl_minutes is null or p_ttl_minutes not between 1 and 15 then
    raise exception 'El candado dura entre 1 y 15 minutos.';
  end if;
  if p_episode is null or char_length(p_episode) not between 3 and 160 then
    raise exception 'Falta el episodio del pedido.';
  end if;
  if not exists (select 1 from orders where id = p_order and store_id = p_store) then
    raise exception 'El pedido no pertenece a la tienda indicada.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('lima_repro:' || p_order::text, 0));

  select * into v_case
    from lima_repro_cases
   where order_id = p_order and closed_at is null
   for update;
  v_open := found;

  if v_open and v_case.episode_key <> p_episode then
    if p_episode_at is null or p_episode_at <= v_case.episode_at then
      raise exception 'El pedido cambió mientras lo abrías: vuelve a intentarlo.';
    end if;
    update lima_repro_cases
       set closed_at = now(), close_reason = 'nuevo_intento', claimed_by = null, claimed_until = null
     where id = v_case.id;
    v_open := false;
  end if;

  if not exists (
    select 1 from order_master
     where order_id = p_order and macro_stage = 'en_curso' and macro_substage = 'por_reprogramar_lima'
  ) then
    raise exception 'Este pedido ya no está en «Por reprogramar Lima».';
  end if;

  if not v_open then
    select * into v_last
      from lima_repro_cases
     where order_id = p_order and closed_at is not null
     order by closed_at desc, opened_at desc
     limit 1;
    if found and v_last.close_reason = 'desarmar_cerrar' and v_last.episode_key = p_episode
       and not coalesce(p_reopen, false) then
      return jsonb_build_object('claimed', false, 'needs_reopen', true);
    end if;
    insert into lima_repro_cases (store_id, order_id, episode_key, episode_at, opened_by)
    values (p_store, p_order, p_episode, coalesce(p_episode_at, now()), p_actor)
    returning * into v_case;
  end if;

  if v_case.claimed_by is not null and v_case.claimed_by <> p_actor and v_case.claimed_until > now() then
    return jsonb_build_object(
      'case_id', v_case.id, 'claimed', false,
      'holder', v_case.claimed_by, 'until', v_case.claimed_until);
  end if;

  v_until := now() + make_interval(mins => p_ttl_minutes);
  update lima_repro_cases set claimed_by = p_actor, claimed_until = v_until where id = v_case.id;
  return jsonb_build_object('case_id', v_case.id, 'claimed', true, 'until', v_until);
end;
$$;

revoke all on function public.lima_repro_claim(uuid, uuid, uuid, text, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.lima_repro_claim(uuid, uuid, uuid, text, timestamptz, integer, boolean) to service_role;

-- d2) Registrar una llamada ---------------------------------------------------
--
-- Una transacción: la llamada, el caso y el evento del pedido. El
-- `operation_id` se mira DESPUÉS del candado de fila, así un doble clic
-- devuelve `duplicate` sin carrera; el mismo `operation_id` con otro resultado
-- u otra fecha es otro formulario y se rechaza. Después: caso abierto, candado
-- vivo de quien llama y mismo episodio. La fecha acordada es de hoy (Lima) a
-- 60 días; la próxima llamada, futura y a 60 días como mucho (§11.6).
--   · `confirma` fija el acuerdo (y lo deja sin programar).
--   · `llamar_despues` y `no_quiere` vacían el acuerdo; la historia queda en
--     las llamadas. `no_quiere` además cierra el caso (`desarmar_cerrar`) y
--     suelta el candado: no anula la venta, solo Shopify la anula.
--   · `no_contesta` cuenta el intento y conserva el acuerdo vigente.
--   · `sin_contacto` no es una llamada: no cuenta como intento.
create or replace function public.lima_repro_record(
  p_case uuid,
  p_actor uuid,
  p_operation uuid,
  p_episode text,
  p_outcome text,
  p_channel text,
  p_next_call_at timestamptz default null,
  p_agreed_on date default null,
  p_courier text default null,
  p_changes jsonb default '{}'::jsonb,
  p_box_action text default null,
  p_box_location text default null,
  p_note text default null,
  p_event_note text default null,
  p_ttl_minutes integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case lima_repro_cases%rowtype;
  v_prev lima_repro_calls%rowtype;
  v_call uuid;
  v_today date := (now() at time zone 'America/Lima')::date;
  v_changes jsonb := coalesce(p_changes, '{}'::jsonb);
  v_contact integer := case when p_channel = 'sin_contacto' then 0 else 1 end;
  v_until timestamptz;
begin
  if p_actor is null then
    raise exception 'Falta quién registra la llamada.';
  end if;
  if p_operation is null then
    raise exception 'Falta el identificador del envío.';
  end if;
  if p_outcome is null or p_outcome not in ('confirma', 'llamar_despues', 'no_contesta', 'no_quiere') then
    raise exception 'Resultado de la llamada inválido.';
  end if;
  if p_channel is null or p_channel not in ('llamada', 'whatsapp', 'sin_contacto') then
    raise exception 'Canal de la llamada inválido.';
  end if;
  if p_ttl_minutes is null or p_ttl_minutes not between 1 and 15 then
    raise exception 'El candado dura entre 1 y 15 minutos.';
  end if;

  select * into v_case from lima_repro_cases where id = p_case for update;
  if not found then
    raise exception 'No encontramos el caso.';
  end if;

  select * into v_prev from lima_repro_calls where operation_id = p_operation;
  if found then
    if v_prev.case_id <> p_case or v_prev.outcome <> p_outcome
       or v_prev.agreed_on is distinct from p_agreed_on then
      raise exception 'Ya se guardó otra llamada con este envío: vuelve a abrir el caso.';
    end if;
    return jsonb_build_object('call_id', v_prev.id, 'duplicate', true);
  end if;

  if v_case.closed_at is not null then
    raise exception 'El caso ya está cerrado.';
  end if;
  if v_case.claimed_by is distinct from p_actor or v_case.claimed_until <= now() then
    raise exception 'Ya no tienes este caso: vuelve a tomarlo.';
  end if;
  if v_case.episode_key is distinct from p_episode then
    raise exception 'El pedido tuvo otro intento de entrega: vuelve a abrirlo.';
  end if;

  if p_outcome = 'confirma' and p_agreed_on is not null then
    if p_agreed_on < v_today then
      raise exception 'La nueva fecha no puede ser anterior a hoy.';
    end if;
    if p_agreed_on > v_today + 60 then
      raise exception 'La nueva fecha no puede pasar de 60 días.';
    end if;
  end if;
  if p_next_call_at is not null then
    if p_next_call_at <= now() then
      raise exception 'Elige una hora que todavía no pasó.';
    end if;
    if p_next_call_at > now() + interval '60 days' then
      raise exception 'La próxima llamada no puede pasar de 60 días.';
    end if;
  end if;

  -- La forma (qué lleva cada resultado) la valida el CHECK de la tabla.
  insert into lima_repro_calls (
    case_id, store_id, order_id, operation_id, outcome, channel, next_call_at,
    agreed_on, courier, changes, box_action, box_location, note, actor
  ) values (
    p_case, v_case.store_id, v_case.order_id, p_operation, p_outcome, p_channel, p_next_call_at,
    p_agreed_on, p_courier, v_changes, p_box_action, p_box_location, nullif(btrim(p_note), ''), p_actor
  ) returning id into v_call;

  v_until := now() + make_interval(mins => p_ttl_minutes);

  if p_outcome = 'confirma' then
    update lima_repro_cases
       set call_count = call_count + v_contact,
           last_call_at = now(), last_outcome = p_outcome, next_call_at = null,
           agreement_call_id = v_call, agreed_on = p_agreed_on, agreed_courier = p_courier,
           changes = v_changes, box_action = p_box_action, box_location = p_box_location,
           decided_by = p_actor, decided_at = now(),
           materialized_at = null, materialized_on = null,
           claimed_until = v_until
     where id = p_case;
  elsif p_outcome = 'no_contesta' then
    update lima_repro_cases
       set call_count = call_count + v_contact, no_answer_count = no_answer_count + 1,
           last_call_at = now(), last_outcome = p_outcome, next_call_at = p_next_call_at,
           claimed_until = v_until
     where id = p_case;
  elsif p_outcome = 'llamar_despues' then
    update lima_repro_cases
       set call_count = call_count + v_contact,
           last_call_at = now(), last_outcome = p_outcome, next_call_at = p_next_call_at,
           agreement_call_id = null, agreed_on = null, agreed_courier = null,
           changes = '{}'::jsonb, box_action = null, box_location = null,
           decided_by = null, decided_at = null,
           materialized_at = null, materialized_on = null,
           claimed_until = v_until
     where id = p_case;
  else
    update lima_repro_cases
       set call_count = call_count + v_contact,
           last_call_at = case when v_contact = 1 then now() else last_call_at end,
           last_outcome = case when v_contact = 1 then p_outcome else last_outcome end,
           next_call_at = null,
           agreement_call_id = null, agreed_on = null, agreed_courier = null,
           changes = '{}'::jsonb, box_action = 'desarmar_cerrar', box_location = null,
           decided_by = null, decided_at = null,
           materialized_at = null, materialized_on = null,
           closed_at = now(), closed_by = p_actor, close_reason = 'desarmar_cerrar',
           close_note = left(btrim(p_note), 500),
           claimed_by = null, claimed_until = null
     where id = p_case;
  end if;

  insert into order_events (store_id, order_id, kind, actor, source, note, operation_id, payload)
  values (
    v_case.store_id, v_case.order_id,
    case p_outcome
      when 'confirma' then 'lima_repro_agreed'
      when 'no_quiere' then 'lima_repro_closed'
      else 'lima_repro_call'
    end,
    p_actor, 'repro_lima', nullif(btrim(p_event_note), ''), p_operation,
    jsonb_build_object(
      'case_id', p_case,
      'call_id', v_call,
      'outcome', p_outcome,
      'channel', p_channel,
      'next_call_at', p_next_call_at,
      'agreed_on', p_agreed_on,
      'courier', p_courier,
      'changes', v_changes,
      'box_action', p_box_action,
      'box_location', p_box_location
    )
  );

  return jsonb_build_object('call_id', v_call, 'duplicate', false);
end;
$$;

revoke all on function public.lima_repro_record(uuid, uuid, uuid, text, text, text, timestamptz, date, text, jsonb, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.lima_repro_record(uuid, uuid, uuid, text, text, text, timestamptz, date, text, jsonb, text, text, text, text, integer) to service_role;
