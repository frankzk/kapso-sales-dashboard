-- Read-only guard shared by installation and post-installation checks.
-- A valid index with the right NAME but wrong columns/order is not sufficient.
do $master_indexes$
declare expected record;
begin
  for expected in select * from (values
    ('order_master_store_created_page_idx', 'order_master',
      '(store_id, order_created_at DESC NULLS LAST, id)'),
    ('order_master_stage_created_page_idx', 'order_master',
      '(store_id, macro_stage, order_created_at DESC NULLS LAST, id)'),
    ('order_master_substage_created_page_idx', 'order_master',
      '(store_id, macro_substage, order_created_at DESC NULLS LAST, id)'),
    ('leads_order_id_idx', 'leads', '(order_id) WHERE (order_id IS NOT NULL)')
  ) e(index_name, table_name, definition)
  loop
    if not exists (
      select 1 from pg_index i
      join pg_class idx on idx.oid = i.indexrelid
      join pg_namespace n on n.oid = idx.relnamespace
      where n.nspname = 'public' and idx.relname = expected.index_name
        and i.indrelid = to_regclass('public.' || expected.table_name)
        and i.indisvalid and i.indisready
        and pg_get_indexdef(i.indexrelid) = format(
          'CREATE INDEX %I ON public.%I USING btree %s',
          expected.index_name, expected.table_name, expected.definition)
    ) then
      raise exception 'Required Master index missing or invalid definition; prebuild exact index concurrently: %', expected.index_name;
    end if;
  end loop;
end;
$master_indexes$;
