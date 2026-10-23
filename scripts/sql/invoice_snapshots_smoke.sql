-- La foto del pedido para su boleta (0274, MOM §35.10, owner 23-10-2026). Sobre
-- el clúster desechable, después de todas las migraciones (con la 0273) y con
-- los fixtures de rls_smoke.sql. Lo que fija:
--   a) Aplicada sobre el esquema de la 0273 —Kenku, Aurela, sus pedidos, su
--      Master y sus comprobantes—, no cambia ninguna fila de ninguna tabla.
--   b) `invoice_snapshot_candidates` elige lo de la regla: de esa tienda, de
--      Shopify (`orders.platform`) con su id numérico, desde el piso, sin
--      comprobante real vivo, sin foto y no anulado, o con una foto anterior a
--      su último cambio; y en el orden: sin foto antes, en curso antes, del más
--      nuevo al más viejo. Sin piso o sin límite, nada.
--   c) `invoice_snapshot_put` guarda solo un pedido de Shopify de esa tienda, con
--      su gid y la respuesta tal cual (`{"order": …}` de ese pedido o null);
--      nunca una foto más vieja sobre una más nueva; y la que guarda sale de la
--      lista hasta que el pedido vuelva a cambiar.
--   d) Solo el servidor: RLS encendida, sin privilegios para anon ni
--      authenticated en la tabla ni en las funciones.
--   e) Dos veces es una.
--   f) Sin la 0273 delante, se detiene en su guarda.
-- Todo dentro de una transacción que se deshace al final.

begin;
set local client_min_messages = warning;

-- ── El esquema de antes de la 0274 ──────────────────────────────────────────
drop function if exists invoice_snapshot_put(uuid, uuid, text, jsonb, timestamptz);
drop function if exists invoice_snapshot_candidates(uuid, timestamptz, integer);
drop table if exists order_invoice_snapshots;

-- Grupo GF con su RUC, Kenku Peru y Aurela. Los pedidos de Kenku cubren cada
-- condición de la regla; Aurela tiene uno que nunca entra en la lista de Kenku.
insert into organizations (id, name) values ('27400000-0000-0000-0000-0000000000a1', 'Grupo GF (0274)');
insert into stores (id, org_id, name, shopify_domain, status, shopify_app) values
  ('27400000-0000-0000-0000-0000000000b1', '27400000-0000-0000-0000-0000000000a1', 'Kenku Peru',
   'kenku-peru-0274.myshopify.com', 'active', 'interna'),
  ('27400000-0000-0000-0000-0000000000b2', '27400000-0000-0000-0000-0000000000a1', 'Aurela',
   'aurela-0274.myshopify.com', 'active', 'interna');
insert into invoice_issuers (id, org_id, ruc, legal_name, simplefact_subdomain) values
  ('27400000-0000-0000-0000-0000000000e1', '27400000-0000-0000-0000-0000000000a1', '20000000274',
   'GF 0274 S.A.C.', 'gf0274');

-- Los pedidos: 27400000-…-0000000000NN (c01 a c13).
create function pg_temp.p(n integer) returns uuid language sql immutable as $$
  select ('27400000-0000-0000-0000-0000000000' || lpad(to_hex(192 + n), 2, '0'))::uuid
$$;

insert into orders (id, store_id, shopify_order_id, name, created_at, updated_at, cancelled_at,
                    total_amount, currency, platform) values
  -- 1: en curso, sin foto → entra.
  (pg_temp.p(1),  '27400000-0000-0000-0000-0000000000b1', '7400000000001', '#KP200901',
   '2026-10-20T15:00:00Z', '2026-10-20T15:00:00Z', null, 100, 'PEN', 'shopify'),
  -- 2: finalizado, sin foto → entra, después de los que siguen en curso.
  (pg_temp.p(2),  '27400000-0000-0000-0000-0000000000b1', '7400000000002', '#KP200902',
   '2026-10-21T15:00:00Z', '2026-10-21T15:00:00Z', null, 100, 'PEN', 'shopify'),
  -- 3: sin fila en el Master → cuenta como en curso → entra, primero (el más nuevo).
  (pg_temp.p(3),  '27400000-0000-0000-0000-0000000000b1', '7400000000003', '#KP200903',
   '2026-10-22T15:00:00Z', '2026-10-22T15:00:00Z', null, 100, 'PEN', 'shopify'),
  -- 4: un segundo antes del piso → no.
  (pg_temp.p(4),  '27400000-0000-0000-0000-0000000000b1', '7400000000004', '#KP200904',
   '2026-08-28T23:59:59Z', '2026-08-28T23:59:59Z', null, 100, 'PEN', 'shopify'),
  -- 5: anulado, sin foto → no.
  (pg_temp.p(5),  '27400000-0000-0000-0000-0000000000b1', '7400000000005', '#KP200905',
   '2026-10-20T16:00:00Z', '2026-10-20T16:00:00Z', '2026-10-20T17:00:00Z', 100, 'PEN', 'shopify'),
  -- 6: con su boleta emitida → no.
  (pg_temp.p(6),  '27400000-0000-0000-0000-0000000000b1', '7400000000006', '#KP200906',
   '2026-10-20T17:00:00Z', '2026-10-20T17:00:00Z', null, 100, 'PEN', 'shopify'),
  -- 7: con un error real y una simulada (ninguna viva) → entra.
  (pg_temp.p(7),  '27400000-0000-0000-0000-0000000000b1', '7400000000007', '#KP200907',
   '2026-10-19T15:00:00Z', '2026-10-19T15:00:00Z', null, 100, 'PEN', 'shopify'),
  -- 8: de WooCommerce → nunca.
  (pg_temp.p(8),  '27400000-0000-0000-0000-0000000000b1', 'wc-kp-1532', '#KP200908',
   '2026-10-22T16:00:00Z', '2026-10-22T16:00:00Z', null, 100, 'PEN', 'woocommerce'),
  -- 9: un pedido manual (sin id de Shopify) → no.
  (pg_temp.p(9),  '27400000-0000-0000-0000-0000000000b1', 'manual-0274', '#KP200909',
   '2026-10-22T17:00:00Z', '2026-10-22T17:00:00Z', null, 100, 'PEN', 'shopify'),
  -- 10: de Aurela → no en la lista de Kenku.
  (pg_temp.p(10), '27400000-0000-0000-0000-0000000000b2', '7400000000010', '#AUR900010',
   '2026-10-22T18:00:00Z', '2026-10-22T18:00:00Z', null, 100, 'PEN', 'shopify'),
  -- 11: con foto vieja (cambió después) → entra para volver a tomarla.
  (pg_temp.p(11), '27400000-0000-0000-0000-0000000000b1', '7400000000011', '#KP200911',
   '2026-10-18T15:00:00Z', '2026-10-23T10:00:00Z', null, 100, 'PEN', 'shopify'),
  -- 12: con foto al día → no.
  (pg_temp.p(12), '27400000-0000-0000-0000-0000000000b1', '7400000000012', '#KP200912',
   '2026-10-18T16:00:00Z', '2026-10-21T10:00:00Z', null, 100, 'PEN', 'shopify'),
  -- 13: anulado después de su foto → entra: la foto tiene que decir que se anuló.
  (pg_temp.p(13), '27400000-0000-0000-0000-0000000000b1', '7400000000013', '#KP200913',
   '2026-10-17T15:00:00Z', '2026-10-23T11:00:00Z', '2026-10-23T11:00:00Z', 100, 'PEN', 'shopify');

insert into order_master (order_id, store_id, shopify_order_id, order_name, order_created_at, macro_stage) values
  (pg_temp.p(1), '27400000-0000-0000-0000-0000000000b1', '7400000000001', '#KP200901', '2026-10-20T15:00:00Z', 'en_curso'),
  (pg_temp.p(2), '27400000-0000-0000-0000-0000000000b1', '7400000000002', '#KP200902', '2026-10-21T15:00:00Z', 'finalizado'),
  (pg_temp.p(7), '27400000-0000-0000-0000-0000000000b1', '7400000000007', '#KP200907', '2026-10-19T15:00:00Z', 'por_confirmar');

insert into order_invoices (id, org_id, store_id, order_id, issuer_id, ruc, mode, status, total, paid_at, request) values
  (gen_random_uuid(), '27400000-0000-0000-0000-0000000000a1', '27400000-0000-0000-0000-0000000000b1', pg_temp.p(6),
   '27400000-0000-0000-0000-0000000000e1', '20000000274', 'real', 'emitida', 100, now(), '{"invoice_type": "03"}'),
  (gen_random_uuid(), '27400000-0000-0000-0000-0000000000a1', '27400000-0000-0000-0000-0000000000b1', pg_temp.p(7),
   '27400000-0000-0000-0000-0000000000e1', '20000000274', 'real', 'error', 100, now(), '{"invoice_type": "03"}'),
  (gen_random_uuid(), '27400000-0000-0000-0000-0000000000a1', '27400000-0000-0000-0000-0000000000b1', pg_temp.p(7),
   '27400000-0000-0000-0000-0000000000e1', '20000000274', 'simulacion', 'simulada', 100, now(), '{"invoice_type": "03"}');

-- La huella de todo lo que la 0274 promete no tocar.
create temp table s0274_antes on commit drop as
select 'orders' as tabla, md5(string_agg(to_jsonb(o)::text, ',' order by o.id)) as huella from orders o
union all
select 'stores', md5(string_agg(to_jsonb(s)::text, ',' order by s.id)) from stores s
union all
select 'order_master', md5(string_agg(to_jsonb(m)::text, ',' order by m.order_id)) from order_master m
union all
select 'order_invoices', md5(string_agg(to_jsonb(i)::text, ',' order by i.id)) from order_invoices i;

\echo '  primera pasada, sobre el esquema de la 0273'
\ir ../../db/migrations/0274_invoice_snapshots.sql

-- ── a) Ninguna fila cambia ─────────────────────────────────────────────────
do $$
declare
  v_bad text;
begin
  select string_agg(a.tabla, ', ') into v_bad
    from s0274_antes a
    join (
      select 'orders' as tabla, md5(string_agg(to_jsonb(o)::text, ',' order by o.id)) as huella from orders o
      union all
      select 'stores', md5(string_agg(to_jsonb(s)::text, ',' order by s.id)) from stores s
      union all
      select 'order_master', md5(string_agg(to_jsonb(m)::text, ',' order by m.order_id)) from order_master m
      union all
      select 'order_invoices', md5(string_agg(to_jsonb(i)::text, ',' order by i.id)) from order_invoices i
    ) d on d.tabla = a.tabla
   where d.huella is distinct from a.huella;
  if v_bad is not null then
    raise exception 'la 0274 cambió filas de: %', v_bad;
  end if;
  if exists (select 1 from order_invoice_snapshots) then
    raise exception 'la 0274 tiene que nacer vacía';
  end if;
end $$;

-- Dos fotos ya tomadas (como las deja el cron): la 11, antes de su último
-- cambio; la 12, después; la 13, antes de que se anulara.
insert into order_invoice_snapshots (order_id, store_id, shopify_order_gid, payload, fetched_at) values
  (pg_temp.p(11), '27400000-0000-0000-0000-0000000000b1', 'gid://shopify/Order/7400000000011',
   '{"order": {"id": "gid://shopify/Order/7400000000011"}}', '2026-10-22T10:00:00Z'),
  (pg_temp.p(12), '27400000-0000-0000-0000-0000000000b1', 'gid://shopify/Order/7400000000012',
   '{"order": {"id": "gid://shopify/Order/7400000000012"}}', '2026-10-22T10:00:00Z'),
  (pg_temp.p(13), '27400000-0000-0000-0000-0000000000b1', 'gid://shopify/Order/7400000000013',
   '{"order": {"id": "gid://shopify/Order/7400000000013"}}', '2026-10-22T10:00:00Z');

-- ── b) La lista ─────────────────────────────────────────────────────────────
create function pg_temp.lista(p_store uuid, p_since timestamptz, p_limit integer) returns text
language sql as $$
  select coalesce(string_agg(o.name || case when c.refresh then '*' else '' end, ' ' order by c.ord), '')
    from invoice_snapshot_candidates(p_store, p_since, p_limit)
           with ordinality as c(order_id, shopify_order_id, refresh, ord)
    join orders o on o.id = c.order_id
$$;

do $$
declare
  k constant uuid := '27400000-0000-0000-0000-0000000000b1';
  piso constant timestamptz := '2026-08-29T00:00:00Z';
  v text;
begin
  v := pg_temp.lista(k, piso, 100);
  -- Sin foto, en curso (3 sin Master, 1, 7); sin foto, finalizado (2); y las
  -- fotos viejas (11, 13; la * es «volver a tomarla»).
  if v <> '#KP200903 #KP200901 #KP200907 #KP200902 #KP200911* #KP200913*' then
    raise exception 'la lista de Kenku no es la de la regla: %', v;
  end if;
  v := pg_temp.lista(k, piso, 2);
  if v <> '#KP200903 #KP200901' then raise exception 'el límite no corta por el principio: %', v; end if;
  if pg_temp.lista(k, null, 100) <> '' then raise exception 'sin piso tiene que dar nada'; end if;
  if pg_temp.lista(k, piso, 0) <> '' or pg_temp.lista(k, piso, null) <> '' or pg_temp.lista(k, piso, -1) <> '' then
    raise exception 'sin límite tiene que dar nada';
  end if;
  v := pg_temp.lista('27400000-0000-0000-0000-0000000000b2', piso, 100);
  if v <> '#AUR900010' then raise exception 'la lista de Aurela: %', v; end if;
  -- El piso es inclusivo: un pedido creado justo en el piso entra.
  update orders set created_at = piso where id = pg_temp.p(4);
  if pg_temp.lista(k, piso, 100) not like '%#KP200904%' then raise exception 'el piso es inclusivo'; end if;
  update orders set created_at = '2026-08-28T23:59:59Z' where id = pg_temp.p(4);
end $$;

-- ── c) Guardar ──────────────────────────────────────────────────────────────
do $$
declare
  k constant uuid := '27400000-0000-0000-0000-0000000000b1';
  a constant uuid := '27400000-0000-0000-0000-0000000000b2';
  g1 constant text := 'gid://shopify/Order/7400000000001';
  bueno constant jsonb := '{"order": {"id": "gid://shopify/Order/7400000000001", "name": "#KP200901"}}';
begin
  -- Lo que no es una foto de un pedido de Shopify de esa tienda, no entra.
  if invoice_snapshot_put(pg_temp.p(8), k, 'gid://shopify/Order/1532', '{"order": null}', now()) then
    raise exception 'guardó la foto de un pedido de WooCommerce';
  end if;
  if invoice_snapshot_put(pg_temp.p(9), k, 'gid://shopify/Order/0274', '{"order": null}', now()) then
    raise exception 'guardó la foto de un pedido sin id de Shopify';
  end if;
  if invoice_snapshot_put(pg_temp.p(1), a, g1, bueno, now()) then
    raise exception 'guardó la foto con otra tienda';
  end if;
  if invoice_snapshot_put(pg_temp.p(1), k, 'gid://shopify/Order/7400000000002', bueno, now()) then
    raise exception 'guardó la foto con otro gid';
  end if;
  if invoice_snapshot_put(pg_temp.p(1), k, g1, '{"order": {"id": "gid://shopify/Order/9"}}', now()) then
    raise exception 'guardó la respuesta de otro pedido';
  end if;
  if invoice_snapshot_put(pg_temp.p(1), k, g1, '{"data": {}}', now())
     or invoice_snapshot_put(pg_temp.p(1), k, g1, '[]', now())
     or invoice_snapshot_put(pg_temp.p(1), k, g1, '{"order": [1]}', now())
     or invoice_snapshot_put(pg_temp.p(1), k, g1, null, now()) then
    raise exception 'guardó una respuesta sin la forma de la 0274';
  end if;
  if invoice_snapshot_put(pg_temp.p(1), k, g1, bueno, now() + interval '1 hour')
     or invoice_snapshot_put(pg_temp.p(1), k, g1, bueno, null) then
    raise exception 'guardó una foto con una hora que no se entiende';
  end if;
  if exists (select 1 from order_invoice_snapshots where order_id in (pg_temp.p(1), pg_temp.p(8), pg_temp.p(9))) then
    raise exception 'quedó una foto que no debía';
  end if;

  -- La buena entra, y sale de la lista. (Las horas van contra `now()`: una
  -- foto «del futuro» no se acepta.)
  if not invoice_snapshot_put(pg_temp.p(1), k, g1, bueno, now() - interval '3 hours') then
    raise exception 'no guardó la foto buena';
  end if;
  if (select payload from order_invoice_snapshots where order_id = pg_temp.p(1)) is distinct from bueno then
    raise exception 'la foto no es la respuesta tal cual';
  end if;
  if pg_temp.lista(k, '2026-08-29T00:00:00Z', 100) like '%#KP200901%' then
    raise exception 'el pedido con foto al día sigue en la lista';
  end if;
  -- Una más vieja, o igual de nueva, no la pisa.
  if invoice_snapshot_put(pg_temp.p(1), k, g1, '{"order": null}', now() - interval '4 hours')
     or invoice_snapshot_put(pg_temp.p(1), k, g1, '{"order": null}', now() - interval '3 hours') then
    raise exception 'una foto vieja pisó a una nueva';
  end if;
  if (select payload from order_invoice_snapshots where order_id = pg_temp.p(1)) is distinct from bueno then
    raise exception 'la foto cambió con una más vieja';
  end if;
  -- El pedido cambia en Shopify después de la foto: vuelve a la lista, y la
  -- más nueva la reemplaza.
  update orders set updated_at = now() - interval '2 hours' where id = pg_temp.p(1);
  if pg_temp.lista(k, '2026-08-29T00:00:00Z', 100) not like '%#KP200901*%' then
    raise exception 'un pedido que cambió después de su foto no volvió a la lista';
  end if;
  if not invoice_snapshot_put(pg_temp.p(1), k, g1, '{"order": null}', now() - interval '1 hour') then
    raise exception 'no reemplazó la foto vieja';
  end if;
  if (select (payload, fetched_at) from order_invoice_snapshots where order_id = pg_temp.p(1))
     is distinct from ('{"order": null}'::jsonb, now() - interval '1 hour') then
    raise exception 'la foto nueva no quedó';
  end if;

  -- La tabla tampoco acepta lo que no es una respuesta (aunque alguien escriba directo).
  begin
    insert into order_invoice_snapshots (order_id, store_id, shopify_order_gid, payload, fetched_at)
    values (pg_temp.p(2), k, 'gid://shopify/Order/7400000000002', '[]', now());
    raise exception 'la tabla aceptó una respuesta que no es un objeto';
  exception when check_violation then null;
  end;
  begin
    insert into order_invoice_snapshots (order_id, store_id, shopify_order_gid, payload, fetched_at)
    values (pg_temp.p(2), k, 'wc-kp-1532', '{"order": null}', now());
    raise exception 'la tabla aceptó un gid que no es de Shopify';
  exception when check_violation then null;
  end;
end $$;

-- ── d) Solo el servidor ─────────────────────────────────────────────────────
do $$
declare
  v_rol  text;
  v_priv text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.order_invoice_snapshots'::regclass) then
    raise exception 'order_invoice_snapshots sin RLS';
  end if;
  foreach v_rol in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['select', 'insert', 'update', 'delete'] loop
      if has_table_privilege(v_rol, 'public.order_invoice_snapshots', v_priv) then
        raise exception '% puede % en order_invoice_snapshots', v_rol, v_priv;
      end if;
    end loop;
    if has_function_privilege(v_rol, 'invoice_snapshot_candidates(uuid, timestamptz, integer)', 'execute')
       or has_function_privilege(v_rol, 'invoice_snapshot_put(uuid, uuid, text, jsonb, timestamptz)', 'execute') then
      raise exception '% puede ejecutar las funciones de la 0274', v_rol;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.order_invoice_snapshots', 'insert')
     or not has_function_privilege('service_role', 'invoice_snapshot_candidates(uuid, timestamptz, integer)', 'execute')
     or not has_function_privilege('service_role', 'invoice_snapshot_put(uuid, uuid, text, jsonb, timestamptz)', 'execute') then
    raise exception 'service_role tiene que poder leer y escribir las fotos';
  end if;
end $$;

-- Y un usuario con sesión no ve ninguna foto, aunque sea de su tienda.
set local role authenticated;
do $$
begin
  perform 1 from order_invoice_snapshots;
  raise exception 'authenticated leyó order_invoice_snapshots';
exception when insufficient_privilege then null;
end $$;
reset role;

-- ── e) Dos veces es una ─────────────────────────────────────────────────────
create temp table s0274_fotos on commit drop as
select order_id, to_jsonb(x) as fila from order_invoice_snapshots x;
\echo '  segunda pasada'
\ir ../../db/migrations/0274_invoice_snapshots.sql
do $$
begin
  if (select count(*) from order_invoice_snapshots) <> (select count(*) from s0274_fotos)
     or exists (select 1 from order_invoice_snapshots x join s0274_fotos f on f.order_id = x.order_id
                 where to_jsonb(x) is distinct from f.fila) then
    raise exception 'correr la 0274 otra vez cambió las fotos';
  end if;
  if (select count(*) from pg_proc where proname in ('invoice_snapshot_candidates', 'invoice_snapshot_put')) <> 2 then
    raise exception 'correr la 0274 otra vez dejó funciones de más';
  end if;
end $$;

-- ── f) Sin la 0273, se detiene en su guarda ─────────────────────────────────
-- Como la prueba de la 0262 (invoices_smoke.sql): psql corre cada sentencia con
-- su propio punto de guardado (`ON_ERROR_ROLLBACK`), así que el resto de la
-- 0274 corre igual y se deshace con el punto de guardado de afuera; sin
-- validar los cuerpos de las funciones, el único ERROR es el de la guarda. En
-- el SQL Editor (una transacción) y con `psql -1 -v ON_ERROR_STOP=1`, la guarda
-- deshace la migración entera.
savepoint sin_0273;
drop function invoice_snapshot_put(uuid, uuid, text, jsonb, timestamptz);
drop function invoice_snapshot_candidates(uuid, timestamptz, integer);
drop table order_invoice_snapshots;
alter table orders drop column platform;
set local check_function_bodies = off;
\echo '  (el ERROR que sigue es la guarda de la 0274, y se espera)'
\set VERBOSITY terse
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\set LAST_ERROR_MESSAGE ''
\set LAST_ERROR_SQLSTATE ''
\ir ../../db/migrations/0274_invoice_snapshots.sql
select :'LAST_ERROR_SQLSTATE' = 'P0001' and :'LAST_ERROR_MESSAGE' like '0274: falta la 0273%' as guarda_0273 \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
\set VERBOSITY default
rollback to savepoint sin_0273;
release savepoint sin_0273;
\if :guarda_0273
\else
do $$ begin raise exception 'la 0274 corrió sin la 0273 (orders.platform)'; end $$;
\endif

rollback;
