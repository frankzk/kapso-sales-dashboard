\set ON_ERROR_STOP on
-- 0356: los sellos del cierre de Aliclik (MOM §19.2). `aliclik_followup_at` y
-- `reason_probed_at` no mueven `shipments.updated_at` ni dejan el pedido
-- desfasado; un cambio de verdad sí, también junto con un sello; y las reglas
-- de la 0204 y la 0321 siguen: sus sellos tampoco lo mueven y `last_report_at`
-- sí. Reutiliza la tienda A de rls_smoke.sql.
begin;

do $test$
declare
  v_a      uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_o1     uuid := '35500000-0000-0000-0000-00000000000a';
  v_o2     uuid := '35500000-0000-0000-0000-00000000000b';
  v_g1     uuid;
  v_g2     uuid;
  v_before timestamptz;
  v_after  timestamptz;
  v_n      int;
begin
  insert into orders (id, store_id, shopify_order_id, name, created_at) values
    (v_o1, v_a, 'afn-1', '#AFN1', now() - interval '1 day'),
    (v_o2, v_a, 'afn-2', '#AFN2', now() - interval '1 day');
  insert into order_master (order_id, store_id, shopify_order_id, order_name, customer_name,
                            customer_phone, guide_code, macro_version, recomputed_at, updated_at) values
    (v_o1, v_a, 'afn-1', '#AFN1', 'Sello Uno', '999355001', 'AFN-G1', 'mom-v1.8',
     now() - interval '1 hour', now() - interval '1 hour'),
    (v_o2, v_a, 'afn-2', '#AFN2', 'Sello Dos', '999355002', 'AFN-G2', 'mom-v1.8',
     now() - interval '1 hour', now() - interval '1 hour');
  -- Las dos guías nacen «tocadas» hace dos horas: antes del último recálculo.
  insert into shipments (store_id, order_id, courier, guide_code, delivery_status, status_category, updated_at)
  values (v_a, v_o1, 'aliclik', 'AFN-G1', 'pendiente', 'in_transit', now() - interval '2 hours')
  returning id into v_g1;
  insert into shipments (store_id, order_id, courier, guide_code, delivery_status, status_category, updated_at)
  values (v_a, v_o2, 'aliclik', 'AFN-G2', 'pendiente', 'in_transit', now() - interval '2 hours')
  returning id into v_g2;

  -- 1. El sello del turno no es un cambio de la guía, y el pedido no queda desfasado.
  select updated_at into v_before from shipments where id = v_g1;
  update shipments set aliclik_followup_at = now() where id = v_g1;
  select updated_at into v_after from shipments where id = v_g1;
  if v_after <> v_before then raise exception 'FAIL 1: aliclik_followup_at moved updated_at'; end if;
  if (select aliclik_followup_at from shipments where id = v_g1) is null then raise exception 'FAIL 1: the stamp was not written'; end if;
  select count(*) into v_n from order_master_stale(v_a) where order_id = v_o1;
  if v_n <> 0 then raise exception 'FAIL 1: a follow-up stamp left the order stale'; end if;

  -- 2. El sello de la consulta del motivo, tampoco. Ni los dos juntos con los de la API.
  update shipments set reason_probed_at = now() where id = v_g1;
  select updated_at into v_after from shipments where id = v_g1;
  if v_after <> v_before then raise exception 'FAIL 2: reason_probed_at moved updated_at'; end if;
  update shipments
     set aliclik_followup_at = now() + interval '1 second', reason_probed_at = now() + interval '1 second',
         api_report_at = now(), api_updated_at = now()
   where id = v_g1;
  select updated_at into v_after from shipments where id = v_g1;
  if v_after <> v_before then raise exception 'FAIL 2: stamps together moved updated_at'; end if;

  -- 3. Los sellos de la 0321 siguen sin moverlo: la lista se amplió, no se reemplazó.
  update shipments set shalom_checked_at = now(), shalom_not_found_since = now(), shalom_not_found_count = 2 where id = v_g1;
  select updated_at into v_after from shipments where id = v_g1;
  if v_after <> v_before then raise exception 'FAIL 3: the 0321 stamps started moving updated_at'; end if;
  select count(*) into v_n from order_master_stale(v_a) where order_id = v_o1;
  if v_n <> 0 then raise exception 'FAIL 3: stamps left the order stale'; end if;

  -- 4. `last_report_at` sí lo mueve (0204), aunque venga con un sello.
  update shipments set aliclik_followup_at = now() + interval '2 seconds', last_report_at = now() where id = v_g1;
  select updated_at into v_after from shipments where id = v_g1;
  if not (v_after > v_before) then raise exception 'FAIL 4: last_report_at stopped moving updated_at'; end if;

  -- 5. Un cambio de verdad lo mueve y deja el pedido desfasado, también junto con un sello.
  select updated_at into v_before from shipments where id = v_g2;
  update shipments set delivery_status = 'anulado', aliclik_followup_at = now() where id = v_g2;
  select updated_at into v_after from shipments where id = v_g2;
  if not (v_after > v_before) then raise exception 'FAIL 5: a real change did not move updated_at'; end if;
  select count(*) into v_n from order_master_stale(v_a) where order_id = v_o2;
  if v_n <> 1 then raise exception 'FAIL 5: a real change did not leave the order stale'; end if;
end $test$;

rollback;
