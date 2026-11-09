\set ON_ERROR_STOP on
-- 0325: lo que dijo Google junto al veredicto y la versión de la reja de la
-- calle (MOM §6.1 y §38). Las filas de antes siguen igual (null); las tres
-- columnas de Google y la versión tienen rango; lo de la 0316 no cambia; y
-- `order_geocodes` sigue siendo solo del servidor.
begin;
insert into organizations(id,name) values ('32500000-0000-0000-0000-000000000001','Google said smoke');
insert into auth.users(id) values ('32500000-0000-0000-0000-000000000009');
insert into memberships(org_id,user_id,role) values
 ('32500000-0000-0000-0000-000000000001','32500000-0000-0000-0000-000000000009','owner');
insert into stores(id,org_id,name,shopify_domain) values
 ('32500000-0000-0000-0000-0000000000a1','32500000-0000-0000-0000-000000000001','Said','said.myshopify.com');
insert into orders(id,store_id,shopify_order_id,name) values
 ('32500000-0000-0000-0000-0000000000b1','32500000-0000-0000-0000-0000000000a1','wc-1','#KP204099'),
 ('32500000-0000-0000-0000-0000000000b2','32500000-0000-0000-0000-0000000000a1','wc-2','#KP2');

do $test$
declare
  st uuid := '32500000-0000-0000-0000-0000000000a1';
  o1 uuid := '32500000-0000-0000-0000-0000000000b1';
  o2 uuid := '32500000-0000-0000-0000-0000000000b2';
begin
  -- Una fila de la 0316 (veredicto sin lo que dijo Google) sigue valiendo.
  insert into order_geocodes(order_id,store_id,address_hash,ok,precision,reason,approx_kind,approx_mode,approx_checked_at)
  values (o1, st, 'h1', false, 'RANGE_INTERPOLATED', 'no_es_edificio', 'otra_calle', 'activo', now());
  if (select google_label is not null or google_route is not null or google_number is not null or approx_rule is not null
        from order_geocodes where order_id = o1) then raise exception 'FAIL born set'; end if;

  -- La consulta nueva guarda lo que dijo Google y la versión de la reja.
  update order_geocodes
     set google_label = 'Av. José Quiñones 546, Chiclayo 14001, Perú', google_route = 'Avenida José Quiñones',
         google_number = '546', approx_rule = 2, approx_kind = 'calle', approx_latitude = -6.77, approx_longitude = -79.84
   where order_id = o1;
  -- El edificio no se toca.
  if (select ok or latitude is not null from order_geocodes where order_id = o1) then raise exception 'FAIL rooftop touched'; end if;
  -- Lo de la 0316 sigue mandando: `calle` sin punto no vale.
  begin
    update order_geocodes set approx_latitude = null where order_id = o1;
    raise exception 'FAIL 0316 point check lost';
  exception when check_violation then null; end;

  -- Rangos.
  begin
    update order_geocodes set approx_rule = 0 where order_id = o1;
    raise exception 'FAIL rule 0';
  exception when check_violation then null; end;
  begin
    update order_geocodes set google_label = repeat('x', 501) where order_id = o1;
    raise exception 'FAIL label too long';
  exception when check_violation then null; end;
  begin
    update order_geocodes set google_number = repeat('9', 51) where order_id = o1;
    raise exception 'FAIL number too long';
  exception when check_violation then null; end;

  -- Sin resultado: todo null, como siempre.
  insert into order_geocodes(order_id,store_id,address_hash,ok,reason,google_label,google_route,google_number)
  values (o2, st, 'h2', false, 'sin_resultado', null, null, null);
end $test$;

-- RLS: la caché de Google (y lo que dijo Google) no la lee nadie más que el servidor.
select set_config('request.test_uid', '32500000-0000-0000-0000-000000000009', true) \gset
set local role authenticated;
do $$ begin
  begin
    if exists (select 1 from order_geocodes) then raise exception 'FAIL authenticated read order_geocodes'; end if;
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
