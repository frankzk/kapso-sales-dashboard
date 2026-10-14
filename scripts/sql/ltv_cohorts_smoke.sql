-- LTV : CPA (migración 0252). Corre en el clúster desechable después de todas
-- las migraciones y reutiliza las tiendas y usuarios de rls_smoke.sql:
-- A (viewer de la tienda A), B (viewer de B), C (owner de las dos), D (sin
-- tiendas).
--
-- Lo que se fija es lo que decide el ratio: quién es clienta nueva y en qué
-- mes, qué pedidos suman a cada horizonte (solo entregados, desde la primera
-- compra, el teléfono por sus últimos nueve dígitos), el gasto de Meta por
-- moneda, y que cada persona vea solo sus tiendas.

do $$
declare
  v_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
begin
  -- Tienda A. X: 100 el 10-06, 50 el 01-07 (dentro de 30 días), 70 el 20-09
  -- (fuera de 90, dentro de 180) y un anulado que no cuenta; además una entrega
  -- de mayo, antes del historial, que tampoco cuenta. Y: 200 el 20-06 y 80 el
  -- 01-08 (dentro de 60), escrito con y sin prefijo. Z: 120 el 05-07.
  insert into orders (id, store_id, shopify_order_id, name, created_at) values
    ('25200000-0000-0000-0000-000000000001', v_a, 'ltv-x1', '#LTVX1', '2026-06-10 15:00+00'),
    ('25200000-0000-0000-0000-000000000002', v_a, 'ltv-x2', '#LTVX2', '2026-07-01 15:00+00'),
    ('25200000-0000-0000-0000-000000000003', v_a, 'ltv-x3', '#LTVX3', '2026-09-20 15:00+00'),
    ('25200000-0000-0000-0000-000000000004', v_a, 'ltv-x4', '#LTVX4', '2026-06-12 15:00+00'),
    ('25200000-0000-0000-0000-000000000005', v_a, 'ltv-x0', '#LTVX0', '2026-05-20 15:00+00'),
    ('25200000-0000-0000-0000-000000000006', v_a, 'ltv-y1', '#LTVY1', '2026-06-20 15:00+00'),
    ('25200000-0000-0000-0000-000000000007', v_a, 'ltv-y2', '#LTVY2', '2026-08-01 15:00+00'),
    ('25200000-0000-0000-0000-000000000008', v_a, 'ltv-z1', '#LTVZ1', '2026-07-05 15:00+00'),
    ('25200000-0000-0000-0000-000000000009', v_b, 'ltv-w1', '#LTVW1', '2026-06-15 15:00+00');
  insert into order_master (order_id, store_id, shopify_order_id, order_name, customer_phone, order_created_at, order_total, general_status, macro_version) values
    ('25200000-0000-0000-0000-000000000001', v_a, 'ltv-x1', '#LTVX1', '51999111001',     '2026-06-10 15:00+00', 100, 'entregado', 'mom-v1.8'),
    ('25200000-0000-0000-0000-000000000002', v_a, 'ltv-x2', '#LTVX2', '+51 999 111 001', '2026-07-01 15:00+00',  50, 'entregado', 'mom-v1.8'),
    ('25200000-0000-0000-0000-000000000003', v_a, 'ltv-x3', '#LTVX3', '999111001',       '2026-09-20 15:00+00',  70, 'entregado', 'mom-v1.8'),
    ('25200000-0000-0000-0000-000000000004', v_a, 'ltv-x4', '#LTVX4', '999111001',       '2026-06-12 15:00+00', 999, 'anulado',   'mom-v1.8'),
    ('25200000-0000-0000-0000-000000000005', v_a, 'ltv-x0', '#LTVX0', '999111001',       '2026-05-20 15:00+00', 999, 'entregado', 'mom-v1.8'),
    ('25200000-0000-0000-0000-000000000006', v_a, 'ltv-y1', '#LTVY1', '999-111-002',     '2026-06-20 15:00+00', 200, 'entregado', 'mom-v1.8'),
    ('25200000-0000-0000-0000-000000000007', v_a, 'ltv-y2', '#LTVY2', '51999111002',     '2026-08-01 15:00+00',  80, 'entregado', 'mom-v1.8'),
    ('25200000-0000-0000-0000-000000000008', v_a, 'ltv-z1', '#LTVZ1', '999111003',       '2026-07-05 15:00+00', 120, 'entregado', 'mom-v1.8'),
    ('25200000-0000-0000-0000-000000000009', v_b, 'ltv-w1', '#LTVW1', '999111004',       '2026-06-15 15:00+00', 300, 'entregado', 'mom-v1.8');

  insert into meta_ad_insights_daily (store_id, account_id, currency, date, ad_id, spend) values
    (v_a, 'act-pen', 'PEN', '2026-06-05', 'ltv-ad-1', 100),
    (v_a, 'act-usd', 'USD', '2026-06-06', 'ltv-ad-2', 10),
    (v_a, 'act-usd', 'USD', '2026-06-07', 'ltv-ad-2', 5),
    (v_a, 'act-pen', null,  '2026-07-01', 'ltv-ad-3', 7),
    (v_a, 'act-pen', 'PEN', '2026-05-30', 'ltv-ad-1', 999),
    (v_b, 'act-b',   'PEN', '2026-06-05', 'ltv-ad-4', 40);
end $$;

\echo '  owner: clientas nuevas por mes, valor a cada horizonte y recompra'
set request.test_uid = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
do $$
declare
  r record;
begin
  -- Junio en A: X y Y. A 30 días 100 + 50 + 200; a 60 suma el 80 de Y; a 90
  -- igual; a 180 suma el 70 de X. Las dos compraron de nuevo en 90 días.
  select * into r from ltv_cohorts(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-06-01')
   where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and cohort_month = '2026-06-01';
  if r.new_customers <> 2 then raise exception 'junio A: esperaba 2 clientas nuevas, hay %', r.new_customers; end if;
  if r.value_30 <> 350 or r.value_60 <> 430 or r.value_90 <> 430 or r.value_180 <> 500 or r.value_365 <> 500 then
    raise exception 'junio A: valores % % % % %', r.value_30, r.value_60, r.value_90, r.value_180, r.value_365;
  end if;
  if r.repeat_90 <> 2 then raise exception 'junio A: esperaba 2 recompras a 90 días, hay %', r.repeat_90; end if;
  if r.last_first_at <> '2026-06-20 15:00+00'::timestamptz then raise exception 'junio A: última primera compra %', r.last_first_at; end if;

  -- Julio en A: solo Z, que es nueva. X compró en julio pero no es nueva.
  select * into r from ltv_cohorts(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-06-01')
   where cohort_month = '2026-07-01';
  if r.new_customers <> 1 or r.value_30 <> 120 or r.repeat_90 <> 0 then
    raise exception 'julio A: % clientas, % a 30 días, % recompras', r.new_customers, r.value_30, r.repeat_90;
  end if;

  -- El gasto por mes y moneda, sin lo de antes del historial; sin moneda es «?».
  if (select spend from meta_spend_by_month(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-06-01')
       where month = '2026-06-01' and currency = 'PEN') <> 100 then raise exception 'gasto PEN de junio'; end if;
  if (select spend from meta_spend_by_month(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-06-01')
       where month = '2026-06-01' and currency = 'USD') <> 15 then raise exception 'gasto USD de junio'; end if;
  if (select spend from meta_spend_by_month(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-06-01')
       where month = '2026-07-01' and currency = '?') <> 7 then raise exception 'gasto sin moneda de julio'; end if;
  if exists (select 1 from meta_spend_by_month(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-06-01') where month < '2026-06-01') then
    raise exception 'entró gasto de antes del historial';
  end if;
end $$;
reset role;

\echo '  cada quien ve solo sus tiendas'
set request.test_uid = '00000000-0000-0000-0000-00000000000a';
set role authenticated;
do $$
begin
  if exists (select 1 from ltv_cohorts(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-06-01')
              where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') then raise exception 'A: vio clientas de la tienda B'; end if;
  if exists (select 1 from meta_spend_by_month(array['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-06-01')) then
    raise exception 'A: vio gasto de la tienda B';
  end if;
  if not exists (select 1 from ltv_cohorts(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-06-01')) then
    raise exception 'A: no ve sus propias clientas';
  end if;
end $$;
reset role;

set request.test_uid = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
do $$
begin
  if exists (select 1 from ltv_cohorts(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-06-01')) then
    raise exception 'D: sin tiendas vio clientas';
  end if;
end $$;
reset role;

do $$
begin
  if has_function_privilege('anon', 'public.ltv_cohorts(uuid[], date)', 'execute') then
    raise exception 'anon puede ejecutar ltv_cohorts';
  end if;
  if has_function_privilege('anon', 'public.meta_spend_by_month(uuid[], date)', 'execute') then
    raise exception 'anon puede ejecutar meta_spend_by_month';
  end if;
end $$;
\echo '  ltv_cohorts: 4 comprobaciones OK'
