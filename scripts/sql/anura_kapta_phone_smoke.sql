\set ON_ERROR_STOP on
-- 0311: «Llamar con Anura», fase 2 (el teléfono dentro de Kapta). Ajustes SIP
-- por org con valores por defecto (wss://sipwss.anura.pe, 55090), solo hosts
-- de anura.pe; la clave SIP va cifrada («v1:»), colgada del anexo: quitar el
-- anexo o cambiarle el número la borra, apagarlo no; «clave rechazada» lleva
-- fecha y motivo juntos; RLS: los ajustes los lee la org y las credenciales
-- nadie desde el navegador.
begin;
insert into organizations(id,name) values ('31100000-0000-0000-0000-000000000001','Anura fase 2'),
 ('31100000-0000-0000-0000-0000000000f1','Otra org');
insert into auth.users(id) values ('31100000-0000-0000-0000-000000000009'),('31100000-0000-0000-0000-000000000008'),
 ('31100000-0000-0000-0000-0000000000f9');
insert into memberships(org_id,user_id,role) values
 ('31100000-0000-0000-0000-000000000001','31100000-0000-0000-0000-000000000009','vendedora'),
 ('31100000-0000-0000-0000-000000000001','31100000-0000-0000-0000-000000000008','vendedora'),
 ('31100000-0000-0000-0000-0000000000f1','31100000-0000-0000-0000-0000000000f9','owner');

do $test$
declare
  org uuid := '31100000-0000-0000-0000-000000000001';
  other uuid := '31100000-0000-0000-0000-0000000000f1';
  u1 uuid := '31100000-0000-0000-0000-000000000009';
  u2 uuid := '31100000-0000-0000-0000-000000000008';
  e1 uuid;
  e2 uuid;
begin
  -- Ajustes SIP por org: nacen con la URL y el puerto de Perú.
  insert into anura_sip_settings(org_id, sip_domain) values (org, 'kenku.anura.pe');
  if (select ws_url from anura_sip_settings where org_id = org) <> 'wss://sipwss.anura.pe' then raise exception 'FAIL default ws url'; end if;
  if (select sip_port from anura_sip_settings where org_id = org) <> 55090 then raise exception 'FAIL default sip port'; end if;
  begin
    update anura_sip_settings set ws_url = 'wss://sip.anura.dev' where org_id = org;
    raise exception 'FAIL ws url outside anura.pe';
  exception when check_violation then null; end;
  begin
    update anura_sip_settings set ws_url = 'ws://sipwss.anura.pe' where org_id = org;
    raise exception 'FAIL insecure ws url';
  exception when check_violation then null; end;
  begin
    update anura_sip_settings set ws_url = 'wss://sipwss.anura.pe:8089' where org_id = org;
    raise exception 'FAIL ws url with a port the CSP does not allow';
  exception when check_violation then null; end;
  begin
    update anura_sip_settings set ws_url = 'wss://sipwss.anura.pe.evil.com' where org_id = org;
    raise exception 'FAIL ws url that only starts like anura.pe';
  exception when check_violation then null; end;
  begin
    update anura_sip_settings set sip_domain = 'sip:Kenku.anura.pe:55090' where org_id = org;
    raise exception 'FAIL domain with scheme or port';
  exception when check_violation then null; end;
  begin
    update anura_sip_settings set sip_port = 70000 where org_id = org;
    raise exception 'FAIL port out of range';
  exception when check_violation then null; end;
  insert into anura_sip_settings(org_id) values (other);

  -- La clave va cifrada y colgada del anexo.
  insert into anura_extensions(org_id,user_id,extension) values (org,u1,'101') returning id into e1;
  insert into anura_extensions(org_id,user_id,extension) values (org,u2,'102') returning id into e2;
  begin
    insert into anura_sip_credentials(extension_id,org_id,extension,sip_user,password_cipher)
    values (e1,org,'101','101-websocket','clave-en-claro');
    raise exception 'FAIL plaintext password accepted';
  exception when check_violation then null; end;
  begin
    insert into anura_sip_credentials(extension_id,org_id,extension,sip_user,password_cipher)
    values (e1,org,'101','101 websocket@x','v1:abc');
    raise exception 'FAIL bad sip user accepted';
  exception when check_violation then null; end;
  insert into anura_sip_credentials(extension_id,org_id,extension,sip_user,password_cipher)
  values (e1,org,'101','101-websocket','v1:abc');
  insert into anura_sip_credentials(extension_id,org_id,extension,sip_user,password_cipher)
  values (e2,org,'102','102-websocket','v1:def');
  begin
    insert into anura_sip_credentials(extension_id,org_id,extension,sip_user,password_cipher)
    values (e1,org,'101','101-websocket','v1:otra');
    raise exception 'FAIL two passwords for one extension';
  exception when unique_violation then null; end;

  -- «Clave rechazada»: fecha y motivo van juntos.
  begin
    update anura_sip_credentials set rejected_at = now() where extension_id = e1;
    raise exception 'FAIL rejected without reason';
  exception when check_violation then null; end;
  update anura_sip_credentials set rejected_at = now(), rejected_reason = 'Anura rechazó la clave (401).' where extension_id = e1;

  -- Apagar el anexo no borra la clave; cambiarle el número sí; quitarlo también.
  update anura_extensions set active = false where id = e1;
  if not exists (select 1 from anura_sip_credentials where extension_id = e1) then raise exception 'FAIL turning off removed the password'; end if;
  update anura_extensions set active = true, extension = '103' where id = e1;
  if exists (select 1 from anura_sip_credentials where extension_id = e1) then raise exception 'FAIL new extension number kept the old password'; end if;
  delete from anura_extensions where id = e2;
  if exists (select 1 from anura_sip_credentials where extension_id = e2) then raise exception 'FAIL removing the extension left its password'; end if;
  insert into anura_sip_credentials(extension_id,org_id,extension,sip_user,password_cipher)
  values (e1,org,'103','103-websocket','v1:ghi');
end $test$;

-- RLS: los ajustes SIP los lee la org; las credenciales nadie; nadie escribe.
select set_config('request.test_uid', '31100000-0000-0000-0000-000000000009', true) \gset
set local role authenticated;
do $$ begin
  if (select count(*) from anura_sip_settings) <> 1 then raise exception 'FAIL member reads sip settings of its org only'; end if;
  begin
    perform 1 from anura_sip_credentials limit 1;
    raise exception 'FAIL authenticated read the sip passwords';
  exception when insufficient_privilege then null; end;
  begin
    update anura_sip_settings set sip_port = 5060 where org_id = '31100000-0000-0000-0000-000000000001';
    raise exception 'FAIL authenticated changed the sip settings';
  exception when insufficient_privilege then null; end;
  begin
    insert into anura_sip_credentials(extension_id,org_id,extension,sip_user,password_cipher)
    select id, org_id, extension, 'x', 'v1:x' from anura_extensions limit 1;
    raise exception 'FAIL authenticated wrote a sip password';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
