-- ============================================================================
-- 0305_urpi_take_gf_output.sql — la programación de Urpi toma la caja que
-- Grupo GF no entregó (MOM §9.1 y §30.10; decisión del owner, 03-11-2026).
--
-- EL CASO. #KP200665 salió el 29/10 con Yordani (Grupo GF), que la reportó
-- «No entregado · No contesta» el 30/10. Nadie la recibió en oficina, así que
-- su salida KP200665-S01 siguió `propio · pendiente` dentro de la caja de
-- Yordani. El 31/10 salió con Urpi (programación de Kenku, fila 25) y el 02/11
-- Urpi la canceló. Al registrar el despacho, Kapta vio «otra salida viva» —la
-- de Grupo GF— y no lo hizo (`planUrpiDispatch`, lib/urpi-dispatch.ts): sin
-- salida de Urpi, el cancelado no tenía nada que anular y el pedido no entró a
-- «Reintentos Aliclik». Medido el 03-11-2026: 25 pedidos abiertos en «Por
-- reprogramar Lima» que Urpi canceló, en la misma situación.
--
-- LA REGLA. Si la única salida viva del pedido es la propia de Grupo GF y lo
-- último que se reportó en ella es «No entregado» en una ruta ANTERIOR al día
-- que Urpi la programó, la programación de Urpi es el siguiente intento con esa
-- misma caja (mismo consecutivo, QR y rótulo, como la retoma propia de Grupo
-- GF, §9.3). En una sola transacción:
--
--   1. Si sigue en la caja del motorizado, se recibe en oficina con
--      `gf_return_to_office` (0206/0285): la función de siempre, con sus
--      eventos. Si ya se recibió, se sigue.
--   2. La solicitud de Grupo GF de esa salida se cancela (la lleva Urpi, no
--      Grupo GF) con un `logistics_request_events` `taken_by_urpi`.
--   3. La salida pasa a Urpi en ruta, despachada el día programado a mediodía
--      de Lima, con `created_via = urpi_programacion`; queda
--      `route_output_filled` (`previousCourier = propio`), el mismo rastro que
--      deja el relleno de una «por definir».
--
-- El intento de Grupo GF no se pierde: es su parada «No entregado», que es lo
-- que leen Repro Lima, la cadena de reintentos y la paga del motorizado.
--
-- NO TOMA, y devuelve por qué: otra salida, entregada, devuelta, reemplazada
-- (0248) o de una venta terminada; la última parada no es «No entregado»; la
-- ruta de esa parada es del mismo día o posterior; la caja es de otro courier
-- o su parada no es la «No entregado»; o el paquete no está ni en la caja ni en
-- la empresa. Esos se siguen nombrando para revisar a mano.
--
-- Aplicar a mano ANTES de desplegar el código (DEPLOY.md). Idempotente.
-- ============================================================================

create or replace function public.urpi_take_gf_output(
  p_shipment_id uuid,
  p_programmed_on date,
  p_guide_code text
) returns text language plpgsql set search_path = public as $$
declare
  v_ship shipments%rowtype;
  v_stop delivery_stops%rowtype;
  v_route_date date;
  v_item dispatch_manifest_items%rowtype;
  v_manifest dispatch_manifests%rowtype;
  v_rider text;
  v_code text;
  v_note text;
  v_request uuid;
begin
  if p_programmed_on is null or coalesce(trim(p_guide_code), '') = '' then
    raise exception 'Falta el día programado o el código de guía.';
  end if;

  select * into v_ship from shipments where id = p_shipment_id;
  if not found then return 'no_existe'; end if;
  if v_ship.courier <> 'propio' or v_ship.delivery_status <> 'pendiente' then return 'no_es_caja_gf_viva'; end if;
  if v_ship.returned_at is not null or v_ship.custody_state in ('devuelto', 'retorno') or gf_output_replaced(v_ship.id) then
    return 'devuelta_o_reemplazada';
  end if;
  if exists (select 1 from woo_sale_returns where order_id = v_ship.order_id) then return 'venta_terminada'; end if;
  if exists (
    select 1 from shipments s
     where s.order_id = v_ship.order_id and s.id <> v_ship.id
       and (s.delivery_status = 'entregado'
            or (s.delivery_status in ('pendiente', 'en_ruta') and s.returned_at is null and coalesce(s.custody_state, '') <> 'devuelto'))
  ) then
    return 'otra_salida';
  end if;

  -- La última parada de ESTA salida, en cualquier ruta: la más nueva. Una
  -- retoma posterior de Grupo GF (otra parada, aún sin reporte) no se pisa.
  select * into v_stop from delivery_stops
   where shipment_id = p_shipment_id
   order by created_at desc, reported_at desc nulls last
   limit 1;
  if not found or v_stop.status <> 'no_entregado' then return 'sin_no_entregado'; end if;
  select route_date into v_route_date from delivery_routes where id = v_stop.route_id;
  if v_route_date is null or v_route_date >= p_programmed_on then return 'gf_no_es_anterior'; end if;

  -- 1. Recibir en oficina, si sigue en una caja.
  select * into v_item from dispatch_manifest_items
   where shipment_id = p_shipment_id and removed_at is null
   order by created_at desc
   limit 1;
  if found then
    select * into v_manifest from dispatch_manifests where id = v_item.manifest_id;
    if v_manifest.courier <> 'propio' then return 'en_caja_de_otro_courier'; end if;
    if v_stop.dispatch_manifest_id is distinct from v_item.manifest_id then return 'caja_sin_reporte'; end if;
    perform gf_return_to_office(v_item.id, null);
  end if;

  select * into v_ship from shipments where id = p_shipment_id for update;
  if v_ship.courier <> 'propio' or v_ship.delivery_status <> 'pendiente' then return 'no_es_caja_gf_viva'; end if;
  if v_ship.custody_state is distinct from 'empresa' or v_ship.custody_transferred_at is not null then
    if v_item.id is not null then
      raise exception 'La salida % no quedó en la empresa al recibirla en oficina.', p_shipment_id;
    end if;
    return 'fuera_de_oficina';
  end if;

  if v_manifest.id is null and v_stop.dispatch_manifest_id is not null then
    select * into v_manifest from dispatch_manifests where id = v_stop.dispatch_manifest_id;
  end if;
  v_rider := coalesce(
    v_manifest.driver_name,
    (select r.full_name from delivery_routes dr join riders r on r.id = dr.rider_id where dr.id = v_stop.route_id),
    'el motorizado');
  v_code := coalesce(v_ship.output_code, v_ship.guide_code, 'La salida');
  v_note := left(
    v_code || ': Grupo GF (' || v_rider || ') no la entregó el ' || to_char(v_route_date, 'DD/MM')
      || coalesce(' (' || v_stop.outcome_reason || ')', '')
      || ' y salió con Urpi el ' || to_char(p_programmed_on, 'DD/MM')
      || ' según su programación: misma caja, ahora de Urpi.',
    300);

  -- 2. La solicitud de Grupo GF: la lleva Urpi.
  update logistics_requests
     set status = 'cancelled', observation = v_note
   where shipment_id = p_shipment_id and status not in ('cancelled', 'completed')
  returning id into v_request;
  if v_request is not null then
    insert into logistics_request_events(request_id, kind, status, actor, note, payload)
    values (v_request, 'taken_by_urpi', 'cancelled', null, v_note,
            jsonb_build_object('shipment_id', p_shipment_id, 'programmed_on', p_programmed_on, 'stop_id', v_stop.id));
  end if;

  -- 3. La caja pasa a Urpi en ruta, el día programado a mediodía de Lima.
  update shipments
     set courier = 'urpi',
         created_via = 'urpi_programacion',
         guide_code = p_guide_code,
         delivery_status = 'en_ruta',
         status_category = 'in_route',
         dispatched_at = (p_programmed_on + time '12:00') at time zone 'America/Lima',
         updated_at = now()
   where id = p_shipment_id;

  if v_ship.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (v_ship.store_id, v_ship.order_id, 'route_output_filled', null, 'manual', 'urpi', p_guide_code, p_shipment_id,
            v_stop.outcome_reason, v_note,
            jsonb_build_object('outputCode', v_ship.output_code, 'previousCourier', 'propio', 'via', 'urpi_programacion',
                               'programmedOn', p_programmed_on, 'stopId', v_stop.id, 'gfRouteDate', v_route_date,
                               'requestId', v_request));
  end if;
  return 'tomada';
end;
$$;

revoke all on function public.urpi_take_gf_output(uuid, date, text) from public, anon, authenticated;
grant execute on function public.urpi_take_gf_output(uuid, date, text) to service_role;
