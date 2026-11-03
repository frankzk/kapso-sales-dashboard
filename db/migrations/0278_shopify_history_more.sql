-- ============================================================================
-- 0278_shopify_history_more.sql — el resto de lo que se puede traer de Shopify
-- por API antes del cierre (MOM §37.6, 24-10-2026, pedido de Frankz: «dale con
-- todo lo que puedas por API»).
--
-- Va todo al historial de §37: nunca a `orders` ni al Master.
--
--   shopify_history_products        el catálogo completo: descripción, variantes
--                                   (SKU, precio, precio tachado, stock),
--                                   colecciones, metacampos y SEO.
--   shopify_history_product_images  cada foto de cada producto, en su tamaño
--                                   original, y dónde quedó la copia en el
--                                   bucket privado `shopify-history`.
--   shopify_history_carts           carritos abandonados de la web y borradores
--                                   (el formulario contra entrega): quién dejó
--                                   sus datos y qué quería comprar.
--
-- Y más detalle en lo que ya se trajo:
--   pedidos   método de envío, despachos con su guía y courier, devoluciones
--             y de qué visita o campaña vino la compra (UTM).
--   clientes  permiso de SMS y de WhatsApp, todas sus direcciones, desde
--             cuándo es cliente y su estado de cuenta.
--
-- `shopify_history_imports.kind` admite los tres tipos nuevos.
-- Escritura solo con el service role. Lectura: quien ve la tienda.
-- ============================================================================

alter table shopify_history_imports drop constraint if exists shopify_history_imports_kind_check;
alter table shopify_history_imports add constraint shopify_history_imports_kind_check
  check (kind in ('pedidos', 'clientes', 'productos', 'carritos', 'borradores'));

alter table shopify_history_orders add column if not exists shipping_method text;
alter table shopify_history_orders add column if not exists fulfillments jsonb;
alter table shopify_history_orders add column if not exists refunds jsonb;
alter table shopify_history_orders add column if not exists attribution jsonb;

alter table shopify_history_customers add column if not exists sms_marketing text;
alter table shopify_history_customers add column if not exists whatsapp_marketing text;
alter table shopify_history_customers add column if not exists addresses jsonb;
alter table shopify_history_customers add column if not exists customer_since timestamptz;
alter table shopify_history_customers add column if not exists account_state text;

create table if not exists shopify_history_products (
  store_id         uuid not null references stores(id) on delete cascade,
  product_id       text not null,
  handle           text,
  title            text,
  status           text,
  vendor           text,
  product_type     text,
  tags             text,
  description_html text,
  seo_title        text,
  seo_description  text,
  created_at       timestamptz,
  updated_at       timestamptz,
  published_at     timestamptz,
  options          jsonb not null default '[]'::jsonb,
  variants         jsonb not null default '[]'::jsonb,
  collections      jsonb not null default '[]'::jsonb,
  metafields       jsonb not null default '[]'::jsonb,
  import_id        uuid references shopify_history_imports(id) on delete set null,
  imported_at      timestamptz not null default now(),
  primary key (store_id, product_id)
);

create table if not exists shopify_history_product_images (
  store_id     uuid not null references stores(id) on delete cascade,
  image_id     text not null,
  product_id   text not null,
  position     integer,
  src_url      text not null,
  alt          text,
  width        integer,
  height       integer,
  -- La copia en el bucket privado `shopify-history`; null mientras falta.
  storage_path text,
  attempts     integer not null default 0,
  error        text,
  copied_at    timestamptz,
  import_id    uuid references shopify_history_imports(id) on delete set null,
  imported_at  timestamptz not null default now(),
  primary key (store_id, image_id)
);

create index if not exists shopify_history_product_images_pending_idx
  on shopify_history_product_images (store_id) where storage_path is null;

create table if not exists shopify_history_carts (
  store_id      uuid not null references stores(id) on delete cascade,
  -- «carrito:<id>» (checkout abandonado) o «borrador:<id>» (pedido borrador).
  cart_key      text not null,
  kind          text not null check (kind in ('carrito', 'borrador')),
  name          text,
  status        text,
  created_at    timestamptz,
  updated_at    timestamptz,
  completed_at  timestamptz,
  email         text,
  phone         text,
  phone_norm    text,
  customer_name text,
  address1      text,
  address2      text,
  city          text,
  province      text,
  total         numeric(12, 2),
  currency      text,
  -- El enlace para retomar la compra (carrito) o la factura (borrador).
  url           text,
  -- El pedido en que terminó, si terminó en uno.
  order_name    text,
  tags          text,
  line_items    jsonb not null default '[]'::jsonb,
  raw           jsonb not null default '{}'::jsonb,
  import_id     uuid references shopify_history_imports(id) on delete set null,
  imported_at   timestamptz not null default now(),
  primary key (store_id, cart_key)
);

create index if not exists shopify_history_carts_phone_idx
  on shopify_history_carts (store_id, phone_norm);
create index if not exists shopify_history_carts_email_idx
  on shopify_history_carts (store_id, lower(email));
create index if not exists shopify_history_carts_created_idx
  on shopify_history_carts (store_id, created_at);

alter table shopify_history_products enable row level security;
alter table shopify_history_product_images enable row level security;
alter table shopify_history_carts enable row level security;

drop policy if exists shopify_history_products_select on shopify_history_products;
create policy shopify_history_products_select on shopify_history_products for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists shopify_history_product_images_select on shopify_history_product_images;
create policy shopify_history_product_images_select on shopify_history_product_images for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists shopify_history_carts_select on shopify_history_carts;
create policy shopify_history_carts_select on shopify_history_carts for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on shopify_history_products, shopify_history_product_images, shopify_history_carts to authenticated;
