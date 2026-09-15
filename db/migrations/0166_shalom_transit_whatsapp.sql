-- ============================================================================
-- 0166_shalom_transit_whatsapp.sql — el aviso por WhatsApp cuando la guía de
-- Shalom sale en tránsito, y las cuentas de cobro que se le enseñan al cliente.
--
-- EL HUECO QUE TAPA. Cuando Shalom mueve una guía a `en_transito`, Kapta ya se
-- entera (cron shalom-reconcile, cada 30 min) y escribe `courier_status` en la
-- línea de tiempo del pedido. Ahí se quedaba. La clienta no recibía nada, y el
-- saldo pendiente —que es lo que decide si va a poder recoger— se cobraba a
-- mano, chat por chat, cuando alguien se acordaba. En #KP133540 el tránsito se
-- registró el 11/09 a las 11:46 y el saldo se cobró el 15/09, por una asesora.
--
-- Lo que hace este cambio: en ese mismo instante sale la plantilla aprobada
-- (`guias_shalom`) con guía, código, agencia, producto y el resumen de pago, y
-- tres botones —Yape, transferencia, link— que Kapta contesta sola con las
-- cuentas de la tienda.
--
-- CUATRO PIEZAS, en este orden:
--   1. Config del aviso en `stores`, con la convención de las otras
--      automatizaciones (`return_recovery_*`, 0112): nace APAGADO.
--   2. `store_payment_methods`: las cuentas que se le ENSEÑAN al cliente. No es
--      `store_collection_accounts` (0126): esa lista sirve para VERIFICAR un
--      comprobante y guarda solo tres dígitos del celular; esta guarda el número
--      completo porque su trabajo es que el cliente pague. Son dos preguntas
--      distintas y mezclarlas convertiría un cambio de cuenta en un falso desvío.
--   3. `shalom_transit_notifications`: cola + registro. El cron ENCOLA en el
--      momento del tránsito y otro paso ENVÍA. Separados a propósito: el envío
--      puede necesitar bajar el ticket de Shalom (~45 s) y puede fallar por Meta,
--      y el tránsito solo ocurre una vez — si el envío fuera en línea, un fallo
--      transitorio perdería el aviso para siempre. Una fila por guía: la unique
--      es la garantía de que no se manda dos veces.
--   4. `wa_auto_replies`: qué botón pulsó quién y qué se le contestó. La unique
--      por mensaje entrante es lo que evita contestar dos veces cuando Kapso
--      reintenta la entrega del webhook.
-- ============================================================================

-- ── 1. Config del aviso ──────────────────────────────────────────────────────
alter table stores
  add column if not exists shalom_transit_template_enabled boolean not null default false,
  add column if not exists shalom_transit_template_name text,
  add column if not exists shalom_transit_template_language text not null default 'es',
  -- Qué va en {{1}}, {{2}}… por tokens, igual que `return_recovery_params`.
  -- Cada tienda es una WABA con su propia aprobación: el orden se configura.
  add column if not exists shalom_transit_params text not null
    default 'nombre,guia,codigo,producto,agencia,total,adelanto,saldo,yape',
  -- Para la variante con el ticket de Shalom en cabecera (`guias_shalom_imagen`).
  -- Solo tiene sentido con una plantilla aprobada con cabecera de documento.
  add column if not exists shalom_transit_attach_ticket boolean not null default false,
  -- Número propio para este aviso. NULL ⇒ el número por el que escribió la
  -- clienta (lead) y, si no hay, el de la tienda.
  add column if not exists shalom_transit_phone_number_id text,
  -- Un aviso a las 3 a.m. no se contesta: se silencia el chat.
  add column if not exists shalom_transit_hour_start integer not null default 8,
  add column if not exists shalom_transit_hour_end integer not null default 21,
  -- Lo que se contesta al botón «Link de pago». Texto libre con {saldo},
  -- {pedido} y {yape}. NULL ⇒ se cae al aviso de Yape.
  add column if not exists shalom_transit_payment_link text;

comment on column stores.shalom_transit_params is
  'Orden de los parámetros del cuerpo, por token: nombre, guia, codigo, producto, agencia, total, adelanto, saldo, yape. Debe coincidir con la plantilla aprobada en Meta.';

-- ── 2. Cuentas de cobro que ve el cliente ────────────────────────────────────
create table if not exists store_payment_methods (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores(id) on delete cascade,
  kind        text not null check (kind in ('yape', 'plin', 'banco', 'billetera')),
  -- Cómo se presenta: «BCP», «YAPE 1», «LUKITA - PLIN - AGORA».
  label       text not null,
  -- A nombre de quién. Se escribe tal cual se quiere leer en el mensaje.
  holder      text not null,
  -- Número de cuenta o celular, completo. Es lo que el cliente teclea.
  account     text not null,
  -- «CUENTA CORRIENTE BCP SOLES», «BBVA CUENTA FACIL». Opcional.
  detail      text,
  -- La que contesta al botón «Pagar con Yape» y rellena {{yape}} en la
  -- plantilla. Una sola por tienda (índice parcial abajo).
  primary_yape boolean not null default false,
  -- Retirar sin borrar: una cuenta que dejó de usarse sigue nombrada en
  -- respuestas ya enviadas.
  active      boolean not null default true,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (store_id, label)
);

create index if not exists store_payment_methods_store_idx
  on store_payment_methods (store_id, sort, created_at) where active;

-- Un solo Yape principal activo por tienda: el botón tiene que contestar UNA
-- cuenta, y {{yape}} de la plantilla también.
create unique index if not exists store_payment_methods_primary_yape_uniq
  on store_payment_methods (store_id) where primary_yape and active;

comment on table store_payment_methods is
  'Cuentas que se le ENSEÑAN al cliente para pagar. Distinto de store_collection_accounts (0126), que sirve para VERIFICAR comprobantes.';

alter table store_payment_methods enable row level security;

drop policy if exists store_payment_methods_select on store_payment_methods;
create policy store_payment_methods_select on store_payment_methods for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on store_payment_methods to authenticated;
grant all privileges on store_payment_methods to service_role;

-- Semilla: las cuentas por las que el negocio cobra hoy, en cada tienda. Son de
-- la misma empresa, igual que en 0126. El Yape de la empresa es el principal:
-- es el que el circuito de validación de comprobantes sabe verificar (§12).
insert into store_payment_methods (store_id, kind, label, holder, account, detail, primary_yape, sort)
select s.id, v.kind, v.label, v.holder, v.account, v.detail, v.primary_yape, v.sort
from stores s
cross join (values
  ('banco',     'BCP',                   'Grupo GF SAC',   '191-2434540-0-12',    'CUENTA CORRIENTE BCP SOLES', false, 10),
  ('banco',     'BBVA',                  'Frankz Kastner', '0011-0179-0200429111', 'BBVA CUENTA FACIL',          false, 20),
  ('banco',     'SCOTIABANK',            'Frankz Kastner', '005-7509762',          null,                         false, 30),
  ('banco',     'INTERBANK',             'Frankz Kastner', '6433195481731',        null,                         false, 40),
  ('yape',      'YAPE 1',                'Grupo GF SAC',   '930555309',            null,                         true,  50),
  ('billetera', 'LUKITA - PLIN - AGORA', 'Frankz Kastner', '965391481',            null,                         false, 60),
  ('yape',      'YAPE 2 o PLIN',         'Gabriela Reaño', '987754147',            null,                         false, 70)
) as v(kind, label, holder, account, detail, primary_yape, sort)
on conflict (store_id, label) do nothing;

-- ── 3. Cola y registro del aviso ─────────────────────────────────────────────
create table if not exists shalom_transit_notifications (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references stores(id) on delete cascade,
  shipment_id         uuid not null references shipments(id) on delete cascade,
  order_id            uuid references orders(id) on delete set null,
  -- pending → sent | failed | skipped. `failed` es definitivo (se agotaron los
  -- intentos o el pedido no tiene cómo recibirlo); `skipped` es «la tienda lo
  -- tiene apagado», que no es un fallo.
  status              text not null default 'pending'
                        check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts            integer not null default 0,
  next_attempt_at     timestamptz not null default now(),
  phone               text,
  phone_number_id     text,
  template_name       text,
  -- Los parámetros tal como se mandaron. Es la única forma de responder «¿qué
  -- saldo le dijimos?» cuando el pedido ya cambió.
  params              jsonb,
  provider_message_id text,
  error               text,
  error_code          integer,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- UNA por guía. Es la garantía de exactamente-una-vez: el cron puede volver a
  -- ver el mismo tránsito y el insert simplemente no hace nada.
  unique (shipment_id)
);

create index if not exists shalom_transit_notifications_pending_idx
  on shalom_transit_notifications (next_attempt_at) where status = 'pending';
create index if not exists shalom_transit_notifications_phone_idx
  on shalom_transit_notifications (store_id, phone, created_at desc);

alter table shalom_transit_notifications enable row level security;

drop policy if exists shalom_transit_notifications_select on shalom_transit_notifications;
create policy shalom_transit_notifications_select on shalom_transit_notifications
  for select to authenticated using (store_id in (select auth_store_ids()));

grant select on shalom_transit_notifications to authenticated;
grant all privileges on shalom_transit_notifications to service_role;

-- ── 4. Respuestas automáticas a los botones ──────────────────────────────────
create table if not exists wa_auto_replies (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references stores(id) on delete cascade,
  -- El `wamid` del mensaje del cliente. Kapso reintenta los webhooks, y sin
  -- esto la clienta recibiría las cuentas dos veces.
  inbound_message_id  text not null,
  phone               text not null,
  phone_number_id     text,
  -- yape | transferencia | link_pago
  trigger             text not null,
  order_id            uuid references orders(id) on delete set null,
  body                text,
  ok                  boolean not null default false,
  error               text,
  provider_message_id text,
  created_at          timestamptz not null default now(),
  unique (store_id, inbound_message_id)
);

create index if not exists wa_auto_replies_store_idx
  on wa_auto_replies (store_id, created_at desc);

alter table wa_auto_replies enable row level security;

drop policy if exists wa_auto_replies_select on wa_auto_replies;
create policy wa_auto_replies_select on wa_auto_replies
  for select to authenticated using (store_id in (select auth_store_ids()));

grant select on wa_auto_replies to authenticated;
grant all privileges on wa_auto_replies to service_role;
