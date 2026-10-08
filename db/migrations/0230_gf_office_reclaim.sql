-- 0230_gf_office_reclaim.sql — «Mover» un paquete que está en la oficina aunque
-- su caja ya esté en poder del motorizado.
--
-- QUÉ PASABA (05-10-2026). Con verificación «exigir», un paquete que el
-- motorizado confirmó al recibir su caja no se puede retirar desde Despacho del
-- día: `gf_withdraw_in_custody` lo rechaza a propósito, para que nadie le saque
-- en silencio un paquete de su cuadre. Pero #KP138381 estaba en la oficina, en la
-- mano de quien lo escaneaba para la caja de Alexis, y seguía en la de Yhoni: el
-- «Mover» fallaba y el único camino eran tres pasos (reportarlo «No entregado»,
-- «Recibir en oficina» y volver a escanearlo).
--
-- QUÉ CAMBIA. Escanear el paquete en la oficina es la prueba de que no está en
-- la calle. `gf_office_reclaim` lo saca de la caja del motorizado con ese
-- motivo dicho —«recuperado en oficina»—, borra su parada pendiente y devuelve la
-- custodia a la empresa, listo para entrar en la caja del otro motorizado. Solo
-- con la parada PENDIENTE: una ya reportada (entregada o no) se resuelve por su
-- reporte, nunca desde aquí. Queda en el historial del pedido y de la caja, con
-- quién lo hizo y a quién va.

create or replace function public.gf_office_reclaim(
  p_manifest_id uuid,
  p_shipment_id uuid,
  p_reason text,
  p_actor uuid,
  p_moved_to_rider uuid
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_item dispatch_manifest_items%rowtype;
  v_manifest dispatch_manifests%rowtype;
  v_shipment shipments%rowtype;
  v_stop_status text;
  v_rider text;
  v_target text;
  v_reason text := left(trim(coalesce(p_reason, '')), 200);
  v_note text;
begin
  if length(v_reason) < 3 then raise exception 'Escribe el motivo.'; end if;
  select * into v_item from dispatch_manifest_items
    where manifest_id = p_manifest_id and shipment_id = p_shipment_id and removed_at is null
    for update;
  if not found then raise exception 'Ese paquete ya no está en la caja.'; end if;
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if v_manifest.courier <> 'propio' then raise exception 'Solo para cajas de Grupo GF.'; end if;
  if v_manifest.state <> 'in_custody' then raise exception 'La caja no está en poder del motorizado.'; end if;

  select status into v_stop_status from delivery_stops
    where shipment_id = v_item.shipment_id and dispatch_manifest_id = p_manifest_id
    order by reported_at desc nulls last limit 1 for update;
  if v_stop_status is not null and v_stop_status <> 'pendiente' then
    raise exception 'Esa parada ya fue reportada: se resuelve por su reporte, no desde aquí.';
  end if;

  select * into v_shipment from shipments where id = v_item.shipment_id for update;
  v_rider := coalesce(v_manifest.driver_name, 'el motorizado');
  select full_name into v_target from riders where id = p_moved_to_rider;
  v_note := 'Escaneado en oficina: el paquete no salió con ' || v_rider || '. Se mueve a '
    || coalesce(v_target, 'otro motorizado') || ': ' || v_reason;

  perform set_config('gf.withdraw', 'on', true);
  update dispatch_manifest_items
     set removed_at = now(), removed_by = p_actor,
         removal_reason = left('Recuperado en oficina, movido a ' || coalesce(v_target, 'otro motorizado') || ': ' || v_reason, 300)
   where id = v_item.id;
  perform set_config('gf.withdraw', 'off', true);

  delete from delivery_stops
   where shipment_id = v_item.shipment_id and dispatch_manifest_id = p_manifest_id and status = 'pendiente';

  update shipments
     set custody_state = 'empresa', custody_transferred_at = null, custody_transferred_by = null, dispatched_at = null
   where id = v_item.shipment_id;

  update logistics_requests
     set status = 'accepted', observation = left(v_note, 300)
   where shipment_id = v_item.shipment_id and status = 'scheduled';

  insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
  values (v_manifest.org_id, p_manifest_id, v_item.shipment_id, p_actor, 'reclaimed_in_office',
          jsonb_build_object('reason', v_reason, 'moved_to', p_moved_to_rider,
                             'pickup_checked_at', v_item.pickup_checked_at, 'in_custody', true));
  if v_shipment.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (v_shipment.store_id, v_shipment.order_id, 'returned_to_office', p_actor, 'dispatch', 'propio',
            v_shipment.guide_code, v_item.shipment_id, v_reason, v_note,
            jsonb_build_object('manifest_id', p_manifest_id, 'rider_id', v_manifest.rider_id,
                               'route_date', v_manifest.route_date, 'moved_to', p_moved_to_rider,
                               'reclaimed_in_office', true));
  end if;
  return v_shipment.order_id;
end;
$$;

revoke all on function public.gf_office_reclaim(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_office_reclaim(uuid, uuid, text, uuid, uuid) to service_role;
