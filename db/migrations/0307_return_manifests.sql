-- ============================================================================
-- 0307_return_manifests.sql — Manifiesto de devolución (fase 1, Grupo GF) y
-- pedido anulado en la tienda que vuelve: a inventario (decisiones del owner,
-- 04-11-2026; MOM §9.4, §13 y §29.13).
--
-- EL CASO. Alexis trae de golpe las devoluciones de varios días y nada deja
-- constancia de «esto llegó junto, lo entregó él y lo recibió esta persona»:
-- cada caja se recibe sola (`gf_return_to_office`) y lo que no llegó no se
-- anota en ningún sitio. Medido el 04-11-2026: 730 «No entregado» siguen en
-- cajas de Grupo GF (276 de Alexis); 346 son de pedidos anulados en la tienda,
-- que al recibirse volvían a «por asignar» sin abrir nunca el inventario.
--
-- LO QUE HACE.
--  1. `gf_return_to_office` (misma firma): la caja de un pedido ANULADO EN LA
--     TIENDA (`orders.cancelled_at`) va a stock —custodia `devuelto`,
--     `returned_at`, `return_received`—, como la venta terminada de la 0285:
--     el pedido pasa a «Devolución pendiente de inventario» y Almacén decide
--     stock o merma. Un pedido reactivado (`cancelled_at` nulo) sigue igual.
--     Si la llamada viene de un manifiesto, sus eventos llevan su id.
--  2. `urpi_take_gf_output` (0305) no toma la caja de un pedido anulado en la
--     tienda (la programación de Urpi ya no lo llama; esto es la guarda).
--  3. `return_manifests` (cabecera) y `return_manifest_lines` (líneas), con
--     RLS de solo lectura, un candado que congela lo cerrado y las funciones
--     de abrir, recibir, anotar, cerrar y anular. Ninguna cambia estados de
--     pedido: la recepción es la de siempre (`gf_return_to_office`).
--
-- Aplicar a mano ANTES de desplegar el código (DEPLOY.md). Idempotente.
-- ============================================================================

-- 1. Recepción en oficina: el anulado en la tienda va a inventario.
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
  v_store_cancelled boolean;
  v_woo_ended boolean;
  v_code text;
  v_cancelled_request uuid;
  -- El manifiesto de devolución que recibe, si lo hay (0307): solo para el rastro.
  v_rm jsonb := jsonb_strip_nulls(jsonb_build_object('return_manifest_id', nullif(current_setting('gf.return_manifest', true), '')));
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
  -- 0307 (owner, 04-11-2026): también la de un pedido ANULADO EN LA TIENDA.
  -- La venta terminó: la caja va a inventario y Almacén decide stock o merma.
  v_replaced := gf_output_replaced(v_shipment.id);
  v_store_cancelled := exists(select 1 from orders where id = v_shipment.order_id and cancelled_at is not null);
  v_woo_ended := exists(select 1 from woo_sale_returns where order_id = v_shipment.order_id);
  if v_shipment.custody_state = 'devuelto' or v_shipment.returned_at is not null
     or (v_shipment.custody_state = 'retorno' and v_replaced)
     or v_woo_ended or v_store_cancelled then
    v_code := coalesce(v_shipment.output_code, v_shipment.guide_code, 'La salida');
    perform set_config('gf.withdraw', 'on', true);
    update dispatch_manifest_items
       set removed_at = now(), removed_by = p_actor,
           removal_reason = left(case
             when v_replaced then 'Salida reemplazada: recibida en oficina, vuelve a stock (' || v_rider || ')'
             when v_store_cancelled then 'Pedido anulado en la tienda: recibido en oficina, va a inventario (' || v_rider || ')'
             else 'Venta terminada o salida devuelta: recibida en oficina, sale de la caja (' || v_rider || ')' end, 300)
     where id = p_item_id;
    perform set_config('gf.withdraw', 'off', true);

    -- Conserva `dispatched_at`: salió de verdad y la devolución está probada.
    -- Una recepción anterior conserva su sello.
    update shipments
       set custody_state = 'devuelto', returned_at = coalesce(returned_at, now()),
           returned_by = coalesce(returned_by, p_actor), returned_source = coalesce(returned_source, 'manual')
     where id = v_item.shipment_id;
    -- Defensivo: la solicitud ya pasó a la salida nueva al reemplazarla.
    if v_woo_ended then
      update logistics_requests set status='cancelled',observation='Venta terminada: retorno recibido en almacén'
        where shipment_id=v_item.shipment_id and status<>'cancelled' returning id into v_cancelled_request;
      if found then
        insert into logistics_request_events(request_id,kind,status,actor,note,payload)
          values(v_cancelled_request,'sale_ended_return_received','cancelled',p_actor,
            'Venta terminada: retorno recibido en almacén',jsonb_build_object('shipment_id',v_item.shipment_id));
      end if;
    elsif v_store_cancelled and not v_replaced then
      -- El pedido anulado no se reprograma: su solicitud no vuelve a la cola.
      update logistics_requests set status = 'cancelled',
             observation = 'Pedido anulado en la tienda: caja recibida en oficina, va a inventario'
       where shipment_id = v_item.shipment_id and status in ('accepted', 'scheduled')
      returning id into v_cancelled_request;
      if found then
        insert into logistics_request_events(request_id, kind, status, actor, note, payload)
          values (v_cancelled_request, 'store_cancelled_return_received', 'cancelled', p_actor,
                  'Pedido anulado en la tienda: caja recibida en oficina, va a inventario',
                  jsonb_build_object('shipment_id', v_item.shipment_id) || v_rm);
      end if;
    else
    update logistics_requests
       set status = 'cancelled', observation = 'Salida devuelta recibida en oficina'
     where shipment_id = v_item.shipment_id and status in ('accepted', 'scheduled');
    end if;

    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
    values (v_manifest.org_id, v_item.manifest_id, v_item.shipment_id, p_actor, 'returned_to_office',
            jsonb_build_object('stop_id', v_stop.id, 'outcome_reason', v_stop.outcome_reason, 'replaced', v_replaced,
                               'to_stock', true, 'store_cancelled', v_store_cancelled) || v_rm);
    if v_shipment.order_id is not null and not exists (
      select 1 from order_events where shipment_id = v_item.shipment_id and kind = 'return_received'
    ) then
      insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
      values (v_shipment.store_id, v_shipment.order_id, 'return_received', p_actor, 'dispatch', 'propio',
              v_shipment.guide_code, v_item.shipment_id, v_stop.outcome_reason,
              case when v_replaced
                then v_code || ' recibida en oficina (' || v_rider
                  || '): era la caja reemplazada. Desármala y devuelve el producto a stock; no se reprograma.'
                when v_store_cancelled
                then v_code || ' recibida en oficina (' || v_rider
                  || '): el pedido está anulado en la tienda. Va a inventario —Almacén decide stock o merma—; no vuelve a «por asignar».'
                else v_code || ' recibida en oficina (' || v_rider
                  || '): venta terminada o devolución confirmada. Sale de la caja; no vuelve a «por asignar».' end,
              jsonb_build_object('manifest_id', v_item.manifest_id, 'rider_id', v_manifest.rider_id,
                                 'route_date', v_manifest.route_date, 'stop_id', v_stop.id, 'replaced', v_replaced,
                                 'store_cancelled', v_store_cancelled) || v_rm);
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
          jsonb_build_object('stop_id', v_stop.id, 'outcome_reason', v_stop.outcome_reason) || v_rm);
  if v_shipment.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (v_shipment.store_id, v_shipment.order_id, 'returned_to_office', p_actor, 'dispatch', 'propio',
            v_shipment.guide_code, v_item.shipment_id, v_stop.outcome_reason,
            v_reason || '. Vuelve a «por asignar».',
            jsonb_build_object('manifest_id', v_item.manifest_id, 'rider_id', v_manifest.rider_id,
                               'route_date', v_manifest.route_date, 'stop_id', v_stop.id) || v_rm);
  end if;
  return v_shipment.order_id;
end;
$$;

revoke all on function public.gf_return_to_office(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_return_to_office(uuid, uuid) to service_role;

-- 2. Urpi no toma la caja de un pedido anulado en la tienda (0305 + una guarda).
-- La programación no llama por un pedido anulado (`planUrpiDispatch` → cerrado);
-- si una carrera la llama igual, la recepción de arriba ya la mandaría a stock y
-- la función fallaría al no verla en la empresa. Se nombra y no se toca.
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
  if exists (select 1 from orders where id = v_ship.order_id and cancelled_at is not null) then return 'anulado_en_tienda'; end if;
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

-- 3. Manifiesto de devolución: cabecera.
create table if not exists public.return_manifests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete restrict,
  -- 'propio' (Grupo GF) en la fase 1; Urpi y los demás después.
  courier text not null check (courier ~ '^[a-z][a-z0-9_]{1,39}$'),
  rider_id uuid references riders(id) on delete restrict,
  driver_name text,
  label text not null check (length(btrim(label)) between 3 and 120),
  -- El día de Lima en que llegó la entrega física.
  arrived_on date not null,
  -- «Entregó»: quien trajo las cajas. Obligatorio (≥3) al cerrar.
  handed_over_by text check (handed_over_by is null or length(btrim(handed_over_by)) between 1 and 120),
  -- «Declara N paquetes»: lo que dice que entrega. Opcional.
  declared_count integer check (declared_count is null or declared_count between 0 and 5000),
  note text check (note is null or length(note) <= 1000),
  -- Hoja de entrega o acta firmada: opcional (owner, 04-11-2026).
  photo_paths text[] not null default '{}' check (cardinality(photo_paths) <= 20),
  -- La cadencia usada para separar «con el motorizado» de «falta», congelada al abrir.
  cadence_days integer not null check (cadence_days between 0 and 60),
  -- Lo esperado que al cerrar seguía DENTRO de plazo (no es «Falta»), por
  -- tienda: {"<store_id>": {"con_el_motorizado": n, "reprogramado": n}}. Lo
  -- escribe el cierre para que «Recibidos X de Y esperados» y el acta digan lo
  -- mismo antes y después de cerrar. Null mientras está abierto.
  pending_at_close jsonb check (pending_at_close is null or jsonb_typeof(pending_at_close) = 'object'),
  state text not null default 'open' check (state in ('open', 'closed', 'cancelled')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_by uuid references auth.users(id) on delete restrict,
  closed_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete restrict,
  cancelled_at timestamptz,
  cancellation_reason text,
  constraint return_manifests_rider_ck check (courier <> 'propio' or rider_id is not null),
  constraint return_manifests_closed_ck check (
    (state = 'closed') = (closed_at is not null)
    and (closed_at is null or (closed_by is not null and length(btrim(coalesce(handed_over_by, ''))) >= 3))),
  constraint return_manifests_cancelled_ck check (
    (state = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is null or (cancelled_by is not null and length(btrim(coalesce(cancellation_reason, ''))) between 5 and 500)))
);
-- Una sola abierta por courier y motorizado (no por día: una llegada cubre varios días).
alter table public.return_manifests add column if not exists pending_at_close jsonb
  check (pending_at_close is null or jsonb_typeof(pending_at_close) = 'object');
create unique index if not exists return_manifests_one_open
  on public.return_manifests(org_id, courier, coalesce(rider_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where state = 'open';
create index if not exists return_manifests_org_day on public.return_manifests(org_id, arrived_on desc, created_at desc);

-- Líneas: cada caja escaneada, y lo esperado que faltó al cerrar.
create table if not exists public.return_manifest_lines (
  id uuid primary key default gen_random_uuid(),
  manifest_id uuid not null references return_manifests(id) on delete restrict,
  org_id uuid not null references organizations(id) on delete restrict,
  -- Null solo en una caja que no se identificó.
  store_id uuid references stores(id) on delete restrict,
  shipment_id uuid references shipments(id) on delete restrict,
  scanned_code text not null check (length(btrim(scanned_code)) between 1 and 200),
  dispatch_item_id uuid references dispatch_manifest_items(id) on delete restrict,
  source_manifest_id uuid references dispatch_manifests(id) on delete restrict,
  source_rider_id uuid references riders(id) on delete restrict,
  source_route_date date,
  -- La parada al escanear (o al cerrar). Una parada PENDIENTE se puede borrar
  -- después (Rutas «Quitar parada», `gf_office_reclaim`, `gf_withdraw_in_custody`):
  -- la línea pierde el enlace y conserva lo leído en `reported_status`/`reported_reason`.
  stop_id uuid references delivery_stops(id) on delete set null,
  reported_status text,
  reported_reason text,
  -- ¿Era de lo que Kapta esperaba de este motorizado?
  expected boolean not null default false,
  -- received: se recibió en oficina con la recepción de siempre.
  -- held: observación abierta, no se recibió (sin reporte que no pudo
  --   reportarse, reportada entregada, no identificada).
  -- info: ya recibida o ya en la oficina; no se escribe nada en el pedido.
  -- missing: esperada, fuera de plazo y no llegó (al cerrar).
  outcome text not null check (outcome in ('received', 'held', 'info', 'missing')),
  flags text[] not null default '{}' check (flags <@ array['otra_caja', 'sin_reporte', 'reportada_entregada', 'ya_recibida', 'no_identificada', 'reprogramado']::text[]),
  -- Lo que hizo la recepción: por_asignar; a_inventario_anulado (anulado en la tienda o
  -- venta terminada, 0285); a_stock_reemplazada (0248); ya_devuelta.
  receipt_outcome text check (receipt_outcome is null or receipt_outcome in ('por_asignar', 'a_inventario_anulado', 'a_stock_reemplazada', 'ya_devuelta')),
  -- El `dispatch_events` que escribió la recepción (siempre existe; el de
  -- `order_events` puede no existir: salida sin pedido o recepción anterior).
  dispatch_event_id uuid references dispatch_events(id) on delete restrict,
  message text check (message is null or length(message) <= 600),
  note text check (note is null or length(note) <= 600),
  photo_paths text[] not null default '{}' check (cardinality(photo_paths) <= 10),
  scanned_by uuid references auth.users(id) on delete restrict,
  scanned_at timestamptz not null default now(),
  scan_count integer not null default 1 check (scan_count >= 1),
  last_scanned_at timestamptz not null default now(),
  removed_by uuid references auth.users(id) on delete restrict,
  removed_at timestamptz,
  removal_reason text,
  constraint return_manifest_lines_removed_ck check (
    (removed_at is null and removed_by is null and removal_reason is null)
    or (removed_at is not null and removed_by is not null and length(btrim(coalesce(removal_reason, ''))) between 5 and 300)),
  -- Lo recibido o faltante no se descarta: la recepción no se deshace desde aquí.
  constraint return_manifest_lines_removable_ck check (removed_at is null or outcome in ('held', 'info')),
  constraint return_manifest_lines_received_ck check (
    outcome <> 'received' or (shipment_id is not null and receipt_outcome is not null and dispatch_event_id is not null)),
  constraint return_manifest_lines_missing_ck check (
    outcome <> 'missing' or (shipment_id is not null and expected and dispatch_item_id is not null)),
  constraint return_manifest_lines_identified_ck check (shipment_id is not null or 'no_identificada' = any(flags))
);
-- Re-aplicar converge: el enlace a la parada nunca bloquea borrar una pendiente.
alter table public.return_manifest_lines drop constraint if exists return_manifest_lines_stop_id_fkey;
alter table public.return_manifest_lines add constraint return_manifest_lines_stop_id_fkey
  foreign key (stop_id) references public.delivery_stops(id) on delete set null;
create unique index if not exists return_manifest_lines_one_per_output
  on public.return_manifest_lines(manifest_id, shipment_id)
  where removed_at is null and shipment_id is not null;
create unique index if not exists return_manifest_lines_one_per_unknown_code
  on public.return_manifest_lines(manifest_id, upper(btrim(scanned_code)))
  where removed_at is null and shipment_id is null;
create index if not exists return_manifest_lines_shipment on public.return_manifest_lines(shipment_id) where shipment_id is not null;
create index if not exists return_manifest_lines_manifest on public.return_manifest_lines(manifest_id, scanned_at);

alter table public.return_manifests enable row level security;
alter table public.return_manifest_lines enable row level security;
revoke all on public.return_manifests from public, anon, authenticated;
revoke all on public.return_manifest_lines from public, anon, authenticated;
grant select on public.return_manifests to authenticated;
grant select on public.return_manifest_lines to authenticated;
grant all on public.return_manifests to service_role;
grant all on public.return_manifest_lines to service_role;
drop policy if exists return_manifests_select on public.return_manifests;
create policy return_manifests_select on public.return_manifests for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists return_manifest_lines_select on public.return_manifest_lines;
create policy return_manifest_lines_select on public.return_manifest_lines for select to authenticated
  using (store_id in (select auth_store_ids()) or (store_id is null and org_id in (select auth_org_ids())));
-- Sin policies de escritura: escriben las acciones del servidor (service role)
-- y las funciones de abajo.

-- El candado: lo cerrado o anulado no se toca. La cabecera abierta solo cambia
-- sus campos de entrega; el estado lo cambian `return_manifest_close` y
-- `return_manifest_cancel` (GUC `return_manifest.state`, como `gf.withdraw`).
-- Cerrado, solo se le pueden AÑADIR fotos (el acta firmada llega después).
create or replace function public.return_manifests_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
declare v_flow text := coalesce(current_setting('return_manifest.state', true), '');
begin
  if tg_op = 'DELETE' then raise exception 'Un manifiesto de devolución no se borra: se anula.'; end if;
  if new.id <> old.id or new.org_id <> old.org_id or new.courier <> old.courier
     or new.rider_id is distinct from old.rider_id or new.created_by <> old.created_by
     or new.created_at <> old.created_at or new.cadence_days <> old.cadence_days
     or new.arrived_on <> old.arrived_on then
    raise exception 'La identidad del manifiesto de devolución no cambia.';
  end if;
  if old.state <> 'open' then
    if old.state = 'closed' and new.state = 'closed'
       and (to_jsonb(new) - array['photo_paths', 'updated_at']) = (to_jsonb(old) - array['photo_paths', 'updated_at'])
       and new.photo_paths @> old.photo_paths then
      return new;
    end if;
    raise exception 'El manifiesto de devolución está %: no se modifica.', case old.state when 'closed' then 'cerrado' else 'anulado' end;
  end if;
  if new.state <> old.state and v_flow <> old.id::text then
    raise exception 'El manifiesto de devolución se cierra o se anula con su función.';
  end if;
  return new;
end $$;
revoke all on function public.return_manifests_guard() from public, anon, authenticated;
drop trigger if exists return_manifests_guard on public.return_manifests;
create trigger return_manifests_guard before update or delete on public.return_manifests
  for each row execute function public.return_manifests_guard();

-- Las líneas solo cambian con la cabecera abierta; al cerrar, solo la función
-- de cierre escribe las que faltaron. Nunca se borran: se descartan con motivo.
create or replace function public.return_manifest_lines_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
declare v_state text; v_org uuid; v_flow text := coalesce(current_setting('return_manifest.state', true), '');
begin
  if tg_op = 'DELETE' then raise exception 'Una línea del manifiesto de devolución no se borra: se descarta con motivo.'; end if;
  -- Se borró la parada pendiente que la línea citaba (`on delete set null`):
  -- solo se suelta el enlace, también en lo cerrado o descartado.
  if tg_op = 'UPDATE' and old.stop_id is not null and new.stop_id is null
     and (to_jsonb(new) - 'stop_id') = (to_jsonb(old) - 'stop_id') then
    return new;
  end if;
  -- FOR SHARE: espera a un cierre o una anulación en curso y relee el estado
  -- ya confirmado (una línea no cambia después de `closed_at`).
  select state, org_id into v_state, v_org from return_manifests where id = new.manifest_id for share;
  if v_org is null then raise exception 'Manifiesto de devolución inexistente.'; end if;
  if new.org_id <> v_org then raise exception 'La línea es de otra organización que su manifiesto.'; end if;
  if v_state <> 'open' and v_flow <> new.manifest_id::text then
    raise exception 'El manifiesto de devolución ya no está abierto: sus líneas no cambian.';
  end if;
  if tg_op = 'UPDATE' then
    if new.manifest_id <> old.manifest_id or new.org_id <> old.org_id
       or new.shipment_id is distinct from old.shipment_id then
      raise exception 'La línea no cambia de manifiesto ni de salida.';
    end if;
    -- Lo recibido queda recibido; lo faltante lo escribe solo el cierre.
    if old.outcome = 'received' and new.outcome <> 'received' then
      raise exception 'Una caja recibida no vuelve atrás desde el manifiesto.';
    end if;
    if old.removed_at is not null then raise exception 'Una línea descartada no cambia.'; end if;
  end if;
  if new.outcome = 'missing' and v_flow <> new.manifest_id::text then
    raise exception 'Las cajas que faltaron las anota el cierre del manifiesto.';
  end if;
  return new;
end $$;
revoke all on function public.return_manifest_lines_guard() from public, anon, authenticated;
drop trigger if exists return_manifest_lines_guard on public.return_manifest_lines;
create trigger return_manifest_lines_guard before insert or update or delete on public.return_manifest_lines
  for each row execute function public.return_manifest_lines_guard();

-- Abrir: una por courier y motorizado. Si ya hay una abierta, devuelve esa.
create or replace function public.return_manifest_open(
  p_org_id uuid, p_courier text, p_rider_id uuid, p_actor uuid, p_arrived_on date, p_cadence_days integer
) returns uuid language plpgsql security invoker set search_path = public as $$
declare v_id uuid; v_rider riders%rowtype; v_first text;
begin
  if p_actor is null or p_org_id is null or p_arrived_on is null then raise exception 'Falta organización, persona o día.'; end if;
  if p_courier <> 'propio' then raise exception 'Por ahora el manifiesto de devolución es de Grupo GF.'; end if;
  if not exists (select 1 from memberships where org_id = p_org_id and user_id = p_actor) then
    raise exception 'La persona no pertenece a la organización.';
  end if;
  select * into v_rider from riders where id = p_rider_id and org_id = p_org_id;
  if not found then raise exception 'Elige un motorizado de Grupo GF de la organización.'; end if;
  select id into v_id from return_manifests
   where org_id = p_org_id and courier = p_courier and rider_id = p_rider_id and state = 'open';
  if found then return v_id; end if;
  v_first := coalesce(nullif(split_part(btrim(v_rider.full_name), ' ', 1), ''), 'Motorizado');
  begin
    insert into return_manifests(org_id, courier, rider_id, driver_name, label, arrived_on, handed_over_by, cadence_days, created_by)
    values (p_org_id, p_courier, p_rider_id, v_rider.full_name,
            'Devolución · ' || v_first || ' · ' || to_char(p_arrived_on, 'DD/MM'),
            p_arrived_on, left(btrim(v_rider.full_name), 120), coalesce(p_cadence_days, 1), p_actor)
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from return_manifests
     where org_id = p_org_id and courier = p_courier and rider_id = p_rider_id and state = 'open';
  end;
  return v_id;
end $$;
revoke all on function public.return_manifest_open(uuid, text, uuid, uuid, date, integer) from public, anon, authenticated;
grant execute on function public.return_manifest_open(uuid, text, uuid, uuid, date, integer) to service_role;

-- La cabecera abierta, con candado, validada para quien escanea.
create or replace function public.return_manifest_lock_open(p_manifest_id uuid, p_actor uuid)
returns return_manifests language plpgsql security invoker set search_path = public as $$
declare v_header return_manifests%rowtype;
begin
  if p_actor is null then raise exception 'Falta quién recibe.'; end if;
  select * into v_header from return_manifests where id = p_manifest_id for update;
  if not found then raise exception 'Manifiesto de devolución inexistente.'; end if;
  if v_header.state <> 'open' then raise exception 'El manifiesto de devolución ya no está abierto.'; end if;
  if not exists (select 1 from memberships where org_id = v_header.org_id and user_id = p_actor) then
    raise exception 'La persona no pertenece a la organización del manifiesto.';
  end if;
  return v_header;
end $$;
revoke all on function public.return_manifest_lock_open(uuid, uuid) from public, anon, authenticated;
grant execute on function public.return_manifest_lock_open(uuid, uuid) to service_role;

-- Recibir dentro del manifiesto, en UNA transacción: candado de la cabecera,
-- luego la recepción de siempre (ítem y caja, `gf_return_to_office`) y la
-- línea. Un escaneo repetido actualiza la línea; no inserta otra.
create or replace function public.return_manifest_receive(
  p_manifest_id uuid, p_item_id uuid, p_actor uuid, p_scanned_code text, p_flags text[] default '{}', p_message text default null
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_header return_manifests%rowtype;
  v_item dispatch_manifest_items%rowtype;
  v_box dispatch_manifests%rowtype;
  v_stop delivery_stops%rowtype;
  v_ship shipments%rowtype;
  v_order uuid;
  v_event uuid;
  v_flags text[];
  v_outcome text;
  v_line uuid;
  v_store_cancelled boolean;
begin
  v_header := return_manifest_lock_open(p_manifest_id, p_actor);
  if v_header.courier <> 'propio' then raise exception 'Este manifiesto no recibe cajas de Grupo GF.'; end if;
  if p_flags is not null and not (p_flags <@ array['sin_reporte']::text[]) then
    raise exception 'Marca de línea no válida.';
  end if;
  select * into v_item from dispatch_manifest_items where id = p_item_id;
  if not found or v_item.removed_at is not null then raise exception 'Ese paquete ya no está en la caja.'; end if;
  select * into v_box from dispatch_manifests where id = v_item.manifest_id;
  if v_box.org_id <> v_header.org_id or v_box.courier <> 'propio' then raise exception 'La caja no es de Grupo GF de esta organización.'; end if;
  select * into v_ship from shipments where id = v_item.shipment_id;
  if not exists (select 1 from stores where id = v_ship.store_id and org_id = v_header.org_id) then
    raise exception 'La salida no es de esta organización.';
  end if;
  select * into v_stop from delivery_stops
   where shipment_id = v_item.shipment_id and dispatch_manifest_id = v_item.manifest_id
   order by reported_at desc nulls last limit 1;

  perform set_config('gf.return_manifest', p_manifest_id::text, true);
  v_order := gf_return_to_office(p_item_id, p_actor);
  perform set_config('gf.return_manifest', '', true);

  select id into v_event from dispatch_events
   where shipment_id = v_item.shipment_id and manifest_id = v_item.manifest_id and kind = 'returned_to_office'
   order by occurred_at desc limit 1;
  select * into v_ship from shipments where id = v_item.shipment_id;
  v_store_cancelled := exists(select 1 from orders where id = v_ship.order_id and cancelled_at is not null);
  v_outcome := case
    when v_ship.custody_state <> 'devuelto' then 'por_asignar'
    when gf_output_replaced(v_ship.id) then 'a_stock_reemplazada'
    when v_store_cancelled or exists(select 1 from woo_sale_returns where order_id = v_ship.order_id) then 'a_inventario_anulado'
    else 'ya_devuelta' end;
  v_flags := coalesce(p_flags, '{}');
  if v_box.rider_id is distinct from v_header.rider_id then v_flags := array_append(v_flags, 'otra_caja'); end if;
  if v_stop.outcome_reason = 'reprogramado' then v_flags := array_append(v_flags, 'reprogramado'); end if;

  insert into return_manifest_lines(manifest_id, org_id, store_id, shipment_id, scanned_code, dispatch_item_id,
      source_manifest_id, source_rider_id, source_route_date, stop_id, reported_status, reported_reason, expected,
      outcome, flags, receipt_outcome, dispatch_event_id, message, scanned_by)
  values (p_manifest_id, v_header.org_id, v_ship.store_id, v_ship.id, left(btrim(p_scanned_code), 200), v_item.id,
      v_box.id, v_box.rider_id, v_box.route_date, v_stop.id, v_stop.status, v_stop.outcome_reason,
      v_box.rider_id is not distinct from v_header.rider_id and not ('sin_reporte' = any(v_flags)),
      'received', v_flags, v_outcome, v_event, left(p_message, 600), p_actor)
  on conflict (manifest_id, shipment_id) where removed_at is null and shipment_id is not null do update
     set scanned_code = excluded.scanned_code, dispatch_item_id = excluded.dispatch_item_id,
         source_manifest_id = excluded.source_manifest_id, source_rider_id = excluded.source_rider_id,
         source_route_date = excluded.source_route_date, stop_id = excluded.stop_id,
         reported_status = excluded.reported_status, reported_reason = excluded.reported_reason,
         expected = excluded.expected, outcome = 'received', flags = excluded.flags,
         receipt_outcome = excluded.receipt_outcome, dispatch_event_id = excluded.dispatch_event_id,
         message = excluded.message, scan_count = return_manifest_lines.scan_count + 1, last_scanned_at = now()
  returning id into v_line;

  return jsonb_build_object('line_id', v_line, 'order_id', v_order, 'shipment_id', v_ship.id,
                            'receipt_outcome', v_outcome, 'flags', to_jsonb(v_flags), 'dispatch_event_id', v_event);
end $$;
revoke all on function public.return_manifest_receive(uuid, uuid, uuid, text, text[], text) from public, anon, authenticated;
grant execute on function public.return_manifest_receive(uuid, uuid, uuid, text, text[], text) to service_role;

-- Anotar una caja que NO se recibe (observación o información). Nunca pisa una
-- línea recibida: un escaneo repetido de lo ya recibido solo suma la lectura.
create or replace function public.return_manifest_note(
  p_manifest_id uuid, p_actor uuid, p_scanned_code text, p_outcome text, p_flags text[],
  p_shipment_id uuid default null, p_item_id uuid default null, p_message text default null, p_note text default null
) returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_header return_manifests%rowtype;
  v_ship shipments%rowtype;
  v_item dispatch_manifest_items%rowtype;
  v_box dispatch_manifests%rowtype;
  v_stop delivery_stops%rowtype;
  v_line uuid;
begin
  v_header := return_manifest_lock_open(p_manifest_id, p_actor);
  if p_outcome not in ('held', 'info') then raise exception 'Solo se anota una observación o una información.'; end if;
  if p_flags is null or cardinality(p_flags) = 0 or not (p_flags <@ array['otra_caja', 'sin_reporte', 'reportada_entregada', 'ya_recibida', 'no_identificada', 'reprogramado']::text[]) then
    raise exception 'Marca de línea no válida.';
  end if;
  if p_shipment_id is null then
    if not ('no_identificada' = any(p_flags)) then raise exception 'Sin salida, la caja es «no identificada».'; end if;
    insert into return_manifest_lines(manifest_id, org_id, scanned_code, outcome, flags, message, note, scanned_by)
    values (p_manifest_id, v_header.org_id, left(btrim(p_scanned_code), 200), p_outcome, p_flags, left(p_message, 600), left(p_note, 600), p_actor)
    on conflict (manifest_id, upper(btrim(scanned_code))) where removed_at is null and shipment_id is null do update
       set scan_count = return_manifest_lines.scan_count + 1, last_scanned_at = now(),
           note = coalesce(excluded.note, return_manifest_lines.note)
    returning id into v_line;
    return v_line;
  end if;

  select * into v_ship from shipments where id = p_shipment_id;
  if not found or not exists (select 1 from stores where id = v_ship.store_id and org_id = v_header.org_id) then
    raise exception 'La salida no es de esta organización.';
  end if;
  if p_item_id is not null then
    select * into v_item from dispatch_manifest_items where id = p_item_id and shipment_id = p_shipment_id;
    if not found then raise exception 'Ese paquete no es de esa salida.'; end if;
    select * into v_box from dispatch_manifests where id = v_item.manifest_id;
    if v_box.org_id <> v_header.org_id then raise exception 'La caja es de otra organización.'; end if;
    select * into v_stop from delivery_stops
     where shipment_id = p_shipment_id and dispatch_manifest_id = v_item.manifest_id
     order by reported_at desc nulls last limit 1;
  end if;

  insert into return_manifest_lines(manifest_id, org_id, store_id, shipment_id, scanned_code, dispatch_item_id,
      source_manifest_id, source_rider_id, source_route_date, stop_id, reported_status, reported_reason,
      expected, outcome, flags, message, note, scanned_by)
  values (p_manifest_id, v_header.org_id, v_ship.store_id, v_ship.id, left(btrim(p_scanned_code), 200), v_item.id,
      v_box.id, v_box.rider_id, v_box.route_date, v_stop.id, v_stop.status, v_stop.outcome_reason,
      false, p_outcome, p_flags, left(p_message, 600), left(p_note, 600), p_actor)
  on conflict (manifest_id, shipment_id) where removed_at is null and shipment_id is not null do update
     set scan_count = return_manifest_lines.scan_count + 1, last_scanned_at = now(),
         -- Lo recibido queda como está; una observación se actualiza con lo de ahora.
         outcome = case when return_manifest_lines.outcome = 'received' then 'received' else excluded.outcome end,
         flags = case when return_manifest_lines.outcome = 'received' then return_manifest_lines.flags else excluded.flags end,
         message = case when return_manifest_lines.outcome = 'received' then return_manifest_lines.message else excluded.message end,
         reported_status = case when return_manifest_lines.outcome = 'received' then return_manifest_lines.reported_status else excluded.reported_status end,
         reported_reason = case when return_manifest_lines.outcome = 'received' then return_manifest_lines.reported_reason else excluded.reported_reason end,
         note = coalesce(excluded.note, return_manifest_lines.note)
  returning id into v_line;
  return v_line;
end $$;
revoke all on function public.return_manifest_note(uuid, uuid, text, text, text[], uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.return_manifest_note(uuid, uuid, text, text, text[], uuid, uuid, text, text) to service_role;

-- Lo esperado de un motorizado: cada paquete activo en una caja propia suya
-- cuya última parada en ESA caja es «No entregado» (el criterio de
-- `gf_return_to_office`, sin filtrar el estado de la caja). La edad se mide
-- desde el día de ruta de la caja, nunca desde `reported_at`.
create or replace function public.return_manifest_expected(p_org_id uuid, p_rider_id uuid)
returns table(item_id uuid, shipment_id uuid, store_id uuid, manifest_id uuid, route_date date,
              stop_id uuid, outcome_reason text)
language sql stable security invoker set search_path = public as $$
  select i.id, i.shipment_id, s.store_id, m.id, m.route_date, st.id, st.outcome_reason
    from dispatch_manifest_items i
    join dispatch_manifests m on m.id = i.manifest_id
    join shipments s on s.id = i.shipment_id
    join lateral (
      select ds.id, ds.status, ds.outcome_reason from delivery_stops ds
       where ds.shipment_id = i.shipment_id and ds.dispatch_manifest_id = i.manifest_id
       order by ds.reported_at desc nulls last limit 1
    ) st on true
   where i.removed_at is null and m.org_id = p_org_id and m.courier = 'propio' and m.rider_id = p_rider_id
     and st.status = 'no_entregado';
$$;
revoke all on function public.return_manifest_expected(uuid, uuid) from public, anon, authenticated;
grant execute on function public.return_manifest_expected(uuid, uuid) to service_role;

-- Cerrar: pide «Entregó», anota como faltantes las esperadas fuera de plazo
-- que no llegaron (reprogramado: más de 14 días), y congela el manifiesto.
-- No cambia ningún pedido ni ninguna salida.
create or replace function public.return_manifest_close(p_manifest_id uuid, p_actor uuid, p_handed_over_by text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_header return_manifests%rowtype;
  v_missing integer := 0;
  v_unnoted integer;
  v_pending jsonb := '{}'::jsonb;
begin
  v_header := return_manifest_lock_open(p_manifest_id, p_actor);
  if length(btrim(coalesce(p_handed_over_by, ''))) < 3 then raise exception 'Escribe quién entregó las cajas (al menos 3 letras).'; end if;
  select count(*) into v_unnoted from return_manifest_lines
   where manifest_id = p_manifest_id and removed_at is null and 'no_identificada' = any(flags)
     and length(btrim(coalesce(note, ''))) < 3;
  if v_unnoted > 0 then
    raise exception 'Hay % caja(s) no identificada(s) sin nota: anota qué es o descártala.', v_unnoted;
  end if;
  perform set_config('return_manifest.state', p_manifest_id::text, true);
  if v_header.courier = 'propio' then
    insert into return_manifest_lines(manifest_id, org_id, store_id, shipment_id, scanned_code, dispatch_item_id,
        source_manifest_id, source_rider_id, source_route_date, stop_id, reported_status, reported_reason,
        expected, outcome, flags, scanned_by, scanned_at)
    select p_manifest_id, v_header.org_id, e.store_id, e.shipment_id,
           coalesce(s.output_code, s.guide_code, e.shipment_id::text), e.item_id,
           e.manifest_id, v_header.rider_id, e.route_date, e.stop_id, 'no_entregado', e.outcome_reason,
           true, 'missing', case when e.outcome_reason = 'reprogramado' then array['reprogramado'] else '{}'::text[] end,
           p_actor, now()
      from return_manifest_expected(v_header.org_id, v_header.rider_id) e
      join shipments s on s.id = e.shipment_id
     where (v_header.arrived_on - e.route_date) > case when e.outcome_reason = 'reprogramado' then 14 else v_header.cadence_days end
       and not exists (select 1 from return_manifest_lines l
                        where l.manifest_id = p_manifest_id and l.shipment_id = e.shipment_id and l.removed_at is null)
    on conflict do nothing;
    get diagnostics v_missing = row_count;
    -- Lo que sigue DENTRO de plazo y no llegó: no se anota, pero se cuenta
    -- (por tienda) para que «esperados» no cambie al cerrar.
    select coalesce(jsonb_object_agg(x.store_key, x.counts), '{}'::jsonb) into v_pending
      from (
        select coalesce(e.store_id::text, '') as store_key,
               jsonb_build_object(
                 'con_el_motorizado', count(*) filter (where e.outcome_reason is distinct from 'reprogramado'),
                 'reprogramado', count(*) filter (where e.outcome_reason = 'reprogramado')) as counts
          from return_manifest_expected(v_header.org_id, v_header.rider_id) e
         where not ((v_header.arrived_on - e.route_date) > case when e.outcome_reason = 'reprogramado' then 14 else v_header.cadence_days end)
           and not exists (select 1 from return_manifest_lines l
                            where l.manifest_id = p_manifest_id and l.shipment_id = e.shipment_id and l.removed_at is null)
         group by 1
      ) x;
  end if;
  update return_manifests
     set state = 'closed', closed_at = now(), closed_by = p_actor,
         handed_over_by = left(btrim(p_handed_over_by), 120), pending_at_close = v_pending, updated_at = now()
   where id = p_manifest_id;
  perform set_config('return_manifest.state', '', true);
  return jsonb_build_object('missing', v_missing, 'pending_at_close', v_pending);
end $$;
revoke all on function public.return_manifest_close(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.return_manifest_close(uuid, uuid, text) to service_role;

-- Anular: solo sin cajas recibidas, con motivo.
create or replace function public.return_manifest_cancel(p_manifest_id uuid, p_actor uuid, p_reason text)
returns void language plpgsql security invoker set search_path = public as $$
declare v_header return_manifests%rowtype;
begin
  v_header := return_manifest_lock_open(p_manifest_id, p_actor);
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'Escribe el motivo de la anulación (al menos 5 letras).'; end if;
  if exists (select 1 from return_manifest_lines where manifest_id = p_manifest_id and outcome = 'received') then
    raise exception 'Ya se recibieron cajas en este manifiesto: ciérralo en vez de anularlo.';
  end if;
  perform set_config('return_manifest.state', p_manifest_id::text, true);
  update return_manifests
     set state = 'cancelled', cancelled_at = now(), cancelled_by = p_actor,
         cancellation_reason = left(btrim(p_reason), 500), updated_at = now()
   where id = p_manifest_id;
  perform set_config('return_manifest.state', '', true);
end $$;
revoke all on function public.return_manifest_cancel(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.return_manifest_cancel(uuid, uuid, text) to service_role;
