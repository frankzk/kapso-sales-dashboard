-- ============================================================================
-- 0137_courier_district_availability.sql
-- Pausas temporales de cobertura para Grupo GF Courier.
--
-- La disponibilidad no se mezcla con la tarifa: poner S/0 nunca significa
-- "pausado". Cada cambio es un evento append-only para conservar quién tomó la
-- decisión, el motivo y la fecha opcional de reactivación automática.
-- ============================================================================

create table if not exists logistics_district_availability_events (
  id                    uuid primary key default gen_random_uuid(),
  provider_id           uuid not null references logistics_providers(id) on delete cascade,
  agreement_id          uuid references logistics_service_agreements(id) on delete cascade,
  district_key          text not null references peru_districts(district_key) on delete restrict,
  action                text not null check (action in ('paused', 'reactivated')),
  reason                text,
  paused_until          date,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  check (
    (action = 'paused' and length(trim(coalesce(reason, ''))) >= 4)
    or (action = 'reactivated' and paused_until is null)
  )
);

create index if not exists logistics_district_availability_latest_idx
  on logistics_district_availability_events(
    provider_id,
    coalesce(agreement_id, '00000000-0000-0000-0000-000000000000'::uuid),
    district_key,
    created_at desc,
    id desc
  );

alter table logistics_district_availability_events enable row level security;

drop policy if exists logistics_district_availability_select
  on logistics_district_availability_events;
create policy logistics_district_availability_select
  on logistics_district_availability_events
  for select to authenticated using (
    provider_id in (
      select id from logistics_providers where org_id in (select auth_org_ids())
    )
    or agreement_id in (
      select id from logistics_service_agreements where client_org_id in (select auth_org_ids())
    )
  );

grant select on logistics_district_availability_events to authenticated;
grant all privileges on logistics_district_availability_events to service_role;

create or replace function prevent_logistics_availability_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'La disponibilidad logística es append-only: registra un evento nuevo.';
end;
$$;

drop trigger if exists logistics_district_availability_immutable
  on logistics_district_availability_events;
create trigger logistics_district_availability_immutable
  before update or delete on logistics_district_availability_events
  for each row execute function prevent_logistics_availability_event_mutation();

comment on table logistics_district_availability_events is
  'Historial inmutable de pausas y reactivaciones por distrito y ámbito contractual.';

-- Punto único para que la futura asignación logística falle cerrada cuando un
-- distrito esté pausado. Una pausa general gana sobre cualquier tienda.
create or replace function courier_district_is_available(
  p_provider_id uuid,
  p_agreement_id uuid,
  p_district_key text,
  p_day date default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_general logistics_district_availability_events%rowtype;
  v_agreement logistics_district_availability_events%rowtype;
  v_day date := coalesce(p_day, (now() at time zone 'America/Lima')::date);
begin
  select e.* into v_general
  from logistics_district_availability_events e
  where e.provider_id = p_provider_id
    and e.agreement_id is null
    and e.district_key = p_district_key
  order by e.created_at desc, e.id desc
  limit 1;

  if v_general.action = 'paused'
     and (v_general.paused_until is null or v_general.paused_until >= v_day) then
    return false;
  end if;

  if p_agreement_id is not null then
    select e.* into v_agreement
    from logistics_district_availability_events e
    where e.provider_id = p_provider_id
      and e.agreement_id = p_agreement_id
      and e.district_key = p_district_key
    order by e.created_at desc, e.id desc
    limit 1;

    if v_agreement.action = 'paused'
       and (v_agreement.paused_until is null or v_agreement.paused_until >= v_day) then
      return false;
    end if;
  end if;

  return true;
end;
$$;

comment on function courier_district_is_available(uuid, uuid, text, date) is
  'Disponibilidad efectiva para una nueva asignación; la pausa general prevalece sobre la contractual.';

revoke all on function courier_district_is_available(uuid, uuid, text, date)
  from public, anon, authenticated;
grant execute on function courier_district_is_available(uuid, uuid, text, date)
  to service_role;
