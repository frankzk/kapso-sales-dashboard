\set ON_ERROR_STOP on
-- 0196: la caja del motorizado sigue abierta mientras se coteja (modo exigir).
-- Se le suman paquetes en paralelo al cotejo de oficina y a la recepción del
-- motorizado; la custodia pasa solo con todo cotejado dos veces o con la
-- diferencia retirada. Una carga adicional solo después de la custodia.
begin;
insert into organizations(id,name) values ('19600000-0000-0000-0000-000000000001','GF caja en paralelo');
insert into stores(id,org_id,name,shopify_domain) values
 ('19600000-0000-0000-0000-000000000002','19600000-0000-0000-0000-000000000001','Store GF','gf-parallel.myshopify.com');
insert into auth.users(id) values ('19600000-0000-0000-0000-000000000009');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('19600000-0000-0000-0000-000000000003','19600000-0000-0000-0000-000000000001','Yhoni paralelo','Grupo GF Courier','19600000-0000-0000-0000-000000000009');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('19600000-0000-0000-0000-000000000020','19600000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','11:30',4000,9000,'exigir');
insert into orders(id,store_id,shopify_order_id,name) values
 ('19600000-0000-0000-0000-000000000101','19600000-0000-0000-0000-000000000002','gf-p-1','#GP1'),
 ('19600000-0000-0000-0000-000000000102','19600000-0000-0000-0000-000000000002','gf-p-2','#GP2'),
 ('19600000-0000-0000-0000-000000000103','19600000-0000-0000-0000-000000000002','gf-p-3','#GP3'),
 ('19600000-0000-0000-0000-000000000104','19600000-0000-0000-0000-000000000002','gf-p-4','#GP4'),
 ('19600000-0000-0000-0000-000000000105','19600000-0000-0000-0000-000000000002','gf-p-5','#GP5'),
 ('19600000-0000-0000-0000-000000000106','19600000-0000-0000-0000-000000000002','gf-p-6','#GP6');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state) values
 ('19600000-0000-0000-0000-000000000201','19600000-0000-0000-0000-000000000002','propio','GP-1','19600000-0000-0000-0000-000000000101','#GP1','listo_despacho','empresa'),
 ('19600000-0000-0000-0000-000000000202','19600000-0000-0000-0000-000000000002','propio','GP-2','19600000-0000-0000-0000-000000000102','#GP2','listo_despacho','empresa'),
 ('19600000-0000-0000-0000-000000000203','19600000-0000-0000-0000-000000000002','propio','GP-3','19600000-0000-0000-0000-000000000103','#GP3','listo_despacho','empresa'),
 ('19600000-0000-0000-0000-000000000204','19600000-0000-0000-0000-000000000002','propio','GP-4','19600000-0000-0000-0000-000000000104','#GP4','listo_despacho','empresa'),
 ('19600000-0000-0000-0000-000000000205','19600000-0000-0000-0000-000000000002','propio','GP-5','19600000-0000-0000-0000-000000000105','#GP5','listo_despacho','empresa'),
 ('19600000-0000-0000-0000-000000000206','19600000-0000-0000-0000-000000000002','propio','GP-6','19600000-0000-0000-0000-000000000106','#GP6','listo_despacho','empresa');
do $$
declare
  c_org constant uuid := '19600000-0000-0000-0000-000000000001';
  c_store constant uuid := '19600000-0000-0000-0000-000000000002';
  c_rider constant uuid := '19600000-0000-0000-0000-000000000003';
  c_user constant uuid := '19600000-0000-0000-0000-000000000009';
  v_box uuid; v_again uuid; v_box2 uuid; v_route uuid; v_done uuid[];
begin
  -- 1) La caja del día nace en borrador con dos paquetes.
  v_box := gf_dispatch_load_open(c_org, c_rider, current_date, c_user);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_box,'19600000-0000-0000-0000-000000000201',c_store),
    (v_box,'19600000-0000-0000-0000-000000000202',c_store);

  -- 2) Oficina empieza a cotejar (la app recalcula el estado a cotejo de oficina).
  update dispatch_manifest_items set office_checked_at=now() where manifest_id=v_box and shipment_id='19600000-0000-0000-0000-000000000201';
  update dispatch_manifests set state='office_check' where id=v_box;

  -- 3) EN PARALELO se suma un tercero: misma caja, sin error. Antes: «La carga
  --    ya inició el cotejo» / «Termina de verificar y recibir la carga actual».
  v_again := gf_dispatch_load_open(c_org, c_rider, current_date, c_user);
  if v_again <> v_box then raise exception 'FAIL: during office check a new load was opened'; end if;
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_box,'19600000-0000-0000-0000-000000000203',c_store);
  if (select count(*) from dispatch_manifests where rider_id=c_rider and route_date=current_date and state<>'cancelled') <> 1 then
    raise exception 'FAIL: more than one load for the day';
  end if;

  -- 4) Oficina termina: la caja queda lista para el motorizado.
  update dispatch_manifest_items set office_checked_at=now() where manifest_id=v_box and office_checked_at is null;
  update dispatch_manifests set state='ready_for_pickup', office_completed_at=now() where id=v_box;

  -- 5) El motorizado empieza a recibir.
  perform gf_rider_receive(v_box,'GP-1',c_user);
  if (select state from dispatch_manifests where id=v_box) <> 'pickup_check' then raise exception 'FAIL: receiving did not move to pickup_check'; end if;

  -- 6) Mientras recibe, se suma un cuarto: misma caja, y vuelve a cotejo de
  --    oficina SOLO por él. Lo ya cotejado y recibido no se toca.
  if gf_dispatch_load_open(c_org, c_rider, current_date, c_user) <> v_box then raise exception 'FAIL: while receiving a new load was opened'; end if;
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_box,'19600000-0000-0000-0000-000000000204',c_store);
  if (select state from dispatch_manifests where id=v_box) <> 'office_check' then raise exception 'FAIL: new package did not reopen office check'; end if;
  if (select office_completed_at from dispatch_manifests where id=v_box) is not null then raise exception 'FAIL: office still marked complete'; end if;
  if (select pickup_checked_at from dispatch_manifest_items where manifest_id=v_box and shipment_id='19600000-0000-0000-0000-000000000201') is null then
    raise exception 'FAIL: an earlier receipt was undone';
  end if;

  -- 7) Recibe lo verificado aunque haya algo sin verificar.
  perform gf_rider_receive(v_box,'GP-2',c_user);
  if (select state from dispatch_manifests where id=v_box) <> 'office_check' then raise exception 'FAIL: state hides the unverified package'; end if;

  -- 8) Lo que oficina no verificó no se recibe, y se dice por qué. Se prueba
  --    con otro paquete todavía por recibir: si fuera el último, el cierre de
  --    custodia lo frenaría por su cuenta y taparía el fallo.
  begin
    perform gf_rider_receive(v_box,'GP-4',c_user);
    raise exception 'FAIL: unverified package received';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%no lo verifica oficina%' then raise exception 'FAIL: wrong reason: %', sqlerrm; end if;
  end;
  perform gf_rider_receive(v_box,'GP-3',c_user);

  -- 9) Sin el 100 % no hay custodia ni ruta.
  if (select state from dispatch_manifests where id=v_box) = 'in_custody' then raise exception 'FAIL: custody passed with a package pending'; end if;
  if exists (select 1 from delivery_stops s join delivery_routes r on r.id=s.route_id where r.rider_id=c_rider and r.route_date=current_date) then
    raise exception 'FAIL: stops created before custody';
  end if;

  -- 10) La diferencia que no irá se retira: «No lo recojo» del sin verificar.
  --     Con todo lo demás recibido, la custodia pasa en el mismo acto.
  perform gf_rider_decline(v_box,'19600000-0000-0000-0000-000000000204','no está en la caja',c_user);
  if (select state from dispatch_manifests where id=v_box) <> 'in_custody' then raise exception 'FAIL: custody did not pass after removing the difference'; end if;
  select delivery_route_id into v_route from dispatch_manifests where id=v_box;
  if (select count(*) from delivery_stops where route_id=v_route) <> 3 then raise exception 'FAIL: expected 3 stops'; end if;
  if (select custody_state from shipments where id='19600000-0000-0000-0000-000000000204') <> 'empresa' then raise exception 'FAIL: declined package left with the rider'; end if;
  if exists (select 1 from delivery_stops where route_id=v_route and order_id='19600000-0000-0000-0000-000000000104') then
    raise exception 'FAIL: declined package became a stop';
  end if;

  -- 11) Ya salió: lo nuevo va en una carga adicional, en la misma ruta.
  v_box2 := gf_dispatch_load_open(c_org, c_rider, current_date, c_user);
  if v_box2 = v_box then raise exception 'FAIL: added to a box already in custody'; end if;
  if (select load_number from dispatch_manifests where id=v_box2) <> 2 then raise exception 'FAIL: extra load is not number 2'; end if;
  if (select delivery_route_id from dispatch_manifests where id=v_box2) <> v_route then raise exception 'FAIL: extra load outside the daily route'; end if;
  begin
    insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
      (v_box,'19600000-0000-0000-0000-000000000205',c_store);
    raise exception 'FAIL: inserted into a box in custody';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values
    (v_box2,'19600000-0000-0000-0000-000000000204',c_store),
    (v_box2,'19600000-0000-0000-0000-000000000205',c_store),
    (v_box2,'19600000-0000-0000-0000-000000000206',c_store);

  -- 12) «No lo recojo» de lo único sin verificar deja oficina completa y el
  --     estado en recepción.
  update dispatch_manifest_items set office_checked_at=now() where manifest_id=v_box2 and shipment_id in
    ('19600000-0000-0000-0000-000000000204','19600000-0000-0000-0000-000000000205');
  update dispatch_manifests set state='office_check' where id=v_box2;
  perform gf_rider_receive(v_box2,'GP-4',c_user);
  perform gf_rider_decline(v_box2,'19600000-0000-0000-0000-000000000206','dañado',c_user);
  if (select state from dispatch_manifests where id=v_box2) <> 'pickup_check' then raise exception 'FAIL: state after decline is not pickup_check'; end if;
  if (select office_completed_at from dispatch_manifests where id=v_box2) is null then raise exception 'FAIL: office not complete after decline'; end if;

  -- 13) Con un paquete sin recibir, cerrar si está completa no hace nada.
  v_done := gf_finalize_if_complete(v_box2, c_user);
  if cardinality(v_done) <> 0 or (select state from dispatch_manifests where id=v_box2) = 'in_custody' then
    raise exception 'FAIL: finalized an incomplete box';
  end if;

  -- 14) Oficina retira el pendiente: lo que queda está completo y la custodia
  --     pasa. Antes la caja quedaba completa y sin dueño.
  update dispatch_manifest_items set removed_at=now(), removal_reason='No irá hoy'
   where manifest_id=v_box2 and shipment_id='19600000-0000-0000-0000-000000000205';
  v_done := gf_finalize_if_complete(v_box2, c_user);
  if (select state from dispatch_manifests where id=v_box2) <> 'in_custody' then raise exception 'FAIL: complete box did not pass custody'; end if;
  if not ('19600000-0000-0000-0000-000000000104' = any(v_done)) then raise exception 'FAIL: finalize did not return the order'; end if;
  if (select count(*) from delivery_stops where route_id=v_route) <> 4 then raise exception 'FAIL: expected 4 stops after load 2'; end if;

  -- 15) Sobre una caja en custodia no hace nada.
  v_done := gf_finalize_if_complete(v_box, c_user);
  if cardinality(v_done) <> 0 then raise exception 'FAIL: finalize ran twice'; end if;
end;
$$;
rollback;
