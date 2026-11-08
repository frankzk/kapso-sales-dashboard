\set ON_ERROR_STOP on
-- 0318: «Pedir sola la dirección o la ubicación» (MOM §6.1 y §40). La
-- posición nace apagada (también en una fila de antes), solo acepta sus tres
-- valores, no toca la de la ubicación aproximada (0316), la org la lee y
-- nadie la cambia desde el navegador.
begin;
insert into organizations(id,name) values ('31800000-0000-0000-0000-000000000001','Pedir smoke');
insert into auth.users(id) values ('31800000-0000-0000-0000-000000000009');
insert into memberships(org_id,user_id,role) values
 ('31800000-0000-0000-0000-000000000001','31800000-0000-0000-0000-000000000009','owner');
insert into chatby_auto_settings(org_id, approx_mode) values ('31800000-0000-0000-0000-000000000001', 'simulacion');

do $test$
declare
  org uuid := '31800000-0000-0000-0000-000000000001';
begin
  -- Nace apagada y solo acepta sus tres posiciones.
  if (select ask_mode from chatby_auto_settings where org_id = org) <> 'apagado' then raise exception 'FAIL default mode'; end if;
  update chatby_auto_settings set ask_mode = 'simulacion' where org_id = org;
  update chatby_auto_settings set ask_mode = 'activo' where org_id = org;
  begin
    update chatby_auto_settings set ask_mode = 'encendido' where org_id = org;
    raise exception 'FAIL unknown mode';
  exception when check_violation then null; end;
  begin
    update chatby_auto_settings set ask_mode = null where org_id = org;
    raise exception 'FAIL null mode';
  exception when not_null_violation then null; end;
  -- La ubicación aproximada (0316) sigue a su aire.
  if (select approx_mode from chatby_auto_settings where org_id = org) <> 'simulacion' then raise exception 'FAIL approx touched'; end if;
end $test$;

-- RLS: la org lee su posición y nadie la cambia desde el navegador.
select set_config('request.test_uid', '31800000-0000-0000-0000-000000000009', true) \gset
set local role authenticated;
do $$ begin
  if (select ask_mode from chatby_auto_settings where org_id = '31800000-0000-0000-0000-000000000001') <> 'activo' then
    raise exception 'FAIL member cannot read the mode';
  end if;
  begin
    update chatby_auto_settings set ask_mode = 'apagado' where org_id = '31800000-0000-0000-0000-000000000001';
    if found then raise exception 'FAIL authenticated switched the mode'; end if;
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
