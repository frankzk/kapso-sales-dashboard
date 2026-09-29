-- Master liviano (migración 0203). Corre en el clúster desechable después de
-- todas las migraciones y reutiliza las tiendas y usuarios de rls_smoke.sql:
-- A (viewer de la tienda A), C (owner de las dos), D (viewer sin tiendas).
--
-- Lo que se fija es lo que decide si la pantalla se recarga y si el barrido
-- recalcula: qué escritura mueve `updated_at` y cuál no. Un fallo acá no
-- revienta nada visible, solo devuelve la cascada de recargas medida el
-- 29-09-2026 — por eso se prueba.

do $$
declare
  v_a      uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_b      uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  v_oa     uuid := '22222222-0000-0000-0000-00000000000a';
  v_ob     uuid := '22222222-0000-0000-0000-00000000000b';
  v_sello  uuid;
  v_olva   uuid;
  v_before timestamptz;
  v_after  timestamptz;
  v_n      int;
begin
  insert into orders (id, store_id, shopify_order_id, name, created_at) values
    (v_oa, v_a, 'liv-a', '#LIV1', now() - interval '1 day'),
    (v_ob, v_b, 'liv-b', '#LIV2', now() - interval '1 day');

  insert into order_master (order_id, store_id, shopify_order_id, order_name, customer_name,
                            customer_phone, guide_code, macro_version, recomputed_at, updated_at) values
    (v_oa, v_a, 'liv-a', '#LIV1', 'Zoila Buscada', '999111222', 'LIV-G1', 'mom-v1.8',
     now() - interval '1 hour', now() - interval '1 hour'),
    (v_ob, v_b, 'liv-b', '#LIV2', 'Zoila Buscada', '999111333', 'LIV-G2', 'mom-v1.8',
     now() - interval '1 hour', now() - interval '1 hour');

  insert into shipments (store_id, order_id, courier, guide_code, delivery_status, status_category, updated_at)
  values (v_a, v_oa, 'aliclik', 'LIV-G1', 'pendiente', 'in_transit', now() - interval '2 hours')
  returning id into v_sello;

  insert into shipments (store_id, order_id, courier, guide_code, delivery_status, status_category, updated_at)
  values (v_b, v_ob, 'olva', 'LIV-G2', 'pendiente', 'in_transit', now() - interval '2 hours')
  returning id into v_olva;

  -- 1. El sello de lectura de la API NO es un cambio de la guía: `updated_at`
  --    se queda, y el pedido no se da por desfasado. Es la cascada entera.
  select updated_at into v_before from shipments where id = v_sello;
  update shipments set api_report_at = now(), api_updated_at = now() where id = v_sello;
  select updated_at into v_after from shipments where id = v_sello;
  if v_after <> v_before then raise exception '1: un sello de lectura movió shipments.updated_at'; end if;
  select count(*) into v_n from order_master_stale(v_a) where order_id = v_oa;
  if v_n <> 0 then raise exception '1: un sello de lectura dejó el pedido desfasado'; end if;

  -- 2. Escribir lo mismo que ya había tampoco es un cambio.
  update shipments set delivery_status = 'pendiente' where id = v_sello;
  select updated_at into v_after from shipments where id = v_sello;
  if v_after <> v_before then raise exception '2: reescribir el mismo valor movió updated_at'; end if;

  -- 3. Un cambio de verdad sí lo mueve, y el pedido sale desfasado (MOM §19.1),
  --    aunque venga junto con el sello.
  update shipments set reported_status = 'EN RUTA', api_report_at = now() where id = v_sello;
  select updated_at into v_after from shipments where id = v_sello;
  if not (v_after > v_before) then raise exception '3: un cambio real no movió shipments.updated_at'; end if;
  select count(*) into v_n from order_master_stale(v_a) where order_id = v_oa;
  if v_n <> 1 then raise exception '3: un cambio real de la guía no dejó el pedido desfasado'; end if;

  -- 4. `last_report_at` SÍ mueve `updated_at`: los barridos de Olva y Shalom
  --    rotan por esa columna y se quedarían releyendo siempre las mismas guías.
  select updated_at into v_before from shipments where id = v_olva;
  update shipments set last_report_at = now() where id = v_olva;
  select updated_at into v_after from shipments where id = v_olva;
  if not (v_after > v_before) then raise exception '4: last_report_at dejó de mover updated_at'; end if;

  -- 5. Master: un recálculo que no cambia nada deja `updated_at` quieto. Es lo
  --    que lee el sondeo de la pantalla.
  select updated_at into v_before from order_master where order_id = v_oa;
  update order_master set recomputed_at = now() where order_id = v_oa;
  select updated_at into v_after from order_master where order_id = v_oa;
  if v_after <> v_before then raise exception '5: un recálculo sin cambios movió order_master.updated_at'; end if;

  -- 6. Por el mismo camino que usa el recálculo: upsert con los mismos datos.
  select updated_at into v_before from order_master where order_id = v_ob;
  insert into order_master (order_id, store_id, shopify_order_id, order_name, customer_name,
                            customer_phone, guide_code, macro_version, recomputed_at)
  values (v_ob, v_b, 'liv-b', '#LIV2', 'Zoila Buscada', '999111333', 'LIV-G2', 'mom-v1.8', now())
  on conflict (order_id) do update set
    customer_name = excluded.customer_name,
    customer_phone = excluded.customer_phone,
    recomputed_at = excluded.recomputed_at;
  select updated_at into v_after from order_master where order_id = v_ob;
  if v_after <> v_before then raise exception '6: un upsert sin cambios movió order_master.updated_at'; end if;

  -- 7. Un cambio de verdad en el Master sí lo mueve.
  select updated_at into v_before from order_master where order_id = v_oa;
  update order_master set comment_count = comment_count + 1 where order_id = v_oa;
  select updated_at into v_after from order_master where order_id = v_oa;
  if not (v_after > v_before) then raise exception '7: un cambio real no movió order_master.updated_at'; end if;

  raise notice 'master liviano: 7 comprobaciones de escritura OK';
end $$;

-- 8–11. La búsqueda nunca devuelve más de lo que la RLS dejaría leer.
\echo '  búsqueda: viewer A solo ve la tienda A'
set request.test_uid = '00000000-0000-0000-0000-00000000000a';
set role authenticated;
do $$ begin
  if (select count(*) from order_master_search(
        array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[],
        'zoila busc')) <> 1 then
    raise exception '8: viewer A debería ver 1 resultado (solo su tienda)';
  end if;
  if (select count(*) from order_master_search(array['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], 'zoila')) <> 0 then
    raise exception '8: pedir una tienda ajena no puede devolver nada';
  end if;
  -- Por cada una de las cuatro columnas.
  if (select count(*) from order_master_search(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], 'LIV1')) <> 1 then
    raise exception '8: no encontró por código de pedido';
  end if;
  if (select count(*) from order_master_search(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], 'liv-g1')) <> 1 then
    raise exception '8: no encontró por guía';
  end if;
  if (select count(*) from order_master_search(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '111222')) <> 1 then
    raise exception '8: no encontró por teléfono';
  end if;
end $$;
reset role;

\echo '  búsqueda: owner C ve las dos tiendas; viewer D sin tiendas, nada'
set request.test_uid = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
do $$ begin
  if (select count(*) from order_master_search(
        array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[],
        'zoila')) <> 2 then
    raise exception '9: el owner debería ver los 2 pedidos';
  end if;
  -- 10. El término es literal: `%` y `_` no son comodines.
  if (select count(*) from order_master_search(
        array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[],
        'Zoila%Buscada')) <> 0 then
    raise exception '10: un %% del término se usó como comodín';
  end if;
  if (select count(*) from order_master_search(
        array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[],
        'LIV_G')) <> 0 then
    raise exception '10: un _ del término se usó como comodín';
  end if;
  -- 11. Sin término no devuelve la tabla entera.
  if (select count(*) from order_master_search(
        array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[],
        '   ')) <> 0 then
    raise exception '11: un término vacío devolvió filas';
  end if;
end $$;
reset role;

set request.test_uid = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
do $$ begin
  if (select count(*) from order_master_search(
        array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[],
        'zoila')) <> 0 then
    raise exception '9: un viewer sin tiendas no puede ver nada';
  end if;
end $$;
reset role;

do $$ begin
  delete from shipments    where guide_code in ('LIV-G1', 'LIV-G2');
  delete from order_master where order_id in ('22222222-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b');
  delete from orders       where id in ('22222222-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-00000000000b');
end $$;
