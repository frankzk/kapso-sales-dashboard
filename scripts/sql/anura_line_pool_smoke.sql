\set ON_ERROR_STOP on
-- 0313: «Llamar con Anura», líneas compartidas. Una línea compartida no tiene
-- dueña y un anexo propio sí; un número es una sola cosa en la org; la
-- casilla «Puede llamar con Anura» es una por persona y org; una línea nunca
-- tiene dos llamadas vivas (y sigue una viva por persona); una terminada
-- libera la línea; las entrantes no ocupan líneas; RLS de solo lectura.
begin;
insert into organizations(id,name) values ('31300000-0000-0000-0000-000000000001','Anura pool'),
 ('31300000-0000-0000-0000-0000000000f1','Otra org');
insert into auth.users(id) values ('31300000-0000-0000-0000-000000000009'),('31300000-0000-0000-0000-000000000008'),
 ('31300000-0000-0000-0000-000000000007'),('31300000-0000-0000-0000-0000000000f9');
insert into memberships(org_id,user_id,role) values
 ('31300000-0000-0000-0000-000000000001','31300000-0000-0000-0000-000000000009','vendedora'),
 ('31300000-0000-0000-0000-000000000001','31300000-0000-0000-0000-000000000008','vendedora'),
 ('31300000-0000-0000-0000-000000000001','31300000-0000-0000-0000-000000000007','vendedora'),
 ('31300000-0000-0000-0000-0000000000f1','31300000-0000-0000-0000-0000000000f9','owner');

do $test$
declare
  org uuid := '31300000-0000-0000-0000-000000000001';
  other uuid := '31300000-0000-0000-0000-0000000000f1';
  u1 uuid := '31300000-0000-0000-0000-000000000009';
  u2 uuid := '31300000-0000-0000-0000-000000000008';
  u3 uuid := '31300000-0000-0000-0000-000000000007';
  c uuid;
begin
  -- Un anexo propio sigue como en la 0310 (y nace sin pool).
  insert into anura_extensions(org_id,user_id,extension) values (org,u1,'101');
  if (select pool from anura_extensions where org_id = org and extension = '101') is not false then raise exception 'FAIL personal extension born as pool'; end if;
  begin
    insert into anura_extensions(org_id,extension) values (org,'102');
    raise exception 'FAIL personal extension without owner';
  exception when check_violation then null; end;

  -- Líneas compartidas: sin dueña, varias por org.
  insert into anura_extensions(org_id,extension,pool) values (org,'201',true),(org,'202',true),(org,'203',true);
  begin
    insert into anura_extensions(org_id,user_id,extension,pool) values (org,u2,'204',true);
    raise exception 'FAIL pool line with an owner';
  exception when check_violation then null; end;
  begin
    insert into anura_extensions(org_id,extension,pool) values (org,'101',true);
    raise exception 'FAIL pool line reusing a personal extension';
  exception when unique_violation then null; end;
  begin
    insert into anura_extensions(org_id,user_id,extension) values (org,u2,'201');
    raise exception 'FAIL personal extension reusing a pool line';
  exception when unique_violation then null; end;
  insert into anura_extensions(org_id,extension,pool) values (other,'201',true);
  -- El número de una línea con clave: cambiarlo la borra (0311), como a un anexo propio.
  insert into anura_sip_credentials(extension_id,org_id,extension,sip_user,password_cipher)
  select id, org_id, extension, '203-websocket', 'v1:abc' from anura_extensions where org_id = org and extension = '203';
  update anura_extensions set extension = '205' where org_id = org and extension = '203';
  if exists (select 1 from anura_sip_credentials where org_id = org and extension = '203') then raise exception 'FAIL renumbered pool line kept its password'; end if;

  -- «Puede llamar con Anura»: una por persona y org.
  insert into anura_callers(org_id,user_id) values (org,u2);
  if (select enabled from anura_callers where org_id = org and user_id = u2) is not true then raise exception 'FAIL caller born disabled'; end if;
  begin
    insert into anura_callers(org_id,user_id) values (org,u2);
    raise exception 'FAIL two caller rows for one person';
  exception when unique_violation then null; end;
  insert into anura_callers(org_id,user_id,enabled) values (org,u3,false);

  -- Una línea, una llamada viva: dos personas no comparten la 201.
  insert into anura_calls(org_id,user_id,mode,direction,extension,reserved_at)
  values (org,u2,'prueba','out','201',now()) returning id into c;
  if (select reserved_at is not null and dialed_at is null from anura_calls where id = c) is not true then raise exception 'FAIL reservation columns'; end if;
  begin
    insert into anura_calls(org_id,user_id,mode,direction,extension,reserved_at) values (org,u3,'prueba','out','201',now());
    raise exception 'FAIL two live calls on one line';
  exception when unique_violation then null; end;
  -- Otra línea sí; la misma persona no (una viva por persona, 0310).
  insert into anura_calls(org_id,user_id,mode,direction,extension,reserved_at) values (org,u3,'prueba','out','202',now());
  begin
    insert into anura_calls(org_id,user_id,mode,direction,extension,reserved_at) values (org,u2,'prueba','out','205',now());
    raise exception 'FAIL two live calls for one person';
  exception when unique_violation then null; end;
  -- La misma línea en otra org no choca.
  insert into anura_calls(org_id,user_id,mode,direction,extension) values (other,'31300000-0000-0000-0000-0000000000f9','prueba','out','201');
  -- Pedir el Click2Dial deja la fila viva; terminada, la línea queda libre.
  update anura_calls set dialed_at = now(), phone = '987654321' where id = c;
  update anura_calls set status = 'fallida', status_rank = 100, failure_reason = 'La llamada no llegó a pedirse.' where id = c;
  insert into anura_calls(org_id,user_id,mode,direction,extension,reserved_at) values (org,u1,'prueba','out','201',now());
  -- Las entrantes no ocupan líneas.
  insert into anura_calls(org_id,mode,direction,extension,status,status_rank,anura_call_id)
  values (org,'entrante','in','202','sonando',10,'cdr-pool-1');
  -- Los índices de la 0310 siguen.
  if to_regclass('public.anura_calls_one_active_per_user') is null then raise exception 'FAIL per-user index gone'; end if;
  if to_regclass('public.anura_calls_one_active_per_extension') is null then raise exception 'FAIL per-extension index missing'; end if;
end $test$;

-- RLS: las líneas y las casillas las lee la org; nadie escribe desde el navegador.
select set_config('request.test_uid', '31300000-0000-0000-0000-000000000009', true) \gset
set local role authenticated;
do $$ begin
  if (select count(*) from anura_extensions where pool) <> 3 then raise exception 'FAIL member reads the pool lines of its org only'; end if;
  if (select count(*) from anura_callers) <> 2 then raise exception 'FAIL member reads the callers of its org'; end if;
  begin
    insert into anura_callers(org_id,user_id) values ('31300000-0000-0000-0000-000000000001','31300000-0000-0000-0000-000000000009');
    raise exception 'FAIL authenticated checked «Puede llamar con Anura»';
  exception when insufficient_privilege then null; end;
  begin
    update anura_callers set enabled = true where org_id = '31300000-0000-0000-0000-000000000001';
    raise exception 'FAIL authenticated changed a caller';
  exception when insufficient_privilege then null; end;
  begin
    insert into anura_extensions(org_id,extension,pool) values ('31300000-0000-0000-0000-000000000001','206',true);
    raise exception 'FAIL authenticated added a pool line';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.test_uid', '31300000-0000-0000-0000-0000000000f9', true) \gset
set local role authenticated;
do $$ begin
  if exists (select 1 from anura_callers) then raise exception 'FAIL other org reads the callers'; end if;
  if (select count(*) from anura_extensions where pool) <> 1 then raise exception 'FAIL other org reads foreign pool lines'; end if;
end $$;
reset role;
rollback;
