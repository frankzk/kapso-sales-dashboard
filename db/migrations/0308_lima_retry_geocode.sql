-- ============================================================================
-- 0308_lima_retry_geocode.sql — ubicación por dirección (Google) en los
-- reintentos Aliclik automáticos de Lima, y el resultado «Sin ubicación»
-- (MOM §9.5 entrega 3, §38 y §40; owner, 05-11-2026).
--
-- POR QUÉ. Aliclik exige la coordenada y, desde WooCommerce, en Lima solo un
-- 10–20 % de los pedidos la trae (en Shopify, el 99 %). La simulación del
-- 05-11-2026 dio 1 de 19 «Habría creado» y 18 «Este pedido no tiene
-- coordenada». Lima nunca se midió sola en el piloto de Google.
--
-- QUÉ CAMBIA.
--   * `lima_retry_auto_settings.geocode_enabled`: el interruptor «Usar la
--     ubicación por dirección (Google) si el pedido no tiene», por
--     organización. Nace APAGADO. El panel solo deja encenderlo si la última
--     medición de Lima cumple el criterio B con el edificio (ROOFTOP).
--   * `lima_retry_auto_log.outcome` acepta `sin_ubicacion`: el pedido no tiene
--     coordenada usable. Se reintenta, no cuenta para el tope y no avisa.
--   * `geocode_pilot_runs`: la cuenta de cada medición (solo números: ni
--     direcciones, ni nombres, ni celulares, ni números de pedido). Hoy solo
--     la medición de Lima de los reintentos (`coverage = 'lima'`).
--
-- No cambia datos. Correrla otra vez no cambia nada.
-- ============================================================================

alter table public.lima_retry_auto_settings
  add column if not exists geocode_enabled boolean not null default false;

alter table public.lima_retry_auto_log drop constraint if exists lima_retry_auto_log_outcome_check;
alter table public.lima_retry_auto_log add constraint lima_retry_auto_log_outcome_check check (outcome in (
  'simulada', 'creada', 'fallo', 'incierto', 'sin_transporte',
  'no_seleccionable', 'en_curso', 'tope', 'atendiendo', 'esperando_aliclik',
  'sin_ubicacion'));

create table if not exists public.geocode_pilot_runs (
  id          bigserial primary key,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  -- Null: la medición es de todas las tiendas de la organización.
  store_id    uuid references public.stores(id) on delete cascade,
  coverage    text not null check (coverage in ('lima', 'provincia_cod')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  -- `GeocodeLimaRunSummary` (lib/geocode-google.ts): solo cuentas.
  summary     jsonb not null
);
create index if not exists geocode_pilot_runs_org_idx
  on public.geocode_pilot_runs (org_id, coverage, created_at desc);

alter table public.geocode_pilot_runs enable row level security;

drop policy if exists geocode_pilot_runs_read on public.geocode_pilot_runs;
create policy geocode_pilot_runs_read on public.geocode_pilot_runs
  for select to authenticated using (org_id in (select auth_org_ids()));

grant select on public.geocode_pilot_runs to authenticated;
grant all on public.geocode_pilot_runs to service_role;
grant usage, select on sequence public.geocode_pilot_runs_id_seq to service_role;
