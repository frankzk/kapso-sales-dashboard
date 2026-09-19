-- ============================================================================
-- 0173_master_backfill_log.sql — bitácora reversible de las entregas que se
-- aplican al Master en bloque desde la historia del cuaderno (Liquidaciones 2).
--
-- POR QUÉ. El 19-09-2026 la bandeja de Grupo GF Courier mostraba 6.368 pedidos
-- de Lima «abiertos» de los que 4.619 ya estaban entregados según el cuaderno
-- de los motorizados: la carga histórica llenó Rutas y las hojas, pero a
-- propósito no tocó el Master (MOM §29.12). Aplicarlos en bloque es la única
-- forma práctica de ponerse al día, y una operación de ese tamaño sobre
-- producción exige poder deshacerse: esta tabla guarda, por pedido, cómo
-- estaba el Master antes y qué evento se insertó, para que
-- `scripts/rollback-master-backfill.ts` pueda retirar el lote entero.
--
-- Revertir = borrar los `order_events` del lote y recalcular: el Master vuelve
-- a derivarse de los eventos que quedan. Las columnas «previous_*» sirven
-- para comprobar que el recálculo devolvió lo mismo, no para escribirlas a
-- mano.
-- ============================================================================
create table if not exists master_backfill_log (
  id                    uuid primary key default gen_random_uuid(),
  batch_id              uuid not null,
  order_id              uuid not null references orders(id) on delete cascade,
  store_id              uuid references stores(id) on delete set null,
  sheet_id              uuid references sheets(id) on delete set null,
  row_id                uuid references sheet_rows(id) on delete set null,
  event_id              uuid references order_events(id) on delete set null,
  previous_general      text,
  previous_operational  text,
  previous_source       text,
  previous_locked       boolean,
  previous_delivered_at timestamptz,
  previous_courier      text,
  previous_macro_stage  text,
  previous_macro_substage text,
  applied_status        text not null,
  applied_courier       text,
  applied_occurred_at   timestamptz,
  applied_at            timestamptz not null default now(),
  reverted_at           timestamptz,
  note                  text
);
create index if not exists master_backfill_log_batch_idx on master_backfill_log(batch_id, applied_at);
create index if not exists master_backfill_log_order_idx on master_backfill_log(order_id);

alter table master_backfill_log enable row level security;
drop policy if exists master_backfill_log_select on master_backfill_log;
create policy master_backfill_log_select on master_backfill_log for select to authenticated
  using (store_id in (select auth_store_ids()));
-- Solo la escribe el service role (scripts). Nadie la edita desde la UI.
revoke all on master_backfill_log from anon, authenticated;
grant select on master_backfill_log to authenticated;
grant all privileges on master_backfill_log to service_role;
