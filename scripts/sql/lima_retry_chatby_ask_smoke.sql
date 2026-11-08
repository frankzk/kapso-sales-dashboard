\set ON_ERROR_STOP on
-- 0324: «Pedir la ubicación por WhatsApp» de los reintentos de Lima (MOM §9.5
-- y §40). La posición nace apagada (también en una fila de antes), solo acepta
-- sus tres valores y no toca el tope ni Google; la marca es una por pedido y
-- episodio (el candado de «una vez»), solo con sus dos estados; la org lee la
-- posición y sus marcas, y nadie las cambia desde el navegador.
begin;
insert into organizations(id,name) values ('32300000-0000-0000-0000-000000000001','Pedir ubicación smoke');
insert into auth.users(id) values ('32300000-0000-0000-0000-000000000009');
insert into memberships(org_id,user_id,role) values
 ('32300000-0000-0000-0000-000000000001','32300000-0000-0000-0000-000000000009','owner');
insert into stores(id,org_id,name,shopify_domain) values
 ('32300000-0000-0000-0000-000000000002','32300000-0000-0000-0000-000000000001','Lima smoke','lima-smoke.test');
insert into orders(id,store_id,shopify_order_id,name) values
 ('32300000-0000-0000-0000-000000000003','32300000-0000-0000-0000-000000000002','smoke-1','#SM1');
insert into lima_retry_auto_settings(org_id, daily_cap, geocode_enabled) values ('32300000-0000-0000-0000-000000000001', 7, true);

do $test$
declare
  org uuid := '32300000-0000-0000-0000-000000000001';
  store uuid := '32300000-0000-0000-0000-000000000002';
  ord uuid := '32300000-0000-0000-0000-000000000003';
begin
  -- Nace apagada y solo acepta sus tres posiciones.
  if (select chatby_ask_mode from lima_retry_auto_settings where org_id = org) <> 'apagado' then raise exception 'FAIL default mode'; end if;
  update lima_retry_auto_settings set chatby_ask_mode = 'simulacion' where org_id = org;
  update lima_retry_auto_settings set chatby_ask_mode = 'activo' where org_id = org;
  begin
    update lima_retry_auto_settings set chatby_ask_mode = 'encendido' where org_id = org;
    raise exception 'FAIL unknown mode';
  exception when check_violation then null; end;
  begin
    update lima_retry_auto_settings set chatby_ask_mode = null where org_id = org;
    raise exception 'FAIL null mode';
  exception when not_null_violation then null; end;
  -- El tope y Google siguen a su aire.
  if (select daily_cap from lima_retry_auto_settings where org_id = org) <> 7 then raise exception 'FAIL cap touched'; end if;
  if (select geocode_enabled from lima_retry_auto_settings where org_id = org) is not true then raise exception 'FAIL geocode touched'; end if;

  -- Una marca por pedido y episodio; otro episodio sí.
  insert into lima_retry_chatby_asks(org_id, store_id, order_id, episode_at) values (org, store, ord, '2026-11-06T17:00:00Z');
  if (select status from lima_retry_chatby_asks where order_id = ord) <> 'enviando' then raise exception 'FAIL default status'; end if;
  begin
    insert into lima_retry_chatby_asks(org_id, store_id, order_id, episode_at) values (org, store, ord, '2026-11-06T17:00:00Z');
    raise exception 'FAIL second ask in the same episode';
  exception when unique_violation then null; end;
  insert into lima_retry_chatby_asks(org_id, store_id, order_id, episode_at, status) values (org, store, ord, '2026-11-09T17:00:00Z', 'enviado');
  update lima_retry_chatby_asks set status = 'enviado' where order_id = ord;
  begin
    update lima_retry_chatby_asks set status = 'fallo' where order_id = ord;
    raise exception 'FAIL unknown status';
  exception when check_violation then null; end;
end $test$;

-- RLS: la org lee la posición y sus marcas; nadie las cambia desde el navegador.
select set_config('request.test_uid', '32300000-0000-0000-0000-000000000009', true) \gset
set local role authenticated;
do $$ begin
  if (select chatby_ask_mode from lima_retry_auto_settings where org_id = '32300000-0000-0000-0000-000000000001') <> 'activo' then
    raise exception 'FAIL member cannot read the mode';
  end if;
  if (select count(*) from lima_retry_chatby_asks where order_id = '32300000-0000-0000-0000-000000000003') <> 2 then
    raise exception 'FAIL member cannot read the marks';
  end if;
  begin
    update lima_retry_auto_settings set chatby_ask_mode = 'apagado' where org_id = '32300000-0000-0000-0000-000000000001';
    if found then raise exception 'FAIL authenticated switched the mode'; end if;
  exception when insufficient_privilege then null; end;
  begin
    delete from lima_retry_chatby_asks where order_id = '32300000-0000-0000-0000-000000000003';
    if found then raise exception 'FAIL authenticated deleted a mark'; end if;
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
