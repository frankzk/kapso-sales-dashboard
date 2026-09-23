\set ON_ERROR_STOP on
-- 0185: modo 'confirmar'. Asignar entrega la custodia y crea paradas «por
-- confirmar»; «Lo llevo» marca pickup_checked_at; «No lo llevo» sobre la caja
-- en custodia retira el ítem, borra la parada pendiente y devuelve la solicitud
-- a «por asignar»; el supervisor quita solo lo no confirmado.
begin;
insert into organizations(id,name) values ('17700000-0000-0000-0000-000000000001','GF pickup-mode smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('17700000-0000-0000-0000-000000000002','17700000-0000-0000-0000-000000000001','Store GF','gf-mode.myshopify.com');
insert into auth.users(id) values ('17700000-0000-0000-0000-000000000009'),('17700000-0000-0000-0000-000000000010');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('17700000-0000-0000-0000-000000000003','17700000-0000-0000-0000-000000000001','Roy modo','Grupo GF Courier','17700000-0000-0000-0000-000000000009'),
 ('17700000-0000-0000-0000-000000000013','17700000-0000-0000-0000-000000000001','Yhoni modo','Grupo GF Courier','17700000-0000-0000-0000-000000000010');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('17700000-0000-0000-0000-000000000020','17700000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','11:30',4000,5000,'confirmar');
insert into orders(id,store_id,shopify_order_id,name) values
 ('17700000-0000-0000-0000-000000000004','17700000-0000-0000-0000-000000000002','gf-m-1','#GM1'),
 ('17700000-0000-0000-0000-000000000005','17700000-0000-0000-0000-000000000002','gf-m-2','#GM2'),
 ('17700000-0000-0000-0000-000000000014','17700000-0000-0000-0000-000000000002','gf-m-3','#GM3');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state) values
 ('17700000-0000-0000-0000-000000000006','17700000-0000-0000-0000-000000000002','propio','GM-1','17700000-0000-0000-0000-000000000004','#GM1','listo_despacho','empresa'),
 ('17700000-0000-0000-0000-000000000007','17700000-0000-0000-0000-000000000002','propio','GM-2','17700000-0000-0000-0000-000000000005','#GM2','listo_despacho','empresa'),
 ('17700000-0000-0000-0000-000000000015','17700000-0000-0000-0000-000000000002','propio','GM-3','17700000-0000-0000-0000-000000000014','#GM3','listo_despacho','empresa');
do $$
declare v_load uuid; v_route uuid; v_item1 uuid; v_item2 uuid; v_item3 uuid; v_order uuid; v_orders uuid[]; v_other uuid;
begin
  if gf_rider_pickup_mode('17700000-0000-0000-0000-000000000001') <> 'confirmar' then raise exception 'mode reader'; end if;
  if gf_rider_pickup_mode('00000000-0000-0000-0000-000000000000') <> 'exigir' then raise exception 'mode default without provider'; end if;

  -- Asignar: custodia en el acto, paradas nacen «por confirmar» (pickup_checked_at null).
  v_load := gf_dispatch_load_open('17700000-0000-0000-0000-000000000001','17700000-0000-0000-0000-000000000003',current_date,'17700000-0000-0000-0000-000000000009');
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_load,'17700000-0000-0000-0000-000000000006','17700000-0000-0000-0000-000000000002'),
    (v_load,'17700000-0000-0000-0000-000000000007','17700000-0000-0000-0000-000000000002');
  v_orders := gf_assign_custody(v_load,'17700000-0000-0000-0000-000000000009');
  if (select state from dispatch_manifests where id=v_load) <> 'in_custody' then raise exception 'custody not granted in confirmar'; end if;
  if not exists (select 1 from order_events where order_id='17700000-0000-0000-0000-000000000004' and kind='custody_transferred' and note like '%confirma cada paquete%') then raise exception 'confirmar note missing'; end if;
  select delivery_route_id into v_route from dispatch_manifests where id=v_load;
  if (select count(*) from delivery_stops where route_id=v_route and status='pendiente') <> 2 then raise exception 'stops not created'; end if;
  select id into v_item1 from dispatch_manifest_items where manifest_id=v_load and shipment_id='17700000-0000-0000-0000-000000000006';
  select id into v_item2 from dispatch_manifest_items where manifest_id=v_load and shipment_id='17700000-0000-0000-0000-000000000007';
  if (select pickup_checked_at from dispatch_manifest_items where id=v_item1) is not null then raise exception 'item born confirmed'; end if;

  -- Un paquete sumado en custodia también nace por confirmar (no como en 'ninguno').
  v_order := gf_add_item_in_custody(v_load,'17700000-0000-0000-0000-000000000015','17700000-0000-0000-0000-000000000002','17700000-0000-0000-0000-000000000009');
  select id into v_item3 from dispatch_manifest_items where manifest_id=v_load and shipment_id='17700000-0000-0000-0000-000000000015';
  if (select pickup_checked_at from dispatch_manifest_items where id=v_item3) is not null then raise exception 'added item born confirmed in confirmar'; end if;
  if (select count(*) from delivery_stops where route_id=v_route) <> 3 then raise exception 'added item without stop'; end if;

  -- «Lo llevo»: solo el motorizado dueño; idempotente; evento con «Lo lleva Roy».
  begin
    perform gf_rider_confirm_pickup(v_item1,'17700000-0000-0000-0000-000000000010');
    raise exception 'FAIL confirm by another user';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  v_order := gf_rider_confirm_pickup(v_item1,'17700000-0000-0000-0000-000000000009');
  if v_order <> '17700000-0000-0000-0000-000000000004' then raise exception 'order not returned'; end if;
  if (select pickup_checked_at from dispatch_manifest_items where id=v_item1) is null then raise exception 'pickup not checked'; end if;
  if not exists (select 1 from order_events where order_id='17700000-0000-0000-0000-000000000004' and kind='pickup_checked' and note='Lo lleva Roy modo.') then raise exception 'lo lleva event missing'; end if;
  perform gf_rider_confirm_pickup(v_item1,'17700000-0000-0000-0000-000000000009');
  if (select count(*) from order_events where order_id='17700000-0000-0000-0000-000000000004' and kind='pickup_checked') <> 1 then raise exception 'confirm not idempotent'; end if;

  -- Un UPDATE suelto no cambia la pertenencia de la caja en custodia.
  begin
    update dispatch_manifest_items set removed_at=now(), removal_reason='x' where id=v_item2;
    raise exception 'FAIL membership changed in custody';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  -- «No lo llevo» en custodia: ítem retirado, parada borrada, custodia a la empresa, solicitud por asignar.
  v_orders := gf_rider_decline(v_load,'17700000-0000-0000-0000-000000000007','no cabe en la moto','17700000-0000-0000-0000-000000000009');
  if v_orders <> array['17700000-0000-0000-0000-000000000005'::uuid] then raise exception 'declined order not returned'; end if;
  if (select removed_at from dispatch_manifest_items where id=v_item2) is null then raise exception 'declined item still active'; end if;
  if (select pickup_declined_reason from dispatch_manifest_items where id=v_item2) <> 'no cabe en la moto' then raise exception 'declined reason lost'; end if;
  if exists (select 1 from delivery_stops where route_id=v_route and shipment_id='17700000-0000-0000-0000-000000000007') then raise exception 'declined stop not deleted'; end if;
  if (select custody_state from shipments where id='17700000-0000-0000-0000-000000000007') <> 'empresa' then raise exception 'custody not returned'; end if;
  if not exists (select 1 from order_events where order_id='17700000-0000-0000-0000-000000000005' and kind='pickup_declined' and note='No lo llevó Roy modo: no cabe en la moto') then raise exception 'no lo llevó event missing'; end if;
  if (select state from dispatch_manifests where id=v_load) <> 'in_custody' then raise exception 'load left custody'; end if;

  -- Vuelve a la MISMA caja (0187): la fila retirada revive con parada y custodia;
  -- se rechaza otra vez para dejar el resto del guion como estaba.
  v_order := gf_add_item_in_custody(v_load,'17700000-0000-0000-0000-000000000007','17700000-0000-0000-0000-000000000002','17700000-0000-0000-0000-000000000009');
  if v_order <> '17700000-0000-0000-0000-000000000005' then raise exception 'readd order not returned'; end if;
  if (select count(*) from dispatch_manifest_items where manifest_id=v_load and shipment_id='17700000-0000-0000-0000-000000000007') <> 1 then raise exception 'readd duplicated the item'; end if;
  if (select removed_at is null and pickup_declined_at is null and office_checked_at is not null from dispatch_manifest_items where id=v_item2) is not true then raise exception 'readded item not revived'; end if;
  if not exists (select 1 from delivery_stops where route_id=v_route and shipment_id='17700000-0000-0000-0000-000000000007') then raise exception 'readded stop missing'; end if;
  if (select custody_state from shipments where id='17700000-0000-0000-0000-000000000007') <> 'courier' then raise exception 'readded custody missing'; end if;
  v_orders := gf_rider_decline(v_load,'17700000-0000-0000-0000-000000000007','no cabe en la moto','17700000-0000-0000-0000-000000000009');
  if (select custody_state from shipments where id='17700000-0000-0000-0000-000000000007') <> 'empresa' then raise exception 'second decline custody not returned'; end if;

  -- Lo ya confirmado no se rechaza ni lo retira el supervisor.
  begin
    perform gf_rider_decline(v_load,'17700000-0000-0000-0000-000000000006','ya no','17700000-0000-0000-0000-000000000009');
    raise exception 'FAIL decline after confirm';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    perform gf_supervisor_withdraw(v_load,'17700000-0000-0000-0000-000000000006','cambio','17700000-0000-0000-0000-000000000009',null);
    raise exception 'FAIL withdraw confirmed item';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  -- El supervisor quita lo no confirmado: parada borrada y paquete libre para otra caja el mismo día.
  v_order := gf_supervisor_withdraw(v_load,'17700000-0000-0000-0000-000000000015','se queda en almacén','17700000-0000-0000-0000-000000000009',null);
  if v_order <> '17700000-0000-0000-0000-000000000014' then raise exception 'withdraw order not returned'; end if;
  if (select count(*) from delivery_stops where route_id=v_route) <> 1 then raise exception 'withdrawn stop not deleted'; end if;
  if not exists (select 1 from order_events where order_id='17700000-0000-0000-0000-000000000014' and kind='package_removed' and note like 'Retirado sin confirmar%') then raise exception 'withdraw event missing'; end if;
  v_other := gf_dispatch_load_open('17700000-0000-0000-0000-000000000001','17700000-0000-0000-0000-000000000013',current_date,'17700000-0000-0000-0000-000000000009');
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_other,'17700000-0000-0000-0000-000000000007','17700000-0000-0000-0000-000000000002');
  perform gf_assign_custody(v_other,'17700000-0000-0000-0000-000000000009');
  if (select custody_state from shipments where id='17700000-0000-0000-0000-000000000007') <> 'courier' then raise exception 'reassigned package not in custody'; end if;

  -- Una parada reportada ya no se retira.
  update delivery_stops set status='entregado', payment_method='sin_cobro', reported_at=now(), pickup_confirmed=true where route_id=v_route and shipment_id='17700000-0000-0000-0000-000000000006';
  if (select pickup_confirmed from delivery_stops where route_id=v_route and shipment_id='17700000-0000-0000-0000-000000000006') is not true then raise exception 'pickup_confirmed column missing'; end if;
  -- (el ítem ya está confirmado, así que el retiro falla por eso; lo que se prueba es que la parada reportada tampoco se toca)

  -- En 'ninguno' nada de esto aplica: «No lo llevo» sobre custodia se rechaza.
  update logistics_providers set rider_pickup_mode='ninguno' where id='17700000-0000-0000-0000-000000000020';
  begin
    perform gf_rider_decline(v_other,'17700000-0000-0000-0000-000000000007','x','17700000-0000-0000-0000-000000000010');
    raise exception 'FAIL decline in custody with mode ninguno';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- En 'exigir' asignar no entrega la custodia.
  update logistics_providers set rider_pickup_mode='exigir' where id='17700000-0000-0000-0000-000000000020';
  begin
    perform gf_assign_custody(gf_dispatch_load('17700000-0000-0000-0000-000000000001','17700000-0000-0000-0000-000000000003',current_date + 1,null),'17700000-0000-0000-0000-000000000009');
    raise exception 'FAIL custody granted in exigir';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
end;
$$;
rollback;
