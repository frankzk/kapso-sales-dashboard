-- ============================================================================
-- 0277_bot_orders.sql — los pedidos del bot de Kapso, creados por Kapta en
-- WooCommerce (MOM §38.13, plan D5 del owner, 23-10-2026).
--
-- POR QUÉ. Shopify cierra Kenku Perú y Aurela el 28-10-2026 (se planifica para
-- el 27-10 a las 19:00 de Lima). Hoy el bot de Kapso crea ~31 pedidos al día
-- directamente en Shopify. Desde el corte los pedidos nuevos van a
-- WooCommerce, y el owner decidió (D5) que el bot no hable con WooCommerce: le
-- pide el pedido a Kapta (`POST /api/internal/orders/<storeId>`), y Kapta lo
-- crea con el mismo núcleo que «Generar pedido» (§38.12). Un solo camino, con
-- las mismas marcas.
--
-- QUÉ CAMBIA. Dos tablas nuevas; no toca ninguna otra ni ninguna fila:
--   · `bot_order_secrets`: el secreto con el que el bot se identifica, uno por
--     tienda, guardado SOLO como su sha256 (hexadecimal). El secreto en claro
--     se muestra una vez en Ajustes al generarlo y no queda en ninguna parte
--     de Kapta: es una llave de 256 bits al azar, así que su sha256 basta (no
--     hace falta una función lenta). Con cuándo se creó, cuándo se cambió por
--     última vez y el último uso y el último fallo (sin datos de la clienta),
--     para Ajustes.
--   · `bot_order_requests`: el candado de cada pedido que pide el bot. El bot
--     reintenta solo y en paralelo, y la búsqueda del intento anterior en
--     WooCommerce (`kapta_request_id`, §38.12) no frena dos llamadas a la vez:
--     las dos buscan antes de que cualquiera cree. Aquí, `unique (store_id,
--     request_id)`: la primera llamada inserta la fila (`processing`, con su
--     `claim_token`) y recién entonces crea el pedido; la segunda choca con la
--     fila y no llama a WooCommerce. Al terminar, la fila queda `done` (con el
--     pedido, para devolver el mismo a un reintento) o `failed` (un reintento
--     con lo mismo vuelve a intentar). Una fila `processing` que no terminó
--     (la función se cortó) se puede retomar pasado su plazo, y solo una
--     llamada la retoma: el cambio exige el `claim_token` que leyó.
--     `woo_order_id` anota el pedido de WooCommerce apenas existe, para que
--     quien retome lo lea por su id. `body_hash` es la huella de lo pedido: el
--     mismo id con otra cosa es un conflicto y no crea nada; otro id con la
--     misma huella en pocos minutos es el mismo pedido pedido dos veces.
--
-- SOLO EL SERVIDOR. RLS encendida y sin privilegios para `anon` ni
-- `authenticated` (Supabase se los da a toda tabla nueva del esquema público):
-- las lee y escribe solo el service role, como `order_invoice_snapshots`.
--
-- SIN LLAVES FORÁNEAS, a propósito: crearlas tomaría un candado de `stores`,
-- que Kenku y Aurela leen en cada consulta del panel (0274, 0275). Una fila de
-- una tienda borrada no estorba: solo se lee por la tienda de la URL.
--
-- Se aplica a mano ANTES del código (DEPLOY.md, entrada del 23-10-2026). Sin
-- ella el endpoint contesta 503 («falta la migración 0277») sin crear nada, y
-- Ajustes lo dice en vez de ofrecer el secreto. Es idempotente: correrla otra
-- vez no cambia nada.
-- ============================================================================

-- ── 1. El secreto del bot, por tienda (solo su sha256) ──────────────────────
create table if not exists bot_order_secrets (
  store_id      uuid primary key,
  secret_hash   text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  rotated_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  -- El código del último pedido pedido (`ok`, `price_mismatch`…), sin datos.
  last_outcome  text check (last_outcome is null or last_outcome ~ '^[a-z_]{2,40}$'),
  -- El último fallo, en corto y sin teléfono, nombre ni dirección.
  last_error    text check (last_error is null or length(last_error) <= 300),
  last_error_at timestamptz
);

comment on table bot_order_secrets is
  'MOM §38.13: el secreto del bot de Kapso para POST /api/internal/orders/<storeId>, uno por tienda, guardado solo como sha256 hexadecimal. Se genera y se cambia en Ajustes (se muestra una vez). Solo service_role.';

-- ── 2. El candado de cada pedido del bot ─────────────────────────────────────
create table if not exists bot_order_requests (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null,
  -- El id que manda el bot (un uuid, o de 8 a 64 letras, dígitos, «-» y «_»).
  request_id   text not null check (request_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  -- sha256 de lo pedido, normalizado: el mismo id con otra cosa es un conflicto.
  body_hash    text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  status       text not null default 'processing' check (status in ('processing', 'done', 'failed')),
  -- Quién tiene el candado: solo quien lo tiene lo cierra, y para retomar uno
  -- vencido hay que nombrar el que se leyó.
  claim_token  uuid not null,
  claimed_at   timestamptz not null default now(),
  attempts     integer not null default 1 check (attempts > 0),
  -- El id de WooCommerce del pedido que creó este request_id, anotado apenas
  -- existe (antes de comprobarlo): un reintento lo lee por su id a cualquier
  -- edad, sin depender de la búsqueda de las últimas 2 horas.
  woo_order_id bigint check (woo_order_id is null or woo_order_id > 0),
  -- El pedido creado (`wc-<clave>-<id>`), su número (`#KP200123`), total y moneda.
  order_id     text,
  order_name   text,
  order_total  numeric(12, 2),
  currency     text,
  error_code   text check (error_code is null or error_code ~ '^[a-z_]{2,40}$'),
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  constraint bot_order_requests_store_request_uniq unique (store_id, request_id),
  constraint bot_order_requests_done_check
    check (status <> 'done' or (order_id is not null and order_name is not null))
);

-- El tope por minuto de la tienda cuenta las filas recientes, y el mismo
-- pedido con otro request_id se busca entre las de los últimos minutos.
create index if not exists bot_order_requests_store_created_idx
  on bot_order_requests (store_id, created_at desc);

comment on table bot_order_requests is
  'MOM §38.13: el candado de cada pedido que pide el bot de Kapso. unique (store_id, request_id): dos llamadas a la vez con el mismo id no crean dos pedidos. processing → done (con el pedido, para devolverlo a un reintento) o failed; una processing vencida se retoma con su claim_token, y woo_order_id dice qué pedido de WooCommerce leer al retomar. Solo service_role.';

-- ── 3. Solo el servidor ──────────────────────────────────────────────────────
alter table bot_order_secrets enable row level security;
revoke all on bot_order_secrets from anon, authenticated;
grant all privileges on bot_order_secrets to service_role;
alter table bot_order_requests enable row level security;
revoke all on bot_order_requests from anon, authenticated;
grant all privileges on bot_order_requests to service_role;
