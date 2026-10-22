\set ON_ERROR_STOP on
-- 0270: la caja «por definir» que el cuaderno de Grupo GF da por entregada pasa
-- a salida entregada del motorizado propio (decisión del dueño, 19-10-2026; MOM
-- §30.8, §4). Corre en el clúster desechable de verify-db, después de todas las
-- migraciones, dentro de una transacción que se deshace. Reutiliza la tienda A
-- de rls_smoke.sql (org 3333…).
--
-- Lo que se fija aquí es lo que decide qué caja se toca, porque es un relleno de
-- datos sobre producción y un error no se ve hasta que alguien liquida:
--   a) entra el caso objetivo, de Alexis y de Reparto propio, con los mismos
--      valores que escribe `ownSalidaRow` (lib/own-salida.ts) y su evento
--      `route_output_filled`; lo de la caja (consecutivo, código, QR,
--      preparación, custodia) no se toca, y el pedido queda desfasado para el
--      barrido del Master. También entra con una caja anterior que ya volvió
--      (custodia devuelta o `returned_at`: no es salida viva) y con la caja sin
--      `ready_at` (cuenta desde su creación);
--   b) quedan fuera: Urpi (por el courier del override o porque Urpi lo
--      reportó), el último override sin courier, sin fecha, contradicho por una
--      fila posterior, con otra salida entregada, con la salida viva que no es
--      «por definir», con dos salidas vivas, la caja que no estaba lista ese día
--      o no está escaneada, el anulado en Shopify, la entrega posterior al
--      21-10-2026, el pedido cuyo estado no se puso a mano, la caja que no está
--      en la empresa (retorno pedido), el pedido en otra subetapa, en otra
--      macroetapa o fuera de Lima, el día del cuaderno más de 30 días antes de
--      la caja y la guía que ya tiene otra salida de «propio»;
--   c) correrla otra vez no duplica eventos ni cambia nada.
begin;

-- Un pedido de Lima en «Por cerrar · Salida adicional activa» con su S01 «por
-- definir» y el override de la entrega del cuaderno. Lo que cada caso cambia
-- llega por parámetro; lo demás es el caso objetivo.
create function pg_temp.s0270_case(
  p_n int,
  p_rider text,
  p_fecha text,
  p_courier text default 'por_definir',
  p_via text default 'mom_manual_route',
  p_prep text default 'listo_despacho',
  p_ready timestamptz default '2026-08-02 10:00-05',
  p_cancelled timestamptz default null,
  p_source text default 'manual',
  p_custody text default 'empresa',
  p_stage text default 'por_cerrar',
  p_substage text default 'salida_adicional_activa',
  -- Fuera de Lima: región, provincia y distrito con ese nombre.
  p_region text default 'Lima'
) returns uuid
language plpgsql as $$
declare
  v_store constant uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_order uuid := ('27000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_ship uuid := ('c27000' || lpad(p_n::text, 2, '0') || '-0000-4000-8000-000000000000')::uuid;
  v_name text := '#CS' || lpad(p_n::text, 2, '0');
begin
  insert into orders (id, store_id, shopify_order_id, name, created_at, cancelled_at)
  values (v_order, v_store, 's0270-' || p_n, v_name, '2026-07-30 10:00-05', p_cancelled);
  insert into order_master (order_id, store_id, shopify_order_id, order_name, order_created_at, order_total, general_status,
                            status_source, macro_version, region, province, district, macro_operation, macro_stage,
                            macro_substage, macro_since, recomputed_at)
  values (v_order, v_store, 's0270-' || p_n, v_name, '2026-07-30 10:00-05', 100, 'entregado',
          p_source, 'mom-v1.30', p_region, p_region, case when p_region = 'Lima' then 'Miraflores' else p_region end,
          'lima', p_stage, p_substage, '2026-08-03 12:00-05', now() - interval '1 minute');
  -- `updated_at` en el pasado: así se ve que lo que lo mueve es el relleno.
  insert into shipments (id, store_id, order_id, order_name, courier, guide_code, delivery_status, status_category, created_via,
                         custody_state, preparation_state, ready_at, created_at, updated_at)
  values (v_ship, v_store, v_order, v_name, p_courier, 'MOM-CS' || lpad(p_n::text, 2, '0') || '-S01-' || p_courier, 'pendiente', 'pending', p_via,
          p_custody, p_prep, p_ready, '2026-08-01 10:00-05', '2026-09-01 10:00-05');
  insert into order_events (store_id, order_id, kind, occurred_at, source, courier, new_status, new_operational, reason, payload)
  values (v_store, v_order, 'status_override',
          case when p_fecha ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (p_fecha || 'T17:00:00Z')::timestamptz else '2026-08-03T17:00:00Z' end,
          'liquidacion', p_rider, 'entregado', 'entregado',
          'Carga histórica del cuaderno (Alexis, ' || p_fecha || ')', jsonb_build_object('fecha', p_fecha, 'backfill', true));
  return v_order;
end $$;

-- ── Los casos ───────────────────────────────────────────────────────────────
do $$
begin
  perform pg_temp.s0270_case(1, 'alexis', '2026-08-03');                                    -- objetivo, Alexis
  perform pg_temp.s0270_case(2, 'propio', '2026-09-15');                                    -- objetivo, Reparto propio
  perform pg_temp.s0270_case(3, 'urpi', '2026-08-03');                                      -- cuaderno de Urpi
  perform pg_temp.s0270_case(4, 'alexis', '2026-08-03');                                    -- Urpi lo reportó
  perform pg_temp.s0270_case(5, 'alexis', '2026-08-03');                                    -- último override sin courier
  perform pg_temp.s0270_case(6, 'alexis', '');                                              -- sin fecha
  perform pg_temp.s0270_case(7, 'alexis', '2026-08-03');                                    -- contradicho por una fila posterior
  perform pg_temp.s0270_case(8, 'alexis', '2026-08-03');                                    -- otra salida entregada
  perform pg_temp.s0270_case(9, 'alexis', '2026-08-03', 'tanders', 'tanders');              -- la salida viva no es «por definir»
  perform pg_temp.s0270_case(10, 'alexis', '2026-08-03', p_ready => '2026-08-20 10:00-05'); -- caja lista después de la entrega
  perform pg_temp.s0270_case(11, 'alexis', '2026-08-03');                                   -- dos salidas vivas
  perform pg_temp.s0270_case(12, 'alexis', '2026-08-03', p_cancelled => '2026-09-01 10:00-05'); -- anulado en Shopify
  perform pg_temp.s0270_case(13, 'alexis', '2026-10-25');                                   -- posterior al relleno
  perform pg_temp.s0270_case(14, 'alexis', '2026-08-03', p_prep => 'rotulo_generado');      -- caja sin escanear
  perform pg_temp.s0270_case(15, 'alexis', '2026-08-03', p_source => 'aliclik');            -- el estado no lo puso una persona
  -- Pidieron su retorno (`return_request` pone custodia `retorno` sin tocar
  -- `custody_transferred_at` ni el estado): la caja no está en la empresa.
  perform pg_temp.s0270_case(16, 'alexis', '2026-08-03', p_custody => 'retorno');
  perform pg_temp.s0270_case(17, 'alexis', '2026-08-03', p_substage => 'pendiente_liquidacion'); -- otra subetapa
  perform pg_temp.s0270_case(18, 'alexis', '2026-08-03', p_stage => 'en_curso');                -- otra macroetapa
  perform pg_temp.s0270_case(19, 'alexis', '2026-08-03', p_region => 'Arequipa');               -- fuera de Lima
  -- Objetivo también: una caja anterior que ya no está viva no cuenta como
  -- segunda salida. Cada señal por separado: custodia devuelta (20), devuelta
  -- con fecha (21, como las guías de Aliclik que vuelven sin pasar por la oficina).
  perform pg_temp.s0270_case(20, 'alexis', '2026-08-03');
  perform pg_temp.s0270_case(21, 'alexis', '2026-08-03');
  -- Objetivo: sin `ready_at`, la caja lista se mide desde su creación (01-08).
  perform pg_temp.s0270_case(22, 'alexis', '2026-08-03', p_ready => null);
  -- El día del cuaderno, más de 30 días antes de la caja (01-08). Con `ready_at`
  -- anterior a la caja: así solo el tope de 30 días lo deja fuera.
  perform pg_temp.s0270_case(23, 'alexis', '2026-06-20', p_ready => '2026-06-01 10:00-05');
  -- La guía que le tocaría ya la tiene otra salida de «propio».
  perform pg_temp.s0270_case(24, 'alexis', '2026-08-03');
end $$;

-- 4: una fila del reporte de Urpi vinculada al pedido.
insert into urpi_report_imports (id, org_id) values ('22222222-0000-0000-0000-000000000270', '33333333-3333-3333-3333-333333333333');
insert into urpi_report_rows (org_id, urpi_row, report_date, result_code, data, digest, order_id, store_id,
                              link_status, link_method, first_import_id, last_import_id, updated_at) values
  ('33333333-3333-3333-3333-333333333333', 2704, '2026-08-03', 'entregado', '{}'::jsonb, repeat('b', 64),
   '27000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'vinculado', 'telefono',
   '22222222-0000-0000-0000-000000000270', '22222222-0000-0000-0000-000000000270', '2026-09-01 10:00-05');

-- 5: después del de Alexis, un override a mano sin courier. Manda el último.
insert into order_events (store_id, order_id, kind, occurred_at, source, courier, new_status, reason, payload) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27000000-0000-0000-0000-000000000005', 'status_override', '2026-08-05T17:00:00Z',
   'manual', null, 'entregado', 'Corrección a mano', '{"fecha": "2026-08-05"}');

-- 7 y 1: la hoja. La fila del 10/08 que da por devuelto a #CS07 es POSTERIOR al
-- día del cuaderno y lo contradice; la del 02/08 de #CS01 es ANTERIOR y no.
insert into sheet_domains (id, org_id, key, name, row_key) values
  ('d0270000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 's0270_cuaderno', 'Cuaderno 0270', 'punto');
insert into sheet_domain_statuses (domain_id, code, label, operational_status, effect) values
  ('d0270000-0000-0000-0000-000000000001', 'devuelto', 'Devuelto', 'devuelto', 'devolucion');
insert into sheets (id, org_id, domain_id, key, name, config) values
  ('50270000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'd0270000-0000-0000-0000-000000000001',
   's0270_alexis', 'Alexis 0270', '{"layout": "cuaderno", "courier": "alexis"}');
insert into sheet_rows (sheet_id, order_id, row_key, values) values
  ('50270000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000007', '2026-08-10#7', '{"fecha": "2026-08-10", "estado": "devuelto"}'),
  ('50270000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000001', '2026-08-02#1', '{"fecha": "2026-08-02", "estado": "devuelto"}');

-- 8: Tanders ya la entregó con otra guía.
insert into shipments (store_id, order_id, order_name, courier, guide_code, delivery_status, status_category, created_via, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27000000-0000-0000-0000-000000000008', '#CS08', 'tanders', 'TND-0270-8', 'entregado', 'delivered', 'tanders', '2026-09-01 10:00-05');

-- 11: una segunda caja «por definir» viva.
insert into shipments (store_id, order_id, order_name, courier, guide_code, delivery_status, status_category, created_via,
                       custody_state, preparation_state, created_at, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27000000-0000-0000-0000-000000000011', '#CS11', 'por_definir', 'MOM-CS11-S02', 'pendiente', 'pending',
   'mom_manual_route', 'empresa', 'listo_despacho', '2026-07-31 10:00-05', '2026-09-01 10:00-05');

-- 20 y 21: una caja anterior, todavía «pendiente», que ya volvió. 20: custodia
-- devuelta, sin `returned_at`; 21: una guía de Aliclik con `returned_at` y la
-- custodia en la empresa. Ninguna es salida viva: cada pedido tiene una sola.
insert into shipments (store_id, order_id, order_name, courier, guide_code, delivery_status, status_category, created_via,
                       custody_state, returned_at, preparation_state, created_at, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27000000-0000-0000-0000-000000000020', '#CS20', 'por_definir', 'MOM-CS20-OLD', 'pendiente', 'pending',
   'mom_manual_route', 'devuelto', null, 'listo_despacho', '2026-07-31 10:00-05', '2026-09-01 10:00-05'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27000000-0000-0000-0000-000000000021', '#CS21', 'aliclik', 'AL-0270-21', 'en_ruta', 'pending',
   'aliclik_api', 'empresa', '2026-07-31 18:00-05', 'listo_despacho', '2026-07-31 10:00-05', '2026-09-01 10:00-05');

-- 24: una salida anulada de «propio» con la guía que le tocaría a su S01.
insert into shipments (store_id, order_id, order_name, courier, guide_code, delivery_status, status_category, created_via,
                       created_at, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27000000-0000-0000-0000-000000000024', '#CS24', 'propio', 'MOM-CS24-PROPIO-C2700024', 'anulado',
   'closed', 'mom_manual_route', '2026-07-31 10:00-05', '2026-09-01 10:00-05');

-- Los que el relleno tiene que tocar, con su S01; todo lo demás queda intacto.
create temp table s0270_target on commit drop as
select ('27000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid as order_id,
       ('c27000' || lpad(n::text, 2, '0') || '-0000-4000-8000-000000000000')::uuid as shipment_id
  from unnest(array[1, 2, 20, 21, 22]) n;

-- Lo de la caja antes del relleno, para ver que no se tocó.
create temp table s0270_before on commit drop as
select id, order_id, courier, created_via, guide_code, delivery_status, output_number, output_code, qr_token, preparation_state,
       custody_state, ready_at, updated_at
  from shipments where order_id::text like '27000000-%';

do $$
begin
  if (select count(*) from order_master where order_id::text like '27000000-%' and coverage = 'lima') <> 23
     or (select coverage from order_master where order_id = '27000000-0000-0000-0000-000000000019') = 'lima' then
    raise exception 'los pedidos sembrados tienen que resolver a Lima, salvo #CS19';
  end if;
  if (select count(*) from order_master_stale('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') where order_id::text like '27000000-%') <> 0 then
    raise exception 'antes del relleno ningún pedido sembrado debería estar desfasado';
  end if;
end $$;

\echo '  primera pasada'
\ir ../../db/migrations/0270_cuaderno_s01_fill.sql

-- ── a) Entra el objetivo, con los valores del código ────────────────────────
do $$
declare
  v_bad text;
begin
  select string_agg(s.order_name, ', ') into v_bad
    from shipments s
    join s0270_before b on b.id = s.id
   where s.id in (select shipment_id from s0270_target)
     and not (
       s.courier = 'propio'
       and s.created_via = 'cuaderno_gf'
       and s.delivered_source = 'cuaderno_gf'
       and s.delivery_status = 'entregado'
       and s.status_category = 'delivered'
       and s.guide_code = 'MOM-' || substr(s.order_name, 2) || '-PROPIO-' || upper(left(s.id::text, 8))
       and s.dispatched_at = s.closed_at
       and s.closed_at = case s.order_name when '#CS02' then '2026-09-15T17:00:00Z'::timestamptz else '2026-08-03T17:00:00Z'::timestamptz end
       -- La caja es la misma: consecutivo, código, QR, preparación y custodia.
       and s.output_number = b.output_number and s.output_number = 1
       and s.output_code = b.output_code and s.output_code = substr(s.order_name, 2) || '-S01'
       and s.qr_token = b.qr_token
       and s.preparation_state = 'listo_despacho'
       and s.custody_state = 'empresa'
       and s.ready_at is not distinct from b.ready_at
       and s.updated_at > b.updated_at
     );
  if v_bad is not null then raise exception 'la salida rellenada no quedó como la escribe el código: %', v_bad; end if;
  select string_agg(om.order_name, ', ' order by om.order_name) into v_bad
    from s0270_target t
    join order_master om on om.order_id = t.order_id
   where not exists (select 1 from shipments s where s.id = t.shipment_id and s.courier = 'propio' and s.delivery_status = 'entregado');
  if v_bad is not null then raise exception 'los casos objetivo tenían que rellenarse, faltan: %', v_bad; end if;
  -- El mismo código de guía que `manualRouteGuideCode('#CS01', 'c2700001-…', 'propio')`.
  if not exists (select 1 from shipments where guide_code = 'MOM-CS01-PROPIO-C2700001') then
    raise exception 'la guía interna tiene que ser la de manualRouteGuideCode';
  end if;

  -- Un rastro por salida, con lo que el relleno sabía.
  if (select count(*) from order_events where kind = 'route_output_filled' and order_id::text like '27000000-%') <> 5 then
    raise exception 'tenía que haber un route_output_filled por salida rellenada';
  end if;
  if not exists (
    select 1 from order_events e
     where e.kind = 'route_output_filled'
       and e.order_id = '27000000-0000-0000-0000-000000000001'
       and e.shipment_id = 'c2700001-0000-4000-8000-000000000000'
       and e.source = 'manual' and e.courier = 'propio' and e.guide_code = 'MOM-CS01-PROPIO-C2700001'
       and e.payload = '{"outputCode": "CS01-S01", "previousCourier": "por_definir", "backfill": true, "rider": "alexis", "fecha": "2026-08-03"}'::jsonb
       and e.note like 'CS01-S01 tenía courier por definir; el cuaderno de Alexis la da por entregada el 03/08/2026%'
  ) then
    raise exception 'el evento de #CS01 no dice lo que tiene que decir';
  end if;
  if not exists (
    select 1 from order_events e
     where e.kind = 'route_output_filled' and e.order_id = '27000000-0000-0000-0000-000000000002'
       and e.payload->>'rider' = 'propio' and e.payload->>'fecha' = '2026-09-15'
  ) then
    raise exception 'el evento de #CS02 tenía que nombrar a Reparto propio y su fecha';
  end if;

  -- El barrido del Master los recalcula: quedaron desfasados, los otros no.
  select string_agg(om.order_name, ', ' order by om.order_name) into v_bad
    from order_master_stale('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') st
    join order_master om on om.order_id = st.order_id
   where st.order_id::text like '27000000-%';
  if v_bad is distinct from '#CS01, #CS02, #CS20, #CS21, #CS22' then
    raise exception 'solo los rellenados tenían que quedar desfasados, quedaron: %', v_bad;
  end if;
end $$;

-- ── b) Lo demás no se toca ──────────────────────────────────────────────────
do $$
declare
  v_bad text;
begin
  select string_agg(s.order_name || ' ' || coalesce(s.guide_code, ''), ', ' order by s.order_name) into v_bad
    from shipments s
    join s0270_before b on b.id = s.id
   where s.id not in (select shipment_id from s0270_target)
     and (s.courier, s.created_via, s.guide_code, s.delivery_status, s.updated_at)
         is distinct from (b.courier, b.created_via, b.guide_code, b.delivery_status, b.updated_at);
  if v_bad is not null then raise exception 'se tocaron salidas fuera del objetivo: %', v_bad; end if;
  if exists (select 1 from order_events where kind = 'route_output_filled'
              and order_id::text like '27000000-%'
              and order_id not in (select order_id from s0270_target)) then
    raise exception 'un pedido fuera del objetivo recibió el evento del relleno';
  end if;
end $$;

-- ── c) Otra vez: nada nuevo ─────────────────────────────────────────────────
create temp table s0270_after on commit drop as
select id, courier, guide_code, delivery_status, closed_at, updated_at from shipments where order_id::text like '27000000-%';

\echo '  segunda pasada'
\ir ../../db/migrations/0270_cuaderno_s01_fill.sql

do $$
begin
  if (select count(*) from order_events where kind = 'route_output_filled' and order_id::text like '27000000-%') <> 5 then
    raise exception 'correrla otra vez no puede duplicar el evento del relleno';
  end if;
  if exists (
    select 1 from shipments s join s0270_after a on a.id = s.id
     where (s.courier, s.guide_code, s.delivery_status, s.closed_at, s.updated_at)
           is distinct from (a.courier, a.guide_code, a.delivery_status, a.closed_at, a.updated_at)
  ) then
    raise exception 'correrla otra vez no puede cambiar ninguna salida';
  end if;
end $$;

\echo '  ✅ objetivo de Alexis y de Reparto propio rellenado como lo escribe el código (también con una caja anterior ya devuelta o sin ready_at), la caja intacta y el pedido desfasado; Urpi, sin courier, sin fecha, contradicho, otra entregada, otra viva, caja dudosa o sin escanear, anulado, posterior, estado no manual, retorno pedido, otra etapa o subetapa, fuera de Lima, más de 30 días antes y guía ya usada fuera; dos veces es una'
rollback;
