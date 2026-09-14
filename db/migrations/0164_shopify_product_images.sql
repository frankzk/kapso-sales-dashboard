-- 0164_shopify_product_images.sql — el espejo de la imagen del producto.
--
-- POR QUÉ UNA TABLA Y NO UNA LLAMADA EN VIVO. El desglose de productos (0163 y
-- el PR que lo rehízo) dibuja el hueco de una miniatura que hoy no existe:
-- Shopify NO manda imagen en el line item —0 de 15.726 ítems medidos el
-- 14-09-2026— y el pedido guardado tampoco la trae. Las dos salidas eran pedirla
-- a Shopify al abrir cada cajón, o espejarla.
--
-- Gana el espejo por una razón de tamaño: en 180 días los pedidos citan **331
-- productos distintos** sobre 21.789 ítems. Es un catálogo diminuto que cambia
-- poco, consultado desde una pantalla que se abre cientos de veces al día. Pedir
-- en vivo sería una llamada de red por apertura de cajón, con su latencia y su
-- modo de fallo, para releer 331 valores casi siempre iguales.
--
-- LA CLAVE ES (store_id, product_id) Y NO product_id A SECAS. El id de producto
-- es único dentro de una tienda, no entre tiendas: Aurela y Kenku son dos
-- Shopify distintas y nada impide que repitan un número. Sin el store_id, la
-- foto de un producto de una tienda podría aparecer en el pedido de la otra.
--
-- `product_id` se guarda tal como viene en `orders.line_items`: el id numérico
-- de la API REST («10020077175079»), que es la forma en que ya está escrito en
-- 21.789 ítems. Convertirlo al `gid://shopify/Product/...` de GraphQL es cosa
-- del sincronizador, no del almacenamiento: la tabla habla el idioma del dato
-- que ya tenemos, para que el JOIN sea directo y no haya que traducir al leer.

create table if not exists shopify_product_images (
  store_id     uuid        not null references stores(id) on delete cascade,
  -- Id numérico REST, como lo escribe Shopify en los line items del pedido.
  product_id   text        not null,
  -- URL del CDN de Shopify. Puede ser null: un producto sin foto es un dato
  -- válido y distinto de «todavía no lo hemos sincronizado» (esa es la fila
  -- ausente). Guardar el null evita volver a preguntar por él en cada pasada.
  image_url    text,
  -- Alternativo de la imagen tal como lo escribió quien cargó el producto.
  image_alt    text,
  -- El título del producto en el catálogo, que puede diferir del que quedó
  -- congelado en el pedido si alguien lo renombró después de la venta. No
  -- reemplaza al del pedido: sirve para saber si el espejo sigue apuntando a
  -- lo mismo.
  catalog_title text,
  synced_at    timestamptz not null default now(),
  primary key (store_id, product_id)
);

comment on table shopify_product_images is
  'Espejo de la foto de catálogo por producto y tienda. Lo llena /api/cron/shopify-product-images; se lee al armar el desglose de productos de un pedido.';

-- Se lee siempre por tienda + lote de ids (el desglose de UN pedido pide entre
-- uno y cinco), y eso ya lo sirve la clave primaria. El índice por antigüedad
-- es para el sincronizador, que busca lo más viejo para refrescarlo primero.
create index if not exists shopify_product_images_synced_idx
  on shopify_product_images (store_id, synced_at);

alter table shopify_product_images enable row level security;

-- Misma forma que `orders`, `shipments` y el resto de lo ingestado: lectura
-- para la sesión, acotada a las tiendas que esa persona alcanza, y escritura
-- solo por el rol de servicio (el cron). `auth_store_ids()` es la función que
-- ya resuelve ese alcance en todo el esquema; duplicar su lógica acá sería
-- plantar la próxima divergencia.
drop policy if exists shopify_product_images_select on shopify_product_images;
create policy shopify_product_images_select on shopify_product_images
  for select to authenticated
  using (store_id in (select auth_store_ids()));
