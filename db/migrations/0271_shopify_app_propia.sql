-- 0271_shopify_app_propia.sql — tiendas conectadas con la app propia de su
-- organización de Shopify (MOM §36, decisión del owner del 23-10-2026).
--
-- QUÉ PASABA. Kapta conectaba una tienda de dos formas: la app interna de
-- Aurela y Kenku, con un token fijo, y la app pública «Kapta» para tiendas
-- cliente (0249), que no está revisada por Shopify y no se puede ofrecer.
-- Desde el 01-01-2026 Shopify ya no deja crear apps personalizadas desde el
-- admin de una tienda. Para conectar «Súper Human Perú», su propia organización
-- de Shopify crea una app en el Dev Dashboard y la instala en su tienda. Esa
-- app no recibe un token fijo: lo pide con el client credentials grant (Client
-- ID + Client secret) y cada token dura unas 24 horas. Kapta tiene que guardar
-- con qué pedirlo otra vez y cuándo vence el que tiene.
--
-- QUÉ CAMBIA.
--   stores_shopify_app_check           admite un tercer valor: 'propia'.
--   stores.shopify_client_id           Client ID de la app propia. No es secreto.
--   stores.shopify_client_secret_enc   Client secret de la app propia, cifrado
--                                      como los demás *_enc de `stores`.
--   stores.shopify_token_expires_at    cuándo vence el token vigente.
--   stores.shopify_token_renewed_at    cuándo se renovó por última vez.
--   stores.shopify_token_error         el último fallo al renovar, o los permisos
--                                      que le faltan a la app, en texto que se
--                                      puede mostrar (sin secretos); null si la
--                                      última renovación salió bien y completa.
--   stores.shopify_token_retry_at      freno de la renovación al usar el token:
--                                      antes de esta hora no se vuelve a pedir
--                                      uno a Shopify (5 min tras cada intento,
--                                      15 si Shopify no respondió bien).
--   stores.shopify_webhook_secret_prev_enc
--                                      el Client secret anterior, cifrado, tras
--                                      rotarlo en Ajustes: Shopify firma los
--                                      webhooks con el secreto más viejo que no
--                                      se revocó, y Kapta lo acepta un tiempo.
--   stores.shopify_webhook_secret_prev_set_at
--                                      desde cuándo es el anterior (48 h de
--                                      gracia, o hasta que alguien confirma que
--                                      lo revocó).
--   stores_own_app_columns_check       las ocho columnas son solo de la app
--                                      propia: en una tienda 'interna' o
--                                      'clientes' quedan null, y una escritura
--                                      que intente llenarlas falla.
--   stores_own_app_shop_uniq           un dominio está en una sola tienda con la
--                                      app propia (como stores_client_app_shop_uniq
--                                      de la 0249 para la de clientes).
--
-- A QUIÉN NO. Kenku Peru y Aurela ('interna') y las tiendas 'clientes' quedan
-- exactamente como están: ninguna fila se actualiza, sus columnas nuevas nacen
-- null y los dos CHECK se cumplen sin tocarlas. Su token, sus webhooks y su
-- estado no dependen de nada de esto.
--
-- Los secretos se guardan como siempre en `stores` (0001, 0052, 0161):
-- AES-256-GCM con lib/crypto.ts, y se descifran solo en el servidor. Sin grants
-- nuevos ni vistas: la fila la protege la RLS de supabase/policies.sql, igual
-- que a shopify_token_enc.
--
-- Idempotente y sin tocar datos. A mano y ANTES del código (DEPLOY.md, entrada
-- del 23-10-2026).

alter table stores
  add column if not exists shopify_client_id         text,
  add column if not exists shopify_client_secret_enc text,
  add column if not exists shopify_token_expires_at  timestamptz,
  add column if not exists shopify_token_renewed_at  timestamptz,
  add column if not exists shopify_token_error       text,
  add column if not exists shopify_token_retry_at    timestamptz,
  add column if not exists shopify_webhook_secret_prev_enc    text,
  add column if not exists shopify_webhook_secret_prev_set_at timestamptz;

-- La 0249 creó el CHECK con dos valores. Se reemplaza solo si todavía no admite
-- 'propia': correrla otra vez no vuelve a validar la tabla.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'stores'::regclass
       and conname = 'stores_shopify_app_check'
       and pg_get_constraintdef(oid) like '%''propia''%'
  ) then
    alter table stores drop constraint if exists stores_shopify_app_check;
    alter table stores
      add constraint stores_shopify_app_check
      check (shopify_app in ('interna', 'clientes', 'propia'));
  end if;
end $$;

-- La garantía del owner, puesta en la base: nada de la renovación puede
-- escribir en Kenku, Aurela ni una tienda 'clientes'. Un código que lo intente
-- falla con 23514 en vez de cambiarles algo. Si una versión anterior de esta
-- misma migración ya lo creó con menos columnas (solo en bases de prueba: en
-- producción no se aplicó), se rehace; si ya las nombra todas, no se toca.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'stores'::regclass
       and conname = 'stores_own_app_columns_check'
       and pg_get_constraintdef(oid) like '%shopify_webhook_secret_prev_set_at%'
  ) then
    alter table stores drop constraint if exists stores_own_app_columns_check;
    alter table stores
      add constraint stores_own_app_columns_check
      check (
        shopify_app = 'propia'
        or (shopify_client_id is null
            and shopify_client_secret_enc is null
            and shopify_token_expires_at is null
            and shopify_token_renewed_at is null
            and shopify_token_error is null
            and shopify_token_retry_at is null
            and shopify_webhook_secret_prev_enc is null
            and shopify_webhook_secret_prev_set_at is null)
      );
  end if;
end $$;

-- Los webhooks de la app propia llegan firmados con su Client secret y el cron
-- renueva por tienda: dos tiendas de Kapta con el mismo dominio y la app propia
-- pedirían dos tokens para la misma tienda de Shopify. La unicidad de siempre
-- es por organización (0001) y no alcanza.
create unique index if not exists stores_own_app_shop_uniq
  on stores (lower(shopify_domain))
  where shopify_app = 'propia';

comment on column stores.shopify_app is
  'App de Shopify con la que se conectó: interna (Aurela y Kenku), clientes (app pública para tiendas cliente, MOM §29.15.9) o propia (app que la organización de Shopify de la tienda creó en su Dev Dashboard, MOM §36).';
comment on column stores.shopify_client_id is
  'Solo app propia (MOM §36): Client ID de la app de la organización de Shopify de la tienda. No es secreto.';
comment on column stores.shopify_client_secret_enc is
  'enc: solo app propia (MOM §36). Client secret de la app, cifrado AES-256-GCM (lib/crypto.ts). Pide cada token (client credentials grant) y firma sus webhooks. Nunca viaja al cliente.';
comment on column stores.shopify_token_expires_at is
  'Solo app propia (MOM §36): cuándo vence el token de shopify_token_enc (~24 h). Null = no hay token vigente que valga.';
comment on column stores.shopify_token_renewed_at is
  'Solo app propia (MOM §36): cuándo se renovó el token por última vez.';
comment on column stores.shopify_token_error is
  'Solo app propia (MOM §36): el último fallo al renovar el token, o los permisos que le faltan a la app, en texto que se puede mostrar (sin secretos). Null si la última renovación salió bien y con todos los permisos.';
comment on column stores.shopify_token_retry_at is
  'Solo app propia (MOM §36.3): antes de esta hora la renovación al usar el token no vuelve a pedir uno a Shopify. Cada intento al usar la pone 5 min adelante; un fallo de red o un 429/5xx, 15 min. El cron y «Renovar ahora» no la miran.';
comment on column stores.shopify_webhook_secret_prev_enc is
  'enc: solo app propia (MOM §36.4). El Client secret anterior tras rotarlo en Ajustes, cifrado AES-256-GCM. Los webhooks se aceptan también firmados con él durante 48 h desde shopify_webhook_secret_prev_set_at, o hasta que alguien confirma que lo revocó. Nunca viaja al cliente.';
comment on column stores.shopify_webhook_secret_prev_set_at is
  'Solo app propia (MOM §36.4): cuándo el Client secret anterior pasó a serlo. Pasadas 48 h ya no firma nada que Kapta acepte.';
