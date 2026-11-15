-- ============================================================================
-- 0345_gf_auto_guide.sql — «Guía GF automática» (MOM §29.17 y §40; owner,
-- 15-11-2026).
--
-- POR QUÉ. GF Courier por API (0344) ya crea la guía desde la Mesa de ruta,
-- pero cada pedido de Lima seguía esperando a que alguien la pulsara. El owner
-- decidió que el día del despacho, a las 9:00, 10:00 y 11:00 de Lima, Kapta la
-- cree sola para los pedidos de Lima por generar rótulo, y que se encienda desde
-- el panel de Automatizaciones con Apagado / Simulación / Activo, como los
-- reintentos de Lima (0306).
--
-- QUÉ CREA (aditiva: no toca ninguna fila).
--   * `gf_auto_guide_settings`: la posición por organización. Sin fila =
--     apagado: así nace todo, y el panel la crea al cambiarla.
--   * `gf_auto_guide_log`: lo que hizo o habría hecho cada pasada, un renglón
--     por pedido, día de Lima y modo; la última pasada del día lo sobrescribe.
--     Es lo que el panel muestra en «Hoy y ayer» y lo que deja la Simulación.
--
-- La regla de un intento por pedido y día no vive aquí: la da el hecho
-- `gf_auto_guide_failed` del historial del pedido, como la guía Aliclik del día
-- programado (§6.2). La creación sigue siendo la de 0344 (`gf_order_requests`).
--
-- No cambia datos. Correrla otra vez no cambia nada. Aplicar ANTES del código
-- (DEPLOY.md): sin ella el cron responde que falta y el panel bloquea la fila.
-- ============================================================================

create table if not exists public.gf_auto_guide_settings (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  mode        text not null default 'apagado',
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table public.gf_auto_guide_settings drop constraint if exists gf_auto_guide_settings_mode_check;
alter table public.gf_auto_guide_settings add constraint gf_auto_guide_settings_mode_check
  check (mode in ('apagado', 'simulacion', 'activo'));
comment on table public.gf_auto_guide_settings is
  'Guía GF automática (0345, MOM §29.17): apagado | simulacion | activo por organización. Sin fila = apagado.';

create table if not exists public.gf_auto_guide_log (
  id          bigserial primary key,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  store_id    uuid not null references public.stores(id) on delete cascade,
  order_id    uuid not null references public.orders(id) on delete cascade,
  order_name  text,
  lima_day    date not null,
  mode        text not null,
  outcome     text not null,
  guide_code  text,
  detail      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.gf_auto_guide_log drop constraint if exists gf_auto_guide_log_mode_check;
alter table public.gf_auto_guide_log add constraint gf_auto_guide_log_mode_check
  check (mode in ('simulacion', 'activo'));
alter table public.gf_auto_guide_log drop constraint if exists gf_auto_guide_log_outcome_check;
alter table public.gf_auto_guide_log add constraint gf_auto_guide_log_outcome_check
  check (outcome in ('simulada', 'creada', 'fallo', 'en_curso'));
-- Un renglón por pedido, día y modo: el upsert de cada pasada choca aquí.
create unique index if not exists gf_auto_guide_log_day_uniq
  on public.gf_auto_guide_log (order_id, lima_day, mode);
-- «Hoy y ayer» del panel, por organización.
create index if not exists gf_auto_guide_log_org_day_idx
  on public.gf_auto_guide_log (org_id, lima_day desc, mode);
comment on table public.gf_auto_guide_log is
  'Guía GF automática (0345, MOM §29.17): lo que hizo (activo) o habría hecho (simulacion) cada pasada, por pedido y día de Lima.';

-- RLS como sus pares de 0306: la organización lee lo suyo; solo el servidor
-- (service_role) escribe. Como en 0344, ni anon ni authenticated escriben.
alter table public.gf_auto_guide_settings enable row level security;
alter table public.gf_auto_guide_log enable row level security;

drop policy if exists gf_auto_guide_settings_read on public.gf_auto_guide_settings;
create policy gf_auto_guide_settings_read on public.gf_auto_guide_settings
  for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists gf_auto_guide_log_read on public.gf_auto_guide_log;
create policy gf_auto_guide_log_read on public.gf_auto_guide_log
  for select to authenticated using (store_id in (select auth_store_ids()));

revoke all on public.gf_auto_guide_settings, public.gf_auto_guide_log from anon, authenticated;
grant select on public.gf_auto_guide_settings, public.gf_auto_guide_log to authenticated;
grant all on public.gf_auto_guide_settings, public.gf_auto_guide_log to service_role;
grant usage, select on sequence public.gf_auto_guide_log_id_seq to service_role;
