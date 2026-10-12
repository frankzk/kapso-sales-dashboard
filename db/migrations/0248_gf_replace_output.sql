-- ============================================================================
-- 0248_gf_replace_output.sql — «Sacar con salida nueva»: el pedido vuelve a
-- salir mientras el motorizado todavía tiene la caja que no entregó.
--
-- DECISIÓN DEL OWNER (12-10-2026, «Reprogramación en Lima»): un mismo pedido
-- puede tener una salida «en devolución» sin devolver y otra saliendo. Johnny
-- (Yhoni) y Roy traen lo no entregado al día siguiente; Alexis cada dos o tres
-- días; de noche no se recibe nada. Si el pedido tiene que salir antes, Almacén
-- arma otra caja desde stock con salida, QR y rótulo nuevos, y la caja anterior
-- queda en devolución a nombre del motorizado hasta que la trae. Al recibirla,
-- se desarma y vuelve a stock: no se reutiliza ni vuelve a la cola. Vale para
-- cualquier motorizado con caja de Grupo GF. MOM §9.3, §29.13.
--
-- QUÉ CAMBIA:
--
--   0) `gf_output_replaced(salida)`: la salida se reemplazó por otra (tiene el
--      evento `output_replaced`). Es la marca: la custodia `retorno` sola no
--      basta, porque «Solicitar devolución» (§13) también la pone.
--   a) `gf_replace_output`: la salida anterior (S01, «No entregado» en la caja
--      del motorizado) pasa a custodia `retorno` y conserva todo lo demás —su
--      parada, su ítem activo en la caja y `dispatched_at`—. La solicitud de
--      Grupo GF pasa a la salida nueva (S02), aceptada y con su día. La S02 la
--      crea Kapta antes de llamar (con su consecutivo, QR y rótulo); aquí solo
--      se comprueba que es del mismo pedido y no salió. Se repite el tope de
--      cinco salidas. Eventos `output_replaced` en el pedido, la caja y la
--      solicitud.
--   b) `gf_return_to_office` gana una rama «a stock» para la salida
--      reemplazada (en `retorno`) y para la que ya consta devuelta pero sigue en
--      la caja (la recepción de la Mesa de cierre no la saca): queda `devuelto`
--      (conserva el `returned_at` que tuviera), conserva `dispatched_at` —salió
--      de verdad, así que nunca vuelve a «Por despachar»— y NO vuelve a «por
--      asignar». Escribe `return_received` (si no estaba), no
--      `returned_to_office`, que `gf_order_departures` (0199) cuenta como salida
--      del pedido. El resto de la función es la de la 0206, sin cambios.
--   c) Trigger `delivery_stops_guard_replaced`: la parada de una salida
--      reemplazada que el motorizado todavía tiene no cambia de estado. Si
--      deshiciera su «No entregado», la parada volvería a `pendiente` y las
--      funciones de custodia (`gf_withdraw_in_custody`, `gf_office_reclaim`,
--      `gf_rider_decline`) la devolverían a la empresa: habría dos salidas vivas
--      del mismo pedido. Bloquea también entregarla, soltarla de su salida o de
--      su caja y borrarla. Es `security definer`: el motorizado puede escribir
--      su parada directamente (política `delivery_stops_report`, 0066) sin
--      poder leer `shipments`.
--   d) `gf_carry_over` (0234) no pasa a la ruta siguiente del motorizado una
--      salida reemplazada (`gf_output_replaced`; una en `retorno` por
--      «Solicitar devolución» pasa como siempre). Bloquea primero los ítems y
--      las cajas de todo el lote, en orden, y vuelve a leer con candado cada
--      paquete antes de sacarlo de la caja anterior: un reemplazo o una
--      recepción simultáneos no se pisan ni se bloquean en cruz. El resto de la
--      función es la de la 0234.
--   e) Trigger `dispatch_items_guard_replaced_route`: la salida nueva no entra
--      en una caja del mismo motorizado y el mismo día que la parada de la caja
--      reemplazada. La ruta del día tiene una parada por pedido
--      (`delivery_stops`, único por ruta y pedido) y la custodia de toda la
--      carga fallaría con un error confuso.
--
-- Aplicar a mano ANTES de desplegar el código (DEPLOY.md). Sin `begin`/`commit`
-- propios, como el resto de migraciones. Idempotente.
-- ============================================================================

-- 0) La marca de la salida reemplazada ----------------------------------------

create or replace function public.gf_output_replaced(p_shipment uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from order_events where shipment_id = p_shipment and kind = 'output_replaced'
  );
$$;

revoke all on function public.gf_output_replaced(uuid) from public, anon, authenticated;
grant execute on function public.gf_output_replaced(uuid) to service_role;

-- a) Reemplazar la salida que el motorizado todavía tiene ----------------------

create or replace function public.gf_replace_output(
  p_item_id uuid,
  p_new_shipment uuid,
  p_request_id uuid,
  p_scheduled_for date,
  p_reason text,
  p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_item dispatch_manifest_items%rowtype;
  v_manifest dispatch_manifests%rowtype;
  v_stop delivery_stops%rowtype;
  v_old shipments%rowtype;
  v_new shipments%rowtype;
  v_req uuid;
  v_prev text;
  v_count int;
  v_rider text;
  v_old_code text;
  v_new_code text;
  v_note text;
begin
  -- Mismo orden de bloqueo que `gf_return_to_office`: ítem, caja, parada,
  -- salida. Así las dos no se cruzan.
  select * into v_item from dispatch_manifest_items where id = p_item_id for update;
  if not found or v_item.removed_at is not null then
    raise exception 'RECIBIDA: ya se recibió en oficina; tómalo con su misma salida.';
  end if;
  select * into v_manifest from dispatch_manifests where id = v_item.manifest_id for update;
  if v_manifest.courier <> 'propio' then raise exception 'Solo para cajas de Grupo GF.'; end if;
  select * into v_stop from delivery_stops
    where shipment_id = v_item.shipment_id and dispatch_manifest_id = v_item.manifest_id
    order by reported_at desc nulls last limit 1 for update;
  if not found or v_stop.status <> 'no_entregado' then
    raise exception 'Solo se saca con salida nueva un paquete reportado «No entregado».';
  end if;

  select * into v_old from shipments where id = v_item.shipment_id for update;
  if v_old.custody_state = 'retorno' and not gf_output_replaced(v_old.id) then
    raise exception 'La salida ya está en devolución (se pidió su retorno): no se saca con salida nueva.';
  end if;
  if v_old.custody_state = 'retorno' then
    select s.output_code into v_prev
      from order_events e join shipments s on s.id = (e.payload->>'replaced_by')::uuid
     where e.kind = 'output_replaced' and e.shipment_id = v_old.id
     order by e.occurred_at desc limit 1;
    raise exception 'REPLACED:%', coalesce(v_prev, '');
  end if;
  if v_old.courier <> 'propio' or v_old.delivery_status <> 'pendiente'
     or v_old.returned_at is not null or v_old.custody_state = 'devuelto' then
    raise exception 'La salida ya no está «No entregado» con el motorizado.';
  end if;

  select * into v_new from shipments where id = p_new_shipment for update;
  if not found or v_new.id = v_old.id or v_new.order_id is distinct from v_old.order_id
     or v_new.courier <> 'propio' or v_new.delivery_status <> 'pendiente'
     or v_new.custody_state is distinct from 'empresa' or v_new.dispatched_at is not null then
    raise exception 'La salida nueva no corresponde a este pedido.';
  end if;

  -- La S02 ya existe: con ella, el pedido no puede pasar de cinco salidas.
  select count(*) into v_count from shipments where order_id = v_old.order_id;
  if v_count > 5 then raise exception 'TOPE: el pedido ya alcanzó el máximo de 5 salidas.'; end if;

  v_rider := coalesce(v_manifest.driver_name, 'el motorizado');
  v_old_code := coalesce(v_old.output_code, v_old.guide_code, 'La salida anterior');
  v_new_code := coalesce(v_new.output_code, v_new.guide_code, 'una salida nueva');
  v_note := v_old_code || ' sigue con ' || v_rider || ' (en devolución); el pedido sale con ' || v_new_code || '.';

  update shipments set custody_state = 'retorno' where id = v_old.id;

  -- La solicitud viva de la salida anterior pasa a la nueva. Si la anterior no
  -- tenía (salió por el cuaderno o antes de las solicitudes), Kapta abrió una en
  -- `accepting` y aquí se acepta.
  update logistics_requests
     set shipment_id = p_new_shipment, status = 'accepted', scheduled_for = p_scheduled_for,
         observation = left(coalesce(p_reason, v_note), 300)
   where shipment_id = v_old.id and status in ('accepted', 'scheduled', 'in_route')
  returning id into v_req;
  if v_req is null and p_request_id is not null then
    update logistics_requests
       set shipment_id = p_new_shipment, status = 'accepted', accepted_at = now(),
           accepted_by = p_actor, scheduled_for = p_scheduled_for, observation = null
     where id = p_request_id and status = 'accepting' and order_id = v_old.order_id
    returning id into v_req;
  end if;
  if v_req is null then
    raise exception 'El pedido no tiene solicitud de Grupo GF para la salida nueva.';
  end if;

  insert into logistics_request_events(request_id, kind, status, actor, note, payload)
  values (v_req, 'output_replaced', 'accepted', p_actor, v_note,
          jsonb_build_object('from', v_old.id, 'from_code', v_old.output_code,
                             'to', p_new_shipment, 'to_code', v_new.output_code,
                             'scheduled_for', p_scheduled_for));
  insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
  values (v_manifest.org_id, v_item.manifest_id, v_old.id, p_actor, 'output_replaced',
          jsonb_build_object('stop_id', v_stop.id, 'outcome_reason', v_stop.outcome_reason,
                             'replaced_by', p_new_shipment, 'replaced_by_code', v_new.output_code));
  if v_old.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (v_old.store_id, v_old.order_id, 'output_replaced', p_actor, 'dispatch', 'propio',
            v_old.guide_code, v_old.id, v_stop.outcome_reason, v_note,
            jsonb_build_object('replaced_by', p_new_shipment, 'replaced_by_code', v_new.output_code,
                               'manifest_id', v_item.manifest_id, 'rider_id', v_manifest.rider_id,
                               'route_date', v_manifest.route_date, 'stop_id', v_stop.id,
                               'outcome_reason', v_stop.outcome_reason, 'request_id', v_req));
  end if;

  return jsonb_build_object('order_id', v_old.order_id, 'request_id', v_req,
                            'old_code', v_old.output_code, 'new_code', v_new.output_code);
end;
$$;

revoke all on function public.gf_replace_output(uuid, uuid, uuid, date, text, uuid) from public, anon, authenticated;
grant execute on function public.gf_replace_output(uuid, uuid, uuid, date, text, uuid) to service_role;

-- b) «Recibir en oficina» de la salida en devolución --------------------------
-- El cuerpo es el de la 0206 más la rama de `retorno`, justo después de leer la
-- salida.

create or replace function public.gf_return_to_office(p_item_id uuid, p_actor uuid)
returns uuid language plpgsql set search_path = public as $$
declare
  v_item dispatch_manifest_items%rowtype;
  v_manifest dispatch_manifests%rowtype;
  v_shipment shipments%rowtype;
  v_stop delivery_stops%rowtype;
  v_reason text;
  v_rider text;
  v_replaced boolean;
  v_code text;
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

  -- A stock (0248): la salida reemplazada —el pedido ya salió con otra— y la
  -- que ya consta devuelta pero sigue en la caja. Queda devuelta; no vuelve a
  -- «por asignar» ni a la cola. Una en `retorno` sin reemplazo («Solicitar
  -- devolución») sigue el camino de siempre.
  v_replaced := gf_output_replaced(v_shipment.id);
  if v_shipment.custody_state = 'devuelto' or v_shipment.returned_at is not null
     or (v_shipment.custody_state = 'retorno' and v_replaced) then
    v_code := coalesce(v_shipment.output_code, v_shipment.guide_code, 'La salida');
    perform set_config('gf.withdraw', 'on', true);
    update dispatch_manifest_items
       set removed_at = now(), removed_by = p_actor,
           removal_reason = left(case when v_replaced
             then 'Salida reemplazada: recibida en oficina, vuelve a stock (' || v_rider || ')'
             else 'Ya constaba devuelta: recibida en oficina, sale de la caja (' || v_rider || ')' end, 300)
     where id = p_item_id;
    perform set_config('gf.withdraw', 'off', true);

    -- Conserva `dispatched_at`: salió de verdad y la devolución está probada.
    -- Una recepción anterior conserva su sello.
    update shipments
       set custody_state = 'devuelto', returned_at = coalesce(returned_at, now()),
           returned_by = coalesce(returned_by, p_actor), returned_source = coalesce(returned_source, 'manual')
     where id = v_item.shipment_id;
    -- Defensivo: la solicitud ya pasó a la salida nueva al reemplazarla.
    update logistics_requests
       set status = 'cancelled', observation = 'Salida devuelta recibida en oficina'
     where shipment_id = v_item.shipment_id and status in ('accepted', 'scheduled');

    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
    values (v_manifest.org_id, v_item.manifest_id, v_item.shipment_id, p_actor, 'returned_to_office',
            jsonb_build_object('stop_id', v_stop.id, 'outcome_reason', v_stop.outcome_reason, 'replaced', v_replaced, 'to_stock', true));
    if v_shipment.order_id is not null and not exists (
      select 1 from order_events where shipment_id = v_item.shipment_id and kind = 'return_received'
    ) then
      insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
      values (v_shipment.store_id, v_shipment.order_id, 'return_received', p_actor, 'dispatch', 'propio',
              v_shipment.guide_code, v_item.shipment_id, v_stop.outcome_reason,
              case when v_replaced
                then v_code || ' recibida en oficina (' || v_rider
                  || '): era la caja reemplazada. Desármala y devuelve el producto a stock; no se reprograma.'
                else v_code || ' recibida en oficina (' || v_rider
                  || '): ya constaba devuelta. Sale de la caja; no vuelve a «por asignar».' end,
              jsonb_build_object('manifest_id', v_item.manifest_id, 'rider_id', v_manifest.rider_id,
                                 'route_date', v_manifest.route_date, 'stop_id', v_stop.id, 'replaced', v_replaced));
    end if;
    return v_shipment.order_id;
  end if;

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

-- c) La parada de la salida en devolución no cambia ----------------------------

-- `security definer`: el motorizado escribe su parada bajo RLS y no ve
-- `shipments`; leída como él, la guarda no encontraría nada. Mira la salida de
-- ANTES del cambio: soltar la parada de su salida (`shipment_id`) o de su caja
-- también la sacaría de la guarda. Corregir la nota o el motivo sin cambiar el
-- estado sí se puede.
create or replace function public.gf_guard_replaced_stop()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status
     and new.shipment_id is not distinct from old.shipment_id
     and new.dispatch_manifest_id is not distinct from old.dispatch_manifest_id then
    return new;
  end if;
  if exists (
    select 1 from shipments s
     where s.id = old.shipment_id and s.courier = 'propio'
       and s.custody_state = 'retorno' and s.returned_at is null
  ) and gf_output_replaced(old.shipment_id) then
    raise exception 'Este paquete ya salió con otra salida: no se entrega ni se reporta. Tráelo a la oficina.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.gf_guard_replaced_stop() from public, anon, authenticated;

-- `create or replace trigger` y no drop + create (como la 0204): atómico.
create or replace trigger delivery_stops_guard_replaced
  before update of status, shipment_id, dispatch_manifest_id or delete on public.delivery_stops
  for each row
  when (old.shipment_id is not null)
  execute function public.gf_guard_replaced_stop();

-- d) El traspaso del cuaderno no se lleva la caja reemplazada -----------------
-- El cuerpo es el de la 0234 con una condición más sobre la salida.

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
  v_item_row dispatch_manifest_items%rowtype;
  v_stop_row delivery_stops%rowtype;
  v_custody text;
  v_replaced int;
  v_n int := 0;
  v_reason text;
  v_wanted int := (select count(distinct x) from unnest(p_shipment_ids) as x);
begin
  if v_wanted = 0 then raise exception 'No hay paquetes que pasar.'; end if;
  select * into v_rider from riders where id = p_rider_id;
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
    if v_stop_row.status <> 'no_entregado' or v_stop_row.outcome_reason is distinct from 'reprogramado' then
      raise exception 'Un paquete ya no está reprogramado: vuelve a leer la hoja.';
    end if;
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
    select count(*) into v_replaced from shipments sh
     where sh.id = any(p_shipment_ids) and sh.custody_state = 'retorno' and public.gf_output_replaced(sh.id);
    raise exception 'Solo % de % paquetes son reprogramados que % conserva en una caja anterior.%', v_n, v_wanted, v_rider.full_name,
      case when v_replaced > 0 then ' Una caja reemplazada por otra salida no pasa: vuelve a la oficina.' else '' end;
  end if;
  -- 3. La carga pasa a custodia: nacen las paradas pendientes de la ruta del día.
  perform public.finalize_dispatch_manifest(v_load, p_actor);
  return v_load;
end;
$$;
revoke all on function public.gf_carry_over(uuid, date, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.gf_carry_over(uuid, date, uuid[], uuid) to service_role;

-- e) La salida nueva no va en la ruta del mismo día que la caja reemplazada ----

create or replace function public.gf_guard_replaced_same_route()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_manifest dispatch_manifests%rowtype;
  v_order uuid;
  v_code text;
begin
  select * into v_manifest from dispatch_manifests where id = new.manifest_id;
  if not found or v_manifest.courier <> 'propio' or v_manifest.rider_id is null then return new; end if;
  select order_id into v_order from shipments where id = new.shipment_id;
  if v_order is null then return new; end if;
  select coalesce(s.output_code, s.guide_code) into v_code
    from delivery_routes dr
    join delivery_stops ds on ds.route_id = dr.id
    join shipments s on s.id = ds.shipment_id
   where dr.org_id = v_manifest.org_id and dr.rider_id = v_manifest.rider_id
     and dr.route_date = v_manifest.route_date and ds.order_id = v_order
     and ds.shipment_id is distinct from new.shipment_id
     and gf_output_replaced(ds.shipment_id)
   limit 1;
  if found then
    raise exception 'Este pedido tiene su caja anterior (%) en la ruta de % del %: la salida nueva va con otro motorizado u otro día.',
      coalesce(v_code, 'en devolución'), coalesce(v_manifest.driver_name, 'ese motorizado'), to_char(v_manifest.route_date, 'DD/MM');
  end if;
  return new;
end;
$$;

revoke all on function public.gf_guard_replaced_same_route() from public, anon, authenticated;

create or replace trigger dispatch_items_guard_replaced_route
  before insert on public.dispatch_manifest_items
  for each row
  execute function public.gf_guard_replaced_same_route();
