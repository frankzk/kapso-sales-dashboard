-- Canal de cierre (migración 0257). Corre en el clúster desechable después de
-- todas las migraciones y reutiliza las tiendas y usuarios de rls_smoke.sql:
-- A (viewer de la tienda A), C (owner de las dos), D (sin tiendas).
--
-- Lo que se fija es lo que decide el panel: un pedido cae en UN solo canal y
-- en el orden del MOM §17.3 (la venta registrada de la asesora gana a
-- cualquier etiqueta), «ayudado por asesora» solo con una gestión firmada de la
-- misma tienda en los 7 días previos, los cancelados aparte, el día local de la
-- tienda, y que cada persona vea solo sus tiendas. Fechas de marzo de 2026 para
-- no cruzarse con los pedidos de los demás smokes.

do $$
declare
  v_a  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_b  uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  v_uc uuid := '00000000-0000-0000-0000-00000000000c';
  v_l1 uuid := '25700000-0000-0000-0000-0000000000a1';
  v_l3 uuid := '25700000-0000-0000-0000-0000000000a3';
  v_l4 uuid := '25700000-0000-0000-0000-0000000000a4';
  v_l7 uuid := '25700000-0000-0000-0000-0000000000a7';
  v_lb uuid := '25700000-0000-0000-0000-0000000000b4';
begin
  insert into orders (id, store_id, shopify_order_id, name, created_at, total_amount, total_refunded, currency, tags, customer_phone, cancelled_at) values
    -- 1. Venta registrada por una asesora, aunque el pedido diga kapso.
    ('25700000-0000-0000-0000-000000000001', v_a, 'cc-a1', '#CC1', '2026-03-10 15:00+00', 100, 0, 'PEN', array['kapso', 'venta_manual'], '51999000001', null),
    -- 2. Recompra automática: completa el borrador de EasySell, así que trae sus etiquetas.
    ('25700000-0000-0000-0000-000000000002', v_a, 'cc-a2', '#CC2', '2026-03-10 15:05+00', 200, 0, 'PEN', array['easysell_cod_form'], '51999000002', null),
    -- 3. Bot de Kapso (la etiqueta con mayúscula también cuenta), ayudado 2 días antes.
    ('25700000-0000-0000-0000-000000000003', v_a, 'cc-a3', '#CC3', '2026-03-10 15:10+00', 300, 0, 'PEN', array['Kapso', 'whatsapp'], '51999000003', null),
    -- 4. Bot de Kapso con gestión de hace 10 días y otra de la OTRA tienda: no ayudado.
    ('25700000-0000-0000-0000-000000000004', v_a, 'cc-a4', '#CC4', '2026-03-10 15:15+00', 400, 0, 'PEN', array['kapso'], '51999000004', null),
    -- 5. El otro bot de carritos.
    ('25700000-0000-0000-0000-000000000005', v_a, 'cc-a5', '#CC5', '2026-03-10 15:20+00', 500, 0, 'PEN', array['BOT', 'CARRITO RECUPERADO'], '51999000005', null),
    -- 6. Web cancelado: aparte, fuera de pedidos e ingresos.
    ('25700000-0000-0000-0000-000000000006', v_a, 'cc-a6', '#CC6', '2026-03-10 15:25+00', 600, 0, 'PEN', array['easysell_cod_form'], '51999000006', '2026-03-10 18:00+00'),
    -- 7. Web con reembolso parcial; solo notas sin firma o que no son gestión.
    ('25700000-0000-0000-0000-000000000007', v_a, 'cc-a7', '#CC7', '2026-03-10 15:30+00', 150, 50, 'PEN', array['easysell_cod_form', 'easysell-abandoned-checkout'], '51999000007', null),
    -- 8. Otros: sin etiquetas de origen y sin teléfono.
    ('25700000-0000-0000-0000-000000000008', v_a, 'cc-a8', '#CC8', '2026-03-10 15:35+00', 80, 0, 'PEN', array['catalogo-wsp'], null, null),
    -- 9. 23:30 del 10-03 en Lima (04:30 UTC del 11-03): es del día 10.
    ('25700000-0000-0000-0000-000000000009', v_a, 'cc-a9', '#CC9', '2026-03-11 04:30+00', 90, 0, 'PEN', array['kapso'], '51999000009', null),
    -- 10. 23:30 del 09-03 en Lima (04:30 UTC del 10-03): queda fuera del día 10.
    ('25700000-0000-0000-0000-000000000010', v_a, 'cc-a10', '#CC10', '2026-03-10 04:30+00', 999, 0, 'PEN', array['kapso'], '51999000010', null),
    -- 11. Tienda B: el viewer de A no lo ve.
    ('25700000-0000-0000-0000-000000000011', v_b, 'cc-b1', '#CCB1', '2026-03-10 15:00+00', 700, 0, 'PEN', array['easysell_cod_form'], '51999000011', null);

  insert into order_sales (order_id, store_id, vendedora, occurred_at) values
    ('25700000-0000-0000-0000-000000000001', v_a, v_uc, '2026-03-10 15:00+00');

  insert into auto_order_trials (store_id, draft_order_gid, cohort, grupo, status, shopify_order_id) values
    (v_a, 'gid://shopify/DraftOrder/cc-a2', 'cc-cohorte', 'A', 'generado', 'cc-a2');

  insert into leads (id, store_id, phone) values
    (v_l1, v_a, '51999000001'),
    (v_l3, v_a, '51999000003'),
    (v_l4, v_a, '51999000004'),
    (v_l7, v_a, '51999000007'),
    (v_lb, v_b, '51999000004');

  insert into lead_calls (lead_id, store_id, vendedora, kind, occurred_at) values
    -- La asesora gestionó a la clienta 1: igual es su venta, no «ayudada».
    (v_l1, v_a, v_uc, 'call',    '2026-03-09 15:00+00'),
    -- Ayuda real al pedido 3.
    (v_l3, v_a, v_uc, 'message', '2026-03-08 15:00+00'),
    -- Pedido 4: hace 10 días en A, y ayer pero en el lead de B.
    (v_l4, v_a, v_uc, 'call',    '2026-02-28 15:00+00'),
    (v_lb, v_b, v_uc, 'call',    '2026-03-09 15:00+00'),
    -- Pedido 7: una fila del sistema sin firma y una nota firmada; ninguna es gestión.
    (v_l7, v_a, null, 'system',  '2026-03-09 15:00+00'),
    (v_l7, v_a, v_uc, 'note',    '2026-03-09 16:00+00');
end $$;

\echo '  owner: un canal por pedido, en el orden del MOM, cancelados aparte, día local'
set request.test_uid = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
do $$
declare
  v_res jsonb;
  v_n   int;
  function_canal text;
begin
  v_res := canal_de_cierre(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-03-10', '2026-03-10');
  if (v_res->>'version')::int <> 1 then raise exception 'versión %', v_res->>'version'; end if;

  -- Ocho pedidos activos del día 10 en A (el 6 está cancelado; el 10 es del día 9).
  select sum((f->>'pedidos')::int) into v_n from jsonb_array_elements(v_res->'filas') f;
  if v_n <> 8 then raise exception 'esperaba 8 pedidos activos en A, hay % (%)', v_n, v_res; end if;

  for function_canal, v_n in
    select f->>'canal', (f->>'pedidos')::int from jsonb_array_elements(v_res->'filas') f
  loop
    if (function_canal, v_n) not in (('asesora', 1), ('recompra_auto', 1), ('bot_kapso', 3), ('bot_externo', 1), ('web', 1), ('otros', 1)) then
      raise exception 'canal % con % pedidos (%)', function_canal, v_n, v_res;
    end if;
  end loop;

  if (select (f->>'cancelados')::int from jsonb_array_elements(v_res->'filas') f where f->>'canal' = 'web') <> 1 then
    raise exception 'el web cancelado debía ir aparte (%)', v_res;
  end if;
  if (select (f->>'ingresos')::numeric from jsonb_array_elements(v_res->'filas') f where f->>'canal' = 'web') <> 100 then
    raise exception 'ingreso web = total − reembolsado = 100 (%)', v_res;
  end if;
  if (select (f->>'ingresos')::numeric from jsonb_array_elements(v_res->'filas') f where f->>'canal' = 'bot_kapso') <> 790 then
    raise exception 'bot_kapso = 300 + 400 + 90, sin el 999 del día anterior (%)', v_res;
  end if;

  -- «Ayudado»: solo el 3. Ni la gestión de hace 10 días, ni la de la otra
  -- tienda, ni una nota o una fila del sistema; y la venta de la asesora nunca.
  if (select (f->>'ayudados')::int from jsonb_array_elements(v_res->'filas') f where f->>'canal' = 'bot_kapso') <> 1 then
    raise exception 'esperaba 1 pedido del bot ayudado (%)', v_res;
  end if;
  if (select (f->>'ingresos_ayudados')::numeric from jsonb_array_elements(v_res->'filas') f where f->>'canal' = 'bot_kapso') <> 300 then
    raise exception 'el ayudado es el pedido 3, de 300 (%)', v_res;
  end if;
  if (select sum((f->>'ayudados')::int) from jsonb_array_elements(v_res->'filas') f where f->>'canal' <> 'bot_kapso') <> 0 then
    raise exception 'nadie más estaba ayudado (%)', v_res;
  end if;

  -- El owner ve las dos tiendas cuando las pide.
  v_res := canal_de_cierre(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-03-10', '2026-03-10');
  select count(distinct f->>'store_id') into v_n from jsonb_array_elements(v_res->'filas') f;
  if v_n <> 2 then raise exception 'el owner debía ver 2 tiendas (%)', v_res; end if;

  -- Un rango sin pedidos devuelve filas vacías, no null.
  v_res := canal_de_cierre(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2020-01-01', '2020-01-02');
  if jsonb_array_length(v_res->'filas') <> 0 then raise exception 'rango vacío: %', v_res; end if;
end $$;
reset role;

\echo '  viewer A solo ve A; viewer sin tiendas, nada; anon no ejecuta'
set request.test_uid = '00000000-0000-0000-0000-00000000000a';
set role authenticated;
do $$
declare v_res jsonb;
begin
  v_res := canal_de_cierre(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-03-10', '2026-03-10');
  if exists (select 1 from jsonb_array_elements(v_res->'filas') f where f->>'store_id' <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') then
    raise exception 'el viewer de A vio otra tienda (%)', v_res;
  end if;
end $$;
reset role;

set request.test_uid = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
do $$
begin
  if jsonb_array_length(canal_de_cierre(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-03-10', '2026-03-10')->'filas') <> 0 then
    raise exception 'un viewer sin tiendas no puede ver nada';
  end if;
end $$;
reset role;

do $$
begin
  if has_function_privilege('anon', 'public.canal_de_cierre(uuid[], date, date)', 'execute') then
    raise exception 'anon no debe poder ejecutar canal_de_cierre';
  end if;
end $$;
