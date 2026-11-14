-- ============================================================================
-- 0344_gf_courier_api.sql — GF Courier por API (MOM §29.17).
--
-- POR QUÉ. GF Courier pasó a ser un sistema independiente con API propia
-- (POST /v1/orders, webhooks firmados) y reemplaza al módulo interno de Grupo GF
-- (§29) para todas las tiendas. Kapta deja de planificar rutas y motorizados:
-- crea la guía en GF y sigue su estado, como hace con Aliclik.
--
-- QUÉ CAMBIA.
--   * stores: token de la API de GF y secreto de webhooks, cifrados (lib/crypto.ts,
--     ENCRYPTION_KEY), y el interruptor por tienda `gf_courier_enabled`.
--   * gf_order_requests: intención de crear la guía, escrita ANTES del POST. A
--     diferencia de Aliclik, GF tiene Idempotency-Key: un timeout se reintenta
--     con la MISMA clave y GF devuelve la misma guía. El índice único parcial
--     sigue siendo el candado contra dos guías para el mismo pedido.
--   * gf_webhook_events: registro append-only de cada evento recibido; su id
--     (X-GF-Event-Id) es la idempotencia: un reintento de GF choca aquí.
-- No toca datos existentes, sin drop, se puede correr otra vez.
-- Aplicar DESPUÉS de supabase/policies.sql y ANTES del código (DEPLOY.md).
-- ============================================================================

alter table stores add column if not exists gf_courier_api_token_enc text;
alter table stores add column if not exists gf_courier_webhook_secret_enc text;
alter table stores add column if not exists gf_courier_enabled boolean not null default false;

create table if not exists gf_order_requests (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  order_id        uuid not null references orders(id) on delete cascade,
  -- external_id enviado a GF: el nombre del pedido, con sufijo -S2, -S3… para salidas posteriores.
  external_id     text not null check (length(external_id) between 1 and 100),
  idempotency_key text not null check (length(idempotency_key) between 8 and 128),
  -- pending → escrito antes del POST · sent → GF devolvió la guía · failed → GF rechazó (se puede reintentar)
  status          text not null default 'pending' check (status in ('pending','sent','failed')),
  tracking_id     text,
  request         jsonb not null default '{}'::jsonb,
  response        jsonb,
  http_status     integer,
  error_code      text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists gf_order_requests_key_uniq on gf_order_requests(idempotency_key);
-- EL CANDADO: un solo intento vivo por pedido.
create unique index if not exists gf_order_requests_live_uniq on gf_order_requests(order_id) where status <> 'failed';
create index if not exists gf_order_requests_pending_idx on gf_order_requests(created_at) where status = 'pending';

alter table gf_order_requests enable row level security;
drop policy if exists gf_order_requests_select on gf_order_requests;
create policy gf_order_requests_select on gf_order_requests for select to authenticated
  using (store_id in (select auth_store_ids()));
revoke all on gf_order_requests from anon, authenticated;
grant select on gf_order_requests to authenticated;
grant all on gf_order_requests to service_role;

create table if not exists gf_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  event_id      text not null,               -- X-GF-Event-Id
  store_id      uuid references stores(id) on delete cascade,
  type          text not null,
  tracking_id   text,
  payload       jsonb not null default '{}'::jsonb,
  -- applied | duplicate | unknown_order | ignored | error
  outcome       text,
  received_at   timestamptz not null default now()
);
create unique index if not exists gf_webhook_events_event_uniq on gf_webhook_events(event_id);
create index if not exists gf_webhook_events_tracking_idx on gf_webhook_events(tracking_id, received_at desc);

alter table gf_webhook_events enable row level security;
drop policy if exists gf_webhook_events_select on gf_webhook_events;
create policy gf_webhook_events_select on gf_webhook_events for select to authenticated
  using (store_id in (select auth_store_ids()));
revoke all on gf_webhook_events from anon, authenticated, service_role;
grant select on gf_webhook_events to authenticated;
grant select, insert on gf_webhook_events to service_role;
drop trigger if exists gf_webhook_events_immutable on gf_webhook_events;
create trigger gf_webhook_events_immutable before update or delete on gf_webhook_events
  for each row execute function public.reject_mutation();

comment on table gf_order_requests is 'MOM §29.17: intención de crear la guía en GF Courier, escrita antes del POST; candado de una guía viva por pedido.';
comment on table gf_webhook_events is 'MOM §29.17: eventos firmados recibidos de GF Courier, append-only; X-GF-Event-Id es la idempotencia.';
