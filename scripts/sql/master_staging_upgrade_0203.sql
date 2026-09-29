-- ONLY the disposable kapso-sales-staging project, selected by the operator.
-- Synthetic fixture guard; never run this script against production.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $guard$ begin
  if (select count(*) from public.orders) <> 420
    or not exists(select 1 from public.organizations where id='01980000-0000-4000-0001-000000000001') then
    raise exception 'Expected isolated staging fixture; refusing upgrade';
  end if;
end $guard$;
create function pg_temp.master_source_fingerprints()
returns table(relation text, rows bigint, digest text)
language plpgsql as $capture$
declare t record;
begin
  for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and (n.nspname='public' or (n.nspname='auth' and c.relname='users'))
    and c.relname not in ('order_master_stage_parts','order_master_facet_parts')
  loop
    return query execute format(
      $sql$select %L::text,count(*),md5(coalesce(string_agg(h,'' order by h),'')) from (select md5(to_jsonb(t)::text) h from %I.%I t) r$sql$,
      t.nspname||'.'||t.relname,t.nspname,t.relname);
  end loop;
end;
$capture$;
create temp table master_source_before as select * from pg_temp.master_source_fingerprints();
\ir ../../db/migrations/0202_swayp_inventory_sessions.sql
\ir master_read_scaling_indexes.sql
\ir ../../db/migrations/0203_master_read_scaling.sql
do $verify$ begin
  if exists(select * from master_source_before except select * from pg_temp.master_source_fingerprints()) then
    raise exception 'Staging source data changed; rolling back upgrade';
  end if;
end $verify$;
select 'STAGING_0203_PRESERVED' as result,(select count(*) from master_source_before) as tables_checked,
  (select count(*) from public.orders) as orders,(select count(*) from public.order_events) as events,
  (select count(*) from public.shipments) as shipments;
commit;
