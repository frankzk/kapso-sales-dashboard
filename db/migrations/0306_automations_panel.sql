-- ============================================================================
-- 0306_automations_panel.sql — panel de automatizaciones y reintentos Aliclik
-- automáticos en Lima (MOM §9.5 entrega 3 y §40, owner 04-11-2026).
--
-- POR QUÉ. El owner pidió un solo lugar con interruptores para todas las
-- automatizaciones, y que la creación automática de los reintentos de Lima se
-- encienda por variante (paso de la cadena × motivo), pasando antes por una
-- simulación.
--
-- QUÉ CREA.
--   * `lima_retry_auto_settings`: el tope diario de guías automáticas por
--     organización.
--   * `lima_retry_auto_variants`: la posición de cada variante (apagado,
--     simulación, activo). Sin fila = apagado.
--   * `lima_retry_auto_log`: lo que hizo o habría hecho cada pasada, un
--     renglón por pedido, día y modo. El único (pedido, día, modo) es el
--     candado del modo activo: una sola creación por pedido y día.
--   * `automation_switch_events`: quién cambió qué interruptor del panel, y
--     cuándo (los de las demás automatizaciones también).
--
-- No cambia datos. Correrla otra vez no cambia nada. Todo nace apagado.
-- ============================================================================

create table if not exists public.lima_retry_auto_settings (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  daily_cap   integer not null default 10 check (daily_cap between 1 and 50),
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.lima_retry_auto_variants (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  variant     text not null check (variant ~ '^(alexis_autoecom|urpi_autoecom|autoecom_alidriver_3|autoecom_alidriver_2):(no_contesta|no_estaba|otro)$'),
  mode        text not null default 'apagado' check (mode in ('apagado', 'simulacion', 'activo')),
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (org_id, variant)
);

create table if not exists public.lima_retry_auto_log (
  id          bigserial primary key,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  store_id    uuid not null references public.stores(id) on delete cascade,
  order_id    uuid not null references public.orders(id) on delete cascade,
  order_name  text,
  lima_day    date not null,
  variant     text not null,
  mode        text not null check (mode in ('simulacion', 'activo')),
  outcome     text not null check (outcome in (
                'simulada', 'creada', 'fallo', 'incierto', 'sin_transporte',
                'no_seleccionable', 'en_curso', 'tope', 'atendiendo', 'esperando_aliclik')),
  transport   text,
  guide_code  text,
  detail      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists lima_retry_auto_log_day_uniq
  on public.lima_retry_auto_log (order_id, lima_day, mode);
create index if not exists lima_retry_auto_log_org_day_idx
  on public.lima_retry_auto_log (org_id, lima_day desc, mode);

create table if not exists public.automation_switch_events (
  id           bigserial primary key,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  store_id     uuid references public.stores(id) on delete cascade,
  automation   text not null,
  previous     text,
  next         text not null,
  actor        uuid references auth.users(id) on delete set null,
  occurred_at  timestamptz not null default now()
);
create index if not exists automation_switch_events_org_idx
  on public.automation_switch_events (org_id, occurred_at desc);

alter table public.lima_retry_auto_settings enable row level security;
alter table public.lima_retry_auto_variants enable row level security;
alter table public.lima_retry_auto_log enable row level security;
alter table public.automation_switch_events enable row level security;

drop policy if exists lima_retry_auto_settings_read on public.lima_retry_auto_settings;
create policy lima_retry_auto_settings_read on public.lima_retry_auto_settings
  for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists lima_retry_auto_variants_read on public.lima_retry_auto_variants;
create policy lima_retry_auto_variants_read on public.lima_retry_auto_variants
  for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists lima_retry_auto_log_read on public.lima_retry_auto_log;
create policy lima_retry_auto_log_read on public.lima_retry_auto_log
  for select to authenticated using (store_id in (select auth_store_ids()));
drop policy if exists automation_switch_events_read on public.automation_switch_events;
create policy automation_switch_events_read on public.automation_switch_events
  for select to authenticated using (org_id in (select auth_org_ids()));

grant select on public.lima_retry_auto_settings, public.lima_retry_auto_variants,
  public.lima_retry_auto_log, public.automation_switch_events to authenticated;
grant all on public.lima_retry_auto_settings, public.lima_retry_auto_variants,
  public.lima_retry_auto_log, public.automation_switch_events to service_role;
grant usage, select on sequence public.lima_retry_auto_log_id_seq,
  public.automation_switch_events_id_seq to service_role;
