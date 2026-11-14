\set ON_ERROR_STOP on
-- 0337: la guía de Aliclik deja «en devolución» la caja de Grupo GF que el
-- motorizado todavía tiene «No entregado» (#KP203491, owner 12-11-2026). La
-- S01 pasa a `retorno` con `output_replaced`, su solicitud de Grupo GF se
-- cierra, su parada queda como estaba y, al recibirla en oficina, vuelve a
-- stock. Idempotente; fuera de Lima, con la guía anulada, sin «No entregado» o
-- con el «No entregado» posterior a la guía, no hace nada. El barrido de la
-- migración arregla lo que ya estaba así.
begin;
insert into organizations(id,name) values ('32900000-0000-0000-0000-000000000001','GF por Aliclik smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('32900000-0000-0000-0000-000000000002','32900000-0000-0000-0000-000000000001','Store 0337','gf-aliclik-0337.myshopify.com');
insert into auth.users(id) values ('32900000-0000-0000-0000-000000000009');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('32900000-0000-0000-0000-000000000003','32900000-0000-0000-0000-000000000001','Alexis 0337','Grupo GF Courier','32900000-0000-0000-0000-000000000009');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('32900000-0000-0000-0000-000000000020','32900000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','12:00',4000,5000,'confirmar');
insert into logistics_service_agreements(id,provider_id,client_org_id,store_id,client_label) values
 ('32900000-0000-0000-0000-000000000021','32900000-0000-0000-0000-000000000020','32900000-0000-0000-0000-000000000001','32900000-0000-0000-0000-000000000002','Store 0337');
insert into peru_districts(district_key,district,province,department,source) values
 ('zz smoke 0337','Smoke 0337','Lima','Lima','manual') on conflict do nothing;
insert into logistics_district_tariffs(id,provider_id,agreement_id,district_key,delivery_amount,rejection_amount) values
 ('32900000-0000-0000-0000-000000000022','32900000-0000-0000-0000-000000000020','32900000-0000-0000-0000-000000000021','zz smoke 0337',10,10);

-- Pedidos: #A1 (el caso de #KP203491), #A2 (provincia), #A3 (la guía anulada),
-- #A4 (la parada sin reporte), #A5 (lo arregla el barrido de la migración).
insert into orders(id,store_id,shopify_order_id,name)
select ('32900000-0000-0000-0000-0000000001' || n || '0')::uuid, '32900000-0000-0000-0000-000000000002', 'a0337-' || n, '#A' || n
  from generate_series(1, 5) n;
insert into order_master(order_id,store_id,shopify_order_id,order_name,order_created_at,region,province,district,macro_stage,macro_substage)
select ('32900000-0000-0000-0000-0000000001' || n || '0')::uuid, '32900000-0000-0000-0000-000000000002', 'a0337-' || n, '#A' || n, now() - interval '10 days',
       case when n = 2 then 'Arequipa' else 'Lima' end, case when n = 2 then 'Arequipa' else 'Lima' end,
       case when n = 2 then 'Paucarpata' else 'Miraflores' end, 'en_curso', 'por_reprogramar_lima'
  from generate_series(1, 5) n;
-- La S01 de Grupo GF de cada pedido, lista para salir.
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state,delivery_status)
select ('32900000-0000-0000-0000-0000000001' || n || '1')::uuid, '32900000-0000-0000-0000-000000000002', 'propio', 'A' || n || '-GF',
       ('32900000-0000-0000-0000-0000000001' || n || '0')::uuid, '#A' || n, 'listo_despacho', 'empresa', 'pendiente'
  from generate_series(1, 5) n;
-- La solicitud de Grupo GF de la S01 de #A1.
insert into logistics_requests(id,provider_id,agreement_id,store_id,order_id,shipment_id,idempotency_key,status,district_key,tariff_id,tariff_amount,scheduled_for) values
 ('32900000-0000-0000-0000-000000000030','32900000-0000-0000-0000-000000000020','32900000-0000-0000-0000-000000000021','32900000-0000-0000-0000-000000000002',
  '32900000-0000-0000-0000-000000000110','32900000-0000-0000-0000-000000000111','smoke-0337-1','scheduled','zz smoke 0337','32900000-0000-0000-0000-000000000022',10,current_date - 4);

do $$
declare
  v_load uuid; v_route uuid; v_orders uuid[]; v_res jsonb; v_order uuid; v_item1 uuid; v_n int;
  v_actor uuid := '32900000-0000-0000-0000-000000000009';
  v_store uuid := '32900000-0000-0000-0000-000000000002';
  v_s01 uuid := '32900000-0000-0000-0000-000000000111';
  v_a02 uuid := '32900000-0000-0000-0000-000000000112';
  v_dispatched timestamptz;
  v_stop delivery_stops%rowtype;
begin
  if (select coverage from order_master where order_id = '32900000-0000-0000-0000-000000000110') <> 'lima' then raise exception 'fixture: #A1 not Lima'; end if;
  if (select coverage from order_master where order_id = '32900000-0000-0000-0000-000000000120') = 'lima' then raise exception 'fixture: #A2 is Lima'; end if;

  -- Alexis sale el 07-11 (hace cuatro días) con las cinco S01.
  v_load := gf_dispatch_load_open('32900000-0000-0000-0000-000000000001','32900000-0000-0000-0000-000000000003',current_date - 4,v_actor);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id)
  select v_load, ('32900000-0000-0000-0000-0000000001' || n || '1')::uuid, v_store from generate_series(1, 5) n;
  v_orders := gf_assign_custody(v_load,v_actor);
  select delivery_route_id into v_route from dispatch_manifests where id=v_load;
  select id into v_item1 from dispatch_manifest_items where manifest_id=v_load and shipment_id=v_s01;
  if (select custody_state from shipments where id=v_s01) <> 'courier' then raise exception 'fixture: S01 not with the rider'; end if;
  select dispatched_at into v_dispatched from shipments where id=v_s01;
  -- «No entregado · no contesta» hace cuatro días; la de #A4 sigue sin reporte.
  update delivery_stops set status='no_entregado', outcome_reason='no_contesta', reported_at=now() - interval '4 days'
   where route_id=v_route and shipment_id <> '32900000-0000-0000-0000-000000000141';
  update logistics_requests set status='in_route' where id='32900000-0000-0000-0000-000000000030';

  -- La guía de Aliclik del reintento, hoy (la crea Kapta antes de llamar).
  insert into shipments(id,store_id,courier,guide_code,external_order_number,order_id,order_name,preparation_state,custody_state,delivery_status,created_via,assigned_at)
  select ('32900000-0000-0000-0000-0000000001' || n || '2')::uuid, v_store, 'aliclik', 'ALC' || n, 'ALC' || n,
         ('32900000-0000-0000-0000-0000000001' || n || '0')::uuid, '#A' || n, 'rotulo_generado', 'empresa',
         case when n = 3 then 'anulado' else 'pendiente' end, 'aliclik_api', now()
    from generate_series(1, 4) n;

  -- Una salida que no es guía de Aliclik no reemplaza nada.
  v_res := gf_replace_output_with_aliclik(v_s01, v_actor);
  if v_res->>'skipped' <> 'no_es_guia_aliclik_viva' then raise exception 'GF output accepted as guide: %', v_res; end if;
  -- Provincia: no.
  v_res := gf_replace_output_with_aliclik('32900000-0000-0000-0000-000000000122', v_actor);
  if v_res->>'skipped' <> 'no_es_lima' then raise exception 'non-Lima order: %', v_res; end if;
  -- La guía anulada: no.
  v_res := gf_replace_output_with_aliclik('32900000-0000-0000-0000-000000000132', v_actor);
  if v_res->>'skipped' <> 'no_es_guia_aliclik_viva' then raise exception 'cancelled guide: %', v_res; end if;
  -- La parada sin reporte: no.
  v_res := gf_replace_output_with_aliclik('32900000-0000-0000-0000-000000000142', v_actor);
  if jsonb_array_length(v_res->'replaced') <> 0 or v_res->'skipped'->0->>'why' <> 'sin_no_entregado' then raise exception 'pending stop: %', v_res; end if;
  if exists (select 1 from shipments where id in ('32900000-0000-0000-0000-000000000121','32900000-0000-0000-0000-000000000131','32900000-0000-0000-0000-000000000141') and custody_state <> 'courier') then
    raise exception 'a skipped S01 changed custody';
  end if;

  -- #A1: la S01 queda en devolución con Alexis.
  v_res := gf_replace_output_with_aliclik(v_a02, v_actor);
  if jsonb_array_length(v_res->'replaced') <> 1 or (v_res->'replaced'->0->>'shipment_id')::uuid <> v_s01 then raise exception 'S01 not replaced: %', v_res; end if;
  if (select custody_state from shipments where id=v_s01) <> 'retorno' then raise exception 'S01 not in retorno'; end if;
  if (select dispatched_at from shipments where id=v_s01) is distinct from v_dispatched then raise exception 'S01 dispatched_at touched'; end if;
  if (select returned_at from shipments where id=v_s01) is not null then raise exception 'S01 marked returned'; end if;
  if (select removed_at from dispatch_manifest_items where id=v_item1) is not null then raise exception 'S01 left the box'; end if;
  if not gf_output_replaced(v_s01) then raise exception 'S01 not marked replaced'; end if;
  if not exists (select 1 from order_events where shipment_id=v_s01 and kind='output_replaced'
                  and payload->>'replaced_by'=v_a02::text and payload->>'replaced_by_courier'='aliclik'
                  and (payload->>'request_closed')::boolean) then raise exception 'order event missing'; end if;
  if not exists (select 1 from dispatch_events where shipment_id=v_s01 and kind='output_replaced' and manifest_id=v_load and payload->>'replaced_by'=v_a02::text) then raise exception 'dispatch event missing'; end if;
  -- La solicitud de Grupo GF se cierra y NO pasa a la guía de Aliclik.
  if (select status from logistics_requests where id='32900000-0000-0000-0000-000000000030') <> 'cancelled' then raise exception 'request not closed'; end if;
  if (select shipment_id from logistics_requests where id='32900000-0000-0000-0000-000000000030') <> v_s01 then raise exception 'request moved'; end if;
  if not exists (select 1 from logistics_request_events where request_id='32900000-0000-0000-0000-000000000030' and kind='output_replaced' and status='cancelled') then raise exception 'request event missing'; end if;
  -- La guía de Aliclik no cambia.
  if (select custody_state from shipments where id=v_a02) <> 'empresa' then raise exception 'guide custody touched'; end if;
  -- La parada fallida sigue en la ruta, como estaba.
  select * into v_stop from delivery_stops where route_id=v_route and shipment_id=v_s01;
  if v_stop.status <> 'no_entregado' or v_stop.outcome_reason <> 'no_contesta' then raise exception 'stop touched'; end if;

  -- Dos veces: nada nuevo.
  v_res := gf_replace_output_with_aliclik(v_a02, v_actor);
  if jsonb_array_length(v_res->'replaced') <> 0 then raise exception 'replaced twice: %', v_res; end if;
  select count(*) into v_n from order_events where shipment_id=v_s01 and kind='output_replaced';
  if v_n <> 1 then raise exception 'duplicate order events (%)', v_n; end if;

  -- El motorizado ya no la entrega ni deshace el «No entregado» (0248).
  begin
    update delivery_stops set status='entregado', payment_method='sin_cobro', collected_amount=0 where route_id=v_route and shipment_id=v_s01;
    raise exception 'FAIL delivered a replaced output';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'Este paquete ya salió con otra salida%' then raise exception 'expected the stop guard, got %', sqlerrm; end if;
  end;

  -- «Recibir en oficina»: a stock, no a «por asignar».
  v_order := gf_return_to_office(v_item1, v_actor);
  if v_order <> '32900000-0000-0000-0000-000000000110' then raise exception 'receive returned wrong order'; end if;
  if (select custody_state from shipments where id=v_s01) <> 'devuelto' then raise exception 'S01 not devuelto'; end if;
  if (select dispatched_at from shipments where id=v_s01) is null then raise exception 'S01 dispatched_at cleared'; end if;
  if not exists (select 1 from order_events where shipment_id=v_s01 and kind='return_received' and (payload->>'replaced')::boolean) then raise exception 'return_received missing'; end if;
  if exists (select 1 from order_events where shipment_id=v_s01 and kind='returned_to_office') then raise exception 'went back to por asignar'; end if;
  if (select status from logistics_requests where id='32900000-0000-0000-0000-000000000030') <> 'cancelled' then raise exception 'request reopened'; end if;

  -- #A5: la guía de Aliclik salió ANTES del «No entregado»: no.
  insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state,delivery_status,created_via,created_at,assigned_at)
  values ('32900000-0000-0000-0000-000000000152', v_store, 'aliclik', 'ALC5', '32900000-0000-0000-0000-000000000150', '#A5',
          'rotulo_generado', 'empresa', 'pendiente', 'aliclik_api', now() - interval '5 days', now() - interval '5 days');
  v_res := gf_replace_output_with_aliclik('32900000-0000-0000-0000-000000000152', v_actor);
  if v_res->'skipped'->0->>'why' <> 'no_entregado_posterior_a_la_guia' then raise exception 'guide before the stop: %', v_res; end if;
  -- … y otra guía viva de hoy (la que deja el barrido) sí la reemplaza.
  update shipments set delivery_status='anulado' where id='32900000-0000-0000-0000-000000000152';
  -- La segunda guía de #A5 ya la ENTREGÓ Aliclik (13-11-2026, #KP203491): la S01
  -- que sigue con el motorizado también queda en devolución.
  insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state,delivery_status,created_via,assigned_at)
  values ('32900000-0000-0000-0000-000000000153', v_store, 'aliclik', 'ALC5B', '32900000-0000-0000-0000-000000000150', '#A5',
          'rotulo_generado', 'empresa', 'entregado', 'aliclik_api', now());
end $$;

-- El barrido de la migración: reemplaza la S01 de #A5 y no vuelve a tocar #A1.
\ir ../../db/migrations/0337_gf_replaced_by_aliclik.sql
do $$
begin
  if (select custody_state from shipments where id='32900000-0000-0000-0000-000000000151') <> 'retorno' then raise exception 'backfill missed #A5'; end if;
  if not exists (select 1 from order_events where shipment_id='32900000-0000-0000-0000-000000000151' and kind='output_replaced'
                  and payload->>'replaced_by'='32900000-0000-0000-0000-000000000153') then raise exception 'backfill event missing'; end if;
  if (select count(*) from order_events where shipment_id='32900000-0000-0000-0000-000000000111' and kind='output_replaced') <> 1 then raise exception 'backfill touched #A1 again'; end if;
  if (select custody_state from shipments where id='32900000-0000-0000-0000-000000000121') <> 'courier' then raise exception 'backfill touched the province'; end if;
  if (select custody_state from shipments where id='32900000-0000-0000-0000-000000000141') <> 'courier' then raise exception 'backfill touched the pending stop'; end if;
end $$;
\ir ../../db/migrations/0337_gf_replaced_by_aliclik.sql
do $$
begin
  if (select count(*) from order_events where shipment_id='32900000-0000-0000-0000-000000000151' and kind='output_replaced') <> 1 then raise exception 'backfill not idempotent'; end if;
end $$;

-- Solo el servidor.
do $$
begin
  if has_function_privilege('authenticated', 'public.gf_replace_output_with_aliclik(uuid, uuid)', 'execute') then raise exception 'authenticated can call it'; end if;
  if has_function_privilege('anon', 'public.gf_replace_output_with_aliclik(uuid, uuid)', 'execute') then raise exception 'anon can call it'; end if;
  if not has_function_privilege('service_role', 'public.gf_replace_output_with_aliclik(uuid, uuid)', 'execute') then raise exception 'service_role cannot call it'; end if;
  if (select prosecdef from pg_proc where proname = 'gf_replace_output_with_aliclik') then raise exception 'security definer'; end if;
end $$;
rollback;
