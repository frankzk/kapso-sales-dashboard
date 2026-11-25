-- ============================================================================
-- 0354_social_inbox.sql — la bandeja de redes en Leads (owner, 25-11-2026:
-- «las asesoras desde Kapta, dentro de Leads. Con respuestas automáticas»;
-- MOM §25.4).
--
-- Los comentarios de la fan page y de Instagram, Messenger y los mensajes
-- directos de Instagram llegan por Zernio (zernio.com, la API sobre la de
-- Meta). Kapta guarda su copia para que las asesoras lean y respondan desde
-- Leads → Redes. Fase 1: recibir, guardar y responder; el reparto y las
-- respuestas automáticas vienen después y usan estas mismas tablas.
--
--   * `social_accounts`: cada cuenta conectada en Zernio (una fan page o un
--     Instagram) y la tienda de Kapta a la que pertenece.
--   * `social_webhook_events`: cada aviso de Zernio, una vez (su `id` es la
--     llave: Zernio reintenta hasta 7 veces y puede repetir el mismo aviso).
--   * `social_threads`: una conversación de mensajes directos, o un comentario
--     principal de un post con sus respuestas.
--   * `social_messages`: cada mensaje o comentario, entrante o saliente.
--
-- Lectura: los miembros con acceso a la tienda (RLS `auth_store_ids()`), igual
-- que `leads`. Escritura: solo el servidor (service_role), desde el webhook y
-- las acciones de Leads → Redes, que revisan el acceso antes de escribir.
-- Tablas nuevas: no cambia datos existentes. Correrla otra vez no cambia nada.
-- ============================================================================

create table if not exists social_accounts (
  account_id    text primary key,              -- el `accountId` de Zernio
  store_id      uuid references stores(id) on delete set null,
  profile_id    text,                          -- el perfil de Zernio (una marca)
  platform      text not null,                 -- facebook | instagram
  username      text,
  display_name  text,
  page_id       text,
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);

create table if not exists social_webhook_events (
  event_id      text primary key,              -- `id` / X-Zernio-Event-Id
  event         text not null,
  account_id    text,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);
create index if not exists social_webhook_events_received_idx on social_webhook_events (received_at desc);

create table if not exists social_threads (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid references stores(id) on delete set null,
  account_id            text not null,
  platform              text not null,          -- facebook | instagram
  kind                  text not null check (kind in ('dm', 'comment')),
  -- dm: el `conversationId` de Zernio; comment: el id del comentario principal.
  external_id           text not null,
  post_id               text,                   -- comment: el id del post en la red
  post_text             text,
  post_permalink        text,
  post_image_url        text,
  ad_id                 text,
  participant_id        text,
  participant_name      text,
  participant_username  text,
  participant_picture   text,
  last_inbound_at       timestamptz,
  last_message_at       timestamptz,
  last_message_text     text,
  last_direction        text check (last_direction in ('in', 'out')),
  unread                integer not null default 0,
  status                text not null default 'abierto' check (status in ('abierto', 'respondido', 'cerrado')),
  private_reply_at      timestamptz,            -- comment: la única respuesta por privado que Meta permite
  claimed_by            uuid references auth.users(id) on delete set null,
  claimed_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (account_id, kind, external_id)
);
create index if not exists social_threads_store_idx on social_threads (store_id, last_message_at desc);
create index if not exists social_threads_status_idx on social_threads (status, last_message_at desc);

create table if not exists social_messages (
  id                    uuid primary key default gen_random_uuid(),
  thread_id             uuid not null references social_threads(id) on delete cascade,
  store_id              uuid references stores(id) on delete set null,
  direction             text not null check (direction in ('in', 'out')),
  channel               text not null check (channel in ('dm', 'comment_public', 'comment_private')),
  -- dm: el `mid` de Meta (platformMessageId); comentario: el id del comentario.
  external_id           text,
  text                  text,
  attachments           jsonb not null default '[]'::jsonb,
  author_id             text,
  author_name           text,
  sent_by               uuid references auth.users(id) on delete set null,
  via                   text not null default 'cliente' check (via in ('cliente', 'kapta', 'auto', 'nativo')),
  occurred_at           timestamptz not null default now(),
  idempotency_key       text,
  status                text not null default 'ok' check (status in ('ok', 'enviando', 'fallo')),
  error                 text,
  created_at            timestamptz not null default now()
);
create unique index if not exists social_messages_external_uniq on social_messages (thread_id, external_id) where external_id is not null;
create unique index if not exists social_messages_idem_uniq on social_messages (idempotency_key) where idempotency_key is not null;
create index if not exists social_messages_thread_idx on social_messages (thread_id, occurred_at);

alter table social_accounts enable row level security;
alter table social_webhook_events enable row level security;
alter table social_threads enable row level security;
alter table social_messages enable row level security;

drop policy if exists social_accounts_select on social_accounts;
create policy social_accounts_select on social_accounts for select to authenticated
  using (store_id in (select auth_store_ids()));
drop policy if exists social_threads_select on social_threads;
create policy social_threads_select on social_threads for select to authenticated
  using (store_id in (select auth_store_ids()));
drop policy if exists social_messages_select on social_messages;
create policy social_messages_select on social_messages for select to authenticated
  using (store_id in (select auth_store_ids()));
-- social_webhook_events: sin política, solo el servidor.
