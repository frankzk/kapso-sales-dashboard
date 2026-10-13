-- Recordatorio de reposición (migración 0255). Corre en el clúster desechable
-- después de todas las migraciones y reutiliza las tiendas y usuarios de
-- rls_smoke.sql: A (viewer de la tienda A), C (owner de las dos), D (sin
-- tiendas).
--
-- Lo que se fija es a quién le toca hoy: cuándo vence cada producto (unidades ×
-- días − días antes), que una línea sin id se reconozca por su título, que no
-- se le escriba a quien ya volvió a comprar ni dos veces por el mismo pedido, y
-- cómo se cuentan los resultados de cada grupo.

do $$
declare
  v_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  aceite jsonb := '{"product_id": "111", "title": "Aceite Semilla Negra 60 caps", "quantity": 1}';
begin
  insert into restock_products (store_id, product_key, shopify_title, short_name, days_per_unit) values
    (v_a, '111', 'Aceite Semilla Negra 60 caps', 'Aceite de Semilla Negra', 30),
    (v_a, '333', 'Gotas 10 ml', 'gotas', 10),
    (v_b, '111', 'Aceite Semilla Negra 60 caps', 'Aceite B', 30);

  -- Hoy es 13-10 a las 15:00 UTC; días antes 7, ventana 14 ⇒ vence entre el
  -- 29-09 (exclusive) y hoy.
  insert into orders (id, store_id, shopify_order_id, name, created_at, line_items) values
    -- 1. Un frasco entregado el 15-09: vence el 08-10. Le toca.
    ('25300000-0000-0000-0000-000000000001', v_a, 'rs-1', '#RS1', '2026-09-12 15:00+00', jsonb_build_array(aceite)),
    -- 2. Dos frascos el 20-08, línea SIN id y título en otra caja: vence el 12-10.
    ('25300000-0000-0000-0000-000000000002', v_a, 'rs-2', '#RS2', '2026-08-18 15:00+00',
      '[{"title": "aceite semilla negra 60 caps", "quantity": 2}]'),
    -- 3. Le toca, pero volvió a comprar el 30-09.
    ('25300000-0000-0000-0000-000000000003', v_a, 'rs-3', '#RS3', '2026-09-12 15:00+00', jsonb_build_array(aceite)),
    ('25300000-0000-0000-0000-000000000004', v_a, 'rs-3b', '#RS3B', '2026-09-30 15:00+00', jsonb_build_array(aceite)),
    -- 5. Producto sin días configurados: nunca.
    ('25300000-0000-0000-0000-000000000005', v_a, 'rs-5', '#RS5', '2026-09-12 15:00+00',
      '[{"product_id": "222", "title": "Pelador", "quantity": 1}]'),
    -- 6. Ya tiene su recordatorio.
    ('25300000-0000-0000-0000-000000000006', v_a, 'rs-6', '#RS6', '2026-09-12 15:00+00', jsonb_build_array(aceite)),
    -- 7. Venció en junio: llegaría tarde.
    ('25300000-0000-0000-0000-000000000007', v_a, 'rs-7', '#RS7', '2026-05-30 15:00+00', jsonb_build_array(aceite)),
    -- 8. Dos productos: las gotas se acabaron el 18-09 (fuera de la ventana),
    --    el aceite vence el 08-10. Le toca por el aceite.
    ('25300000-0000-0000-0000-000000000008', v_a, 'rs-8', '#RS8', '2026-09-12 15:00+00',
      jsonb_build_array(aceite, '{"product_id": "333", "title": "Gotas 10 ml", "quantity": 1}'::jsonb)),
    -- 9. Volvió a comprar, pero ese pedido se anuló: le toca igual.
    ('25300000-0000-0000-0000-000000000009', v_a, 'rs-9', '#RS9', '2026-09-12 15:00+00', jsonb_build_array(aceite)),
    ('25300000-0000-0000-0000-000000000010', v_a, 'rs-9b', '#RS9B', '2026-10-01 15:00+00', jsonb_build_array(aceite)),
    -- 11. Sin entregar.
    ('25300000-0000-0000-0000-000000000011', v_a, 'rs-11', '#RS11', '2026-09-12 15:00+00', jsonb_build_array(aceite)),
    -- 12. La tienda B.
    ('25300000-0000-0000-0000-000000000012', v_b, 'rs-12', '#RS12', '2026-09-12 15:00+00', jsonb_build_array(aceite));

  insert into order_master (order_id, store_id, shopify_order_id, order_name, customer_name, customer_phone,
                            order_created_at, delivered_at, order_total, general_status, macro_version) values
    ('25300000-0000-0000-0000-000000000001', v_a, 'rs-1',  '#RS1',  'Ana Pérez',   '51999222001', '2026-09-12 15:00+00', '2026-09-15 15:00+00', 89, 'entregado', 'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000002', v_a, 'rs-2',  '#RS2',  'Bea Ruiz',    '51999222002', '2026-08-18 15:00+00', '2026-08-20 15:00+00', 89, 'entregado', 'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000003', v_a, 'rs-3',  '#RS3',  'Cata Soto',   '51999222003', '2026-09-12 15:00+00', '2026-09-15 15:00+00', 89, 'entregado', 'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000004', v_a, 'rs-3b', '#RS3B', 'Cata Soto',   '51999222003', '2026-09-30 15:00+00', null,                  89, 'en_proceso', 'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000005', v_a, 'rs-5',  '#RS5',  'Dora Vega',   '51999222005', '2026-09-12 15:00+00', '2026-09-15 15:00+00', 89, 'entregado', 'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000006', v_a, 'rs-6',  '#RS6',  'Eva Luna',    '51999222006', '2026-09-12 15:00+00', '2026-09-15 15:00+00', 89, 'entregado', 'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000007', v_a, 'rs-7',  '#RS7',  'Fiona Paz',   '51999222007', '2026-05-30 15:00+00', '2026-06-01 15:00+00', 89, 'entregado', 'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000008', v_a, 'rs-8',  '#RS8',  'Gina Rojas',  '51999222008', '2026-09-12 15:00+00', '2026-09-15 15:00+00', 89, 'entregado', 'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000009', v_a, 'rs-9',  '#RS9',  'Hilda Mora',  '51999222009', '2026-09-12 15:00+00', '2026-09-15 15:00+00', 89, 'entregado', 'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000010', v_a, 'rs-9b', '#RS9B', 'Hilda Mora',  '51999222009', '2026-10-01 15:00+00', null,                  89, 'anulado',   'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000011', v_a, 'rs-11', '#RS11', 'Inés Ríos',   '51999222011', '2026-09-12 15:00+00', null,                  89, 'en_proceso', 'mom-v1.8'),
    ('25300000-0000-0000-0000-000000000012', v_b, 'rs-12', '#RS12', 'Julia Cruz',  '51999222012', '2026-09-12 15:00+00', '2026-09-15 15:00+00', 89, 'entregado', 'mom-v1.8');

  insert into restock_sends (store_id, order_id, phone, product_key, product_name, units, due_at, arm, ok, sent_at) values
    (v_a, '25300000-0000-0000-0000-000000000006', '51999222006', '111', 'Aceite de Semilla Negra', 1, '2026-10-08 15:00+00', 'enviado', true, '2026-10-08 15:00+00');
end $$;

\echo '  a quién le toca hoy'
do $$
declare
  got text;
  r record;
begin
  select string_agg(order_name, ',' order by order_name) into got
    from restock_candidates('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-10-13 15:00+00', 7, 14, 100);
  if got is distinct from '#RS1,#RS2,#RS8,#RS9' then raise exception 'candidatas de A: %', got; end if;

  -- La línea sin id se reconoció por su título y suma sus dos unidades.
  select * into r from restock_candidates('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-10-13 15:00+00', 7, 14, 100)
   where order_name = '#RS2';
  if r.product_key <> '111' or r.units <> 2 or r.due_at <> '2026-10-12 15:00+00'::timestamptz
     or r.product_name <> 'Aceite de Semilla Negra' then
    raise exception '#RS2: % % % %', r.product_key, r.units, r.due_at, r.product_name;
  end if;

  -- Con dos productos, el que vence dentro de la ventana.
  select * into r from restock_candidates('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-10-13 15:00+00', 7, 14, 100)
   where order_name = '#RS8';
  if r.product_key <> '111' then raise exception '#RS8: eligió %', r.product_key; end if;

  -- Un día antes de vencer, todavía no.
  if exists (select 1 from restock_candidates('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-10-07 15:00+00', 7, 14, 100)
              where order_name = '#RS1') then raise exception '#RS1 salió antes de vencer'; end if;

  -- El catálogo junta la línea sin id con su producto.
  select * into r from restock_product_catalog('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-01-01') where product_key = '111';
  -- #RS1, 2 (dos u.), 3, 3B, 6, 7, 8, 9, 9B y 11.
  if r.pedidos <> 10 or r.unidades <> 11 then raise exception 'catálogo 111: % pedidos, % unidades', r.pedidos, r.unidades; end if;
  if exists (select 1 from restock_product_catalog('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-01-01')
              where lower(product_key) like 'aceite%') then raise exception 'el catálogo partió el aceite en dos'; end if;
end $$;

\echo '  un recordatorio por pedido y resultados por grupo'
do $$
declare
  r record;
begin
  begin
    insert into restock_sends (store_id, order_id, phone, product_key, product_name, units, due_at, arm, ok)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25300000-0000-0000-0000-000000000006', '51999222006', '111', 'x', 1, now(), 'enviado', true);
    raise exception 'se aceptó un segundo recordatorio para el mismo pedido';
  exception when unique_violation then null;
  end;
  -- Un intento fallido sí se registra al lado.
  insert into restock_sends (store_id, order_id, phone, product_key, product_name, units, due_at, arm, ok, error)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25300000-0000-0000-0000-000000000006', '51999222006', '111', 'x', 1, now(), 'enviado', false, 'rechazo');

  -- #RS9 al grupo de control. #RS6 (enviado el 08-10) contestó; la clienta
  -- de #RS9 no compró después (su pedido nuevo se anuló).
  insert into restock_sends (store_id, order_id, phone, product_key, product_name, units, due_at, arm, ok, sent_at)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25300000-0000-0000-0000-000000000009', '51999222009', '111', 'x', 1, '2026-10-08 15:00+00', 'control', true, '2026-10-08 15:00+00');
  update restock_sends set replied_at = '2026-10-08 16:00+00', reply_kind = 'boton'
   where order_id = '25300000-0000-0000-0000-000000000006' and ok;
  insert into orders (id, store_id, shopify_order_id, name, created_at) values
    ('25300000-0000-0000-0000-000000000013', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rs-6b', '#RS6B', '2026-10-09 15:00+00');
  insert into order_master (order_id, store_id, shopify_order_id, order_name, customer_phone, order_created_at,
                            delivered_at, order_total, general_status, macro_version) values
    ('25300000-0000-0000-0000-000000000013', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rs-6b', '#RS6B', '51999222006',
     '2026-10-09 15:00+00', '2026-10-11 15:00+00', 89, 'entregado', 'mom-v1.8');

  select * into r from restock_results('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-10-01') where arm = 'enviado';
  if r.clientas <> 1 or r.respondieron <> 1 or r.compraron <> 1 or r.entregados <> 1 then
    raise exception 'enviado: % % % %', r.clientas, r.respondieron, r.compraron, r.entregados;
  end if;
  select * into r from restock_results('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-10-01') where arm = 'control';
  if r.clientas <> 1 or r.respondieron <> 0 or r.compraron <> 0 then
    raise exception 'control: % % %', r.clientas, r.respondieron, r.compraron;
  end if;
end $$;

\echo '  cada quien ve solo sus tiendas; candidatas solo el servidor'
set request.test_uid = '00000000-0000-0000-0000-00000000000a';
set role authenticated;
do $$
begin
  if exists (select 1 from restock_products where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') then
    raise exception 'A: vio productos de la tienda B';
  end if;
  if not exists (select 1 from restock_products where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') then
    raise exception 'A: no ve sus productos';
  end if;
  if exists (select 1 from restock_product_catalog('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-01-01')) then
    raise exception 'A: vio el catálogo de la tienda B';
  end if;
  begin
    insert into restock_products (store_id, product_key, shopify_title, short_name, days_per_unit)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '999', 'x', 'x', 30);
    raise exception 'A: escribió un producto desde el navegador';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set request.test_uid = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
do $$
begin
  if exists (select 1 from restock_sends) or exists (select 1 from contact_opt_outs) then
    raise exception 'D: sin tiendas vio recordatorios';
  end if;
end $$;
reset role;

do $$
begin
  if has_function_privilege('authenticated', 'public.restock_candidates(uuid, timestamptz, integer, integer, integer)', 'execute') then
    raise exception 'authenticated puede ejecutar restock_candidates';
  end if;
  if has_function_privilege('anon', 'public.restock_results(uuid, timestamptz)', 'execute') then
    raise exception 'anon puede ejecutar restock_results';
  end if;
end $$;
\echo '  restock_reminders: 4 comprobaciones OK'
