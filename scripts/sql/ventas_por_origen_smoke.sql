-- Ventas por origen y conversión por fuente (migración 0265). Corre en el
-- clúster desechable después de todas las migraciones y reutiliza las tiendas
-- y usuarios de rls_smoke.sql: A (viewer de la tienda A), C (owner de las dos),
-- D (sin tiendas). Todo dentro de una transacción que se deshace al final.
--
-- Lo que se fija es lo que decide la pantalla (MOM §17.4): todas las ventas por
-- día LOCAL y canal, con los cancelados aparte; la conversión de cada fuente
-- como cohorte de nacimiento con 7 días de maduración y 7 de ventana, por
-- cualquier canal, con quién cerró; las que ya eran clientas aparte; el pedido
-- de otra tienda no cuenta; el lead sin teléfono convierte por su pedido;
-- whatsapp-bot es orgánico y manual no tiene tasa; el % de las asesoras como en
-- Productividad; y que cada persona vea solo sus tiendas. Abril de 2026, para
-- no cruzarse con los demás smokes.

begin;

do $$
declare
  v_a  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_b  uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  v_uc uuid := '00000000-0000-0000-0000-00000000000c';
begin
  -- Ventas por origen: 10 y 11 de abril (Lima).
  insert into orders (id, store_id, shopify_order_id, name, created_at, total_amount, total_refunded, currency, tags, customer_phone, cancelled_at) values
    ('25900000-0000-0000-0000-000000000001', v_a, 'vo-a1', '#VO1', '2026-04-10 15:00+00', 100, 0, 'PEN', array['kapso'], '51999200001', null),
    -- Web cancelado: aparte.
    ('25900000-0000-0000-0000-000000000002', v_a, 'vo-a2', '#VO2', '2026-04-10 16:00+00', 200, 0, 'PEN', array['easysell_cod_form'], '51999200002', '2026-04-10 18:00+00'),
    -- 23:30 del 10 en Lima (04:30 UTC del 11): es del día 10.
    ('25900000-0000-0000-0000-000000000003', v_a, 'vo-a3', '#VO3', '2026-04-11 04:30+00', 50, 0, 'PEN', array['easysell_cod_form'], '51999200003', null),
    -- Venta registrada de asesora, día 11.
    ('25900000-0000-0000-0000-000000000004', v_a, 'vo-a4', '#VO4', '2026-04-11 15:00+00', 300, 0, 'PEN', array[]::text[], '51999200004', null),
    -- Tienda B.
    ('25900000-0000-0000-0000-000000000005', v_b, 'vo-b1', '#VOB1', '2026-04-10 15:00+00', 700, 0, 'PEN', array['kapso'], '51999200005', null);
  insert into order_sales (order_id, store_id, vendedora, occurred_at) values
    ('25900000-0000-0000-0000-000000000004', v_a, v_uc, '2026-04-11 15:00+00');

  -- Conversión por fuente: leads nacidos el 02-04 (Lima) y sus pedidos.
  insert into orders (id, store_id, shopify_order_id, name, created_at, total_amount, total_refunded, currency, tags, customer_phone, cancelled_at) values
    -- L1 (meta_ad) compra a los 2 días; la registró una asesora.
    ('25900000-0000-0000-0000-000000000101', v_a, 'cf-1', '#CF1', '2026-04-04 15:00+00', 120, 0, 'PEN', array['easysell_cod_form'], '51999200101', null),
    -- L2 (cod_cart) compra a los 10 días: fuera de la ventana.
    ('25900000-0000-0000-0000-000000000102', v_a, 'cf-2', '#CF2', '2026-04-12 15:00+00', 120, 0, 'PEN', array['easysell_cod_form'], '51999200102', null),
    -- L3 (orgánico) ya había comprado antes de nacer el lead.
    ('25900000-0000-0000-0000-000000000103', v_a, 'cf-3', '#CF3', '2026-03-20 15:00+00', 120, 0, 'PEN', array['kapso'], '51999200103', null),
    -- L4 (whatsapp-bot) compra sola en la web al día siguiente.
    ('25900000-0000-0000-0000-000000000104', v_a, 'cf-4', '#CF4', '2026-04-03 15:00+00', 120, 0, 'PEN', array['easysell_cod_form'], '51999200104', null),
    -- L6 (meta_ad, sin teléfono): su propio pedido, del bot.
    ('25900000-0000-0000-0000-000000000106', v_a, 'cf-6', '#CF6', '2026-04-03 15:00+00', 120, 0, 'PEN', array['kapso'], null, null),
    -- L7 (cod_cart): su pedido está cancelado.
    ('25900000-0000-0000-0000-000000000107', v_a, 'cf-7', '#CF7', '2026-04-03 15:00+00', 120, 0, 'PEN', array['easysell_cod_form'], '51999200107', '2026-04-04 15:00+00'),
    -- L8 (fb_web): compró, pero en la OTRA tienda.
    ('25900000-0000-0000-0000-000000000108', v_b, 'cf-8', '#CF8', '2026-04-03 15:00+00', 120, 0, 'PEN', array['easysell_cod_form'], '51999200108', null),
    -- Pedido del bot del que Kapta creó el lead L13 (sin first_seen_at, después del pedido).
    ('25900000-0000-0000-0000-000000000113', v_a, 'cf-13', '#CF13', '2026-04-02 15:00+00', 120, 0, 'PEN', array['kapso'], '51999200113', null),
    -- Venta de asesora anulada después (cuenta en ventas, aparte en canceladas).
    ('25900000-0000-0000-0000-000000000112', v_a, 'cf-12', '#CF12', '2026-04-04 16:00+00', 120, 0, 'PEN', array[]::text[], '51999200112', '2026-04-05 15:00+00');
  insert into order_sales (order_id, store_id, vendedora, occurred_at) values
    ('25900000-0000-0000-0000-000000000101', v_a, v_uc, '2026-04-04 15:00+00'),
    ('25900000-0000-0000-0000-000000000112', v_a, v_uc, '2026-04-04 16:00+00');

  insert into leads (id, store_id, phone, bsuid, source, first_seen_at, created_at, order_id) values
    ('25900000-0000-0000-0000-0000000000a1', v_a, '51999200101', null, 'meta_ad',          '2026-04-02 15:00+00', '2026-04-02 15:05+00', null),
    ('25900000-0000-0000-0000-0000000000a2', v_a, '51999200102', null, 'cod_cart',         '2026-04-02 15:00+00', '2026-04-02 15:05+00', null),
    ('25900000-0000-0000-0000-0000000000a3', v_a, '51999200103', null, null,               '2026-04-02 15:00+00', '2026-04-02 15:05+00', null),
    ('25900000-0000-0000-0000-0000000000a4', v_a, '51999200104', null, 'whatsapp-bot',     '2026-04-02 15:00+00', '2026-04-02 15:05+00', null),
    ('25900000-0000-0000-0000-0000000000a5', v_a, '51999200105', null, 'manual',           '2026-04-02 15:00+00', '2026-04-02 15:05+00', null),
    ('25900000-0000-0000-0000-0000000000a6', v_a, null, 'PE.cfbsuid6',          'meta_ad',          '2026-04-02 15:00+00', '2026-04-02 15:05+00', '25900000-0000-0000-0000-000000000106'),
    ('25900000-0000-0000-0000-0000000000a7', v_a, '51999200107', null, 'cod_cart',         '2026-04-02 15:00+00', '2026-04-02 15:05+00', '25900000-0000-0000-0000-000000000107'),
    ('25900000-0000-0000-0000-0000000000a8', v_a, '51999200108', null, 'fb_web',           '2026-04-02 15:00+00', '2026-04-02 15:05+00', null),
    -- Sin first_seen_at: nace por created_at.
    ('25900000-0000-0000-0000-0000000000a9', v_a, '51999200109', null, 'abandoned_browse', null,                  '2026-04-02 15:00+00', null),
    -- L13: creado desde su propio pedido, nunca escribió. No nace en la cohorte
    -- (si naciera, «Orgánico» tendría 3 nacidos y 2 ya clientas).
    ('25900000-0000-0000-0000-0000000000ad', v_a, '51999200113', null, null,               null,                  '2026-04-02 15:00:30+00', '25900000-0000-0000-0000-000000000113'),
    -- Nació antes del periodo: no es de esta cohorte.
    ('25900000-0000-0000-0000-0000000000aa', v_a, '51999200110', null, null,               '2026-03-25 15:00+00', '2026-03-25 15:05+00', null),
    -- Recién nacido (hace 2 días): espera sus 7 días.
    ('25900000-0000-0000-0000-0000000000ab', v_a, '51999200111', null, 'meta_ad',          now() - interval '2 days', now() - interval '2 days', null);

  insert into lead_calls (lead_id, store_id, vendedora, kind, occurred_at) values
    -- L1 dos veces (un solo lead trabajado) y L2 con una nota firmada: 2 leads.
    ('25900000-0000-0000-0000-0000000000a1', v_a, v_uc, 'call',        '2026-04-02 16:00+00'),
    ('25900000-0000-0000-0000-0000000000a1', v_a, v_uc, 'message',     '2026-04-03 16:00+00'),
    ('25900000-0000-0000-0000-0000000000a2', v_a, v_uc, 'note',        '2026-04-02 16:00+00'),
    -- No son gestión: el sistema, el agente de voz y una fila sin firma.
    ('25900000-0000-0000-0000-0000000000a3', v_a, v_uc, 'system',      '2026-04-02 16:00+00'),
    ('25900000-0000-0000-0000-0000000000a4', v_a, v_uc, 'voice_agent', '2026-04-02 16:00+00'),
    ('25900000-0000-0000-0000-0000000000a5', v_a, null, 'call',        '2026-04-02 16:00+00');
end $$;

\echo '  ventas por origen: día local, un canal por pedido, cancelados aparte'
set request.test_uid = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
do $$
declare
  v_res jsonb;
  v_n   int;
begin
  v_res := ventas_por_origen(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-04-10', '2026-04-11');
  if (v_res->>'version')::int <> 1 then raise exception 'versión %', v_res->>'version'; end if;
  if jsonb_array_length(v_res->'filas') <> 3 then raise exception 'esperaba 3 filas (día × canal): %', v_res; end if;
  if not exists (select 1 from jsonb_array_elements(v_res->'filas') f
                  where f->>'dia' = '2026-04-10' and f->>'canal' = 'bot_kapso'
                    and (f->>'pedidos')::int = 1 and (f->>'ingresos')::numeric = 100) then
    raise exception 'el bot del día 10: %', v_res;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_res->'filas') f
                  where f->>'dia' = '2026-04-10' and f->>'canal' = 'web'
                    and (f->>'pedidos')::int = 1 and (f->>'ingresos')::numeric = 50 and (f->>'cancelados')::int = 1) then
    raise exception 'la web del día 10: el de las 23:30 de Lima cuenta, el cancelado va aparte: %', v_res;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_res->'filas') f
                  where f->>'dia' = '2026-04-11' and f->>'canal' = 'asesora' and (f->>'pedidos')::int = 1) then
    raise exception 'la venta registrada del día 11 es de asesora: %', v_res;
  end if;

  -- El owner ve las dos tiendas; un rango vacío da filas vacías, no null.
  v_res := ventas_por_origen(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-04-10', '2026-04-11');
  select count(distinct f->>'store_id') into v_n from jsonb_array_elements(v_res->'filas') f;
  if v_n <> 2 then raise exception 'el owner debía ver 2 tiendas (%)', v_res; end if;
  if jsonb_array_length(ventas_por_origen(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2020-01-01', '2020-01-02')->'filas') <> 0 then
    raise exception 'rango vacío con filas';
  end if;

  -- La vista y canal_de_cierre dicen lo mismo del pedido de la asesora.
  if (select canal from pedidos_canal where id = '25900000-0000-0000-0000-000000000004') <> 'asesora' then
    raise exception 'pedidos_canal: la venta registrada es de asesora';
  end if;
end $$;
reset role;

\echo '  conversión por fuente: cohorte de nacimiento, 7 días, cualquier canal, ya clientas aparte'
set request.test_uid = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
do $$
declare
  v_res jsonb;
  v_f   jsonb;
begin
  v_res := conversion_por_fuente(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-04-01', '2026-04-05');
  if (v_res->>'version')::int <> 1 then raise exception 'versión %', v_res->>'version'; end if;

  -- fuente → (nacidos, por_madurar, ya_clientas, prospectos, convertidos)
  for v_f in select f from jsonb_array_elements(v_res->'fuentes') f loop
    if (v_f->>'fuente',
        (v_f->>'nacidos')::int, (v_f->>'por_madurar')::int, (v_f->>'ya_clientas')::int,
        (v_f->>'prospectos')::int, (v_f->>'convertidos')::int)
       not in (('meta_ad', 2, 0, 0, 2, 2),
               ('cod_cart', 2, 0, 0, 2, 0),
               ('organico', 2, 0, 1, 1, 1),
               ('sin_tasa', 1, 0, 0, 1, 0),
               ('fb_web', 1, 0, 0, 1, 0),
               ('abandoned_browse', 1, 0, 0, 1, 0)) then
      raise exception 'fila inesperada %: %', v_f, v_res;
    end if;
  end loop;
  if jsonb_array_length(v_res->'fuentes') <> 6 then raise exception 'esperaba 6 fuentes: %', v_res; end if;

  -- Quién cerró: L1 una asesora, L6 el bot (por su pedido, sin teléfono), L4 la web.
  if jsonb_array_length(v_res->'cierres') <> 3
     or not exists (select 1 from jsonb_array_elements(v_res->'cierres') c where c->>'fuente' = 'meta_ad' and c->>'canal' = 'asesora' and (c->>'convertidos')::int = 1)
     or not exists (select 1 from jsonb_array_elements(v_res->'cierres') c where c->>'fuente' = 'meta_ad' and c->>'canal' = 'bot_kapso' and (c->>'convertidos')::int = 1)
     or not exists (select 1 from jsonb_array_elements(v_res->'cierres') c where c->>'fuente' = 'organico' and c->>'canal' = 'web' and (c->>'convertidos')::int = 1) then
    raise exception 'cierres: %', v_res->'cierres';
  end if;

  -- Asesoras como en Productividad: 2 leads distintos, 2 ventas (1 anulada).
  if (v_res->'asesoras'->0->>'leads_trabajados')::int <> 2
     or (v_res->'asesoras'->0->>'ventas')::int <> 2
     or (v_res->'asesoras'->0->>'canceladas')::int <> 1 then
    raise exception 'asesoras: %', v_res->'asesoras';
  end if;

  -- El lead de hace 2 días espera sus 7 días: está, pero no entra a la tasa.
  v_res := conversion_por_fuente(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], current_date - 3, current_date);
  if not exists (select 1 from jsonb_array_elements(v_res->'fuentes') f
                  where f->>'fuente' = 'meta_ad' and (f->>'nacidos')::int = 1
                    and (f->>'por_madurar')::int = 1 and (f->>'prospectos')::int = 0) then
    raise exception 'el lead reciente debía esperar sus 7 días: %', v_res;
  end if;
end $$;
reset role;

\echo '  viewer A solo ve A; viewer sin tiendas, nada; anon ni ejecuta ni lee la vista'
set request.test_uid = '00000000-0000-0000-0000-00000000000a';
set role authenticated;
do $$
declare v_res jsonb;
begin
  v_res := ventas_por_origen(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-04-10', '2026-04-11');
  if exists (select 1 from jsonb_array_elements(v_res->'filas') f where f->>'store_id' <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') then
    raise exception 'el viewer de A vio otra tienda en ventas_por_origen (%)', v_res;
  end if;
  v_res := conversion_por_fuente(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-04-01', '2026-04-05');
  if exists (select 1 from jsonb_array_elements(v_res->'fuentes') f where f->>'store_id' <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
     or exists (select 1 from jsonb_array_elements(v_res->'asesoras') f where f->>'store_id' <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') then
    raise exception 'el viewer de A vio otra tienda en conversion_por_fuente (%)', v_res;
  end if;
  if exists (select 1 from pedidos_canal where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') then
    raise exception 'el viewer de A vio pedidos de B en la vista';
  end if;
end $$;
reset role;

set request.test_uid = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
do $$
begin
  if jsonb_array_length(ventas_por_origen(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-04-10', '2026-04-11')->'filas') <> 0
     or jsonb_array_length(conversion_por_fuente(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-04-01', '2026-04-05')->'fuentes') <> 0 then
    raise exception 'un viewer sin tiendas no puede ver nada';
  end if;
end $$;
reset role;

do $$
begin
  if has_function_privilege('anon', 'public.ventas_por_origen(uuid[], date, date)', 'execute')
     or has_function_privilege('anon', 'public.conversion_por_fuente(uuid[], date, date)', 'execute') then
    raise exception 'anon no debe poder ejecutar las funciones de 0265';
  end if;
  if has_table_privilege('anon', 'public.pedidos_canal', 'select') then
    raise exception 'anon no debe poder leer pedidos_canal';
  end if;
  if has_table_privilege('authenticated', 'public.pedidos_canal', 'insert')
     or has_table_privilege('authenticated', 'public.pedidos_canal', 'update')
     or has_table_privilege('authenticated', 'public.pedidos_canal', 'delete') then
    raise exception 'pedidos_canal es de solo lectura';
  end if;
end $$;

\echo '  ventas_por_origen y conversion_por_fuente: comprobaciones OK'

rollback;
