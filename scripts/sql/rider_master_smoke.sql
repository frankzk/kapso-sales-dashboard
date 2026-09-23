-- Master para el motorizado (0186): un motorizado lee del Master solo los
-- pedidos que son paradas de SUS rutas en curso o cerradas. Reusa la org, las
-- tiendas y los pedidos de rls_smoke.sql (A1, A2 en Store A) y los motorizados
-- E y F de sheets_rider_smoke.sql.

insert into order_master(store_id,order_id,shopify_order_id,order_name,customer_name)
select o.store_id, o.id, o.shopify_order_id, '#'||o.shopify_order_id, 'Cliente '||o.shopify_order_id
  from orders o where o.shopify_order_id in ('A1','A2','B1')
on conflict (order_id) do nothing;

-- E lleva A1 en una ruta en curso; F llevó A2 en una ruta cerrada; nadie lleva
-- B1. Una ruta planificada de E con B1 no cuenta: todavía no es suya.
insert into delivery_routes(id,org_id,store_id,rider_id,route_date,status) values
  ('a0000000-0000-0000-0000-00000000000e','33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','2026-09-16','en_curso'),
  ('a0000000-0000-0000-0000-00000000000f','33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ffffffff-ffff-ffff-ffff-ffffffffffff','2026-09-15','cerrada'),
  ('a0000000-0000-0000-0000-0000000000e2','33333333-3333-3333-3333-333333333333','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','2026-09-17','planificada')
on conflict do nothing;

insert into delivery_stops(route_id,order_id,store_id,seq)
select 'a0000000-0000-0000-0000-00000000000e'::uuid, o.id, o.store_id, 1 from orders o where o.shopify_order_id='A1'
union all
select 'a0000000-0000-0000-0000-00000000000f'::uuid, o.id, o.store_id, 1 from orders o where o.shopify_order_id='A2'
union all
select 'a0000000-0000-0000-0000-0000000000e2'::uuid, o.id, o.store_id, 1 from orders o where o.shopify_order_id='B1'
on conflict do nothing;

\echo '  rider E: order_master=1 (A1, su ruta en curso); ni A2 (de F) ni B1 (planificada)'
set request.test_uid = '00000000-0000-0000-0000-00000000000e';
set role authenticated;
do $$ begin
  if (select count(*) from order_master) <> 1 then raise exception 'E: expected 1 order_master row, saw %', (select count(*) from order_master); end if;
  if (select shopify_order_id from order_master) <> 'A1' then raise exception 'E: ve un pedido ajeno'; end if;
end $$;
reset role;

\echo '  rider F: order_master=1 (A2, su ruta cerrada)'
set request.test_uid = '00000000-0000-0000-0000-00000000000f';
set role authenticated;
do $$ begin
  if (select count(*) from order_master) <> 1 then raise exception 'F: expected 1 order_master row, saw %', (select count(*) from order_master); end if;
  if (select shopify_order_id from order_master) <> 'A2' then raise exception 'F: ve un pedido ajeno'; end if;
end $$;
reset role;

\echo '  owner C: sigue viendo los 3 del Master; viewer D sin grant: 0'
set request.test_uid = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
do $$ begin
  if (select count(*) from order_master) <> 3 then raise exception 'C: expected 3, saw %', (select count(*) from order_master); end if;
end $$;
reset role;
set request.test_uid = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
do $$ begin
  if (select count(*) from order_master) <> 0 then raise exception 'D: expected 0, saw %', (select count(*) from order_master); end if;
end $$;
reset role;
