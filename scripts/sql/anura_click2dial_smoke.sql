\set ON_ERROR_STOP on
-- 0310: «Llamar con Anura», fase 1. Un anexo por persona y uno por anexo en
-- la org, de 2 a 6 dígitos; el estado y su rango van juntos; el modo fija qué
-- lleva pedido; una sola llamada viva por persona; un `cdrid` es una llamada
-- por org; la grabación guardada lleva su ruta; RLS de solo lectura (anexos
-- por org, llamadas por tienda) y la bitácora solo para el servidor.
begin;
insert into organizations(id,name) values ('31000000-0000-0000-0000-000000000001','Anura smoke'),
 ('31000000-0000-0000-0000-0000000000f1','Otra org');
insert into stores(id,org_id,name,shopify_domain) values
 ('31000000-0000-0000-0000-000000000002','31000000-0000-0000-0000-000000000001','Anura A','anura-a.test'),
 ('31000000-0000-0000-0000-0000000000f2','31000000-0000-0000-0000-0000000000f1','Otra','anura-otra.test');
insert into auth.users(id) values ('31000000-0000-0000-0000-000000000009'),('31000000-0000-0000-0000-000000000008'),
 ('31000000-0000-0000-0000-0000000000f9');
insert into memberships(org_id,user_id,role) values
 ('31000000-0000-0000-0000-000000000001','31000000-0000-0000-0000-000000000009','vendedora'),
 ('31000000-0000-0000-0000-000000000001','31000000-0000-0000-0000-000000000008','vendedora'),
 ('31000000-0000-0000-0000-0000000000f1','31000000-0000-0000-0000-0000000000f9','owner');
insert into user_store_access(user_id,store_id) values
 ('31000000-0000-0000-0000-000000000009','31000000-0000-0000-0000-000000000002');
insert into orders(id,store_id,shopify_order_id,name) values
 ('31000000-0000-0000-0001-000000000001','31000000-0000-0000-0000-000000000002','anura-1','#AN1');

do $test$
declare
  org uuid := '31000000-0000-0000-0000-000000000001';
  other uuid := '31000000-0000-0000-0000-0000000000f1';
  st uuid := '31000000-0000-0000-0000-000000000002';
  ord uuid := '31000000-0000-0000-0001-000000000001';
  u1 uuid := '31000000-0000-0000-0000-000000000009';
  u2 uuid := '31000000-0000-0000-0000-000000000008';
  c uuid;
begin
  -- Anexos: de 2 a 6 dígitos, uno por persona y uno por anexo en la org.
  insert into anura_extensions(org_id,user_id,extension) values (org,u1,'101');
  begin
    insert into anura_extensions(org_id,user_id,extension) values (org,u2,'1');
    raise exception 'FAIL one-digit extension';
  exception when check_violation then null; end;
  begin
    insert into anura_extensions(org_id,user_id,extension) values (org,u2,'10a');
    raise exception 'FAIL non-numeric extension';
  exception when check_violation then null; end;
  begin
    insert into anura_extensions(org_id,user_id,extension) values (org,u2,'101');
    raise exception 'FAIL same extension twice in the org';
  exception when unique_violation then null; end;
  begin
    insert into anura_extensions(org_id,user_id,extension) values (org,u1,'102');
    raise exception 'FAIL two extensions for one person';
  exception when unique_violation then null; end;
  insert into anura_extensions(org_id,user_id,extension) values (org,u2,'102');
  -- El mismo anexo en otra org sí.
  insert into anura_extensions(org_id,user_id,extension) values (other,'31000000-0000-0000-0000-0000000000f9','101');
  if (select active from anura_extensions where org_id = org and user_id = u1) is not true then raise exception 'FAIL extension born inactive'; end if;

  -- Una llamada de pedido nace solicitada (rango 0).
  insert into anura_calls(org_id,store_id,order_id,user_id,mode,direction,extension,phone)
  values (org,st,ord,u1,'pedido','out','101','987654321') returning id into c;
  if (select status_rank from anura_calls where id = c) <> 0 then raise exception 'FAIL default rank'; end if;
  -- Estado y rango van juntos.
  begin
    update anura_calls set status = 'contestada' where id = c;
    raise exception 'FAIL status without its rank';
  exception when check_violation then null; end;
  begin
    update anura_calls set status = 'colgada', status_rank = 100 where id = c;
    raise exception 'FAIL unknown status';
  exception when check_violation then null; end;
  -- Una sola llamada viva por persona.
  begin
    insert into anura_calls(org_id,store_id,user_id,mode,direction,extension,phone)
    values (org,st,u1,'prueba','out','101','912345678');
    raise exception 'FAIL two live calls for one person';
  exception when unique_violation then null; end;
  update anura_calls set status = 'sonando', status_rank = 10, anura_call_id = 'cdr-1' where id = c;
  update anura_calls set status = 'contestada', status_rank = 100, bill_seconds = 42 where id = c;
  -- Terminada, ya puede pedir otra (una prueba, sin pedido).
  insert into anura_calls(org_id,store_id,user_id,mode,direction,extension,phone)
  values (org,st,u1,'prueba','out','101','912345678');

  -- El modo fija qué lleva pedido.
  begin
    insert into anura_calls(org_id,store_id,user_id,mode,direction) values (org,st,u2,'pedido','out');
    raise exception 'FAIL pedido without order';
  exception when check_violation then null; end;
  begin
    insert into anura_calls(org_id,store_id,order_id,user_id,mode,direction) values (org,st,ord,u2,'prueba','out');
    raise exception 'FAIL prueba with order';
  exception when check_violation then null; end;
  begin
    insert into anura_calls(org_id,mode,direction) values (org,'entrante','out');
    raise exception 'FAIL entrante going out';
  exception when check_violation then null; end;

  -- Un cdrid es una sola llamada por org; las entrantes no ocupan a nadie.
  insert into anura_calls(org_id,user_id,mode,direction,status,status_rank,anura_call_id)
  values (org,u1,'entrante','in','sonando',10,'cdr-2');
  begin
    insert into anura_calls(org_id,mode,direction,status,status_rank,anura_call_id)
    values (org,'entrante','in','perdida',100,'cdr-2');
    raise exception 'FAIL same cdrid twice';
  exception when unique_violation then null; end;
  insert into anura_calls(org_id,mode,direction,status,status_rank,anura_call_id)
  values (other,'entrante','in','perdida',100,'cdr-2');

  -- La grabación guardada lleva su ruta, y solo esa.
  begin
    update anura_calls set recording_status = 'guardada' where id = c;
    raise exception 'FAIL saved recording without path';
  exception when check_violation then null; end;
  update anura_calls set recording_status = 'guardada', recording_path = 'org/2026-11/x.mp3' where id = c;

  -- Borrar un pedido con una llamada de pedido borra la llamada (no choca con
  -- el chequeo del modo, como haría `on delete set null`).
  insert into orders(id,store_id,shopify_order_id,name)
  values ('31000000-0000-0000-0001-000000000002',st,'anura-2','#AN2');
  insert into anura_calls(org_id,store_id,order_id,user_id,mode,direction,extension,phone,status,status_rank)
  values (org,st,'31000000-0000-0000-0001-000000000002',u2,'pedido','out','102','912345678','no_contestada',100);
  delete from orders where id = '31000000-0000-0000-0001-000000000002';
  if exists (select 1 from anura_calls where order_id = '31000000-0000-0000-0001-000000000002') then
    raise exception 'FAIL order delete left its anura call';
  end if;

  -- La bitácora: resultado conocido y payload objeto.
  insert into anura_webhook_events(org_id,event,outcome,call_id) values (org,'END','aplicado',c);
  begin
    insert into anura_webhook_events(org_id,event,outcome) values (org,'END','raro');
    raise exception 'FAIL unknown outcome';
  exception when check_violation then null; end;
  begin
    insert into anura_webhook_events(org_id,outcome,payload) values (org,'ignorado','[]');
    raise exception 'FAIL payload not an object';
  exception when check_violation then null; end;
end $test$;

-- RLS: los anexos los lee la org; las llamadas, quien ve la tienda; la
-- bitácora nadie desde el navegador; nadie escribe.
select set_config('request.test_uid', '31000000-0000-0000-0000-000000000009', true) \gset
set local role authenticated;
do $$ begin
  if (select count(*) from anura_extensions) <> 2 then raise exception 'FAIL member reads extensions of its org only'; end if;
  if not exists (select 1 from anura_calls where store_id = '31000000-0000-0000-0000-000000000002') then raise exception 'FAIL store viewer cannot read calls'; end if;
  if exists (select 1 from anura_calls where store_id is null) then raise exception 'FAIL inbound without store leaked'; end if;
  begin
    perform 1 from anura_webhook_events limit 1;
    raise exception 'FAIL authenticated read the event log';
  exception when insufficient_privilege then null; end;
  begin
    insert into anura_extensions(org_id,user_id,extension) values ('31000000-0000-0000-0000-000000000001','31000000-0000-0000-0000-000000000009','103');
    raise exception 'FAIL authenticated wrote an extension';
  exception when insufficient_privilege then null; end;
  begin
    update anura_calls set status = 'fallida', status_rank = 100 where store_id = '31000000-0000-0000-0000-000000000002';
    raise exception 'FAIL authenticated moved a call';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.test_uid', '31000000-0000-0000-0000-000000000008', true) \gset
set local role authenticated;
do $$ begin
  -- u2 es de la org pero no tiene acceso a la tienda: ve los anexos, no las llamadas.
  if (select count(*) from anura_extensions) <> 2 then raise exception 'FAIL org member cannot read extensions'; end if;
  if exists (select 1 from anura_calls) then raise exception 'FAIL calls leaked without store access'; end if;
end $$;
reset role;
rollback;
