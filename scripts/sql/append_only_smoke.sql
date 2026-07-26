-- Append-only assertions for the Master de Pedidos audit trail. Run after every
-- migration has been applied on a throwaway cluster. Each block RAISEs when the
-- guarantee is broken, so with ON_ERROR_STOP the script exits non-zero.
--
-- What we are proving: `order_events` is the trazabilidad of every order — who
-- changed what, when, and from which source. It must be impossible to rewrite,
-- even through the role the server actions write with (`service_role`), which is
-- why that role gets only SELECT + INSERT and the table carries a guard trigger.
--
-- Note on error codes: the guard trigger raises the default P0001. Our own
-- "the guarantee is broken" raises use ZZ001 so they are NOT swallowed by the
-- handler that is there to catch the trigger.

-- Reuse the org/store fixtures created by rls_smoke.sql; add one order.
insert into orders(id, store_id, shopify_order_id, name, created_at)
values ('eeeeeeee-0000-0000-0000-00000000000e',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '9000000001', '#APPEND1', now())
on conflict (store_id, shopify_order_id) do nothing;

insert into order_events(store_id, order_id, kind, source, note)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'eeeeeeee-0000-0000-0000-00000000000e',
        'created', 'shopify', 'evento de prueba');

-- 1) UPDATE must fail.
do $$
begin
  update order_events set note = 'reescrito'
   where order_id = 'eeeeeeee-0000-0000-0000-00000000000e';
  raise exception 'order_events aceptó un UPDATE: la auditoría no es inmutable'
    using errcode = 'ZZ001';
exception
  when sqlstate 'P0001' then null;  -- el trigger append-only actuó: correcto
end;
$$;

-- 2) DELETE must fail.
do $$
begin
  delete from order_events
   where order_id = 'eeeeeeee-0000-0000-0000-00000000000e';
  raise exception 'order_events aceptó un DELETE: la auditoría no es inmutable'
    using errcode = 'ZZ001';
exception
  when sqlstate 'P0001' then null;
end;
$$;

-- 3) The event is still there, untouched.
do $$
declare n int; kept text;
begin
  select count(*), max(note) into n, kept from order_events
   where order_id = 'eeeeeeee-0000-0000-0000-00000000000e';
  if n <> 1 or kept is distinct from 'evento de prueba' then
    raise exception 'order_events perdió o alteró el evento (n=%, note=%)', n, kept
      using errcode = 'ZZ001';
  end if;
end;
$$;

-- 4) service_role holds no UPDATE/DELETE privilege at all — the trigger is
--    defense in depth, not the only lock.
do $$
declare bad text;
begin
  select string_agg(privilege_type, ',') into bad
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'order_events'
     and grantee = 'service_role'
     and privilege_type in ('UPDATE', 'DELETE');
  if bad is not null then
    raise exception 'service_role conserva privilegios % sobre order_events', bad
      using errcode = 'ZZ001';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Clave de recojo (0049): la información más sensible del sistema.
-- ----------------------------------------------------------------------------

-- 5) `shalom_pickup_keys` no es legible por el rol `authenticated`. RLS activo y
--    SIN policy = denegado; además no se le otorga SELECT. La clave solo sale
--    por el server action, que comprueba permisos y deja auditoría.
do $$
declare has_policy int; has_grant int; rls boolean;
begin
  select count(*) into has_policy from pg_policies
   where schemaname = 'public' and tablename = 'shalom_pickup_keys';
  if has_policy > 0 then
    raise exception 'shalom_pickup_keys tiene % policy(s): la clave sería legible', has_policy
      using errcode = 'ZZ001';
  end if;

  select count(*) into has_grant from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'shalom_pickup_keys'
     and grantee = 'authenticated';
  if has_grant > 0 then
    raise exception 'shalom_pickup_keys concede privilegios a authenticated'
      using errcode = 'ZZ001';
  end if;

  select relrowsecurity into rls from pg_class
   where oid = 'public.shalom_pickup_keys'::regclass;
  if not rls then
    raise exception 'shalom_pickup_keys no tiene RLS activo' using errcode = 'ZZ001';
  end if;
end;
$$;

-- 6) El historial de visualizaciones de la clave tampoco se puede reescribir:
--    "la visualización de la clave no deberá poder eliminarse del historial".
insert into pickup_key_views(store_id, order_id, user_id, reason)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'eeeeeeee-0000-0000-0000-00000000000e',
        null, 'prueba');

do $$
begin
  delete from pickup_key_views where order_id = 'eeeeeeee-0000-0000-0000-00000000000e';
  raise exception 'pickup_key_views aceptó un DELETE: la auditoría no es inmutable'
    using errcode = 'ZZ001';
exception
  when sqlstate 'P0001' then null;
end;
$$;

do $$
declare n int;
begin
  select count(*) into n from pickup_key_views
   where order_id = 'eeeeeeee-0000-0000-0000-00000000000e';
  if n <> 1 then
    raise exception 'pickup_key_views perdió el registro (n=%)', n using errcode = 'ZZ001';
  end if;
end;
$$;

-- 7) Unicidad global del comprobante Yape: el mismo nº de operación no puede
--    usarse en dos pedidos, ni siquiera de tiendas distintas.
insert into orders(id, store_id, shopify_order_id, name, created_at)
values ('eeeeeeee-0000-0000-0000-00000000000f',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        '9000000002', '#APPEND2', now())
on conflict (store_id, shopify_order_id) do nothing;

insert into order_payments(store_id, order_id, kind, amount, operation_number, validation_status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'eeeeeeee-0000-0000-0000-00000000000e',
        'adelanto', 50, 'OP-DUP-1', 'validado');

do $$
begin
  -- Otro pedido, OTRA TIENDA, mismo nº de operación: debe rebotar.
  insert into order_payments(store_id, order_id, kind, amount, operation_number, validation_status)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          'eeeeeeee-0000-0000-0000-00000000000f',
          'diferencia', 50, 'OP-DUP-1', 'pendiente_revision');
  raise exception 'order_payments aceptó el mismo nº de operación en dos pedidos'
    using errcode = 'ZZ001';
exception
  when unique_violation then null;
end;
$$;

-- 8) Un pago rechazado libera su nº de operación (pudo ser un error de carga).
update order_payments set validation_status = 'rechazado' where operation_number = 'OP-DUP-1';
insert into order_payments(store_id, order_id, kind, amount, operation_number, validation_status)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'eeeeeeee-0000-0000-0000-00000000000f',
        'diferencia', 50, 'OP-DUP-1', 'pendiente_revision');

-- 9) Un solo adelanto vivo por pedido.
do $$
begin
  insert into order_payments(store_id, order_id, kind, amount, validation_status)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          'eeeeeeee-0000-0000-0000-00000000000f',
          'diferencia', 99, 'pendiente_revision');
  raise exception 'order_payments aceptó dos diferencias vivas en el mismo pedido'
    using errcode = 'ZZ001';
exception
  when unique_violation then null;
end;
$$;
