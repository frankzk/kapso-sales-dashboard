\set ON_ERROR_STOP on
-- 0292: la hoja permite trasladar sin inventar el reporte anterior.
begin;
insert into organizations(id,name) values ('29200000-0000-0000-0000-000000000001','Notebook carry smoke');
insert into stores(id,org_id,name,shopify_domain) values ('29200000-0000-0000-0000-000000000002','29200000-0000-0000-0000-000000000001','Notebook store','notebook292.myshopify.com');
insert into auth.users(id) values ('29200000-0000-0000-0000-000000000009');
insert into memberships(org_id,user_id,role) values ('29200000-0000-0000-0000-000000000001','29200000-0000-0000-0000-000000000009','owner');
insert into riders(id,org_id,full_name,courier) values ('29200000-0000-0000-0000-000000000003','29200000-0000-0000-0000-000000000001','Alexis 0292','Grupo GF Courier');
insert into logistics_providers(id,org_id,code,name,status,same_day_cutoff,cash_warning_amount,cash_limit_amount,rider_pickup_mode) values
 ('29200000-0000-0000-0000-000000000020','29200000-0000-0000-0000-000000000001','grupo-gf-courier','Grupo GF Courier','active','12:00',4000,5000,'confirmar');
insert into orders(id,store_id,shopify_order_id,name) values
 ('29200000-0000-0000-0000-000000000004','29200000-0000-0000-0000-000000000002','nb-1','#KP292001'),
 ('29200000-0000-0000-0000-000000000005','29200000-0000-0000-0000-000000000002','nb-2','#KP292002'),
 ('29200000-0000-0000-0000-000000000006','29200000-0000-0000-0000-000000000002','nb-3','#KP292003'),
 ('29200000-0000-0000-0000-000000000007','29200000-0000-0000-0000-000000000002','nb-4','#KP292004');
insert into shipments(id,store_id,courier,guide_code,order_id,preparation_state,custody_state) select
 ('29200000-0000-0000-0000-'||lpad((n+10)::text,12,'0'))::uuid,
 '29200000-0000-0000-0000-000000000002','propio','NB-'||n,
 ('29200000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'listo_despacho','empresa'
 from generate_series(4,7) n;

do $test$
declare
 a uuid := '29200000-0000-0000-0000-000000000009';
 rider uuid := '29200000-0000-0000-0000-000000000003';
 imp uuid := '29200000-0000-0000-0000-000000000040';
 s1 uuid := '29200000-0000-0000-0000-000000000014';
 s2 uuid := '29200000-0000-0000-0000-000000000015';
 s3 uuid := '29200000-0000-0000-0000-000000000016';
 s4 uuid := '29200000-0000-0000-0000-000000000017';
 old_load uuid; old_route uuid; new_load uuid; new_route uuid; unused uuid[]; plan_json jsonb;
begin
 old_load := gf_dispatch_load_open('29200000-0000-0000-0000-000000000001',rider,current_date-2,a);
 insert into dispatch_manifest_items(manifest_id,shipment_id,store_id) select old_load,id,store_id from shipments where id=any(array[s1,s2,s3,s4]);
 unused := gf_assign_custody(old_load,a);
 select delivery_route_id into old_route from dispatch_manifests where id=old_load;
 update logistics_providers set rider_pickup_mode='exigir' where id='29200000-0000-0000-0000-000000000020';
 update delivery_stops set status='no_entregado',outcome_reason='no_contesta',reported_at=now() where shipment_id=s2;
 update orders set cancelled_at=now() where id='29200000-0000-0000-0000-000000000006';
 select jsonb_agg(jsonb_build_object('line',jsonb_build_object('order',o.name),
  'match',jsonb_build_object('kind','arrastre','via','codigo','orderId',o.id,'shipmentId',s.id))) into plan_json
 from shipments s join orders o on o.id=s.order_id where s.id=any(array[s1,s2,s3]);
 insert into rider_notebook_imports(id,org_id,rider_id,route_date,created_by,plan)
 values(imp,'29200000-0000-0000-0000-000000000001',rider,current_date,a,plan_json);

 -- La función antigua NO admite el pendiente.
 begin perform gf_carry_over(rider,current_date,array[s1],a); raise exception 'FAIL old function widened';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 -- La nueva requiere una hoja aplicada por el actor.
 begin perform gf_notebook_carry_over(rider,current_date,array[s1],a,imp); raise exception 'FAIL unapproved sheet';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 update rider_notebook_imports set status='aplicada',applied_at=now(),applied_by=a where id=imp;
 begin perform gf_notebook_carry_over(rider,current_date,array[s1],null,imp); raise exception 'FAIL wrong actor';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 begin perform gf_notebook_carry_over('29200000-0000-0000-0000-000000000099',current_date,array[s1],a,imp); raise exception 'FAIL wrong rider';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 begin perform gf_notebook_carry_over(rider,current_date+1,array[s1],a,imp); raise exception 'FAIL wrong day';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 -- No contesta, anulado y fuera de la hoja no pasan.
 begin perform gf_notebook_carry_over(rider,current_date,array[s2],a,imp); raise exception 'FAIL no_contesta';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 begin perform gf_notebook_carry_over(rider,current_date,array[s3],a,imp); raise exception 'FAIL cancelled';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 begin perform gf_notebook_carry_over(rider,current_date,array[s4],a,imp); raise exception 'FAIL not in plan';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 -- Un lote inválido no mueve al válido ni deja una caja vacía.
 begin perform gf_notebook_carry_over(rider,current_date,array[s1,s2],a,imp); raise exception 'FAIL partial batch';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 if exists(select 1 from dispatch_manifest_items where shipment_id=s1 and removed_at is not null) then raise exception 'invalid batch mutated item'; end if;
 if (select count(*) from dispatch_manifests where rider_id=rider)<>1 then raise exception 'invalid batch left box'; end if;
 -- Sin reporte anterior, un cruce por nombre no autoriza el traslado.
 update rider_notebook_imports set plan=jsonb_set(plan,'{0,match,via}','"nombre"') where id=imp;
 begin perform gf_notebook_carry_over(rider,current_date,array[s1],a,imp); raise exception 'FAIL fuzzy pending';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 update rider_notebook_imports set plan=plan_json where id=imp;
 -- Una salida reemplazada no se rescata aunque la hoja la nombre.
 begin
  update shipments set custody_state='retorno' where id=s1;
  insert into order_events(store_id,order_id,shipment_id,kind,source,payload)
   values('29200000-0000-0000-0000-000000000002','29200000-0000-0000-0000-000000000004',s1,'output_replaced','manual','{}');
  perform gf_notebook_carry_over(rider,current_date,array[s1],a,imp); raise exception 'FAIL replaced output';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 -- Código inequívoco + custodia propia: nace la parada del día.
 new_load:=gf_notebook_carry_over(rider,current_date,array[s1,s1],a,imp);
 select delivery_route_id into new_route from dispatch_manifests where id=new_load;
 if (select count(*) from delivery_stops where route_id=new_route and shipment_id=s1)<>1 then raise exception 'missing or duplicated new stop'; end if;
 if (select status from delivery_stops where route_id=old_route and shipment_id=s1)<>'pendiente' then raise exception 'old report fabricated'; end if;
 if (select reported_at from delivery_stops where route_id=old_route and shipment_id=s1) is not null then raise exception 'old report time fabricated'; end if;
 if (select notebook_carried_to_route_id from delivery_stops where route_id=old_route and shipment_id=s1) is distinct from new_route then raise exception 'missing historical marker'; end if;
 begin update delivery_stops set note='overwrite history' where route_id=old_route and shipment_id=s1; raise exception 'FAIL changed previous stop';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 if (select state from dispatch_manifests where id=new_load)<>'in_custody' then raise exception 'new load lacks custody'; end if;
 if not exists(select 1 from dispatch_events where manifest_id=old_load and kind='carried_over' and payload->>'notebook_import_id'=imp::text and payload->>'previous_stop_status'='pendiente') then raise exception 'missing source audit'; end if;
 if (select count(*) from dispatch_manifest_items where manifest_id=old_load and removed_at is null)<>3 then raise exception 'other packages moved'; end if;
 begin perform gf_notebook_carry_over(rider,current_date,array[s1],a,imp); raise exception 'FAIL duplicated transfer';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 if (select count(*) from delivery_stops where route_id=new_route)<>1 then raise exception 'retry duplicated stop'; end if;
 if has_function_privilege('anon','public.gf_notebook_carry_over(uuid,date,uuid[],uuid,uuid)','execute')
 or has_function_privilege('authenticated','public.gf_notebook_carry_over(uuid,date,uuid[],uuid,uuid)','execute') then raise exception 'public access'; end if;
 if not has_function_privilege('service_role','public.gf_notebook_carry_over(uuid,date,uuid[],uuid,uuid)','execute') then raise exception 'no service access'; end if;
end $test$;
rollback;

