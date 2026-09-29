-- 0206_gf_return_rejected_reprograms.sql — «Recibir en oficina» trata el
-- RECHAZO como cualquier otro «No entregado» (MOM v1.23, 30-09-2026).
--
-- La 0189 recibía un «Rechazó el pedido» como DEVUELTO (`custody_state =
-- devuelto`, `returned_at`) y cancelaba la solicitud del courier: la venta se
-- daba por terminada y el pedido iba a «Por cerrar». Regla del owner: en Lima
-- lo que no se entrega pasa a «Por reprogramar Lima»; solo la entrega lleva a
-- cerrar y solo la anulación en Shopify termina la venta. Así que el rechazo
-- vuelve a «por asignar» con su caja en la oficina, igual que los demás
-- motivos de la 0188.
--
-- Solo cambia la función: las salidas que la 0189 ya recibió como devueltas no
-- se tocan (el Master las lleva a «Por reprogramar Lima» con el inventario como
-- razón mientras el pedido siga vivo en Shopify).
--
-- Aplicar a mano antes de desplegar el código (DEPLOY.md).

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

  -- Cualquier motivo, rechazo incluido: la caja vuelve a la empresa y la
  -- solicitud queda aceptada para el siguiente intento.
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
