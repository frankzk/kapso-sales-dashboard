\set ON_ERROR_STOP on
-- 0319: OAuth del conector de IA (MOM §42.8). El client_id con su forma y
-- redirect_uris con rango; el código guardado como sha256, con PKCE S256 de 43
-- caracteres, con vencimiento de hasta 15 minutos, permisos de la lista cerrada
-- y tiendas con rango; el token sabe de qué cliente vino; solo el servidor, y
-- el servidor no borra.
begin;

do $test$
declare
  org uuid := '31900000-0000-0000-0000-000000000001';
  store uuid := '31900000-0000-0000-0000-0000000000a1';
  person uuid := '31900000-0000-0000-0000-000000000009';
  client text := 'kcli_AAAAAAAAAAAAAAAAAAAAAA';
  challenge text := repeat('A', 43);
begin
  insert into agent_oauth_clients(client_id, client_name, redirect_uris) values (client, 'Grok Bot', array['https://grok.example/cb']);
  begin
    insert into agent_oauth_clients(client_id, client_name, redirect_uris) values ('cualquiera', 'X', array['https://x.example/cb']);
    raise exception 'FAIL client id shape';
  exception when check_violation then null; end;
  begin
    insert into agent_oauth_clients(client_id, client_name, redirect_uris) values ('kcli_BBBBBBBBBBBBBBBBBBBBBB', 'Sin vuelta', array[]::text[]);
    raise exception 'FAIL no redirect uris';
  exception when check_violation then null; end;

  insert into agent_oauth_codes(code_hash, client_id, redirect_uri, code_challenge, user_id, org_id, store_ids, scopes, label, expires_at)
  values (repeat('a', 64), client, 'https://grok.example/cb', challenge, person, org, array[store], array['pedidos.leer'], 'Grok Bot (OAuth)', now() + interval '10 minutes');
  -- El código en claro no entra.
  begin
    insert into agent_oauth_codes(code_hash, client_id, redirect_uri, code_challenge, user_id, org_id, store_ids, scopes, label, expires_at)
    values ('codigo-en-claro', client, 'https://grok.example/cb', challenge, person, org, array[store], array['pedidos.leer'], 'X', now() + interval '10 minutes');
    raise exception 'FAIL plain code';
  exception when check_violation then null; end;
  -- PKCE S256: 43 caracteres base64url.
  begin
    insert into agent_oauth_codes(code_hash, client_id, redirect_uri, code_challenge, user_id, org_id, store_ids, scopes, label, expires_at)
    values (repeat('b', 64), client, 'https://grok.example/cb', 'plain', person, org, array[store], array['pedidos.leer'], 'X', now() + interval '10 minutes');
    raise exception 'FAIL plain challenge';
  exception when check_violation then null; end;
  -- Un código que dura un día no.
  begin
    insert into agent_oauth_codes(code_hash, client_id, redirect_uri, code_challenge, user_id, org_id, store_ids, scopes, label, expires_at)
    values (repeat('c', 64), client, 'https://grok.example/cb', challenge, person, org, array[store], array['pedidos.leer'], 'X', now() + interval '1 day');
    raise exception 'FAIL long code';
  exception when check_violation then null; end;
  -- Permisos de la lista cerrada.
  begin
    insert into agent_oauth_codes(code_hash, client_id, redirect_uri, code_challenge, user_id, org_id, store_ids, scopes, label, expires_at)
    values (repeat('d', 64), client, 'https://grok.example/cb', challenge, person, org, array[store], array['pedidos.anular'], 'X', now() + interval '10 minutes');
    raise exception 'FAIL unknown scope';
  exception when check_violation then null; end;

  -- El token nacido del canje dice de qué cliente vino.
  insert into agent_tokens(org_id, created_by, label, token_hash, token_hint, store_ids, scopes, oauth_client_id)
  values (org, person, 'Grok Bot (OAuth)', repeat('e', 64), 'kagt_eeee', array[store], array['pedidos.leer'], client);
  if (select oauth_client_id from agent_tokens where token_hash = repeat('e', 64)) <> client then raise exception 'FAIL oauth client lost'; end if;
end $test$;

-- El servidor lee, crea y marca usado; no borra.
set local role service_role;
do $$ begin
  update agent_oauth_codes set used_at = now() where code_hash = repeat('a', 64);
  if (select used_at from agent_oauth_codes where code_hash = repeat('a', 64)) is null then raise exception 'FAIL cannot mark used'; end if;
  begin
    delete from agent_oauth_codes where code_hash = repeat('a', 64);
    raise exception 'FAIL service_role deleted a code';
  exception when insufficient_privilege then null; end;
  begin
    delete from agent_oauth_clients where client_id = 'kcli_AAAAAAAAAAAAAAAAAAAAAA';
    raise exception 'FAIL service_role deleted a client';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- El navegador, nada.
set local role authenticated;
do $$ begin
  begin
    perform 1 from agent_oauth_codes limit 1;
    raise exception 'FAIL authenticated read codes';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from agent_oauth_clients limit 1;
    raise exception 'FAIL authenticated read clients';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from agent_oauth_codes limit 1;
    raise exception 'FAIL anon read codes';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
