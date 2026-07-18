-- Reliable outbound WhatsApp lifecycle. One row per explicit send attempt;
-- client_token prevents double sends and provider_message_id joins status webhooks.

create table if not exists whatsapp_outbox (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references stores(id) on delete cascade,
  lead_id             uuid not null references leads(id) on delete cascade,
  client_token        text not null,
  retry_of            uuid references whatsapp_outbox(id) on delete set null,
  provider_message_id text,
  phone_number_id     text not null,
  to_phone            text not null,
  kind                text not null default 'text',
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

create unique index if not exists whatsapp_outbox_provider_id_idx
  on whatsapp_outbox(store_id, provider_message_id)
  where provider_message_id is not null;
create index if not exists whatsapp_outbox_lead_created_idx
  on whatsapp_outbox(lead_id, created_at desc);

alter table whatsapp_outbox enable row level security;
drop policy if exists whatsapp_outbox_select on whatsapp_outbox;
create policy whatsapp_outbox_select on whatsapp_outbox for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on whatsapp_outbox to authenticated;
grant all privileges on whatsapp_outbox to service_role;
