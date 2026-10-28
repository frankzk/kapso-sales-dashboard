\set ON_ERROR_STOP on
begin;
insert into organizations(id,name) values('28700000-0000-0000-0000-000000000001','Payment amount smoke');
insert into stores(id,org_id,name,shopify_domain) values('28700000-0000-0000-0000-000000000002','28700000-0000-0000-0000-000000000001','Amount smoke','amount-smoke.myshopify.com');
insert into orders(id,store_id,shopify_order_id,name) values('28700000-0000-0000-0000-000000000003','28700000-0000-0000-0000-000000000002','amount-smoke','#AMOUNT');
do $$
declare
  st uuid:='28700000-0000-0000-0000-000000000002';
  ord uuid:='28700000-0000-0000-0000-000000000003';
  pay uuid; bad numeric;
begin
  foreach bad in array array[null::numeric,0::numeric,-1::numeric,'NaN'::numeric] loop
    begin
      insert into order_payments(store_id,order_id,kind,amount,validation_status) values(st,ord,'adelanto',bad,'validado');
      raise exception 'FAIL: validado sin monto positivo (%)',bad;
    exception when check_violation then null; end;
  end loop;
  insert into order_payments(store_id,order_id,kind,amount,validation_status)
    values(st,ord,'adelanto',null,'info_incompleta') returning id into pay;
  begin
    update order_payments set validation_status='validado' where id=pay;
    raise exception 'FAIL: validación de monto nulo';
  exception when check_violation then null; end;
  update order_payments set amount=20,validation_status='validado' where id=pay;
  begin
    update order_payments set amount=null where id=pay;
    raise exception 'FAIL: borró monto de validado';
  exception when check_violation then null; end;
  update order_payments set validation_status='revision_admin',amount=null where id=pay;
  if not exists(select 1 from order_payments where id=pay and validation_status='revision_admin' and amount is null)
    then raise exception 'FAIL: no permite retirar validación para observar'; end if;
end;
$$;
rollback;
