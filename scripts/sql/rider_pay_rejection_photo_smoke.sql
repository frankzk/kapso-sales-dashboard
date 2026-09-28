\set ON_ERROR_STOP on
-- 0197: para aprobar el pago del motorizado, un rechazo de una ruta anterior al
-- 28/09 no exige foto (MOM §29.7); desde el 28/09 sí. La entrega sin foto y el
-- Yape sin captura cuentan siempre.
begin;
insert into organizations(id,name) values ('19700000-0000-0000-0000-000000000001','Rechazo sin foto smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('19700000-0000-0000-0000-000000000002','19700000-0000-0000-0000-000000000001','Store 0197','rechazo-0197.myshopify.com');
insert into auth.users(id,email) values ('19700000-0000-0000-0000-000000000009','owner-0197@example.test');
insert into memberships(user_id,org_id,role) values ('19700000-0000-0000-0000-000000000009','19700000-0000-0000-0000-000000000001','owner');
insert into riders(id,org_id,full_name) values
 ('19700000-0000-0000-0000-000000000003','19700000-0000-0000-0000-000000000001','Roy 0197');
insert into orders(id,store_id,shopify_order_id,name) values
 ('19700000-0000-0000-0000-000000000041','19700000-0000-0000-0000-000000000002','r0197-1','#R1'),
 ('19700000-0000-0000-0000-000000000042','19700000-0000-0000-0000-000000000002','r0197-2','#R2'),
 ('19700000-0000-0000-0000-000000000043','19700000-0000-0000-0000-000000000002','r0197-3','#R3'),
 ('19700000-0000-0000-0000-000000000044','19700000-0000-0000-0000-000000000002','r0197-4','#R4');
-- Una ruta del 27/09 y otra del 28/09, cada una con una entrega con foto y un
-- rechazo sin foto.
insert into delivery_routes(id,org_id,store_id,rider_id,route_date,status) values
 ('19700000-0000-0000-0000-000000000027','19700000-0000-0000-0000-000000000001','19700000-0000-0000-0000-000000000002','19700000-0000-0000-0000-000000000003','2026-09-27','en_curso'),
 ('19700000-0000-0000-0000-000000000028','19700000-0000-0000-0000-000000000001','19700000-0000-0000-0000-000000000002','19700000-0000-0000-0000-000000000003','2026-09-28','en_curso');
insert into delivery_stops(id,route_id,order_id,store_id,seq,status,payment_method,collected_amount,outcome_reason,photo_path,reported_at) values
 ('19700000-0000-0000-0000-000000000051','19700000-0000-0000-0000-000000000027','19700000-0000-0000-0000-000000000041','19700000-0000-0000-0000-000000000002',1,'entregado','efectivo',89,null,'f/1.jpg',now()),
 ('19700000-0000-0000-0000-000000000052','19700000-0000-0000-0000-000000000027','19700000-0000-0000-0000-000000000042','19700000-0000-0000-0000-000000000002',2,'no_entregado',null,null,'rechazado',null,now()),
 ('19700000-0000-0000-0000-000000000053','19700000-0000-0000-0000-000000000028','19700000-0000-0000-0000-000000000043','19700000-0000-0000-0000-000000000002',1,'entregado','efectivo',89,null,'f/3.jpg',now()),
 ('19700000-0000-0000-0000-000000000054','19700000-0000-0000-0000-000000000028','19700000-0000-0000-0000-000000000044','19700000-0000-0000-0000-000000000002',2,'no_entregado',null,null,'rechazado',null,now());
do $$
declare
  v_owner uuid := '19700000-0000-0000-0000-000000000009';
  v_old uuid := '19700000-0000-0000-0000-000000000027';
  v_new uuid := '19700000-0000-0000-0000-000000000028';
  v_snap jsonb;
begin
  perform rider_pay_save_rate('19700000-0000-0000-0000-000000000003', null, 8.50, date '2026-09-01', 'Tarifa acordada', v_owner);

  -- 27/09: el rechazo sin foto no cuenta; 28/09: sí.
  if (rider_pay_preview(v_old, v_owner)->>'evidence_missing')::int <> 0 then raise exception 'FAIL old rejection counted as missing evidence'; end if;
  if (rider_pay_preview(v_new, v_owner)->>'evidence_missing')::int <> 1 then raise exception 'FAIL new rejection not counted'; end if;
  -- El rechazo se sigue pagando como punto: la excepción es de evidencia, no de tarifa.
  if (rider_pay_preview(v_old, v_owner)->>'base')::numeric <> 17 then raise exception 'FAIL old rejection not paid as a point'; end if;

  -- La entrega sin foto cuenta siempre, también antes del 28/09…
  update delivery_stops set photo_path=null where id='19700000-0000-0000-0000-000000000051';
  if (rider_pay_preview(v_old, v_owner)->>'evidence_missing')::int <> 1 then raise exception 'FAIL old delivery without photo not counted'; end if;
  -- …y el Yape sin captura también.
  update delivery_stops set photo_path='f/1.jpg', payment_method='yape' where id='19700000-0000-0000-0000-000000000051';
  if (rider_pay_preview(v_old, v_owner)->>'evidence_missing')::int <> 1 then raise exception 'FAIL old yape without voucher not counted'; end if;
  update delivery_stops set payment_method='efectivo' where id='19700000-0000-0000-0000-000000000051';

  -- Con la ruta cerrada, el pago del 27/09 se aprueba; el del 28/09 no.
  update delivery_routes set status='cerrada' where id in (v_old, v_new);
  v_snap := rider_pay_preview(v_old, v_owner);
  perform rider_pay_approve(v_old, v_snap, v_owner);
  if not exists (select 1 from rider_daily_pay_closures where route_id=v_old) then raise exception 'FAIL old route pay not approved'; end if;
  begin
    v_snap := rider_pay_preview(v_new, v_owner);
    perform rider_pay_approve(v_new, v_snap, v_owner);
    raise exception 'FAIL new route approved without rejection photo';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%evidencia%' then raise exception 'FAIL unexpected error: %', sqlerrm; end if;
  end;
end $$;
rollback;
