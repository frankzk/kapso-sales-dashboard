-- 0234_gf_notebook_carry_over.sql — la hoja del motorizado sin app se carga
-- desde Kapta (MOM §29.7, 08-10-2026, decisión de Frankz).
--
-- QUÉ PASABA. Alexis todavía no usa la app: manda una foto de su hoja por día y
-- hasta ahora se cargaba a mano con SQL (docs/runbooks/cuaderno-a-rutas.md).
-- El paso más delicado era el traspaso de los reprogramados que él conserva:
-- sacar el paquete de la caja del día anterior y meterlo en una carga de su
-- ruta siguiente, ya cotejada, con rastro (§29.7, 07-10-2026). Eso solo se
-- puede hacer en SQL —el guardián de la caja exige `gf.withdraw = on` en la
-- misma transacción— y lo hacía una persona con acceso a la base.
--
-- QUÉ CAMBIA.
--   gf_carry_over            el traspaso, en una función: valida cada paquete
--                            (reprogramado, en una caja anterior del mismo
--                            motorizado, pedido vivo, sin parada en la ruta
--                            destino, sin una carga a medio armar ese día), lo
--                            retira con `carried_over` y
--                            `package_removed`, lo mete en una carga adicional
--                            cotejada por oficina y por el motorizado, y pasa la
--                            carga a custodia: nacen las paradas pendientes.
--   rider_notebook_imports   cada hoja leída desde «Reparto y liquidación»: las
--                            fotos (bucket privado), lo que leyó la visión, el
--                            cruce con la ruta y lo que se aplicó. Es la
--                            auditoría de lo que se cargó sin la app.
--
-- Aplicar a mano antes de desplegar el código que la usa (DEPLOY.md).

create or replace function public.gf_carry_over(
  p_rider_id uuid,
  p_to_date date,
  p_shipment_ids uuid[],
  p_actor uuid
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_rider riders%rowtype;
  v_load uuid;
  r record;
  v_n int := 0;
  v_reason text;
  v_wanted int := (select count(distinct x) from unnest(p_shipment_ids) as x);
begin
  if v_wanted = 0 then raise exception 'No hay paquetes que pasar.'; end if;
  select * into v_rider from riders where id = p_rider_id;
  if not found then raise exception 'Motorizado no encontrado.'; end if;

  for r in
    select distinct on (sh.id)
           sh.id shipment_id, sh.order_id, sh.store_id ship_store, sh.guide_code,
           i.id item_id, i.store_id item_store, m.id old_manifest, m.org_id, m.route_date old_date, s.id old_stop
      from unnest(p_shipment_ids) as x(shipment_id)
      join shipments sh on sh.id = x.shipment_id
      join orders o on o.id = sh.order_id and o.cancelled_at is null
      join dispatch_manifest_items i on i.shipment_id = sh.id and i.removed_at is null
      join dispatch_manifests m on m.id = i.manifest_id and m.rider_id = p_rider_id and m.courier = 'propio'
           and m.state = 'in_custody' and m.route_date < p_to_date
      join delivery_stops s on s.dispatch_manifest_id = m.id and s.shipment_id = sh.id
           and s.status = 'no_entregado' and s.outcome_reason = 'reprogramado'
     order by sh.id, s.reported_at desc nulls last
  loop
    if exists (select 1 from delivery_routes dr join delivery_stops ds on ds.route_id = dr.id
                where dr.rider_id = p_rider_id and dr.route_date = p_to_date and ds.order_id = r.order_id) then
      raise exception 'El pedido ya tiene parada en la ruta del %.', to_char(p_to_date, 'DD/MM');
    end if;
    if v_load is null then
      v_load := public.gf_dispatch_load(r.org_id, p_rider_id, p_to_date, p_actor);
      -- gf_dispatch_load devuelve la carga que Despacho esté armando para ese
      -- día. Esa no se toca: pasarla a custodia sacaría su caja a medio cotejar.
      if exists (select 1 from dispatch_manifest_items where manifest_id = v_load) then
        raise exception 'Despacho está armando la carga de % del %: pasa los reprogramados cuando él la reciba.',
          v_rider.full_name, to_char(p_to_date, 'DD/MM');
      end if;
    end if;
    v_reason := 'Reprogramado el ' || to_char(r.old_date, 'DD/MM') || ': ' || v_rider.full_name
             || ' se quedó con el paquete y sale en su ruta del ' || to_char(p_to_date, 'DD/MM') || ', ya cotejado.';

    -- 1. Sale de la caja anterior: no volvió a la oficina, sigue con él.
    perform set_config('gf.withdraw', 'on', true);
    update dispatch_manifest_items
       set removed_at = clock_timestamp(), removed_by = p_actor, removal_reason = left(v_reason, 300)
     where id = r.item_id;
    perform set_config('gf.withdraw', 'off', true);
    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
    values (r.org_id, r.old_manifest, r.shipment_id, p_actor, 'carried_over',
            jsonb_build_object('stop_id', r.old_stop, 'to_route_date', p_to_date, 'to_manifest_id', v_load, 'reason', v_reason));
    -- Un segundo antes de la custodia de la carga nueva: la señal del motorizado
    -- que manda en el Master es la recepción (gfRiderSignal, mom-v1.14).
    insert into order_events(store_id, order_id, kind, occurred_at, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (r.ship_store, r.order_id, 'package_removed', now() - interval '1 second', p_actor, 'dispatch', 'propio',
            r.guide_code, r.shipment_id, 'reprogramado', v_reason,
            jsonb_build_object('manifest_id', r.old_manifest, 'rider_id', p_rider_id, 'route_date', r.old_date,
                               'carried_over', true, 'to_route_date', p_to_date, 'to_manifest_id', v_load));

    -- 2. Entra en la carga del día, cotejada por oficina y por el motorizado:
    --    él ya lo tiene, no hay nada que cotejar.
    insert into dispatch_manifest_items(manifest_id, shipment_id, store_id, added_by,
      office_checked_at, office_checked_by, pickup_checked_at, pickup_checked_by)
    values (v_load, r.shipment_id, r.item_store, p_actor, clock_timestamp(), p_actor, clock_timestamp(), p_actor);
    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload) values
      (r.org_id, v_load, r.shipment_id, p_actor, 'package_added',
       jsonb_build_object('source', 'grupo_gf_courier', 'riderId', p_rider_id, 'carried_from_manifest', r.old_manifest,
                          'carried_from_date', r.old_date, 'note', v_reason)),
      (r.org_id, v_load, r.shipment_id, p_actor, 'office_checked', jsonb_build_object('carried_over', true)),
      (r.org_id, v_load, r.shipment_id, p_actor, 'pickup_checked', jsonb_build_object('carried_over', true));
    v_n := v_n + 1;
  end loop;

  if v_n <> v_wanted then
    raise exception 'Solo % de % paquetes son reprogramados que % conserva en una caja anterior.', v_n, v_wanted, v_rider.full_name;
  end if;
  -- 3. La carga pasa a custodia: nacen las paradas pendientes de la ruta del día.
  perform public.finalize_dispatch_manifest(v_load, p_actor);
  return v_load;
end;
$$;
revoke all on function public.gf_carry_over(uuid, date, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.gf_carry_over(uuid, date, uuid[], uuid) to service_role;

create table if not exists public.rider_notebook_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  rider_id uuid not null references public.riders(id),
  route_date date not null,
  route_id uuid references public.delivery_routes(id),
  -- Fotos de la hoja en el bucket privado `rider-notebooks`.
  photo_paths text[] not null default '{}',
  -- Lo que leyó la visión, tal cual: la base para discutir una fila.
  transcription jsonb not null default '{}' check (jsonb_typeof(transcription) = 'object'),
  -- El cruce con la ruta y la propuesta por fila (lib/notebook-import.ts).
  plan jsonb not null default '[]' check (jsonb_typeof(plan) = 'array'),
  status text not null default 'leida' check (status in ('leida', 'aplicada')),
  -- Qué se aplicó y qué falló, fila por fila.
  result jsonb,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  applied_by uuid references auth.users(id),
  applied_at timestamptz,
  check ((status = 'aplicada') = (applied_at is not null))
);
create index if not exists rider_notebook_imports_rider_day
  on public.rider_notebook_imports(rider_id, route_date desc);
alter table public.rider_notebook_imports enable row level security;
-- Sin políticas: la lee y escribe el servidor con el service role, después de
-- comprobar `routes.manage` (app/dashboard/courier/notebook-actions.ts).
revoke all on public.rider_notebook_imports from anon, authenticated;
grant all on public.rider_notebook_imports to service_role;
