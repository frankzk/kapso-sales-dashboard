-- Base de WooCommerce (0274, MOM §38). Sobre el clúster desechable, después de
-- todas las migraciones y con los fixtures de rls_smoke.sql. Lo que fija es la
-- promesa de la migración: Kenku Peru y Aurela siguen en Shopify exactamente
-- igual hasta que Shopify cierre.
--   a) Aplicada sobre el esquema que hay en producción (el de la 0273, con
--      Kenku, Aurela y una tienda cliente con pedidos y borradores), no cambia
--      ninguna fila: todo nace 'shopify' y las columnas woo_* en null.
--   b) La plataforma solo admite 'shopify' y 'woocommerce', en las tres tablas.
--   c) Las credenciales pueden guardarse antes del cambio; pasar a
--      'woocommerce' sin ellas falla. Volver a 'shopify' no exige nada.
--   d) La clave del sitio: minúsculas y dígitos, sin guion, y única en toda la
--      base; la dirección: solo https, sin usuario, y una sola tienda por sitio.
--   e) Los secretos nuevos tienen los privilegios de shopify_token_enc, y la
--      fila la sigue tapando la RLS.
--   f) Un pedido de WooCommerce y uno de Shopify conviven en la misma tienda; el
--      mismo número de WooCommerce en dos sitios no choca (`wc-kp-…`, `wc-aur-…`).
--   g) Dos veces es una, sin volver a validar ni rehacer nada.
-- Todo dentro de una transacción que se deshace al final.

begin;

-- ── El esquema de antes de la 0274, como está en producción ─────────────────
drop index if exists stores_woo_site_key_uniq;
drop index if exists stores_woo_site_url_uniq;
alter table stores drop constraint if exists stores_woo_platform_check;
alter table stores drop constraint if exists stores_woo_site_key_check;
alter table stores drop constraint if exists stores_woo_site_url_check;
alter table stores
  drop column if exists platform,
  drop column if exists woo_site_url,
  drop column if exists woo_site_key,
  drop column if exists woo_consumer_key_enc,
  drop column if exists woo_consumer_secret_enc,
  drop column if exists woo_webhook_secret_enc,
  drop column if exists woo_last_error,
  drop column if exists platform_switched_at,
  drop column if exists woo_intake_from;
alter table orders drop column if exists platform;
alter table draft_orders drop column if exists platform;

-- Kenku Peru y Aurela con la app interna, y una tienda cliente; cada una con lo
-- que guarda hoy, sus pedidos y sus borradores.
insert into organizations (id, name) values
  ('27300000-0000-0000-0000-0000000000a1', 'Grupo GF (0274)'),
  ('27300000-0000-0000-0000-0000000000a2', 'Cliente (0274)');
insert into stores (id, org_id, name, shopify_domain, shopify_token_enc, shopify_webhook_secret_enc,
                    status, shopify_app, order_prefix) values
  ('27300000-0000-0000-0000-0000000000b1', '27300000-0000-0000-0000-0000000000a1', 'Kenku Peru',
   'kenkuperu-0274.myshopify.com', 'enc:token-kenku', 'enc:secreto-kenku', 'active', 'interna', 'KP'),
  ('27300000-0000-0000-0000-0000000000b2', '27300000-0000-0000-0000-0000000000a1', 'Aurela',
   'aurela-peru-0274.myshopify.com', 'enc:token-aurela', 'enc:secreto-aurela', 'active', 'interna', 'AUR'),
  ('27300000-0000-0000-0000-0000000000b3', '27300000-0000-0000-0000-0000000000a2', 'Cliente conectada',
   'cliente-0274.myshopify.com', 'enc:token-cliente', 'enc:secreto-app-clientes', 'active', 'clientes', null);
insert into orders (id, store_id, shopify_order_id, name, created_at, total_amount, currency, financial_status, tags) values
  ('27300000-0000-0000-0000-0000000000c1', '27300000-0000-0000-0000-0000000000b1', '7549608558887', '#KP143506',
   '2026-10-23T05:00:00Z', 149, 'PEN', 'pending', '{easysell_cod_form}'),
  ('27300000-0000-0000-0000-0000000000c2', '27300000-0000-0000-0000-0000000000b2', '18973278044380', '#AUR178521',
   '2026-10-23T05:10:00Z', 89, 'PEN', 'pending', '{kapso,whatsapp}');
insert into draft_orders (id, store_id, shopify_draft_order_id, name, status, created_at) values
  ('27300000-0000-0000-0000-0000000000d1', '27300000-0000-0000-0000-0000000000b1', '1234567890123', '#D9001',
   'open', '2026-10-23T04:00:00Z');

create temp table s0274_stores_before on commit drop as select s.id, to_jsonb(s) as fila from stores s;
create temp table s0274_orders_before on commit drop as select o.id, to_jsonb(o) as fila from orders o;
create temp table s0274_drafts_before on commit drop as select d.id, to_jsonb(d) as fila from draft_orders d;

\echo '  primera pasada, sobre el esquema de la 0273'
\ir ../../db/migrations/0274_woocommerce_base.sql

-- ── a) Ninguna fila cambia ─────────────────────────────────────────────────
do $$
declare
  v_nuevas text[] := array['platform', 'woo_site_url', 'woo_site_key', 'woo_consumer_key_enc',
                           'woo_consumer_secret_enc', 'woo_webhook_secret_enc', 'woo_last_error',
                           'platform_switched_at', 'woo_intake_from'];
  v_bad    text;
begin
  if (select count(*) from stores) <> (select count(*) from s0274_stores_before)
     or (select count(*) from orders) <> (select count(*) from s0274_orders_before)
     or (select count(*) from draft_orders) <> (select count(*) from s0274_drafts_before) then
    raise exception 'la 0274 cambió cuántas tiendas, pedidos o borradores hay';
  end if;
  select string_agg(s.name, ', ') into v_bad
    from stores s join s0274_stores_before b on b.id = s.id
   where (to_jsonb(s) - v_nuevas) is distinct from b.fila;
  if v_bad is not null then
    raise exception 'la 0274 cambió estas tiendas: %', v_bad;
  end if;
  select string_agg(o.name, ', ') into v_bad
    from orders o join s0274_orders_before b on b.id = o.id
   where (to_jsonb(o) - 'platform') is distinct from b.fila;
  if v_bad is not null then
    raise exception 'la 0274 cambió estos pedidos: %', v_bad;
  end if;
  if exists (select 1 from draft_orders d join s0274_drafts_before b on b.id = d.id
              where (to_jsonb(d) - 'platform') is distinct from b.fila) then
    raise exception 'la 0274 cambió un borrador';
  end if;

  select string_agg(s.name, ', ') into v_bad
    from stores s
   where s.platform <> 'shopify' or s.woo_site_url is not null or s.woo_site_key is not null
      or s.woo_consumer_key_enc is not null or s.woo_consumer_secret_enc is not null
      or s.woo_webhook_secret_enc is not null or s.woo_last_error is not null
      or s.platform_switched_at is not null or s.woo_intake_from is not null;
  if v_bad is not null then
    raise exception 'las tiendas tienen que nacer shopify y sin nada de WooCommerce: %', v_bad;
  end if;
  if exists (select 1 from orders where platform <> 'shopify')
     or exists (select 1 from draft_orders where platform <> 'shopify') then
    raise exception 'los pedidos y borradores de antes son de Shopify';
  end if;
  if (select (shopify_app, shopify_token_enc, status, shopify_domain) from stores
       where id = '27300000-0000-0000-0000-0000000000b1')
     is distinct from ('interna'::text, 'enc:token-kenku'::text, 'active'::text, 'kenkuperu-0274.myshopify.com'::text) then
    raise exception 'Kenku Peru tiene que seguir interna, activa, con su token y su dominio';
  end if;

  -- Una escritura de hoy, que no nombra la plataforma, sigue siendo de Shopify:
  -- el webhook y la sincronización de Shopify no cambian una línea.
  insert into orders (store_id, shopify_order_id, name, created_at, total_amount, currency)
  values ('27300000-0000-0000-0000-0000000000b1', '7549608558888', '#KP143507', now(), 99, 'PEN');
  insert into orders (store_id, shopify_order_id, name, created_at, total_amount, currency)
  values ('27300000-0000-0000-0000-0000000000b1', '7549608558888', '#KP143507', now(), 109, 'PEN')
  on conflict (store_id, shopify_order_id) do update set total_amount = excluded.total_amount;
  if (select platform from orders where shopify_order_id = '7549608558888') <> 'shopify' then
    raise exception 'un pedido de Shopify que no dice su plataforma tiene que quedar shopify';
  end if;
  insert into draft_orders (store_id, shopify_draft_order_id) values ('27300000-0000-0000-0000-0000000000b2', '99887766');
  if (select platform from draft_orders where shopify_draft_order_id = '99887766') <> 'shopify' then
    raise exception 'un borrador de Shopify que no dice su plataforma tiene que quedar shopify';
  end if;
end $$;

-- ── a2) Los CHECK de orders y draft_orders quedan validados ─────────────────
-- Entran `not valid` (sin recorrer la tabla bajo el candado exclusivo) y se
-- validan aparte; al final tienen que estar validados, como uno en línea.
do $$
begin
  if (select count(*) from pg_constraint
       where conname in ('orders_platform_check', 'draft_orders_platform_check', 'stores_platform_check')
         and convalidated) <> 3 then
    raise exception 'los CHECK de la plataforma tienen que quedar validados';
  end if;
  -- La columna nueva no reescribió la tabla: el valor por defecto vive en el
  -- catálogo (atthasmissing) para las filas de antes.
  if not (select atthasmissing from pg_attribute where attrelid = 'orders'::regclass and attname = 'platform') then
    raise exception 'orders.platform tenía que añadirse sin reescribir la tabla';
  end if;
end $$;

-- ── b) Solo 'shopify' y 'woocommerce' ───────────────────────────────────────
do $$
begin
  begin
    update stores set platform = 'tiendanube' where id = '27300000-0000-0000-0000-0000000000b3';
    raise exception 'stores.platform no debería aceptar otra plataforma';
  exception when check_violation then null;
  end;
  begin
    update orders set platform = 'woo' where id = '27300000-0000-0000-0000-0000000000c1';
    raise exception 'orders.platform no debería aceptar otra plataforma';
  exception when check_violation then null;
  end;
  begin
    update draft_orders set platform = 'WooCommerce' where id = '27300000-0000-0000-0000-0000000000d1';
    raise exception 'draft_orders.platform no debería aceptar otra plataforma (ni en mayúsculas)';
  exception when check_violation then null;
  end;
  begin
    update orders set platform = null where id = '27300000-0000-0000-0000-0000000000c1';
    raise exception 'orders.platform no puede quedar vacía';
  exception when not_null_violation then null;
  end;
end $$;

-- ── c) Credenciales antes del cambio; el cambio, solo con ellas ─────────────
do $$
begin
  -- Sin credenciales, Kenku no puede pasar a WooCommerce.
  begin
    update stores set platform = 'woocommerce', platform_switched_at = now()
     where id = '27300000-0000-0000-0000-0000000000b1';
    raise exception 'una tienda sin credenciales de WooCommerce no debería pasar a woocommerce';
  exception when check_violation then null;
  end;

  -- Las credenciales se guardan con la tienda todavía en Shopify (el ensayo).
  update stores set woo_site_url = 'https://kenku.pe', woo_site_key = 'kp',
                    woo_consumer_key_enc = 'enc:ck', woo_consumer_secret_enc = 'enc:cs'
   where id = '27300000-0000-0000-0000-0000000000b1';
  if (select platform from stores where id = '27300000-0000-0000-0000-0000000000b1') <> 'shopify' then
    raise exception 'guardar las credenciales no cambia la plataforma';
  end if;

  -- Falta una sola: tampoco.
  update stores set woo_consumer_secret_enc = null where id = '27300000-0000-0000-0000-0000000000b1';
  begin
    update stores set platform = 'woocommerce' where id = '27300000-0000-0000-0000-0000000000b1';
    raise exception 'sin el Consumer secret no debería pasar a woocommerce';
  exception when check_violation then null;
  end;
  update stores set woo_consumer_secret_enc = 'enc:cs' where id = '27300000-0000-0000-0000-0000000000b1';

  -- Con todo, sí; y el secreto de los webhooks y el error son opcionales.
  update stores set platform = 'woocommerce', platform_switched_at = now(),
                    woo_webhook_secret_enc = 'enc:wh', woo_last_error = 'WooCommerce no respondió a tiempo.'
   where id = '27300000-0000-0000-0000-0000000000b1';
  -- Y una vez en WooCommerce, no se le pueden borrar.
  begin
    update stores set woo_consumer_key_enc = null where id = '27300000-0000-0000-0000-0000000000b1';
    raise exception 'una tienda en woocommerce no debería quedarse sin Consumer key';
  exception when check_violation then null;
  end;
  -- Volver a Shopify no exige nada.
  update stores set platform = 'shopify' where id = '27300000-0000-0000-0000-0000000000b1';
  update stores set platform = 'woocommerce' where id = '27300000-0000-0000-0000-0000000000b1';

  -- El token de Shopify sigue ahí: Kapta recibe las dos fuentes a la vez.
  if (select shopify_token_enc from stores where id = '27300000-0000-0000-0000-0000000000b1') <> 'enc:token-kenku' then
    raise exception 'pasar a WooCommerce no toca el token de Shopify';
  end if;
end $$;

-- ── d) La clave del sitio y la dirección ────────────────────────────────────
do $$
declare
  v_key text;
  v_url text;
begin
  foreach v_key in array array['KP', 'k', 'kp-1', 'k p', '1kp', 'kenkuperutienda', 'kp_'] loop
    begin
      update stores set woo_site_key = v_key where id = '27300000-0000-0000-0000-0000000000b2';
      raise exception 'la clave de sitio % no debería aceptarse', v_key;
    exception when check_violation then null;
    end;
  end loop;
  foreach v_url in array array['http://aurela.pe', 'aurela.pe', 'https://', 'https://user:pass@aurela.pe',
                               'https://aurela.pe/?a=1', 'https://aurela.pe/#x', 'ftp://aurela.pe'] loop
    begin
      update stores set woo_site_url = v_url where id = '27300000-0000-0000-0000-0000000000b2';
      raise exception 'la dirección % no debería aceptarse', v_url;
    exception when check_violation then null;
    end;
  end loop;

  update stores set woo_site_url = 'https://tienda.aurela.pe/shop', woo_site_key = 'aur'
   where id = '27300000-0000-0000-0000-0000000000b2';

  -- La clave de Kenku no se repite en otra tienda, ni de otra organización.
  begin
    update stores set woo_site_key = 'kp' where id = '27300000-0000-0000-0000-0000000000b3';
    raise exception 'la clave kp ya es de Kenku';
  exception when unique_violation then null;
  end;
  -- El sitio tampoco, aunque cambien las mayúsculas.
  begin
    update stores set woo_site_url = 'https://KENKU.pe' where id = '27300000-0000-0000-0000-0000000000b3';
    raise exception 'el sitio de Kenku no debería estar en otra tienda';
  exception when unique_violation then null;
  end;
  -- Varias tiendas sin WooCommerce, todas con null: eso no choca.
  if (select count(*) from stores where woo_site_key is null) < 1 then
    raise exception 'la prueba necesita tiendas sin WooCommerce';
  end if;
  if (select count(*) from pg_indexes
       where tablename = 'stores' and indexname in ('stores_woo_site_key_uniq', 'stores_woo_site_url_uniq')
         and indexdef like '%WHERE%IS NOT NULL%') <> 2 then
    raise exception 'los dos índices únicos tienen que ser parciales (solo filas con WooCommerce)';
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
      foreach v_col in array array['platform', 'woo_site_url', 'woo_site_key', 'woo_consumer_key_enc',
                                   'woo_consumer_secret_enc', 'woo_webhook_secret_enc', 'woo_last_error',
                                   'platform_switched_at', 'woo_intake_from'] loop
        if has_column_privilege(v_role, 'stores', v_col, v_priv)
           is distinct from has_column_privilege(v_role, 'stores', 'shopify_token_enc', v_priv) then
          raise exception '% sobre stores.% para % no es el de shopify_token_enc', v_priv, v_col, v_role;
        end if;
      end loop;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(v_role, 'orders', 'platform', v_priv)
         is distinct from has_column_privilege(v_role, 'orders', 'shopify_order_id', v_priv) then
        raise exception '% sobre orders.platform para % no es el de shopify_order_id', v_priv, v_role;
      end if;
    end loop;
  end loop;
end $$;

-- Un viewer de la tienda A (rls_smoke.sql) no ve a Kenku con sus claves.
set request.test_uid = '00000000-0000-0000-0000-00000000000a';
set role authenticated;
do $$
begin
  if exists (select 1 from stores where id = '27300000-0000-0000-0000-0000000000b1') then
    raise exception 'un usuario de otra organización ve la tienda con claves de WooCommerce';
  end if;
  if exists (select 1 from stores where woo_consumer_key_enc is not null) then
    raise exception 'un usuario de otra organización ve claves de WooCommerce';
  end if;
end $$;
reset role;
reset request.test_uid;

-- ── f) Pedidos de las dos plataformas, sin chocar ───────────────────────────
do $$
begin
  insert into orders (store_id, shopify_order_id, name, created_at, total_amount, currency, financial_status, platform, tags)
  values ('27300000-0000-0000-0000-0000000000b1', 'wc-kp-1532', '#KP200001', now(), 149, 'PEN', 'pending', 'woocommerce', '{easysell_cod_form}'),
         ('27300000-0000-0000-0000-0000000000b2', 'wc-aur-1532', '#AUR900001', now(), 89, 'PEN', 'pending', 'woocommerce', '{venta_manual}');
  -- En la misma tienda, el viejo de Shopify y el nuevo de WooCommerce.
  if (select array_agg(platform order by platform) from orders where store_id = '27300000-0000-0000-0000-0000000000b1')
     <> array['shopify', 'shopify', 'woocommerce'] then
    raise exception 'Kenku tiene que tener sus pedidos de Shopify y el de WooCommerce';
  end if;
  -- El mismo número de WooCommerce en los dos sitios es un id distinto.
  if (select count(distinct shopify_order_id) from orders where shopify_order_id like 'wc-%-1532') <> 2 then
    raise exception 'wc-kp-1532 y wc-aur-1532 son dos pedidos';
  end if;
  insert into draft_orders (store_id, shopify_draft_order_id, platform)
  values ('27300000-0000-0000-0000-0000000000b1', 'wc-cart-kp-77', 'woocommerce');
end $$;

-- ── g) Dos veces es una ─────────────────────────────────────────────────────
create temp table s0274_after on commit drop as
select 's' as t, s.id, to_jsonb(s) as fila from stores s
union all select 'o', o.id, to_jsonb(o) from orders o
union all select 'd', d.id, to_jsonb(d) from draft_orders d;
create temp table s0274_constraints on commit drop as
select oid, conname from pg_constraint
 where conname in ('stores_platform_check', 'stores_woo_site_key_check', 'stores_woo_site_url_check',
                   'stores_woo_platform_check', 'orders_platform_check', 'draft_orders_platform_check');

\echo '  segunda pasada'
\ir ../../db/migrations/0274_woocommerce_base.sql

do $$
begin
  if (select count(*) from s0274_constraints) <> 6 then
    raise exception 'la 0274 tiene que dejar seis CHECK con nombre (hay %)', (select count(*) from s0274_constraints);
  end if;
  if exists (
    select 1
      from (select 's' as t, s.id, to_jsonb(s) as fila from stores s
            union all select 'o', o.id, to_jsonb(o) from orders o
            union all select 'd', d.id, to_jsonb(d) from draft_orders d) now_
      full join s0274_after a on a.t = now_.t and a.id = now_.id
     where now_.fila is distinct from a.fila
  ) then
    raise exception 'correrla otra vez no puede cambiar ninguna fila';
  end if;
  if (select count(*) from pg_constraint c join s0274_constraints k on k.oid = c.oid) <> 6 then
    raise exception 'correrla otra vez no debería rehacer los CHECK (ni validar las tablas de nuevo)';
  end if;
  if (select count(*) from pg_indexes
       where tablename = 'stores' and indexname in ('stores_woo_site_key_uniq', 'stores_woo_site_url_uniq')) <> 2 then
    raise exception 'correrla otra vez no debería duplicar los índices';
  end if;
end $$;

\echo '  ✅ Kenku, Aurela y la cliente sin una fila cambiada y todo nace shopify; solo shopify o woocommerce; el cambio exige las credenciales; clave y sitio únicos y con forma; los secretos con los privilegios de shopify_token_enc y tapados por la RLS; pedidos de las dos plataformas sin chocar; dos veces es una'
rollback;
