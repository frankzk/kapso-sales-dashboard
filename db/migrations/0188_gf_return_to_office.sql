-- 0188_gf_return_to_office.sql — «Recibir en oficina» un paquete no entregado
-- (MOM §29.13, 22-09-2026).
--
-- Un paquete que el motorizado reportó «No entregado» seguía dentro de su caja
-- y bajo su custodia: no volvía a la cola de «Desde la lista» y nadie podía
-- sacarlo, porque la parada ya tenía reporte y, en modo `exigir`, el guard de
-- ítems prohibía cualquier cambio sobre una caja en custodia. Aquí:
--
--   1. El guard admite el retiro cuando la transacción lo marca con
--      `gf.withdraw = on` también en `exigir` (solo lo hacen los RPC de
--      retiro, nunca un UPDATE suelto).
--   2. `gf_return_to_office` retira el ítem con rastro, devuelve la custodia a
--      la empresa y la solicitud a «por asignar». La parada reportada NO se
--      borra: es la evidencia del intento y cuenta en la liquidación del día.
--
-- Aplicar a mano antes de desplegar el código que la usa (DEPLOY.md).

create or replace function public.gf_guard_load_items()
returns trigger language plpgsql set search_path = public as $$
declare v_manifest dispatch_manifests%rowtype; v_mode text; v_withdraw boolean;
begin
  select * into v_manifest from dispatch_manifests where id = new.manifest_id for update;
  if v_manifest.courier = 'propio' then
    v_mode := public.gf_rider_pickup_mode(v_manifest.org_id);
    v_withdraw := coalesce(current_setting('gf.withdraw', true), '') = 'on';
    if tg_op = 'INSERT' then
      if v_manifest.state = 'in_custody' and v_mode <> 'exigir' then
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
      if v_manifest.state = 'cancelled' or (v_mode = 'exigir' and not v_withdraw) then
        raise exception 'La carga ya está cerrada; sus cotejos son históricos.';
      end if;
      if (new.removed_at is distinct from old.removed_at or new.shipment_id <> old.shipment_id)
         and not v_withdraw then
        raise exception 'La carga ya está en poder del motorizado; sus paquetes no se retiran desde aquí.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.gf_return_to_office(p_item_id uuid, p_actor uuid)
returns uuid language plpgsql set search_path = public as $$
declare
  v_item dispatch_manifest_items%rowtype;
  v_manifest dispatch_manifests%rowtype;
  v_shipment shipments%rowtype;
  v_stop delivery_stops%rowtype;
  v_reason text;
  v_rider text;
begin
  select * into v_item from dispatch_manifest_items where id = p_item_id for update;
  if not found or v_item.removed_at is not null then raise exception 'Ese paquete ya no está en la caja.'; end if;
  select * into v_manifest from dispatch_manifests where id = v_item.manifest_id for update;
  if v_manifest.courier <> 'propio' then raise exception 'Solo para cajas de Grupo GF.'; end if;
  select * into v_stop from delivery_stops
    where shipment_id = v_item.shipment_id and dispatch_manifest_id = v_item.manifest_id
    order by reported_at desc nulls last limit 1 for update;
  if not found or v_stop.status <> 'no_entregado' then
    raise exception 'Solo se recibe en oficina un paquete reportado «No entregado».';
  end if;
  select * into v_shipment from shipments where id = v_item.shipment_id for update;
  v_rider := coalesce(v_manifest.driver_name, 'el motorizado');
  v_reason := 'No entregado por ' || v_rider || coalesce(' (' || v_stop.outcome_reason || ')', '') || ': recibido en oficina';

  perform set_config('gf.withdraw', 'on', true);
  update dispatch_manifest_items
     set removed_at = now(), removed_by = p_actor, removal_reason = left(v_reason, 300)
   where id = p_item_id;
  perform set_config('gf.withdraw', 'off', true);

  update shipments
     set custody_state = 'empresa', custody_transferred_at = null, custody_transferred_by = null, dispatched_at = null
   where id = v_item.shipment_id;

  update logistics_requests
     set status = 'accepted', observation = left(v_reason, 300)
   where shipment_id = v_item.shipment_id and status = 'scheduled';

  insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
  values (v_manifest.org_id, v_item.manifest_id, v_item.shipment_id, p_actor, 'returned_to_office',
          jsonb_build_object('stop_id', v_stop.id, 'outcome_reason', v_stop.outcome_reason));
  if v_shipment.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (v_shipment.store_id, v_shipment.order_id, 'returned_to_office', p_actor, 'dispatch', 'propio',
            v_shipment.guide_code, v_item.shipment_id, v_stop.outcome_reason,
            v_reason || '. Vuelve a «por asignar».',
            jsonb_build_object('manifest_id', v_item.manifest_id, 'rider_id', v_manifest.rider_id,
                               'route_date', v_manifest.route_date, 'stop_id', v_stop.id));
  end if;
  return v_shipment.order_id;
end;
$$;

revoke all on function public.gf_return_to_office(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_return_to_office(uuid, uuid) to service_role;
