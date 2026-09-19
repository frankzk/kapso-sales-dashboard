-- ============================================================================
-- 0176_gf_one_load_per_day.sql — con la verificación del motorizado apagada,
-- una sola carga por motorizado y día (MOM §29.13, corrección 19-09-2026).
--
-- Con `rider_pickup_check_required = false`, asignar entrega la custodia en el
-- acto (0175). Tal como quedó, cada asignación posterior del mismo día abría
-- una carga adicional, porque gf_dispatch_load no admite meter paquetes en una
-- carga que ya inició cotejo o custodia. La operación quiere lo contrario: el
-- motorizado vuelve a la oficina y se le SUMAN paquetes a la misma carga y
-- ruta del día; el cierre es por día.
--
--   gf_dispatch_load_open   con el flag en false devuelve la carga del día
--                           aunque esté en custodia (o la crea); con el flag
--                           en true es gf_dispatch_load, sin cambios.
--   gf_add_item_in_custody  añade UN paquete a una carga ya en custodia: el
--                           ítem entra cotejado y recibido (actor supervisor,
--                           «custodia al asignar»), la salida pasa a custodia
--                           del courier y su parada se crea en la ruta del día
--                           sin duplicar (misma lógica que el trigger
--                           gf_received_load_to_delivery, para un solo ítem).
--   gf_guard_load_items     admite el INSERT en una carga en custodia solo
--                           cuando el proveedor tiene el flag en false.
-- ============================================================================
create or replace function public.gf_dispatch_load_open(p_org_id uuid, p_rider_id uuid, p_day date, p_actor uuid)
returns uuid language plpgsql set search_path = public as $$
declare v_required boolean; v_load dispatch_manifests%rowtype; v_route_status text;
begin
  select rider_pickup_check_required into v_required from logistics_providers
    where org_id = p_org_id and code = 'grupo-gf-courier';
  if coalesce(v_required, true) then
    return public.gf_dispatch_load(p_org_id, p_rider_id, p_day, p_actor);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || p_rider_id::text || p_day::text, 0));
  select * into v_load from dispatch_manifests
    where org_id = p_org_id and rider_id = p_rider_id and route_date = p_day
      and courier = 'propio' and state <> 'cancelled'
    order by load_number desc limit 1 for update;
  if found then
    select status into v_route_status from delivery_routes where id = v_load.delivery_route_id;
    if v_route_status = 'cerrada' then raise exception 'La ruta diaria ya está liquidada.'; end if;
    return v_load.id;
  end if;
  return public.gf_dispatch_load(p_org_id, p_rider_id, p_day, p_actor);
end;
$$;
revoke all on function public.gf_dispatch_load_open(uuid, uuid, date, uuid) from public, anon, authenticated;
grant execute on function public.gf_dispatch_load_open(uuid, uuid, date, uuid) to service_role;

create or replace function public.gf_add_item_in_custody(p_manifest_id uuid, p_shipment_id uuid, p_store_id uuid, p_actor uuid)
returns uuid language plpgsql set search_path = public as $$
declare
  v_manifest dispatch_manifests%rowtype;
  v_required boolean;
  v_shipment shipments%rowtype;
  v_route delivery_routes%rowtype;
  v_seq integer;
  v_note text := 'Custodia al asignar: verificación del motorizado desactivada.';
begin
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if not found or v_manifest.courier <> 'propio' or v_manifest.rider_id is null then
    raise exception 'La caja no es de un motorizado de Grupo GF.';
  end if;
  if v_manifest.state <> 'in_custody' then raise exception 'La caja todavía no está en custodia: usa la asignación normal.'; end if;
  select rider_pickup_check_required into v_required from logistics_providers
    where org_id = v_manifest.org_id and code = 'grupo-gf-courier';
  if coalesce(v_required, true) then
    raise exception 'La verificación del motorizado está activada: abre una carga adicional.';
  end if;
  select * into v_shipment from shipments where id = p_shipment_id for update;
  if not found then raise exception 'Paquete no encontrado.'; end if;
  if v_shipment.custody_state <> 'empresa' then raise exception 'El paquete ya no está en custodia de Grupo GF.'; end if;

  insert into dispatch_manifest_items(manifest_id, shipment_id, store_id, added_by,
    office_checked_at, office_checked_by, pickup_checked_at, pickup_checked_by)
  values (p_manifest_id, p_shipment_id, p_store_id, p_actor, now(), p_actor, now(), p_actor);

  update shipments set custody_state = 'courier', custody_transferred_at = now(),
    custody_transferred_by = p_actor, dispatched_at = coalesce(dispatched_at, now())
   where id = p_shipment_id;

  -- La ruta del día ya existe (la creó la primera custodia); si no, se abre.
  perform pg_advisory_xact_lock(hashtextextended(v_manifest.org_id::text || v_manifest.rider_id::text || v_manifest.route_date::text, 0));
  insert into delivery_routes(org_id, rider_id, route_date, status, created_by)
    values (v_manifest.org_id, v_manifest.rider_id, v_manifest.route_date, 'planificada', p_actor)
    on conflict (org_id, rider_id, route_date) do nothing;
  select * into v_route from delivery_routes
    where org_id = v_manifest.org_id and rider_id = v_manifest.rider_id and route_date = v_manifest.route_date for update;
  if v_route.status = 'cerrada' then raise exception 'La ruta diaria ya está liquidada.'; end if;
  if v_shipment.order_id is not null and not exists (
    select 1 from delivery_stops where route_id = v_route.id and order_id = v_shipment.order_id
  ) then
    select coalesce(max(seq), 0) + 1 into v_seq from delivery_stops where route_id = v_route.id;
    insert into delivery_stops(route_id, order_id, store_id, seq, shipment_id, dispatch_manifest_id)
      values (v_route.id, v_shipment.order_id, p_store_id, v_seq, p_shipment_id, p_manifest_id);
  end if;
  update delivery_routes set status = 'en_curso', started_at = coalesce(started_at, now())
    where id = v_route.id and status = 'planificada';
  update dispatch_manifests set delivery_route_id = coalesce(delivery_route_id, v_route.id) where id = p_manifest_id;

  insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
  values (v_manifest.org_id, p_manifest_id, p_shipment_id, p_actor, 'package_added',
          jsonb_build_object('source', 'grupo_gf_courier', 'auto_custody', true, 'note', v_note));
  if v_shipment.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, note, payload)
    values (v_shipment.store_id, v_shipment.order_id, 'custody_transferred', p_actor, 'dispatch', v_shipment.courier,
            v_shipment.guide_code, p_shipment_id, v_note,
            jsonb_build_object('manifest_id', p_manifest_id, 'route_label', v_manifest.route_label,
                               'route_date', v_manifest.route_date, 'driver_name', v_manifest.driver_name, 'auto', true));
  end if;
  return v_shipment.order_id;
end;
$$;
revoke all on function public.gf_add_item_in_custody(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_add_item_in_custody(uuid, uuid, uuid, uuid) to service_role;

create or replace function public.gf_guard_load_items()
returns trigger language plpgsql set search_path = public as $$
declare v_manifest dispatch_manifests%rowtype; v_required boolean;
begin
  select * into v_manifest from dispatch_manifests where id = new.manifest_id for update;
  if v_manifest.courier = 'propio' then
    select rider_pickup_check_required into v_required from logistics_providers
      where org_id = v_manifest.org_id and code = 'grupo-gf-courier';
    if tg_op = 'INSERT' then
      -- Flag apagado y carga en custodia: gf_add_item_in_custody suma a la caja del día.
      if v_manifest.state = 'in_custody' and not coalesce(v_required, true) then
        return new;
      end if;
      if v_manifest.state <> 'draft' or exists (
        select 1 from dispatch_manifest_items where manifest_id = new.manifest_id and removed_at is null
        and (office_checked_at is not null or pickup_checked_at is not null)
      ) then
        raise exception 'La carga ya inició el cotejo; no se pueden agregar paquetes.';
      end if;
    end if;
    if tg_op = 'UPDATE' and v_manifest.state in ('in_custody', 'cancelled') then
      if v_manifest.state = 'cancelled' or coalesce(v_required, true) then
        raise exception 'La carga ya está cerrada; sus cotejos son históricos.';
      end if;
      if new.removed_at is distinct from old.removed_at or new.shipment_id <> old.shipment_id then
        raise exception 'La carga ya está en poder del motorizado; sus paquetes no se retiran desde aquí.';
      end if;
    end if;
  end if;
  return new;
end;
$$;
