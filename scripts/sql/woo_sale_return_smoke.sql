\set ON_ERROR_STOP on
-- 0285: venta terminada sin stock; recepción e inventario habilitan un solo turno.
begin;
insert into organizations(id,name) values ('28500000-0000-0000-0000-000000000001','GF replace smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('28500000-0000-0000-0000-000000000002','28500000-0000-0000-0000-000000000001','Store GF','gf-cancel.myshopify.com');
insert into auth.users(id) values ('28500000-0000-0000-0000-000000000009');
insert into riders(id,org_id,full_name,courier,user_id) values
 ('28500000-0000-0000-0000-000000000003','28500000-0000-0000-0000-000000000001','Alexis smoke','Grupo GF Courier','28500000-0000-0000-0000-000000000009');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('28500000-0000-0000-0000-000000000020','28500000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','12:00',4000,5000,'confirmar');
insert into logistics_service_agreements(id,provider_id,client_org_id,store_id,client_label) values
 ('28500000-0000-0000-0000-000000000021','28500000-0000-0000-0000-000000000020','28500000-0000-0000-0000-000000000001','28500000-0000-0000-0000-000000000002','Store GF');
insert into peru_districts(district_key,district,province,department,source) values
 ('zz smoke 0285','Smoke 0248','Lima','Lima','manual') on conflict do nothing;
insert into logistics_district_tariffs(id,provider_id,agreement_id,district_key,delivery_amount,rejection_amount) values
 ('28500000-0000-0000-0000-000000000022','28500000-0000-0000-0000-000000000020','28500000-0000-0000-0000-000000000021','zz smoke 0285',10,10);
insert into orders(id,store_id,shopify_order_id,name) values
 ('28500000-0000-0000-0000-000000000004','28500000-0000-0000-0000-000000000002','gf-x-1','#GX1'),
 ('28500000-0000-0000-0000-000000000005','28500000-0000-0000-0000-000000000002','gf-x-2','#GX2');
insert into shipments(id,store_id,courier,guide_code,order_id,order_name,preparation_state,custody_state,delivery_status) values
 -- #GX1: con solicitud de Grupo GF.
 ('28500000-0000-0000-0000-000000000006','28500000-0000-0000-0000-000000000002','propio','GX-1','28500000-0000-0000-0000-000000000004','#GX1','listo_despacho','empresa','pendiente'),
 -- #GX2: salió sin solicitud (cuaderno o antes de las solicitudes).
 ('28500000-0000-0000-0000-000000000007','28500000-0000-0000-0000-000000000002','propio','GX-2','28500000-0000-0000-0000-000000000005','#GX2','listo_despacho','empresa','pendiente');
insert into logistics_requests(id,provider_id,agreement_id,store_id,order_id,shipment_id,idempotency_key,status,district_key,tariff_id,tariff_amount,scheduled_for) values
 ('28500000-0000-0000-0000-000000000030','28500000-0000-0000-0000-000000000020','28500000-0000-0000-0000-000000000021','28500000-0000-0000-0000-000000000002',
  '28500000-0000-0000-0000-000000000004','28500000-0000-0000-0000-000000000006','smoke-0285-1','scheduled','zz smoke 0285','28500000-0000-0000-0000-000000000022',10,current_date);
update shipments set created_via='grupo_gf_courier' where id in ('28500000-0000-0000-0000-000000000006','28500000-0000-0000-0000-000000000007');
insert into gf_dispatch_programs(order_id,store_id,scheduled_for,reason) values
 ('28500000-0000-0000-0000-000000000004','28500000-0000-0000-0000-000000000002',current_date,'Programa de prueba');
update orders set platform='woocommerce',financial_status='pending' where id='28500000-0000-0000-0000-000000000004';
do $$
declare
  o uuid:='28500000-0000-0000-0000-000000000004';
  s uuid:='28500000-0000-0000-0000-000000000006';
  a uuid:='28500000-0000-0000-0000-000000000009';
  st uuid:='28500000-0000-0000-0000-000000000002';
  box uuid; item uuid; n integer; token uuid;
begin
  if has_function_privilege('authenticated','woo_end_sale_pending_return(uuid,uuid,text,uuid)','EXECUTE')
    or has_function_privilege('anon','woo_claim_sale_return(uuid)','EXECUTE')
    or has_table_privilege('authenticated','woo_sale_returns','SELECT') then raise exception 'FAIL: cola o RPC expuestos'; end if;
  begin
    perform woo_end_sale_pending_return(o,a,'No se reintentará',gen_random_uuid());
    raise exception 'FAIL: terminó venta que nunca salió';
  exception when others then if sqlerrm not like '%caja no salió%' then raise; end if; end;
  box:=gf_dispatch_load_open('28500000-0000-0000-0000-000000000001','28500000-0000-0000-0000-000000000003',current_date,a);
  insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) values(box,s,st) returning id into item;
  update dispatch_manifests set state='in_custody' where id=box;
  update shipments set custody_state='courier',dispatched_at=now(),custody_transferred_at=now() where id=s;
  update delivery_stops set status='no_entregado',outcome_reason='no_contesta' where shipment_id=s;
  perform woo_end_sale_pending_return(o,a,'No se reintentará',gen_random_uuid());
  perform woo_end_sale_pending_return(o,a,'No se reintentará',gen_random_uuid());
  if (select count(*) from order_events where order_id=o and kind='woo_sale_ended_pending_return')<>1
    or (select cancelled_at from orders where id=o) is not null
    or (select financial_status from orders where id=o)<>'pending'
    or (select custody_state from shipments where id=s)<>'courier' then raise exception 'FAIL: no preservó fuente, caja o idempotencia'; end if;
  select count(*) into n from woo_claim_sale_return(o); if n<>0 then raise exception 'FAIL: stock antes de retorno'; end if;
  -- El estado del courier no basta, aunque alguien haya inventariado antes.
  insert into order_events(store_id,order_id,shipment_id,kind,source,actor,occurred_at)
    values(st,o,s,'returned','aliclik_api',null,now()),(st,o,s,'inventory_reconciled','manual',a,now()-interval '1 second');
  select count(*) into n from woo_claim_sale_return(o); if n<>0 then raise exception 'FAIL: stock por reporte de courier'; end if;
  -- La recepción real GF conserva la salida y su parada; no la reprograma.
  perform gf_return_to_office(item,a);
  if (select custody_state from shipments where id=s)<>'devuelto'
    or (select dispatched_at from shipments where id=s) is null
    or not exists(select 1 from delivery_stops where shipment_id=s and status='no_entregado')
    or not exists(select 1 from order_events where shipment_id=s and kind='return_received' and actor=a)
    or exists(select 1 from dispatch_manifest_items where id=item and removed_at is null) then raise exception 'FAIL: recepción GF perdió historia o volvió a asignar'; end if;
  select count(*) into n from woo_claim_sale_return(o); if n<>0 then raise exception 'FAIL: inventario anterior a recepción autorizó stock'; end if;
  insert into order_events(store_id,order_id,shipment_id,kind,source,actor,occurred_at)
    values(st,o,s,'inventory_reconciled','manual',a,now()+interval '1 second');
  select lease_token into token from woo_claim_sale_return(o); if token is null then raise exception 'FAIL: no habilitó turno tras recepción e inventario'; end if;
  select count(*) into n from woo_claim_sale_return(o); if n<>0 then raise exception 'FAIL: dos turnos simultáneos'; end if;
  update woo_sale_returns set lease_until=now()-interval '1 minute' where order_id=o;
  if not exists(select 1 from woo_claim_sale_return(o) where lease_token<>token and attempts=2) then raise exception 'FAIL: turno perdido no se recupera'; end if;
  update woo_sale_returns set state='synced',lease_until=null,lease_token=null where order_id=o;
  select count(*) into n from woo_claim_sale_return(o); if n<>0 then raise exception 'FAIL: repitió cierre confirmado'; end if;
end;
$$;
rollback;
