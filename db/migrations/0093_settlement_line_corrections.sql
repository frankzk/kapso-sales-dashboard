-- 0093 — Correcciones auditadas de transcripciones en liquidaciones.
--
-- La foto o el Excel original siguen siendo evidencia inmutable. Cuando visión
-- omite una comisión o una persona corrige un monto, se actualiza el valor
-- operativo de la fila y se registra aquí el antes, el después, quién y por qué.

create table if not exists rider_settlement_line_corrections (
  id              uuid primary key default gen_random_uuid(),
  settlement_id   uuid not null references rider_settlements(id) on delete cascade,
  line_id          uuid not null references rider_settlement_lines(id) on delete cascade,
  field_name       text not null check (field_name in ('declared_amount', 'declared_fee')),
  previous_value   numeric(12, 2),
  new_value        numeric(12, 2),
  reason           text not null check (length(btrim(reason)) >= 3),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists rider_settlement_line_corrections_line_idx
  on rider_settlement_line_corrections(line_id, created_at desc);
create index if not exists rider_settlement_line_corrections_settlement_idx
  on rider_settlement_line_corrections(settlement_id, created_at desc);

alter table rider_settlement_line_corrections enable row level security;

drop policy if exists rider_settlement_line_corrections_select
  on rider_settlement_line_corrections;
create policy rider_settlement_line_corrections_select
  on rider_settlement_line_corrections for select to authenticated
  using (settlement_id in (
    select id from rider_settlements where store_id in (select auth_store_ids())
  ));

-- Solo el servidor escribe. Nadie puede reescribir o borrar la auditoría.
revoke all on rider_settlement_line_corrections from anon, authenticated, service_role;
grant select on rider_settlement_line_corrections to authenticated;
grant select, insert on rider_settlement_line_corrections to service_role;

drop trigger if exists rider_settlement_line_corrections_immutable
  on rider_settlement_line_corrections;
create trigger rider_settlement_line_corrections_immutable
  before update or delete on rider_settlement_line_corrections
  for each row execute function public.reject_mutation();

comment on table rider_settlement_line_corrections is
  'Historial append-only de correcciones humanas a montos transcritos de una liquidación.';

-- Actualiza monto y comisión en una sola transacción. El raw original de la
-- fila no se toca, por lo que siempre puede cotejarse contra la imagen.
create or replace function public.correct_rider_settlement_line_values(
  p_settlement_id uuid,
  p_line_id uuid,
  p_declared_amount numeric,
  p_declared_fee numeric,
  p_reason text,
  p_actor uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_previous_amount numeric(12, 2);
  v_previous_fee numeric(12, 2);
  v_changes integer := 0;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Escribe un motivo breve para la corrección.';
  end if;
  if p_declared_amount is not null and p_declared_amount < 0 then
    raise exception 'El monto reportado no puede ser negativo.';
  end if;
  if p_declared_fee is not null and p_declared_fee < 0 then
    raise exception 'La comisión no puede ser negativa.';
  end if;

  select s.status, l.declared_amount, l.declared_fee
    into v_status, v_previous_amount, v_previous_fee
  from rider_settlement_lines l
  join rider_settlements s on s.id = l.settlement_id
  where l.id = p_line_id and l.settlement_id = p_settlement_id
  for update of l;

  if not found then
    raise exception 'La fila no pertenece a esta liquidación.';
  end if;
  if v_status = 'cerrada' then
    raise exception 'La liquidación está cerrada; abre una liquidación de ajuste.';
  end if;

  if v_previous_amount is distinct from p_declared_amount then
    insert into rider_settlement_line_corrections (
      settlement_id, line_id, field_name, previous_value, new_value, reason, created_by
    ) values (
      p_settlement_id, p_line_id, 'declared_amount', v_previous_amount,
      p_declared_amount, btrim(p_reason), p_actor
    );
    v_changes := v_changes + 1;
  end if;

  if v_previous_fee is distinct from p_declared_fee then
    insert into rider_settlement_line_corrections (
      settlement_id, line_id, field_name, previous_value, new_value, reason, created_by
    ) values (
      p_settlement_id, p_line_id, 'declared_fee', v_previous_fee,
      p_declared_fee, btrim(p_reason), p_actor
    );
    v_changes := v_changes + 1;
  end if;

  if v_changes = 0 then
    return 0;
  end if;

  update rider_settlement_lines
  set declared_amount = p_declared_amount,
      declared_fee = p_declared_fee,
      updated_at = now()
  where id = p_line_id;

  update rider_settlements
  set status = 'borrador', updated_at = now()
  where id = p_settlement_id;

  return v_changes;
end;
$$;

revoke all on function public.correct_rider_settlement_line_values(
  uuid, uuid, numeric, numeric, text, uuid
) from public, anon, authenticated;
grant execute on function public.correct_rider_settlement_line_values(
  uuid, uuid, numeric, numeric, text, uuid
) to service_role;

