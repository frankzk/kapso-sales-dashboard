-- MOM §38.17: retirar y anular una salida GF que nunca salió de almacén.
-- Aplicar antes del código. No modifica pedidos ni salidas al instalarse.
-- La acción verifica sesión, RLS y orders.cancel_woo en la organización objetivo.
create or replace function public.gf_cancel_output_before_dispatch(
  p_order_id uuid, p_shipment_id uuid, p_actor uuid, p_reason text
) returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_shipment shipments%rowtype;
  v_manifest dispatch_manifests%rowtype;
  v_manifest_id uuid;
  v_current_manifest uuid;
  v_request logistics_requests%rowtype;
  v_program gf_dispatch_programs%rowtype;
  v_reason text := btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g'));
  v_total integer; v_office integer; v_pickup integer;
begin
  if p_actor is null or char_length(v_reason) not between 5 and 500 then
    raise exception 'Indica quién retira y un motivo de 5 a 500 caracteres.';
  end if;
  -- El mismo orden que el cierre/«Lo llevo»: manifiesto antes de salida.
  select manifest_id into v_manifest_id from dispatch_manifest_items
    where shipment_id=p_shipment_id and removed_at is null;
  if v_manifest_id is not null then
    select * into v_manifest from dispatch_manifests where id=v_manifest_id for update;
  end if;
  select * into v_shipment from shipments where id=p_shipment_id for update;
  if not found or v_shipment.order_id is distinct from p_order_id then
    raise exception 'Salida no encontrada en este pedido.';
  end if;
  -- Reintentar la misma anulación no duplica hechos ni toca una salida diferente.
  if v_shipment.delivery_status='anulado' and exists (
    select 1 from order_events where shipment_id=p_shipment_id and order_id=p_order_id
      and kind='route_output_cancelled' and source='grupo_gf_courier'
  ) then return p_order_id; end if;
  if v_shipment.created_via is distinct from 'grupo_gf_courier'
    or v_shipment.courier is distinct from 'propio'
    or v_shipment.delivery_status is distinct from 'pendiente'
    or v_shipment.custody_state is distinct from 'empresa'
    or v_shipment.custody_transferred_at is not null or v_shipment.dispatched_at is not null
    or v_shipment.returned_at is not null or v_shipment.reported_status is not null then
    raise exception 'Solo se retira una salida interna de Grupo GF que nunca salió de almacén. Si salió, registra su retorno.';
  end if;
  select manifest_id into v_current_manifest from dispatch_manifest_items
    where shipment_id=p_shipment_id and removed_at is null;
  if v_current_manifest is distinct from v_manifest_id then
    raise exception 'La caja cambió mientras retirabas el paquete. Recarga la ficha.';
  end if;
  if v_manifest_id is not null and (
    v_manifest.courier <> 'propio' or v_manifest.state in ('in_custody','cancelled')
    or v_manifest.custody_completed_at is not null
  ) then raise exception 'La caja ya se cerró o pasó al motorizado. Revisa su retorno.'; end if;
  -- Incluye cotejos históricos: no se borra un «Lo llevo» ni una parada.
  if exists (select 1 from dispatch_manifest_items where shipment_id=p_shipment_id and pickup_checked_at is not null)
    or exists (select 1 from delivery_stops where shipment_id=p_shipment_id) then
    raise exception 'El motorizado ya recibió el paquete o tiene una parada. Revisa Despacho y su retorno.';
  end if;
  select * into v_request from logistics_requests where shipment_id=p_shipment_id for update;
  if found and (v_request.order_id is distinct from p_order_id or v_request.store_id is distinct from v_shipment.store_id
    or v_request.status not in ('accepting','accepted','observed','scheduled','cancelled')) then
    raise exception 'La solicitud de Grupo GF ya tiene actividad de ruta. Revisa Despacho.';
  end if;
  if v_manifest_id is not null then
    update dispatch_manifest_items set removed_at=now(), removed_by=p_actor, removal_reason=v_reason
      where manifest_id=v_manifest_id and shipment_id=p_shipment_id and removed_at is null;
    insert into dispatch_events(org_id,manifest_id,shipment_id,actor,kind,payload)
      values(v_manifest.org_id,v_manifest_id,p_shipment_id,p_actor,'package_removed',
        jsonb_build_object('reason',v_reason,'source','gf_output_cancelled_before_dispatch'));
    select count(*), count(*) filter(where office_checked_at is not null),
      count(*) filter(where pickup_checked_at is not null)
      into v_total,v_office,v_pickup from dispatch_manifest_items
      where manifest_id=v_manifest_id and removed_at is null;
    -- Recalcula visibilidad sin transferir automáticamente el resto de la caja.
    update dispatch_manifests set state=case when v_total=0 then 'draft'
      when v_office<>v_total then 'office_check' when v_pickup=0 then 'ready_for_pickup' else 'pickup_check' end,
      office_completed_at=case when v_total>0 and v_office=v_total then office_completed_at else null end,
      office_completed_by=case when v_total>0 and v_office=v_total then office_completed_by else null end
      where id=v_manifest_id;
  end if;
  if v_request.id is not null and v_request.status<>'cancelled' then
    update logistics_requests set status='cancelled', observation=v_reason where id=v_request.id;
    insert into logistics_request_events(request_id,kind,status,actor,note,payload)
      values(v_request.id,'cancelled_before_dispatch','cancelled',p_actor,v_reason,
        jsonb_build_object('shipment_id',p_shipment_id,'previous_status',v_request.status));
  end if;
  -- El programa es una intención vigente, no historial. Se conserva su foto en el evento.
  if not exists(select 1 from logistics_requests where order_id=p_order_id and status<>'cancelled') then
    delete from gf_dispatch_programs where order_id=p_order_id returning * into v_program;
    if found then
      insert into order_events(store_id,order_id,kind,actor,source,courier,note,payload)
        values(v_shipment.store_id,p_order_id,'dispatch_program_cleared',p_actor,'grupo_gf_courier','propio',
          'Programa retirado al anular la salida antes del despacho: '||v_reason,
          jsonb_build_object('program',to_jsonb(v_program),'shipment_id',p_shipment_id));
    end if;
  end if;
  update shipments set delivery_status='anulado',status_category='closed',closed_at=now(),
    pickup_state=null,next_followup_at=null,updated_at=now() where id=p_shipment_id;
  insert into order_events(store_id,order_id,kind,actor,source,courier,guide_code,shipment_id,note,payload)
    values(v_shipment.store_id,p_order_id,'route_output_cancelled',p_actor,'grupo_gf_courier','propio',
      v_shipment.guide_code,p_shipment_id,'Salida retirada y anulada antes del despacho: '||v_reason,
      jsonb_build_object('reason',v_reason,'manifest_id',v_manifest_id,'request_id',v_request.id,
        'outputCode',v_shipment.output_code,'previousStatus',v_shipment.delivery_status));
  return p_order_id;
end;
$$;
revoke all on function public.gf_cancel_output_before_dispatch(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.gf_cancel_output_before_dispatch(uuid,uuid,uuid,text) to service_role;

-- Una asignación que esperaba el bloqueo de la salida no puede volver a ponerla
-- en otra caja tras anularla. El guard existente bloquea primero el manifiesto.
create or replace function public.gf_guard_cancelled_output_assignment()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v_shipment shipments%rowtype;
begin
  if new.removed_at is not null then return new; end if;
  select * into v_shipment from shipments where id=new.shipment_id for update;
  if v_shipment.created_via='grupo_gf_courier' and v_shipment.delivery_status='anulado' then
    raise exception 'Esta salida de Grupo GF está anulada; no se puede asignar a una caja.';
  end if;
  return new;
end;
$$;
revoke all on function public.gf_guard_cancelled_output_assignment() from public,anon,authenticated;
drop trigger if exists zz_gf_guard_cancelled_output_assignment on dispatch_manifest_items;
create trigger zz_gf_guard_cancelled_output_assignment before insert or update on dispatch_manifest_items
  for each row execute function public.gf_guard_cancelled_output_assignment();
