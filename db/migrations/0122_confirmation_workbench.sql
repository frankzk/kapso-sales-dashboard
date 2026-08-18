-- ============================================================================
-- 0122_confirmation_workbench.sql
-- Cierra la macroetapa Por confirmar: corte operativo, intentos idempotentes,
-- seguimientos por fecha y tareas del séptimo día. Shopify sigue siendo quien
-- anula; Kapta solo crea y audita la tarea humana.
-- ============================================================================

alter table stores
  add column if not exists confirmation_activation_date date not null default date '2026-06-01',
  add column if not exists confirmation_fallback_user uuid references auth.users(id) on delete set null;

comment on column stores.confirmation_activation_date is
  'Primer día operativo de Por confirmar en Kapta. Pedidos anteriores sin gestión son históricos, no Sin llamar.';
comment on column stores.confirmation_fallback_user is
  'Responsable de respaldo para tareas automáticas de confirmación; operativamente corresponde a Milagros.';

alter table order_events
  add column if not exists operation_id uuid;

create unique index if not exists order_events_operation_kind_uniq
  on order_events(order_id, operation_id, kind)
  where operation_id is not null;

create table if not exists order_tasks (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references stores(id) on delete cascade,
  order_id             uuid not null references orders(id) on delete cascade,
  kind                 text not null check (kind in (
    'confirmation_reminder',
    'confirmation_followup',
    'shopify_cancellation_review'
  )),
  status               text not null default 'pending'
                         check (status in ('pending', 'completed', 'cancelled')),
  due_at               timestamptz,
  due_on               date,
  assigned_to          uuid references auth.users(id) on delete set null,
  created_by_event_id  uuid references order_events(id) on delete set null,
  payload              jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  completed_at         timestamptz,
  completed_by         uuid references auth.users(id) on delete set null,
  resolution_note      text,
  check (due_at is not null or due_on is not null)
);

comment on table order_tasks is
  'Trabajo pendiente derivado de hechos. Las tareas cambian de estado; la auditoría inmutable permanece en order_events.';

create unique index if not exists order_tasks_one_pending_kind_uniq
  on order_tasks(order_id, kind)
  where status = 'pending';
create index if not exists order_tasks_confirmation_queue_idx
  on order_tasks(store_id, status, kind, due_on, due_at);

drop trigger if exists order_tasks_touch on order_tasks;
create trigger order_tasks_touch before update on order_tasks
  for each row execute function public.touch_updated_at();

alter table order_tasks enable row level security;
drop policy if exists order_tasks_select on order_tasks;
create policy order_tasks_select on order_tasks for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on order_tasks to authenticated;
grant all privileges on order_tasks to service_role;

alter table order_master
  add column if not exists confirmation_active boolean not null default false,
  add column if not exists confirmation_day_count integer not null default 0,
  add column if not exists confirmation_last_contact_at timestamptz,
  add column if not exists confirmation_next_contact_on date,
  add column if not exists confirmation_reminder_due_at timestamptz,
  add column if not exists confirmation_last_actor uuid references auth.users(id) on delete set null;

create index if not exists order_master_confirmation_followup_idx
  on order_master(store_id, confirmation_next_contact_on, order_created_at desc)
  where macro_stage = 'por_confirmar' and confirmation_next_contact_on is not null;
create index if not exists order_master_confirmation_reminder_idx
  on order_master(store_id, confirmation_reminder_due_at, order_created_at desc)
  where macro_stage = 'por_confirmar' and confirmation_reminder_due_at is not null;
create index if not exists order_master_updated_at_idx
  on order_master(updated_at desc);

-- Un gesto de la interfaz se vuelve una sola transacción. El operation_id evita
-- que un doble clic o un reintento de red consuma dos días o duplique tareas.
create or replace function public.register_confirmation_attempt_v1(
  p_store_id uuid,
  p_order_id uuid,
  p_actor uuid,
  p_operation_id uuid,
  p_result text,
  p_channel text,
  p_note text default null,
  p_next_contact_on date default null,
  p_occurred_at timestamptz default now(),
  p_reminder_due_at timestamptz default null
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
      'manual', nullif(trim(p_note), ''),
      jsonb_build_object(
        'channel', p_channel,
        'result', p_result,
        'next_contact_on', p_next_contact_on,
        'reminder_due_at', p_reminder_due_at
      ),
      p_operation_id
    ) returning id into v_contact_id;

    if p_result in ('volver_a_contactar', 'pendiente_de_abono') then
      insert into order_events (
        store_id, order_id, kind, occurred_at, actor, source, reason, payload, operation_id
      ) values (
        p_store_id, p_order_id, 'confirmation_followup', p_occurred_at, p_actor,
        'manual', 'Próximo contacto: ' || p_next_contact_on::text,
        jsonb_build_object('channel', p_channel, 'next_contact_on', p_next_contact_on),
        p_operation_id
      );
    elsif p_result = 'confirmado' then
      insert into order_events (
        store_id, order_id, kind, occurred_at, actor, source, note, payload, operation_id
      ) values (
        p_store_id, p_order_id, 'confirmed', p_occurred_at, p_actor,
        'manual', nullif(trim(p_note), ''), jsonb_build_object('channel', p_channel),
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

revoke all on function public.register_confirmation_attempt_v1(
  uuid, uuid, uuid, uuid, text, text, text, date, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.register_confirmation_attempt_v1(
  uuid, uuid, uuid, uuid, text, text, text, date, timestamptz, timestamptz
) to service_role;
