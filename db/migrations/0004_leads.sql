-- ============================================================================
-- 0004_leads.sql — Leads + call-management module (replaces the "abandonos" Excel)
-- Adds the 'vendedora' role, a leads table (one per phone within a store) and a
-- lead_calls activity log. RLS: store-scoped reads; writes go through the
-- service role (server actions), like the rest of the ingested data.
-- Apply AFTER supabase/policies.sql (it uses auth_store_ids()).
-- ============================================================================

-- 1) New role for sales agents.
alter table memberships drop constraint if exists memberships_role_check;
alter table memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'viewer', 'vendedora'));

-- 1b) Customer phone on orders, so leads (keyed by phone) can link to orders.
alter table orders add column if not exists customer_phone text;
create index if not exists orders_store_customer_phone_idx on orders(store_id, customer_phone);

-- 2) Leads — deduped by phone within a store, ordered by last interaction.
create table if not exists leads (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete cascade,
  phone                 text not null,
  wa_id                 text,
  name                  text,
  email                 text,
  first_seen_at         timestamptz,
  last_interaction_at   timestamptz,
  kapso_conversation_id text,
  -- bot / CRM-derived signals
  bot_compra_state      text,                  -- Kapso "Compra realizada": no/iniciado/...
  handoff_reason        text,                  -- e.g. validacion_logistica
  handoff_context       text,                  -- bot context_summary
  handoff_at            timestamptz,
  -- our state machine
  category              text not null default 'open',   -- won | hot | open | lost
  status                text not null default 'nuevo',
  needs_attention       boolean not null default false,
  -- order linkage
  order_id              uuid references orders(id) on delete set null,
  has_order             boolean not null default false,
  -- assignment / claim lock
  claimed_by            uuid references auth.users(id) on delete set null,
  claimed_at            timestamptz,
  -- close / followup
  closed_by             uuid references auth.users(id) on delete set null,
  next_followup_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (store_id, phone)
);
create index if not exists leads_store_lastint_idx on leads(store_id, last_interaction_at desc);
create index if not exists leads_store_category_idx on leads(store_id, category);
create index if not exists leads_store_followup_idx on leads(store_id, next_followup_at);
create index if not exists leads_store_attention_idx on leads(store_id, needs_attention);

-- 3) lead_calls — activity log (calls, manual state changes, notes, sale).
create table if not exists lead_calls (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid not null references leads(id) on delete cascade,
  store_id          uuid not null references stores(id) on delete cascade,
  vendedora         uuid references auth.users(id) on delete set null,
  kind              text not null default 'call',   -- call | state_change | note | sale | system
  new_status        text,
  note              text,
  next_followup_at  timestamptz,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create index if not exists lead_calls_lead_idx on lead_calls(lead_id, occurred_at desc);
create index if not exists lead_calls_store_idx on lead_calls(store_id, occurred_at desc);
create index if not exists lead_calls_vendedora_idx on lead_calls(vendedora, occurred_at desc);

-- 4) RLS — store-scoped reads; writes via service role only.
alter table leads enable row level security;
alter table lead_calls enable row level security;

drop policy if exists leads_select on leads;
create policy leads_select on leads for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists lead_calls_select on lead_calls;
create policy lead_calls_select on lead_calls for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on leads to authenticated;
grant select on lead_calls to authenticated;
grant all privileges on leads to service_role;
grant all privileges on lead_calls to service_role;

-- 5) keep leads.updated_at fresh
create or replace function public.touch_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists leads_touch on leads;
create trigger leads_touch before update on leads
  for each row execute function public.touch_updated_at();
