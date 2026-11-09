\set ON_ERROR_STOP on
-- 0326: «Pago solo online (lista automática)» (MOM §41.11). La regla (últimos
-- 9 dígitos, las tiendas de la organización juntas, solo contra entrega, sin
-- los pedidos de la migración de plataforma, 0 recibidas y (A) 1+ devuelto o
-- (B) 5+ pedidos con el 75 % o más anulados), los correos de
-- un solo celular, la excepción de Kapta, lo que se guarda en Activo y no en
-- Simulación, el freno de un celular (solo en Activo y con la corrida
-- vigente), lo de Por confirmar, la posición que nace apagada y en
-- «adelanto», y la RLS: el navegador lee cuentas, nunca los celulares.
begin;
insert into organizations(id,name) values ('32600000-0000-0000-0000-000000000001','Pago online smoke'),
 ('32600000-0000-0000-0000-0000000000f1','Otra org');
insert into auth.users(id) values ('32600000-0000-0000-0000-000000000009'),('32600000-0000-0000-0000-0000000000f9');
insert into memberships(org_id,user_id,role) values
 ('32600000-0000-0000-0000-000000000001','32600000-0000-0000-0000-000000000009','owner'),
 ('32600000-0000-0000-0000-0000000000f1','32600000-0000-0000-0000-0000000000f9','owner');
insert into stores(id,org_id,name,shopify_domain) values
 ('32600000-0000-0000-0000-000000000002','32600000-0000-0000-0000-000000000001','Kenku smoke','kenku-smoke.test'),
 ('32600000-0000-0000-0000-000000000003','32600000-0000-0000-0000-000000000001','Aurela smoke','aurela-smoke.test'),
 ('32600000-0000-0000-0000-0000000000f2','32600000-0000-0000-0000-0000000000f1','Otra tienda','otra-smoke.test');

-- n | tienda | celular          | cobertura     | estado     | salió | correo
--  1 | K | +51 987 654 321      | lima          | devuelto   | sí    | a@x.pe      → 987654321: devuelto
--  2 | A | 987654321            | provincia_cod | devuelto   | sí    |             → 987654321: 2.º devuelto (las dos tiendas juntas)
--  3 | K | 51912345678          | lima          | anulado    | sí    |             → 912345678: un anulado después de salir, solo, ya no basta
--  4 | K | 913000000            | provincia_cod | devuelto   | sí    | c@x.pe      → 913000000: fallida…
--  5 | A | 913000000            | lima          | entregado  | sí    |             → …y recibida: no entra
--  6 | K | 914000000            | agencia       | devuelto   | sí    |             → agencia: no cuenta
--  7 | K | 915000000            | lima          | devuelto   | sí    | shared@x.pe → 915000000: entra, el correo es compartido
--  8 | A | 916000000            | lima          | entregado  | sí    | shared@x.pe
--  9 | K | 12345                | lima          | devuelto   | sí    |             → sin 9 dígitos: no entra
-- 10 | K | 917000000            | lima          | devuelto   | sí    |             → exceptuado por Kapta
-- 11 | O | 987654321            | lima          | entregado  | sí    |             → otra organización: no cambia nada
-- 12 | K | 987654321            | lima          | pendiente  | no    |             → Por confirmar, sin pago: se frena
-- 13 | A | 915000000            | lima          | pendiente  | no    |             → Por confirmar, adelanto validado
-- 14 | K | 918000000            | lima          | devuelto   | sí    |             → cancelled_woocommerce: artefacto de la migración, no cuenta
-- 15 | A | 919000000            | lima          | entregado  | sí    |             → legacy_shopify_sale_cancelled: no cuenta (ni como entrega)…
-- 16 | A | 919000000            | lima          | devuelto   | sí    |             → …y su devuelto sí: entra con 1 de 1 pedido
-- 17 | K | 920000000            | provincia_cod | devuelto   | sí    |             → woo_sale_ended_pending_return: no entra
-- El «anulador» (B), pedidos #PA<celular>-<n>, todos contra entrega:
--   921000000: 5 pedidos, 4 anulados (antes y después de salir)  → entra: anuló 4 de 5
--   922000000: 4 pedidos, 4 anulados                              → no: menos de 5
--   923000000: 5 pedidos, 3 anulados                              → no: 60 %
--   924000000: 6 pedidos, 5 anulados y 1 entregado                → no: recibió
--   925000000: 5 anulados, 1 con cancelled_woocommerce            → no: cuentan 4
--   926000000: 8 pedidos, 6 anulados                              → entra: 75 % justo
insert into orders(id,store_id,shopify_order_id,name,customer_phone,raw)
 select ('32600000-0000-0000-0001-' || lpad(v.n::text,12,'0'))::uuid, v.store::uuid, 'po-'||v.n, '#PO'||v.n, v.phone,
   case when v.email is null then '{}'::jsonb else jsonb_build_object('woo', jsonb_build_object('billing', jsonb_build_object('email', v.email))) end
 from (values
   (1,'32600000-0000-0000-0000-000000000002','+51 987 654 321','A@X.pe '),
   (2,'32600000-0000-0000-0000-000000000003','987654321',null),
   (3,'32600000-0000-0000-0000-000000000002','51912345678',null),
   (4,'32600000-0000-0000-0000-000000000002','913000000','c@x.pe'),
   (5,'32600000-0000-0000-0000-000000000003','913000000',null),
   (6,'32600000-0000-0000-0000-000000000002','914000000',null),
   (7,'32600000-0000-0000-0000-000000000002','915000000','shared@x.pe'),
   (8,'32600000-0000-0000-0000-000000000003','916000000','shared@x.pe'),
   (9,'32600000-0000-0000-0000-000000000002','12345',null),
   (10,'32600000-0000-0000-0000-000000000002','917000000',null),
   (11,'32600000-0000-0000-0000-0000000000f2','987654321',null),
   (12,'32600000-0000-0000-0000-000000000002','987654321',null),
   (13,'32600000-0000-0000-0000-000000000003','915000000',null),
   (14,'32600000-0000-0000-0000-000000000002','918000000',null),
   (15,'32600000-0000-0000-0000-000000000003','919000000',null),
   (16,'32600000-0000-0000-0000-000000000003','919000000',null),
   (17,'32600000-0000-0000-0000-000000000002','920000000',null)
 ) as v(n, store, phone, email);
insert into orders(id,store_id,shopify_order_id,name,customer_phone)
 select gen_random_uuid(), '32600000-0000-0000-0000-000000000002', 'pa-'||v.phone||'-'||g, '#PA'||v.phone||'-'||g, v.phone
 from (values ('921000000',5), ('922000000',4), ('923000000',5), ('924000000',6), ('925000000',5), ('926000000',8)) as v(phone, n)
 cross join lateral generate_series(1, v.n) g;
insert into order_master(order_id,store_id,shopify_order_id,order_name,customer_phone,coverage,general_status,dispatched_at)
 select o.id, o.store_id, o.shopify_order_id, o.name, o.customer_phone, v.coverage, v.status,
   case when v.out then '2026-10-01T15:00:00Z'::timestamptz end
 from orders o join (values
   ('#PO1','lima','devuelto',true), ('#PO2','provincia_cod','devuelto',true), ('#PO3','lima','anulado',true),
   ('#PO4','provincia_cod','devuelto',true), ('#PO5','lima','entregado',true), ('#PO6','agencia','devuelto',true),
   ('#PO7','lima','devuelto',true), ('#PO8','lima','entregado',true), ('#PO9','lima','devuelto',true),
   ('#PO10','lima','devuelto',true), ('#PO11','lima','entregado',true), ('#PO12','lima','pendiente',false),
   ('#PO13','lima','pendiente',false), ('#PO14','lima','devuelto',true), ('#PO15','lima','entregado',true),
   ('#PO16','lima','devuelto',true), ('#PO17','provincia_cod','devuelto',true)
 ) as v(name, coverage, status, out) on v.name = o.name
 where o.shopify_order_id like 'po-%';
-- El anulador: los primeros N de cada celular, anulados (los impares después de salir).
insert into order_master(order_id,store_id,shopify_order_id,order_name,customer_phone,coverage,general_status,dispatched_at)
 select o.id, o.store_id, o.shopify_order_id, o.name, o.customer_phone, 'lima',
   case when g <= v.anulados then 'anulado' when v.phone = '924000000' then 'entregado' else 'pendiente' end,
   case when g % 2 = 1 then '2026-10-01T15:00:00Z'::timestamptz end
 from orders o
 join (values ('921000000',4), ('922000000',4), ('923000000',3), ('924000000',5), ('925000000',5), ('926000000',6)) as v(phone, anulados)
   on o.customer_phone = v.phone
 cross join lateral (select split_part(o.shopify_order_id, '-', 3)::int as g) n
 where o.shopify_order_id like 'pa-%';
-- Los hechos de la migración de plataforma (MOM §38): esos anulados no son fallas.
insert into order_events(store_id, order_id, kind, source)
 select o.store_id, o.id, v.kind, 'system'
 from orders o join (values ('#PO14','cancelled_woocommerce'), ('#PO15','legacy_shopify_sale_cancelled'),
   ('#PO17','woo_sale_ended_pending_return'), ('#PO1','comment'), ('#PA925000000-1','cancelled_woocommerce')) as v(name, kind)
   on v.name = o.name
 where o.shopify_order_id like 'po-%' or o.shopify_order_id like 'pa-%';
-- La cobertura la calcula un trigger desde el destino: aquí se fija a mano,
-- sin él (solo dentro de esta transacción).
alter table order_master disable trigger order_master_coverage;
update order_master om set coverage = v.coverage
 from (values ('#PO1','lima'), ('#PO2','provincia_cod'), ('#PO3','lima'), ('#PO4','provincia_cod'), ('#PO5','lima'),
   ('#PO6','agencia'), ('#PO7','lima'), ('#PO8','lima'), ('#PO9','lima'), ('#PO10','lima'), ('#PO11','lima'),
   ('#PO12','lima'), ('#PO13','lima'), ('#PO14','lima'), ('#PO15','lima'), ('#PO16','lima'),
   ('#PO17','provincia_cod')) as v(name, coverage)
 where om.order_name = v.name and om.shopify_order_id like 'po-%';
update order_master set coverage = 'lima', macro_stage = 'finalizado' where shopify_order_id like 'pa-%';
update order_master set macro_stage = 'por_confirmar' where order_name in ('#PO12','#PO13') and shopify_order_id like 'po-%';
update order_master set macro_stage = 'finalizado' where order_name not in ('#PO12','#PO13') and shopify_order_id like 'po-%';
update order_master set payment_state = 'adelanto_validado' where order_name = '#PO13' and shopify_order_id like 'po-%';
alter table order_master enable trigger order_master_coverage;
insert into pago_online_exceptions(org_id, phone, reason, order_name)
 values ('32600000-0000-0000-0000-000000000001', '917000000', 'Pagó el pedido anterior por Yape', '#PO10');

do $test$
declare
  org uuid := '32600000-0000-0000-0000-000000000001';
  other uuid := '32600000-0000-0000-0000-0000000000f1';
  run uuid;
  sim jsonb;
  act jsonb;
  r record;
begin
  -- La regla.
  if (select string_agg(phone || ':' || reason || ':' || failed || '/' || orders || ':' || excepted, ',' order by phone) from pago_online_candidates(org))
     is distinct from '915000000:devuelto:1/2:false,917000000:devuelto:1/1:true,919000000:devuelto:1/1:false,'
       || '921000000:anulador:4/5:false,926000000:anulador:6/8:false,987654321:devuelto:2/3:false' then
    raise exception 'FAIL candidates: %',
      (select string_agg(phone || ':' || reason || ':' || failed || '/' || orders || ':' || excepted, ',' order by phone) from pago_online_candidates(org));
  end if;
  -- El correo en minúsculas, y el compartido no va.
  if (select emails from pago_online_candidates(org) where phone = '987654321') is distinct from array['a@x.pe'] then
    raise exception 'FAIL emails of 987654321';
  end if;
  if (select cardinality(emails) from pago_online_candidates(org) where phone = '915000000') <> 0 then
    raise exception 'FAIL shared email sent';
  end if;
  -- La otra organización no tiene a nadie.
  if exists (select 1 from pago_online_candidates(other)) then raise exception 'FAIL other org listed'; end if;

  -- Nace apagada y en «adelanto».
  insert into pago_online_settings(org_id) values (org);
  if (select mode || ':' || requirement from pago_online_settings where org_id = org) <> 'apagado:adelanto' then
    raise exception 'FAIL defaults';
  end if;
  begin
    update pago_online_settings set requirement = 'medio' where org_id = org;
    raise exception 'FAIL unknown requirement';
  exception when check_violation then null; end;
  begin
    update pago_online_settings set mode = 'encendido' where org_id = org;
    raise exception 'FAIL unknown mode';
  exception when check_violation then null; end;

  -- Simulación: cuenta y no guarda celulares.
  sim := pago_online_build(org, null, 'adelanto');
  if (sim->>'phones')::int <> 5 or (sim->>'emails')::int <> 1 or (sim->>'two_or_more')::int <> 1
     or (sim->>'anuladores')::int <> 2 or (sim->>'excepted')::int <> 1 then
    raise exception 'FAIL simulation counts %', sim;
  end if;
  -- Por confirmar: #PO12 (987654321, sin pago) y #PO13 (915000000, adelanto validado).
  if (sim->>'por_confirmar_listed')::int <> 2 or (sim->>'por_confirmar_braked')::int <> 1 then
    raise exception 'FAIL por confirmar with adelanto %', sim;
  end if;
  if (pago_online_build(org, null, 'pago_completo')->>'por_confirmar_braked')::int <> 2 then
    raise exception 'FAIL por confirmar with pago completo';
  end if;
  if exists (select 1 from pago_online_phones where org_id = org) then raise exception 'FAIL simulation stored phones'; end if;

  -- Activo: guarda los celulares de la corrida, y correrla dos veces no duplica.
  insert into pago_online_runs(org_id, run_date, mode, trigger, daily_key, requirement)
    values (org, '2026-11-10', 'activo', 'cron', '2026-11-10:activo', 'adelanto') returning id into run;
  begin
    insert into pago_online_runs(org_id, run_date, mode, trigger, daily_key, requirement)
      values (org, '2026-11-10', 'activo', 'cron', '2026-11-10:activo', 'adelanto');
    raise exception 'FAIL two daily runs';
  exception when unique_violation then null; end;
  act := pago_online_build(org, run, 'adelanto');
  act := pago_online_build(org, run, 'adelanto');
  if (select count(*) from pago_online_phones where run_id = run) <> 5 then raise exception 'FAIL stored phones'; end if;
  if (select reason || ':' || failed || '/' || orders from pago_online_phones where run_id = run and phone = '921000000') <> 'anulador:4/5' then
    raise exception 'FAIL stored anulador';
  end if;
  begin
    insert into pago_online_phones(run_id, org_id, phone, failed, reason) values (run, org, '911111111', 1, 'otro');
    raise exception 'FAIL unknown reason stored';
  exception when check_violation then null; end;
  begin
    insert into pago_online_phones(run_id, org_id, phone, failed) values (run, org, '51987654321', 1);
    raise exception 'FAIL 11-digit phone stored';
  exception when check_violation then null; end;

  -- El freno: nada hasta Activo con la corrida vigente.
  if exists (select 1 from pago_online_lookup(org, '987654321')) then raise exception 'FAIL lookup while apagado'; end if;
  update pago_online_settings set mode = 'activo' where org_id = org;
  select * into r from pago_online_lookup(org, '987654321');
  if r.listed is distinct from false then raise exception 'FAIL lookup without current run'; end if;
  update pago_online_settings set current_run_id = run where org_id = org;
  select * into r from pago_online_lookup(org, '987654321');
  if r.listed is not true or r.failed <> 2 or r.reason <> 'devuelto' or r.orders <> 3 or r.requirement <> 'adelanto' then raise exception 'FAIL lookup listed'; end if;
  select * into r from pago_online_lookup(org, '926000000');
  if r.listed is not true or r.reason <> 'anulador' or r.failed <> 6 or r.orders <> 8 then raise exception 'FAIL lookup anulador'; end if;
  select * into r from pago_online_lookup(org, '913000000');
  if r.listed is not false then raise exception 'FAIL lookup received customer'; end if;
  if exists (select 1 from pago_online_lookup(other, '987654321')) then raise exception 'FAIL lookup other org'; end if;
  -- Una excepción de Kapta del mismo día manda sobre la corrida.
  insert into pago_online_exceptions(org_id, phone, reason) values (org, '987654321', 'Clienta conocida del equipo');
  select * into r from pago_online_lookup(org, '987654321');
  if r.listed is not false then raise exception 'FAIL exception ignored'; end if;
  begin
    insert into pago_online_exceptions(org_id, phone, reason) values (org, '987654321', 'Otra vez la misma');
    raise exception 'FAIL two live exceptions';
  exception when unique_violation then null; end;
  begin
    update pago_online_exceptions set removed_at = now() where org_id = org and phone = '987654321';
    raise exception 'FAIL removed without reason';
  exception when check_violation then null; end;
  update pago_online_exceptions set removed_at = now(), removed_reason = 'Ya no hace falta' where org_id = org and phone = '987654321';
  select * into r from pago_online_lookup(org, '987654321');
  if r.listed is not true then raise exception 'FAIL removed exception still applies'; end if;
  begin
    insert into pago_online_exceptions(org_id, phone, reason) values (org, '9876', 'Celular corto');
    raise exception 'FAIL short phone exception';
  exception when check_violation then null; end;

  -- El registro de envíos: un intento por corrida, tienda y número.
  insert into pago_online_sends(org_id, store_id, run_id, kind, attempt, status)
    values (org, '32600000-0000-0000-0000-000000000002', run, 'diaria', 1, 'reintento');
  begin
    insert into pago_online_sends(org_id, store_id, run_id, kind, attempt)
      values (org, '32600000-0000-0000-0000-000000000002', run, 'diaria', 1);
    raise exception 'FAIL same attempt twice';
  exception when unique_violation then null; end;
  begin
    insert into pago_online_sends(org_id, store_id, run_id, kind, attempt)
      values (org, '32600000-0000-0000-0000-000000000002', run, 'diaria', 5);
    raise exception 'FAIL fifth attempt';
  exception when check_violation then null; end;
  begin
    insert into pago_online_sends(org_id, store_id, kind, status) values (org, '32600000-0000-0000-0000-000000000002', 'prueba', 'perdido');
    raise exception 'FAIL unknown send status';
  exception when check_violation then null; end;
  -- Borrar la corrida no se lleva el registro de envíos.
  update pago_online_settings set current_run_id = null where org_id = org;
  delete from pago_online_runs where id = run;
  if exists (select 1 from pago_online_phones where run_id = run) then raise exception 'FAIL phones outlived the run'; end if;
  if (select count(*) from pago_online_sends where org_id = org) <> 1 then raise exception 'FAIL send log lost'; end if;
end $test$;

-- RLS: la organización lee la posición, las corridas, los envíos y las
-- excepciones; los celulares de la lista no los lee nadie desde el navegador,
-- ni las funciones del servidor.
insert into pago_online_runs(id, org_id, run_date, mode, trigger, requirement, phones)
  values ('32600000-0000-0000-0002-000000000001', '32600000-0000-0000-0000-000000000001', '2026-11-11', 'activo', 'manual', 'adelanto', 2);
select pago_online_build('32600000-0000-0000-0000-000000000001', '32600000-0000-0000-0002-000000000001', 'adelanto') \gset
select set_config('request.test_uid', '32600000-0000-0000-0000-000000000009', true) \gset
set local role authenticated;
do $$ begin
  if (select count(*) from pago_online_settings) <> 1 then raise exception 'FAIL member cannot read settings'; end if;
  if (select count(*) from pago_online_runs) <> 1 then raise exception 'FAIL member cannot read runs'; end if;
  if (select count(*) from pago_online_sends) <> 1 then raise exception 'FAIL member cannot read sends'; end if;
  if (select count(*) from pago_online_exceptions) <> 2 then raise exception 'FAIL member cannot read exceptions'; end if;
  begin
    perform count(*) from pago_online_phones;
    raise exception 'FAIL member read the phones';
  exception when insufficient_privilege then null; end;
  begin
    perform * from pago_online_lookup('32600000-0000-0000-0000-000000000001', '987654321');
    raise exception 'FAIL member ran the lookup';
  exception when insufficient_privilege then null; end;
  begin
    perform pago_online_build('32600000-0000-0000-0000-000000000001', null, 'adelanto');
    raise exception 'FAIL member ran the build';
  exception when insufficient_privilege then null; end;
  begin
    update pago_online_settings set mode = 'apagado';
    if found then raise exception 'FAIL member switched the mode'; end if;
  exception when insufficient_privilege then null; end;
  begin
    insert into pago_online_exceptions(org_id, phone, reason) values ('32600000-0000-0000-0000-000000000001', '911111111', 'Desde el navegador');
    raise exception 'FAIL member wrote an exception';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.test_uid', '32600000-0000-0000-0000-0000000000f9', true) \gset
set local role authenticated;
do $$ begin
  if exists (select 1 from pago_online_settings) or exists (select 1 from pago_online_runs)
     or exists (select 1 from pago_online_sends) or exists (select 1 from pago_online_exceptions) then
    raise exception 'FAIL other org reads';
  end if;
end $$;
reset role;
rollback;
