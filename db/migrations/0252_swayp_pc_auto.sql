-- 0252_swayp_pc_auto.sql — Swayp automático desde Por confirmar, piloto A/B
-- (MOM §11.13, 13-10-2026).
--
-- QUÉ ES. Una pasada diaria que hace lo mismo que el botón «Enviar por Swayp»
-- de la mesa de confirmación (§11.11) sobre pedidos frescos —hasta 48 h, con
-- 1 o 2 llamadas sin respuesta, dirección con número o manzana y lote, sin
-- agencia, ubicación corroborada y stock completo—. La mitad de los elegibles
-- sale por Swayp y la otra mitad sigue la cola de llamadas, para medir si de
-- verdad suma. Decisiones del owner: sin aviso por WhatsApp, 48 h, A/B de 10
-- por día.
--
-- APAGADO AL INSTALAR. La fila de cada organización nace con `enabled = false`;
-- lo activa una persona con «Administrar tiendas» desde el registro de Swayp
-- desde Por confirmar. Y se apaga sola —el freno— si de los últimos
-- `brake_window` casos resueltos se entrega menos de `brake_min_rate`.
--
-- Las tres tablas siguen el patrón del automático Aliclik → Swayp (0209): la
-- lectura respeta organización y tiendas por RLS y solo el servidor escribe.

create table if not exists swayp_pc_auto_settings (
  org_id            uuid primary key references organizations(id),
  enabled           boolean not null default false,
  daily_cap         integer not null default 10 check (daily_cap between 1 and 50),
  per_warehouse_cap integer not null default 3 check (per_warehouse_cap between 1 and 50),
  max_age_hours     integer not null default 48 check (max_age_hours between 1 and 168),
  min_attempts      integer not null default 1 check (min_attempts between 0 and 10),
  max_unanswered    integer not null default 2 check (max_unanswered between 0 and 10),
  max_amount        numeric not null default 300 check (max_amount > 0),
  brake_window      integer not null default 20 check (brake_window between 5 and 200),
  brake_min_rate    numeric not null default 0.35 check (brake_min_rate between 0 and 1),
  -- Por qué está apagado, si lo apagó el freno (null si lo apagó una persona).
  paused_reason     text,
  paused_at         timestamptz,
  updated_by        uuid references auth.users(id) on delete set null,
  updated_at        timestamptz not null default now()
);

-- Una decisión por pedido. Mientras no es elegible se reescribe en cada pasada
-- (el motivo cambia: hoy sin llamada, mañana sí); en cuanto es elegible queda
-- fija con su brazo, para que el A/B no cambie de lado a nadie.
create table if not exists swayp_pc_auto_decisions (
  order_id    uuid primary key references orders(id) on delete cascade,
  store_id    uuid not null references stores(id),
  org_id      uuid not null references organizations(id),
  arm         text check (arm in ('swayp', 'control')),
  reason      text not null,
  eligible    boolean not null default false,
  shipment_id uuid references shipments(id) on delete set null,
  evidence    jsonb not null default '{}',
  decided_at  timestamptz not null default now(),
  checked_at  timestamptz not null default now()
);
create index if not exists swayp_pc_auto_decisions_org_idx
  on swayp_pc_auto_decisions (org_id, eligible, decided_at desc);

create table if not exists swayp_pc_auto_runs (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id),
  summary    jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists swayp_pc_auto_runs_org_idx on swayp_pc_auto_runs (org_id, created_at desc);

alter table swayp_pc_auto_settings enable row level security;
alter table swayp_pc_auto_decisions enable row level security;
alter table swayp_pc_auto_runs enable row level security;
drop policy if exists swayp_pc_auto_settings_read on swayp_pc_auto_settings;
create policy swayp_pc_auto_settings_read on swayp_pc_auto_settings
  for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists swayp_pc_auto_decisions_read on swayp_pc_auto_decisions;
create policy swayp_pc_auto_decisions_read on swayp_pc_auto_decisions
  for select to authenticated using (store_id in (select auth_store_ids()));
drop policy if exists swayp_pc_auto_runs_read on swayp_pc_auto_runs;
create policy swayp_pc_auto_runs_read on swayp_pc_auto_runs
  for select to authenticated using (org_id in (select auth_org_ids()));
grant select on swayp_pc_auto_settings, swayp_pc_auto_decisions, swayp_pc_auto_runs to authenticated;
grant all on swayp_pc_auto_settings, swayp_pc_auto_decisions, swayp_pc_auto_runs to service_role;

-- Una fila apagada por organización con tiendas activas.
insert into swayp_pc_auto_settings (org_id)
select distinct org_id from stores where status = 'active' and org_id is not null
on conflict (org_id) do nothing;
