-- ============================================================================
-- 0179_gf_readd_declined_item.sql — un paquete que el motorizado no llevó
-- puede volver a la MISMA caja.
--
-- «No lo llevo» (0174/0177) retira el ítem de la caja: la fila se queda con
-- `removed_at`, `pickup_declined_*` y el motivo, y la solicitud vuelve a
-- «por asignar». Al asignarlo otra vez al mismo motorizado el mismo día,
-- `gf_add_item_in_custody` insertaba una fila nueva en la misma caja y
-- chocaba con la clave (manifest_id, shipment_id): la pantalla decía «El
-- paquete ya fue asignado a otra ruta», que era falso.
--
-- Regla: si la caja ya tiene una fila retirada para ese paquete, esa fila
-- revive (como hace mover de caja, `moveManifestItem`): vuelve a estar activa,
-- cotejada por oficina ahora y sin rechazo pendiente. El rechazo anterior no
-- se pierde: quedó en `dispatch_events` (`package_declined`) y en el
-- historial del pedido (`pickup_declined`). Un paquete ACTIVO en otra caja
-- sigue chocando con `dispatch_item_active_shipment_uniq`, que es lo que
-- de verdad significa «ya está en otra caja».
-- ============================================================================

create or replace function public.gf_add_item_in_custody(p_manifest_id uuid, p_shipment_id uuid, p_store_id uuid, p_actor uuid)
returns uuid language plpgsql set search_path = public as $$
declare
  v_manifest dispatch_manifests%rowtype;
  v_mode text;
  v_shipment shipments%rowtype;
  v_route delivery_routes%rowtype;
  v_seq integer;
  v_note text;
begin
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if not found or v_manifest.courier <> 'propio' or v_manifest.rider_id is null then
    raise exception 'La caja no es de un motorizado de Grupo GF.';
  end if;
  if v_manifest.state <> 'in_custody' then raise exception 'La caja todavía no está en custodia: usa la asignación normal.'; end if;
  v_mode := public.gf_rider_pickup_mode(v_manifest.org_id);
  if v_mode = 'exigir' then
    raise exception 'La verificación del motorizado está activada: abre una carga adicional.';
  end if;
  v_note := case when v_mode = 'confirmar'
    then 'Custodia al asignar: el motorizado confirma cada paquete al llevarlo.'
    else 'Custodia al asignar: verificación del motorizado desactivada.' end;
  select * into v_shipment from shipments where id = p_shipment_id for update;
  if not found then raise exception 'Paquete no encontrado.'; end if;
  if v_shipment.custody_state <> 'empresa' then raise exception 'El paquete ya no está en custodia de Grupo GF.'; end if;

  -- Fila nueva, o la retirada de esta misma caja que revive (0179). Revivirla
  -- es un UPDATE de `removed_at` sobre una carga en custodia, que el guardián
  -- de 0177 solo admite dentro de un retiro con `gf.withdraw = on`: aquí es el
  -- movimiento inverso, dentro de la misma transacción y con el mismo pase.
  perform set_config('gf.withdraw', 'on', true);
  insert into dispatch_manifest_items(manifest_id, shipment_id, store_id, added_by,
    office_checked_at, office_checked_by, pickup_checked_at, pickup_checked_by)
  values (p_manifest_id, p_shipment_id, p_store_id, p_actor, now(), p_actor,
          case when v_mode = 'ninguno' then now() end, case when v_mode = 'ninguno' then p_actor end)
  on conflict (manifest_id, shipment_id) do update set
    removed_at = null, removed_by = null, removal_reason = null,
    pickup_declined_at = null, pickup_declined_by = null, pickup_declined_reason = null,
    added_by = excluded.added_by, added_at = now(),
    office_checked_at = excluded.office_checked_at, office_checked_by = excluded.office_checked_by,
    pickup_checked_at = excluded.pickup_checked_at, pickup_checked_by = excluded.pickup_checked_by
  where dispatch_manifest_items.removed_at is not null;
  perform set_config('gf.withdraw', 'off', true);

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
          jsonb_build_object('source', 'grupo_gf_courier', 'in_custody', true, 'note', v_note, 'pickup_mode', v_mode));
  if v_shipment.order_id is not null then
    insert into order_events(store_id, order_id, kind, occurred_at, actor, source, courier, guide_code, shipment_id, note, payload)
    values (v_shipment.store_id, v_shipment.order_id, 'custody_transferred', now(), p_actor, 'dispatch', v_shipment.courier,
            v_shipment.guide_code, p_shipment_id, v_note,
            jsonb_build_object('manifest_id', p_manifest_id, 'route_date', v_manifest.route_date, 'route_kind', v_manifest.kind,
                               'driver_name', v_manifest.driver_name, 'auto', true, 'added_in_custody', true, 'pickup_mode', v_mode));
  end if;
  return v_shipment.order_id;
end;
$$;
revoke all on function public.gf_add_item_in_custody(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_add_item_in_custody(uuid, uuid, uuid, uuid) to service_role;
