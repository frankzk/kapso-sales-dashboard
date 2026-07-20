-- ============================================================================
-- 0040_cart_sequence.sql — secuencia de WhatsApp para CARRITOS ABANDONADOS
-- (drafts COD de Shopify). Dos plantillas aprobadas por Meta, ancladas a la
-- CREACIÓN del carrito (default: +3h y +24h), enviadas desde el cron de sync
-- solo en horario local configurable. Corre EN PARALELO a la gestión humana:
-- nunca toca status/category/next_followup_at del lead — solo sus columnas
-- propias — así no se cruza con el reencolado a "sin llamar" ni con las olas.
-- Se detiene si el lead ya tiene pedido / quedó won o lost / el carrito se
-- completó o borró / el cliente respondió después de crear el carrito.
--
--  1) stores.cart_seq_* — config por tienda (espejo del drip 0035, con horas
--     y ventana horaria configurables). OFF por defecto: nada se envía hasta
--     activar en Ajustes con las plantillas ya aprobadas.
--  2) leads.cart_seq_touches / last_cart_seq_at / cart_seq_gid — estado del
--     lead. cart_seq_gid ata el contador AL carrito: un carrito nuevo (gid
--     distinto) reinicia la secuencia (recompra = nueva conversación).
--  3) cart_seq_sends — un registro por intento (ok o fallido) para auditoría
--     y para medir recuperación (¿pedido después de sent_at?). RLS de solo
--     lectura para usuarios de la tienda; escribe el service role (espejo de
--     drip_sends / winback_sends).
-- ============================================================================

alter table stores add column if not exists cart_seq_enabled boolean not null default false;
alter table stores add column if not exists cart_seq_template_1_name     text;
alter table stores add column if not exists cart_seq_template_1_language text;
alter table stores add column if not exists cart_seq_template_2_name     text;
alter table stores add column if not exists cart_seq_template_2_language text;
alter table stores add column if not exists cart_seq_hours_1 integer not null default 3;
alter table stores add column if not exists cart_seq_hours_2 integer not null default 24;
alter table stores add column if not exists cart_seq_hour_start integer not null default 8;
alter table stores add column if not exists cart_seq_hour_end   integer not null default 21;

alter table leads add column if not exists cart_seq_touches int not null default 0;
alter table leads add column if not exists last_cart_seq_at timestamptz;
alter table leads add column if not exists cart_seq_gid text;

create table if not exists cart_seq_sends (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  lead_id        uuid not null references leads(id) on delete cascade,
  phone          text not null,              -- normalizePhone() applied
  draft_order_gid text,                      -- carrito al que pertenece el toque
  template_name  text,
  touch          int  not null,              -- 1 o 2
  ok             boolean not null default true, -- Meta/Kapso aceptó el envío
  error          text,                       -- motivo cuando ok = false
  sent_at        timestamptz not null default now()
);
create index if not exists cart_seq_sends_store_sent_idx on cart_seq_sends(store_id, sent_at);
create index if not exists cart_seq_sends_lead_idx on cart_seq_sends(lead_id);

alter table cart_seq_sends enable row level security;
drop policy if exists cart_seq_sends_select on cart_seq_sends;
create policy cart_seq_sends_select on cart_seq_sends for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on cart_seq_sends to authenticated;
grant all privileges on cart_seq_sends to service_role;
