\set ON_ERROR_STOP on
-- 0321: la fila del rastreo de Shalom (MOM §12). Las tres columnas nacen sin
-- sello y con la racha en cero, la racha no baja de cero, los sellos del
-- rastreo no mueven `updated_at` (como `api_report_at`, 0204), `last_report_at`
-- y un cambio de verdad sí, y la fila va por `shalom_checked_at` con la nunca
-- preguntada primero. Reutiliza la tienda A de rls_smoke.sql.
begin;

do $test$
declare
  v_a      uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_g1     uuid;
  v_g2     uuid;
  v_before timestamptz;
  v_after  timestamptz;
  v_first  uuid;
begin
  insert into shipments (store_id, courier, guide_code, delivery_status, status_category, updated_at)
  values (v_a, 'shalom', 'SCQ-1', 'pendiente', 'in_transit', now() - interval '2 hours')
  returning id into v_g1;
  insert into shipments (store_id, courier, guide_code, delivery_status, status_category, updated_at, created_at)
  values (v_a, 'shalom', 'SCQ-2', 'pendiente', 'in_transit', now() - interval '2 hours', now() - interval '1 day')
  returning id into v_g2;

  -- Nacen sin sello y con la racha en cero.
  if (select shalom_checked_at from shipments where id = v_g1) is not null then raise exception 'FAIL checked_at default'; end if;
  if (select shalom_not_found_since from shipments where id = v_g1) is not null then raise exception 'FAIL since default'; end if;
  if (select shalom_not_found_count from shipments where id = v_g1) <> 0 then raise exception 'FAIL count default'; end if;

  -- La racha no baja de cero ni queda nula.
  begin
    update shipments set shalom_not_found_count = -1 where id = v_g1;
    raise exception 'FAIL negative count';
  exception when check_violation then null; end;
  begin
    update shipments set shalom_not_found_count = null where id = v_g1;
    raise exception 'FAIL null count';
  exception when not_null_violation then null; end;

  -- Los sellos del rastreo no mueven `updated_at`.
  select updated_at into v_before from shipments where id = v_g1;
  update shipments
     set shalom_checked_at = now(), shalom_not_found_since = now(), shalom_not_found_count = 3
   where id = v_g1;
  select updated_at into v_after from shipments where id = v_g1;
  if v_after <> v_before then raise exception 'FAIL a check stamp moved updated_at'; end if;
  -- Junto con `api_report_at`, tampoco (la regla de la 0204 sigue).
  update shipments set shalom_checked_at = now(), api_report_at = now() where id = v_g1;
  select updated_at into v_after from shipments where id = v_g1;
  if v_after <> v_before then raise exception 'FAIL check stamp + api_report_at moved updated_at'; end if;

  -- `last_report_at` sí lo mueve (0204), y un cambio de verdad también.
  update shipments set shalom_checked_at = now(), last_report_at = now() where id = v_g1;
  select updated_at into v_after from shipments where id = v_g1;
  if not (v_after > v_before) then raise exception 'FAIL last_report_at stopped moving updated_at'; end if;
  update shipments set updated_at = now() - interval '1 hour' where id = v_g2;
  select updated_at into v_before from shipments where id = v_g2;
  update shipments set delivery_status = 'en_ruta', shalom_checked_at = now() where id = v_g2;
  select updated_at into v_after from shipments where id = v_g2;
  if not (v_after > v_before) then raise exception 'FAIL a real change did not move updated_at'; end if;

  -- La fila: la nunca preguntada primero.
  update shipments set shalom_checked_at = null where id = v_g2;
  select id into v_first from shipments
   where courier = 'shalom' and guide_code in ('SCQ-1', 'SCQ-2')
   order by shalom_checked_at asc nulls first, created_at asc limit 1;
  if v_first <> v_g2 then raise exception 'FAIL never-checked guide is not first'; end if;

  if not exists (select 1 from pg_indexes where indexname = 'shipments_shalom_check_queue_idx') then
    raise exception 'FAIL queue index missing';
  end if;
end $test$;

rollback;
