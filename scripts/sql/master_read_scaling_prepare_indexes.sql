-- Production preparation, only in the agreed low-activity window.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/master_read_scaling_prepare_indexes.sql
-- DO NOT wrap in BEGIN or pass --single-transaction: builds are CONCURRENTLY.
-- No source data is changed. Interrupted builds can leave invalid indexes;
-- investigate and repair explicitly rather than repeatedly rerunning this file.
set lock_timeout='5s';
set statement_timeout='15min';
set application_name='master-scaling-prepare-indexes';
create index concurrently if not exists order_master_store_created_page_idx
  on public.order_master (store_id, order_created_at desc nulls last, id asc);
create index concurrently if not exists order_master_stage_created_page_idx
  on public.order_master (store_id, macro_stage, order_created_at desc nulls last, id asc);
create index concurrently if not exists order_master_substage_created_page_idx
  on public.order_master (store_id, macro_substage, order_created_at desc nulls last, id asc);
create index concurrently if not exists leads_order_id_idx
  on public.leads (order_id) where order_id is not null;
\ir master_read_scaling_indexes.sql
reset lock_timeout;
reset statement_timeout;
reset application_name;
