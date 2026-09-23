-- ============================================================================
-- 0185_provider_rider_pickup_mode.sql — «Lo llevo»: el motorizado confirma
-- cada paquete al sacarlo del almacén, sin que nada lo bloquee (MOM §29.13).
--
-- El booleano de 0183 (`rider_pickup_check_required`) solo sabía decir «exigir
-- la verificación antes de ver la ruta» o «nada». La operación necesita un
-- tercer modo: el supervisor asigna y la ruta aparece al instante, pero el
-- motorizado escanea cada pedido cuando lo mete en la caja de la moto («lo
-- llevo»); lo asignado y no escaneado es «no se lo llevó» y el supervisor lo
-- reasigna. Por eso el booleano se reemplaza por un texto de tres valores:
--
--   `logistics_providers.rider_pickup_mode`
--     'exigir'    = como 0159/0174: oficina coteja, el motorizado recibe su
--                   caja al 100 % de los aceptados y recién entonces ve la ruta.
--     'confirmar' = asignar entrega la custodia y crea las paradas; cada parada
--                   nace «por confirmar». El motorizado dice «Lo llevo»
--                   (gf_rider_confirm_pickup → pickup_checked_at) o «No lo
--                   llevo» con motivo (gf_rider_decline admite la caja en
--                   custodia: retira el ítem, borra la parada pendiente y la
--                   solicitud vuelve a «por asignar»). Una parada sin confirmar
--                   se puede entregar igual: el reporte guarda
--                   `delivery_stops.pickup_confirmed = false` y deja rastro.
--                   El supervisor puede quitar o mover lo no confirmado
--                   (gf_supervisor_withdraw).
--     'ninguno'   = como 0183/0176 con el flag en false: basta con asignar y
--                   no se pide nada más.
--
-- Migración de datos: true → 'exigir', false → 'ninguno'. Producción queda en
-- 'confirmar' por decisión de la operación (19-09-2026), con un UPDATE aparte:
--   update logistics_providers set rider_pickup_mode = 'confirmar' where code = 'grupo-gf-courier';
--   update logistics_providers set rider_pickup_mode = 'exigir'    where code = 'grupo-gf-courier';
--   update logistics_providers set rider_pickup_mode = 'ninguno'   where code = 'grupo-gf-courier';
-- Se lee en un solo sitio en SQL (gf_rider_pickup_mode) y en uno en código
-- (riderPickupMode, lib/grupo-gf-courier-route-access.ts).
-- ============================================================================
alter table logistics_providers
  add column if not exists rider_pickup_mode text not null default 'confirmar';
alter table logistics_providers drop constraint if exists logistics_providers_rider_pickup_mode_check;
alter table logistics_providers
  add constraint logistics_providers_rider_pickup_mode_check
  check (rider_pickup_mode in ('exigir', 'confirmar', 'ninguno'));

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'logistics_providers'
               and column_name = 'rider_pickup_check_required') then
    update logistics_providers
       set rider_pickup_mode = case when rider_pickup_check_required then 'exigir' else 'ninguno' end;
    alter table logistics_providers drop column rider_pickup_check_required;
  end if;
end;
$$;

-- Si al reportar la entrega el motorizado había confirmado «lo llevo». Null en
-- paradas sin caja de despacho o reportadas antes de 0185.
alter table delivery_stops
  add column if not exists pickup_confirmed boolean;
comment on column delivery_stops.pickup_confirmed is
  'Al reportar la entrega, si el ítem de la caja tenía pickup_checked_at (modo confirmar). Null: sin caja o anterior a 0185.';

-- El único lector del modo en SQL. Sin proveedor se asume ''exigir'' (lo de
-- siempre), igual que 0183 asumía true.
create or replace function public.gf_rider_pickup_mode(p_org_id uuid)
returns text language sql stable set search_path = public as $$
  select coalesce((select rider_pickup_mode from logistics_providers
                    where org_id = p_org_id and code = 'grupo-gf-courier'), 'exigir');
$$;
revoke all on function public.gf_rider_pickup_mode(uuid) from public, anon;

-- ----------------------------------------------------------------------------
-- Custodia al asignar (0183), ahora para 'confirmar' y 'ninguno'.
-- ----------------------------------------------------------------------------
create or replace function public.gf_assign_custody(p_manifest_id uuid, p_actor uuid)
returns uuid[] language plpgsql set search_path = public as $$
declare
  v_manifest dispatch_manifests%rowtype;
  v_mode text;
  v_total integer;
  v_order_ids uuid[];
  v_note text;
begin
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if not found then raise exception 'Caja no encontrada.'; end if;
  if v_manifest.courier <> 'propio' or v_manifest.rider_id is null then
    raise exception 'La custodia al asignar solo aplica a cajas de motorizados de Grupo GF.';
  end if;
  v_mode := public.gf_rider_pickup_mode(v_manifest.org_id);
  if v_mode = 'exigir' then
    raise exception 'La verificación del motorizado está activada: la custodia cambia al recibir la caja.';
  end if;
  v_note := case when v_mode = 'confirmar'
    then 'Custodia al asignar: el motorizado confirma cada paquete al llevarlo.'
    else 'Custodia al asignar: verificación del motorizado desactivada.' end;
  if v_manifest.state = 'in_custody' then
    return coalesce((select array_agg(distinct s.order_id) filter (where s.order_id is not null)
      from dispatch_manifest_items i join shipments s on s.id = i.shipment_id
      where i.manifest_id = p_manifest_id and i.removed_at is null), '{}'::uuid[]);
  end if;
  if v_manifest.state = 'cancelled' then raise exception 'La caja está cancelada.'; end if;
  select count(*) into v_total from dispatch_manifest_items where manifest_id = p_manifest_id and removed_at is null;
  if v_total = 0 then raise exception 'La caja no tiene paquetes.'; end if;

  select coalesce(array_agg(distinct s.order_id) filter (where s.order_id is not null), '{}'::uuid[])
    into v_order_ids
    from dispatch_manifest_items i join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id and i.removed_at is null;

  update shipments s
     set custody_state = 'courier', custody_transferred_at = now(), custody_transferred_by = p_actor,
         dispatched_at = coalesce(s.dispatched_at, now())
    from dispatch_manifest_items i
   where i.manifest_id = p_manifest_id and i.removed_at is null and s.id = i.shipment_id;

  update dispatch_manifests
     set state = 'in_custody', custody_completed_at = now(), custody_completed_by = p_actor
   where id = p_manifest_id;

  insert into order_events (store_id, order_id, kind, occurred_at, actor, source, courier, guide_code, shipment_id, note, payload)
  select s.store_id, s.order_id, 'custody_transferred', now(), p_actor, 'dispatch', s.courier, s.guide_code, s.id, v_note,
         jsonb_build_object('manifest_id', p_manifest_id, 'route_label', v_manifest.route_label, 'route_date', v_manifest.route_date,
                            'route_kind', v_manifest.kind, 'driver_name', v_manifest.driver_name, 'auto', true, 'pickup_mode', v_mode)
    from dispatch_manifest_items i join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id and i.removed_at is null and s.order_id is not null;

  insert into dispatch_events (org_id, manifest_id, actor, kind, payload)
  values (v_manifest.org_id, p_manifest_id, p_actor, 'custody_transferred',
          jsonb_build_object('packages', v_total, 'route_kind', v_manifest.kind, 'driver_name', v_manifest.driver_name, 'auto', true, 'note', v_note, 'pickup_mode', v_mode));
  return v_order_ids;
end;
$$;
revoke all on function public.gf_assign_custody(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_assign_custody(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Una carga por motorizado y día (0184), ahora para 'confirmar' y 'ninguno'.
-- ----------------------------------------------------------------------------
create or replace function public.gf_dispatch_load_open(p_org_id uuid, p_rider_id uuid, p_day date, p_actor uuid)
returns uuid language plpgsql set search_path = public as $$
declare v_load dispatch_manifests%rowtype; v_route_status text;
begin
  if public.gf_rider_pickup_mode(p_org_id) = 'exigir' then
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

-- En 'ninguno' el paquete sumado entra cotejado y recibido (como 0184); en
-- 'confirmar' entra cotejado por oficina y «por confirmar» por el motorizado.
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

  insert into dispatch_manifest_items(manifest_id, shipment_id, store_id, added_by,
    office_checked_at, office_checked_by, pickup_checked_at, pickup_checked_by)
  values (p_manifest_id, p_shipment_id, p_store_id, p_actor, now(), p_actor,
          case when v_mode = 'ninguno' then now() end, case when v_mode = 'ninguno' then p_actor end);

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

-- ----------------------------------------------------------------------------
-- Guard de ítems: en 'confirmar' y 'ninguno' se admiten los cotejos sobre una
-- caja en custodia; la pertenencia solo la cambian los RPC de retiro (marcan
-- la transacción con gf.withdraw = on), nunca un UPDATE suelto.
-- ----------------------------------------------------------------------------
create or replace function public.gf_guard_load_items()
returns trigger language plpgsql set search_path = public as $$
declare v_manifest dispatch_manifests%rowtype; v_mode text;
begin
  select * into v_manifest from dispatch_manifests where id = new.manifest_id for update;
  if v_manifest.courier = 'propio' then
    v_mode := public.gf_rider_pickup_mode(v_manifest.org_id);
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
      if v_manifest.state = 'cancelled' or v_mode = 'exigir' then
        raise exception 'La carga ya está cerrada; sus cotejos son históricos.';
      end if;
      if (new.removed_at is distinct from old.removed_at or new.shipment_id <> old.shipment_id)
         and coalesce(current_setting('gf.withdraw', true), '') <> 'on' then
        raise exception 'La carga ya está en poder del motorizado; sus paquetes no se retiran desde aquí.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Retiro de un paquete de una caja en custodia (modo 'confirmar'). Lo comparten
-- «No lo llevo» del motorizado y «Quitar / Mover» del supervisor: el ítem sale
-- con rastro, la custodia vuelve a la empresa, la parada pendiente se borra y
-- la solicitud vuelve a «por asignar». Interno: sin grant.
-- ----------------------------------------------------------------------------
create or replace function public.gf_withdraw_in_custody(p_item_id uuid, p_reason text, p_actor uuid, p_kind text, p_note text, p_payload jsonb)
returns uuid language plpgsql set search_path = public as $$
declare
  v_item dispatch_manifest_items%rowtype;
  v_manifest dispatch_manifests%rowtype;
  v_shipment shipments%rowtype;
  v_stop_status text;
begin
  select * into v_item from dispatch_manifest_items where id = p_item_id for update;
  if not found or v_item.removed_at is not null then raise exception 'Ese paquete ya no está en la caja.'; end if;
  select * into v_manifest from dispatch_manifests where id = v_item.manifest_id for update;
  if v_manifest.state <> 'in_custody' then raise exception 'La caja no está en custodia.'; end if;
  if public.gf_rider_pickup_mode(v_manifest.org_id) <> 'confirmar' then
    raise exception 'La caja ya está en poder del motorizado; sus paquetes no se retiran desde aquí.';
  end if;
  if v_item.pickup_checked_at is not null then
    raise exception 'El motorizado ya confirmó que lo lleva; solo se puede reportar como parada.';
  end if;
  select * into v_shipment from shipments where id = v_item.shipment_id for update;

  select status into v_stop_status from delivery_stops
    where shipment_id = v_item.shipment_id and dispatch_manifest_id = v_item.manifest_id
    limit 1 for update;
  if v_stop_status is not null and v_stop_status <> 'pendiente' then
    raise exception 'Esa parada ya fue reportada; no se puede retirar de la caja.';
  end if;

  perform set_config('gf.withdraw', 'on', true);
  update dispatch_manifest_items
     set removed_at = now(), removed_by = p_actor, removal_reason = left(p_reason, 300)
   where id = p_item_id;
  perform set_config('gf.withdraw', 'off', true);

  delete from delivery_stops
   where shipment_id = v_item.shipment_id and dispatch_manifest_id = v_item.manifest_id and status = 'pendiente';

  update shipments
     set custody_state = 'empresa', custody_transferred_at = null, custody_transferred_by = null, dispatched_at = null
   where id = v_item.shipment_id;

  update logistics_requests
     set status = 'accepted', observation = left(p_reason, 300)
   where shipment_id = v_item.shipment_id and status = 'scheduled';

  insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
  values (v_manifest.org_id, v_item.manifest_id, v_item.shipment_id, p_actor, p_kind,
          coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('reason', p_reason, 'in_custody', true));
  if v_shipment.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (v_shipment.store_id, v_shipment.order_id, p_kind, p_actor, 'dispatch', 'propio',
            v_shipment.guide_code, v_item.shipment_id, p_reason, p_note,
            coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('manifest_id', v_item.manifest_id, 'rider_id', v_manifest.rider_id,
                                                                    'route_date', v_manifest.route_date, 'in_custody', true));
  end if;
  return v_shipment.order_id;
end;
$$;
revoke all on function public.gf_withdraw_in_custody(uuid, text, uuid, text, text, jsonb) from public, anon, authenticated;

-- «Quitar» / «Mover a…» de un paquete sin confirmar desde Despacho del día.
create or replace function public.gf_supervisor_withdraw(p_manifest_id uuid, p_shipment_id uuid, p_reason text, p_actor uuid, p_moved_to_rider uuid default null)
returns uuid language plpgsql set search_path = public as $$
declare v_item dispatch_manifest_items%rowtype; v_rider_name text; v_target_name text; v_reason text := left(trim(coalesce(p_reason, '')), 200);
begin
  if length(v_reason) < 3 then raise exception 'Escribe el motivo.'; end if;
  select * into v_item from dispatch_manifest_items
    where manifest_id = p_manifest_id and shipment_id = p_shipment_id and removed_at is null;
  if not found then raise exception 'Ese paquete ya no está en la caja.'; end if;
  select r.full_name into v_rider_name from dispatch_manifests m join riders r on r.id = m.rider_id where m.id = p_manifest_id;
  if p_moved_to_rider is not null then
    select full_name into v_target_name from riders where id = p_moved_to_rider;
    return public.gf_withdraw_in_custody(v_item.id, 'Movido a ' || coalesce(v_target_name, 'otro motorizado') || ': ' || v_reason, p_actor,
      'package_removed', 'Retirado sin confirmar de la caja de ' || coalesce(v_rider_name, 'el motorizado') || ' para moverlo a ' || coalesce(v_target_name, 'otro motorizado') || ': ' || v_reason,
      jsonb_build_object('moved_to', p_moved_to_rider, 'unconfirmed', true));
  end if;
  return public.gf_withdraw_in_custody(v_item.id, v_reason, p_actor,
    'package_removed', 'Retirado sin confirmar de la caja de ' || coalesce(v_rider_name, 'el motorizado') || ': ' || v_reason,
    jsonb_build_object('unconfirmed', true));
end;
$$;
revoke all on function public.gf_supervisor_withdraw(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_supervisor_withdraw(uuid, uuid, text, uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- «Lo llevo»: el motorizado confirma un paquete de su caja en custodia.
-- Idempotente. Devuelve el pedido para recalcular el Master.
-- ----------------------------------------------------------------------------
create or replace function public.gf_rider_confirm_pickup(p_item_id uuid, p_actor uuid)
returns uuid language plpgsql set search_path = public as $$
declare v_item dispatch_manifest_items%rowtype; v_manifest dispatch_manifests%rowtype; v_rider riders%rowtype; v_shipment shipments%rowtype;
begin
  select * into v_item from dispatch_manifest_items where id = p_item_id for update;
  if not found or v_item.removed_at is not null then raise exception 'Ese paquete ya no está en tu caja.'; end if;
  select * into v_manifest from dispatch_manifests where id = v_item.manifest_id for update;
  if v_manifest.courier <> 'propio' then raise exception 'La caja no pertenece a tu cuenta.'; end if;
  select * into v_rider from riders where id = v_manifest.rider_id and user_id = p_actor and active;
  if not found then raise exception 'La caja no pertenece a tu cuenta.'; end if;
  if v_manifest.state <> 'in_custody' then
    raise exception 'Esta caja se recibe escaneando desde «Recibir mi caja».';
  end if;
  if public.gf_rider_pickup_mode(v_manifest.org_id) = 'exigir' then
    raise exception 'Esta caja se recibe escaneando desde «Recibir mi caja».';
  end if;
  select * into v_shipment from shipments where id = v_item.shipment_id;
  if v_item.pickup_checked_at is not null then return v_shipment.order_id; end if;

  update dispatch_manifest_items set pickup_checked_at = now(), pickup_checked_by = p_actor where id = p_item_id;
  insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
  values (v_manifest.org_id, v_item.manifest_id, v_item.shipment_id, p_actor, 'pickup_checked',
          jsonb_build_object('rider_id', v_rider.id, 'in_custody', true));
  if v_shipment.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, note, payload)
    values (v_shipment.store_id, v_shipment.order_id, 'pickup_checked', p_actor, 'reparto', 'propio',
            v_shipment.guide_code, v_item.shipment_id, 'Lo lleva ' || v_rider.full_name || '.',
            jsonb_build_object('manifest_id', v_item.manifest_id, 'rider_id', v_rider.id, 'route_date', v_manifest.route_date, 'in_custody', true));
  end if;
  return v_shipment.order_id;
end;
$$;
revoke all on function public.gf_rider_confirm_pickup(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_rider_confirm_pickup(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- «No lo llevo» (0182) ahora también sobre la caja en custodia en 'confirmar'.
-- ----------------------------------------------------------------------------
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
  v_order uuid;
begin
  if length(v_reason) < 2 then raise exception 'Di por qué no lo llevas.'; end if;
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if not found or v_manifest.courier <> 'propio' then raise exception 'La carga no pertenece a tu cuenta.'; end if;
  select * into v_rider from riders where id = v_manifest.rider_id and user_id = p_actor and active;
  if not found then raise exception 'La carga no pertenece a tu cuenta.'; end if;

  -- Modo 'confirmar': la caja ya salió con custodia; «No lo llevo» retira el
  -- paquete, borra su parada pendiente y lo devuelve a «por asignar».
  if v_manifest.state = 'in_custody' then
    if public.gf_rider_pickup_mode(v_manifest.org_id) <> 'confirmar' then
      raise exception 'La caja ya está en tu poder; avisa al supervisor para retirar un paquete.';
    end if;
    select * into v_item from dispatch_manifest_items
      where manifest_id = p_manifest_id and shipment_id = p_shipment_id and removed_at is null;
    if not found then raise exception 'Ese paquete ya no está en tu caja.'; end if;
    if v_item.pickup_checked_at is not null then raise exception 'Ya confirmaste que lo llevas; avisa al supervisor para retirarlo.'; end if;
    update dispatch_manifest_items
       set pickup_declined_at = now(), pickup_declined_by = p_actor, pickup_declined_reason = v_reason
     where id = v_item.id;
    v_order := public.gf_withdraw_in_custody(v_item.id, 'No lo llevó ' || v_rider.full_name || ': ' || v_reason, p_actor,
      'pickup_declined', 'No lo llevó ' || v_rider.full_name || ': ' || v_reason,
      jsonb_build_object('rider_id', v_rider.id, 'declined_reason', v_reason));
    return case when v_order is null then '{}'::uuid[] else array[v_order] end;
  end if;

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
            'No lo llevó ' || v_rider.full_name || ' al recibir su caja: ' || v_reason,
            jsonb_build_object('manifest_id', p_manifest_id, 'rider_id', v_rider.id, 'route_date', v_manifest.route_date));
  end if;
  update logistics_requests
     set status = 'accepted', observation = 'No recogido por ' || v_rider.full_name || ': ' || v_reason
   where shipment_id = p_shipment_id and status = 'scheduled';

  select count(*), count(*) filter (where pickup_checked_at is null)
    into v_active, v_pending
    from dispatch_manifest_items where manifest_id = p_manifest_id and removed_at is null;
  if v_active = 0 then
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
