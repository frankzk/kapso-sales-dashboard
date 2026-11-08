\set ON_ERROR_STOP on
-- 0316: «Aceptar ubicación aproximada en la calle correcta» (MOM §6.1 y §40).
-- La posición nace apagada y solo acepta sus tres valores; el punto
-- aproximado solo existe con el veredicto `calle` y siempre con sus dos
-- coordenadas; el edificio (`ok`, `latitude`, `longitude`) no cambia; la
-- org lee su posición y nadie escribe desde el navegador; `order_geocodes`
-- sigue siendo solo del servidor.
begin;
insert into organizations(id,name) values ('31400000-0000-0000-0000-000000000001','Aprox smoke');
insert into auth.users(id) values ('31400000-0000-0000-0000-000000000009');
insert into memberships(org_id,user_id,role) values
 ('31400000-0000-0000-0000-000000000001','31400000-0000-0000-0000-000000000009','owner');
insert into stores(id,org_id,name,shopify_domain) values
 ('31400000-0000-0000-0000-0000000000a1','31400000-0000-0000-0000-000000000001','Aprox','aprox.myshopify.com');
insert into orders(id,store_id,shopify_order_id,name) values
 ('31400000-0000-0000-0000-0000000000b1','31400000-0000-0000-0000-0000000000a1','wc-1','#KP1'),
 ('31400000-0000-0000-0000-0000000000b2','31400000-0000-0000-0000-0000000000a1','wc-2','#KP2');
insert into chatby_auto_settings(org_id) values ('31400000-0000-0000-0000-000000000001');

do $test$
declare
  org uuid := '31400000-0000-0000-0000-000000000001';
  st uuid := '31400000-0000-0000-0000-0000000000a1';
  o1 uuid := '31400000-0000-0000-0000-0000000000b1';
  o2 uuid := '31400000-0000-0000-0000-0000000000b2';
begin
  -- Nace apagada y solo acepta sus tres posiciones.
  if (select approx_mode from chatby_auto_settings where org_id = org) <> 'apagado' then raise exception 'FAIL default mode'; end if;
  update chatby_auto_settings set approx_mode = 'simulacion' where org_id = org;
  update chatby_auto_settings set approx_mode = 'activo' where org_id = org;
  begin
    update chatby_auto_settings set approx_mode = 'off' where org_id = org;
    raise exception 'FAIL unknown mode';
  exception when check_violation then null; end;

  -- Una fila de antes (0301) sigue valiendo sin tocar nada.
  insert into order_geocodes(order_id,store_id,address_hash,ok,precision,reason)
  values (o1, st, 'h1', false, 'RANGE_INTERPOLATED', 'no_es_edificio');
  if (select approx_kind from order_geocodes where order_id = o1) is not null then raise exception 'FAIL approx born set'; end if;

  -- `calle` lleva su punto; sin él, se rechaza.
  begin
    update order_geocodes set approx_kind = 'calle', approx_mode = 'simulacion' where order_id = o1;
    raise exception 'FAIL calle without point';
  exception when check_violation then null; end;
  update order_geocodes
     set approx_kind = 'calle', approx_latitude = -13.16, approx_longitude = -74.22,
         approx_mode = 'simulacion', approx_checked_at = now()
   where order_id = o1;
  -- El edificio no se toca: sigue sin punto y sin `ok`.
  if (select ok or latitude is not null from order_geocodes where order_id = o1) then raise exception 'FAIL rooftop touched'; end if;

  -- Un rechazo de la calle no guarda punto.
  begin
    insert into order_geocodes(order_id,store_id,address_hash,ok,precision,reason,approx_kind,approx_latitude,approx_longitude,approx_mode)
    values (o2, st, 'h2', false, 'RANGE_INTERPOLATED', 'no_es_edificio', 'otra_calle', -13.1, -74.2, 'activo');
    raise exception 'FAIL rejected with point';
  exception when check_violation then null; end;
  insert into order_geocodes(order_id,store_id,address_hash,ok,precision,reason,approx_kind,approx_mode,approx_checked_at)
  values (o2, st, 'h2', false, 'RANGE_INTERPOLATED', 'no_es_edificio', 'otra_calle', 'activo', now());
  begin
    update order_geocodes set approx_kind = 'cerca' where order_id = o2;
    raise exception 'FAIL unknown approx kind';
  exception when check_violation then null; end;
  begin
    update order_geocodes set approx_mode = 'apagado' where order_id = o2;
    raise exception 'FAIL unknown approx mode';
  exception when check_violation then null; end;

  -- El índice del panel existe y es parcial.
  if not exists (
    select 1 from pg_indexes where indexname = 'order_geocodes_approx_idx' and indexdef like '%WHERE (approx_kind = ''calle''::text)%'
  ) then raise exception 'FAIL approx index'; end if;
end $test$;

-- RLS: la org lee su posición y nadie la cambia desde el navegador; la caché
-- de Google no la lee nadie más que el servidor.
select set_config('request.test_uid', '31400000-0000-0000-0000-000000000009', true) \gset
set local role authenticated;
do $$ begin
  if (select approx_mode from chatby_auto_settings where org_id = '31400000-0000-0000-0000-000000000001') <> 'activo' then
    raise exception 'FAIL member cannot read the mode';
  end if;
  begin
    update chatby_auto_settings set approx_mode = 'apagado' where org_id = '31400000-0000-0000-0000-000000000001';
    if found then raise exception 'FAIL authenticated switched the mode'; end if;
  exception when insufficient_privilege then null; end;
  begin
    if exists (select 1 from order_geocodes) then raise exception 'FAIL authenticated read order_geocodes'; end if;
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
