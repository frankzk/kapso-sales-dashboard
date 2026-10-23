-- 0273_woocommerce_base.sql — la base para que una tienda reciba pedidos de
-- WooCommerce (MOM §37, 23-10-2026).
--
-- QUÉ PASA. Shopify cierra Kenku Perú y Aurela el 28-10-2026 (UTC; se planifica
-- para el 27-10 a las 19:00 de Lima) y las dos pasan a WooCommerce. Kapta tiene
-- que poder guardar con qué entrar a la tienda WooCommerce y distinguir de qué
-- plataforma viene cada pedido: entre la salida a producción y el cierre llegan
-- a la vez cambios de los pedidos viejos de Shopify y pedidos nuevos de
-- WooCommerce, y cada uno se trata según SU plataforma, nunca por la forma de su
-- id. Si WooCommerce va en la misma fila de la tienda o en una nueva lo decide
-- el owner; esto sirve igual para las dos: las credenciales viven en una fila de
-- `stores` y cada pedido lleva su plataforma.
--
-- QUÉ CAMBIA.
--   stores.platform                 dónde se crean los pedidos NUEVOS que Kapta
--                                   crea para esta tienda: 'shopify' (todas hoy)
--                                   o 'woocommerce'. No dice de dónde viene cada
--                                   pedido: eso es orders.platform.
--   stores.woo_site_url             la dirección del sitio WordPress, solo
--                                   https (https://kenku.pe, sin barra final).
--   stores.woo_site_key             clave corta del sitio ('kp', 'aur'): va en el
--                                   id de cada pedido (`wc-kp-1532`) porque los
--                                   dos WordPress numeran desde 1 y hay consultas
--                                   que buscan por id sin filtrar por tienda.
--                                   Única en toda la base; minúsculas y dígitos,
--                                   de 2 a 12, empezando por letra.
--   stores.woo_consumer_key_enc     Consumer key de la API REST, cifrada como los
--   stores.woo_consumer_secret_enc  demás *_enc de `stores`; y su Consumer secret.
--   stores.woo_webhook_secret_enc   el secreto con el que WooCommerce firma los
--                                   webhooks (X-WC-Webhook-Signature), cifrado.
--   stores.woo_last_error           el último fallo al hablar con WooCommerce, en
--                                   texto que se puede mostrar (sin secretos).
--   stores.platform_switched_at     cuándo la tienda pasó a crear sus pedidos en
--                                   WooCommerce.
--   orders.platform                 de qué plataforma vino el pedido: 'shopify'
--   draft_orders.platform           o 'woocommerce'. Lo mismo para los borradores.
--   stores_woo_platform_check       una tienda solo pasa a 'woocommerce' con la
--                                   dirección, la clave del sitio y las dos
--                                   claves de la API guardadas. Las credenciales
--                                   sí pueden estar antes del cambio.
--   stores_woo_site_key_uniq        una clave de sitio, una sola tienda.
--   stores_woo_site_url_uniq        un sitio, una sola tienda (sin importar
--                                   mayúsculas): dos tiendas leyendo el mismo
--                                   WordPress meterían cada pedido dos veces.
--
-- A QUIÉN NO. Ninguna fila se actualiza. Kenku Peru, Aurela y todas las demás
-- tiendas nacen con platform = 'shopify' y las columnas woo_* en null, y sus
-- pedidos y borradores con platform = 'shopify', que es lo que son. Su token, sus
-- webhooks, su sincronización y «Generar pedido» siguen exactamente igual: nada
-- del código de Shopify lee estas columnas. `shopify_domain` sigue obligatorio y
-- en su clave única de siempre (0001): no se toca.
--
-- Los secretos se guardan como siempre en `stores` (0001, 0052, 0161, 0271):
-- AES-256-GCM con lib/crypto.ts, y se descifran solo en el servidor. Sin grants
-- nuevos ni vistas: la fila la protege la RLS de supabase/policies.sql, igual
-- que a shopify_token_enc.
--
-- EL CANDADO. Añadir una columna con valor por defecto y su CHECK toma un momento
-- el candado exclusivo de `orders` y `draft_orders` (Postgres comprueba el CHECK
-- recorriendo la tabla, sin reescribirla). Mientras lo espera, los webhooks de
-- Kenku y Aurela hacen cola: por eso DEPLOY.md la corre con lock_timeout de 3 s.
--
-- Idempotente y sin tocar datos. A mano y ANTES del código (DEPLOY.md, entrada
-- del 23-10-2026).

alter table stores
  add column if not exists platform text not null default 'shopify'
    constraint stores_platform_check check (platform in ('shopify', 'woocommerce')),
  add column if not exists woo_site_url            text,
  add column if not exists woo_site_key            text,
  add column if not exists woo_consumer_key_enc    text,
  add column if not exists woo_consumer_secret_enc text,
  add column if not exists woo_webhook_secret_enc  text,
  add column if not exists woo_last_error          text,
  add column if not exists platform_switched_at    timestamptz;

alter table orders
  add column if not exists platform text not null default 'shopify'
    constraint orders_platform_check check (platform in ('shopify', 'woocommerce'));

alter table draft_orders
  add column if not exists platform text not null default 'shopify'
    constraint draft_orders_platform_check check (platform in ('shopify', 'woocommerce'));

-- La forma de la clave del sitio y de la dirección. La clave va dentro del id
-- del pedido (`wc-<clave>-<id>`): un guion en ella haría ambiguo el id. La
-- dirección es solo https, sin usuario ni contraseña en ella; la validación
-- completa (sin IP, sin puertos raros) la hace lib/woocommerce.ts al guardar.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'stores'::regclass and conname = 'stores_woo_site_key_check') then
    alter table stores
      add constraint stores_woo_site_key_check
      check (woo_site_key is null or woo_site_key ~ '^[a-z][a-z0-9]{1,11}$');
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'stores'::regclass and conname = 'stores_woo_site_url_check') then
    alter table stores
      add constraint stores_woo_site_url_check
      check (woo_site_url is null or woo_site_url ~ '^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$');
  end if;
  -- Pasar a WooCommerce sin con qué entrar a la tienda dejaría a la tienda sin
  -- poder crear pedidos: la base no lo acepta.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'stores'::regclass and conname = 'stores_woo_platform_check') then
    alter table stores
      add constraint stores_woo_platform_check
      check (
        platform <> 'woocommerce'
        or (woo_site_url is not null
            and woo_site_key is not null
            and woo_consumer_key_enc is not null
            and woo_consumer_secret_enc is not null)
      );
  end if;
end $$;

-- Únicas en toda la base, no por organización: los ids de pedido `wc-<clave>-…`
-- se buscan a veces sin filtrar por tienda.
create unique index if not exists stores_woo_site_key_uniq
  on stores (woo_site_key)
  where woo_site_key is not null;

create unique index if not exists stores_woo_site_url_uniq
  on stores (lower(woo_site_url))
  where woo_site_url is not null;

comment on column stores.platform is
  'Dónde se crean los pedidos NUEVOS que Kapta crea para esta tienda: shopify (por defecto) o woocommerce (MOM §37). No dice de dónde viene cada pedido: eso es orders.platform. Pasa a woocommerce solo con woo_site_url, woo_site_key y las dos claves de la API guardadas.';
comment on column stores.woo_site_url is
  'MOM §37: dirección https del sitio WordPress con WooCommerce, sin barra final ni credenciales. Null si la tienda no tiene WooCommerce.';
comment on column stores.woo_site_key is
  'MOM §37: clave corta del sitio (kp, aur) que va en el id de cada pedido de WooCommerce (orders.shopify_order_id = wc-<clave>-<id>). Única en toda la base. No se cambia después del primer pedido: los ids guardados la llevan.';
comment on column stores.woo_consumer_key_enc is
  'enc: MOM §37. Consumer key de la API REST de WooCommerce, cifrada AES-256-GCM (lib/crypto.ts). Nunca viaja al cliente.';
comment on column stores.woo_consumer_secret_enc is
  'enc: MOM §37. Consumer secret de la API REST de WooCommerce, cifrado AES-256-GCM (lib/crypto.ts). Nunca viaja al cliente.';
comment on column stores.woo_webhook_secret_enc is
  'enc: MOM §37. Secreto con el que WooCommerce firma los webhooks (X-WC-Webhook-Signature, HMAC-SHA256 en base64 del cuerpo), cifrado AES-256-GCM. Nunca viaja al cliente.';
comment on column stores.woo_last_error is
  'MOM §37: el último fallo al hablar con WooCommerce, en texto que se puede mostrar (sin secretos). Null si la última llamada salió bien.';
comment on column stores.platform_switched_at is
  'MOM §37: cuándo la tienda pasó a crear sus pedidos en WooCommerce (platform = woocommerce).';
comment on column orders.platform is
  'De qué plataforma vino el pedido: shopify (todos los anteriores a la 0273) o woocommerce (MOM §37). Las decisiones por plataforma se toman con esta columna, nunca por la forma de shopify_order_id.';
comment on column draft_orders.platform is
  'De qué plataforma vino el borrador o carrito: shopify o woocommerce (MOM §37).';
