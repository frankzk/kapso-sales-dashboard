\set ON_ERROR_STOP on
-- 0271: la salida de Urpi rellenada lleva el día de la entrega, y las cajas «por
-- definir» de entregas viejas de Urpi pasan a su salida entregada (MOM §30.11,
-- §4; 23-10-2026). Corre en el clúster desechable de verify-db, después de todas
-- las migraciones, dentro de una transacción que se deshace. Reutiliza la tienda
-- A de rls_smoke.sql (org 3333…).
--
-- Lo que se fija aquí es qué salida se toca y qué se le escribe, porque es un
-- relleno de datos sobre producción:
--   a) (1) a una salida `urpi_report` entregada sin `closed_at` se le pone el
--      día de la fila MÁS RECIENTE de Urpi del pedido a las 17:00Z, sin evento y
--      sin tocar `dispatched_at`; la más reciente es la de mayor `urpi_row`,
--      como en el código, aunque otra anterior tenga una fecha posterior (#CU06,
--      y #CU14 en (2)); quedan fuera la que tiene después un intento
--      cancelado, la «Entregado» sin fecha, la que ya tiene `closed_at` y la
--      salida de Urpi que no salió del reporte;
--   b) (2) entra la caja objetivo, con los mismos valores que escribe
--      `urpiSalidaRow` (lib/urpi-salida.ts) —el primer intento en
--      `dispatched_at` y el de la entrega en `closed_at`— y su evento
--      `route_output_filled`; lo de la caja (consecutivo, código, QR,
--      preparación, custodia) no se toca, y el pedido queda desfasado para el
--      barrido del Master. También entra con otra salida que ya no está viva
--      (custodia devuelta, anulada, `returned_at`);
--   c) quedan fuera, como en `planUrpiSalida`: el último intento que no es
--      «Entregado», el pedido que Kapta no tiene entregado o que Shopify anuló,
--      el que ya tiene una salida de Urpi entregada, dos salidas vivas, la
--      salida viva de otro courier, la caja transferida, en retorno, que no es
--      de ruta manual o que ya salió (en ruta), el pedido sin filas de Urpi, la
--      «Entregado» sin fecha, la guía que ya tiene otra salida de Urpi, el
--      courier escrito distinto (el UPDATE de `writeCourierGuide` tampoco lo
--      toma) y el pedido sin salida (no se crea una);
--   d) correrla otra vez no duplica eventos ni cambia nada.
begin;

-- Un pedido de la tienda A con su S01 y lo que cada caso cambia por parámetro.
-- Por defecto, el objetivo de (2): entregado en Kapta y su S01 «por definir».
create function pg_temp.s0271_case(
  p_n int,
  p_status text default 'entregado',
  p_cancelled timestamptz default null,
  p_courier text default 'por_definir',
  p_via text default 'mom_manual_route',
  p_delivery text default 'pendiente',
  p_custody text default 'empresa',
  p_transferred timestamptz default null,
  p_dispatched timestamptz default null,
  p_closed timestamptz default null,
  p_with_ship boolean default true
) returns uuid
language plpgsql as $$
declare
  v_store constant uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_order uuid := ('27100000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_ship uuid := ('c27100' || lpad(p_n::text, 2, '0') || '-0000-4000-8000-000000000000')::uuid;
  v_name text := '#CU' || lpad(p_n::text, 2, '0');
begin
  insert into orders (id, store_id, shopify_order_id, name, created_at, cancelled_at)
  values (v_order, v_store, 's0271-' || p_n, v_name, '2026-07-30 10:00-05', p_cancelled);
  insert into order_master (order_id, store_id, shopify_order_id, order_name, order_created_at, order_total, general_status,
                            status_source, macro_version, region, province, district, macro_operation, macro_stage,
                            macro_substage, macro_since, recomputed_at)
  values (v_order, v_store, 's0271-' || p_n, v_name, '2026-07-30 10:00-05', 100, p_status,
          'manual', 'mom-v1.31', 'Lima', 'Lima', 'Miraflores', 'lima', 'por_cerrar',
          'salida_adicional_activa', '2026-08-03 12:00-05', now() - interval '1 minute');
  if p_with_ship then
    -- `updated_at` en el pasado: así se ve que lo que lo mueve es el relleno.
    insert into shipments (id, store_id, order_id, order_name, courier, guide_code, delivery_status, status_category, created_via,
                           delivered_source, custody_state, custody_transferred_at, preparation_state, ready_at, dispatched_at,
                           closed_at, created_at, updated_at)
    values (v_ship, v_store, v_order, v_name, p_courier,
            case when p_via = 'urpi_report' then 'MOM-CU' || lpad(p_n::text, 2, '0') || '-URPI-' || upper(left(v_ship::text, 8))
                 else 'MOM-CU' || lpad(p_n::text, 2, '0') || '-S01-' || p_courier end,
            p_delivery, case p_delivery when 'entregado' then 'delivered' else 'pending' end, p_via,
            case when p_via = 'urpi_report' then 'urpi_report' end,
            p_custody, p_transferred, 'listo_despacho', '2026-08-02 10:00-05', p_dispatched, p_closed,
            '2026-08-01 10:00-05', '2026-09-01 10:00-05');
  end if;
  return v_order;
end $$;

-- Una fila del reporte de Urpi vinculada al pedido `p_n`.
insert into urpi_report_imports (id, org_id) values ('22222222-0000-0000-0000-000000000271', '33333333-3333-3333-3333-333333333333');
create function pg_temp.s0271_row(p_n int, p_row int, p_result text, p_date date) returns void
language sql as $$
  insert into urpi_report_rows (org_id, urpi_row, report_date, result_code, data, digest, order_id, store_id,
                                link_status, link_method, first_import_id, last_import_id, updated_at)
  values ('33333333-3333-3333-3333-333333333333', p_row, p_date, p_result, '{}'::jsonb, repeat('c', 64),
          ('27100000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'vinculado', 'telefono', '22222222-0000-0000-0000-000000000271', '22222222-0000-0000-0000-000000000271',
          '2026-09-01 10:00-05');
$$;

-- ── Los casos ───────────────────────────────────────────────────────────────
do $$
begin
  -- (1) Salidas de Urpi ya rellenadas por el código, sin `closed_at`.
  perform pg_temp.s0271_case(1, p_courier => 'urpi', p_via => 'urpi_report', p_delivery => 'entregado',
                             p_dispatched => '2026-09-20T17:00:00Z');                           -- objetivo
  perform pg_temp.s0271_row(1, 27101, 'reprogramado', '2026-09-20');
  perform pg_temp.s0271_row(1, 27102, 'entregado', '2026-09-22');
  perform pg_temp.s0271_case(2, p_courier => 'urpi', p_via => 'urpi_report', p_delivery => 'entregado');   -- después, un cancelado
  perform pg_temp.s0271_row(2, 27201, 'entregado', '2026-09-10');
  perform pg_temp.s0271_row(2, 27202, 'cancelado', '2026-09-12');
  perform pg_temp.s0271_case(3, p_courier => 'urpi', p_via => 'urpi_report', p_delivery => 'entregado');   -- «Entregado» sin fecha
  perform pg_temp.s0271_row(3, 27301, 'entregado', null);
  perform pg_temp.s0271_case(4, p_courier => 'urpi', p_via => 'urpi_report', p_delivery => 'entregado',
                             p_closed => '2026-09-05T17:00:00Z');                               -- ya tiene closed_at
  perform pg_temp.s0271_row(4, 27401, 'entregado', '2026-09-06');
  perform pg_temp.s0271_case(5, p_courier => 'urpi', p_via => 'mom_manual_route', p_delivery => 'entregado'); -- no salió del reporte
  perform pg_temp.s0271_row(5, 27501, 'entregado', '2026-09-07');
  perform pg_temp.s0271_case(6, p_courier => 'urpi', p_via => 'urpi_report', p_delivery => 'entregado'); -- objetivo: la fila de mayor número tiene la fecha anterior
  perform pg_temp.s0271_row(6, 27601, 'reprogramado', '2026-09-25');
  perform pg_temp.s0271_row(6, 27602, 'entregado', '2026-09-15');

  -- (2) Cajas «por definir» de entregas de Urpi.
  perform pg_temp.s0271_case(10);                                                               -- objetivo
  perform pg_temp.s0271_row(10, 27110, 'reprogramado', '2026-08-10');
  perform pg_temp.s0271_row(10, 27111, 'entregado', '2026-08-12');
  perform pg_temp.s0271_case(11);                                                               -- objetivo, con otra caja ya devuelta
  perform pg_temp.s0271_row(11, 27121, 'entregado', '2026-08-15');
  perform pg_temp.s0271_case(12);                                                               -- objetivo, con otra salida anulada
  perform pg_temp.s0271_row(12, 27131, 'entregado', '2026-08-22');
  perform pg_temp.s0271_case(13);                                                               -- objetivo, con otra guía ya devuelta
  perform pg_temp.s0271_row(13, 27141, 'entregado', '2026-08-16');
  perform pg_temp.s0271_case(14);                                                               -- objetivo: la fila de mayor número tiene la fecha anterior
  perform pg_temp.s0271_row(14, 28400, 'reprogramado', '2026-08-20');
  perform pg_temp.s0271_row(14, 28401, 'entregado', '2026-08-12');
  perform pg_temp.s0271_case(20);                                                               -- el último intento es un cancelado
  perform pg_temp.s0271_row(20, 28201, 'entregado', '2026-08-10');
  perform pg_temp.s0271_row(20, 28202, 'cancelado', '2026-08-11');
  perform pg_temp.s0271_case(21, p_status => 'en_proceso');                                     -- Kapta no lo tiene entregado
  perform pg_temp.s0271_row(21, 28211, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(22, p_cancelled => '2026-08-20 10:00-05');                         -- anulado en Shopify
  perform pg_temp.s0271_row(22, 28221, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(23);                                                               -- ya tiene salida de Urpi entregada
  perform pg_temp.s0271_row(23, 28231, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(24);                                                               -- dos salidas vivas
  perform pg_temp.s0271_row(24, 28241, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(25, p_courier => 'tanders', p_via => 'tanders', p_delivery => 'en_ruta'); -- la viva es de otro courier
  perform pg_temp.s0271_row(25, 28251, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(26, p_transferred => '2026-08-09 10:00-05');                      -- la caja ya cambió de custodia
  perform pg_temp.s0271_row(26, 28261, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(27, p_custody => 'retorno');                                       -- pidieron su retorno
  perform pg_temp.s0271_row(27, 28271, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(28, p_via => 'manual_legacy');                                     -- no es de ruta manual
  perform pg_temp.s0271_row(28, 28281, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(29);                                                               -- Urpi no lo reportó
  perform pg_temp.s0271_case(30);                                                               -- «Entregado» sin fecha (el intento anterior sí la tiene)
  perform pg_temp.s0271_row(30, 28300, 'reprogramado', '2026-08-09');
  perform pg_temp.s0271_row(30, 28301, 'entregado', null);
  perform pg_temp.s0271_case(31);                                                               -- la guía ya la tiene otra salida de Urpi
  perform pg_temp.s0271_row(31, 28311, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(32, p_delivery => 'en_ruta');                                      -- la caja ya salió
  perform pg_temp.s0271_row(32, 28321, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(33, p_with_ship => false);                                         -- sin salida: no se crea una
  perform pg_temp.s0271_row(33, 28331, 'entregado', '2026-08-10');
  perform pg_temp.s0271_case(34, p_courier => 'Por_Definir ');                                  -- courier escrito distinto
  perform pg_temp.s0271_row(34, 28341, 'entregado', '2026-08-10');
end $$;

-- 11: una caja anterior «por definir», todavía pendiente, con la custodia devuelta.
-- 12: una guía de Tanders anulada. 13: una guía de Aliclik en ruta con
-- `returned_at` y la custodia en la empresa. Ninguna es salida viva.
insert into shipments (store_id, order_id, order_name, courier, guide_code, delivery_status, status_category, created_via,
                       custody_state, returned_at, preparation_state, created_at, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27100000-0000-0000-0000-000000000011', '#CU11', 'por_definir', 'MOM-CU11-OLD', 'pendiente', 'pending',
   'mom_manual_route', 'devuelto', null, 'listo_despacho', '2026-07-31 10:00-05', '2026-09-01 10:00-05'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27100000-0000-0000-0000-000000000012', '#CU12', 'tanders', 'TND-0271-12', 'anulado', 'closed',
   'tanders', 'empresa', null, 'listo_despacho', '2026-07-31 10:00-05', '2026-09-01 10:00-05'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27100000-0000-0000-0000-000000000013', '#CU13', 'aliclik', 'AL-0271-13', 'en_ruta', 'pending',
   'aliclik_api', 'empresa', '2026-07-31 18:00-05', 'listo_despacho', '2026-07-31 10:00-05', '2026-09-01 10:00-05');
-- 23: Urpi ya tiene su salida entregada (de su ruta), y sobra una «por definir».
-- 24: una segunda caja «por definir» viva.
-- 31: una salida de Urpi anulada con la guía que le tocaría a su S01.
insert into shipments (store_id, order_id, order_name, courier, guide_code, delivery_status, status_category, created_via,
                       custody_state, preparation_state, created_at, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27100000-0000-0000-0000-000000000023', '#CU23', 'urpi', 'MOM-CU23-URPI-RUTA', 'entregado', 'delivered',
   'mom_manual_route', 'empresa', 'listo_despacho', '2026-07-31 10:00-05', '2026-09-01 10:00-05'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27100000-0000-0000-0000-000000000024', '#CU24', 'por_definir', 'MOM-CU24-S02', 'pendiente', 'pending',
   'mom_manual_route', 'empresa', 'listo_despacho', '2026-07-31 10:00-05', '2026-09-01 10:00-05'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '27100000-0000-0000-0000-000000000031', '#CU31', 'urpi', 'MOM-CU31-URPI-C2710031', 'anulado', 'closed',
   'mom_manual_route', 'empresa', 'listo_despacho', '2026-07-31 10:00-05', '2026-09-01 10:00-05');

-- Los que el relleno (2) tiene que tocar, con su S01; y el que (1) completa.
create temp table s0271_target on commit drop as
select ('27100000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid as order_id,
       ('c27100' || lpad(n::text, 2, '0') || '-0000-4000-8000-000000000000')::uuid as shipment_id
  from unnest(array[10, 11, 12, 13, 14]) n;

-- Cómo estaba todo antes, para ver qué se tocó.
create temp table s0271_before on commit drop as
select id, order_id, order_name, courier, created_via, guide_code, delivery_status, delivered_source, output_number, output_code,
       qr_token, preparation_state, custody_state, ready_at, dispatched_at, closed_at, updated_at
  from shipments where order_id::text like '27100000-%';

do $$
begin
  if (select count(*) from order_master_stale('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') where order_id::text like '27100000-%') <> 0 then
    raise exception 'antes del relleno ningún pedido sembrado debería estar desfasado';
  end if;
end $$;

\echo '  primera pasada'
\ir ../../db/migrations/0271_urpi_salida_fecha.sql

-- ── a) (1) El día de la entrega en la salida ya rellenada ───────────────────
do $$
declare
  v_bad text;
begin
  if not exists (
    select 1 from shipments s join s0271_before b on b.id = s.id
     where s.order_name = '#CU01'
       and s.closed_at = '2026-09-22T17:00:00Z'::timestamptz          -- la fila más reciente, no la primera
       and s.dispatched_at = '2026-09-20T17:00:00Z'::timestamptz      -- el primer intento no cambia
       and (s.courier, s.created_via, s.guide_code, s.delivery_status, s.delivered_source)
           is not distinct from (b.courier, b.created_via, b.guide_code, b.delivery_status, b.delivered_source)
       and s.updated_at > b.updated_at
  ) then
    raise exception '#CU01 tenía que quedar cerrada el 22/09 a las 17:00Z, con lo demás igual';
  end if;
  -- La fila más reciente es la de mayor `urpi_row`, no la de fecha más tardía.
  if not exists (
    select 1 from shipments s join s0271_before b on b.id = s.id
     where s.order_name = '#CU06'
       and s.closed_at = '2026-09-15T17:00:00Z'::timestamptz
       and s.dispatched_at is null
       and s.updated_at > b.updated_at
  ) then
    raise exception '#CU06 tenía que quedar cerrada el 15/09 (la fila 27602), no el 25/09';
  end if;
  select string_agg(s.order_name, ', ' order by s.order_name) into v_bad
    from shipments s join s0271_before b on b.id = s.id
   where s.order_name in ('#CU02', '#CU03', '#CU04', '#CU05')
     and (s.closed_at, s.dispatched_at, s.updated_at) is distinct from (b.closed_at, b.dispatched_at, b.updated_at);
  if v_bad is not null then raise exception '(1) tocó salidas que no debía: %', v_bad; end if;
  -- Sin evento: el relleno ya dejó el suyo.
  if exists (select 1 from order_events where order_id::text like '27100000-0000-0000-0000-00000000000%') then
    raise exception '(1) no escribe eventos';
  end if;
end $$;

-- ── b) (2) Entra el objetivo, con los valores del código ────────────────────
do $$
declare
  v_bad text;
begin
  select string_agg(s.order_name, ', ' order by s.order_name) into v_bad
    from shipments s
    join s0271_before b on b.id = s.id
   where s.id in (select shipment_id from s0271_target)
     and not (
       s.courier = 'urpi'
       and s.created_via = 'urpi_report'
       and s.delivered_source = 'urpi_report'
       and s.delivery_status = 'entregado'
       and s.status_category = 'delivered'
       and s.guide_code = 'MOM-' || substr(s.order_name, 2) || '-URPI-' || upper(left(s.id::text, 8))
       and s.dispatched_at = case s.order_name when '#CU10' then '2026-08-10T17:00:00Z'::timestamptz
                                               when '#CU11' then '2026-08-15T17:00:00Z'::timestamptz
                                               when '#CU12' then '2026-08-22T17:00:00Z'::timestamptz
                                               when '#CU14' then '2026-08-12T17:00:00Z'::timestamptz
                                               else '2026-08-16T17:00:00Z'::timestamptz end
       -- #CU14: la fila 28401 (12/08), la de mayor número, aunque la 28400 sea del 20/08.
       and s.closed_at = case s.order_name when '#CU10' then '2026-08-12T17:00:00Z'::timestamptz
                                           when '#CU11' then '2026-08-15T17:00:00Z'::timestamptz
                                           when '#CU12' then '2026-08-22T17:00:00Z'::timestamptz
                                           when '#CU14' then '2026-08-12T17:00:00Z'::timestamptz
                                           else '2026-08-16T17:00:00Z'::timestamptz end
       -- La caja es la misma: consecutivo, código, QR, preparación y custodia.
       and s.output_number = b.output_number
       and s.output_code is not distinct from b.output_code
       and s.qr_token = b.qr_token
       and s.preparation_state = 'listo_despacho'
       and s.custody_state = 'empresa'
       and s.ready_at is not distinct from b.ready_at
       and s.updated_at > b.updated_at
     );
  if v_bad is not null then raise exception 'la salida rellenada no quedó como la escribe el código: %', v_bad; end if;
  select string_agg(t.order_id::text, ', ') into v_bad
    from s0271_target t
   where not exists (select 1 from shipments s where s.id = t.shipment_id and s.courier = 'urpi' and s.delivery_status = 'entregado');
  if v_bad is not null then raise exception 'los casos objetivo tenían que rellenarse, faltan: %', v_bad; end if;
  -- El mismo código de guía que `manualRouteGuideCode('#CU10', 'c2710010-…', 'urpi')`.
  if not exists (select 1 from shipments where guide_code = 'MOM-CU10-URPI-C2710010') then
    raise exception 'la guía interna tiene que ser la de manualRouteGuideCode';
  end if;

  -- Un rastro por salida, con lo que el relleno sabía.
  if (select count(*) from order_events where kind = 'route_output_filled' and order_id::text like '27100000-%') <> 5 then
    raise exception 'tenía que haber un route_output_filled por salida rellenada';
  end if;
  if not exists (
    select 1 from order_events e
      join shipments s on s.id = e.shipment_id
     where e.kind = 'route_output_filled'
       and e.order_id = '27100000-0000-0000-0000-000000000010'
       and e.shipment_id = 'c2710010-0000-4000-8000-000000000000'
       and e.source = 'manual' and e.courier = 'urpi' and e.guide_code = 'MOM-CU10-URPI-C2710010'
       and e.payload = jsonb_build_object('outputCode', s.output_code, 'previousCourier', 'por_definir', 'backfill', true,
                                          'urpi_row', 27111, 'fecha', '2026-08-12')
       and e.note = s.output_code || ' tenía courier por definir; el reporte de Urpi la da por entregada el 12/08/2026 (fila 27111): pasó a salida de Urpi entregada (relleno 0271).'
  ) then
    raise exception 'el evento de #CU10 no dice lo que tiene que decir';
  end if;

  -- El barrido del Master los recalcula: quedaron desfasados, los otros no.
  select string_agg(om.order_name, ', ' order by om.order_name) into v_bad
    from order_master_stale('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') st
    join order_master om on om.order_id = st.order_id
   where st.order_id::text like '27100000-%';
  if v_bad is distinct from '#CU01, #CU06, #CU10, #CU11, #CU12, #CU13, #CU14' then
    raise exception 'solo los completados y los rellenados tenían que quedar desfasados, quedaron: %', v_bad;
  end if;
end $$;

-- ── c) Lo demás no se toca ──────────────────────────────────────────────────
do $$
declare
  v_bad text;
begin
  select string_agg(s.order_name || ' ' || coalesce(s.guide_code, ''), ', ' order by s.order_name) into v_bad
    from shipments s
    join s0271_before b on b.id = s.id
   where s.id not in (select shipment_id from s0271_target)
     and s.order_name not in ('#CU01', '#CU06')
     and (s.courier, s.created_via, s.guide_code, s.delivery_status, s.dispatched_at, s.closed_at, s.updated_at)
         is distinct from (b.courier, b.created_via, b.guide_code, b.delivery_status, b.dispatched_at, b.closed_at, b.updated_at);
  if v_bad is not null then raise exception 'se tocaron salidas fuera del objetivo: %', v_bad; end if;
  if exists (select 1 from order_events where order_id::text like '27100000-%'
              and order_id not in (select order_id from s0271_target)) then
    raise exception 'un pedido fuera del objetivo recibió un evento';
  end if;
  if exists (select 1 from shipments where order_id = '27100000-0000-0000-0000-000000000033') then
    raise exception 'sin salida no se crea una';
  end if;
end $$;

-- ── d) Otra vez: nada nuevo ─────────────────────────────────────────────────
create temp table s0271_after on commit drop as
select id, courier, guide_code, delivery_status, dispatched_at, closed_at, updated_at from shipments where order_id::text like '27100000-%';

\echo '  segunda pasada'
\ir ../../db/migrations/0271_urpi_salida_fecha.sql

do $$
begin
  if (select count(*) from order_events where kind = 'route_output_filled' and order_id::text like '27100000-%') <> 5 then
    raise exception 'correrla otra vez no puede duplicar el evento del relleno';
  end if;
  if exists (
    select 1 from shipments s join s0271_after a on a.id = s.id
     where (s.courier, s.guide_code, s.delivery_status, s.dispatched_at, s.closed_at, s.updated_at)
           is distinct from (a.courier, a.guide_code, a.delivery_status, a.dispatched_at, a.closed_at, a.updated_at)
  ) then
    raise exception 'correrla otra vez no puede cambiar ninguna salida';
  end if;
end $$;

\echo '  ✅ (1) la salida de Urpi rellenada toma el día de su fila más reciente «Entregado» (la de mayor número, aunque otra tenga fecha posterior), sin evento; cancelado después, sin fecha, ya cerrada o no del reporte fuera. (2) la caja «por definir» pasa a Urpi entregada como la escribe el código (primer intento y entrega, de la fila de mayor número), también con otra salida que ya no está viva, la caja intacta y el pedido desfasado; último intento no entregado, no entregado en Kapta, anulado, ya de Urpi, dos vivas, otro courier, transferida, en retorno, no de ruta manual, en ruta, sin Urpi, sin fecha, guía usada, courier escrito distinto y sin salida fuera; dos veces es una'
rollback;
