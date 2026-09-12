\set ON_ERROR_STOP on
begin;
insert into organizations(id,name) values ('15900000-0000-0000-0000-000000000001','GF smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('15900000-0000-0000-0000-000000000002','15900000-0000-0000-0000-000000000001','Store GF','gf-smoke.myshopify.com');
insert into auth.users(id) values ('15900000-0000-0000-0000-000000000009');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('15900000-0000-0000-0000-000000000003','15900000-0000-0000-0000-000000000001','Rider smoke','Grupo GF Courier','15900000-0000-0000-0000-000000000009');
insert into orders(id,store_id,shopify_order_id,name) values
 ('15900000-0000-0000-0000-000000000004','15900000-0000-0000-0000-000000000002','gf-smoke-1','#GF1'),
 ('15900000-0000-0000-0000-000000000005','15900000-0000-0000-0000-000000000002','gf-smoke-2','#GF2');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state) values
 ('15900000-0000-0000-0000-000000000006','15900000-0000-0000-0000-000000000002','propio','GF-SMOKE-1','15900000-0000-0000-0000-000000000004','#GF1','listo_despacho','empresa'),
 ('15900000-0000-0000-0000-000000000007','15900000-0000-0000-0000-000000000002','propio','GF-SMOKE-2','15900000-0000-0000-0000-000000000005','#GF2','listo_despacho','empresa');
do $$
declare v_first uuid; v_second uuid; v_route uuid; v_time timestamptz;
begin
  v_first := gf_dispatch_load('15900000-0000-0000-0000-000000000001','15900000-0000-0000-0000-000000000003',current_date,null);
  if v_first <> gf_dispatch_load('15900000-0000-0000-0000-000000000001','15900000-0000-0000-0000-000000000003',current_date,null) then raise exception 'draft not reused'; end if;
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_first,'15900000-0000-0000-0000-000000000006','15900000-0000-0000-0000-000000000002');
  begin
    perform gf_rider_receive(v_first,'GF-SMOKE-1','15900000-0000-0000-0000-000000000009');
    raise exception 'FAIL early receipt accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  update dispatch_manifest_items set office_checked_at=now() where manifest_id=v_first;
  update dispatch_manifests set state='ready_for_pickup' where id=v_first;
  begin
    perform gf_dispatch_load('15900000-0000-0000-0000-000000000001','15900000-0000-0000-0000-000000000003',current_date,null);
    raise exception 'FAIL mixed unchecked load';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    perform gf_rider_receive(v_first,'GF-SMOKE-1',null);
    raise exception 'FAIL accepted another user';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform gf_rider_receive(v_first,'GF-SMOKE-1','15900000-0000-0000-0000-000000000009');
  select delivery_route_id,custody_completed_at into v_route,v_time from dispatch_manifests where id=v_first;
  if (select count(*) from delivery_stops where route_id=v_route) <> 1 then raise exception 'missing delivery stop'; end if;
  if (select status from delivery_routes where id=v_route) <> 'en_curso' then raise exception 'route not visible to rider'; end if;
  v_second := gf_dispatch_load('15900000-0000-0000-0000-000000000001','15900000-0000-0000-0000-000000000003',current_date,null);
  if v_first=v_second then raise exception 'receipt overwritten'; end if;
  if (select delivery_route_id from dispatch_manifests where id=v_second) <> v_route then raise exception 'duplicate daily route'; end if;
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_second,'15900000-0000-0000-0000-000000000007','15900000-0000-0000-0000-000000000002');
  update dispatch_manifest_items set office_checked_at=now() where manifest_id=v_second;
  update dispatch_manifests set state='ready_for_pickup' where id=v_second;
  perform gf_rider_receive(v_second,'GF-SMOKE-2','15900000-0000-0000-0000-000000000009');
  perform finalize_dispatch_manifest(v_second,null);
  if (select count(*) from delivery_stops where route_id=v_route) <> 2 then raise exception 'stops lost or duplicated'; end if;
  if (select custody_completed_at from dispatch_manifests where id=v_first) <> v_time then raise exception 'first receipt changed'; end if;
  update delivery_routes set status='cerrada' where id=v_route;
  begin
    perform gf_dispatch_load('15900000-0000-0000-0000-000000000001','15900000-0000-0000-0000-000000000003',current_date,null);
    raise exception 'FAIL appended to settled route';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
end;
$$;
rollback;
