-- Los pedidos del bot de Kapso por Kapta (0277, MOM §38.13). Sobre el clúster
-- desechable, después de todas las migraciones y con los fixtures de
-- rls_smoke.sql. Lo que fija:
--   a) Aplicada sobre el esquema de la 0276 —Kenku y Aurela con sus pedidos—,
--      no cambia ninguna fila de `stores` ni de `orders`.
--   b) El candado: `unique (store_id, request_id)`. El mismo id dos veces en la
--      misma tienda choca (23505), que es lo que deja a la segunda llamada sin
--      llamar a WooCommerce; el mismo id en otra tienda no choca.
--   c) Retomar un candado vencido: solo quien nombra el `claim_token` que leyó
--      lo cambia; una segunda llamada con el mismo token viejo no cambia nada.
--   d) Las formas: el sha256 en hexadecimal, el id del bot, los tres estados,
--      el id de WooCommerce del intento (positivo o nada), y
--      `done` siempre con su pedido.
--   e) Solo el servidor: RLS encendida, sin privilegios para anon ni
--      authenticated; service_role sí.
--   f) Dos veces es una.
-- Todo dentro de una transacción que se deshace al final.

begin;
set local client_min_messages = warning;

-- ── El esquema de antes de la 0277 ──────────────────────────────────────────
drop table if exists bot_order_requests;
drop table if exists bot_order_secrets;

insert into organizations (id, name) values ('27700000-0000-0000-0000-0000000000a1', 'Grupo GF (0277)');
insert into stores (id, org_id, name, shopify_domain, status, order_prefix) values
  ('27700000-0000-0000-0000-0000000000b1', '27700000-0000-0000-0000-0000000000a1', 'Kenku Peru',
   'kenku-peru-0277.myshopify.com', 'active', 'KP'),
  ('27700000-0000-0000-0000-0000000000b2', '27700000-0000-0000-0000-0000000000a1', 'Aurela',
   'aurela-0277.myshopify.com', 'active', 'AUR');
insert into orders (id, store_id, shopify_order_id, name, created_at, total_amount, currency, tags) values
  ('27700000-0000-0000-0000-0000000000c1', '27700000-0000-0000-0000-0000000000b1', '7549608559001', '#KP143601',
   '2026-10-23T05:00:00Z', 149, 'PEN', '{kapso,whatsapp}'),
  ('27700000-0000-0000-0000-0000000000c2', '27700000-0000-0000-0000-0000000000b2', 'wc-aur-15', '#AUR900015',
   '2026-10-23T05:10:00Z', 89, 'PEN', '{venta_manual}');

create temp table s0277_stores_before on commit drop as select s.id, to_jsonb(s) as fila from stores s;
create temp table s0277_orders_before on commit drop as select o.id, to_jsonb(o) as fila from orders o;

\echo '  primera pasada, sobre el esquema de la 0276'
\ir ../../db/migrations/0277_bot_orders.sql

-- ── a) Ninguna fila cambia ─────────────────────────────────────────────────
do $$
begin
  if (select count(*) from stores) <> (select count(*) from s0277_stores_before)
     or (select count(*) from orders) <> (select count(*) from s0277_orders_before) then
    raise exception 'la 0277 cambió cuántas tiendas o pedidos hay';
  end if;
  if exists (select 1 from stores s join s0277_stores_before b on b.id = s.id where to_jsonb(s) is distinct from b.fila)
     or exists (select 1 from orders o join s0277_orders_before b on b.id = o.id where to_jsonb(o) is distinct from b.fila) then
    raise exception 'la 0277 cambió una tienda o un pedido';
  end if;
  if exists (select 1 from bot_order_secrets) or exists (select 1 from bot_order_requests) then
    raise exception 'las tablas de la 0277 nacen vacías';
  end if;
end $$;

-- ── b) El candado ─────────────────────────────────────────────────────────
do $$
declare
  v_hash text := repeat('a', 64);
begin
  insert into bot_order_requests (store_id, request_id, body_hash, claim_token)
  values ('27700000-0000-0000-0000-0000000000b1', '6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f', v_hash, gen_random_uuid());
  -- La segunda llamada con el mismo id, en la misma tienda: choca.
  begin
    insert into bot_order_requests (store_id, request_id, body_hash, claim_token)
    values ('27700000-0000-0000-0000-0000000000b1', '6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f', v_hash, gen_random_uuid());
    raise exception 'el mismo request_id en la misma tienda no puede tener dos filas';
  exception when unique_violation then null;
  end;
  -- Ni con otra huella: el id es el candado, la huella decide después.
  begin
    insert into bot_order_requests (store_id, request_id, body_hash, claim_token)
    values ('27700000-0000-0000-0000-0000000000b1', '6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f', repeat('b', 64), gen_random_uuid());
    raise exception 'el mismo request_id con otra huella tampoco';
  exception when unique_violation then null;
  end;
  -- El mismo id en otra tienda no choca.
  insert into bot_order_requests (store_id, request_id, body_hash, claim_token)
  values ('27700000-0000-0000-0000-0000000000b2', '6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f', v_hash, gen_random_uuid());
  if (select status from bot_order_requests
       where store_id = '27700000-0000-0000-0000-0000000000b1'
         and request_id = '6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f') <> 'processing' then
    raise exception 'una fila nueva nace processing';
  end if;
end $$;

-- ── c) Retomar un candado vencido: solo con el token que se leyó ─────────────
do $$
declare
  v_old  uuid := '27700000-0000-0000-0000-00000000f001';
  v_id   uuid;
  v_n    integer;
begin
  insert into bot_order_requests (store_id, request_id, body_hash, claim_token, claimed_at)
  values ('27700000-0000-0000-0000-0000000000b1', 'kapso-retry-0001', repeat('c', 64), v_old, now() - interval '10 minutes')
  returning id into v_id;
  -- Dos llamadas leyeron el mismo token viejo; solo la primera lo cambia.
  update bot_order_requests
     set claim_token = '27700000-0000-0000-0000-00000000f002', claimed_at = now(), attempts = attempts + 1
   where id = v_id and claim_token = v_old;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'la primera llamada tenía que retomar el candado'; end if;
  update bot_order_requests
     set claim_token = '27700000-0000-0000-0000-00000000f003', claimed_at = now(), attempts = attempts + 1
   where id = v_id and claim_token = v_old;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'la segunda llamada con el token viejo no puede retomarlo'; end if;
  if (select (attempts, claim_token) from bot_order_requests where id = v_id)
     is distinct from (2, '27700000-0000-0000-0000-00000000f002'::uuid) then
    raise exception 'el candado quedó en manos de la primera llamada, con dos intentos';
  end if;
  -- Quien no tiene el candado tampoco lo cierra.
  update bot_order_requests set status = 'failed', error_code = 'conflict'
   where id = v_id and claim_token = v_old;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'un token viejo no cierra el candado'; end if;
  update bot_order_requests
     set status = 'done', order_id = 'wc-kp-501', order_name = '#KP200501', order_total = 89, currency = 'PEN',
         finished_at = now()
   where id = v_id and claim_token = '27700000-0000-0000-0000-00000000f002';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'quien tiene el candado lo cierra con su pedido'; end if;
end $$;

-- ── d) Las formas ─────────────────────────────────────────────────────────
do $$
begin
  begin
    insert into bot_order_secrets (store_id, secret_hash) values ('27700000-0000-0000-0000-0000000000b1', 'kapta_bot_secreto_en_claro');
    raise exception 'el secreto se guarda solo como sha256 hexadecimal, nunca en claro';
  exception when check_violation then null;
  end;
  begin
    insert into bot_order_secrets (store_id, secret_hash) values ('27700000-0000-0000-0000-0000000000b1', upper(repeat('ab', 32)));
    raise exception 'el sha256 va en minúsculas';
  exception when check_violation then null;
  end;
  insert into bot_order_secrets (store_id, secret_hash) values ('27700000-0000-0000-0000-0000000000b1', repeat('ab', 32));
  if (select created_at is null or rotated_at is null or last_used_at is not null from bot_order_secrets
       where store_id = '27700000-0000-0000-0000-0000000000b1') then
    raise exception 'un secreto nuevo lleva cuándo se creó y se cambió, y nunca se usó';
  end if;
  begin
    insert into bot_order_secrets (store_id, secret_hash) values ('27700000-0000-0000-0000-0000000000b1', repeat('cd', 32));
    raise exception 'un secreto por tienda';
  exception when unique_violation then null;
  end;
  begin
    insert into bot_order_requests (store_id, request_id, body_hash, claim_token)
    values ('27700000-0000-0000-0000-0000000000b1', 'corto', repeat('a', 64), gen_random_uuid());
    raise exception 'el id del bot tiene al menos 8 caracteres';
  exception when check_violation then null;
  end;
  begin
    insert into bot_order_requests (store_id, request_id, body_hash, claim_token)
    values ('27700000-0000-0000-0000-0000000000b1', 'con espacios 1234', repeat('a', 64), gen_random_uuid());
    raise exception 'el id del bot no lleva espacios';
  exception when check_violation then null;
  end;
  begin
    insert into bot_order_requests (store_id, request_id, body_hash, claim_token, status)
    values ('27700000-0000-0000-0000-0000000000b1', 'estado-raro-0001', repeat('a', 64), gen_random_uuid(), 'creado');
    raise exception 'solo processing, done y failed';
  exception when check_violation then null;
  end;
  begin
    insert into bot_order_requests (store_id, request_id, body_hash, claim_token, status)
    values ('27700000-0000-0000-0000-0000000000b1', 'listo-sin-pedido', repeat('a', 64), gen_random_uuid(), 'done');
    raise exception 'done sin pedido no';
  exception when check_violation then null;
  end;
  -- El pedido de WooCommerce de ese intento: un id positivo, o nada todavía.
  begin
    insert into bot_order_requests (store_id, request_id, body_hash, claim_token, woo_order_id)
    values ('27700000-0000-0000-0000-0000000000b1', 'woo-id-cero-0001', repeat('a', 64), gen_random_uuid(), 0);
    raise exception 'woo_order_id es un id de WooCommerce (mayor que 0)';
  exception when check_violation then null;
  end;
  insert into bot_order_requests (store_id, request_id, body_hash, claim_token, woo_order_id)
  values ('27700000-0000-0000-0000-0000000000b1', 'woo-id-bueno-0001', repeat('a', 64), gen_random_uuid(), 501);
  if (select woo_order_id from bot_order_requests where request_id = 'woo-id-bueno-0001') <> 501 then
    raise exception 'woo_order_id guarda el id del pedido de WooCommerce';
  end if;
end $$;

-- ── e) Solo el servidor ──────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['bot_order_secrets', 'bot_order_requests'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% tiene que tener RLS encendida', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception '% no puede tener privilegios para anon ni authenticated', t;
    end if;
    if not (has_table_privilege('service_role', 'public.' || t, 'select')
            and has_table_privilege('service_role', 'public.' || t, 'insert')
            and has_table_privilege('service_role', 'public.' || t, 'update')) then
      raise exception '% es del service role', t;
    end if;
  end loop;
end $$;

-- Con la sesión de una persona de la organización, ni siquiera se lee.
set local role authenticated;
set local request.test_uid = '00000000-0000-0000-0000-0000000000a1';
do $$
begin
  begin
    perform 1 from bot_order_secrets;
    raise exception 'authenticated no puede leer bot_order_secrets';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from bot_order_requests;
    raise exception 'authenticated no puede leer bot_order_requests';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── f) Dos veces es una ─────────────────────────────────────────────────────
create temp table s0277_req_before on commit drop as select r.id, to_jsonb(r) as fila from bot_order_requests r;
\echo '  segunda pasada'
\ir ../../db/migrations/0277_bot_orders.sql
do $$
begin
  if (select count(*) from bot_order_requests) <> (select count(*) from s0277_req_before)
     or exists (select 1 from bot_order_requests r join s0277_req_before b on b.id = r.id where to_jsonb(r) is distinct from b.fila)
     or (select count(*) from bot_order_secrets) <> 1 then
    raise exception 'correrla otra vez no puede cambiar nada';
  end if;
  if has_table_privilege('authenticated', 'public.bot_order_requests', 'select') then
    raise exception 'la segunda pasada no devuelve privilegios';
  end if;
end $$;

\echo '  ✅ 0277: ninguna fila cambiada; un candado por (tienda, request_id), retomado solo con el token leído, done con su pedido, el id de WooCommerce del intento; secreto solo en sha256; RLS y solo service_role; dos veces es una'

rollback;
