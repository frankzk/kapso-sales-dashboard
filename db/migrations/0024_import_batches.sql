-- ============================================================================
-- 0024_import_batches.sql — uploaded Aliclik delivery reports. import_batches is
-- one upload; import_rows are the parsed source rows (kept for audit, idempotent
-- re-import, and the manual-review queue: rows that didn't auto-match an order).
--
-- RLS: store-scoped reads; writes via service role. Apply after 0022/0023.
-- ============================================================================

create table if not exists import_batches (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,  -- default store for unmatched rows
  kind            text not null default 'aliclik_delivery',
  filename        text,
  uploaded_by     uuid references auth.users(id) on delete set null,
  row_count       integer not null default 0,
  matched_count   integer not null default 0,
  unmatched_count integer not null default 0,
  status          text not null default 'processed',  -- processing | processed | failed
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists import_batches_store_idx on import_batches(store_id, created_at desc);

create table if not exists import_rows (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references import_batches(id) on delete cascade,
  store_id      uuid not null references stores(id) on delete cascade,
  row_index     integer not null,
  raw           jsonb not null,                  -- the parsed source row (audit + re-match)
  parsed        jsonb,                           -- canonicalized {guide_code, order_name, phone, ...}
  match_status  text not null default 'pending', -- matched | unmatched | review | error
  shipment_id   uuid references shipments(id) on delete set null,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists import_rows_batch_idx  on import_rows(batch_id, row_index);
create index if not exists import_rows_review_idx  on import_rows(store_id, match_status);

alter table import_batches enable row level security;
alter table import_rows    enable row level security;

drop policy if exists import_batches_select on import_batches;
create policy import_batches_select on import_batches for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists import_rows_select on import_rows;
create policy import_rows_select on import_rows for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on import_batches to authenticated;
grant select on import_rows to authenticated;
grant all privileges on import_batches to service_role;
grant all privileges on import_rows to service_role;
