-- App propia de Shopify (0271, MOM §36). Sobre el clúster desechable, después
-- de todas las migraciones y con los fixtures de rls_smoke.sql. Lo que fija es
-- la promesa del owner del 23-10-2026: Kenku Peru, Aurela y las tiendas
-- 'clientes' no cambian.
--   a) Aplicada sobre el esquema que hay en producción (el de la 0249, con
--      tiendas 'interna' y 'clientes' conectadas), no cambia ninguna fila.
--   b) Admite 'propia' y ningún otro valor nuevo.
--   c) Las ocho columnas nuevas solo se llenan en una tienda 'propia'.
--   d) Un dominio, una sola tienda con la app propia.
--   e) Los secretos nuevos tienen los privilegios de shopify_token_enc, y la
--      fila la sigue tapando la RLS.
--   f) Dos veces es una, sin volver a validar la tabla.
--   g) Una base con una versión anterior de la 0271 (el CHECK con cinco
--      columnas) se pone al día sin cambiar ninguna fila.
--   h) La conversión a mano de soporte (MOM §36.2, DEPLOY.md del 23-10-2026)
--      toma solo una tienda 'interna' sin token: nunca a Kenku ni a Aurela.
-- Todo dentro de una transacción que se deshace al final.

begin;

-- ── El esquema de antes de la 0271, como está en producción ─────────────────
alter table stores drop constraint if exists stores_own_app_columns_check;
drop index if exists stores_own_app_shop_uniq;
alter table stores
  drop column if exists shopify_client_id,
  drop column if exists shopify_client_secret_enc,
  drop column if exists shopify_token_expires_at,
  drop column if exists shopify_token_renewed_at,
  drop column if exists shopify_token_error,
  drop column if exists shopify_token_retry_at,
  drop column if exists shopify_webhook_secret_prev_enc,
  drop column if exists shopify_webhook_secret_prev_set_at;
alter table stores drop constraint if exists stores_shopify_app_check;
alter table stores
  add constraint stores_shopify_app_check
  check (shopify_app in ('interna', 'clientes'));

-- Kenku Peru y Aurela con la app interna, una tienda cliente conectada y otra
-- que desinstaló, cada una con lo que guarda hoy.
insert into organizations (id, name) values
  ('27100000-0000-0000-0000-0000000000a1', 'Grupo GF (0271)'),
  ('27100000-0000-0000-0000-0000000000a2', 'Cliente (0271)');
insert into stores (id, org_id, name, shopify_domain, shopify_token_enc, shopify_webhook_secret_enc,
                    status, shopify_app, shopify_uninstalled_at) values
  ('27100000-0000-0000-0000-0000000000b1', '27100000-0000-0000-0000-0000000000a1', 'Kenku Peru',
   'kenku-peru-0271.myshopify.com', 'enc:token-kenku', 'enc:secreto-kenku', 'active', 'interna', null),
  ('27100000-0000-0000-0000-0000000000b2', '27100000-0000-0000-0000-0000000000a1', 'Aurela',
   'aurela-0271.myshopify.com', 'enc:token-aurela', 'enc:secreto-aurela', 'active', 'interna', null),
  ('27100000-0000-0000-0000-0000000000b3', '27100000-0000-0000-0000-0000000000a2', 'Cliente conectada',
   'cliente-0271.myshopify.com', 'enc:token-cliente', 'enc:secreto-app-clientes', 'active', 'clientes', null),
  ('27100000-0000-0000-0000-0000000000b4', '27100000-0000-0000-0000-0000000000a2', 'Cliente que desinstaló',
   'cliente-baja-0271.myshopify.com', null, 'enc:secreto-app-clientes', 'disabled', 'clientes',
   '2026-10-20T15:00:00Z');

create temp table s0271_before on commit drop as
select s.id, to_jsonb(s) as fila from stores s;

\echo '  primera pasada, sobre el esquema de la 0249'
\ir ../../db/migrations/0271_shopify_app_propia.sql

-- ── a) Ninguna fila cambia ─────────────────────────────────────────────────
do $$
declare
  v_nuevas text[] := array['shopify_client_id', 'shopify_client_secret_enc', 'shopify_token_expires_at',
                           'shopify_token_renewed_at', 'shopify_token_error', 'shopify_token_retry_at',
                           'shopify_webhook_secret_prev_enc', 'shopify_webhook_secret_prev_set_at'];
  v_bad    text;
begin
  if (select count(*) from stores) <> (select count(*) from s0271_before) then
    raise exception 'la 0271 cambió cuántas tiendas hay';
  end if;
  select string_agg(s.name, ', ') into v_bad
    from stores s
    join s0271_before b on b.id = s.id
   where (to_jsonb(s) - v_nuevas) is distinct from b.fila;
  if v_bad is not null then
    raise exception 'la 0271 cambió estas tiendas: %', v_bad;
  end if;
  select string_agg(s.name, ', ') into v_bad
    from stores s
   where s.shopify_client_id is not null or s.shopify_client_secret_enc is not null
      or s.shopify_token_expires_at is not null or s.shopify_token_renewed_at is not null
      or s.shopify_token_error is not null or s.shopify_token_retry_at is not null
      or s.shopify_webhook_secret_prev_enc is not null or s.shopify_webhook_secret_prev_set_at is not null;
  if v_bad is not null then
    raise exception 'las columnas nuevas tienen que nacer null: %', v_bad;
  end if;
  if (select (shopify_app, shopify_token_enc, status) from stores where id = '27100000-0000-0000-0000-0000000000b1')
     is distinct from ('interna'::text, 'enc:token-kenku'::text, 'active'::text) then
    raise exception 'Kenku Peru tiene que seguir interna, activa y con su token';
  end if;
end $$;

-- ── b) 'propia' entra; un valor inventado, no ───────────────────────────────
do $$
begin
  if (select count(*) from pg_constraint
       where conrelid = 'stores'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%shopify_app = ANY%') <> 1 then
    raise exception 'tiene que quedar un solo CHECK de la lista de apps';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'stores'::regclass and conname = 'stores_shopify_app_check')
     not like '%''interna''%''clientes''%''propia''%' then
    raise exception 'stores_shopify_app_check tiene que admitir interna, clientes y propia';
  end if;

  begin
    insert into stores (org_id, name, shopify_domain, shopify_app)
    values ('27100000-0000-0000-0000-0000000000a1', 'Inventada', 'inventada-0271.myshopify.com', 'personalizada');
    raise exception 'un valor que no es interna, clientes ni propia no debería guardarse';
  exception when check_violation then null;
  end;

  -- Súper Human Perú, conectada con la app propia.
  insert into stores (id, org_id, name, shopify_domain, shopify_app, shopify_token_enc, shopify_webhook_secret_enc,
                      shopify_client_id, shopify_client_secret_enc, shopify_token_expires_at, shopify_token_renewed_at)
  values ('27100000-0000-0000-0000-0000000000c1', '27100000-0000-0000-0000-0000000000a1', 'Súper Human Perú',
          'super-human-peru-0271.myshopify.com', 'propia', 'enc:token-24h', 'enc:secreto-app-propia',
          'client-id-de-prueba', 'enc:secreto-app-propia', now() + interval '24 hours', now());
  -- La renovación que falla deja su motivo y conserva el token, y frena la
  -- renovación al usar; tras rotar el secreto, el anterior queda aparte.
  update stores set shopify_token_error = 'Shopify rechazó las credenciales de la app.',
                    shopify_token_retry_at = now() + interval '15 minutes',
                    shopify_webhook_secret_prev_enc = 'enc:secreto-anterior',
                    shopify_webhook_secret_prev_set_at = now()
   where id = '27100000-0000-0000-0000-0000000000c1';
  -- Una propia en pausa sigue siendo propia, con sus columnas.
  update stores set status = 'paused' where id = '27100000-0000-0000-0000-0000000000c1';
  update stores set status = 'active' where id = '27100000-0000-0000-0000-0000000000c1';
end $$;

-- ── c) Las columnas nuevas no se llenan fuera de la app propia ──────────────
do $$
declare
  v_store uuid;
  v_col   text;
begin
  foreach v_store in array array['27100000-0000-0000-0000-0000000000b1', '27100000-0000-0000-0000-0000000000b2',
                                 '27100000-0000-0000-0000-0000000000b3', '27100000-0000-0000-0000-0000000000b4']::uuid[] loop
    foreach v_col in array array['shopify_client_id', 'shopify_client_secret_enc', 'shopify_token_expires_at',
                                 'shopify_token_renewed_at', 'shopify_token_error', 'shopify_token_retry_at',
                                 'shopify_webhook_secret_prev_enc', 'shopify_webhook_secret_prev_set_at'] loop
      begin
        execute format('update stores set %I = %s where id = %L', v_col,
                       case when v_col like '%\_at' then 'now()' else quote_literal('x') end, v_store);
        raise exception 'la tienda % no es de la app propia y aceptó %', v_store, v_col;
      exception when check_violation then null;
      end;
    end loop;
  end loop;

  -- Volver una tienda propia a otra app exige vaciar lo suyo primero.
  begin
    update stores set shopify_app = 'interna' where id = '27100000-0000-0000-0000-0000000000c1';
    raise exception 'una tienda propia con credenciales no debería pasar a interna sin vaciarlas';
  exception when check_violation then null;
  end;

  -- Lo de siempre se sigue escribiendo en Kenku y en la cliente: la
  -- desinstalación (0249) borra el token y deshabilita.
  update stores set shopify_token_enc = null, status = 'disabled', shopify_uninstalled_at = now()
   where id = '27100000-0000-0000-0000-0000000000b3';
  update stores set name = 'Kenku Peru' where id = '27100000-0000-0000-0000-0000000000b1';
  -- Y en la propia también.
  update stores set shopify_token_enc = null, status = 'disabled', shopify_uninstalled_at = now()
   where id = '27100000-0000-0000-0000-0000000000c1';
end $$;

-- ── d) Un dominio, una sola tienda con la app propia ────────────────────────
do $$
begin
  begin
    insert into stores (org_id, name, shopify_domain, shopify_app, shopify_client_id)
    values ('27100000-0000-0000-0000-0000000000a2', 'Otra con el mismo dominio',
            'Super-Human-Peru-0271.myshopify.com', 'propia', 'otro-client-id');
    raise exception 'el mismo dominio no debería estar en dos tiendas con la app propia';
  exception when unique_violation then null;
  end;
  -- La unicidad nueva no alcanza a las otras apps: es solo de 'propia'.
  if (select count(*) from pg_indexes
       where tablename = 'stores' and indexname = 'stores_own_app_shop_uniq'
         and indexdef like '%WHERE (shopify_app = ''propia''::text)%') <> 1 then
    raise exception 'stores_own_app_shop_uniq tiene que ser parcial, solo de la app propia';
  end if;
end $$;

-- ── e) Los secretos nuevos se protegen como shopify_token_enc ───────────────
do $$
declare
  v_role text;
  v_priv text;
  v_col  text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      foreach v_col in array array['shopify_client_id', 'shopify_client_secret_enc', 'shopify_token_expires_at',
                                   'shopify_token_renewed_at', 'shopify_token_error', 'shopify_token_retry_at',
                                   'shopify_webhook_secret_prev_enc', 'shopify_webhook_secret_prev_set_at'] loop
        if has_column_privilege(v_role, 'stores', v_col, v_priv)
           is distinct from has_column_privilege(v_role, 'stores', 'shopify_token_enc', v_priv) then
          raise exception '% sobre stores.% para % no es el de shopify_token_enc', v_priv, v_col, v_role;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

-- Un viewer de la tienda A (rls_smoke.sql) no ve la fila de la tienda propia.
set request.test_uid = '00000000-0000-0000-0000-00000000000a';
set role authenticated;
do $$
begin
  if exists (select 1 from stores where id = '27100000-0000-0000-0000-0000000000c1') then
    raise exception 'un usuario de otra organización ve la tienda con la app propia';
  end if;
end $$;
reset role;
reset request.test_uid;

-- ── f) Dos veces es una ─────────────────────────────────────────────────────
create temp table s0271_after on commit drop as
select s.id, to_jsonb(s) as fila from stores s;
create temp table s0271_constraints on commit drop as
select oid, conname from pg_constraint
 where conrelid = 'stores'::regclass and conname in ('stores_shopify_app_check', 'stores_own_app_columns_check');

\echo '  segunda pasada'
\ir ../../db/migrations/0271_shopify_app_propia.sql

do $$
begin
  if exists (
    select 1 from stores s full join s0271_after a on a.id = s.id
     where to_jsonb(s) is distinct from a.fila
  ) then
    raise exception 'correrla otra vez no puede cambiar ninguna tienda';
  end if;
  if (select count(*) from pg_constraint c join s0271_constraints k on k.oid = c.oid) <> 2 then
    raise exception 'correrla otra vez no debería rehacer los CHECK (ni validar la tabla de nuevo)';
  end if;
  if (select count(*) from pg_indexes where tablename = 'stores' and indexname = 'stores_own_app_shop_uniq') <> 1 then
    raise exception 'correrla otra vez no debería duplicar el índice';
  end if;
end $$;

-- ── g) Una versión anterior de la 0271 se pone al día ───────────────────────
-- Solo pasa en bases de prueba (en producción la 0271 no se aplicó antes de
-- sumar las tres columnas): el CHECK de cinco columnas se rehace con ocho, sin
-- tocar filas.
alter table stores drop constraint stores_own_app_columns_check;
alter table stores
  add constraint stores_own_app_columns_check
  check (
    shopify_app = 'propia'
    or (shopify_client_id is null and shopify_client_secret_enc is null and shopify_token_expires_at is null
        and shopify_token_renewed_at is null and shopify_token_error is null)
  );

\echo '  tercera pasada, sobre una versión anterior de la 0271'
\ir ../../db/migrations/0271_shopify_app_propia.sql

do $$
begin
  if exists (
    select 1 from stores s full join s0271_after a on a.id = s.id
     where to_jsonb(s) is distinct from a.fila
  ) then
    raise exception 'ponerse al día no puede cambiar ninguna tienda';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'stores'::regclass and conname = 'stores_own_app_columns_check')
     not like '%shopify_webhook_secret_prev_set_at%' then
    raise exception 'el CHECK de una versión anterior tiene que quedar con las ocho columnas';
  end if;
  begin
    update stores set shopify_token_retry_at = now() where id = '27100000-0000-0000-0000-0000000000b1';
    raise exception 'Kenku no debería aceptar shopify_token_retry_at';
  exception when check_violation then null;
  end;
end $$;

-- ── h) La conversión de soporte solo toma una interna sin token ────────────
-- Una tienda creada con «Crear tienda con token de Admin API» y sin token; la
-- sentencia es la de DEPLOY.md, tal cual, con su id.
insert into stores (id, org_id, name, shopify_domain, shopify_token_enc, shopify_webhook_secret_enc, status, shopify_app)
values ('27100000-0000-0000-0000-0000000000d1', '27100000-0000-0000-0000-0000000000a1', 'Creada con el formulario del token',
        'formulario-token-0271.myshopify.com', null, null, 'active', 'interna'),
       ('27100000-0000-0000-0000-0000000000d2', '27100000-0000-0000-0000-0000000000a2', 'Otra sin token, dominio de una propia',
        'super-human-peru-0271.myshopify.com', null, null, 'active', 'interna');

create temp table s0271_before_conversion on commit drop as
select s.id, to_jsonb(s) as fila from stores s;

do $$
declare
  v_id   uuid;
  v_rows int;
begin
  -- Kenku, Aurela (con token) y la cliente que desinstaló (sin token, pero
  -- 'clientes'): la sentencia no toma ninguna.
  foreach v_id in array array['27100000-0000-0000-0000-0000000000b1', '27100000-0000-0000-0000-0000000000b2',
                              '27100000-0000-0000-0000-0000000000b3', '27100000-0000-0000-0000-0000000000b4']::uuid[] loop
    execute format($f$update stores set shopify_app='propia' where id='%s' and shopify_app='interna' and shopify_token_enc is null;$f$, v_id);
    get diagnostics v_rows = row_count;
    if v_rows <> 0 then
      raise exception 'la conversión de soporte tomó la tienda %', v_id;
    end if;
  end loop;

  -- La creada con el formulario del token: una fila, y después recibe las
  -- credenciales como «Probar y guardar».
  update stores set shopify_app='propia' where id='27100000-0000-0000-0000-0000000000d1' and shopify_app='interna' and shopify_token_enc is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'la conversión de soporte tiene que tomar la interna sin token (tomó %)', v_rows;
  end if;
  update stores set shopify_client_id = 'client-id-convertida', shopify_client_secret_enc = 'enc:secreto',
                    shopify_webhook_secret_enc = 'enc:secreto', shopify_token_enc = 'enc:token-24h',
                    shopify_token_expires_at = now() + interval '24 hours', shopify_token_renewed_at = now()
   where id = '27100000-0000-0000-0000-0000000000d1' and shopify_app = 'propia';

  -- Con el dominio de otra tienda propia, el índice la frena: DEPLOY dice no seguir.
  begin
    update stores set shopify_app='propia' where id='27100000-0000-0000-0000-0000000000d2' and shopify_app='interna' and shopify_token_enc is null;
    raise exception 'un dominio que ya tiene una tienda propia no debería admitir otra';
  exception when unique_violation then null;
  end;

  -- Ninguna otra fila cambió.
  if exists (
    select 1 from stores s join s0271_before_conversion b on b.id = s.id
     where s.id <> '27100000-0000-0000-0000-0000000000d1' and to_jsonb(s) is distinct from b.fila
  ) then
    raise exception 'la conversión de soporte cambió otra tienda';
  end if;
end $$;

\echo '  ✅ Kenku, Aurela y las tiendas clientes sin una fila cambiada; propia admitida y nada inventado; las ocho columnas solo en la propia; un dominio por app propia; los secretos con los privilegios de shopify_token_enc y tapados por la RLS; dos veces es una; una versión anterior se pone al día; la conversión de soporte solo toma una interna sin token'
rollback;
