-- ============================================================================
-- 0051_order_geo.sql — corrección manual de la ubicación de un pedido.
--
-- El problema real: la dirección que llega de Shopify viene del formulario que
-- llenó el cliente, y Shopify mismo la marca con "Revisa los problemas con la
-- dirección" bastante seguido. El punto del mapa ("Ver mapa") apunta a donde
-- Shopify cree, que no es donde está. Y la provincia se infiere del distrito, que
-- también puede venir mal escrito.
--
-- Nada de eso se puede arreglar reescribiendo `orders`: esa tabla es el reflejo
-- de Shopify y la siguiente sincronización lo pisaría. Así que la corrección vive
-- aparte y GANA sobre todo lo demás al recalcular — el mismo criterio que
-- `shipments.address_override` (0038) usa para que un re-import no borre la
-- dirección que el equipo arregló a mano.
--
-- Aplicar DESPUÉS de supabase/policies.sql (usa auth_store_ids()).
-- ============================================================================

create table if not exists order_geo_overrides (
  order_id    uuid primary key references orders(id) on delete cascade,
  store_id    uuid not null references stores(id) on delete cascade,
  -- Cada campo es opcional: se corrige solo lo que está mal. Un nulo significa
  -- "esto no lo toco", no "bórralo".
  region      text,
  province    text,
  district    text,
  address     text,
  reference   text,
  -- Coordenadas corregidas a mano: son las que alimentan el enlace al mapa.
  latitude    double precision,
  longitude   double precision,
  note        text,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists order_geo_overrides_store_idx on order_geo_overrides(store_id);

alter table order_geo_overrides enable row level security;

drop policy if exists order_geo_overrides_select on order_geo_overrides;
create policy order_geo_overrides_select on order_geo_overrides for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on order_geo_overrides to authenticated;
grant all privileges on order_geo_overrides to service_role;

drop trigger if exists order_geo_overrides_touch on order_geo_overrides;
create trigger order_geo_overrides_touch before update on order_geo_overrides
  for each row execute function public.touch_updated_at();

comment on table order_geo_overrides is
  'Corrección manual de la ubicación de un pedido. Gana sobre Shopify, los reportes de courier y el ubigeo al recalcular order_master.';

-- ----------------------------------------------------------------------------
-- El Master carga la dirección y el punto del mapa en su propia fila, para que
-- el listado y el detalle no tengan que volver a resolverlos.
-- ----------------------------------------------------------------------------

alter table order_master
  add column if not exists address    text,
  add column if not exists reference  text,
  add column if not exists latitude   double precision,
  add column if not exists longitude  double precision,
  -- De dónde salió la ubicación vigente: manual | shopify | courier | ubigeo | draft
  add column if not exists geo_source text;

comment on column order_master.geo_source is
  'Origen de la ubicación vigente. "manual" = corregida por el equipo (order_geo_overrides).';

-- El ubigeo también se puede corregir: cuando el equipo arregla la provincia de
-- un distrito, se recuerda para los siguientes pedidos de ese distrito.
-- `source` distingue lo cargado del INEI de lo aprendido a mano.
comment on column peru_districts.source is
  'shipments = inferido de los reportes; inei = ubigeo oficial; manual = corregido por el equipo.';
