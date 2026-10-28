\set ON_ERROR_STOP on
-- 0284: retiro previo al despacho, sin anular venta ni inventar retorno.
begin;
insert into organizations(id,name) values ('28400000-0000-0000-0000-000000000001','GF replace smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('28400000-0000-0000-0000-000000000002','28400000-0000-0000-0000-000000000001','Store GF','gf-cancel.myshopify.com');
insert into auth.users(id) values ('28400000-0000-0000-0000-000000000009');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('28400000-0000-0000-0000-000000000003','28400000-0000-0000-0000-000000000001','Alexis smoke','Grupo GF Courier','28400000-0000-0000-0000-000000000009');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('28400000-0000-0000-0000-000000000020','28400000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','12:00',4000,5000,'confirmar');
insert into logistics_service_agreements(id,provider_id,client_org_id,store_id,client_label) values
 ('28400000-0000-0000-0000-000000000021','28400000-0000-0000-0000-000000000020','28400000-0000-0000-0000-000000000001','28400000-0000-0000-0000-000000000002','Store GF');
insert into peru_districts(district_key,district,province,department,source) values
 ('zz smoke 0284','Smoke 0248','Lima','Lima','manual') on conflict do nothing;
insert into logistics_district_tariffs(id,provider_id,agreement_id,district_key,delivery_amount,rejection_amount) values
 ('28400000-0000-0000-0000-000000000022','28400000-0000-0000-0000-000000000020','28400000-0000-0000-0000-000000000021','zz smoke 0284',10,10);
insert into orders(id,store_id,shopify_order_id,name) values
 ('28400000-0000-0000-0000-000000000004','28400000-0000-0000-0000-000000000002','gf-x-1','#GX1'),
 ('28400000-0000-0000-0000-000000000005','28400000-0000-0000-0000-000000000002','gf-x-2','#GX2');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state,delivery_status) values
 -- #GX1: con solicitud de Grupo GF.
 ('28400000-0000-0000-0000-000000000006','28400000-0000-0000-0000-000000000002','propio','GX-1','28400000-0000-0000-0000-000000000004','#GX1','listo_despacho','empresa','pendiente'),
 -- #GX2: salió sin solicitud (cuaderno o antes de las solicitudes).
 ('28400000-0000-0000-0000-000000000007','28400000-0000-0000-0000-000000000002','propio','GX-2','28400000-0000-0000-0000-000000000005','#GX2','listo_despacho','empresa','pendiente');
insert into logistics_requests(id,provider_id,agreement_id,store_id,order_id,shipment_id,idempotency_key,status,district_key,tariff_id,tariff_amount,scheduled_for) values
 ('28400000-0000-0000-0000-000000000030','28400000-0000-0000-0000-000000000020','28400000-0000-0000-0000-000000000021','28400000-0000-0000-0000-000000000002',
  '28400000-0000-0000-0000-000000000004','28400000-0000-0000-0000-000000000006','smoke-0284-1','scheduled','zz smoke 0284','28400000-0000-0000-0000-000000000022',10,current_date);
update shipments set created_via='grupo_gf_courier' where id in ('28400000-0000-0000-0000-000000000006','28400000-0000-0000-0000-000000000007');
insert into gf_dispatch_programs(order_id,store_id,scheduled_for,reason) values
 ('28400000-0000-0000-0000-000000000004','28400000-0000-0000-0000-000000000002',current_date,'Programa de prueba');
create function pg_temp.reject_gf_cancel_audit() returns trigger language plpgsql as $$
begin
  if new.kind='route_output_cancelled' and current_setting('test.gf_cancel_fail',true)='on' then
    raise exception 'simulated final audit failure';
  end if;
  return new;
end;
$$;
create trigger smoke_reject_gf_cancel_audit before insert on order_events
  for each row execute function pg_temp.reject_gf_cancel_audit();
do $$
declare
  v_load uuid;
  v_store uuid := '28400000-0000-0000-0000-000000000002';
  v_order uuid := '28400000-0000-0000-0000-000000000004';
  v_other uuid := '28400000-0000-0000-0000-000000000005';
  v_shipment uuid := '28400000-0000-0000-0000-000000000006';
  v_other_shipment uuid := '28400000-0000-0000-0000-000000000007';
  v_actor uuid := '28400000-0000-0000-0000-000000000009';
begin
  if has_function_privilege('authenticated','gf_cancel_output_before_dispatch(uuid,uuid,uuid,text)','EXECUTE')
    or has_function_privilege('anon','gf_cancel_output_before_dispatch(uuid,uuid,uuid,text)','EXECUTE')
    or not has_function_privilege('service_role','gf_cancel_output_before_dispatch(uuid,uuid,uuid,text)','EXECUTE') then
    raise exception 'FAIL: RPC expuesto o sin permiso de servicio';
  end if;
  v_load := gf_dispatch_load_open('28400000-0000-0000-0000-000000000001','28400000-0000-0000-0000-000000000003',current_date,v_actor);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id,office_checked_at) values
    (v_load,v_shipment,v_store,now()),(v_load,v_other_shipment,v_store,now());
  update dispatch_manifests set state='ready_for_pickup',office_completed_at=now() where id=v_load;
  -- Lo recibió: se rechaza sin retirar solicitud, programa ni salida.
  update dispatch_manifest_items set pickup_checked_at=now() where shipment_id=v_shipment;
  begin
    perform gf_cancel_output_before_dispatch(v_order,v_shipment,v_actor,'La clienta desiste');
    raise exception 'FAIL: anuló con Lo llevo';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  if (select status from logistics_requests where shipment_id=v_shipment)<>'scheduled'
    or exists(select 1 from dispatch_manifest_items where shipment_id=v_shipment and removed_at is not null) then
    raise exception 'FAIL: rechazo modificó solicitud o caja';
  end if;
  update dispatch_manifest_items set pickup_checked_at=null where shipment_id=v_shipment;
  -- Caja ya fuera incluso si falta un timestamp de la salida.
  begin
    update dispatch_manifests set state='in_custody' where id=v_load;
    perform gf_cancel_output_before_dispatch(v_order,v_shipment,v_actor,'La clienta desiste');
    raise exception 'FAIL: anuló caja fuera';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  insert into delivery_stops(route_id,order_id,store_id,shipment_id,seq)
    select delivery_route_id,v_order,v_store,v_shipment,1 from dispatch_manifests where id=v_load;
  begin
    perform gf_cancel_output_before_dispatch(v_order,v_shipment,v_actor,'La clienta desiste');
    raise exception 'FAIL: anuló con parada';
  exception when others then if sqlerrm not like '%tiene una parada%' then raise; end if; end;
  delete from delivery_stops where shipment_id=v_shipment; -- Solo fixture, nunca el RPC.
  begin
    perform gf_cancel_output_before_dispatch(v_other,v_shipment,v_actor,'La clienta desiste');
    raise exception 'FAIL: aceptó otro pedido';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  -- Un fallo en el último evento revierte solicitud, programa, salida y retiro.
  perform set_config('test.gf_cancel_fail','on',true);
  begin
    perform gf_cancel_output_before_dispatch(v_order,v_shipment,v_actor,'La clienta desiste');
    raise exception 'FAIL: no falló auditoría';
  exception when others then if sqlerrm<>'simulated final audit failure' then raise; end if; end;
  perform set_config('test.gf_cancel_fail','off',true);
  if (select delivery_status from shipments where id=v_shipment)<>'pendiente'
    or (select status from logistics_requests where shipment_id=v_shipment)<>'scheduled'
    or not exists(select 1 from gf_dispatch_programs where order_id=v_order)
    or exists(select 1 from dispatch_manifest_items where shipment_id=v_shipment and removed_at is not null) then
    raise exception 'FAIL: escritura parcial';
  end if;
  perform gf_cancel_output_before_dispatch(v_order,v_shipment,v_actor,'La clienta desiste');
  perform gf_cancel_output_before_dispatch(v_order,v_shipment,v_actor,'La clienta desiste');
  if (select count(*) from order_events where shipment_id=v_shipment and kind='route_output_cancelled')<>1
    or (select status from logistics_requests where shipment_id=v_shipment)<>'cancelled'
    or exists(select 1 from gf_dispatch_programs where order_id=v_order)
    or (select delivery_status from shipments where id=v_shipment)<>'anulado'
    or (select cancelled_at from orders where id=v_order) is not null
    or (select custody_state from shipments where id=v_shipment)<>'empresa'
    or (select returned_at from shipments where id=v_shipment) is not null
    or not exists(select 1 from dispatch_manifest_items where shipment_id=v_shipment and removed_at is not null and office_checked_at is not null)
    or (select delivery_status from shipments where id=v_other_shipment)<>'pendiente'
    or (select state from dispatch_manifests where id=v_load)<>'ready_for_pickup' then
    raise exception 'FAIL: retiro, idempotencia, venta, historial o vecino incorrectos';
  end if;
  -- Un escaneo/asignación que llega después no revive el rótulo anulado.
  begin
    update dispatch_manifest_items set removed_at=null,removal_reason=null where shipment_id=v_shipment;
    raise exception 'FAIL: reasignó salida anulada';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  -- Aun sin caja activa, la prueba física de despacho bloquea.
  update shipments set dispatched_at=now() where id=v_other_shipment;
  begin
    perform gf_cancel_output_before_dispatch(v_other,v_other_shipment,v_actor,'La clienta desiste');
    raise exception 'FAIL: anuló salida despachada';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
end;
$$;
rollback;
