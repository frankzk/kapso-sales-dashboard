-- ============================================================================
-- 0349_lima_courier_auto.sql — Guía Aliclik y Swayp del día programado en Lima
-- (MOM §9.5, §6.2 y §40; owner, 16-11-2026: «Kapta la crea ese día»).
--
-- Desde la 0348 Repro Lima programa en lote con un courier. Con Aliclik o Swayp
-- el pedido queda programado; esta automatización crea su guía: la de Aliclik
-- la mañana del día y la de Swayp la víspera (Swayp arma su ruta el día
-- anterior). Es lo mismo que la 0345 hizo con la guía GF automática:
--
-- 1. `lima_courier_auto_settings`: la posición por organización (Apagado /
--    Simulación / Activo). Sin fila es Apagado.
-- 2. `lima_courier_auto_log`: lo que hizo (activo) o habría hecho (simulacion)
--    cada pasada, uno por pedido, día de Lima y modo, con el courier.
--
-- RLS de lectura para la organización; escritura solo del servidor. Aditiva:
-- sin drop de datos, no toca filas y se puede correr otra vez. Sin ella, el cron
-- responde 502 con «Falta la migración 0349» y la fila del panel queda bloqueada
-- como Apagado; no se crea ninguna guía. Nace Apagado en todas las organizaciones.
-- Se aplica a mano ANTES del código (DEPLOY.md).
-- ============================================================================

create table if not exists public.lima_courier_auto_settings (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  mode        text not null default 'apagado',
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table public.lima_courier_auto_settings drop constraint if exists lima_courier_auto_settings_mode_check;
alter table public.lima_courier_auto_settings add constraint lima_courier_auto_settings_mode_check
  check (mode in ('apagado', 'simulacion', 'activo'));
comment on table public.lima_courier_auto_settings is
  'Guía Aliclik y Swayp del día programado en Lima (0349, MOM §9.5): apagado | simulacion | activo por organización. Sin fila = apagado.';

create table if not exists public.lima_courier_auto_log (
  id          bigserial primary key,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  store_id    uuid not null references public.stores(id) on delete cascade,
  order_id    uuid not null references public.orders(id) on delete cascade,
  order_name  text,
  lima_day    date not null,
  mode        text not null,
  courier     text not null,
  dispatch_on date not null,
  origin      text not null,
  outcome     text not null,
  guide_code  text,
  detail      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.lima_courier_auto_log drop constraint if exists lima_courier_auto_log_mode_check;
alter table public.lima_courier_auto_log add constraint lima_courier_auto_log_mode_check
  check (mode in ('simulacion', 'activo'));
alter table public.lima_courier_auto_log drop constraint if exists lima_courier_auto_log_courier_check;
alter table public.lima_courier_auto_log add constraint lima_courier_auto_log_courier_check
  check (courier in ('aliclik', 'fenix'));
alter table public.lima_courier_auto_log drop constraint if exists lima_courier_auto_log_origin_check;
alter table public.lima_courier_auto_log add constraint lima_courier_auto_log_origin_check
  check (origin in ('envio', 'acuerdo'));
alter table public.lima_courier_auto_log drop constraint if exists lima_courier_auto_log_outcome_check;
alter table public.lima_courier_auto_log add constraint lima_courier_auto_log_outcome_check
  check (outcome in ('simulada', 'creada', 'fallo', 'en_curso'));
create unique index if not exists lima_courier_auto_log_day_uniq
  on public.lima_courier_auto_log (order_id, lima_day, mode);
create index if not exists lima_courier_auto_log_org_day_idx
  on public.lima_courier_auto_log (org_id, lima_day desc, mode);
comment on table public.lima_courier_auto_log is
  'Guía Aliclik y Swayp del día programado en Lima (0349, MOM §9.5): lo que hizo (activo) o habría hecho (simulacion) cada pasada, por pedido y día de Lima.';

alter table public.lima_courier_auto_settings enable row level security;
alter table public.lima_courier_auto_log enable row level security;

drop policy if exists lima_courier_auto_settings_read on public.lima_courier_auto_settings;
create policy lima_courier_auto_settings_read on public.lima_courier_auto_settings
  for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists lima_courier_auto_log_read on public.lima_courier_auto_log;
create policy lima_courier_auto_log_read on public.lima_courier_auto_log
  for select to authenticated using (store_id in (select auth_store_ids()));

revoke all on public.lima_courier_auto_settings, public.lima_courier_auto_log from anon, authenticated;
grant select on public.lima_courier_auto_settings, public.lima_courier_auto_log to authenticated;
grant all on public.lima_courier_auto_settings, public.lima_courier_auto_log to service_role;
grant usage, select on sequence public.lima_courier_auto_log_id_seq to service_role;
