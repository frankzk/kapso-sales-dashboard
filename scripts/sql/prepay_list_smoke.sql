\set ON_ERROR_STOP on
-- 0309: «Lista de pago adelantado» (MOM §41). Una sola alta viva por
-- (organización, celular); el celular en su forma canónica; el motivo con
-- largo mínimo; una alta no se reescribe, solo se quita una vez y con motivo;
-- al quitarla guarda los pedidos que ya la disparaban, una vez;
-- después de quitarla se puede volver a agregar; la posición de la regla nace
-- apagada; RLS de solo lectura por organización.
begin;
insert into organizations(id,name) values ('30900000-0000-0000-0000-000000000001','Prepay smoke'),
 ('30900000-0000-0000-0000-0000000000f1','Otra org');
insert into auth.users(id) values ('30900000-0000-0000-0000-000000000009'),('30900000-0000-0000-0000-0000000000f9');
insert into memberships(org_id,user_id,role) values
 ('30900000-0000-0000-0000-000000000001','30900000-0000-0000-0000-000000000009','vendedora'),
 ('30900000-0000-0000-0000-0000000000f1','30900000-0000-0000-0000-0000000000f9','owner');

do $test$
declare
  org uuid := '30900000-0000-0000-0000-000000000001';
  other uuid := '30900000-0000-0000-0000-0000000000f1';
  e uuid;
begin
  insert into prepay_list_entries(org_id,phone,source,reason,evidence)
  values (org,'51987654321','auto','Rechazó en la puerta 1 pedido (#KP1).','{"kind":"auto","orders":[{"order_id":"x"}]}')
  returning id into e;

  -- Una sola alta viva por celular y organización.
  begin
    insert into prepay_list_entries(org_id,phone,source,reason) values (org,'51987654321','manual','Otra vez a mano');
    raise exception 'FAIL two active entries';
  exception when unique_violation then null; end;
  -- El mismo celular en otra organización sí.
  insert into prepay_list_entries(org_id,phone,source,reason) values (other,'51987654321','manual','Otra organización');

  -- Celular canónico y motivo con largo mínimo.
  begin
    insert into prepay_list_entries(org_id,phone,source,reason) values (org,'987654321','manual','Sin el 51 delante');
    raise exception 'FAIL non canonical phone';
  exception when check_violation then null; end;
  begin
    insert into prepay_list_entries(org_id,phone,source,reason) values (org,'51911111111','manual','corto');
    raise exception 'FAIL short reason';
  exception when check_violation then null; end;
  begin
    insert into prepay_list_entries(org_id,phone,source,reason) values (org,'51911111111','robot','Origen inventado');
    raise exception 'FAIL unknown source';
  exception when check_violation then null; end;

  -- Una alta no se reescribe.
  begin
    update prepay_list_entries set reason = 'Otro motivo cualquiera' where id = e;
    raise exception 'FAIL rewrote reason';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    update prepay_list_entries set phone = '51911111111' where id = e;
    raise exception 'FAIL rewrote phone';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Quitar pide motivo.
  begin
    update prepay_list_entries set removed_at = now() where id = e;
    raise exception 'FAIL removed without reason';
  exception when check_violation then null; end;
  -- Lo sabido al quitar se escribe solo al quitar, y es una lista.
  begin
    update prepay_list_entries set removed_known_order_ids = '["x"]' where id = e;
    raise exception 'FAIL known ids on a live entry';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    update prepay_list_entries set removed_at = now(), removed_reason = 'Pagó y se comprobó que fue un error', removed_known_order_ids = '{"x":1}' where id = e;
    raise exception 'FAIL known ids not an array';
  exception when check_violation then null; end;
  update prepay_list_entries set removed_at = now(), removed_reason = 'Pagó y se comprobó que fue un error', removed_known_order_ids = '["x","y"]' where id = e;
  begin
    update prepay_list_entries set removed_known_order_ids = '[]' where id = e;
    raise exception 'FAIL rewrote known ids';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Lo quitado no se cambia ni se reabre.
  begin
    update prepay_list_entries set removed_at = null, removed_reason = null where id = e;
    raise exception 'FAIL reopened';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    update prepay_list_entries set removed_reason = 'Otro motivo para la baja' where id = e;
    raise exception 'FAIL rewrote removal';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Quitada, se puede volver a agregar (la regla decide CUÁNDO, §41.3).
  insert into prepay_list_entries(org_id,phone,source,reason) values (org,'51987654321','manual','Volvió a rechazar en la puerta');
  if (select count(*) from prepay_list_entries where org_id = org and phone = '51987654321') <> 2 then raise exception 'FAIL history lost'; end if;

  -- La regla nace apagada.
  insert into prepay_list_settings(org_id) values (org);
  if (select auto_mode from prepay_list_settings where org_id = org) <> 'apagado' then raise exception 'FAIL default mode'; end if;
  begin
    update prepay_list_settings set auto_mode = 'encendido' where org_id = org;
    raise exception 'FAIL unknown mode';
  exception when check_violation then null; end;
end $test$;

-- RLS: cada quien lee las altas de su organización y nadie escribe.
select set_config('request.test_uid', '30900000-0000-0000-0000-000000000009', true) \gset
set local role authenticated;
do $$ begin
  if not exists (select 1 from prepay_list_entries where org_id = '30900000-0000-0000-0000-000000000001') then raise exception 'FAIL member cannot read'; end if;
  if exists (select 1 from prepay_list_entries where org_id = '30900000-0000-0000-0000-0000000000f1') then raise exception 'FAIL other org leaked'; end if;
  if not exists (select 1 from prepay_list_settings where org_id = '30900000-0000-0000-0000-000000000001') then raise exception 'FAIL member cannot read settings'; end if;
  begin
    insert into prepay_list_entries(org_id,phone,source,reason) values ('30900000-0000-0000-0000-000000000001','51922222222','manual','Escrito desde el navegador');
    raise exception 'FAIL authenticated wrote';
  exception when insufficient_privilege then null; end;
  begin
    update prepay_list_settings set auto_mode = 'activo' where org_id = '30900000-0000-0000-0000-000000000001';
    raise exception 'FAIL authenticated switched the rule';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
