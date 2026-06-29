-- ============================================================================
-- 0023_shipment_calls.sql — activity log for shipments (calls, state changes,
-- notes, re-routes). A near-verbatim copy of lead_calls, but a SEPARATE table:
-- lead_calls.lead_id is NOT NULL + FK to leads, and a shipment often has no lead
-- (Kenku/unmatched), so overloading lead_calls would break its schema + queries.
--
-- RLS: store-scoped reads; writes via service role. Apply after 0022.
-- ============================================================================

create table if not exists shipment_calls (
  id                uuid primary key default gen_random_uuid(),
  shipment_id       uuid not null references shipments(id) on delete cascade,
  store_id          uuid not null references stores(id) on delete cascade,
  agent             uuid references auth.users(id) on delete set null,  -- 'vendedora' equiv
  kind              text not null default 'call',  -- call | state_change | note | reroute | system
  new_status        text,                          -- delivery_status set, if any
  note              text,
  next_followup_at  timestamptz,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create index if not exists shipment_calls_shipment_idx on shipment_calls(shipment_id, occurred_at desc);
create index if not exists shipment_calls_store_idx     on shipment_calls(store_id, occurred_at desc);
create index if not exists shipment_calls_agent_idx     on shipment_calls(agent, occurred_at desc);

alter table shipment_calls enable row level security;

drop policy if exists shipment_calls_select on shipment_calls;
create policy shipment_calls_select on shipment_calls for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on shipment_calls to authenticated;
grant all privileges on shipment_calls to service_role;
