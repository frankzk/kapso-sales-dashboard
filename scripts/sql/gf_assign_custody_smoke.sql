\set ON_ERROR_STOP on
-- 0175: la verificación del motorizado es un flag. Con true, la custodia solo
-- cambia al recibir; con false, basta con asignar y el cotejo posterior se
-- registra igual.
begin;
insert into organizations(id,name) values ('17500000-0000-0000-0000-000000000001','GF custody smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('17500000-0000-0000-0000-000000000002','17500000-0000-0000-0000-000000000001','Store GF','gf-custody.myshopify.com');
insert into auth.users(id) values ('17500000-0000-0000-0000-000000000009');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('17500000-0000-0000-0000-000000000003','17500000-0000-0000-0000-000000000001','Roy custody','Grupo GF Courier','17500000-0000-0000-0000-000000000009');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_check_required) values
 ('17500000-0000-0000-0000-000000000020','17500000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','11:30',4000,5000,true);
insert into orders(id,store_id,shopify_order_id,name) values
 ('17500000-0000-0000-0000-000000000004','17500000-0000-0000-0000-000000000002','gf-c-1','#GC1');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state) values
 ('17500000-0000-0000-0000-000000000006','17500000-0000-0000-0000-000000000002','propio','GC-1','17500000-0000-0000-0000-000000000004','#GC1','listo_despacho','empresa');
do $$
declare v_load uuid; v_route uuid;
begin
  v_load := gf_dispatch_load('17500000-0000-0000-0000-000000000001','17500000-0000-0000-0000-000000000003',current_date,null);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_load,'17500000-0000-0000-0000-000000000006','17500000-0000-0000-0000-000000000002');
  -- flag = true: asignar no entrega la custodia.
  begin
    perform gf_assign_custody(v_load,'17500000-0000-0000-0000-000000000009');
    raise exception 'FAIL custody granted with flag on';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  if (select state from dispatch_manifests where id=v_load) <> 'draft' then raise exception 'state moved with flag on'; end if;
  -- flag = false: basta con asignar.
  update logistics_providers set rider_pickup_check_required=false where id='17500000-0000-0000-0000-000000000020';
  perform gf_assign_custody(v_load,'17500000-0000-0000-0000-000000000009');
  if (select state from dispatch_manifests where id=v_load) <> 'in_custody' then raise exception 'custody not granted with flag off'; end if;
  if (select custody_state from shipments where id='17500000-0000-0000-0000-000000000006') <> 'courier' then raise exception 'shipment custody not moved'; end if;
  select delivery_route_id into v_route from dispatch_manifests where id=v_load;
  if (select count(*) from delivery_stops where route_id=v_route) <> 1 then raise exception 'stop not created'; end if;
  if (select status from delivery_routes where id=v_route) <> 'en_curso' then raise exception 'route not visible to rider'; end if;
  if not exists (select 1 from order_events where order_id='17500000-0000-0000-0000-000000000004' and kind='custody_transferred' and note like 'Custodia al asignar%') then raise exception 'event missing'; end if;
  -- Idempotente.
  perform gf_assign_custody(v_load,'17500000-0000-0000-0000-000000000009');
  -- El cotejo de oficina posterior se registra igual (opcional, no bloquea).
  update dispatch_manifest_items set office_checked_at=now() where manifest_id=v_load;
  -- Pero la pertenencia no se altera desde el guard.
  begin
    update dispatch_manifest_items set removed_at=now(), removal_reason='x' where manifest_id=v_load;
    raise exception 'FAIL membership changed in custody';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
end;
$$;
rollback;
