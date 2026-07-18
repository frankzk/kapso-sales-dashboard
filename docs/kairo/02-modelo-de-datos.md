# 02 · Modelo de datos (SQL portable)

Esquema consolidado de las migraciones `0004`–`0037`, ya **renombrado a
genérico** (`kapso_*` → `crm_*`) para Kairo/Icomfly. Postgres (Supabase).
Asume que ya existen `stores(id uuid)`, `orders(id uuid)` y `auth.users`.

> Convención de este panel que conviene conservar: las señales de
> enriquecimiento (distrito, carrito, fuente) **nunca cambian** `status` ni
> `category` por sí solas; solo los eventos del ciclo de vida lo hacen.

## `leads` — entidad central

```sql
create table if not exists leads (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references stores(id) on delete cascade,

  -- Identidad (dedup por teléfono dentro de la tienda)
  phone                text not null,          -- normalizado E.164 sin '+' (CR: '506########')
  wa_id                text,
  name                 text,
  email                text,

  -- Relación con el CRM
  crm_conversation_id  text,                   -- id de conversación en Icomfly
  wa_phone_number_id   text,                   -- número de WhatsApp (multi-número)

  -- Señales del bot / handoff
  handoff_reason       text,                   -- razón por la que el bot pidió humano
  handoff_context      text,                   -- resumen de contexto del bot
  handoff_at           timestamptz,
  bot_state            text,                   -- estado interno del bot (opcional)

  -- Ciclo de vida
  category             text not null default 'open',   -- won | hot | open | lost
  status               text not null default 'nuevo',  -- ver 03-maquina-de-estados.md
  needs_attention      boolean not null default false,
  attention_waves      int not null default 0,         -- re-encolados automáticos (máx 2)

  -- Enlace con órdenes (si aplica tienda)
  order_id             uuid references orders(id) on delete set null,
  has_order            boolean not null default false,

  -- Asignación / gestión
  claimed_by           uuid references auth.users(id) on delete set null,
  claimed_at           timestamptz,            -- lock "Tomar lead", TTL 10 min
  closed_by            uuid references auth.users(id) on delete set null,
  next_followup_at     timestamptz,

  -- Reloj de interacción
  first_seen_at        timestamptz,
  last_interaction_at  timestamptz,            -- cualquier dirección
  last_inbound_at      timestamptz,            -- solo cliente→negocio; ventana 24h WA

  -- Señales de enriquecimiento (informativas)
  district             text,                   -- CR: cantón/distrito
  province             text,
  region               text,
  referencia           text,                   -- referencia de dirección
  address1             text,
  ship_name            text,                   -- destinatario si difiere del lead
  cart_value           numeric(14,2),
  cart_item_count      integer,
  cart_summary         text,
  inbound_count        integer,

  -- Carrito/borrador de la tienda (opcional, Shopify COD)
  draft_order_gid      text,
  draft_order_name     text,
  draft_order_status   text,                   -- open | invoice_sent | completed
  draft_order_url      text,

  -- Atribución de fuente (first-touch, pegajosa: no se sobreescribe)
  source               text,                   -- 'meta_ad' | 'fb_web' | 'cod_cart' | 'abandoned_browse' | null=orgánico
  ad_id                text,
  ad_headline          text,
  ctwa_clid            text,

  -- Pago adelantado (Perú: Yape → CR: SINPE Móvil; renombrar a gusto)
  payment_offered_to   uuid references auth.users(id) on delete set null,
  payment_offered_at   timestamptz,
  payment_passed       uuid[] not null default '{}',   -- asesoras que lo pasaron
  payment_alert_sent_at timestamptz,

  -- Drip de seguimiento por plantilla
  drip_touches         int not null default 0,
  last_drip_at         timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (store_id, phone)
);

create index on leads (store_id, last_interaction_at desc);
create index on leads (store_id, category);
create index on leads (store_id, next_followup_at);
create index on leads (store_id, needs_attention);
create index on leads (store_id, source);
create index on leads (store_id, last_inbound_at);
create index on leads (store_id, wa_phone_number_id);

-- Trigger touch de updated_at
create or replace function touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger leads_touch before update on leads
  for each row execute function touch_updated_at();
```

## `lead_calls` — historial de gestiones (auditoría)

Toda acción sobre un lead deja fila aquí. Es la base de la productividad
(atribución last-touch) y del timeline del drawer.

```sql
create table if not exists lead_calls (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid not null references leads(id) on delete cascade,
  store_id          uuid not null references stores(id) on delete cascade,
  vendedora         uuid references auth.users(id) on delete set null,
  kind              text not null default 'call',
                    -- 'call' | 'state_change' | 'note' | 'sale' | 'system'
  new_status        text,
  note              text,
  next_followup_at  timestamptz,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create index on lead_calls (lead_id, occurred_at desc);
create index on lead_calls (store_id, occurred_at desc);
create index on lead_calls (vendedora, occurred_at desc);
```

## `conversations` — espejo ligero del CRM

Cache de metadatos de conversaciones (no de mensajes; el transcript se lee en
vivo del CRM al abrir el drawer).

```sql
create table if not exists conversations (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete cascade,
  crm_conversation_id   text not null,
  phone_number_id       text,
  started_at            timestamptz,
  last_message_at       timestamptz,
  status                text,
  message_count         integer,
  inbound_count         integer,
  first_response_seconds integer,
  raw                   jsonb,
  unique (store_id, crm_conversation_id)
);
```

## `whatsapp_outbox` — envíos salientes confiables

Cada mensaje enviado desde el panel pasa por aquí; los webhooks de estado del
CRM lo van moviendo. Permite reintentos y muestra ✓/✓✓ en el drawer.

```sql
create table if not exists whatsapp_outbox (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references stores(id) on delete cascade,
  lead_id             uuid not null references leads(id) on delete cascade,
  client_token        text not null,            -- idempotencia desde la UI
  retry_of            uuid references whatsapp_outbox(id) on delete set null,
  provider_message_id text,                     -- wamid / id del CRM
  phone_number_id     text not null,
  to_phone            text not null,
  kind                text not null default 'text',  -- text | template | image | document | video
  body                text,
  status              text not null default 'pending'
                      check (status in ('pending','sent','delivered','read','failed','unknown')),
  retryable           boolean not null default false,
  error_code          text,
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  unique (store_id, client_token)
);
create unique index on whatsapp_outbox (store_id, provider_message_id)
  where provider_message_id is not null;
create index on whatsapp_outbox (lead_id, created_at desc);
```

Códigos Meta considerados **retryables** (mostrar botón "Reintentar"):
`131021`, `131026`, `131047` (ventana 24h cerrada / no alcanzable). El resto,
fallo definitivo.

## `drip_sends` — auditoría del drip de seguimiento

```sql
create table if not exists drip_sends (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id) on delete cascade,
  lead_id       uuid not null references leads(id) on delete cascade,
  phone         text not null,
  template_name text,
  touch         int not null,          -- 1 o 2
  ok            boolean not null default true,
  error         text,
  sent_at       timestamptz not null default now()
);
create index on drip_sends (store_id, sent_at);
create index on drip_sends (lead_id);
```

## `whatsapp_numbers` — catálogo de números (multi-número)

```sql
create table if not exists whatsapp_numbers (
  phone_number_id text primary key,
  name            text,
  display_phone   text,
  kind            text,        -- 'api' | 'business' | 'sandbox'
  fetched_at      timestamptz not null default now()
);
```

## Tablas de soporte ya existentes que el módulo usa

- `webhook_events (store_id, topic, webhook_id, error, …)` con
  `unique (store_id, webhook_id)` — **idempotencia** de todos los webhooks.
- `sync_state (store_id, source, cursor)` — cursores de polling por fuente.
- `orders.customer_phone text` + índice `(store_id, customer_phone)` — enlace
  orden→lead por teléfono normalizado.
- `stores`: columnas nuevas `crm_project_id`, `crm_api_key_enc`,
  `crm_webhook_secret_enc`, `whatsapp_phone_number_id`,
  `drip_template_enabled/_name/_language` (y browse/winback si aplican),
  `telegram_bot_token_enc`, `telegram_chat_id`.
- `memberships.role` acepta `'vendedora'` además de owner/admin/viewer.

## RLS (patrón para todas las tablas de leads)

```sql
alter table leads enable row level security;
create policy leads_select on leads for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on leads to authenticated;
grant all on leads to service_role;
-- Repetir para lead_calls, conversations, whatsapp_outbox, drip_sends.
-- whatsapp_numbers: lectura global (using (true)) — no tiene store_id.
```

`auth_store_ids()` es una función SQL que devuelve las tiendas accesibles del
usuario según `memberships` + `user_store_access`. **Las escrituras de la UI
van por server actions con validación de rol**, no por RLS de insert/update.
