-- ============================================================================
-- 0035_seguimiento_drip.sql — drip de seguimiento por WhatsApp para leads que
-- NO CONTESTAN (status no_responde / buzon / cuelga — y solo esos: contactados
-- ya tiene conversación humana, sin_llamar aún no fue tocado y sin_stock no
-- tiene novedad que ofrecer). El cron de sync (cada 5 min) envía la plantilla
-- aprobada por Meta — única vía fuera de la ventana de 24h — con máximo 2
-- toques por lead (~6h tras la gestión y +24h después), solo en horario
-- laboral de Lima, y se detiene si el cliente respondió, si la asesora agendó
-- seguimiento manual (next_followup_at) o si el lead tiene atención pendiente.
--
--  1) stores.drip_template_*  — config por tienda (mismo trío que browse /
--     winback). OFF por defecto: nada se envía hasta activar en Ajustes.
--  2) leads.drip_touches / last_drip_at — targeting barato en el selector
--     (tope de toques + espaciado de 24h) sin joins.
--  3) drip_sends — un registro por intento de envío (ok o fallido) para
--     auditoría y para medir si el drip recupera ventas (¿last_inbound_at o
--     pedido DESPUÉS de sent_at?). RLS de solo lectura para usuarios de la
--     tienda; escribe el service role (espejo de winback_sends / 0030).
-- ============================================================================

alter table stores add column if not exists drip_template_enabled  boolean not null default false;
alter table stores add column if not exists drip_template_name      text;
alter table stores add column if not exists drip_template_language  text;

alter table leads add column if not exists drip_touches int not null default 0;
alter table leads add column if not exists last_drip_at timestamptz;

create table if not exists drip_sends (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  lead_id        uuid not null references leads(id) on delete cascade,
  phone          text not null,              -- normalizePhone() applied
  template_name  text,
  touch          int  not null,              -- 1 o 2
  ok             boolean not null default true, -- Meta/Kapso aceptó el envío
  error          text,                       -- motivo cuando ok = false
  sent_at        timestamptz not null default now()
);
create index if not exists drip_sends_store_sent_idx on drip_sends(store_id, sent_at);
create index if not exists drip_sends_lead_idx on drip_sends(lead_id);

alter table drip_sends enable row level security;
drop policy if exists drip_sends_select on drip_sends;
create policy drip_sends_select on drip_sends for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on drip_sends to authenticated;
grant all privileges on drip_sends to service_role;
