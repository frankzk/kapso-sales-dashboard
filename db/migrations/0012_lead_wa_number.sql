-- ============================================================================
-- 0012_lead_wa_number.sql — which WhatsApp number a lead wrote to
-- A business can connect several WhatsApp numbers to one Kapso project (e.g. an
-- API/Cloud number + a Business-app "coexistence" number). Kapso stamps every
-- conversation with the destination `phone_number_id`; we already store that on
-- `conversations`. This migration surfaces it per LEAD so the queue + dashboard
-- can split by number:
--   1) leads.wa_phone_number_id — the number the lead came in on.
--   2) whatsapp_numbers — phone_number_id → friendly name / display phone / kind
--      (resolved from Kapso; seed with scripts/sql/seed_whatsapp_numbers.sql).
--   3) backfill existing leads from their conversation.
-- whatsapp_numbers self-contains its RLS (applied after policies.sql, like 0004).
-- ============================================================================
alter table leads add column if not exists wa_phone_number_id text;
create index if not exists leads_store_wa_number_idx on leads (store_id, wa_phone_number_id);

create table if not exists whatsapp_numbers (
  phone_number_id text primary key,
  name            text,
  display_phone   text,
  kind            text,            -- 'api' | 'business' (coexistence) | 'sandbox'
  fetched_at      timestamptz not null default now()
);

-- Non-sensitive label metadata: any authenticated user may read; writes only via
-- the service role (or the psql seed).
alter table whatsapp_numbers enable row level security;
drop policy if exists whatsapp_numbers_select on whatsapp_numbers;
create policy whatsapp_numbers_select on whatsapp_numbers for select to authenticated
  using (true);
grant select on whatsapp_numbers to authenticated;
grant all privileges on whatsapp_numbers to service_role;

-- Backfill the number onto existing leads from their conversation (idempotent).
update leads l
   set wa_phone_number_id = c.phone_number_id
  from conversations c
 where c.store_id = l.store_id
   and c.kapso_conversation_id = l.kapso_conversation_id
   and l.wa_phone_number_id is null
   and c.phone_number_id is not null;
