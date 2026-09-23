-- Liquidaciones 2 (0179): un motorizado ve solo su hoja; un owner ve todas.
-- Reusa la org y los usuarios de rls_smoke.sql (C = owner, D = viewer sin
-- grant) y añade dos motorizados con ficha y hoja propia.

insert into auth.users(id,email) values
  ('00000000-0000-0000-0000-00000000000e','rider-e@x.com'),
  ('00000000-0000-0000-0000-00000000000f','rider-f@x.com')
on conflict do nothing;

insert into memberships(user_id,org_id,role) values
  ('00000000-0000-0000-0000-00000000000e','33333333-3333-3333-3333-333333333333','motorizado'),
  ('00000000-0000-0000-0000-00000000000f','33333333-3333-3333-3333-333333333333','motorizado')
on conflict do nothing;

insert into riders(id,org_id,full_name,user_id) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','33333333-3333-3333-3333-333333333333','Rider E','00000000-0000-0000-0000-00000000000e'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff','33333333-3333-3333-3333-333333333333','Rider F','00000000-0000-0000-0000-00000000000f')
on conflict do nothing;

insert into sheet_domains(id,org_id,key,name,row_key) values
  ('d0000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','reparto_propio','Reparto propio','punto'),
  ('d0000000-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','consolidado','Consolidado','pedido')
on conflict do nothing;

insert into sheets(id,org_id,domain_id,key,name,config) values
  ('50000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','d0000000-0000-0000-0000-000000000001','reparto_rider_e','Rider E','{"rider_id":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","layout":"cuaderno"}'),
  ('50000000-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','d0000000-0000-0000-0000-000000000001','reparto_rider_f','Rider F','{"rider_id":"ffffffff-ffff-ffff-ffff-ffffffffffff","layout":"cuaderno"}'),
  ('50000000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','d0000000-0000-0000-0000-000000000002','consolidado_a','Consolidado A','{}')
on conflict do nothing;

insert into sheet_rows(sheet_id,row_key,values) values
  ('50000000-0000-0000-0000-000000000001','2026-09-16##KP1','{"fecha":"2026-09-16","pedido":"#KP1"}'),
  ('50000000-0000-0000-0000-000000000002','2026-09-16##KP2','{"fecha":"2026-09-16","pedido":"#KP2"}'),
  ('50000000-0000-0000-0000-000000000003','#KP1','{}')
on conflict do nothing;

insert into sheet_observations(org_id,sheet_id,field,external_value,kapta_value) values
  ('33333333-3333-3333-3333-333333333333','50000000-0000-0000-0000-000000000001','monto','80','89'),
  ('33333333-3333-3333-3333-333333333333','50000000-0000-0000-0000-000000000002','monto','70','89');

\echo '  rider E: sheets=1 (la suya), rows=1, observations=1'
set request.test_uid = '00000000-0000-0000-0000-00000000000e';
set role authenticated;
do $$ begin
  if not auth_is_rider_only() then raise exception 'E: debería ser solo motorizado'; end if;
  if (select count(*) from sheets) <> 1 then raise exception 'E: expected 1 sheet, saw %', (select count(*) from sheets); end if;
  if (select key from sheets) <> 'reparto_rider_e' then raise exception 'E: ve una hoja ajena'; end if;
  if (select count(*) from sheet_rows) <> 1 then raise exception 'E: expected 1 row, saw %', (select count(*) from sheet_rows); end if;
  if (select count(*) from sheet_observations) <> 1 then raise exception 'E: expected 1 observation'; end if;
  if (select count(*) from sheet_domains) < 2 then raise exception 'E: debe leer los dominios (vocabulario)'; end if;
end $$;
reset role;

\echo '  owner C: sheets=3, rows=3'
set request.test_uid = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
do $$ begin
  if auth_is_rider_only() then raise exception 'C: un owner no es solo motorizado'; end if;
  if (select count(*) from sheets) <> 3 then raise exception 'C: expected 3 sheets, saw %', (select count(*) from sheets); end if;
  if (select count(*) from sheet_rows) <> 3 then raise exception 'C: expected 3 rows'; end if;
end $$;
reset role;

\echo '  viewer D (sin grant de tienda pero miembro): sigue viendo las hojas de su org como antes (3)'
set request.test_uid = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
do $$ begin
  if auth_is_rider_only() then raise exception 'D: un viewer no es solo motorizado'; end if;
  if (select count(*) from sheets) <> 3 then raise exception 'D: expected 3 sheets'; end if;
end $$;
reset role;
