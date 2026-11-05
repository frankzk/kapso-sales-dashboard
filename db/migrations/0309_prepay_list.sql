-- ============================================================================
-- 0309_prepay_list.sql — «Lista de pago adelantado» (la lista negra) por
-- celular y por organización (MOM §41, decisión del owner del 05-11-2026).
--
-- POR QUÉ. Un cliente que rechazó un pedido en la puerta, o que no lo recogió
-- en la agencia, ya no compra contra entrega: paga el total por adelantado.
-- Kapta lo frena al confirmar, al crear cualquier guía y al generar el pedido,
-- y la tienda (WordPress y el formulario de COD Core) le esconde el «Pago
-- contra entrega» preguntando a Kapta por el celular.
--
-- QUÉ CREA.
--   * `prepay_list_entries`: una fila por alta en la lista, con su origen
--     (`auto` por la regla, `manual` por una persona), el motivo, la evidencia
--     (los pedidos que la dispararon) y, si se quitó, quién, cuándo y por qué.
--     El celular va en su forma canónica `51` + 9 dígitos (lib/phone.ts). Una
--     sola fila VIVA (`removed_at is null`) por (organización, celular). Una
--     fila quitada no se borra ni se reabre: es la historia, y es lo que hace
--     que una baja a mano se respete: al quitarla se guardan los pedidos que
--     ya la disparaban (`removed_known_order_ids`) y la regla solo vuelve a
--     agregar por un pedido que no esté ahí (§41.3).
--   * `prepay_list_settings`: la posición de la regla automática por
--     organización (apagado, simulación, activo; sin fila = apagado) y el
--     resumen de la última simulación y de la última pasada activa, que el
--     panel de Automatizaciones muestra.
--
-- No cambia datos. Correrla otra vez no cambia nada. Todo nace apagado.
-- ============================================================================

create table if not exists public.prepay_list_entries (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  -- Canónico: `51` + móvil de 9 dígitos que empieza por 9 (`prepayPhoneKey`).
  phone           text not null check (phone ~ '^519[0-9]{8}$'),
  source          text not null check (source in ('auto', 'manual')),
  reason          text not null check (length(btrim(reason)) >= 8),
  -- Lo que la disparó: tipo, cuántos pedidos, sus ids y nombres, y la fecha de
  -- cada hecho (`PrepayEvidence`, lib/prepay-list.ts). Una alta manual guarda
  -- `{ "kind": "manual" }`.
  evidence        jsonb not null default '{}'::jsonb,
  added_by        uuid references auth.users(id) on delete set null,
  added_at        timestamptz not null default now(),
  removed_at      timestamptz,
  removed_by      uuid references auth.users(id) on delete set null,
  removed_reason  text,
  -- LO QUE YA SE SABÍA AL QUITARLA: los ids de los pedidos que, en ese
  -- momento, ya disparaban el alta de este celular (la misma regla y la misma
  -- ventana que la pasada automática). Es lo que hace que una baja a mano se
  -- respete (§41.3): la regla solo lo vuelve a agregar por un pedido que NO
  -- esté aquí ni en la evidencia. Se escribe una vez, al quitar; las fechas de
  -- los hechos no sirven para esto porque `last_report_at` y `status_since`
  -- se mueven con cada reporte del mismo hecho viejo.
  removed_known_order_ids jsonb,
  constraint prepay_list_entries_removed_ck check (
    (removed_at is null and removed_by is null and removed_reason is null and removed_known_order_ids is null)
    or (removed_at is not null and removed_reason is not null and length(btrim(removed_reason)) >= 8)
  ),
  constraint prepay_list_entries_known_ck check (
    removed_known_order_ids is null or jsonb_typeof(removed_known_order_ids) = 'array'
  )
);

-- Por si la tabla ya existía de una corrida anterior de esta misma migración.
alter table public.prepay_list_entries add column if not exists removed_known_order_ids jsonb;

-- Una sola alta viva por celular y organización: la regla y una persona no
-- pueden dejar dos.
create unique index if not exists prepay_list_entries_active_uniq
  on public.prepay_list_entries (org_id, phone) where removed_at is null;
create index if not exists prepay_list_entries_phone_idx
  on public.prepay_list_entries (org_id, phone, removed_at desc);
create index if not exists prepay_list_entries_org_added_idx
  on public.prepay_list_entries (org_id, added_at desc);

-- Lo escrito no se reescribe: solo se puede QUITAR una alta viva (una vez, con
-- motivo y con lo que ya se sabía al quitarla). Ni el celular, ni el motivo,
-- ni la evidencia cambian después.
create or replace function public.prepay_list_entries_guard() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.phone is distinct from old.phone
     or new.source is distinct from old.source
     or new.reason is distinct from old.reason
     or new.evidence is distinct from old.evidence
     or new.added_by is distinct from old.added_by
     or new.added_at is distinct from old.added_at then
    raise exception 'prepay_list_entries: una alta no se reescribe; quítala y agrega otra';
  end if;
  if old.removed_at is not null then
    raise exception 'prepay_list_entries: una alta quitada no se cambia ni se reabre';
  end if;
  -- `removed_known_order_ids` solo se escribe en la baja misma.
  if new.removed_known_order_ids is distinct from old.removed_known_order_ids and new.removed_at is null then
    raise exception 'prepay_list_entries: lo sabido al quitar se escribe solo al quitar';
  end if;
  return new;
end;
$$;

drop trigger if exists prepay_list_entries_guard on public.prepay_list_entries;
create trigger prepay_list_entries_guard
  before update on public.prepay_list_entries
  for each row execute function public.prepay_list_entries_guard();

create table if not exists public.prepay_list_settings (
  org_id           uuid primary key references public.organizations(id) on delete cascade,
  auto_mode        text not null default 'apagado' check (auto_mode in ('apagado', 'simulacion', 'activo')),
  -- `PrepaySimulationSummary` (lib/prepay-list.ts): cuentas y hasta 200
  -- nombres de pedido. Nunca la lista de celulares.
  last_simulation  jsonb,
  -- La última pasada en Activo: cuántas altas nuevas y cuándo.
  last_run         jsonb,
  updated_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now()
);

alter table public.prepay_list_entries enable row level security;
alter table public.prepay_list_settings enable row level security;

-- Leen los miembros de la organización (la lista es por organización: Kenku y
-- Aurela comparten la suya). Escribe solo el servidor, después de comprobar
-- `prepay_list.manage` o `automations.manage`.
drop policy if exists prepay_list_entries_read on public.prepay_list_entries;
create policy prepay_list_entries_read on public.prepay_list_entries
  for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists prepay_list_settings_read on public.prepay_list_settings;
create policy prepay_list_settings_read on public.prepay_list_settings
  for select to authenticated using (org_id in (select auth_org_ids()));

revoke all on public.prepay_list_entries, public.prepay_list_settings from anon, authenticated;
grant select on public.prepay_list_entries, public.prepay_list_settings to authenticated;
grant all on public.prepay_list_entries, public.prepay_list_settings to service_role;
