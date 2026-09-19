-- ============================================================================
-- 0174_manifest_item_not_picked.sql — «No lo recojo»: el motorizado rechaza un
-- paquete de su caja al recibirla (MOM §29.13).
--
-- Antes la recepción era todo o nada: la carga pasaba a custodia solo con el
-- 100 % de los paquetes escaneados por el motorizado, y si uno no estaba en la
-- caja, estaba dañado o no cabía, el motorizado llamaba y el supervisor lo
-- retiraba desde otra pantalla tecleando el motivo. El rastro decía «retirado»
-- y no «el motorizado no lo recogió».
--
-- Ahora el motorizado lo dice desde su teléfono con un motivo corto. El rechazo
-- se guarda en columnas propias (quién, cuándo, por qué) Y retira el paquete de
-- la carga con `removed_at`, por dos razones: el finalizador y el trigger que
-- crea las paradas ya cuentan solo lo activo (así el 100 % se calcula sobre lo
-- aceptado sin tocar `finalize_dispatch_manifest`), y el índice único de
-- salida activa se libera para que el supervisor lo asigne a otro motorizado
-- el mismo día. La solicitud logística vuelve a `accepted` con observación:
-- reaparece en «por asignar».
-- ============================================================================
alter table dispatch_manifest_items
  add column if not exists pickup_declined_at     timestamptz,
  add column if not exists pickup_declined_reason text,
  add column if not exists pickup_declined_by     uuid references auth.users(id) on delete set null;

create index if not exists dispatch_items_declined_idx
  on dispatch_manifest_items(manifest_id) where pickup_declined_at is not null;

create or replace function public.gf_rider_decline(p_manifest_id uuid, p_shipment_id uuid, p_reason text, p_actor uuid)
returns uuid[] language plpgsql set search_path = public as $$
declare
  v_manifest dispatch_manifests%rowtype;
  v_rider riders%rowtype;
  v_item dispatch_manifest_items%rowtype;
  v_shipment shipments%rowtype;
  v_reason text := left(trim(coalesce(p_reason, '')), 200);
  v_active integer;
  v_pending integer;
begin
  if length(v_reason) < 2 then raise exception 'Di por qué no lo recoges.'; end if;
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if not found or v_manifest.courier <> 'propio' then raise exception 'La carga no pertenece a tu cuenta.'; end if;
  select * into v_rider from riders where id = v_manifest.rider_id and user_id = p_actor and active;
  if not found then raise exception 'La carga no pertenece a tu cuenta.'; end if;
  if v_manifest.state not in ('ready_for_pickup', 'pickup_check') then
    raise exception 'La oficina debe completar primero la verificación de la caja.';
  end if;
  select * into v_item from dispatch_manifest_items
    where manifest_id = p_manifest_id and shipment_id = p_shipment_id and removed_at is null for update;
  if not found then raise exception 'Ese paquete ya no está en tu caja.'; end if;
  if v_item.pickup_checked_at is not null then raise exception 'Ya recibiste ese paquete; avisa al supervisor para retirarlo.'; end if;
  select * into v_shipment from shipments where id = p_shipment_id;

  update dispatch_manifest_items
     set pickup_declined_at = now(), pickup_declined_by = p_actor, pickup_declined_reason = v_reason,
         removed_at = now(), removed_by = p_actor,
         removal_reason = 'No recogido por ' || v_rider.full_name || ': ' || v_reason
   where id = v_item.id;

  insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
  values (v_manifest.org_id, p_manifest_id, p_shipment_id, p_actor, 'pickup_declined',
          jsonb_build_object('reason', v_reason, 'rider_id', v_rider.id));
  if v_shipment.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (v_shipment.store_id, v_shipment.order_id, 'pickup_declined', p_actor, 'reparto', 'propio',
            v_shipment.guide_code, p_shipment_id, v_reason,
            'No recogido por ' || v_rider.full_name || ' al recibir su caja: ' || v_reason,
            jsonb_build_object('manifest_id', p_manifest_id, 'rider_id', v_rider.id, 'route_date', v_manifest.route_date));
  end if;
  -- La solicitud vuelve a «por asignar» con la observación a la vista.
  update logistics_requests
     set status = 'accepted', observation = 'No recogido por ' || v_rider.full_name || ': ' || v_reason
   where shipment_id = p_shipment_id and status = 'scheduled';

  select count(*), count(*) filter (where pickup_checked_at is null)
    into v_active, v_pending
    from dispatch_manifest_items where manifest_id = p_manifest_id and removed_at is null;
  if v_active = 0 then
    -- Caja vacía tras rechazar todo: vuelve a borrador para que el supervisor la rearme o la cancele.
    update dispatch_manifests set state = 'draft', office_completed_at = null, office_completed_by = null where id = p_manifest_id;
    return '{}'::uuid[];
  end if;
  if v_pending = 0 then
    return public.finalize_dispatch_manifest(p_manifest_id, p_actor);
  end if;
  return '{}'::uuid[];
end;
$$;
revoke all on function public.gf_rider_decline(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.gf_rider_decline(uuid, uuid, text, uuid) to service_role;
