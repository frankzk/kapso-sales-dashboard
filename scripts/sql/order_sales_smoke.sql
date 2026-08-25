-- ¿De verdad queda fija la atribución de una venta? (0132)
--
-- Lo que se prueba es exactamente lo que se pidió: "que no se traspase". No basta
-- con que el código no escriba un UPDATE — hace falta que la base lo IMPIDA,
-- porque el fallo que motivó la tabla no fue nadie reasignando ventas a mano:
-- fue un número que se recalculaba solo y cambiaba de dueña sin que nadie tocara
-- nada. #KP130367 se movió porque otra asesora mandó "gracias por la confianza"
-- treinta y dos segundos después de la venta.
--
-- Códigos de error: el trigger guardián lanza P0001. Nuestros "la garantía está
-- rota" usan ZZ001 para que NO los trague el handler que espera al trigger.

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- Reutiliza la org/tienda de rls_smoke.sql. Asesoras propias: la que vende, la
-- que pasa por detrás, y dos más para el backfill.
insert into auth.users(id,email) values
  ('5555aaaa-0000-0000-0000-00000000000a','vende@x.com'),
  ('5555aaaa-0000-0000-0000-00000000000b','pasa-por-detras@x.com'),
  ('5555aaaa-0000-0000-0000-00000000000c','backfill-a@x.com'),
  ('5555aaaa-0000-0000-0000-00000000000d','backfill-b@x.com')
on conflict (id) do nothing;
insert into orders(id, store_id, shopify_order_id, name, created_at, customer_phone, total_amount)
values ('55550000-0000-0000-0000-000000000001',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '9500000001', '#SALE1', now(), '51900000001', 298.00)
on conflict (store_id, shopify_order_id) do nothing;

insert into order_sales(order_id, store_id, vendedora, occurred_at, source)
values ('55550000-0000-0000-0000-000000000001',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '5555aaaa-0000-0000-0000-00000000000a', now(), 'sale_action');

-- 1) UPDATE rechazado: nadie puede reasignar la venta.
do $$
begin
  update order_sales set vendedora = '5555aaaa-0000-0000-0000-00000000000b'
   where order_id = '55550000-0000-0000-0000-000000000001';
  raise exception 'order_sales aceptó un UPDATE: la venta se puede traspasar'
    using errcode = 'ZZ001';
exception
  when sqlstate 'P0001' then null;  -- el trigger actuó: correcto
end;
$$;

-- 2) DELETE rechazado: tampoco se borra para volver a escribirla.
do $$
begin
  delete from order_sales where order_id = '55550000-0000-0000-0000-000000000001';
  raise exception 'order_sales aceptó un DELETE: la venta se puede traspasar'
    using errcode = 'ZZ001';
exception
  when sqlstate 'P0001' then null;
end;
$$;

-- 3) Un segundo registro NO cambia la dueña. Es el caso realista: dos acciones
--    sobre el mismo pedido (un reintento, dos asesoras a la vez). La primera
--    gana, y el choque es de PK — no un UPDATE encubierto.
do $$
begin
  insert into order_sales(order_id, store_id, vendedora, occurred_at, source)
  values ('55550000-0000-0000-0000-000000000001',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '5555aaaa-0000-0000-0000-00000000000b', now(), 'sale_action');
  raise exception 'order_sales aceptó una segunda venta para el mismo pedido'
    using errcode = 'ZZ001';
exception
  when unique_violation then null;  -- correcto: la primera es la dueña
end;
$$;

do $$
declare due uuid;
begin
  select vendedora into due from order_sales
   where order_id = '55550000-0000-0000-0000-000000000001';
  if due <> '5555aaaa-0000-0000-0000-00000000000a' then
    raise exception 'la venta cambió de dueña (%): el pin no aguanta', due
      using errcode = 'ZZ001';
  end if;
end;
$$;

-- ── El backfill del histórico ───────────────────────────────────────────────
-- Reconstruye la dueña de pedidos viejos casando la fila `sale` del lead con el
-- pedido POR TIEMPO (±2 min), porque la nota nunca trae el código del pedido.
-- Acá se prueban las dos mitades que importan: que acierte, y que se calle
-- cuando no puede estar segura.

insert into leads(id, store_id, phone, name, created_at)
values ('55551111-0000-0000-0000-000000000001',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '51900000002', 'Backfill OK', now()),
       ('55551111-0000-0000-0000-000000000002',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '51900000003', 'Backfill ambiguo', now())
on conflict (id) do nothing;

-- (a) Un pedido con UNA venta candidata dentro de la ventana → se atribuye.
insert into orders(id, store_id, shopify_order_id, name, created_at, customer_phone, total_amount)
values ('55550000-0000-0000-0000-000000000002',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '9500000002', '#SALE2', now() - interval '10 days', '51900000002', 99.00)
on conflict (store_id, shopify_order_id) do nothing;

insert into lead_calls(lead_id, store_id, vendedora, kind, occurred_at, note)
values ('55551111-0000-0000-0000-000000000001',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '5555aaaa-0000-0000-0000-00000000000c', 'sale',
        now() - interval '10 days' + interval '1 second', 'Venta nueva · PEN 99.00');

-- (b) Un pedido con DOS ventas en la ventana → ambiguo, se descarta. Preferimos
--     dejarlo sin dueña antes que ponerle la equivocada.
insert into orders(id, store_id, shopify_order_id, name, created_at, customer_phone, total_amount)
values ('55550000-0000-0000-0000-000000000003',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '9500000003', '#SALE3', now() - interval '20 days', '51900000003', 149.00)
on conflict (store_id, shopify_order_id) do nothing;

insert into lead_calls(lead_id, store_id, vendedora, kind, occurred_at, note)
values ('55551111-0000-0000-0000-000000000002',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '5555aaaa-0000-0000-0000-00000000000c', 'sale',
        now() - interval '20 days' + interval '1 second', 'Venta A'),
       ('55551111-0000-0000-0000-000000000002',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '5555aaaa-0000-0000-0000-00000000000d', 'sale',
        now() - interval '20 days' + interval '30 seconds', 'Venta B');

select public.backfill_order_sales();

do $$
declare due uuid; amb integer;
begin
  select vendedora into due from order_sales
   where order_id = '55550000-0000-0000-0000-000000000002';
  if due is null then
    raise exception 'el backfill no atribuyó un pedido con una sola venta candidata'
      using errcode = 'ZZ001';
  end if;
  if due <> '5555aaaa-0000-0000-0000-00000000000c' then
    raise exception 'el backfill atribuyó a la asesora equivocada (%)', due
      using errcode = 'ZZ001';
  end if;

  select count(*) into amb from order_sales
   where order_id = '55550000-0000-0000-0000-000000000003';
  if amb <> 0 then
    raise exception 'el backfill atribuyó un pedido AMBIGUO: eligió dueña al azar'
      using errcode = 'ZZ001';
  end if;
end;
$$;

-- (c) Idempotente, y sin pisar lo registrado en vivo. Correrlo otra vez no puede
--     cambiar a nadie de dueña — si pudiera, tendríamos el traspaso de vuelta por
--     la puerta de atrás.
select public.backfill_order_sales();

do $$
declare vivo uuid; n integer;
begin
  select vendedora into vivo from order_sales
   where order_id = '55550000-0000-0000-0000-000000000001';
  if vivo <> '5555aaaa-0000-0000-0000-00000000000a' then
    raise exception 'un segundo backfill cambió la dueña de una venta en vivo (%)', vivo
      using errcode = 'ZZ001';
  end if;
  select count(*) into n from order_sales
   where order_id = '55550000-0000-0000-0000-000000000002';
  if n <> 1 then
    raise exception 'el backfill duplicó filas (% para un pedido)', n
      using errcode = 'ZZ001';
  end if;
end;
$$;
