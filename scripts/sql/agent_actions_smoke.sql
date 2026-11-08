\set ON_ERROR_STOP on
-- 0323: lo que el agente de IA puede hacer (MOM §42.9). Los interruptores
-- nacen en Simulación con topes 20 y 10 y solo aceptan sus tres posiciones y
-- topes con rango; cada acción solo acepta sus acciones, orígenes y estados,
-- el texto con tope, el hash del texto y del código con forma de sha256 y el
-- código una sola vez; solo el servidor, y el servidor no borra.
begin;

do $test$
declare
  org uuid := '32300000-0000-0000-0000-000000000001';
  store uuid := '32300000-0000-0000-0000-0000000000a1';
  person uuid := '32300000-0000-0000-0000-000000000009';
  tok uuid := '32300000-0000-0000-0000-0000000000f1';
  ord uuid := '32300000-0000-0000-0000-0000000000b1';
  s agent_action_settings;
begin
  -- De fábrica: Simulación, 20 WhatsApp y 10 guías.
  insert into agent_action_settings(org_id) values (org) returning * into s;
  if s.whatsapp_mode <> 'simulacion' or s.guide_mode <> 'simulacion' then raise exception 'FAIL default mode'; end if;
  if s.whatsapp_daily_cap <> 20 or s.guide_daily_cap <> 10 then raise exception 'FAIL default caps'; end if;
  begin
    update agent_action_settings set whatsapp_mode = 'encendido' where org_id = org;
    raise exception 'FAIL unknown mode';
  exception when check_violation then null; end;
  begin
    update agent_action_settings set guide_daily_cap = 0 where org_id = org;
    raise exception 'FAIL zero cap';
  exception when check_violation then null; end;
  begin
    update agent_action_settings set whatsapp_daily_cap = 201 where org_id = org;
    raise exception 'FAIL cap too high';
  exception when check_violation then null; end;
  update agent_action_settings set whatsapp_mode = 'activo', guide_mode = 'apagado', whatsapp_daily_cap = 200, guide_daily_cap = 100 where org_id = org;

  -- Una vista previa de WhatsApp, con su código como sha256.
  insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status, mode, body, body_key, code_hash, code_expires_at)
  values (tok, org, store, ord, person, 'whatsapp', 'chat', 'prevista', 'simulacion', 'Hola, ¿confirmamos tu pedido?', repeat('a', 64), repeat('b', 64), now() + interval '10 minutes');
  -- El mismo código dos veces, no.
  begin
    insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status, code_hash)
    values (tok, org, store, ord, person, 'whatsapp', 'chat', 'prevista', repeat('b', 64));
    raise exception 'FAIL duplicate code';
  exception when unique_violation then null; end;
  -- El código en claro, no.
  begin
    insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status, code_hash)
    values (tok, org, store, ord, person, 'whatsapp', 'chat', 'prevista', 'codigo-en-claro');
    raise exception 'FAIL plain code';
  exception when check_violation then null; end;
  -- Ni cambiar estados ni anular guías: solo sus tres acciones.
  begin
    insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status)
    values (tok, org, store, ord, person, 'anular_guia', 'chat', 'prevista');
    raise exception 'FAIL unknown action';
  exception when check_violation then null; end;
  begin
    insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status)
    values (tok, org, store, ord, person, 'nota', 'otro', 'hecha');
    raise exception 'FAIL unknown origin';
  exception when check_violation then null; end;
  begin
    insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status)
    values (tok, org, store, ord, person, 'nota', 'chat', 'aprobada');
    raise exception 'FAIL unknown status';
  exception when check_violation then null; end;
  begin
    insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status, body)
    values (tok, org, store, ord, person, 'nota', 'chat', 'hecha', repeat('x', 2001));
    raise exception 'FAIL long body';
  exception when check_violation then null; end;
  begin
    insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status, body_key)
    values (tok, org, store, ord, person, 'nota', 'chat', 'hecha', 'texto');
    raise exception 'FAIL body key shape';
  exception when check_violation then null; end;
  begin
    insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status, error_code)
    values (tok, org, store, ord, person, 'guia_aliclik', 'rutina', 'error', 'No se pudo: María 987654321');
    raise exception 'FAIL free text error';
  exception when check_violation then null; end;
  -- Una nota hecha y una guía simulada, como las escribe el servidor.
  insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status, body, body_key, resolved_at)
  values (tok, org, store, ord, person, 'nota', 'rutina', 'hecha', 'La clienta confirmó por Chatby.', repeat('c', 64), now());
  insert into agent_actions(token_id, org_id, store_id, order_id, acting_user, action, origin, status, mode, details, resolved_at)
  values (tok, org, store, ord, person, 'guia_aliclik', 'rutina', 'simulada', 'simulacion', '{"courier":"Urbano","cobrar":89.9}', now());
end $test$;

-- El servidor lee, crea y cambia el estado; no borra.
set local role service_role;
do $$ begin
  update agent_actions set status = 'en_curso' where code_hash = repeat('b', 64) and status = 'prevista';
  update agent_actions set status = 'hecha', resolved_at = now() where code_hash = repeat('b', 64);
  if (select status from agent_actions where code_hash = repeat('b', 64)) <> 'hecha' then raise exception 'FAIL cannot resolve'; end if;
  if (select count(*) from agent_actions where org_id = '32300000-0000-0000-0000-000000000001') <> 3 then raise exception 'FAIL cannot read'; end if;
  update agent_action_settings set whatsapp_mode = 'simulacion' where org_id = '32300000-0000-0000-0000-000000000001';
  begin
    delete from agent_actions where org_id = '32300000-0000-0000-0000-000000000001';
    raise exception 'FAIL service_role deleted an action';
  exception when insufficient_privilege then null; end;
  begin
    delete from agent_action_settings where org_id = '32300000-0000-0000-0000-000000000001';
    raise exception 'FAIL service_role deleted settings';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- El navegador, nada.
set local role authenticated;
do $$ begin
  begin
    perform 1 from agent_actions limit 1;
    raise exception 'FAIL authenticated read actions';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from agent_action_settings limit 1;
    raise exception 'FAIL authenticated read settings';
  exception when insufficient_privilege then null; end;
  begin
    update agent_action_settings set whatsapp_mode = 'activo';
    raise exception 'FAIL authenticated changed settings';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from agent_actions limit 1;
    raise exception 'FAIL anon read actions';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
