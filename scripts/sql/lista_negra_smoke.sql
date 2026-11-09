\set ON_ERROR_STOP on
-- 0329: «Lista negra» unificada (MOM §41). Cada alta a mano dice lo que pide
-- (`adelanto` o `pago_completo`; por defecto y en las filas de antes, el
-- total), solo esos dos valores, y no se reescribe; la búsqueda guarda solo
-- quién y cuándo (nunca el celular) y el navegador no la ve.
begin;
insert into organizations(id,name) values ('32900000-0000-0000-0000-000000000001','Lista negra smoke');
insert into auth.users(id) values ('32900000-0000-0000-0000-000000000009');
insert into memberships(org_id,user_id,role) values ('32900000-0000-0000-0000-000000000001','32900000-0000-0000-0000-000000000009','owner');

do $test$
declare
  org uuid := '32900000-0000-0000-0000-000000000001';
  e uuid;
  a uuid;
begin
  -- Por defecto, el total: lo de siempre.
  insert into prepay_list_entries(org_id,phone,source,reason) values (org,'51987654321','manual','Fraude con otra cuenta')
  returning id into e;
  if (select requirement from prepay_list_entries where id = e) <> 'pago_completo' then raise exception 'FAIL default requirement'; end if;
  -- El adelanto también.
  insert into prepay_list_entries(org_id,phone,source,reason,requirement) values (org,'51911111111','manual','Avisó que no va a recibir','adelanto')
  returning id into a;
  if (select requirement from prepay_list_entries where id = a) <> 'adelanto' then raise exception 'FAIL adelanto'; end if;
  -- Nada más.
  begin
    insert into prepay_list_entries(org_id,phone,source,reason,requirement) values (org,'51922222222','manual','Requisito inventado','gratis');
    raise exception 'FAIL unknown requirement';
  exception when check_violation then null; end;
  -- No se reescribe.
  begin
    update prepay_list_entries set requirement = 'adelanto' where id = e;
    raise exception 'FAIL rewrote requirement';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Sacarla sigue igual.
  update prepay_list_entries set removed_at = now(), removed_reason = 'Era otra persona, se comprobó' where id = e;

  -- La búsqueda: quién y cuándo.
  insert into lista_negra_searches(org_id,user_id) values (org,'32900000-0000-0000-0000-000000000009');
  if (select count(*) from lista_negra_searches where org_id = org) <> 1 then raise exception 'FAIL search log'; end if;
  if exists (select 1 from information_schema.columns where table_name = 'lista_negra_searches' and column_name ilike '%phone%') then
    raise exception 'FAIL the search log keeps a phone';
  end if;
end $test$;

-- El navegador no ve las búsquedas ni las escribe; las altas, como en la 0309.
select set_config('request.test_uid', '32900000-0000-0000-0000-000000000009', true) \gset
set local role authenticated;
do $$ begin
  begin
    perform 1 from lista_negra_searches;
    raise exception 'FAIL authenticated read searches';
  exception when insufficient_privilege then null; end;
  if not exists (select 1 from prepay_list_entries where requirement = 'adelanto') then raise exception 'FAIL member cannot read requirement'; end if;
end $$;
reset role;
rollback;
