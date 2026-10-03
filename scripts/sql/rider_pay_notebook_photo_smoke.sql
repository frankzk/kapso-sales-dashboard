\set ON_ERROR_STOP on
-- 0222: para aprobar el pago del motorizado, lo cargado desde el cuaderno
-- (reported_by null) no exige foto (MOM §29.7); lo reportado desde la app sí.
-- El Yape sin captura cuenta siempre.
begin;
insert into organizations(id,name) values ('22200000-0000-0000-0000-000000000001','Cuaderno sin foto smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('22200000-0000-0000-0000-000000000002','22200000-0000-0000-0000-000000000001','Store 0222','cuaderno-0222.myshopify.com');
insert into auth.users(id,email) values ('22200000-0000-0000-0000-000000000009','owner-0222@example.test');
insert into memberships(user_id,org_id,role) values ('22200000-0000-0000-0000-000000000009','22200000-0000-0000-0000-000000000001','owner');
insert into riders(id,org_id,full_name) values
 ('22200000-0000-0000-0000-000000000003','22200000-0000-0000-0000-000000000001','Alexis 0222');
insert into orders(id,store_id,shopify_order_id,name) values
 ('22200000-0000-0000-0000-000000000041','22200000-0000-0000-0000-000000000002','c0222-1','#C1'),
 ('22200000-0000-0000-0000-000000000042','22200000-0000-0000-0000-000000000002','c0222-2','#C2'),
 ('22200000-0000-0000-0000-000000000043','22200000-0000-0000-0000-000000000002','c0222-3','#C3');
-- Una ruta del 01/10 cargada desde el cuaderno: una entrega y un rechazo, los
-- dos sin foto y sin `reported_by`.
insert into delivery_routes(id,org_id,store_id,rider_id,route_date,status) values
 ('22200000-0000-0000-0000-000000000010','22200000-0000-0000-0000-000000000001','22200000-0000-0000-0000-000000000002','22200000-0000-0000-0000-000000000003','2026-10-01','en_curso');
insert into delivery_stops(id,route_id,order_id,store_id,seq,status,payment_method,collected_amount,outcome_reason,photo_path,reported_at,reported_by) values
 ('22200000-0000-0000-0000-000000000051','22200000-0000-0000-0000-000000000010','22200000-0000-0000-0000-000000000041','22200000-0000-0000-0000-000000000002',1,'entregado','efectivo',149,null,null,now(),null),
 ('22200000-0000-0000-0000-000000000052','22200000-0000-0000-0000-000000000010','22200000-0000-0000-0000-000000000042','22200000-0000-0000-0000-000000000002',2,'no_entregado',null,null,'rechazado',null,now(),null);
do $$
declare
  v_owner uuid := '22200000-0000-0000-0000-000000000009';
  v_route uuid := '22200000-0000-0000-0000-000000000010';
  v_snap jsonb;
begin
  perform rider_pay_save_rate('22200000-0000-0000-0000-000000000003', null, 10.00, date '2026-10-01', 'Tarifa de su cuaderno', v_owner);

  -- Del cuaderno: ni la entrega ni el rechazo cuentan como evidencia faltante…
  if (rider_pay_preview(v_route, v_owner)->>'evidence_missing')::int <> 0 then raise exception 'FAIL notebook stops counted as missing evidence'; end if;
  -- …y los dos se pagan como punto: la excepción es de evidencia, no de tarifa.
  if (rider_pay_preview(v_route, v_owner)->>'base')::numeric <> 20 then raise exception 'FAIL notebook stops not paid as points'; end if;

  -- Una entrega reportada desde la app sin foto sí cuenta.
  insert into delivery_stops(id,route_id,order_id,store_id,seq,status,payment_method,collected_amount,photo_path,reported_at,reported_by) values
   ('22200000-0000-0000-0000-000000000053',v_route,'22200000-0000-0000-0000-000000000043','22200000-0000-0000-0000-000000000002',3,'entregado','efectivo',99,null,now(),v_owner);
  if (rider_pay_preview(v_route, v_owner)->>'evidence_missing')::int <> 1 then raise exception 'FAIL app delivery without photo not counted'; end if;
  update delivery_stops set photo_path='f/3.jpg' where id='22200000-0000-0000-0000-000000000053';

  -- El Yape sin captura cuenta aunque venga del cuaderno.
  update delivery_stops set payment_method='yape' where id='22200000-0000-0000-0000-000000000051';
  if (rider_pay_preview(v_route, v_owner)->>'evidence_missing')::int <> 1 then raise exception 'FAIL notebook yape without voucher not counted'; end if;
  update delivery_stops set payment_method='efectivo' where id='22200000-0000-0000-0000-000000000051';

  -- Con la ruta cerrada, el pago se aprueba sin fotos del cuaderno.
  update delivery_routes set status='cerrada' where id=v_route;
  v_snap := rider_pay_preview(v_route, v_owner);
  perform rider_pay_approve(v_route, v_snap, v_owner);
  if not exists (select 1 from rider_daily_pay_closures where route_id=v_route) then raise exception 'FAIL notebook route pay not approved'; end if;
end $$;
rollback;
