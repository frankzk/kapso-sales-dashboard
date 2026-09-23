-- ============================================================================
-- 0190_voice_calls.sql — agente de voz para Reproprovincia (MOM §11.8).
--
-- Tres piezas, ninguna es un estado nuevo del pedido:
--   1. Ajustes por tienda (`stores.voice_recovery_*`), apagados por defecto.
--   2. `voice_calls`: la bitácora de cada llamada del agente. Se escribe ANTES
--      de pedir la llamada a la telefonía, y todo lo que el agente registre se
--      atribuye a esa fila, nunca a un pedido buscado por el teléfono que
--      contesta (§11.8, «La llamada se ata al pedido ANTES de marcar»).
--   3. `register_confirmation_attempt_v2`: la misma transacción que la v1
--      (0122) con dos parámetros más, `p_source` y `p_payload_extra`, para que
--      los hechos del agente digan que los escribió el agente y lleven el id de
--      su llamada. La v1 no se toca: todas las pantallas la siguen usando.
-- ============================================================================

-- ── 1. Ajustes por tienda ───────────────────────────────────────────────────
alter table stores
  add column if not exists voice_recovery_enabled       boolean not null default false,
  add column if not exists voice_recovery_auto          boolean not null default false,
  add column if not exists voice_recovery_can_discard   boolean not null default false,
  add column if not exists voice_recovery_daily_cap     integer not null default 30,
  add column if not exists voice_recovery_max_attempts  integer not null default 2,
  add column if not exists voice_recovery_max_age_days  integer not null default 7,
  add column if not exists voice_recovery_hour_start    integer not null default 9,
  add column if not exists voice_recovery_hour_end      integer not null default 20,
  add column if not exists voice_recovery_agent_number  text,
  add column if not exists voice_recovery_zadarma_sip   text;

comment on column stores.voice_recovery_enabled is
  'MOM §11.8. Habilita la cola del agente de voz y el botón manual. Apagado por defecto.';
comment on column stores.voice_recovery_auto is
  'MOM §11.8. El barrido llama solo. Apagarlo es la marcha atrás sin cerrar la cola.';
comment on column stores.voice_recovery_agent_number is
  'Número desviado al agente de xAI, en el formato que marca Zadarma (sin 51; p. ej. 17058243). Es el `from` del callback.';
comment on column stores.voice_recovery_zadarma_sip is
  'Extensión o SIP de Zadarma que origina la llamada (`sip` del callback). Su caller ID DEBE ser un número peruano: Kapta no llama sin él (MOM §11.8).';

-- ── 2. Bitácora de llamadas ─────────────────────────────────────────────────
create table if not exists voice_calls (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references stores(id) on delete cascade,
  order_id           uuid not null references orders(id) on delete cascade,
  mode               text not null default 'real' check (mode in ('real', 'test')),
  provider           text not null default 'grok',
  telephony          text not null default 'zadarma',
  agent_number       text not null,
  phone              text not null,
  status             text not null default 'queued' check (status in (
    'queued', 'dialing', 'in_progress', 'completed', 'failed', 'cancelled'
  )),
  outcome            text check (outcome in (
    'confirma', 'programar', 'no_contesta', 'cancela', 'sin_resultado'
  )),
  outcome_payload    jsonb not null default '{}'::jsonb,
  telephony_response jsonb,
  provider_call_id   text,
  triggered_by       uuid references auth.users(id) on delete set null,
  queued_at          timestamptz not null default now(),
  dialed_at          timestamptz,
  started_at         timestamptz,
  ended_at           timestamptz,
  transcript         jsonb,
  recording_url      text,
  error              text,
  updated_at         timestamptz not null default now()
);

comment on table voice_calls is
  'MOM §11.8. Una fila por llamada del agente de voz. Registro de llamadas, no estado del pedido: los hechos sobre el pedido van a order_events por register_confirmation_attempt_v2.';
comment on column voice_calls.mode is
  '`test`: apunta a un pedido real pero llama al teléfono del probador y NO escribe nada sobre el pedido. No cuenta para topes ni métricas.';

-- Una sola llamada abierta por número de agente: es la atadura del piloto
-- (plan, «atar la llamada al pedido», opción 2). El agente no recibe el
-- teléfono de la clienta —el callback le llega con el caller ID de la cuenta—,
-- así que Kapta sabe de qué pedido habla porque es el único abierto.
create unique index if not exists voice_calls_one_open_per_agent
  on voice_calls(agent_number)
  where status in ('queued', 'dialing', 'in_progress');
create index if not exists voice_calls_store_day_idx on voice_calls(store_id, queued_at desc);
create index if not exists voice_calls_order_idx on voice_calls(order_id, queued_at desc);

drop trigger if exists voice_calls_touch on voice_calls;
create trigger voice_calls_touch before update on voice_calls
  for each row execute function public.touch_updated_at();

alter table voice_calls enable row level security;
drop policy if exists voice_calls_select on voice_calls;
create policy voice_calls_select on voice_calls for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on voice_calls to authenticated;
grant all privileges on voice_calls to service_role;

-- ── 3. Registro de intento con procedencia ──────────────────────────────────
-- Copia fiel de register_confirmation_attempt_v1 (0122). Cambian dos cosas:
-- `source` sale de `p_source` en vez de ser 'manual' fijo, y `p_payload_extra`
-- se fusiona en el payload de los hechos que escribe. Todo lo demás —el
-- candado, la idempotencia por operation_id, el tope de siete días y las
-- tareas— es idéntico, porque el agente es un operador más (§11.8).
create or replace function public.register_confirmation_attempt_v2(
  p_store_id uuid,
  p_order_id uuid,
  p_actor uuid,
  p_operation_id uuid,
  p_result text,
  p_channel text,
  p_note text default null,
  p_next_contact_on date default null,
  p_occurred_at timestamptz default now(),
  p_reminder_due_at timestamptz default null,
  p_source text default 'manual',
  p_payload_extra jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_id uuid;
  v_days integer;
  v_duplicate boolean := false;
  v_task_kind text;
  v_assignee uuid;
  v_source text := coalesce(nullif(trim(p_source), ''), 'manual');
  v_extra jsonb := coalesce(p_payload_extra, '{}'::jsonb);
begin
  if p_result not in (
    'sin_respuesta', 'se_deja_mensaje', 'volver_a_contactar',
    'pendiente_de_abono', 'confirmado'
  ) then
    raise exception 'Resultado de confirmación inválido.';
  end if;
  if p_channel not in ('llamada', 'whatsapp', 'mensaje') then
    raise exception 'Canal de confirmación inválido.';
  end if;
  if p_result in ('volver_a_contactar', 'pendiente_de_abono') and p_next_contact_on is null then
    raise exception 'La fecha del próximo contacto es obligatoria.';
  end if;
  if not exists (
    select 1 from orders where id = p_order_id and store_id = p_store_id
  ) then
    raise exception 'El pedido no pertenece a la tienda indicada.';
  end if;

  select coalesce(p_actor, confirmation_fallback_user)
    into v_assignee
    from stores
   where id = p_store_id;

  perform pg_advisory_xact_lock(hashtextextended(p_order_id::text, 1));

  select id into v_contact_id
    from order_events
   where order_id = p_order_id
     and operation_id = p_operation_id
     and kind = 'confirmation_contact'
   limit 1;

  select count(distinct ((occurred_at at time zone 'America/Lima')::date))::integer
    into v_days
    from order_events
   where order_id = p_order_id
     and kind in ('confirmation_contact', 'contact_attempt', 'call');
  if v_days >= 7 and v_contact_id is null then
    raise exception 'El pedido ya agotó sus siete días de confirmación.';
  end if;

  if v_contact_id is not null then
    v_duplicate := true;
  else
    insert into order_events (
      store_id, order_id, kind, occurred_at, actor, source, note, payload, operation_id
    ) values (
      p_store_id, p_order_id, 'confirmation_contact', p_occurred_at, p_actor,
      v_source, nullif(trim(p_note), ''),
      jsonb_build_object(
        'channel', p_channel,
        'result', p_result,
        'next_contact_on', p_next_contact_on,
        'reminder_due_at', p_reminder_due_at
      ) || v_extra,
      p_operation_id
    ) returning id into v_contact_id;

    if p_result in ('volver_a_contactar', 'pendiente_de_abono') then
      insert into order_events (
        store_id, order_id, kind, occurred_at, actor, source, reason, payload, operation_id
      ) values (
        p_store_id, p_order_id, 'confirmation_followup', p_occurred_at, p_actor,
        v_source, 'Próximo contacto: ' || p_next_contact_on::text,
        jsonb_build_object('channel', p_channel, 'next_contact_on', p_next_contact_on) || v_extra,
        p_operation_id
      );
    elsif p_result = 'confirmado' then
      insert into order_events (
        store_id, order_id, kind, occurred_at, actor, source, note, payload, operation_id
      ) values (
        p_store_id, p_order_id, 'confirmed', p_occurred_at, p_actor,
        v_source, nullif(trim(p_note), ''),
        jsonb_build_object('channel', p_channel) || v_extra,
        p_operation_id
      );
    end if;
  end if;

  select count(distinct ((occurred_at at time zone 'America/Lima')::date))::integer
    into v_days
    from order_events
   where order_id = p_order_id
     and kind in ('confirmation_contact', 'contact_attempt', 'call');

  if not v_duplicate then
    update order_tasks
       set status = 'cancelled'
     where order_id = p_order_id
       and status = 'pending'
       and kind in ('confirmation_reminder', 'confirmation_followup');

    if v_days >= 7 and p_result <> 'confirmado' then
      insert into order_tasks (
        store_id, order_id, kind, due_on, assigned_to, created_by_event_id, payload
      ) values (
        p_store_id, p_order_id, 'shopify_cancellation_review',
        (p_occurred_at at time zone 'America/Lima')::date,
        v_assignee, v_contact_id,
        jsonb_build_object('confirmation_days', v_days, 'last_result', p_result)
      ) on conflict (order_id, kind) where status = 'pending' do nothing;

      insert into order_events (
        store_id, order_id, kind, occurred_at, actor, source, note, payload, operation_id
      ) values (
        p_store_id, p_order_id, 'confirmation_cancellation_task_created', p_occurred_at,
        p_actor, 'system',
        'Revisar y anular manualmente en Shopify si el cliente no confirmó.',
        jsonb_build_object('confirmation_days', v_days), p_operation_id
      ) on conflict (order_id, operation_id, kind) where operation_id is not null do nothing;
    elsif p_result in ('volver_a_contactar', 'pendiente_de_abono') then
      v_task_kind := 'confirmation_followup';
      insert into order_tasks (
        store_id, order_id, kind, due_on, assigned_to, created_by_event_id, payload
      ) values (
        p_store_id, p_order_id, v_task_kind, p_next_contact_on, v_assignee, v_contact_id,
        jsonb_build_object('result', p_result, 'channel', p_channel)
      ) on conflict (order_id, kind) where status = 'pending' do update
        set due_on = excluded.due_on,
            assigned_to = excluded.assigned_to,
            created_by_event_id = excluded.created_by_event_id,
            payload = excluded.payload;
    elsif p_result in ('sin_respuesta', 'se_deja_mensaje') and p_reminder_due_at is not null then
      v_task_kind := 'confirmation_reminder';
      insert into order_tasks (
        store_id, order_id, kind, due_at, assigned_to, created_by_event_id, payload
      ) values (
        p_store_id, p_order_id, v_task_kind, p_reminder_due_at, v_assignee, v_contact_id,
        jsonb_build_object('result', p_result, 'channel', p_channel)
      ) on conflict (order_id, kind) where status = 'pending' do update
        set due_at = excluded.due_at,
            assigned_to = excluded.assigned_to,
            created_by_event_id = excluded.created_by_event_id,
            payload = excluded.payload;
    end if;
  end if;

  return jsonb_build_object(
    'duplicate', v_duplicate,
    'day_count', v_days,
    'last_attempt', v_days >= 7,
    'contact_event_id', v_contact_id
  );
end;
$$;

revoke all on function public.register_confirmation_attempt_v2(
  uuid, uuid, uuid, uuid, text, text, text, date, timestamptz, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.register_confirmation_attempt_v2(
  uuid, uuid, uuid, uuid, text, text, text, date, timestamptz, timestamptz, text, jsonb
) to service_role;
