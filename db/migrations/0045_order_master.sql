-- ============================================================================
-- 0045_order_master.sql — Master de Pedidos: la vista central de control de la
-- operación logística de las dos tiendas.
--
-- Dos tablas, con responsabilidades distintas:
--
--   * order_master — UNA fila por pedido, materializada. Es el read-model del
--     listado: lleva denormalizado todo lo que la tabla filtra y ordena (estado
--     general + operativo, antigüedad, rollup de couriers/intentos, dirección).
--     Se materializa porque PostgREST no hace joins ni agregados filtrables: sin
--     esta tabla, filtrar por "más de un courier" o por distrito obligaría a
--     traer todos los pedidos a memoria en cada carga. Mismo criterio con el que
--     `shipments` ya carga un snapshot del pedido (0022).
--     Se recalcula desde lib/order-master.ts; NADIE la edita a mano.
--
--   * order_events — la línea de tiempo + la auditoría. APPEND-ONLY: guarda lo
--     que no cuelga de una guía (comentarios, cambios manuales de estado,
--     anulación en Shopify, importaciones). Las gestiones por courier siguen
--     viviendo en shipments/shipment_calls (0022/0023) — el Master NO las
--     duplica, las mezcla en lectura dentro del detalle del pedido.
--
-- La dirección se denormaliza aquí porque `orders` no tiene columnas de
-- dirección: hoy solo vive dentro de orders.raw (jsonb sin indexar), que se
-- parsea con lib/shopify-address.ts.
--
-- RLS: lecturas por tienda accesible; escrituras por service role (server
-- actions), como el resto de la data ingestada. Aplicar DESPUÉS de
-- supabase/policies.sql (usa auth_store_ids()).
-- ============================================================================

create table if not exists order_master (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references stores(id) on delete cascade,
  order_id           uuid not null references orders(id) on delete cascade,

  -- ── snapshot del pedido (denormalizado: una sola tabla = una sola consulta)
  order_name         text,                       -- "#KP114985"
  shopify_order_id   text not null,
  order_created_at   timestamptz,
  customer_name      text,
  customer_phone     text,                       -- normalizado (lib/phone.ts)
  region             text,                       -- departamento (shippingAddress.province)
  province           text,                       -- provincia (derivada vía peru_districts)
  district           text,                       -- distrito (shippingAddress.city)
  shipping_mode      text,                       -- cod | agency
  order_total        numeric(14, 2),

  -- ── estado resuelto (lib/order-status.ts)
  general_status     text not null default 'pendiente'
                       check (general_status in
                         ('pendiente', 'en_proceso', 'entregado', 'anulado', 'devuelto')),
  operational_status text not null default 'sin_confirmar',
  status_since       timestamptz,                -- desde cuándo está en este estado
  status_source      text,                       -- shopify | aliclik | fenix | shalom | olva | manual
  -- Un cambio manual auditado congela el estado: el recálculo automático deja
  -- de pisarlo. Es el mecanismo del §4 de la especificación ("los cambios
  -- posteriores sobre un pedido entregado requieren modificación manual").
  status_locked      boolean not null default false,

  -- ── rollup logístico (agregado de shipments + order_events)
  current_courier    text,
  last_courier       text,
  courier_count      integer not null default 0,
  attempt_count      integer not null default 0,
  guide_code         text,                       -- guía/tracking vigente
  dispatched_at      timestamptz,
  delivered_at       timestamptz,
  delivered_courier  text,                       -- a quién se atribuye la entrega
  returned_at        timestamptz,
  last_movement_at   timestamptz,
  comment_count      integer not null default 0,
  logistics_cost     numeric(12, 2),             -- resuelto en el recálculo (fase 4)

  recomputed_at      timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (order_id)
);

create index if not exists order_master_store_general_idx  on order_master(store_id, general_status);
create index if not exists order_master_store_oper_idx     on order_master(store_id, operational_status);
create index if not exists order_master_store_created_idx  on order_master(store_id, order_created_at desc);
create index if not exists order_master_store_movement_idx on order_master(store_id, last_movement_at desc);
create index if not exists order_master_store_district_idx on order_master(store_id, district);
create index if not exists order_master_store_province_idx on order_master(store_id, province);
create index if not exists order_master_store_region_idx   on order_master(store_id, region);
create index if not exists order_master_store_courier_idx  on order_master(store_id, current_courier);
create index if not exists order_master_phone_idx          on order_master(store_id, customer_phone);
create index if not exists order_master_guide_idx          on order_master(guide_code) where guide_code is not null;
-- Filtros "con más de un courier" / "con más de un intento": índices parciales
-- para que la cola no escanee toda la tabla.
create index if not exists order_master_multi_courier_idx  on order_master(store_id) where courier_count > 1;
create index if not exists order_master_multi_attempt_idx  on order_master(store_id) where attempt_count > 1;
-- Barrido de reconciliación del cron: pedidos con el rollup desfasado.
create index if not exists order_master_recomputed_idx     on order_master(recomputed_at);

alter table order_master enable row level security;

drop policy if exists order_master_select on order_master;
create policy order_master_select on order_master for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on order_master to authenticated;
grant all privileges on order_master to service_role;

-- touch_updated_at() se define en 0004_leads.sql
drop trigger if exists order_master_touch on order_master;
create trigger order_master_touch before update on order_master
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- order_events — línea de tiempo + auditoría, APPEND-ONLY
-- ----------------------------------------------------------------------------

create table if not exists order_events (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references stores(id) on delete cascade,
  order_id             uuid not null references orders(id) on delete cascade,
  -- created | confirmed | cancelled_shopify | courier_assigned | guide_registered
  -- | dispatched | out_for_delivery | attempt_failed | comment | reschedule
  -- | courier_change | delivered | return_started | returned | status_override
  -- | import | payment | key_view | key_shared
  kind                 text not null,
  occurred_at          timestamptz not null default now(),
  actor                uuid references auth.users(id) on delete set null,
  -- shopify | aliclik | fenix | shalom | olva | repro_provincia | report | manual | system
  source               text not null default 'manual',
  courier              text,
  guide_code           text,
  previous_status      text,
  new_status           text,
  previous_operational text,
  new_operational      text,
  attempt_number       integer,
  reason               text,   -- motivo de no entrega / motivo obligatorio de una excepción
  note                 text,
  comment_type         text,   -- solo para kind = 'comment'
  shipment_id          uuid references shipments(id) on delete set null,
  batch_id             uuid,   -- import_batches(id) cuando el evento vino de un reporte
  payload              jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

create index if not exists order_events_order_idx    on order_events(order_id, occurred_at desc);
create index if not exists order_events_store_idx    on order_events(store_id, occurred_at desc);
create index if not exists order_events_kind_idx     on order_events(store_id, kind);
create index if not exists order_events_shipment_idx on order_events(shipment_id) where shipment_id is not null;

alter table order_events enable row level security;

drop policy if exists order_events_select on order_events;
create policy order_events_select on order_events for select to authenticated
  using (store_id in (select auth_store_ids()));

-- APPEND-ONLY. El historial de auditoría no debe poder eliminarse ni editarse
-- (§16 y §"Auditoría de visualización" de la especificación). service_role NO es
-- superusuario: basta con no otorgarle update/delete para que sea imposible por
-- la API. El trigger es defensa en profundidad y deja la intención documentada
-- para quien entre por psql con otro rol.
grant select on order_events to authenticated;
grant select, insert on order_events to service_role;

create or replace function public.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'La tabla % es append-only: no admite % (auditoría inmutable).',
    tg_table_name, tg_op;
end;
$$;

drop trigger if exists order_events_append_only on order_events;
create trigger order_events_append_only before update or delete on order_events
  for each row execute function public.reject_mutation();
