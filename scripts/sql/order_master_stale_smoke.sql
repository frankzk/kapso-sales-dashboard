-- Detección del desfase del Master (migración 0122). Se ejecuta sobre el clúster
-- desechable, después de aplicar todas las migraciones, y reutiliza la
-- org/tienda del fixture de rls_smoke.sql (org 3333…, store aaaa…).
--
-- POR QUÉ ESTA PRUEBA, Y POR QUÉ ESTÁ ACÁ Y NO EN VITEST. La regla vivía en
-- TypeScript (`staleByShipment`) alimentada por una VENTANA de las 2.000 guías
-- tocadas más recientemente, porque PostgREST no sabe comparar dos columnas de
-- tablas distintas. Esa ventana tenía fondo: un pedido que caía por debajo no
-- podía volver a entrar nunca. Medido en producción el 18-08-2026, tienda Kenku:
-- 487 desfasados, 381 de ellos bajo la línea, invisibles de forma permanente
-- mientras el barrido recalculaba 620 pedidos por hora.
--
-- Al mudar la comparación a la base desaparece el techo, y la definición de
-- «desfasado» pasa a existir en un solo sitio. La prueba se muda con ella: dejar
-- la de TypeScript habría sido conservar la segunda definición que este cambio
-- viene a eliminar.
--
-- Lo que se fija acá es lo que decide si un pedido se ve o no se ve. El caso 4
-- es el que reproduce el incidente.

\set store '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''

do $$
declare
  v_store uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_al    uuid := '11111111-0000-0000-0000-000000000001'; -- al día
  v_stale uuid := '11111111-0000-0000-0000-000000000002'; -- guía posterior
  v_sin   uuid := '11111111-0000-0000-0000-000000000003'; -- sin guías
  v_viejo uuid := '11111111-0000-0000-0000-000000000004'; -- desfasado y ANTIGUO
  v_n     int;
  v_first uuid;
begin
  delete from order_master where store_id = v_store;
  delete from shipments    where store_id = v_store;
  delete from orders       where store_id = v_store;

  insert into orders (id, store_id, shopify_order_id, name, created_at) values
    (v_al,    v_store, 'g-1', '#T1', now() - interval '1 day'),
    (v_stale, v_store, 'g-2', '#T2', now() - interval '1 day'),
    (v_sin,   v_store, 'g-3', '#T3', now() - interval '1 day'),
    (v_viejo, v_store, 'g-4', '#T4', now() - interval '90 days');

  -- Las filas del Master, con su último recálculo.
  insert into order_master (order_id, store_id, shopify_order_id, order_name, macro_version, recomputed_at) values
    (v_al,    v_store, 'g-1', '#T1', 'mom-v1.8', now() - interval '1 hour'),
    (v_stale, v_store, 'g-2', '#T2', 'mom-v1.8', now() - interval '1 hour'),
    (v_sin,   v_store, 'g-3', '#T3', 'mom-v1.8', now() - interval '1 hour'),
    (v_viejo, v_store, 'g-4', '#T4', 'mom-v1.8', now() - interval '89 days');

  -- Las guías. `updated_at` es lo que decide.
  insert into shipments (store_id, order_id, courier, guide_code, delivery_status, status_category, updated_at) values
    (v_store, v_al,    'aliclik', 'G-1', 'pendiente', 'abierto', now() - interval '2 hours'),
    (v_store, v_stale, 'aliclik', 'G-2', 'pendiente', 'abierto', now() - interval '10 minutes'),
    (v_store, v_viejo, 'aliclik', 'G-4', 'pendiente', 'abierto', now() - interval '80 days');
  -- 1. Un pedido cuya guía se escribió ANTES del recálculo no está desfasado.
  select count(*) into v_n from order_master_stale(v_store) where order_id = v_al;
  if v_n <> 0 then raise exception 'una guía anterior al recálculo no debería contar'; end if;

  -- 2. Un pedido cuya guía se escribió DESPUÉS sí lo está. Es la regla entera.
  select count(*) into v_n from order_master_stale(v_store) where order_id = v_stale;
  if v_n <> 1 then raise exception 'una guía posterior al recálculo debería contar'; end if;

  -- 3. Un pedido sin guías nunca está desfasado por esta puerta: no hay nada que
  --    lo mueva. Lo cubren las otras del barrido.
  select count(*) into v_n from order_master_stale(v_store) where order_id = v_sin;
  if v_n <> 0 then raise exception 'un pedido sin guías no debería contar'; end if;

  -- 4. EL CASO QUE COSTÓ 381 PEDIDOS. Un pedido de hace tres meses, con su guía
  --    movida hace ochenta días, tiene que salir igual que el de hace diez
  --    minutos. La versión anterior lo perdía en cuanto caía fuera de las 2.000
  --    escrituras más recientes, y ya no volvía a entrar jamás.
  select count(*) into v_n from order_master_stale(v_store) where order_id = v_viejo;
  if v_n <> 1 then raise exception 'un desfase ANTIGUO tiene que verse igual que uno reciente'; end if;

  -- 5. Y sale PRIMERO: se recorre del recálculo más viejo al más nuevo, para que
  --    un atraso se drene empezando por lo que lleva más tiempo mintiendo.
  select order_id into v_first from order_master_stale(v_store) limit 1;
  if v_first <> v_viejo then raise exception 'el desfase más antiguo debería salir primero'; end if;

  -- 6. El tope devuelve como mucho lo pedido.
  select count(*) into v_n from order_master_stale(v_store, 1);
  if v_n <> 1 then raise exception 'p_limit debería acotar el resultado'; end if;

  -- 7. Aislamiento por tienda: preguntar por otra no devuelve estos.
  select count(*) into v_n
    from order_master_stale('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid);
  if v_n <> 0 then raise exception 'no debería devolver pedidos de otra tienda'; end if;

  delete from order_master where store_id = v_store;
  delete from shipments    where store_id = v_store;
  delete from orders       where store_id = v_store;

  raise notice 'order_master_stale: 7 comprobaciones OK';
end $$;
