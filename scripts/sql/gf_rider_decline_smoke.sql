\set ON_ERROR_STOP on
-- 0174: «No lo recojo». Un rechazo retira el paquete de la carga, deja rastro,
-- libera la salida para otra caja y la custodia pasa con los aceptados.
begin;
insert into organizations(id,name) values ('17400000-0000-0000-0000-000000000001','GF decline smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('17400000-0000-0000-0000-000000000002','17400000-0000-0000-0000-000000000001','Store GF','gf-decline.myshopify.com');
insert into auth.users(id) values ('17400000-0000-0000-0000-000000000009'),('17400000-0000-0000-0000-000000000010');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('17400000-0000-0000-0000-000000000003','17400000-0000-0000-0000-000000000001','Roy smoke','Grupo GF Courier','17400000-0000-0000-0000-000000000009'),
 ('17400000-0000-0000-0000-000000000013','17400000-0000-0000-0000-000000000001','Yhoni smoke','Grupo GF Courier','17400000-0000-0000-0000-000000000010');
insert into orders(id,store_id,shopify_order_id,name) values
 ('17400000-0000-0000-0000-000000000004','17400000-0000-0000-0000-000000000002','gf-d-1','#GD1'),
 ('17400000-0000-0000-0000-000000000005','17400000-0000-0000-0000-000000000002','gf-d-2','#GD2');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state) values
 ('17400000-0000-0000-0000-000000000006','17400000-0000-0000-0000-000000000002','propio','GD-1','17400000-0000-0000-0000-000000000004','#GD1','listo_despacho','empresa'),
 ('17400000-0000-0000-0000-000000000007','17400000-0000-0000-0000-000000000002','propio','GD-2','17400000-0000-0000-0000-000000000005','#GD2','listo_despacho','empresa');
do $$
declare v_load uuid; v_other uuid; v_route uuid;
begin
  v_load := gf_dispatch_load('17400000-0000-0000-0000-000000000001','17400000-0000-0000-0000-000000000003',current_date,null);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_load,'17400000-0000-0000-0000-000000000006','17400000-0000-0000-0000-000000000002'),
    (v_load,'17400000-0000-0000-0000-000000000007','17400000-0000-0000-0000-000000000002');
  -- Antes del cotejo de oficina no se puede rechazar.
  begin
    perform gf_rider_decline(v_load,'17400000-0000-0000-0000-000000000007','dañado','17400000-0000-0000-0000-000000000009');
    raise exception 'FAIL decline before office check';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  update dispatch_manifest_items set office_checked_at=now() where manifest_id=v_load;
  update dispatch_manifests set state='ready_for_pickup' where id=v_load;
  -- Otro usuario no puede rechazar por Roy.
  begin
    perform gf_rider_decline(v_load,'17400000-0000-0000-0000-000000000007','dañado','17400000-0000-0000-0000-000000000010');
    raise exception 'FAIL decline by another user';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Roy rechaza el segundo: sale de la carga, con rastro y evento.
  perform gf_rider_decline(v_load,'17400000-0000-0000-0000-000000000007','no estaba en la caja','17400000-0000-0000-0000-000000000009');
  if (select count(*) from dispatch_manifest_items where manifest_id=v_load and removed_at is null) <> 1 then raise exception 'declined item still active'; end if;
  if (select pickup_declined_reason from dispatch_manifest_items where manifest_id=v_load and shipment_id='17400000-0000-0000-0000-000000000007') <> 'no estaba en la caja' then raise exception 'reason lost'; end if;
  if not exists (select 1 from order_events where order_id='17400000-0000-0000-0000-000000000005' and kind='pickup_declined') then raise exception 'order event missing'; end if;
  -- Recibe el primero: con uno aceptado y uno rechazado, la custodia pasa (100 % sobre los aceptados).
  perform gf_rider_receive(v_load,'GD-1','17400000-0000-0000-0000-000000000009');
  if (select state from dispatch_manifests where id=v_load) <> 'in_custody' then raise exception 'custody did not pass with declined item'; end if;
  select delivery_route_id into v_route from dispatch_manifests where id=v_load;
  if (select count(*) from delivery_stops where route_id=v_route) <> 1 then raise exception 'declined package became a stop'; end if;
  -- El paquete rechazado queda libre para la caja de Yhoni el mismo día.
  v_other := gf_dispatch_load('17400000-0000-0000-0000-000000000001','17400000-0000-0000-0000-000000000013',current_date,null);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_other,'17400000-0000-0000-0000-000000000007','17400000-0000-0000-0000-000000000002');
end;
$$;
rollback;
