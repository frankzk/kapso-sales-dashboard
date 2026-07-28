-- ============================================================================
-- 0055_aliclik_catalog.sql — espejo del catálogo de Aliclik y mapeo de SKUs.
--
-- EL PROBLEMA. `POST /integration/order` exige `products[].ean` — el EAN del
-- catálogo de Aliclik — y que TODOS los productos del pedido salgan del MISMO
-- almacén (`warehouseId`, que además es obligatorio para cotizar el envío).
-- Nosotros solo tenemos el `sku` de Shopify que viene en `orders.line_items`.
-- No existía ninguna tabla de catálogo: `product_costs` (0050) tiene `sku` pero
-- es una tabla de costos, sin EAN ni almacén.
--
-- POR QUÉ UN ESPEJO Y NO CONSULTAR EN VIVO. El catálogo hace falta en cada
-- validación previa (¿este pedido es creable?), y esa pregunta se responde para
-- listas enteras de pedidos, no de uno en uno. Consultar la API por cada fila
-- sería insostenible. Además el directorio de agencias de Aliclik se sirve de un
-- cache en memoria que puede responder 502 si Shalom no contesta: cachearlo aquí
-- evita que una caída de Shalom bloquee una creación.
--
-- POR QUÉ DOS TABLAS Y NO UNA. `aliclik_skus` es un espejo: se reescribe entero
-- en cada sincronización y no contiene ninguna decisión nuestra. `aliclik_sku_map`
-- SÍ es una decisión del equipo (qué SKU de Shopify corresponde a qué EAN) y
-- debe sobrevivir a cualquier resincronización. Mezclarlas perdería el mapeo
-- manual en el primer sync.
--
-- Aplicar DESPUÉS de supabase/policies.sql (usa auth_store_ids()).
-- Nota 0053: Supabase concede TODO por defecto sobre cada tabla nueva, así que
-- hay que revocar antes de conceder.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Espejo del catálogo público (GET /integration/product/public)
-- ----------------------------------------------------------------------------

create table if not exists aliclik_skus (
  store_id            uuid not null references stores(id) on delete cascade,
  -- El EAN es el identificador que viaja en products[].ean. Es la clave.
  ean                 text not null,
  sku                 text,
  product_id          integer,
  product_name        text,
  sku_name            text,
  category            text,
  url_image           text,
  regular_price       numeric(12, 2),
  drop_price          numeric(12, 2),
  -- Ojo: stock RESERVABLE, no físico. Aliclik lo dice explícitamente. Sirve
  -- para avisar, y como bloqueo duro solo en agencia (donde el servidor lo exige).
  stock_virtual       integer,
  warehouse_id        integer,
  warehouse_name      text,
  -- Solo llegan con isAgency=true. `format_time_agency` es la hora de corte del
  -- almacén, contra la que se valida shipping.scheduleDate.
  format_time_agency  text,
  shalom_origin_in    text,
  -- ¿Apareció en la pasada con isAgency=true? Es lo que decide si este SKU se
  -- puede despachar por agencia Shalom.
  is_agency_eligible  boolean not null default false,
  synced_at           timestamptz not null default now(),
  primary key (store_id, ean)
);

create index if not exists aliclik_skus_sku_idx       on aliclik_skus(store_id, sku);
create index if not exists aliclik_skus_warehouse_idx on aliclik_skus(store_id, warehouse_id);

alter table aliclik_skus enable row level security;

drop policy if exists aliclik_skus_select on aliclik_skus;
create policy aliclik_skus_select on aliclik_skus for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_skus from anon, authenticated, service_role;
grant select         on aliclik_skus to authenticated;
grant all privileges on aliclik_skus to service_role;

-- ----------------------------------------------------------------------------
-- Mapeo SKU de Shopify → EAN de Aliclik. Decisión del equipo; sobrevive al sync.
-- ----------------------------------------------------------------------------

create table if not exists aliclik_sku_map (
  store_id     uuid not null references stores(id) on delete cascade,
  -- SKU tal y como llega en orders.line_items[].sku, ya normalizado (trim+upper)
  -- por lib/aliclik-catalog.ts. Normalizar aquí evita que "ABC " y "abc" sean
  -- dos entradas distintas para el mismo producto.
  shopify_sku  text not null,
  ean          text not null,
  -- 'auto' = sembrado por igualdad exacta de SKU en el sync; 'manual' = lo
  -- decidió una persona. El sync solo puede pisar los 'auto'.
  source       text not null default 'manual' check (source in ('auto', 'manual')),
  note         text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (store_id, shopify_sku)
);

create index if not exists aliclik_sku_map_ean_idx on aliclik_sku_map(store_id, ean);

alter table aliclik_sku_map enable row level security;

drop policy if exists aliclik_sku_map_select on aliclik_sku_map;
create policy aliclik_sku_map_select on aliclik_sku_map for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_sku_map from anon, authenticated, service_role;
grant select         on aliclik_sku_map to authenticated;
grant all privileges on aliclik_sku_map to service_role;

drop trigger if exists aliclik_sku_map_touch on aliclik_sku_map;
create trigger aliclik_sku_map_touch before update on aliclik_sku_map
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Directorio de agencias Shalom (GET /integration/order/agencies)
--
-- Cacheado en local a propósito: el endpoint se sirve de un cache en memoria de
-- Aliclik y responde 502 si Shalom no contesta y no hay cache. Un despacho no
-- puede depender de eso.
-- ----------------------------------------------------------------------------

create table if not exists aliclik_agencies (
  store_id   uuid not null references stores(id) on delete cascade,
  -- La API lo declara number | string | null y pide enviarlo como string.
  agency_id  text not null,
  name       text,
  address    text,
  department text,
  province   text,
  district   text,
  synced_at  timestamptz not null default now(),
  primary key (store_id, agency_id)
);

create index if not exists aliclik_agencies_name_idx on aliclik_agencies(store_id, name);

alter table aliclik_agencies enable row level security;

drop policy if exists aliclik_agencies_select on aliclik_agencies;
create policy aliclik_agencies_select on aliclik_agencies for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_agencies from anon, authenticated, service_role;
grant select         on aliclik_agencies to authenticated;
grant all privileges on aliclik_agencies to service_role;

-- ----------------------------------------------------------------------------
-- Tamaños de paquete (GET /integration/order/package-sizes)
-- ----------------------------------------------------------------------------

create table if not exists aliclik_package_sizes (
  store_id  uuid not null references stores(id) on delete cascade,
  title     text not null,
  position  integer,
  synced_at timestamptz not null default now(),
  primary key (store_id, title)
);

alter table aliclik_package_sizes enable row level security;

drop policy if exists aliclik_package_sizes_select on aliclik_package_sizes;
create policy aliclik_package_sizes_select on aliclik_package_sizes for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_package_sizes from anon, authenticated, service_role;
grant select         on aliclik_package_sizes to authenticated;
grant all privileges on aliclik_package_sizes to service_role;

comment on table aliclik_skus is
  'Espejo del catálogo público de Aliclik. Se reescribe en cada sync; no contiene decisiones nuestras.';
comment on table aliclik_sku_map is
  'SKU de Shopify → EAN de Aliclik. Decisión del equipo: el sync NO pisa las filas source=manual.';
