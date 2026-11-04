\set ON_ERROR_STOP on
-- 0307: manifiesto de devolución (fase 1, Grupo GF). Una abierta por
-- motorizado; recibir es la recepción de siempre y la línea, en una sola
-- transacción; un escaneo repetido no duplica; lo de otra caja se recibe y se
-- marca; sin reporte no se recibe; al cerrar se anotan las que faltan fuera de
-- plazo (reprogramado: más de 14 días); lo cerrado no cambia salvo añadir la
-- foto del acta; anular solo sin cajas recibidas. RLS de solo lectura.
begin;
insert into organizations(id,name) values ('30700000-0000-0000-0000-000000000001','Return manifest smoke'),
 ('30700000-0000-0000-0000-0000000000f1','Otra org');
insert into stores(id,org_id,name,shopify_domain) values
 ('30700000-0000-0000-0000-000000000002','30700000-0000-0000-0000-000000000001','RM store','rm307.myshopify.com'),
 ('30700000-0000-0000-0000-0000000000f2','30700000-0000-0000-0000-0000000000f1','Otra store','rm307b.myshopify.com');
insert into auth.users(id) values ('30700000-0000-0000-0000-000000000009'),('30700000-0000-0000-0000-0000000000f9');
insert into memberships(org_id,user_id,role) values
 ('30700000-0000-0000-0000-000000000001','30700000-0000-0000-0000-000000000009','owner'),
 ('30700000-0000-0000-0000-0000000000f1','30700000-0000-0000-0000-0000000000f9','owner');
insert into riders(id,org_id,full_name,courier) values
 ('30700000-0000-0000-0000-000000000003','30700000-0000-0000-0000-000000000001','Alexis Prueba','Grupo GF Courier'),
 ('30700000-0000-0000-0000-000000000013','30700000-0000-0000-0000-000000000001','Roy Prueba','Grupo GF Courier');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('30700000-0000-0000-0000-000000000020','30700000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','12:00',4000,5000,'confirmar');
-- n: 1 viejo (5 d) · 2 reciente (1 d) · 3 reprogramado 10 d · 4 reprogramado 20 d
--    5 de Roy · 6 anulado en la tienda · 7 sin reporte · 8 entregado · 9 viejo sin recibir
--    10 y 11 sin reporte cuya parada pendiente se borra después (oficina / Rutas)
insert into orders(id,store_id,shopify_order_id,name)
 select ('30700000-0000-0000-0000-0000000001'||lpad(n::text,2,'0'))::uuid,'30700000-0000-0000-0000-000000000002','rm-'||n,'#RM'||n
   from generate_series(1,11) n;
insert into shipments(id,store_id,courier,guide_code,output_code,order_id,order_name,preparation_state,custody_state)
 select ('30700000-0000-0000-0000-0000000002'||lpad(n::text,2,'0'))::uuid,'30700000-0000-0000-0000-000000000002','propio',
        'RM-'||n,'RM'||n||'-S01',('30700000-0000-0000-0000-0000000001'||lpad(n::text,2,'0'))::uuid,'#RM'||n,'listo_despacho','empresa'
   from generate_series(1,11) n;

do $test$
declare
  org uuid := '30700000-0000-0000-0000-000000000001';
  a uuid := '30700000-0000-0000-0000-000000000009';
  alexis uuid := '30700000-0000-0000-0000-000000000003';
  roy uuid := '30700000-0000-0000-0000-000000000013';
  rm uuid; rm2 uuid; other uuid; res jsonb; v_line uuid; v_load uuid; v_unused uuid[];
  ship uuid[] := array(select ('30700000-0000-0000-0000-0000000002'||lpad(n::text,2,'0'))::uuid from generate_series(1,11) n);
  days int[] := array[5,1,10,20,2,3,4,2,6,8,9];
  i int;
  item uuid[] := '{}';
begin
  -- Una caja por paquete y día (Roy tiene la 5).
  for i in 1..11 loop
    v_load := gf_dispatch_load_open(org, case when i = 5 then roy else alexis end, current_date - days[i], a);
    insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values (v_load, ship[i], '30700000-0000-0000-0000-000000000002');
    v_unused := gf_assign_custody(v_load, a);
    item := item || (select id from dispatch_manifest_items where manifest_id = v_load and shipment_id = ship[i]);
  end loop;
  update logistics_providers set rider_pickup_mode='exigir' where id='30700000-0000-0000-0000-000000000020';
  update delivery_stops set status='no_entregado', outcome_reason='no_contesta', reported_at=now()
   where shipment_id = any(array[ship[1],ship[2],ship[5],ship[6],ship[9]]);
  update delivery_stops set status='no_entregado', outcome_reason='reprogramado', reported_at=now()
   where shipment_id = any(array[ship[3],ship[4]]);
  update delivery_stops set status='entregado', payment_method='efectivo', collected_amount=10, reported_at=now()
   where shipment_id = ship[8];
  update orders set cancelled_at = now() where id = '30700000-0000-0000-0000-000000000106';

  -- Abrir: una por motorizado. La segunda vez devuelve la misma.
  rm := return_manifest_open(org, 'propio', alexis, a, current_date, 3);
  if return_manifest_open(org, 'propio', alexis, a, current_date, 3) <> rm then raise exception 'FAIL second open manifest'; end if;
  if (select label from return_manifests where id = rm) <> 'Devolución · Alexis · ' || to_char(current_date, 'DD/MM') then raise exception 'FAIL label'; end if;
  begin
    perform return_manifest_open(org, 'urpi', alexis, a, current_date, 14);
    raise exception 'FAIL urpi in phase 1';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    perform return_manifest_open(org, 'propio', alexis, '30700000-0000-0000-0000-0000000000f9', current_date, 3);
    raise exception 'FAIL outsider opened';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    insert into return_manifests(org_id,courier,rider_id,label,arrived_on,cadence_days,created_by)
    values (org,'propio',alexis,'dup',current_date,3,a);
    raise exception 'FAIL two open manifests';
  exception when unique_violation then null; end;

  -- Recibir lo esperado: la recepción de siempre y la línea, juntas.
  res := return_manifest_receive(rm, item[1], a, 'RM1-S01');
  if res->>'receipt_outcome' <> 'por_asignar' then raise exception 'FAIL normal outcome %', res; end if;
  if (select custody_state from shipments where id = ship[1]) <> 'empresa' then raise exception 'FAIL normal custody'; end if;
  select id into v_line from return_manifest_lines where manifest_id = rm and shipment_id = ship[1];
  if not (select expected and outcome = 'received' and dispatch_event_id is not null and flags = '{}' from return_manifest_lines where id = v_line) then
    raise exception 'FAIL received line';
  end if;
  if not exists (select 1 from order_events where shipment_id = ship[1] and kind = 'returned_to_office' and payload->>'return_manifest_id' = rm::text) then
    raise exception 'FAIL event without manifest id';
  end if;
  if not exists (select 1 from dispatch_events where id = (select dispatch_event_id from return_manifest_lines where id = v_line) and payload->>'return_manifest_id' = rm::text) then
    raise exception 'FAIL dispatch event link';
  end if;
  -- El mismo QR otra vez: ya no está en la caja; anotarlo no duplica ni pisa.
  begin
    perform return_manifest_receive(rm, item[1], a, 'RM1-S01');
    raise exception 'FAIL received twice';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform return_manifest_note(rm, a, 'RM1-S01', 'info', array['ya_recibida'], ship[1]);
  if (select count(*) from return_manifest_lines where manifest_id = rm and shipment_id = ship[1]) <> 1 then raise exception 'FAIL duplicate line'; end if;
  if (select outcome || ':' || scan_count from return_manifest_lines where id = v_line) <> 'received:2' then raise exception 'FAIL duplicate overwrote'; end if;

  -- De otra caja (Roy): se recibe y se marca; no era de lo esperado.
  res := return_manifest_receive(rm, item[5], a, 'RM5-S01');
  if not (select 'otra_caja' = any(flags) and not expected from return_manifest_lines where manifest_id = rm and shipment_id = ship[5]) then
    raise exception 'FAIL other box flag';
  end if;
  -- Anulado en la tienda: a inventario (regla del owner, 04-11-2026).
  res := return_manifest_receive(rm, item[6], a, 'RM6-S01');
  if res->>'receipt_outcome' <> 'a_inventario_anulado' then raise exception 'FAIL store-cancelled outcome %', res; end if;
  if (select custody_state from shipments where id = ship[6]) <> 'devuelto' then raise exception 'FAIL store-cancelled custody'; end if;
  -- Reprogramado reciente que llegó: se recibe con su marca.
  res := return_manifest_receive(rm, item[3], a, 'RM3-S01');
  if not (select 'reprogramado' = any(flags) from return_manifest_lines where manifest_id = rm and shipment_id = ship[3]) then raise exception 'FAIL repro flag'; end if;

  -- Sin reporte: no se recibe. Reportado «No entregado» por la vía de siempre,
  -- se recibe con la marca «sin_reporte» y no cuenta como esperado.
  begin
    perform return_manifest_receive(rm, item[7], a, 'RM7-S01');
    raise exception 'FAIL received pending stop';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    perform return_manifest_receive(rm, item[1], a, 'RM7-S01', array['otra_caja']);
    raise exception 'FAIL caller forged a flag';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  update delivery_stops set status='no_entregado', outcome_reason='otro', note='Llegó a oficina sin reporte', reported_at=now() where shipment_id = ship[7];
  perform return_manifest_receive(rm, item[7], a, 'RM7-S01', array['sin_reporte']);
  if not (select 'sin_reporte' = any(flags) and not expected and outcome = 'received' from return_manifest_lines where manifest_id = rm and shipment_id = ship[7]) then
    raise exception 'FAIL sin reporte line';
  end if;
  -- Reportada entregada: observación, no se recibe.
  perform return_manifest_note(rm, a, 'RM8-S01', 'held', array['reportada_entregada'], ship[8], item[8], 'Lo reportó entregado');
  if (select removed_at from dispatch_manifest_items where id = item[8]) is not null then raise exception 'FAIL delivered touched'; end if;
  if (select reported_status from return_manifest_lines where manifest_id = rm and shipment_id = ship[8]) <> 'entregado' then raise exception 'FAIL delivered snapshot'; end if;
  -- Sin reporte con la ruta cerrada: observación que cita la parada pendiente.
  perform return_manifest_note(rm, a, 'RM11-S01', 'held', array['sin_reporte'], ship[11], item[11], 'Llegó sin reporte');
  -- No identificada: sin nota no se cierra.
  perform return_manifest_note(rm, a, 'XX-999', 'held', array['no_identificada']);
  perform return_manifest_note(rm, a, 'xx-999 ', 'held', array['no_identificada']);
  if (select count(*) from return_manifest_lines where manifest_id = rm and shipment_id is null) <> 1 then raise exception 'FAIL unknown duplicated'; end if;
  begin
    perform return_manifest_note(rm, a, 'XX-998', 'held', array['ya_recibida']);
    raise exception 'FAIL line without shipment not flagged';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    perform return_manifest_close(rm, a, 'Alexis');
    raise exception 'FAIL closed with unnoted unknown';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  update return_manifest_lines set note = 'Bolsa sin rótulo' where manifest_id = rm and shipment_id is null;
  -- Lo recibido no se descarta; una observación sí, con motivo.
  begin
    update return_manifest_lines set removed_at = now(), removed_by = a, removal_reason = 'error de escaneo' where id = v_line;
    raise exception 'FAIL removed received line';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    update return_manifest_lines set outcome = 'missing' where id = v_line;
    raise exception 'FAIL line rewritten';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    delete from return_manifest_lines where id = v_line;
    raise exception 'FAIL line deleted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Estado solo por su función.
  begin
    update return_manifests set state = 'closed', closed_at = now(), closed_by = a, handed_over_by = 'Alexis' where id = rm;
    raise exception 'FAIL closed without function';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Anular con cajas recibidas: no.
  begin
    perform return_manifest_cancel(rm, a, 'me equivoqué');
    raise exception 'FAIL cancelled with received';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  -- Cerrar: «Entregó» obligatorio; faltan las esperadas fuera de plazo.
  begin
    perform return_manifest_close(rm, a, 'Al');
    raise exception 'FAIL closed without handed over';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  res := return_manifest_close(rm, a, 'Alexis Prueba');
  -- Faltan: 9 (6 d > 3) y 4 (reprogramado 20 d > 14). No faltan: 2 (1 d) ni
  -- ninguna de Roy (otro motorizado) ni la entregada.
  if (res->>'missing')::int <> 2 then raise exception 'FAIL missing count %', res; end if;
  if (select array_agg(shipment_id order by shipment_id) from return_manifest_lines where manifest_id = rm and outcome = 'missing')
     <> array[ship[4], ship[9]] then raise exception 'FAIL missing set'; end if;
  if not (select 'reprogramado' = any(flags) from return_manifest_lines where manifest_id = rm and shipment_id = ship[4]) then raise exception 'FAIL missing repro flag'; end if;
  -- Cerrar no toca las salidas que faltaron.
  if (select removed_at from dispatch_manifest_items where id = item[9]) is not null then raise exception 'FAIL close touched item'; end if;
  if (select state from return_manifests where id = rm) <> 'closed' then raise exception 'FAIL not closed'; end if;
  -- Lo que seguía dentro de plazo (2, 1 d) no se anota pero queda contado, por
  -- tienda: «esperados» no cambia al cerrar.
  if (select pending_at_close from return_manifests where id = rm)
     <> jsonb_build_object('30700000-0000-0000-0000-000000000002', jsonb_build_object('con_el_motorizado', 1, 'reprogramado', 0)) then
    raise exception 'FAIL pending at close %', (select pending_at_close from return_manifests where id = rm);
  end if;
  if res->'pending_at_close' <> (select pending_at_close from return_manifests where id = rm) then raise exception 'FAIL close result pending'; end if;

  -- Cerrado: nada cambia, salvo añadir la foto del acta.
  begin
    update return_manifests set note = 'otra cosa' where id = rm;
    raise exception 'FAIL closed header edited';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  update return_manifests set photo_paths = array['acta/rm.jpg'] where id = rm;
  begin
    update return_manifests set photo_paths = '{}' where id = rm;
    raise exception 'FAIL photo removed';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    update return_manifest_lines set note = 'tarde' where id = v_line;
    raise exception 'FAIL closed line edited';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    perform return_manifest_note(rm, a, 'RM2-S01', 'info', array['ya_recibida'], ship[2]);
    raise exception 'FAIL scan into closed';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  -- La siguiente llegada abre otro; la que faltó se recibe normal en el nuevo.
  rm2 := return_manifest_open(org, 'propio', alexis, a, current_date, 3);
  if rm2 = rm then raise exception 'FAIL reused closed manifest'; end if;
  perform return_manifest_receive(rm2, item[9], a, 'RM9-S01');
  -- Una observación «sin reporte» cita la parada pendiente; retirarla de la
  -- caja (oficina, Rutas «Quitar parada») la borra: la línea suelta el enlace
  -- y conserva lo leído, sin bloquear la retirada.
  perform return_manifest_note(rm2, a, 'RM10-S01', 'held', array['sin_reporte'], ship[10], item[10], 'Llegó sin reporte');
  if (select stop_id from return_manifest_lines where manifest_id = rm2 and shipment_id = ship[10]) is null then raise exception 'FAIL held line without stop'; end if;
  perform gf_office_reclaim((select manifest_id from dispatch_manifest_items where id = item[10]), ship[10], 'No salió con él', a, roy);
  if (select stop_id is not null or reported_status <> 'pendiente' from return_manifest_lines where manifest_id = rm2 and shipment_id = ship[10]) then
    raise exception 'FAIL reclaim with a held line';
  end if;
  -- También en uno cerrado: Rutas «Quitar parada» borra la pendiente de 11.
  delete from delivery_stops where shipment_id = ship[11] and status = 'pendiente';
  if (select stop_id is not null or reported_status <> 'pendiente' from return_manifest_lines where manifest_id = rm and shipment_id = ship[11]) then
    raise exception 'FAIL closed line kept a deleted stop';
  end if;
  -- Soltar el enlace no abre la puerta a editar lo cerrado.
  begin
    update return_manifest_lines set stop_id = null, note = 'tarde' where manifest_id = rm and shipment_id = ship[1];
    raise exception 'FAIL closed line edited with stop';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Anular sin recibidas, con motivo.
  other := return_manifest_open(org, 'propio', roy, a, current_date, 1);
  begin
    perform return_manifest_cancel(other, a, 'no');
    raise exception 'FAIL cancelled without reason';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform return_manifest_cancel(other, a, 'Abierto por error');
  if (select state from return_manifests where id = other) <> 'cancelled' then raise exception 'FAIL cancel'; end if;
  -- La caja de otra organización no entra.
  begin
    perform return_manifest_receive(rm2, item[2], '30700000-0000-0000-0000-0000000000f9', 'RM2-S01');
    raise exception 'FAIL outsider received';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
end $test$;

-- RLS: solo lectura, por organización la cabecera y por tienda las líneas.
select set_config('request.test_uid', '30700000-0000-0000-0000-0000000000f9', true) \gset
set local role authenticated;
do $$ begin
  if exists (select 1 from return_manifests where org_id = '30700000-0000-0000-0000-000000000001') then raise exception 'FAIL header leaked'; end if;
  if exists (select 1 from return_manifest_lines where org_id = '30700000-0000-0000-0000-000000000001') then raise exception 'FAIL lines leaked'; end if;
end $$;
select set_config('request.test_uid', '30700000-0000-0000-0000-000000000009', true) \gset
do $$ begin
  if not exists (select 1 from return_manifests where org_id = '30700000-0000-0000-0000-000000000001') then raise exception 'FAIL owner cannot read header'; end if;
  if not exists (select 1 from return_manifest_lines where org_id = '30700000-0000-0000-0000-000000000001' and store_id is not null) then raise exception 'FAIL owner cannot read lines'; end if;
  begin
    insert into return_manifests(org_id,courier,rider_id,label,arrived_on,cadence_days,created_by)
    values ('30700000-0000-0000-0000-000000000001','propio','30700000-0000-0000-0000-000000000013','x',current_date,1,'30700000-0000-0000-0000-000000000009');
    raise exception 'FAIL authenticated wrote';
  exception when insufficient_privilege then null; end;
  begin
    perform return_manifest_open('30700000-0000-0000-0000-000000000001','propio','30700000-0000-0000-0000-000000000013','30700000-0000-0000-0000-000000000009',current_date,1);
    raise exception 'FAIL authenticated called rpc';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
