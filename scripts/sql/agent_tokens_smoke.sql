\set ON_ERROR_STOP on
-- 0314: el conector de Kapta para agentes de IA (MOM §42). El token se guarda
-- solo como sha256 (64 hexadecimales) y único; la pista es `kagt_` + 4; tiendas
-- y permisos con su rango, y los permisos de la lista cerrada; el registro de
-- llamadas guarda códigos, no texto libre. Ninguna de las dos tablas se ve ni
-- se escribe desde el navegador: solo el servidor (service_role).
begin;

do $test$
declare
  org uuid := '31400000-0000-0000-0000-000000000001';
  creator uuid := '31400000-0000-0000-0000-000000000009';
  store uuid := '31400000-0000-0000-0000-0000000000a1';
  h text := repeat('a', 64);
  t uuid;
begin
  insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes)
  values (org, creator, 'Grok Bot · atención', h, 'kagt_AbC-', array[store], array['pedidos.leer', 'politicas.leer'])
  returning id into t;
  if (select revoked_at from agent_tokens where id = t) is not null then raise exception 'FAIL born revoked'; end if;

  -- El hash es único: dos tokens nunca comparten secreto.
  begin
    insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes)
    values (org, creator, 'Otro', h, 'kagt_ZzZz', array[store], array['pedidos.leer']);
    raise exception 'FAIL duplicated hash';
  exception when unique_violation then null; end;

  -- Lo que no es un sha256 hexadecimal no se guarda (ni el token en claro).
  begin
    insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes)
    values (org, creator, 'En claro', 'kagt_' || repeat('x', 43), 'kagt_xxxx', array[store], array['pedidos.leer']);
    raise exception 'FAIL plain token stored';
  exception when check_violation then null; end;
  -- La pista es el prefijo y cuatro caracteres, no más.
  begin
    insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes)
    values (org, creator, 'Pista larga', repeat('b', 64), 'kagt_AbCdEfGh', array[store], array['pedidos.leer']);
    raise exception 'FAIL long hint';
  exception when check_violation then null; end;
  -- Un nombre vacío no.
  begin
    insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes)
    values (org, creator, '   ', repeat('c', 64), 'kagt_cccc', array[store], array['pedidos.leer']);
    raise exception 'FAIL blank label';
  exception when check_violation then null; end;
  -- Al menos una tienda y un permiso.
  begin
    insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes)
    values (org, creator, 'Sin tiendas', repeat('d', 64), 'kagt_dddd', array[]::uuid[], array['pedidos.leer']);
    raise exception 'FAIL no stores';
  exception when check_violation then null; end;
  begin
    insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes)
    values (org, creator, 'Sin permisos', repeat('e', 64), 'kagt_eeee', array[store], array[]::text[]);
    raise exception 'FAIL no scopes';
  exception when check_violation then null; end;
  -- Un permiso inventado no.
  begin
    insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes)
    values (org, creator, 'Inventado', repeat('f', 64), 'kagt_ffff', array[store], array['pedidos.leer', 'pedidos.anular']);
    raise exception 'FAIL unknown scope';
  exception when check_violation then null; end;
  -- Los de escritura existen desde ya (partes 2 y 3).
  insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes)
  values (org, creator, 'Con escritura', repeat('0', 64), 'kagt_0000', array[store],
          array['pedidos.nota', 'whatsapp.enviar', 'aliclik.crear_guia']);

  -- El registro guarda códigos, no texto libre.
  insert into agent_tool_calls(token_id, tool, store_id, ok, duration_ms) values (t, 'obtener_pedido', store, true, 120);
  insert into agent_tool_calls(token_id, tool, ok, error_code, duration_ms) values (t, 'buscar_pedidos', false, 'no_encontrado', 40);
  begin
    insert into agent_tool_calls(token_id, tool, ok) values (t, 'busca el 987654321', true);
    raise exception 'FAIL free text tool';
  exception when check_violation then null; end;
  begin
    insert into agent_tool_calls(token_id, tool, ok, error_code) values (t, 'obtener_pedido', false, 'No encontré a María');
    raise exception 'FAIL free text error';
  exception when check_violation then null; end;
  begin
    insert into agent_tool_calls(token_id, tool, ok, duration_ms) values (t, 'obtener_pedido', true, -1);
    raise exception 'FAIL negative duration';
  exception when check_violation then null; end;
  begin
    update agent_tokens set last_tool = 'Lee la conversación' where id = t;
    raise exception 'FAIL free text last tool';
  exception when check_violation then null; end;

  -- Revocar es una fecha; el registro queda.
  update agent_tokens set revoked_at = now(), revoked_by = creator where id = t;
  if (select count(*) from agent_tool_calls where token_id = t) <> 2 then raise exception 'FAIL calls lost'; end if;
end $test$;

-- Solo el servidor: anon y authenticated no leen ni escriben.
set local role authenticated;
do $$ begin
  begin
    perform 1 from agent_tokens limit 1;
    raise exception 'FAIL authenticated read tokens';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from agent_tool_calls limit 1;
    raise exception 'FAIL authenticated read calls';
  exception when insufficient_privilege then null; end;
  begin
    insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes)
    values ('31400000-0000-0000-0000-000000000001', '31400000-0000-0000-0000-000000000009', 'Desde el navegador',
            repeat('9', 64), 'kagt_9999', array['31400000-0000-0000-0000-0000000000a1'::uuid], array['pedidos.leer']);
    raise exception 'FAIL authenticated wrote';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from agent_tokens limit 1;
    raise exception 'FAIL anon read tokens';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$ begin
  if (select count(*) from agent_tokens where org_id = '31400000-0000-0000-0000-000000000001') <> 2 then raise exception 'FAIL service_role cannot read'; end if;
end $$;
reset role;
rollback;
