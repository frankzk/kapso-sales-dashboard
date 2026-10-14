\set ON_ERROR_STOP on
-- 0256: «Todos» de Repro Lima (MOM §9.5). Corre en el clúster desechable de
-- verify-db, después de todas las migraciones, dentro de una transacción que se
-- deshace. Reutiliza las tiendas de rls_smoke.sql: A y B.
--
-- Lo que se fija aquí lo garantiza la base y no solo el código:
--   a) la RPC es exactamente un GROUP BY directo sobre el mismo predicado;
--   b) «Finalizado» y la cobertura que no es Lima quedan fuera, y la cobertura
--      manda sobre `macro_operation` (un pedido de Lima atendido por agencia
--      cuenta);
--   c) los días son días de Lima: el borde de 7 y de 30 días cae a la
--      medianoche de Lima y no a la de UTC, sea cual sea la zona de la sesión;
--   d) un pedido sin `macro_since` cuenta solo en el total;
--   e) una tienda que no se pide no aparece;
--   f) solo el cliente de servicio la ejecuta: authenticated y anon reciben
--      insufficient_privilege.
--
-- Las otras pruebas dejan pedidos en A y B. Por eso las cifras se comprueban
-- como diferencia: lo que la RPC devuelve después de sembrar menos lo que
-- devolvía antes, para tres días de corte (13, 14 y 15-10-2026).
--
-- La cobertura la escribe el trigger `order_master_coverage` (0083), no quien
-- inserta: los pedidos de Lima se siembran con una dirección de Lima
-- Metropolitana y lo primero es comprobar que `order_coverage_for` la da por
-- Lima.
begin;

-- ── La dirección sembrada resuelve a Lima (el trigger es el dueño) ──────────
do $$
begin
  if order_coverage_for('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Lima', 'Lima', 'Miraflores', null, null, '2026-10-14') <> 'lima' then
    raise exception 'Miraflores no resuelve a lima en la tienda A';
  end if;
  if order_coverage_for('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Lima', 'Lima', 'Santiago de Surco', null, null, '2026-10-14') <> 'lima' then
    raise exception 'Santiago de Surco no resuelve a lima en la tienda B';
  end if;
  if order_coverage_for('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Arequipa', 'Arequipa', 'Cayma', null, null, '2026-10-14') = 'lima' then
    raise exception 'Cayma (Arequipa) resuelve a lima';
  end if;
end $$;

-- ── Lo que ya había antes de sembrar, por día de corte ──────────────────────
create temp table lima_open_before on commit drop as
select d.day, r.*
  from (values ('2026-10-13'::date), ('2026-10-14'::date), ('2026-10-15'::date)) as d(day)
 cross join lateral order_master_lima_open_counts(
   array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], d.day) as r;

insert into orders (id, store_id, shopify_order_id, name, created_at) values
  ('25600000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-01', '#LOC01', '2026-09-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-02', '#LOC02', '2026-09-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-03', '#LOC03', '2026-09-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-04', '#LOC04', '2026-09-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-05', '#LOC05', '2026-09-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000006', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-06', '#LOC06', '2026-09-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000007', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-07', '#LOC07', '2026-09-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000008', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-08', '#LOC08', '2026-07-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000009', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-09', '#LOC09', '2026-09-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000010', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-10', '#LOC10', '2026-09-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-11', '#LOC11', '2026-09-01 10:00-05'),
  ('25600000-0000-0000-0000-000000000012', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'loc-12', '#LOC12', '2026-09-01 10:00-05');

insert into order_master (order_id, store_id, shopify_order_id, order_name, order_created_at, order_total, general_status, macro_version,
                          region, province, district, macro_operation, macro_stage, macro_substage, macro_since) values
  -- Tienda A, Lima. Preparación · Por generar rótulo: los cuatro bordes y uno sin fecha.
  --   23:30 del 06-10 en Lima son las 04:30 del 07-10 en UTC: 8 días de Lima, 7 de UTC.
  ('25600000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-01', '#LOC01', '2026-09-01 10:00-05', 100, 'en_proceso', 'mom-v1.26',
   'Lima', 'Lima', 'Miraflores', 'lima', 'preparacion', 'por_generar_rotulo', '2026-10-06 23:30-05'),
  --   00:30 del 07-10 en Lima: 7 días, no más de 7.
  ('25600000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-02', '#LOC02', '2026-09-01 10:00-05', 100, 'en_proceso', 'mom-v1.26',
   'Lima', 'Lima', 'Miraflores', 'lima', 'preparacion', 'por_generar_rotulo', '2026-10-07 00:30-05'),
  --   23:30 del 13-09 en Lima: 31 días de Lima, 30 de UTC.
  ('25600000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-03', '#LOC03', '2026-09-01 10:00-05', 100, 'en_proceso', 'mom-v1.26',
   'Lima', 'Lima', 'Miraflores', 'lima', 'preparacion', 'por_generar_rotulo', '2026-09-13 23:30-05'),
  --   00:30 del 14-09 en Lima: 30 días, no más de 30.
  ('25600000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-04', '#LOC04', '2026-09-01 10:00-05', 100, 'en_proceso', 'mom-v1.26',
   'Lima', 'Lima', 'Miraflores', 'lima', 'preparacion', 'por_generar_rotulo', '2026-09-14 00:30-05'),
  --   Sin macro_since: solo el total.
  ('25600000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-05', '#LOC05', '2026-09-01 10:00-05', 100, 'en_proceso', 'mom-v1.26',
   'Lima', 'Lima', 'Miraflores', 'lima', 'preparacion', 'por_generar_rotulo', null),
  -- Por despachar · Listo para asignar, del día anterior.
  ('25600000-0000-0000-0000-000000000006', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-06', '#LOC06', '2026-09-01 10:00-05', 100, 'en_proceso', 'mom-v1.26',
   'Lima', 'Lima', 'Miraflores', 'lima', 'por_despachar', 'listo_para_asignar', '2026-10-13 10:00-05'),
  -- En curso · Por reprogramar Lima: la RPC la devuelve; la pantalla usa las suyas.
  ('25600000-0000-0000-0000-000000000007', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-07', '#LOC07', '2026-09-01 10:00-05', 100, 'en_proceso', 'mom-v1.26',
   'Lima', 'Lima', 'Miraflores', 'lima', 'en_curso', 'por_reprogramar_lima', '2026-10-01 10:00-05'),
  -- Por cerrar · Pendiente de liquidación: entregado hace mucho.
  ('25600000-0000-0000-0000-000000000008', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-08', '#LOC08', '2026-07-01 10:00-05', 100, 'entregado', 'mom-v1.26',
   'Lima', 'Lima', 'Miraflores', 'lima', 'por_cerrar', 'pendiente_liquidacion', '2026-08-01 10:00-05'),
  -- Finalizado: fuera.
  ('25600000-0000-0000-0000-000000000009', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-09', '#LOC09', '2026-09-01 10:00-05', 100, 'entregado', 'mom-v1.26',
   'Lima', 'Lima', 'Miraflores', 'lima', 'finalizado', 'entregado_cerrado', '2026-10-01 10:00-05'),
  -- De Lima pero atendido por agencia: cuenta, porque manda la cobertura.
  ('25600000-0000-0000-0000-000000000010', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-10', '#LOC10', '2026-09-01 10:00-05', 100, 'en_proceso', 'mom-v1.26',
   'Lima', 'Lima', 'Miraflores', 'agencia', 'en_curso', 'en_reparto', '2026-10-10 10:00-05'),
  -- Tienda A, provincia: fuera.
  ('25600000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'loc-11', '#LOC11', '2026-09-01 10:00-05', 100, 'en_proceso', 'mom-v1.26',
   'Arequipa', 'Arequipa', 'Cayma', 'agencia', 'en_curso', 'en_transito', '2026-09-01 10:00-05'),
  -- Tienda B, Lima.
  ('25600000-0000-0000-0000-000000000012', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'loc-12', '#LOC12', '2026-09-01 10:00-05', 100, 'en_proceso', 'mom-v1.26',
   'Lima', 'Lima', 'Santiago de Surco', 'lima', 'en_curso', 'en_reparto', '2026-10-12 10:00-05');

do $$
declare
  v_bad text;
begin
  -- El trigger escribió la cobertura: once de Lima y la de Arequipa no.
  select string_agg(order_name || '=' || coalesce(coverage, 'null'), ', ' order by order_name) into v_bad
    from order_master
   where order_id::text like '25600000-%'
     and (coverage = 'lima') is distinct from (district <> 'Cayma');
  if v_bad is not null then raise exception 'cobertura sembrada inesperada: %', v_bad; end if;
end $$;

-- ── a) La RPC es un GROUP BY directo sobre el mismo predicado ──────────────
do $$
declare
  v_diff int;
begin
  with rpc as (
    select * from order_master_lima_open_counts(
      array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-10-14')
  ), direct as (
    select om.store_id, om.macro_stage, om.macro_substage,
           count(*)::bigint as total,
           count(*) filter (where '2026-10-14'::date - (om.macro_since at time zone 'America/Lima')::date > 7)::bigint as over_7,
           count(*) filter (where '2026-10-14'::date - (om.macro_since at time zone 'America/Lima')::date > 30)::bigint as over_30
      from order_master om
     where om.store_id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
       and om.coverage = 'lima'
       and om.macro_stage is not null
       and om.macro_stage <> 'finalizado'
     group by om.store_id, om.macro_stage, om.macro_substage
  )
  select count(*) into v_diff
    from ((select * from rpc except all select * from direct)
          union all
          (select * from direct except all select * from rpc)) as d;
  if v_diff <> 0 then raise exception 'la RPC difiere del GROUP BY directo en % filas', v_diff; end if;
end $$;

-- ── b), c), d) Lo sembrado, día por día, como diferencia ────────────────────
--   Por generar rótulo (A), cinco pedidos:
--     13-10: más de 7 solo los de 30 y 31 días; ninguno de más de 30.
--     14-10: el de 8 días entra en más de 7; el de 31, en más de 30.
--     15-10: el de 7 días ya tiene 8; el de 30, 31. El sin fecha no entra nunca.
create temp table lima_open_expected (day date, store_id uuid, macro_stage text, macro_substage text, total bigint, over_7 bigint, over_30 bigint) on commit drop;
insert into lima_open_expected
select d.day, e.store_id::uuid, e.macro_stage, e.macro_substage, e.total,
       case d.day when '2026-10-13' then e.o7_13 when '2026-10-14' then e.o7_14 else e.o7_15 end,
       case d.day when '2026-10-13' then e.o30_13 when '2026-10-14' then e.o30_14 else e.o30_15 end
  from (values ('2026-10-13'::date), ('2026-10-14'::date), ('2026-10-15'::date)) as d(day)
 cross join (values
   --  tienda                                   etapa            subetapa                 total o7(13,14,15) o30(13,14,15)
   ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'preparacion',   'por_generar_rotulo',    5::bigint, 2::bigint, 3::bigint, 4::bigint, 0::bigint, 1::bigint, 2::bigint),
   ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'por_despachar', 'listo_para_asignar',    1, 0, 0, 0, 0, 0, 0),
   ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'en_curso',      'por_reprogramar_lima',  1, 1, 1, 1, 0, 0, 0),
   ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'en_curso',      'en_reparto',            1, 0, 0, 0, 0, 0, 0),
   ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'por_cerrar',    'pendiente_liquidacion', 1, 1, 1, 1, 1, 1, 1),
   ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'en_curso',      'en_reparto',            1, 0, 0, 0, 0, 0, 0)
 ) as e(store_id, macro_stage, macro_substage, total, o7_13, o7_14, o7_15, o30_13, o30_14, o30_15);

do $$
declare
  v_tz text;
  v_bad text;
begin
  -- La zona de la sesión no mueve el borde: los días son de Lima siempre.
  foreach v_tz in array array['UTC', 'America/Lima', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'] loop
    perform set_config('timezone', v_tz, true);
    with after as (
      select d.day, r.*
        from (values ('2026-10-13'::date), ('2026-10-14'::date), ('2026-10-15'::date)) as d(day)
       cross join lateral order_master_lima_open_counts(
         array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], d.day) as r
    ), delta as (
      select coalesce(a.day, b.day) as day,
             coalesce(a.store_id, b.store_id) as store_id,
             coalesce(a.macro_stage, b.macro_stage) as macro_stage,
             coalesce(a.macro_substage, b.macro_substage) as macro_substage,
             coalesce(a.total, 0) - coalesce(b.total, 0) as total,
             coalesce(a.over_7, 0) - coalesce(b.over_7, 0) as over_7,
             coalesce(a.over_30, 0) - coalesce(b.over_30, 0) as over_30
        from after a
        full join lima_open_before b
          on b.day = a.day and b.store_id = a.store_id and b.macro_stage = a.macro_stage
         and b.macro_substage is not distinct from a.macro_substage
    ), changed as (
      select * from delta where (total, over_7, over_30) <> (0, 0, 0)
    )
    select string_agg(format('%s %s %s/%s: %s',
                             coalesce(c.day, e.day),
                             left(coalesce(c.store_id, e.store_id)::text, 1),
                             coalesce(c.macro_stage, e.macro_stage),
                             coalesce(c.macro_substage, e.macro_substage),
                             case when c.day is null then 'falta, se esperaba ' || e.total || '/' || e.over_7 || '/' || e.over_30
                                  when e.day is null then 'sobra ' || c.total || '/' || c.over_7 || '/' || c.over_30
                                  else c.total || '/' || c.over_7 || '/' || c.over_30 || ' en vez de ' || e.total || '/' || e.over_7 || '/' || e.over_30 end),
                      '; ')
      into v_bad
      from changed c
      full join lima_open_expected e
        on e.day = c.day and e.store_id = c.store_id and e.macro_stage = c.macro_stage and e.macro_substage = c.macro_substage
     where c.day is null or e.day is null
        or (c.total, c.over_7, c.over_30) <> (e.total, e.over_7, e.over_30);
    if v_bad is not null then raise exception 'zona %: lo sembrado no cuenta como se espera: %', v_tz, v_bad; end if;
  end loop;
  perform set_config('timezone', 'UTC', true);

  -- b) Ninguna fila de Finalizado, venga de donde venga.
  if exists (select 1 from order_master_lima_open_counts(
               array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-10-14')
              where macro_stage = 'finalizado') then
    raise exception 'la RPC devolvió pedidos en Finalizado';
  end if;
end $$;

-- ── e) Solo las tiendas que se piden ────────────────────────────────────────
do $$
begin
  if exists (select 1 from order_master_lima_open_counts(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-10-14')
              where store_id <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') then
    raise exception 'pidiendo solo A, aparecen pedidos de otra tienda';
  end if;
  if exists (select 1 from order_master_lima_open_counts(array['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-10-14')
              where store_id <> 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') then
    raise exception 'pidiendo solo B, aparecen pedidos de otra tienda';
  end if;
  -- Lo de A es lo mismo pidiéndola sola que junto con B.
  if exists (
    (select * from order_master_lima_open_counts(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-10-14')
     except all
     select * from order_master_lima_open_counts(
       array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-10-14')
     where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    union all
    (select * from order_master_lima_open_counts(
       array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-10-14')
     where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
     except all
     select * from order_master_lima_open_counts(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-10-14'))
  ) then
    raise exception 'la tienda A cuenta distinto sola que junto con B';
  end if;
  if not exists (select 1 from order_master_lima_open_counts(array['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-10-14')
                  where macro_stage = 'en_curso' and macro_substage = 'en_reparto') then
    raise exception 'pidiendo B, no aparece su pedido en reparto';
  end if;
  -- Sin tiendas, nada.
  if exists (select 1 from order_master_lima_open_counts(array[]::uuid[], '2026-10-14'))
     or exists (select 1 from order_master_lima_open_counts(null, '2026-10-14')) then
    raise exception 'sin tiendas, la RPC devolvió filas';
  end if;
end $$;

-- ── f) Solo el cliente de servicio ──────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.order_master_lima_open_counts(uuid[], date)', 'execute')
     or has_function_privilege('anon', 'public.order_master_lima_open_counts(uuid[], date)', 'execute')
     or has_function_privilege('public', 'public.order_master_lima_open_counts(uuid[], date)', 'execute') then
    raise exception 'authenticated, anon o public pueden ejecutar order_master_lima_open_counts';
  end if;
  if not has_function_privilege('service_role', 'public.order_master_lima_open_counts(uuid[], date)', 'execute') then
    raise exception 'service_role no puede ejecutar order_master_lima_open_counts';
  end if;
end $$;

-- El cliente de servicio la ejecuta (security invoker: lee order_master con
-- sus propios permisos) y ve lo mismo que el dueño de la base.
create temp table lima_open_owner on commit drop as
select * from order_master_lima_open_counts(
  array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-10-14');
grant select on lima_open_owner to service_role;
set role service_role;
do $$
begin
  if exists (
    (select * from order_master_lima_open_counts(
       array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-10-14')
     except all select * from lima_open_owner)
    union all
    (select * from lima_open_owner
     except all
     select * from order_master_lima_open_counts(
       array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[], '2026-10-14'))
  ) then
    raise exception 'service_role cuenta distinto que el dueño de la base';
  end if;
  if not exists (select 1 from lima_open_owner where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') then
    raise exception 'service_role no ve la tienda B';
  end if;
end $$;
reset role;

-- authenticated (aunque sea el owner de las dos tiendas) y anon: sin permiso.
set request.test_uid = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
do $$
begin
  begin
    perform order_master_lima_open_counts(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-10-14');
    raise exception 'FAIL authenticated ejecutó order_master_lima_open_counts';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set request.test_uid = '';
set role anon;
do $$
begin
  begin
    perform order_master_lima_open_counts(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[], '2026-10-14');
    raise exception 'FAIL anon ejecutó order_master_lima_open_counts';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

\echo '  order_master_lima_open_counts: 6 comprobaciones OK'
rollback;
