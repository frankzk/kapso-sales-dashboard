\set ON_ERROR_STOP on
-- 0188/0206: «Recibir en oficina». Un paquete reportado «No entregado» sale de la
-- caja en custodia (también en modo 'exigir'), la custodia vuelve a la empresa,
-- la solicitud a «por asignar» y la parada reportada se conserva.
-- 0307 (owner, 04-11-2026): la caja de un pedido ANULADO EN LA TIENDA va a
-- inventario (custodia `devuelto`, `return_received`), no a «por asignar»; uno
-- reactivado vuelve a la cola como siempre. Dentro de un manifiesto de
-- devolución sus eventos llevan el id del manifiesto.
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
 ('18800000-0000-0000-0000-000000000005','18800000-0000-0000-0000-000000000002','gf-r-2','#GR2'),
 ('18800000-0000-0000-0000-000000000014','18800000-0000-0000-0000-000000000002','gf-r-3','#GR3'),
 ('18800000-0000-0000-0000-000000000015','18800000-0000-0000-0000-000000000002','gf-r-4','#GR4');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state) values
 ('18800000-0000-0000-0000-000000000006','18800000-0000-0000-0000-000000000002','propio','GR-1','18800000-0000-0000-0000-000000000004','#GR1','listo_despacho','empresa'),
 ('18800000-0000-0000-0000-000000000007','18800000-0000-0000-0000-000000000002','propio','GR-2','18800000-0000-0000-0000-000000000005','#GR2','listo_despacho','empresa'),
 ('18800000-0000-0000-0000-000000000016','18800000-0000-0000-0000-000000000002','propio','GR-3','18800000-0000-0000-0000-000000000014','#GR3','listo_despacho','empresa'),
 ('18800000-0000-0000-0000-000000000017','18800000-0000-0000-0000-000000000002','propio','GR-4','18800000-0000-0000-0000-000000000015','#GR4','listo_despacho','empresa');
do $$
declare v_load uuid; v_route uuid; v_item1 uuid; v_item2 uuid; v_item3 uuid; v_item4 uuid; v_orders uuid[]; v_order uuid;
begin
  v_load := gf_dispatch_load_open('18800000-0000-0000-0000-000000000001','18800000-0000-0000-0000-000000000003',current_date,'18800000-0000-0000-0000-000000000009');
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_load,'18800000-0000-0000-0000-000000000006','18800000-0000-0000-0000-000000000002'),
    (v_load,'18800000-0000-0000-0000-000000000007','18800000-0000-0000-0000-000000000002'),
    (v_load,'18800000-0000-0000-0000-000000000016','18800000-0000-0000-0000-000000000002'),
    (v_load,'18800000-0000-0000-0000-000000000017','18800000-0000-0000-0000-000000000002');
  v_orders := gf_assign_custody(v_load,'18800000-0000-0000-0000-000000000009');
  select delivery_route_id into v_route from dispatch_manifests where id=v_load;
  select id into v_item1 from dispatch_manifest_items where manifest_id=v_load and shipment_id='18800000-0000-0000-0000-000000000006';
  select id into v_item2 from dispatch_manifest_items where manifest_id=v_load and shipment_id='18800000-0000-0000-0000-000000000007';
  select id into v_item3 from dispatch_manifest_items where manifest_id=v_load and shipment_id='18800000-0000-0000-0000-000000000016';
  select id into v_item4 from dispatch_manifest_items where manifest_id=v_load and shipment_id='18800000-0000-0000-0000-000000000017';
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
  -- 0206 (v1.23): un rechazo recibido en oficina vuelve a «por asignar» como
  -- los demás motivos; ya no queda devuelto (deshace la 0189).
  update delivery_stops set status='no_entregado', outcome_reason='rechazado', reported_at=now()
   where route_id=v_route and shipment_id='18800000-0000-0000-0000-000000000007';
  perform gf_return_to_office(v_item2,'18800000-0000-0000-0000-000000000009');
  if (select custody_state from shipments where id='18800000-0000-0000-0000-000000000007') <> 'empresa' then raise exception 'rejected custody not back'; end if;
  if (select returned_at from shipments where id='18800000-0000-0000-0000-000000000007') is not null then raise exception 'rejected marked returned'; end if;
  if not exists (select 1 from order_events where order_id='18800000-0000-0000-0000-000000000005' and kind='returned_to_office' and note like 'No entregado por Roy vuelta (rechazado)%Vuelve a «por asignar».') then raise exception 'rejected note missing'; end if;

  -- 0307: pedido anulado en la tienda. La caja vuelve, pero no a «por asignar»:
  -- va a inventario (Devolución pendiente de inventario). Conserva la salida.
  update orders set cancelled_at=now() where id='18800000-0000-0000-0000-000000000014';
  update delivery_stops set status='no_entregado', outcome_reason='no_contesta', reported_at=now()
   where route_id=v_route and shipment_id='18800000-0000-0000-0000-000000000016';
  v_order := gf_return_to_office(v_item3,'18800000-0000-0000-0000-000000000009');
  if v_order <> '18800000-0000-0000-0000-000000000014' then raise exception 'cancelled order not returned'; end if;
  if (select custody_state from shipments where id='18800000-0000-0000-0000-000000000016') <> 'devuelto' then raise exception 'store-cancelled not to stock'; end if;
  if (select returned_at from shipments where id='18800000-0000-0000-0000-000000000016') is null then raise exception 'store-cancelled returned_at missing'; end if;
  if (select returned_source from shipments where id='18800000-0000-0000-0000-000000000016') <> 'manual' then raise exception 'store-cancelled source'; end if;
  if (select dispatched_at from shipments where id='18800000-0000-0000-0000-000000000016') is null then raise exception 'store-cancelled lost dispatched_at'; end if;
  if (select removal_reason from dispatch_manifest_items where id=v_item3) not like 'Pedido anulado en la tienda: recibido en oficina, va a inventario%' then raise exception 'store-cancelled removal reason'; end if;
  if not exists (select 1 from order_events where order_id=v_order and kind='return_received' and source='dispatch'
                  and actor='18800000-0000-0000-0000-000000000009' and (payload->>'store_cancelled')::boolean
                  and note like '%anulado en la tienda. Va a inventario%') then raise exception 'store-cancelled return_received missing'; end if;
  if exists (select 1 from order_events where order_id=v_order and kind='returned_to_office') then raise exception 'store-cancelled re-queued'; end if;
  if not exists (select 1 from dispatch_events where shipment_id='18800000-0000-0000-0000-000000000016' and kind='returned_to_office'
                  and (payload->>'to_stock')::boolean and (payload->>'store_cancelled')::boolean and not payload ? 'return_manifest_id') then
    raise exception 'store-cancelled dispatch event';
  end if;
  -- Reactivado (cancelled_at nulo otra vez): como siempre, vuelve a «por asignar».
  update orders set cancelled_at=now() where id='18800000-0000-0000-0000-000000000015';
  update orders set cancelled_at=null where id='18800000-0000-0000-0000-000000000015';
  update delivery_stops set status='no_entregado', outcome_reason='no_contesta', reported_at=now()
   where route_id=v_route and shipment_id='18800000-0000-0000-0000-000000000017';
  perform set_config('gf.return_manifest','18800000-0000-0000-0000-0000000000aa',true);
  perform gf_return_to_office(v_item4,'18800000-0000-0000-0000-000000000009');
  perform set_config('gf.return_manifest','',true);
  if (select custody_state from shipments where id='18800000-0000-0000-0000-000000000017') <> 'empresa' then raise exception 'reactivated not back to queue'; end if;
  if not exists (select 1 from order_events where order_id='18800000-0000-0000-0000-000000000015' and kind='returned_to_office'
                  and payload->>'return_manifest_id'='18800000-0000-0000-0000-0000000000aa') then raise exception 'manifest id not in payload'; end if;

  -- Dos veces: ya no está en la caja.
  begin
    perform gf_return_to_office(v_item1,'18800000-0000-0000-0000-000000000009');
    raise exception 'FAIL returned twice';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
end $$;
rollback;
