-- ============================================================================
-- 0138_group_gf_logistics_requests.sql
-- Admisión de pedidos Kapta desde la bandeja de Grupo GF Courier (MOM §29.2).
--
-- La solicitud es distinta del pedido comercial y de la salida física. Congela
-- el contrato y la tarifa aceptados, enlaza el único QR de la caja y conserva
-- una bitácora append-only. Una restricción parcial impide que dos operadores
-- acepten en paralelo el mismo pedido para Grupo GF.
-- ============================================================================

create table if not exists logistics_requests (
  id                    uuid primary key default gen_random_uuid(),
  provider_id           uuid not null references logistics_providers(id) on delete restrict,
  agreement_id          uuid not null references logistics_service_agreements(id) on delete restrict,
  store_id              uuid not null references stores(id) on delete restrict,
  order_id              uuid not null references orders(id) on delete restrict,
  shipment_id           uuid references shipments(id) on delete restrict,
  source                text not null default 'kapta'
    check (source in ('kapta', 'shopify', 'api', 'excel')),
  external_reference    text,
  idempotency_key       text not null,
  status                text not null default 'accepting'
    check (status in (
      'accepting', 'accepted', 'observed', 'cancelled',
      'scheduled', 'in_route', 'completed'
    )),
  district_key          text not null references peru_districts(district_key) on delete restrict,
  tariff_id             uuid not null references logistics_district_tariffs(id) on delete restrict,
  tariff_amount         numeric(12, 2) not null check (tariff_amount >= 0),
  currency              text not null default 'PEN',
  includes_igv          boolean not null default true,
  scheduled_for         date not null,
  requested_by          uuid references auth.users(id) on delete set null,
  requested_at          timestamptz not null default now(),
  accepted_by           uuid references auth.users(id) on delete set null,
  accepted_at           timestamptz,
  observation           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (length(trim(idempotency_key)) > 0),
  check (length(trim(currency)) > 0)
);

create unique index if not exists logistics_requests_idempotency_uniq
  on logistics_requests(idempotency_key);
create unique index if not exists logistics_requests_active_order_uniq
  on logistics_requests(provider_id, order_id)
  where status <> 'cancelled';
create unique index if not exists logistics_requests_shipment_uniq
  on logistics_requests(shipment_id)
  where shipment_id is not null;
create index if not exists logistics_requests_provider_status_idx
  on logistics_requests(provider_id, status, scheduled_for, created_at desc);
create index if not exists logistics_requests_store_idx
  on logistics_requests(store_id, created_at desc);

drop trigger if exists logistics_requests_touch on logistics_requests;
create trigger logistics_requests_touch before update on logistics_requests
  for each row execute function public.touch_updated_at();

create table if not exists logistics_request_events (
  id                    uuid primary key default gen_random_uuid(),
  request_id            uuid not null references logistics_requests(id) on delete cascade,
  kind                  text not null,
  status                text,
  actor                 uuid references auth.users(id) on delete set null,
  note                  text,
  payload               jsonb not null default '{}'::jsonb,
  occurred_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  check (length(trim(kind)) > 0)
);

create index if not exists logistics_request_events_request_idx
  on logistics_request_events(request_id, occurred_at desc);

comment on table logistics_requests is
  'Solicitud logística separada del pedido Shopify. Congela contrato, tarifa y salida aceptados por Grupo GF Courier.';
comment on column logistics_requests.shipment_id is
  'Salida física de Kapta. Si ya existía una salida por definir, conserva su fila y QR.';
comment on table logistics_request_events is
  'Bitácora append-only de la solicitud logística; los hechos no se corrigen destruyendo historial.';

alter table logistics_requests enable row level security;
alter table logistics_request_events enable row level security;

drop policy if exists logistics_requests_select on logistics_requests;
create policy logistics_requests_select on logistics_requests
  for select to authenticated using (
    store_id in (select auth_store_ids())
    or provider_id in (
      select id from logistics_providers where org_id in (select auth_org_ids())
    )
  );
drop policy if exists logistics_requests_write on logistics_requests;
create policy logistics_requests_write on logistics_requests
  for all to authenticated
  using (provider_id in (
    select id from logistics_providers where org_id in (select auth_admin_org_ids())
  ))
  with check (provider_id in (
    select id from logistics_providers where org_id in (select auth_admin_org_ids())
  ));

drop policy if exists logistics_request_events_select on logistics_request_events;
create policy logistics_request_events_select on logistics_request_events
  for select to authenticated using (
    request_id in (select id from logistics_requests)
  );
drop policy if exists logistics_request_events_insert on logistics_request_events;
create policy logistics_request_events_insert on logistics_request_events
  for insert to authenticated with check (
    request_id in (
      select lr.id
        from logistics_requests lr
        join logistics_providers lp on lp.id = lr.provider_id
       where lp.org_id in (select auth_admin_org_ids())
    )
  );

grant select, insert, update on logistics_requests to authenticated;
grant select, insert on logistics_request_events to authenticated;
grant all privileges on logistics_requests, logistics_request_events to service_role;

