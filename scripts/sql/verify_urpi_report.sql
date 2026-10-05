-- ⚠️  THROWAWAY TEST CLUSTERS ONLY — never run against a real Supabase DB.
-- Verifica 0228_urpi_report.sql sobre un Postgres vacío:
--   psql -v ON_ERROR_STOP=1 -f scripts/sql/verify_urpi_report.sql
-- (lo levanta scripts/verify-urpi-report.sh). Termina con «urpi_report: ok».
\set ON_ERROR_STOP on
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users(id uuid primary key);
create table public.organizations(id uuid primary key);
create table public.stores(id uuid primary key, org_id uuid not null references organizations);
create table public.orders(id uuid primary key, store_id uuid not null references stores);
create function public.auth_org_ids() returns setof uuid language sql stable as $$
  select nullif(current_setting('test.org_id', true), '')::uuid $$;
create function public.auth_store_ids() returns setof uuid language sql stable as $$
  select nullif(current_setting('test.store_id', true), '')::uuid $$;
grant usage on schema public, auth to authenticated, service_role;
grant select on organizations, stores, orders to service_role;
insert into auth.users values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into organizations values ('0a000000-0000-0000-0000-000000000001'), ('0b000000-0000-0000-0000-000000000002');
insert into stores values ('11111111-1111-1111-1111-111111111111', '0a000000-0000-0000-0000-000000000001'),
  ('22222222-2222-2222-2222-222222222222', '0a000000-0000-0000-0000-000000000001'),
  ('33333333-3333-3333-3333-333333333333', '0b000000-0000-0000-0000-000000000002');
insert into orders values ('b1111111-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'),
  ('b2222222-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222'),
  ('b3333333-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333');

\ir ../../db/migrations/0228_urpi_report.sql
\ir ../../db/migrations/0228_urpi_report.sql

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FALLA: %', what; end if; end $$;
create function pg_temp.fails(sql text, pattern text) returns boolean language plpgsql as $$
begin execute sql; return false; exception when others then
  if sqlerrm !~ pattern then raise exception 'error inesperado: %', sqlerrm; end if; return true; end $$;

set role service_role;
insert into urpi_report_imports(id, org_id, created_by, filename, row_count) values
  ('c0000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a.csv', 3),
  ('c0000000-0000-0000-0000-000000000002', '0a000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'b.csv', 3);
-- Tres intentos: 10 sin vínculo, 11 reintento de 10, 12 vinculado a Kenku.
select pg_temp.check((save_urpi_report_batch('0a000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', $j$[
  {"urpi_row":10,"previous_row":null,"report_date":"2026-10-01","result_code":"reprogramado","phone":"900000001","data":{"r":"R"},"digest":"1111111111111111111111111111111111111111111111111111111111111111","order_id":null,"store_id":null,"link_status":"varios","link_method":"telefono","candidate_order_ids":["b1111111-0000-0000-0000-000000000001","b2222222-0000-0000-0000-000000000002"]},
  {"urpi_row":11,"previous_row":10,"report_date":"2026-10-02","result_code":"cancelado","phone":"900000001","data":{"r":"C"},"digest":"2222222222222222222222222222222222222222222222222222222222222222","order_id":null,"store_id":null,"link_status":"varios","link_method":"cadena","candidate_order_ids":["b1111111-0000-0000-0000-000000000001","b2222222-0000-0000-0000-000000000002"]},
  {"urpi_row":12,"previous_row":null,"report_date":"2026-10-02","result_code":"entregado","phone":"900000002","data":{"r":"E"},"digest":"3333333333333333333333333333333333333333333333333333333333333333","order_id":"b1111111-0000-0000-0000-000000000001","store_id":"11111111-1111-1111-1111-111111111111","link_status":"vinculado","link_method":"telefono","candidate_order_ids":[]}
]$j$::jsonb))->>'new' = '3', 'tres filas nuevas');
select pg_temp.check((select count(*) from urpi_report_row_versions) = 3, 'una versión por fila nueva');

-- Reimportar lo mismo no crea versiones; un cambio sí, y la anterior se conserva.
select pg_temp.check((save_urpi_report_batch('0a000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', $j$[
  {"urpi_row":12,"previous_row":null,"report_date":"2026-10-02","result_code":"entregado","phone":"900000002","data":{"r":"E"},"digest":"3333333333333333333333333333333333333333333333333333333333333333","order_id":"b1111111-0000-0000-0000-000000000001","store_id":"11111111-1111-1111-1111-111111111111","link_status":"vinculado","link_method":"telefono","candidate_order_ids":[]},
  {"urpi_row":11,"previous_row":10,"report_date":"2026-10-02","result_code":"entregado","phone":"900000001","data":{"r":"E2"},"digest":"4444444444444444444444444444444444444444444444444444444444444444","order_id":null,"store_id":null,"link_status":"varios","link_method":"cadena","candidate_order_ids":["b1111111-0000-0000-0000-000000000001","b2222222-0000-0000-0000-000000000002"]}
]$j$::jsonb))->>'changed' = '1', 'un solo cambio');
select pg_temp.check((select count(*) from urpi_report_row_versions where urpi_row = 11) = 2, 'historial de la fila cambiada');
select pg_temp.check((select data->>'r' from urpi_report_rows where urpi_row = 11) = 'E2', 'fila con el último contenido');
select pg_temp.check((select first_import_id::text from urpi_report_rows where urpi_row = 11) = 'c0000000-0000-0000-0000-000000000001', 'conserva la primera lectura');

-- Vínculo manual sobre el reintento: toda la cadena pasa al pedido elegido.
select pg_temp.check(link_urpi_report_chain('0a000000-0000-0000-0000-000000000001', 11, 'b2222222-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 2, 'vincula la cadena entera');
select pg_temp.check((select bool_and(order_id = 'b2222222-0000-0000-0000-000000000002' and link_method = 'manual') from urpi_report_rows where urpi_row in (10, 11)), 'cadena manual');
-- Una lectura posterior no pisa un vínculo manual.
select save_urpi_report_batch('0a000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', $j$[
  {"urpi_row":10,"previous_row":null,"report_date":"2026-10-01","result_code":"reprogramado","phone":"900000001","data":{"r":"R"},"digest":"1111111111111111111111111111111111111111111111111111111111111111","order_id":null,"store_id":null,"link_status":"sin_pedido","link_method":null,"candidate_order_ids":[]}
]$j$::jsonb);
select pg_temp.check((select order_id::text from urpi_report_rows where urpi_row = 10) = 'b2222222-0000-0000-0000-000000000002', 'manual se conserva');

-- Nunca un pedido de otra organización ni de otra tienda.
select pg_temp.check(pg_temp.fails($q$select link_urpi_report_chain('0a000000-0000-0000-0000-000000000001', 12, 'b3333333-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', null)$q$, 'invalid_order_scope'), 'otra organización');
select pg_temp.check(pg_temp.fails($q$select link_urpi_report_chain('0a000000-0000-0000-0000-000000000001', 12, 'b1111111-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', null)$q$, 'invalid_order_scope'), 'tienda que no es la del pedido');
select pg_temp.check(pg_temp.fails($q$select save_urpi_report_batch('0a000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', '[{"urpi_row":20,"result_code":"entregado","data":{},"digest":"5555555555555555555555555555555555555555555555555555555555555555","order_id":"b3333333-0000-0000-0000-000000000003","store_id":"33333333-3333-3333-3333-333333333333","link_status":"vinculado","link_method":"telefono"}]')$q$, 'invalid_order_scope'), 'lote con pedido ajeno');
select pg_temp.check(pg_temp.fails($q$select save_urpi_report_batch('0b000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', '[]')$q$, 'invalid_import'), 'lectura de otra organización');
select pg_temp.check(pg_temp.fails($q$insert into urpi_report_rows(org_id, urpi_row, result_code, data, digest, link_status, first_import_id, last_import_id, order_id) values ('0a000000-0000-0000-0000-000000000001', 30, 'entregado', '{}', '6666666666666666666666666666666666666666666666666666666666666666', 'sin_pedido', 'c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'b1111111-0000-0000-0000-000000000001')$q$, 'check'), 'pedido sin tienda');

-- Lectura con RLS: la tienda ve lo suyo y lo que aún no tiene tienda.
reset role;
set role authenticated;
select set_config('test.org_id', '0a000000-0000-0000-0000-000000000001', false);
select set_config('test.store_id', '11111111-1111-1111-1111-111111111111', false);
select pg_temp.check((select count(*) from urpi_report_rows) = 1, 'Kenku ve solo su fila vinculada');
select pg_temp.check((select count(*) from urpi_report_row_versions) = 1, 'y solo su historial');
select set_config('test.store_id', '22222222-2222-2222-2222-222222222222', false);
select pg_temp.check((select count(*) from urpi_report_rows) = 2, 'Aurela ve su cadena');
select set_config('test.org_id', '0b000000-0000-0000-0000-000000000002', false);
select pg_temp.check((select count(*) from urpi_report_rows) = 0, 'otra organización no ve nada');
select pg_temp.check((select count(*) from urpi_report_imports) = 0, 'ni sus lecturas');
select pg_temp.check(pg_temp.fails($q$update urpi_report_rows set result_code = 'entregado'$q$, 'permission denied'), 'usuario no escribe');
select pg_temp.check(pg_temp.fails($q$select save_urpi_report_batch('0a000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', '[]')$q$, 'permission denied'), 'usuario no llama al lote');
select pg_temp.check(pg_temp.fails($q$select link_urpi_report_chain('0a000000-0000-0000-0000-000000000001', 12, 'b1111111-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', null)$q$, 'permission denied'), 'usuario no vincula');
reset role;
set role anon;
select pg_temp.check(pg_temp.fails($q$select * from urpi_report_rows$q$, 'permission denied'), 'anon no lee');
reset role;
select 'urpi_report: ok' as resultado;
