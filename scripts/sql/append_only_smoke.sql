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
