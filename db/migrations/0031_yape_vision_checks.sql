-- ============================================================================
-- 0031_yape_vision_checks.sql — audit + dedup for vision-based Yape voucher
-- detection.
--
-- The "Yape/Shalom por verificar" alert must fire on a REAL voucher, not on any
-- screenshot the customer sends. Text/caption signals catch the explicit cases
-- ("ya pagué", "nº de operación"); a silent voucher IMAGE needs its content read
-- (Yape logo/interfaz, monto, fecha/hora, destinatario "Grupo GF SAC", estado
-- "Pago realizado/Transferencia exitosa/Yapeaste", nº de operación) — i.e. a
-- vision check (Claude), which runs at most once per image thanks to this table.
--
-- One row per inbound image analyzed:
--  - message_id  — the Kapso message id (dedup key; an image is checked once).
--  - is_voucher  — the verdict that (re)promotes the lead to yape_por_verificar.
--  - indicators  — which signals the model saw (audit / tuning), e.g.
--                  {"logo":true,"monto":true,"grupo_gf_sac":false,...}.
--  - model       — which model produced the verdict (audit).
--
-- Store-scoped, RLS read-only for authenticated users; writes via the service
-- role (the sync/cron path), mirroring winback_sends (0030) / draft_orders (0013).
-- ============================================================================

create table if not exists yape_vision_checks (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  message_id   text not null,             -- Kapso message id (globally unique)
  is_voucher   boolean not null,
  indicators   jsonb not null default '{}'::jsonb,
  model        text,
  checked_at   timestamptz not null default now(),
  unique (store_id, message_id)           -- analyze each image at most once
);
create index if not exists yape_vision_checks_store_idx on yape_vision_checks(store_id, checked_at);

alter table yape_vision_checks enable row level security;
drop policy if exists yape_vision_checks_select on yape_vision_checks;
create policy yape_vision_checks_select on yape_vision_checks for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on yape_vision_checks to authenticated;
grant all privileges on yape_vision_checks to service_role;
