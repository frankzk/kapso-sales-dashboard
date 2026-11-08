\set ON_ERROR_STOP on
-- 0315: las políticas escritas por tienda (MOM §42.6). La versión la pone la
-- base (1 al nacer, +1 en cada cambio) y cada versión queda en
-- store_policy_versions sin que nadie la escriba a mano; la tienda, la
-- organización y el autor no cambian; una retirada es final; el texto y las
-- fechas con su rango; nadie borra; anon y authenticated ni leen ni escriben, y
-- el servidor solo lee el historial.
begin;

do $test$
declare
  org uuid := '31500000-0000-0000-0000-000000000001';
  store uuid := '31500000-0000-0000-0000-0000000000a1';
  other_store uuid := '31500000-0000-0000-0000-0000000000a2';
  author uuid := '31500000-0000-0000-0000-000000000009';
  editor uuid := '31500000-0000-0000-0000-000000000008';
  p uuid;
  v int;
begin
  -- Nace en la versión 1 aunque se mande otra, con su autor como último editor.
  insert into store_policies(org_id, store_id, title, body, valid_from, created_by, updated_by, version)
  values (org, store, 'Cambios y devoluciones', 'Dentro de 7 días de recibido.', '2026-11-08', author, editor, 7)
  returning id, version into p, v;
  if v <> 1 then raise exception 'FAIL born at version %', v; end if;
  if (select updated_by from store_policies where id = p) <> author then raise exception 'FAIL born with other editor'; end if;
  if (select count(*) from store_policy_versions where policy_id = p and version = 1 and edited_by = author) <> 1 then raise exception 'FAIL no first version'; end if;

  -- Editar: +1, y la versión queda con quien la editó.
  update store_policies set body = 'Dentro de 15 días de recibido.', updated_by = editor where id = p;
  if (select version from store_policies where id = p) <> 2 then raise exception 'FAIL no version bump'; end if;
  if (select body from store_policy_versions where policy_id = p and version = 1) <> 'Dentro de 7 días de recibido.' then raise exception 'FAIL history rewritten'; end if;
  if (select edited_by from store_policy_versions where policy_id = p and version = 2) <> editor then raise exception 'FAIL editor lost'; end if;
  -- Una versión que se manda a mano no vale: la pone la base.
  update store_policies set version = 99, source = 'Web' where id = p;
  if (select version from store_policies where id = p) <> 3 then raise exception 'FAIL version forced'; end if;

  -- La tienda, la organización y el autor no cambian.
  begin
    update store_policies set store_id = other_store where id = p;
    raise exception 'FAIL store moved';
  exception when check_violation then null; end;
  begin
    update store_policies set created_by = editor where id = p;
    raise exception 'FAIL author changed';
  exception when check_violation then null; end;

  -- Rangos: título, texto, fechas y fuente.
  begin
    insert into store_policies(org_id, store_id, title, body, valid_from, created_by, updated_by)
    values (org, store, 'x', 'Texto válido.', '2026-11-08', author, author);
    raise exception 'FAIL short title';
  exception when check_violation then null; end;
  begin
    insert into store_policies(org_id, store_id, title, body, valid_from, created_by, updated_by)
    values (org, store, 'Garantía', repeat('x', 4001), '2026-11-08', author, author);
    raise exception 'FAIL long body';
  exception when check_violation then null; end;
  begin
    insert into store_policies(org_id, store_id, title, body, valid_from, valid_until, created_by, updated_by)
    values (org, store, 'Garantía', 'Seis meses.', '2026-11-08', '2026-11-07', author, author);
    raise exception 'FAIL until before from';
  exception when check_violation then null; end;
  begin
    insert into store_policies(org_id, store_id, title, body, valid_from, source, created_by, updated_by)
    values (org, store, 'Garantía', 'Seis meses.', '2026-11-08', '   ', author, author);
    raise exception 'FAIL blank source';
  exception when check_violation then null; end;
  -- Un solo día vale.
  insert into store_policies(org_id, store_id, title, body, valid_from, valid_until, created_by, updated_by)
  values (org, store, 'Feriado', 'Hoy no hay despachos.', '2026-11-08', '2026-11-08', author, author);
  -- No nace retirada.
  begin
    insert into store_policies(org_id, store_id, title, body, valid_from, created_by, updated_by, retired_at, retired_by)
    values (org, store, 'Retirada', 'No debería existir.', '2026-11-08', author, author, now(), author);
    raise exception 'FAIL born retired';
  exception when check_violation then null; end;

  -- Retirar: con fecha y autor juntos; queda en el historial; es final.
  begin
    update store_policies set retired_at = now() where id = p;
    raise exception 'FAIL retired without author';
  exception when check_violation then null; end;
  update store_policies set retired_at = now(), retired_by = editor where id = p;
  if (select retired_at from store_policy_versions where policy_id = p and version = 4) is null then raise exception 'FAIL retire not in history'; end if;
  begin
    update store_policies set body = 'Volver a usarla.' where id = p;
    raise exception 'FAIL edited after retire';
  exception when check_violation then null; end;
  begin
    update store_policies set retired_at = null, retired_by = null where id = p;
    raise exception 'FAIL unretired';
  exception when check_violation then null; end;
  if (select count(*) from store_policy_versions where policy_id = p) <> 4 then raise exception 'FAIL history count'; end if;
end $test$;

-- El servidor: lee, crea y edita políticas; no las borra; el historial solo lo lee.
set local role service_role;
do $$ begin
  if (select count(*) from store_policies where org_id = '31500000-0000-0000-0000-000000000001') <> 2 then raise exception 'FAIL service_role cannot read'; end if;
  insert into store_policies(org_id, store_id, title, body, valid_from, created_by, updated_by)
  values ('31500000-0000-0000-0000-000000000001', '31500000-0000-0000-0000-0000000000a1', 'Horario', 'De lunes a sábado.', '2026-11-08',
          '31500000-0000-0000-0000-000000000009', '31500000-0000-0000-0000-000000000009');
  -- El disparador escribe su versión aunque el servidor no pueda escribir el historial.
  if not exists (select 1 from store_policy_versions v join store_policies s on s.id = v.policy_id where s.title = 'Horario') then raise exception 'FAIL no version through service_role'; end if;
  begin
    delete from store_policies where title = 'Horario';
    raise exception 'FAIL service_role deleted';
  exception when insufficient_privilege then null; end;
  begin
    insert into store_policy_versions(policy_id, version, title, body, valid_from, edited_by, edited_at)
    values (gen_random_uuid(), 1, 'Falsa', 'Inventada.', '2026-11-08', '31500000-0000-0000-0000-000000000009', now());
    raise exception 'FAIL service_role wrote history';
  exception when insufficient_privilege then null; end;
  begin
    update store_policy_versions set body = 'Reescrita' where version = 1;
    raise exception 'FAIL service_role rewrote history';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- El navegador, nada.
set local role authenticated;
do $$ begin
  begin
    perform 1 from store_policies limit 1;
    raise exception 'FAIL authenticated read policies';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from store_policy_versions limit 1;
    raise exception 'FAIL authenticated read history';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from store_policies limit 1;
    raise exception 'FAIL anon read policies';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
