\set ON_ERROR_STOP on
-- 0188/0189: «Recibir en oficina». Un paquete reportado «No entregado» sale de la
-- caja en custodia (también en modo 'exigir'), la custodia vuelve a la empresa,
-- la solicitud a «por asignar» y la parada reportada se conserva.
begin;
insert into organizations(id,name) values ('18800000-0000-0000-0000-000000000001','GF return smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('18800000-0000-0000-0000-000000000002','18800000-0000-0000-0000-000000000001','Store GF','gf-return.myshopify.com');
insert into auth.users(id) values ('18800000-0000-0000-0000-000000000009');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('18800000-0000-0000-0000-000000000003','18800000-0000-0000-0000-000000000001','Roy vuelta','Grupo GF Courier','18800000-0000-0000-0000-000000000009');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('18800000-0000-0000-0000-000000000020','18800000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','11:30',4000,5000,'confirmar');
insert into orders(id,store_id,shopify_order_id,name) values
 ('18800000-0000-0000-0000-000000000004','18800000-0000-0000-0000-000000000002','gf-r-1','#GR1'),
 ('18800000-0000-0000-0000-000000000005','18800000-0000-0000-0000-000000000002','gf-r-2','#GR2');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state) values
 ('18800000-0000-0000-0000-000000000006','18800000-0000-0000-0000-000000000002','propio','GR-1','18800000-0000-0000-0000-000000000004','#GR1','listo_despacho','empresa'),
 ('18800000-0000-0000-0000-000000000007','18800000-0000-0000-0000-000000000002','propio','GR-2','18800000-0000-0000-0000-000000000005','#GR2','listo_despacho','empresa');
do $$
declare v_load uuid; v_route uuid; v_item1 uuid; v_item2 uuid; v_orders uuid[]; v_order uuid;
begin
  v_load := gf_dispatch_load_open('18800000-0000-0000-0000-000000000001','18800000-0000-0000-0000-000000000003',current_date,'18800000-0000-0000-0000-000000000009');
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_load,'18800000-0000-0000-0000-000000000006','18800000-0000-0000-0000-000000000002'),
    (v_load,'18800000-0000-0000-0000-000000000007','18800000-0000-0000-0000-000000000002');
  v_orders := gf_assign_custody(v_load,'18800000-0000-0000-0000-000000000009');
  select delivery_route_id into v_route from dispatch_manifests where id=v_load;
  select id into v_item1 from dispatch_manifest_items where manifest_id=v_load and shipment_id='18800000-0000-0000-0000-000000000006';
  select id into v_item2 from dispatch_manifest_items where manifest_id=v_load and shipment_id='18800000-0000-0000-0000-000000000007';
  -- Desde aquí, modo 'exigir': antes de 0188 el guard no dejaba sacar nada.
  update logistics_providers set rider_pickup_mode='exigir' where id='18800000-0000-0000-0000-000000000020';
  update delivery_stops set status='no_entregado', outcome_reason='direccion_errada', reported_at=now()
   where route_id=v_route and shipment_id='18800000-0000-0000-0000-000000000006';

  -- Una parada sin reporte «No entregado» no se recibe en oficina.
  begin
    perform gf_return_to_office(v_item2,'18800000-0000-0000-0000-000000000009');
    raise exception 'FAIL returned a pending stop';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  -- Un UPDATE suelto sigue bloqueado en exigir.
  begin
    update dispatch_manifest_items set removed_at=now() where id=v_item1;
    raise exception 'FAIL loose update allowed';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  v_order := gf_return_to_office(v_item1,'18800000-0000-0000-0000-000000000009');
  if v_order <> '18800000-0000-0000-0000-000000000004' then raise exception 'order not returned'; end if;
  if (select removed_at from dispatch_manifest_items where id=v_item1) is null then raise exception 'item not removed'; end if;
  if (select custody_state from shipments where id='18800000-0000-0000-0000-000000000006') <> 'empresa' then raise exception 'custody not back'; end if;
  if (select status from delivery_stops where route_id=v_route and shipment_id='18800000-0000-0000-0000-000000000006') <> 'no_entregado' then raise exception 'stop evidence lost'; end if;
  if not exists (select 1 from order_events where order_id=v_order and kind='returned_to_office' and note like 'No entregado por Roy vuelta (direccion_errada)%') then raise exception 'event missing'; end if;
  -- El otro paquete sigue en la caja (hasta que se reporte y reciba abajo).
  if (select removed_at from dispatch_manifest_items where id=v_item2) is not null then raise exception 'other item touched'; end if;
  -- 0189: un rechazo recibido en oficina queda devuelto, no vuelve a la cola.
  update delivery_stops set status='no_entregado', outcome_reason='rechazado', reported_at=now()
   where route_id=v_route and shipment_id='18800000-0000-0000-0000-000000000007';
  perform gf_return_to_office(v_item2,'18800000-0000-0000-0000-000000000009');
  if (select custody_state from shipments where id='18800000-0000-0000-0000-000000000007') <> 'devuelto' then raise exception 'rejected not marked returned'; end if;
  if (select returned_at from shipments where id='18800000-0000-0000-0000-000000000007') is null then raise exception 'rejected without returned_at'; end if;
  if not exists (select 1 from order_events where order_id='18800000-0000-0000-0000-000000000005' and kind='returned_to_office' and note like '%no se reprograma%') then raise exception 'rejected note missing'; end if;

  -- Dos veces: ya no está en la caja.
  begin
    perform gf_return_to_office(v_item1,'18800000-0000-0000-0000-000000000009');
    raise exception 'FAIL returned twice';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
end $$;
rollback;
