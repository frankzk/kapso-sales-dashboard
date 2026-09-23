\set ON_ERROR_STOP on
-- 0184: con el flag apagado, dos asignaciones el mismo día → una carga, una
-- ruta, N paradas sin duplicar; con el flag encendido, carga adicional.
begin;
insert into organizations(id,name) values ('17600000-0000-0000-0000-000000000001','GF one-load smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('17600000-0000-0000-0000-000000000002','17600000-0000-0000-0000-000000000001','Store GF','gf-oneload.myshopify.com');
insert into auth.users(id) values ('17600000-0000-0000-0000-000000000009');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('17600000-0000-0000-0000-000000000003','17600000-0000-0000-0000-000000000001','Roy oneload','Grupo GF Courier','17600000-0000-0000-0000-000000000009');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('17600000-0000-0000-0000-000000000020','17600000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','11:30',4000,5000,'ninguno');
insert into orders(id,store_id,shopify_order_id,name) values
 ('17600000-0000-0000-0000-000000000004','17600000-0000-0000-0000-000000000002','gf-o-1','#GO1'),
 ('17600000-0000-0000-0000-000000000005','17600000-0000-0000-0000-000000000002','gf-o-2','#GO2'),
 ('17600000-0000-0000-0000-000000000010','17600000-0000-0000-0000-000000000002','gf-o-3','#GO3');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state) values
 ('17600000-0000-0000-0000-000000000006','17600000-0000-0000-0000-000000000002','propio','GO-1','17600000-0000-0000-0000-000000000004','#GO1','listo_despacho','empresa'),
 ('17600000-0000-0000-0000-000000000007','17600000-0000-0000-0000-000000000002','propio','GO-2','17600000-0000-0000-0000-000000000005','#GO2','listo_despacho','empresa'),
 ('17600000-0000-0000-0000-000000000011','17600000-0000-0000-0000-000000000002','propio','GO-3','17600000-0000-0000-0000-000000000010','#GO3','listo_despacho','empresa');
do $$
declare v_first uuid; v_again uuid; v_route uuid; v_order uuid; v_second uuid;
begin
  -- Primera asignación del día: carga nueva + custodia al asignar.
  v_first := gf_dispatch_load_open('17600000-0000-0000-0000-000000000001','17600000-0000-0000-0000-000000000003',current_date,'17600000-0000-0000-0000-000000000009');
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_first,'17600000-0000-0000-0000-000000000006','17600000-0000-0000-0000-000000000002');
  perform gf_assign_custody(v_first,'17600000-0000-0000-0000-000000000009');
  select delivery_route_id into v_route from dispatch_manifests where id=v_first;
  -- El motorizado vuelve: segunda asignación → MISMA carga.
  v_again := gf_dispatch_load_open('17600000-0000-0000-0000-000000000001','17600000-0000-0000-0000-000000000003',current_date,'17600000-0000-0000-0000-000000000009');
  if v_again <> v_first then raise exception 'second assignment opened another load'; end if;
  v_order := gf_add_item_in_custody(v_first,'17600000-0000-0000-0000-000000000007','17600000-0000-0000-0000-000000000002','17600000-0000-0000-0000-000000000009');
  if v_order <> '17600000-0000-0000-0000-000000000005' then raise exception 'order id not returned'; end if;
  -- Idempotente por pedido: repetir no duplica parada.
  begin
    perform gf_add_item_in_custody(v_first,'17600000-0000-0000-0000-000000000007','17600000-0000-0000-0000-000000000002','17600000-0000-0000-0000-000000000009');
    raise exception 'FAIL duplicate item accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  if (select count(*) from dispatch_manifests where rider_id='17600000-0000-0000-0000-000000000003' and route_date=current_date and state<>'cancelled') <> 1 then raise exception 'more than one load'; end if;
  if (select count(*) from delivery_routes where rider_id='17600000-0000-0000-0000-000000000003' and route_date=current_date) <> 1 then raise exception 'more than one route'; end if;
  if (select count(*) from delivery_stops where route_id=v_route) <> 2 then raise exception 'stops duplicated or missing'; end if;
  if (select custody_state from shipments where id='17600000-0000-0000-0000-000000000007') <> 'courier' then raise exception 'custody not moved'; end if;
  -- El paquete sumado en custodia entra cotejado y recibido por el supervisor.
  if not exists (select 1 from dispatch_manifest_items where manifest_id=v_first and shipment_id='17600000-0000-0000-0000-000000000007' and office_checked_at is not null and pickup_checked_at is not null) then raise exception 'added item not marked as received'; end if;
  -- Flag encendido: comportamiento de siempre → carga adicional tras la custodia.
  update logistics_providers set rider_pickup_mode='exigir' where id='17600000-0000-0000-0000-000000000020';
  v_second := gf_dispatch_load_open('17600000-0000-0000-0000-000000000001','17600000-0000-0000-0000-000000000003',current_date,'17600000-0000-0000-0000-000000000009');
  if v_second = v_first then raise exception 'flag on reused a load in custody'; end if;
  begin
    perform gf_add_item_in_custody(v_first,'17600000-0000-0000-0000-000000000011','17600000-0000-0000-0000-000000000002','17600000-0000-0000-0000-000000000009');
    raise exception 'FAIL add in custody with flag on';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
end;
$$;
rollback;
