-- 0292: la hoja revisada permite incluir paquetes sin reporte de una caja anterior del mismo motorizado.
-- No cambia gf_carry_over ni toca ninguna fila al instalar. Solo service_role.
-- Un pendiente que continuó en otra ruta conserva su reporte desconocido.
-- El marcador lo vuelve historia sin inventar un no-entregado ni perder su salida.
alter table public.delivery_stops
  add column if not exists notebook_carried_to_route_id uuid references public.delivery_routes(id),
  add column if not exists notebook_carried_import_id uuid references public.rider_notebook_imports(id);
alter table public.delivery_stops add constraint delivery_stops_notebook_carried_ck check (
  (notebook_carried_to_route_id is null and notebook_carried_import_id is null)
  or (notebook_carried_to_route_id is not null and notebook_carried_import_id is not null
      and status='pendiente' and notebook_carried_to_route_id<>route_id)
);
drop index if exists public.delivery_stop_shipment_open_uniq;
create unique index delivery_stop_shipment_open_uniq on public.delivery_stops(shipment_id)
  where shipment_id is not null and status='pendiente' and notebook_carried_to_route_id is null;

create or replace function public.gf_guard_notebook_carried_stop()
returns trigger language plpgsql security invoker set search_path=public as $guard$
begin
  if old.notebook_carried_to_route_id is not null then
    if (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') then
      raise exception 'El paquete continuó en otra ruta: su parada anterior es histórica y no se reporta de nuevo.';
    end if;
  elsif new.notebook_carried_to_route_id is not null or new.notebook_carried_import_id is not null then
    if current_user not in ('postgres','service_role')
       or coalesce(current_setting('gf.notebook_import',true),'')<>new.notebook_carried_import_id::text
       or (to_jsonb(new)-array['updated_at','notebook_carried_to_route_id','notebook_carried_import_id'])
           is distinct from (to_jsonb(old)-array['updated_at','notebook_carried_to_route_id','notebook_carried_import_id']) then
      raise exception 'El traslado histórico solo se registra al aplicar la hoja del motorizado.';
    end if;
  end if;
  return new;
end $guard$;
revoke all on function public.gf_guard_notebook_carried_stop() from public,anon,authenticated;
create trigger delivery_stops_guard_notebook_carried before update on public.delivery_stops
  for each row execute function public.gf_guard_notebook_carried_stop();

create or replace function public.gf_notebook_carry_over(
  p_rider_id uuid,
  p_to_date date,
  p_shipment_ids uuid[],
  p_actor uuid,
  p_import_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rider riders%rowtype;
  v_import rider_notebook_imports%rowtype;
  v_to_route uuid;
  v_load uuid;
  r record;
  v_item_row dispatch_manifest_items%rowtype;
  v_stop_row delivery_stops%rowtype;
  v_custody text;
  v_replaced int;
  v_n int := 0;
  v_reason text;
  v_wanted int := (select count(distinct x) from unnest(p_shipment_ids) as x);
begin
  if v_wanted = 0 then raise exception 'No hay paquetes que pasar.'; end if;
  select * into v_import from rider_notebook_imports where id = p_import_id
    and rider_id = p_rider_id and route_date = p_to_date
    and status = 'aplicada' and applied_by = p_actor for update;
  if not found then raise exception 'La hoja no está aplicada por esta persona para esta ruta.'; end if;
  if not exists (select 1 from memberships where org_id = v_import.org_id and user_id = p_actor) then
    raise exception 'La persona no pertenece a la organización de la hoja.'; end if;
  select * into v_rider from riders where id = p_rider_id and org_id = v_import.org_id;
  if not found then raise exception 'Motorizado no encontrado.'; end if;

  -- 0248: los candados de todo el lote antes que nada, ítems y después cajas,
  -- cada uno por id. `gf_replace_output` y `gf_return_to_office` toman ítem y
  -- luego caja: así ninguna espera a la otra en cruz por dos ítems de la misma
  -- caja. Las relecturas de cada paquete, abajo, vuelven a pedirlos.
  perform 1 from dispatch_manifest_items
   where shipment_id = any(p_shipment_ids) and removed_at is null
   order by id for update;
  perform 1 from dispatch_manifests
   where id in (select manifest_id from dispatch_manifest_items
                 where shipment_id = any(p_shipment_ids) and removed_at is null)
   order by id for update;

  for r in
    select distinct on (sh.id)
           sh.id shipment_id, sh.order_id, sh.store_id ship_store, sh.guide_code,
           i.id item_id, i.store_id item_store, m.id old_manifest, m.org_id, m.route_date old_date, s.id old_stop
      from unnest(p_shipment_ids) as x(shipment_id)
      join shipments sh on sh.id = x.shipment_id
           -- 0248: la caja reemplazada no pasa a otra ruta: vuelve a la oficina.
           -- Su marca es el evento; `retorno` solo también es «Solicitar devolución».
           and not (sh.custody_state = 'retorno' and public.gf_output_replaced(sh.id))
      join orders o on o.id = sh.order_id and o.cancelled_at is null
      join dispatch_manifest_items i on i.shipment_id = sh.id and i.removed_at is null
      join dispatch_manifests m on m.id = i.manifest_id and m.rider_id = p_rider_id and m.courier = 'propio'
           and m.state = 'in_custody' and m.route_date < p_to_date
      join delivery_stops s on s.dispatch_manifest_id = m.id and s.shipment_id = sh.id
           and (s.status = 'pendiente' or (s.status = 'no_entregado' and s.outcome_reason = 'reprogramado'))
     order by sh.id, s.reported_at desc nulls last
  loop
    perform 1 from orders where id = r.order_id and cancelled_at is null for update;
    if not found then raise exception 'El pedido fue anulado: vuelve a leer la hoja.'; end if;
    if r.org_id <> v_import.org_id or not exists (select 1 from stores where id = r.ship_store and org_id = v_import.org_id) then
      raise exception 'El paquete no pertenece a la organización de la hoja.'; end if;
    if exists (select 1 from order_master where order_id = r.order_id and general_status in ('entregado','anulado','devuelto')) then
      raise exception 'El pedido ya está cerrado: no se añade a otra ruta.'; end if;
    if not exists (select 1 from jsonb_array_elements(v_import.plan) p
      where p->'match'->>'kind' = 'arrastre'
        and p->'match'->>'shipmentId' = r.shipment_id::text
        and p->'match'->>'orderId' = r.order_id::text) then
      raise exception 'El paquete no forma parte de la hoja revisada.'; end if;
    if exists (select 1 from delivery_routes dr join delivery_stops ds on ds.route_id = dr.id
                where dr.rider_id = p_rider_id and dr.route_date = p_to_date and ds.order_id = r.order_id) then
      raise exception 'El pedido ya tiene parada en la ruta del %.', to_char(p_to_date, 'DD/MM');
    end if;
    if v_load is null then
      v_load := public.gf_dispatch_load(r.org_id, p_rider_id, p_to_date, p_actor);
      -- gf_dispatch_load devuelve la carga que Despacho esté armando para ese
      -- día. Esa no se toca: pasarla a custodia sacaría su caja a medio cotejar.
      if exists (select 1 from dispatch_manifest_items where manifest_id = v_load) then
        raise exception 'Despacho está armando la carga de % del %: añade los pedidos cuando él la reciba.',
          v_rider.full_name, to_char(p_to_date, 'DD/MM');
      end if;
    end if;
    v_reason := 'Hoja del ' || to_char(p_to_date, 'DD/MM') || ': ' || v_rider.full_name
      || ' volvió a llevar el paquete que conserva desde el ' || to_char(r.old_date, 'DD/MM')
      || '. Traspaso documental, sin cambiar el reporte anterior. Hoja ' || p_import_id::text || '.';

    -- 0248: releído con candado, en el orden de `gf_replace_output` (ítem,
    -- caja, parada, salida). La consulta del bucle se leyó antes de que un
    -- «Sacar con salida nueva» o un «Recibir en oficina» simultáneo terminara
    -- de cambiar el paquete, y el UPDATE de abajo no lo vería.
    select * into v_item_row from dispatch_manifest_items where id = r.item_id for update;
    if v_item_row.removed_at is not null then
      raise exception 'Un paquete ya no está en la caja anterior: alguien lo recibió o lo movió. Vuelve a leer la hoja.';
    end if;
    perform 1 from dispatch_manifests where id = r.old_manifest for update;
    select * into v_stop_row from delivery_stops where id = r.old_stop for update;
    if v_stop_row.status <> 'pendiente' and not (v_stop_row.status = 'no_entregado' and v_stop_row.outcome_reason = 'reprogramado') then
      raise exception 'Cambió el reporte anterior: vuelve a leer la hoja.'; end if;
    if v_stop_row.status = 'pendiente' and not exists (select 1 from jsonb_array_elements(v_import.plan) p
      where p->'match'->>'shipmentId' = r.shipment_id::text
        and p->'match'->>'orderId' = r.order_id::text
        and p->'match'->>'via' = 'codigo'
        and nullif(trim(p->'line'->>'order'), '') is not null) then
      raise exception 'La hoja debe identificar por código un paquete sin reporte anterior.'; end if;
    select custody_state into v_custody from shipments where id = r.shipment_id for update;
    if v_custody = 'retorno' and public.gf_output_replaced(r.shipment_id) then
      raise exception 'Una caja ya salió con otra salida y vuelve a la oficina: no pasa a la ruta. Vuelve a leer la hoja.';
    end if;

    -- 1. Sale de la caja anterior: no volvió a la oficina, sigue con él.
    perform set_config('gf.withdraw', 'on', true);
    update dispatch_manifest_items
       set removed_at = clock_timestamp(), removed_by = p_actor, removal_reason = left(v_reason, 300)
     where id = r.item_id;
    perform set_config('gf.withdraw', 'off', true);
    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
    values (r.org_id, r.old_manifest, r.shipment_id, p_actor, 'carried_over',
            jsonb_build_object('stop_id', r.old_stop, 'to_route_date', p_to_date, 'to_manifest_id', v_load, 'reason', v_reason, 'notebook_import_id', p_import_id, 'previous_stop_status', v_stop_row.status));
    -- Un segundo antes de la custodia de la carga nueva: la señal del motorizado
    -- que manda en el Master es la recepción (gfRiderSignal, mom-v1.14).
    insert into order_events(store_id, order_id, kind, occurred_at, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (r.ship_store, r.order_id, 'package_removed', now() - interval '1 second', p_actor, 'dispatch', 'propio',
            r.guide_code, r.shipment_id, 'confirmado_en_cuaderno', v_reason,
            jsonb_build_object('manifest_id', r.old_manifest, 'rider_id', p_rider_id, 'route_date', r.old_date,
                               'carried_over', true, 'to_route_date', p_to_date, 'to_manifest_id', v_load, 'notebook_import_id', p_import_id, 'previous_stop_status', v_stop_row.status));

    -- 2. Entra en la carga del día, cotejada por oficina y por el motorizado:
    --    él ya lo tiene, no hay nada que cotejar.
    insert into dispatch_manifest_items(manifest_id, shipment_id, store_id, added_by,
      office_checked_at, office_checked_by, pickup_checked_at, pickup_checked_by)
    values (v_load, r.shipment_id, r.item_store, p_actor, clock_timestamp(), p_actor, clock_timestamp(), p_actor);
    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload) values
      (r.org_id, v_load, r.shipment_id, p_actor, 'package_added',
       jsonb_build_object('source', 'grupo_gf_courier', 'riderId', p_rider_id, 'carried_from_manifest', r.old_manifest,
                          'carried_from_date', r.old_date, 'note', v_reason, 'notebook_import_id', p_import_id, 'attested_from_notebook', true)),
      (r.org_id, v_load, r.shipment_id, p_actor, 'office_checked', jsonb_build_object('carried_over', true, 'notebook_import_id', p_import_id, 'attested_from_notebook', true)),
      (r.org_id, v_load, r.shipment_id, p_actor, 'pickup_checked', jsonb_build_object('carried_over', true, 'notebook_import_id', p_import_id, 'attested_from_notebook', true));
    if v_stop_row.status = 'pendiente' then
      select delivery_route_id into strict v_to_route from dispatch_manifests where id=v_load;
      perform set_config('gf.notebook_import',p_import_id::text,true);
      update delivery_stops set notebook_carried_to_route_id=v_to_route, notebook_carried_import_id=p_import_id
       where id=r.old_stop;
      perform set_config('gf.notebook_import','',true);
    end if;
    v_n := v_n + 1;
  end loop;

  if v_n <> v_wanted then
    select count(*) into v_replaced from shipments sh
     where sh.id = any(p_shipment_ids) and sh.custody_state = 'retorno' and public.gf_output_replaced(sh.id);
    raise exception 'Solo % de % paquetes siguen en una caja anterior de % y pueden pasar con esta hoja.%', v_n, v_wanted, v_rider.full_name,
      case when v_replaced > 0 then ' Una caja reemplazada por otra salida no pasa: vuelve a la oficina.' else '' end;
  end if;
  -- 3. La carga pasa a custodia: nacen las paradas pendientes de la ruta del día.
  perform public.finalize_dispatch_manifest(v_load, p_actor);
  return v_load;
end;
$$;
revoke all on function public.gf_notebook_carry_over(uuid, date, uuid[], uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_notebook_carry_over(uuid, date, uuid[], uuid, uuid) to service_role;

