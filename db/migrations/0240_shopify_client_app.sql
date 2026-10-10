-- 0240_shopify_client_app.sql — la app de Shopify para tiendas cliente
-- (MOM §29.15.1 y §29.15.9, plan clientes-externos-gf, Fase 1b).
--
-- QUÉ PASABA. Kapta tenía UNA app de Shopify, la de Aurela y Kenku, con
-- distribución personalizada: no se puede instalar en una tienda ajena y nunca
-- pasó la revisión pública de Shopify. Para conectar tiendas cliente se crea
-- una segunda app, pública y oculta. La revisión exige tres cosas que Kapta no
-- tenía: que la instalación empiece en Shopify sin escribir el dominio, que se
-- atiendan los tres webhooks obligatorios de privacidad, y que la tienda quede
-- desconectada cuando desinstala la app.
--
-- QUÉ CAMBIA.
--   stores.shopify_app            con qué app se conectó la tienda: 'interna'
--                                 (la de siempre) o 'clientes' (la nueva).
--   stores.shopify_uninstalled_at cuándo desinstaló la app; la tienda queda
--                                 deshabilitada y sin token (el estado
--                                 'disabled' ya existía).
--   shopify_pending_installs      el token que Shopify entrega al terminar el
--                                 OAuth, guardado cifrado hasta que el dueño
--                                 entra a Kapta y elige su organización. Vence.
--   shopify_privacy_requests      cada aviso de privacidad recibido, verificado
--                                 y guardado ANTES de responder 200: pendiente
--                                 hasta que se atiende (anonimizar o entregar
--                                 los datos), con fecha y nota.
--
-- Las dos tablas nuevas solo las toca el rol de servicio: RLS activa y sin
-- políticas para usuarios.

alter table stores
  add column if not exists shopify_app text not null default 'interna';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stores_shopify_app_check'
  ) then
    alter table stores
      add constraint stores_shopify_app_check
      check (shopify_app in ('interna', 'clientes'));
  end if;
end $$;

alter table stores
  add column if not exists shopify_uninstalled_at timestamptz;

-- Una tienda de Shopify conectada con la app de clientes es UNA tienda de
-- Kapta, en una sola organización: los avisos de privacidad llegan con el
-- dominio, no con el id de Kapta, y tienen que caer en una sola tienda. La
-- unicidad de siempre es por organización (0001) y no alcanza.
create unique index if not exists stores_client_app_shop_uniq
  on stores (lower(shopify_domain))
  where shopify_app = 'clientes';

comment on column stores.shopify_app is
  'App de Shopify con la que se conectó: interna (Aurela y Kenku) o clientes (app pública para tiendas cliente, MOM §29.15.1).';
comment on column stores.shopify_uninstalled_at is
  'Cuándo la tienda desinstaló la app de Shopify. La tienda queda deshabilitada y sin token; su historial no se borra.';

create table if not exists shopify_pending_installs (
  id                uuid primary key default gen_random_uuid(),
  shop_domain       text not null,
  token_enc         text not null,
  scope             text,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '30 minutes',
  claimed_at        timestamptz,
  claimed_store_id  uuid references stores(id) on delete set null,
  claimed_by        uuid references auth.users(id) on delete set null,
  check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  check (expires_at > created_at)
);

create index if not exists shopify_pending_installs_shop_idx
  on shopify_pending_installs(shop_domain, created_at desc);

comment on table shopify_pending_installs is
  'Token de una instalación de la app de clientes que todavía no tiene tienda en Kapta. Cifrado y con vencimiento; lo reclama un owner/admin desde /dashboard/conectar-shopify.';

create table if not exists shopify_privacy_requests (
  id            uuid primary key default gen_random_uuid(),
  topic         text not null
    check (topic in ('customers/data_request', 'customers/redact', 'shop/redact')),
  shop_domain   text not null,
  shop_id       text,
  store_id      uuid references stores(id) on delete set null,
  webhook_id    text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'pendiente'
    check (status in ('pendiente', 'atendida')),
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  note          text,
  check (length(trim(webhook_id)) > 0),
  check ((status = 'atendida') = (processed_at is not null))
);

create unique index if not exists shopify_privacy_requests_webhook_uniq
  on shopify_privacy_requests(webhook_id);
create index if not exists shopify_privacy_requests_pending_idx
  on shopify_privacy_requests(status, received_at)
  where status = 'pendiente';
create index if not exists shopify_privacy_requests_store_idx
  on shopify_privacy_requests(store_id, received_at desc);

comment on table shopify_privacy_requests is
  'Avisos de privacidad de Shopify (customers/data_request, customers/redact, shop/redact) de la app de clientes. Pendiente hasta que se anonimiza o se entregan los datos (MOM §29.15.9).';

alter table shopify_pending_installs enable row level security;
alter table shopify_privacy_requests enable row level security;

grant all privileges on shopify_pending_installs, shopify_privacy_requests to service_role;
