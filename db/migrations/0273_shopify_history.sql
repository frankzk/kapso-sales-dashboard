-- ============================================================================
-- 0273_shopify_history.sql — el historial de Shopify de antes de Kapta, como
-- archivo de consulta (MOM §37, 23-10-2026, pedido de Frankz).
--
-- POR QUÉ. Aurela tiene 177.515 pedidos en Shopify desde 2021 y Kapta solo
-- trae los de junio de 2026 en adelante: la conexión no tiene `read_all_orders`
-- y no ve nada de más de 60 días. Shopify estaba por suspender la tienda, y
-- con ella se iba el historial de pedidos y de cada cliente. La salida fue la
-- exportación del propio Shopify (CSV por año, más el de clientes), que aquí se
-- guarda tal cual y además leíble.
--
-- QUÉ NO ES. No son pedidos de Kapta. No entran a `orders` ni a `order_master`,
-- no tienen etapa, no disparan recálculos, alertas ni tareas. Es un archivo:
-- quién compró, qué, cuándo, a dónde y cómo terminó, para consultarlo.
--
-- TRES TABLAS:
--   shopify_history_files      cada archivo subido: tipo, nombre, dónde quedó
--                              el original (bucket privado `shopify-history`),
--                              cuántos registros dejó y quién lo subió.
--   shopify_history_orders     un pedido por fila (el CSV de Shopify trae una
--                              fila por producto: aquí van juntos en
--                              `line_items`). `raw` guarda los campos de la
--                              primera fila del pedido tal como venían.
--   shopify_history_customers  un cliente por fila, del CSV de clientes.
--
-- Volver a subir el mismo archivo, o dos años que se pisan, no duplica nada:
-- la clave es (tienda, número de pedido) y (tienda, cliente).
--
-- Escritura solo con el service role (la acción de subida). Lectura: quien ve
-- la tienda (`auth_store_ids()`), y la pantalla además exige «Descargar la base
-- de pedidos».
-- ============================================================================

create table if not exists shopify_history_files (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  kind         text not null check (kind in ('pedidos', 'clientes', 'productos', 'otro')),
  filename     text not null,
  -- El original, comprimido, en el bucket privado `shopify-history`.
  storage_path text,
  size_bytes   bigint,
  rows_read    integer not null default 0,
  records      integer not null default 0,
  first_at     timestamptz,
  last_at      timestamptz,
  status       text not null default 'subiendo'
    check (status in ('subiendo', 'cargando', 'listo', 'error')),
  error        text,
  uploaded_by  uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists shopify_history_files_store_idx
  on shopify_history_files (store_id, created_at desc);

create table if not exists shopify_history_orders (
  store_id            uuid not null references stores(id) on delete cascade,
  order_name          text not null,
  shopify_order_id    text,
  created_at          timestamptz,
  paid_at             timestamptz,
  fulfilled_at        timestamptz,
  cancelled_at        timestamptz,
  financial_status    text,
  fulfillment_status  text,
  currency            text,
  subtotal            numeric(12, 2),
  shipping            numeric(12, 2),
  taxes               numeric(12, 2),
  total               numeric(12, 2),
  discount_code       text,
  discount_amount     numeric(12, 2),
  refunded_amount     numeric(12, 2),
  payment_method      text,
  email               text,
  phone               text,
  -- `normalizePhone` (lib/phone.ts): 51 + nueve dígitos, como `orders`.
  phone_norm          text,
  customer_name       text,
  shipping_name       text,
  shipping_address1   text,
  shipping_address2   text,
  shipping_city       text,
  shipping_province   text,
  shipping_zip        text,
  shipping_country    text,
  shipping_phone      text,
  notes               text,
  tags                text,
  source              text,
  line_items          jsonb not null default '[]'::jsonb,
  raw                 jsonb not null default '{}'::jsonb,
  file_id             uuid references shopify_history_files(id) on delete set null,
  imported_at         timestamptz not null default now(),
  primary key (store_id, order_name)
);

create index if not exists shopify_history_orders_phone_idx
  on shopify_history_orders (store_id, phone_norm);
create index if not exists shopify_history_orders_email_idx
  on shopify_history_orders (store_id, lower(email));
create index if not exists shopify_history_orders_created_idx
  on shopify_history_orders (store_id, created_at);

create table if not exists shopify_history_customers (
  store_id            uuid not null references stores(id) on delete cascade,
  -- El «Customer ID» de Shopify; si el archivo no lo trae, el correo o el
  -- celular. Nunca vacío: una fila sin nada que la identifique no se guarda.
  customer_key        text not null,
  shopify_customer_id text,
  first_name          text,
  last_name           text,
  email               text,
  phone               text,
  phone_norm          text,
  company             text,
  address1            text,
  address2            text,
  city                text,
  province            text,
  country             text,
  zip                 text,
  total_spent         numeric(12, 2),
  total_orders        integer,
  accepts_marketing   text,
  tags                text,
  note                text,
  raw                 jsonb not null default '{}'::jsonb,
  file_id             uuid references shopify_history_files(id) on delete set null,
  imported_at         timestamptz not null default now(),
  primary key (store_id, customer_key)
);

create index if not exists shopify_history_customers_phone_idx
  on shopify_history_customers (store_id, phone_norm);
create index if not exists shopify_history_customers_email_idx
  on shopify_history_customers (store_id, lower(email));

alter table shopify_history_files enable row level security;
alter table shopify_history_orders enable row level security;
alter table shopify_history_customers enable row level security;

drop policy if exists shopify_history_files_select on shopify_history_files;
create policy shopify_history_files_select on shopify_history_files for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists shopify_history_orders_select on shopify_history_orders;
create policy shopify_history_orders_select on shopify_history_orders for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists shopify_history_customers_select on shopify_history_customers;
create policy shopify_history_customers_select on shopify_history_customers for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on shopify_history_files, shopify_history_orders, shopify_history_customers to authenticated;
