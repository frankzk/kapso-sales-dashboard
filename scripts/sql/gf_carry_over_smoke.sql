\set ON_ERROR_STOP on
-- 0234: el reprogramado que el motorizado conserva pasa a su ruta siguiente, ya
-- cotejado (MOM §29.7). Sale de la caja anterior con rastro, entra en una carga
-- adicional en custodia y nace su parada pendiente; lo demás no pasa.
begin;
insert into organizations(id,name) values ('23300000-0000-0000-0000-000000000001','GF carry smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('23300000-0000-0000-0000-000000000002','23300000-0000-0000-0000-000000000001','Store GF','gf-carry.myshopify.com');
insert into auth.users(id) values ('23300000-0000-0000-0000-000000000009');
insert into riders(id,org_id,full_name,courier) values
 ('23300000-0000-0000-0000-000000000003','23300000-0000-0000-0000-000000000001','Alexis prueba','Grupo GF Courier');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('23300000-0000-0000-0000-000000000020','23300000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','11:30',4000,5000,'confirmar');
insert into orders(id,store_id,shopify_order_id,name) values
 ('23300000-0000-0000-0000-000000000004','23300000-0000-0000-0000-000000000002','gf-c-1','#GC1'),
 ('23300000-0000-0000-0000-000000000005','23300000-0000-0000-0000-000000000002','gf-c-2','#GC2'),
 ('23300000-0000-0000-0000-000000000006','23300000-0000-0000-0000-000000000002','gf-c-3','#GC3'),
 ('23300000-0000-0000-0000-000000000007','23300000-0000-0000-0000-000000000002','gf-c-4','#GC4');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state) values
 ('23300000-0000-0000-0000-000000000014','23300000-0000-0000-0000-000000000002','propio','GC-1','23300000-0000-0000-0000-000000000004','#GC1','listo_despacho','empresa'),
 ('23300000-0000-0000-0000-000000000015','23300000-0000-0000-0000-000000000002','propio','GC-2','23300000-0000-0000-0000-000000000005','#GC2','listo_despacho','empresa'),
 ('23300000-0000-0000-0000-000000000016','23300000-0000-0000-0000-000000000002','propio','GC-3','23300000-0000-0000-0000-000000000006','#GC3','listo_despacho','empresa'),
 ('23300000-0000-0000-0000-000000000017','23300000-0000-0000-0000-000000000002','propio','GC-4','23300000-0000-0000-0000-000000000007','#GC4','listo_despacho','empresa');
do $$
declare
  v_ayer date := current_date - 1;
  v_load1 uuid; v_route1 uuid; v_load2 uuid; v_route2 uuid; v_load3 uuid; v_orders uuid[];
  v_actor uuid := '23300000-0000-0000-0000-000000000009';
  v_rider uuid := '23300000-0000-0000-0000-000000000003';
begin
  v_load1 := gf_dispatch_load_open('23300000-0000-0000-0000-000000000001', v_rider, v_ayer, v_actor);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_load1,'23300000-0000-0000-0000-000000000014','23300000-0000-0000-0000-000000000002'),
    (v_load1,'23300000-0000-0000-0000-000000000015','23300000-0000-0000-0000-000000000002'),
    (v_load1,'23300000-0000-0000-0000-000000000016','23300000-0000-0000-0000-000000000002');
  v_orders := gf_assign_custody(v_load1, v_actor);
  select delivery_route_id into v_route1 from dispatch_manifests where id = v_load1;
  -- La caja ya salió; desde aquí, verificación «exigir» como en producción.
  update logistics_providers set rider_pickup_mode='exigir' where id='23300000-0000-0000-0000-000000000020';
  update delivery_stops set status='no_entregado', outcome_reason='reprogramado', reported_at=now()
   where route_id=v_route1 and shipment_id in ('23300000-0000-0000-0000-000000000014','23300000-0000-0000-0000-000000000016');
  update delivery_stops set status='no_entregado', outcome_reason='no_contesta', reported_at=now()
   where route_id=v_route1 and shipment_id='23300000-0000-0000-0000-000000000015';
  update orders set cancelled_at=now() where id='23300000-0000-0000-0000-000000000006';

  -- «No contesta» vuelve a la oficina: no pasa.
  begin
    perform gf_carry_over(v_rider, current_date, array['23300000-0000-0000-0000-000000000015']::uuid[], v_actor);
    raise exception 'FAIL carried a no_contesta';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Anulado en Shopify: va a devolución, no pasa.
  begin
    perform gf_carry_over(v_rider, current_date, array['23300000-0000-0000-0000-000000000016']::uuid[], v_actor);
    raise exception 'FAIL carried a cancelled order';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Si uno de la lista no puede pasar, no pasa ninguno.
  begin
    perform gf_carry_over(v_rider, current_date, array['23300000-0000-0000-0000-000000000014','23300000-0000-0000-0000-000000000015']::uuid[], v_actor);
    raise exception 'FAIL partial carry';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  if (select removed_at from dispatch_manifest_items where manifest_id=v_load1 and shipment_id='23300000-0000-0000-0000-000000000014') is not null then
    raise exception 'partial carry left a trace';
  end if;

  -- El reprogramado pasa (repetido en la lista cuenta una vez).
  v_load2 := gf_carry_over(v_rider, current_date,
    array['23300000-0000-0000-0000-000000000014','23300000-0000-0000-0000-000000000014']::uuid[], v_actor);
  select delivery_route_id into v_route2 from dispatch_manifests where id = v_load2;
  if v_route2 is null or v_route2 = v_route1 then raise exception 'no route for today'; end if;
  if (select state from dispatch_manifests where id=v_load2) <> 'in_custody' then raise exception 'new load not in custody'; end if;
  if (select status from delivery_routes where id=v_route2) <> 'en_curso' then raise exception 'route not en_curso'; end if;
  if (select removal_reason from dispatch_manifest_items where manifest_id=v_load1 and shipment_id='23300000-0000-0000-0000-000000000014')
     not like 'Reprogramado el %: Alexis prueba se quedó con el paquete y sale en su ruta del %, ya cotejado.' then
    raise exception 'old item not removed with reason';
  end if;
  if not exists (select 1 from dispatch_manifest_items where manifest_id=v_load2 and shipment_id='23300000-0000-0000-0000-000000000014'
                 and removed_at is null and office_checked_at is not null and pickup_checked_at is not null) then
    raise exception 'new item not checked twice';
  end if;
  if not exists (select 1 from dispatch_events where manifest_id=v_load1 and kind='carried_over'
                 and (payload->>'to_route_date')::date = current_date and payload->>'to_manifest_id' = v_load2::text) then
    raise exception 'carried_over event missing';
  end if;
  if not exists (select 1 from order_events where order_id='23300000-0000-0000-0000-000000000004' and kind='package_removed'
                 and (payload->>'carried_over')::boolean and occurred_at < now()) then
    raise exception 'package_removed event missing';
  end if;
  if not exists (select 1 from order_events where order_id='23300000-0000-0000-0000-000000000004' and kind='custody_transferred'
                 and note like 'Paquete cotejado y recibido%') then
    raise exception 'custody event missing';
  end if;
  if (select status from delivery_stops where route_id=v_route2 and order_id='23300000-0000-0000-0000-000000000004'
      and dispatch_manifest_id=v_load2) <> 'pendiente' then
    raise exception 'pending stop not created';
  end if;
  -- La parada de ayer se conserva: es la evidencia del intento.
  if (select status from delivery_stops where route_id=v_route1 and order_id='23300000-0000-0000-0000-000000000004') <> 'no_entregado' then
    raise exception 'previous stop lost';
  end if;
  if (select custody_state from shipments where id='23300000-0000-0000-0000-000000000014') <> 'courier' then
    raise exception 'custody not with the rider';
  end if;
  -- El otro reprogramado anulado y el «no contesta» siguen en la caja de ayer.
  if (select count(*) from dispatch_manifest_items where manifest_id=v_load1 and removed_at is null) <> 2 then
    raise exception 'other items touched';
  end if;
  -- Dos veces al mismo día: ya tiene parada allí.
  begin
    perform gf_carry_over(v_rider, current_date, array['23300000-0000-0000-0000-000000000014']::uuid[], v_actor);
    raise exception 'FAIL carried twice';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Vuelve a reprogramarse, pero mañana Despacho ya está armando su caja: no se
  -- mete en ella ni se la pasa a custodia a medio cotejar.
  update delivery_stops set status='no_entregado', outcome_reason='reprogramado', reported_at=now()
   where route_id=v_route2 and order_id='23300000-0000-0000-0000-000000000004';
  v_load3 := gf_dispatch_load_open('23300000-0000-0000-0000-000000000001', v_rider, current_date + 1, v_actor);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_load3,'23300000-0000-0000-0000-000000000017','23300000-0000-0000-0000-000000000002');
  begin
    perform gf_carry_over(v_rider, current_date + 1, array['23300000-0000-0000-0000-000000000014']::uuid[], v_actor);
    raise exception 'FAIL carried into a box being built';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Despacho está armando la carga de Alexis prueba del %' then raise; end if;
  end;
  if (select state from dispatch_manifests where id=v_load3) = 'in_custody' then raise exception 'draft box finalized'; end if;

  -- La importación de la hoja guarda fotos, lectura y plan; aplicada exige fecha.
  insert into rider_notebook_imports(org_id, rider_id, route_date, route_id, photo_paths, transcription, plan, created_by)
  values ('23300000-0000-0000-0000-000000000001', v_rider, current_date, v_route2, array['org/x.jpg'], '{"lines":[]}', '[]', v_actor);
  begin
    insert into rider_notebook_imports(org_id, rider_id, route_date, status, created_by)
    values ('23300000-0000-0000-0000-000000000001', v_rider, current_date, 'aplicada', v_actor);
    raise exception 'FAIL applied without applied_at';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
end $$;
rollback;
