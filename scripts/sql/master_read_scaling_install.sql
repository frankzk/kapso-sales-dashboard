-- Controlled first installation/reinstallation. Prebuild indexes concurrently.
-- Run only in the planned release window, BEFORE serving the new application.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/master_read_scaling_install.sql
-- Failure rolls back this transaction; it never drops source orders/history.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local application_name = 'master-scaling-install';

do $indexes$
declare expected record;
begin
  for expected in select * from (values
    ('order_master_store_created_page_idx', 'order_master'),
    ('order_master_stage_created_page_idx', 'order_master'),
    ('order_master_substage_created_page_idx', 'order_master'),
    ('leads_order_id_idx', 'leads')
  ) e(index_name, table_name)
  loop
    if not exists (
      select 1 from pg_index i
      join pg_class idx on idx.oid = i.indexrelid
      join pg_namespace n on n.oid = idx.relnamespace
      where n.nspname = 'public' and idx.relname = expected.index_name
        and i.indrelid = to_regclass('public.' || expected.table_name)
        and i.indisvalid and i.indisready
    ) then
      raise exception 'Prebuild valid index concurrently before installation: %', expected.index_name;
    end if;
  end loop;
end;
$indexes$;

\ir ../../db/migrations/0202_master_read_scaling.sql
commit;
