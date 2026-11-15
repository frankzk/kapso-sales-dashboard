-- ============================================================================
-- 0337_gf_replaced_by_aliclik.sql — la guía de Aliclik deja «en devolución» la
-- caja de Grupo GF que el motorizado todavía tiene «No entregado».
--
-- EL CASO (owner, 12-11-2026: «de acuerdo»). #KP203491, Lima. Alexis (Grupo
-- GF) reportó KP203491-S01 «No entregado · no contesta» el 07-11 y todavía la
-- tiene: `propio · pendiente`, custodia `courier`, sin recibir en oficina. El
-- 11-11 una asesora creó desde la ficha la guía del reintento por Aliclik: la
-- KP203491-S02, `aliclik`, custodia `empresa`, armada desde stock, con el
-- motivo «Salida adicional por Aliclik con 1 salida(s) todavía viva(s)». El
-- pedido seguía en «En curso · Por reprogramar Lima» y en «Reintentos
-- Aliclik»: el «No entregado» de la S01 solo dejaba de mandar con un
-- movimiento posterior de ESA salida (asignarla, «Lo llevo», custodia,
-- entrega), y una guía de otro courier no lo es.
--
-- LA REGLA. Es «Sacar con salida nueva» (0248, MOM §9.3 y §29.13) con la
-- salida nueva de Aliclik: la caja anterior queda en devolución a nombre del
-- motorizado (custodia `retorno` y el evento `output_replaced`, la marca de
-- `gf_output_replaced`) y, al recibirla en oficina, `gf_return_to_office`
-- (rama «a stock», 0248/0307) la desarma y la devuelve a stock: no vuelve a
-- «por asignar». El pedido sigue a la guía de Aliclik y sale de «Por
-- reprogramar Lima», de «Reintentos Aliclik» y de Repro Lima. MOM §9.5.
--
-- QUÉ CAMBIA:
--
--   a) `gf_replace_output_with_aliclik(guía, actor)`: la llama Kapta después
--      de guardar la guía de Aliclik (`createAliclikGuideFor` y el rescate de
--      la huérfana en `/api/cron/aliclik-reconcile`). Busca las salidas de
--      Grupo GF del MISMO pedido de Lima que siguen con el motorizado
--      (`propio · pendiente`, custodia `courier`, sin `returned_at`, sin
--      reemplazo) cuya ÚLTIMA parada dice «No entregado» desde ANTES de que
--      naciera la guía, y a cada una:
--        · la pasa a custodia `retorno` (conserva su parada, su lugar en la
--          caja y `dispatched_at`, como la 0248);
--        · CIERRA su solicitud viva de Grupo GF (`cancelled`, con un
--          `logistics_request_events` `output_replaced`): a diferencia de la
--          0248 no pasa a la salida nueva, que no es de Grupo GF;
--        · escribe `output_replaced` en el pedido (sobre la salida anterior,
--          con `replaced_by`/`replaced_by_code` de la guía de Aliclik y
--          `replaced_by_courier = aliclik`) y, si está en una caja, en
--          `dispatch_events`.
--      La parada fallida del motorizado NO se toca: sigue en su ruta, cuenta
--      en su paga y en la cadena de reintentos; desde ahora la guarda
--      `delivery_stops_guard_replaced` (0248) no deja cambiarle el estado.
--      Idempotente y sin error: lo que no cumple se salta y la respuesta dice
--      por qué. Sin `security definer`; solo `service_role`.
--   b) El barrido de lo que ya está así (#KP203491 y los demás): la misma
--      función sobre cada guía de Aliclik viva de un pedido de Lima que tenga
--      una caja de Grupo GF con el motorizado. Correrla dos veces no cambia
--      nada. El Master se recalcula solo: cambiar la custodia mueve
--      `shipments.updated_at` y el barrido `master-reconcile` (cada 10 min)
--      recalcula esos pedidos (`order_master_stale`, 0123).
--
-- Aplicar a mano ANTES de desplegar el código (DEPLOY.md). Sin `begin`/`commit`
-- propios, como el resto de migraciones.
-- ============================================================================

create or replace function public.gf_replace_output_with_aliclik(
  p_guide_shipment uuid,
  p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_new shipments%rowtype;
  v_old shipments%rowtype;
  v_item dispatch_manifest_items%rowtype;
  v_manifest dispatch_manifests%rowtype;
  v_stop delivery_stops%rowtype;
  v_guide_at timestamptz;
  v_route_date date;
  v_rider text;
  v_rider_id uuid;
  v_old_code text;
  v_new_code text;
  v_note text;
  v_req uuid;
  v_candidate uuid;
  v_done jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  select * into v_new from shipments where id = p_guide_shipment;
  if not found then return jsonb_build_object('replaced', v_done, 'skipped', 'no_existe'); end if;
  if v_new.order_id is null then return jsonb_build_object('replaced', v_done, 'skipped', 'sin_pedido'); end if;
  -- La guía de Aliclik viva o ya ENTREGADA (13-11-2026, #KP203491: Aliclik lo
  -- entregó con la caja de stock y la de Grupo GF seguía «viva» con Alexis,
  -- dejando el pedido en «salida adicional activa»). Una anulada o devuelta no
  -- saca el pedido.
  if lower(trim(coalesce(v_new.courier, ''))) <> 'aliclik'
     or v_new.delivery_status not in ('pendiente', 'en_ruta', 'entregado')
     or v_new.returned_at is not null or coalesce(v_new.custody_state, '') = 'devuelto' then
    return jsonb_build_object('replaced', v_done, 'skipped', 'no_es_guia_aliclik_viva');
  end if;
  -- Solo Lima: fuera de Lima no hay salida adicional con otra viva (§9).
  if not exists (select 1 from order_master where order_id = v_new.order_id and coverage = 'lima') then
    return jsonb_build_object('replaced', v_done, 'skipped', 'no_es_lima');
  end if;
  -- Cuándo nació la guía: una «por definir» rellenada conserva su `created_at`
  -- y la guía se le escribió al asignarla (`assigned_at`).
  v_guide_at := greatest(v_new.created_at, v_new.assigned_at);

  for v_candidate in
    select s.id from shipments s
     where s.order_id = v_new.order_id and s.id <> v_new.id
       and lower(trim(s.courier)) = 'propio' and s.delivery_status = 'pendiente'
       and s.custody_state = 'courier' and s.returned_at is null
     order by s.output_number nulls last, s.created_at
  loop
    -- El mismo orden de candados que `gf_replace_output` y `gf_return_to_office`
    -- (ítem, caja, parada, salida): un «Recibir en oficina» simultáneo no se
    -- cruza con esto.
    v_item := null; v_manifest := null; v_stop := null;
    select * into v_item from dispatch_manifest_items
     where shipment_id = v_candidate and removed_at is null
     order by created_at desc limit 1 for update;
    if v_item.id is not null then
      select * into v_manifest from dispatch_manifests where id = v_item.manifest_id for update;
    end if;
    -- La última parada de ESTA salida, en cualquier ruta (como la 0305).
    select * into v_stop from delivery_stops
     where shipment_id = v_candidate
     order by created_at desc, reported_at desc nulls last
     limit 1 for update;
    select * into v_old from shipments where id = v_candidate for update;

    -- Releído con candado.
    if lower(trim(v_old.courier)) <> 'propio' or v_old.delivery_status <> 'pendiente'
       or v_old.custody_state is distinct from 'courier' or v_old.returned_at is not null then
      v_skipped := v_skipped || jsonb_build_object('shipment_id', v_candidate, 'why', 'ya_no_esta_con_el_motorizado');
      continue;
    end if;
    if gf_output_replaced(v_old.id) then
      v_skipped := v_skipped || jsonb_build_object('shipment_id', v_candidate, 'why', 'ya_reemplazada');
      continue;
    end if;
    if v_stop.id is null or v_stop.status <> 'no_entregado' then
      v_skipped := v_skipped || jsonb_build_object('shipment_id', v_candidate, 'why', 'sin_no_entregado');
      continue;
    end if;
    if coalesce(v_stop.reported_at, v_stop.created_at) >= v_guide_at then
      v_skipped := v_skipped || jsonb_build_object('shipment_id', v_candidate, 'why', 'no_entregado_posterior_a_la_guia');
      continue;
    end if;
    if v_item.id is not null and (v_manifest.courier is distinct from 'propio'
       or v_stop.dispatch_manifest_id is distinct from v_item.manifest_id) then
      -- En una caja que no es de Grupo GF, o con otra parada que la de su caja:
      -- se revisa a mano.
      v_skipped := v_skipped || jsonb_build_object('shipment_id', v_candidate, 'why', 'caja_sin_su_reporte');
      continue;
    end if;

    select dr.route_date, dr.rider_id, r.full_name into v_route_date, v_rider_id, v_rider
      from delivery_routes dr left join riders r on r.id = dr.rider_id
     where dr.id = v_stop.route_id;
    v_rider := coalesce(v_manifest.driver_name, v_rider, 'el motorizado');
    v_rider_id := coalesce(v_manifest.rider_id, v_rider_id);
    v_route_date := coalesce(v_manifest.route_date, v_route_date);
    v_old_code := coalesce(v_old.output_code, v_old.guide_code, 'La salida anterior');
    v_new_code := coalesce(v_new.output_code, v_new.guide_code, 'la guía de Aliclik');
    v_note := left(v_old_code || ' sigue con ' || v_rider || ' (en devolución): el pedido sale por Aliclik con '
      || v_new_code || coalesce(' (' || nullif(v_new.guide_code, v_new_code) || ')', '')
      || '. Al recibirla en oficina se desarma y vuelve a stock.', 300);

    update shipments set custody_state = 'retorno' where id = v_old.id;

    -- La solicitud de Grupo GF de la caja anterior se cierra: el pedido ya no
    -- sale con Grupo GF. La parada fallida queda en la ruta del motorizado.
    v_req := null;
    update logistics_requests
       set status = 'cancelled', observation = v_note
     where shipment_id = v_old.id and status not in ('cancelled', 'completed')
    returning id into v_req;
    if v_req is not null then
      insert into logistics_request_events(request_id, kind, status, actor, note, payload)
      values (v_req, 'output_replaced', 'cancelled', p_actor, v_note,
              jsonb_build_object('from', v_old.id, 'from_code', v_old.output_code,
                                 'to', v_new.id, 'to_code', v_new.output_code,
                                 'to_courier', 'aliclik', 'to_guide', v_new.guide_code));
    end if;

    if v_item.id is not null then
      insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
      values (v_manifest.org_id, v_item.manifest_id, v_old.id, p_actor, 'output_replaced',
              jsonb_build_object('stop_id', v_stop.id, 'outcome_reason', v_stop.outcome_reason,
                                 'replaced_by', v_new.id, 'replaced_by_code', v_new.output_code,
                                 'replaced_by_courier', 'aliclik', 'replaced_by_guide', v_new.guide_code));
    end if;
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (v_old.store_id, v_old.order_id, 'output_replaced', p_actor, 'aliclik', 'propio',
            v_old.guide_code, v_old.id, v_stop.outcome_reason, v_note,
            jsonb_build_object('replaced_by', v_new.id, 'replaced_by_code', v_new.output_code,
                               'replaced_by_courier', 'aliclik', 'replaced_by_guide', v_new.guide_code,
                               'manifest_id', v_item.manifest_id, 'rider_id', v_rider_id,
                               'route_date', v_route_date, 'stop_id', v_stop.id,
                               'outcome_reason', v_stop.outcome_reason, 'request_id', v_req,
                               'request_closed', v_req is not null));

    v_done := v_done || jsonb_build_object('shipment_id', v_old.id, 'old_code', v_old.output_code,
                                           'rider', v_rider, 'route_date', v_route_date, 'request_id', v_req);
  end loop;

  return jsonb_build_object('order_id', v_new.order_id, 'new_code', v_new.output_code,
                            'replaced', v_done, 'skipped', v_skipped);
end;
$$;

revoke all on function public.gf_replace_output_with_aliclik(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_replace_output_with_aliclik(uuid, uuid) to service_role;

-- b) Lo que ya está así ---------------------------------------------------------
-- La guía más antigua primero: si el pedido tiene varias de Aliclik vivas, la
-- caja anterior queda reemplazada por la primera que salió después de su
-- «No entregado». Las siguientes ya la encuentran reemplazada y no hacen nada.

do $$
declare
  r record;
begin
  for r in
    select a.id
      from shipments a
      join order_master om on om.order_id = a.order_id and om.coverage = 'lima'
     where lower(trim(a.courier)) = 'aliclik'
       and a.delivery_status in ('pendiente', 'en_ruta', 'entregado')
       and a.returned_at is null and coalesce(a.custody_state, '') <> 'devuelto'
       and exists (
         select 1 from shipments g
          where g.order_id = a.order_id and g.id <> a.id
            and lower(trim(g.courier)) = 'propio' and g.delivery_status = 'pendiente'
            and g.custody_state = 'courier' and g.returned_at is null
       )
     order by greatest(a.created_at, a.assigned_at), a.id
  loop
    perform public.gf_replace_output_with_aliclik(r.id, null);
  end loop;
end $$;
