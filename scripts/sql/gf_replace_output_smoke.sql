\set ON_ERROR_STOP on
-- 0246: «Sacar con salida nueva». El motorizado todavía tiene la caja «No
-- entregado» (S01) y el pedido sale con otra salida (S02). La S01 queda en
-- devolución a su nombre; su parada ya no cambia; al recibirla vuelve a stock
-- (devuelta, con `dispatched_at`) y no vuelve a «por asignar».
begin;
insert into organizations(id,name) values ('24600000-0000-0000-0000-000000000001','GF replace smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('24600000-0000-0000-0000-000000000002','24600000-0000-0000-0000-000000000001','Store GF','gf-replace.myshopify.com');
insert into auth.users(id) values ('24600000-0000-0000-0000-000000000009');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('24600000-0000-0000-0000-000000000003','24600000-0000-0000-0000-000000000001','Alexis smoke','Grupo GF Courier','24600000-0000-0000-0000-000000000009');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('24600000-0000-0000-0000-000000000020','24600000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','12:00',4000,5000,'confirmar');
insert into logistics_service_agreements(id,provider_id,client_org_id,store_id,client_label) values
 ('24600000-0000-0000-0000-000000000021','24600000-0000-0000-0000-000000000020','24600000-0000-0000-0000-000000000001','24600000-0000-0000-0000-000000000002','Store GF');
insert into peru_districts(district_key,district,province,department,source) values
 ('zz smoke 0246','Smoke 0246','Lima','Lima','manual') on conflict do nothing;
insert into logistics_district_tariffs(id,provider_id,agreement_id,district_key,delivery_amount,rejection_amount) values
 ('24600000-0000-0000-0000-000000000022','24600000-0000-0000-0000-000000000020','24600000-0000-0000-0000-000000000021','zz smoke 0246',10,10);
insert into orders(id,store_id,shopify_order_id,name) values
 ('24600000-0000-0000-0000-000000000004','24600000-0000-0000-0000-000000000002','gf-x-1','#GX1'),
 ('24600000-0000-0000-0000-000000000005','24600000-0000-0000-0000-000000000002','gf-x-2','#GX2');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state,delivery_status) values
 -- #GX1: con solicitud de Grupo GF.
 ('24600000-0000-0000-0000-000000000006','24600000-0000-0000-0000-000000000002','propio','GX-1','24600000-0000-0000-0000-000000000004','#GX1','listo_despacho','empresa','pendiente'),
 -- #GX2: salió sin solicitud (cuaderno o antes de las solicitudes).
 ('24600000-0000-0000-0000-000000000007','24600000-0000-0000-0000-000000000002','propio','GX-2','24600000-0000-0000-0000-000000000005','#GX2','listo_despacho','empresa','pendiente');
insert into logistics_requests(id,provider_id,agreement_id,store_id,order_id,shipment_id,idempotency_key,status,district_key,tariff_id,tariff_amount,scheduled_for) values
 ('24600000-0000-0000-0000-000000000030','24600000-0000-0000-0000-000000000020','24600000-0000-0000-0000-000000000021','24600000-0000-0000-0000-000000000002',
  '24600000-0000-0000-0000-000000000004','24600000-0000-0000-0000-000000000006','smoke-0246-1','scheduled','zz smoke 0246','24600000-0000-0000-0000-000000000022',10,current_date);
do $$
declare
  v_load uuid; v_route uuid; v_item1 uuid; v_item2 uuid; v_orders uuid[]; v_res jsonb; v_order uuid;
  v_s01 uuid := '24600000-0000-0000-0000-000000000006';
  v_s02 uuid := '24600000-0000-0000-0000-000000000016';
  v_t01 uuid := '24600000-0000-0000-0000-000000000007';
  v_t02 uuid := '24600000-0000-0000-0000-000000000017';
  v_actor uuid := '24600000-0000-0000-0000-000000000009';
  v_dispatched timestamptz;
begin
  v_load := gf_dispatch_load_open('24600000-0000-0000-0000-000000000001','24600000-0000-0000-0000-000000000003',current_date,v_actor);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_load,v_s01,'24600000-0000-0000-0000-000000000002'),
    (v_load,v_t01,'24600000-0000-0000-0000-000000000002');
  v_orders := gf_assign_custody(v_load,v_actor);
  select delivery_route_id into v_route from dispatch_manifests where id=v_load;
  select id into v_item1 from dispatch_manifest_items where manifest_id=v_load and shipment_id=v_s01;
  select id into v_item2 from dispatch_manifest_items where manifest_id=v_load and shipment_id=v_t01;
  select dispatched_at into v_dispatched from shipments where id=v_s01;

  -- La S02 la crea Kapta antes de llamar.
  insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state,created_via,delivery_status)
  values (v_s02,'24600000-0000-0000-0000-000000000002','propio','GX-1B','24600000-0000-0000-0000-000000000004','#GX1','rotulo_generado','empresa','grupo_gf_courier','pendiente');

  -- Sin «No entregado» no se reemplaza.
  begin
    perform gf_replace_output(v_item1,v_s02,null,current_date+1,'motivo',v_actor);
    raise exception 'FAIL replaced a pending stop';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  update delivery_stops set status='no_entregado', outcome_reason='no_contesta', reported_at=now()
   where route_id=v_route and shipment_id in (v_s01, v_t01);

  -- Una salida de otro pedido no sirve de S02.
  begin
    perform gf_replace_output(v_item2,v_s02,null,current_date+1,'motivo',v_actor);
    raise exception 'FAIL accepted an output of another order';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  v_res := gf_replace_output(v_item1,v_s02,null,current_date+1,'Alexis no entregó GX-1',v_actor);
  if (v_res->>'order_id')::uuid <> '24600000-0000-0000-0000-000000000004' then raise exception 'wrong order %', v_res; end if;
  -- La S01 queda en devolución con el motorizado: solo cambia la custodia.
  if (select custody_state from shipments where id=v_s01) <> 'retorno' then raise exception 'S01 not in retorno'; end if;
  if (select dispatched_at from shipments where id=v_s01) is distinct from v_dispatched then raise exception 'S01 dispatched_at touched'; end if;
  if (select returned_at from shipments where id=v_s01) is not null then raise exception 'S01 marked returned'; end if;
  if (select removed_at from dispatch_manifest_items where id=v_item1) is not null then raise exception 'S01 left the box'; end if;
  -- La solicitud pasa a la S02, aceptada y con su día.
  if (select shipment_id from logistics_requests where id='24600000-0000-0000-0000-000000000030') <> v_s02 then raise exception 'request not re-pointed'; end if;
  if (select status from logistics_requests where id='24600000-0000-0000-0000-000000000030') <> 'accepted' then raise exception 'request not accepted'; end if;
  if (select scheduled_for from logistics_requests where id='24600000-0000-0000-0000-000000000030') <> current_date+1 then raise exception 'request day not set'; end if;
  if not exists (select 1 from order_events where shipment_id=v_s01 and kind='output_replaced' and payload->>'replaced_by'=v_s02::text) then raise exception 'order event missing'; end if;
  if not exists (select 1 from dispatch_events where shipment_id=v_s01 and kind='output_replaced') then raise exception 'dispatch event missing'; end if;
  if not exists (select 1 from logistics_request_events where request_id='24600000-0000-0000-0000-000000000030' and kind='output_replaced') then raise exception 'request event missing'; end if;

  -- Dos veces: ya salió con otra.
  begin
    perform gf_replace_output(v_item1,v_s02,null,current_date+1,'otra vez',v_actor);
    raise exception 'FAIL replaced twice';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'REPLACED:%' then raise exception 'expected REPLACED, got %', sqlerrm; end if;
  end;

  -- La parada de la S01 ya no cambia: ni deshacer el «No entregado» ni entregarla.
  begin
    update delivery_stops set status='pendiente', reported_at=null where route_id=v_route and shipment_id=v_s01;
    raise exception 'FAIL undo allowed on a replaced output';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    update delivery_stops set status='entregado' where route_id=v_route and shipment_id=v_s01;
    raise exception 'FAIL delivered a replaced output';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- El traspaso del cuaderno (0234) no se la lleva a la ruta siguiente.
  update delivery_stops set outcome_reason='reprogramado' where route_id=v_route and shipment_id=v_s01;
  begin
    perform gf_carry_over('24600000-0000-0000-0000-000000000003',current_date+2,array[v_s01],v_actor);
    raise exception 'FAIL carried over a replaced output';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Solo 0 de 1%' then raise exception 'expected carry-over refusal, got %', sqlerrm; end if;
  end;
  if (select removed_at from dispatch_manifest_items where id=v_item1) is not null then raise exception 'carry-over moved S01'; end if;
  -- Las demás paradas siguen libres.
  update delivery_stops set status='pendiente', reported_at=null where route_id=v_route and shipment_id=v_t01;
  update delivery_stops set status='no_entregado', outcome_reason='no_contesta', reported_at=now() where route_id=v_route and shipment_id=v_t01;

  -- #GX2 sin solicitud: Kapta abre una en `accepting` y la RPC la acepta.
  insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state,created_via,delivery_status)
  values (v_t02,'24600000-0000-0000-0000-000000000002','propio','GX-2B','24600000-0000-0000-0000-000000000005','#GX2','rotulo_generado','empresa','grupo_gf_courier','pendiente');
  -- Sin solicitud ni una que aceptar, no se reemplaza.
  begin
    perform gf_replace_output(v_item2,v_t02,null,current_date,'motivo',v_actor);
    raise exception 'FAIL replaced without a request';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  if (select custody_state from shipments where id=v_t01) <> 'courier' then raise exception 'failed replace left custody changed'; end if;
  insert into logistics_requests(id,provider_id,agreement_id,store_id,order_id,idempotency_key,status,district_key,tariff_id,tariff_amount,scheduled_for) values
   ('24600000-0000-0000-0000-000000000031','24600000-0000-0000-0000-000000000020','24600000-0000-0000-0000-000000000021','24600000-0000-0000-0000-000000000002',
    '24600000-0000-0000-0000-000000000005','smoke-0246-2','accepting','zz smoke 0246','24600000-0000-0000-0000-000000000022',10,current_date);
  perform gf_replace_output(v_item2,v_t02,'24600000-0000-0000-0000-000000000031',current_date,'Alexis no entregó GX-2',v_actor);
  if (select status from logistics_requests where id='24600000-0000-0000-0000-000000000031') <> 'accepted' then raise exception 'new request not accepted'; end if;
  if (select shipment_id from logistics_requests where id='24600000-0000-0000-0000-000000000031') <> v_t02 then raise exception 'new request not linked'; end if;

  -- Recibir la S01: vuelve a stock, no a «por asignar».
  v_order := gf_return_to_office(v_item1,v_actor);
  if v_order <> '24600000-0000-0000-0000-000000000004' then raise exception 'receive returned wrong order'; end if;
  if (select custody_state from shipments where id=v_s01) <> 'devuelto' then raise exception 'S01 not devuelto'; end if;
  if (select returned_at from shipments where id=v_s01) is null then raise exception 'S01 returned_at missing'; end if;
  if (select returned_source from shipments where id=v_s01) <> 'manual' then raise exception 'S01 returned_source'; end if;
  if (select dispatched_at from shipments where id=v_s01) is null then raise exception 'S01 dispatched_at cleared'; end if;
  if (select removed_at from dispatch_manifest_items where id=v_item1) is null then raise exception 'S01 item not removed'; end if;
  if not exists (select 1 from order_events where shipment_id=v_s01 and kind='return_received' and (payload->>'replaced')::boolean) then raise exception 'return_received missing'; end if;
  if exists (select 1 from order_events where shipment_id=v_s01 and kind='returned_to_office') then raise exception 'counted as a departure'; end if;
  -- La solicitud de la S02 no se toca.
  if (select status from logistics_requests where id='24600000-0000-0000-0000-000000000030') <> 'accepted' then raise exception 'S02 request touched'; end if;
  -- Ya recibida: su parada vuelve a ser libre (la custodia es `devuelto`).
  update delivery_stops set note='revisado' where route_id=v_route and shipment_id=v_s01;

  -- Una vez recibida, no se reemplaza.
  begin
    perform gf_replace_output(v_item1,v_s02,null,current_date,'tarde',v_actor);
    raise exception 'FAIL replaced after reception';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'RECIBIDA:%' then raise exception 'expected RECIBIDA, got %', sqlerrm; end if;
  end;
end $$;

-- El tope de cinco salidas también lo repite la base.
do $$
declare v_load uuid; v_route uuid; v_item uuid; v_orders uuid[];
  v_actor uuid := '24600000-0000-0000-0000-000000000009';
begin
  insert into orders(id,store_id,shopify_order_id,name) values
   ('24600000-0000-0000-0000-000000000040','24600000-0000-0000-0000-000000000002','gf-x-3','#GX3');
  insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state,delivery_status)
  select ('24600000-0000-0000-0000-00000000004' || n)::uuid, '24600000-0000-0000-0000-000000000002', 'propio', 'GX-3-' || n,
         '24600000-0000-0000-0000-000000000040', '#GX3', 'listo_despacho', 'empresa', case when n = 1 then 'pendiente' else 'anulado' end
    from generate_series(1, 5) n;
  v_load := gf_dispatch_load_open('24600000-0000-0000-0000-000000000001','24600000-0000-0000-0000-000000000003',current_date+1,v_actor);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_load,'24600000-0000-0000-0000-000000000041','24600000-0000-0000-0000-000000000002');
  v_orders := gf_assign_custody(v_load,v_actor);
  select delivery_route_id into v_route from dispatch_manifests where id=v_load;
  select id into v_item from dispatch_manifest_items where manifest_id=v_load;
  update delivery_stops set status='no_entregado', outcome_reason='no_contesta', reported_at=now()
   where route_id=v_route and shipment_id='24600000-0000-0000-0000-000000000041';
  insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state,delivery_status)
  values ('24600000-0000-0000-0000-000000000049','24600000-0000-0000-0000-000000000002','propio','GX-3-6','24600000-0000-0000-0000-000000000040','#GX3','rotulo_generado','empresa','pendiente');
  begin
    perform gf_replace_output(v_item,'24600000-0000-0000-0000-000000000049',null,current_date+1,'sexta',v_actor);
    raise exception 'FAIL sixth output allowed';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'TOPE:%' then raise exception 'expected TOPE, got %', sqlerrm; end if;
  end;
  if (select custody_state from shipments where id='24600000-0000-0000-0000-000000000041') = 'retorno' then raise exception 'TOPE left S01 in retorno'; end if;
end $$;
rollback;
