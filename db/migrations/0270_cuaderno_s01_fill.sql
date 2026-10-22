-- ============================================================================
-- 0270_cuaderno_s01_fill.sql — la caja «por definir» que el cuaderno de Grupo
-- GF da por entregada pasa a ser la salida entregada del motorizado propio
-- (decisión del dueño del 19-10-2026; MOM §30.8, §4).
--
-- POR QUÉ. La carga histórica del cuaderno (scripts/apply-cuaderno-history-to-
-- master.ts) y «Aplicar al Master» de Liquidaciones 2 escribían solo el
-- `status_override` del pedido. La caja S01 se había armado y rotulado como
-- salida «por definir» y nadie le puso el courier: el pedido quedaba entregado
-- con su salida pendiente y la mesa de cierre pedía «Salida adicional activa».
-- Medido el 20-10-2026: 581 pedidos en la clase `cuaderno_caja_sin_registrar`
-- de la auditoría del atraso de Lima (437 de Kenku), con la entrega en el
-- cuaderno de Alexis (552) o de Reparto propio (23). Desde este cambio el código
-- rellena la caja al aplicar la entrega (lib/own-salida.ts); esto rellena las
-- que ya estaban aplicadas.
--
-- QUÉ TOCA, Y NADA MÁS. La salida de un pedido que cumple TODO esto:
--   · Lima, «Por cerrar · Salida adicional activa», con el estado puesto a mano
--     (`status_source = manual`) y no anulado en Shopify;
--   · su ÚNICA salida viva es la «por definir» de ruta manual, pendiente, en la
--     empresa, nunca transferida y escaneada «listo despacho» —la misma regla
--     con la que el código decide qué caja rellenar—;
--   · su último `status_override` es «entregado», de Alexis o de Reparto propio
--     (`courier` alexis o propio), con el día del cuaderno en `payload.fecha`
--     (hasta el 21-10-2026: lo posterior lo rellena el código);
--   · ninguna otra salida del pedido está entregada y Urpi no lo reportó (si lo
--     reportó, su caja va por el flujo de Urpi, §30.11);
--   · ninguna fila de hoja posterior al día del cuaderno lo da por devuelto,
--     anulado o sin salida (`cuaderno_contradicho`);
--   · el día del cuaderno no es más de 30 días anterior a la caja
--     (`cuaderno_fecha_imposible`) ni anterior a que estuviera lista
--     (`cuaderno_caja_dudosa`: más de un día antes de `ready_at`, o de su
--     creación si no lo tiene).
-- Es la clase `cuaderno_caja_sin_registrar` de la auditoría con la salida «por
-- definir», el override de Alexis o propio y la fecha: 575 pedidos medidos el
-- 21-10-2026 (432 de Kenku Peru, 143 de Aurela), todos con su S01 y con días
-- del cuaderno del 10-08 al 15-09-2026.
--
-- QUÉ ESCRIBE. Lo mismo que el código (`ownSalidaRow`, lib/own-salida.ts):
-- courier `propio`, `created_via` y `delivered_source` `cuaderno_gf`, entregada
-- (`delivered`), la guía interna `MOM-<pedido>-PROPIO-<id>` (`manualRouteGuideCode`)
-- y `dispatched_at` = `closed_at` = el día del cuaderno a mediodía de Lima
-- (17:00Z), como el evento de la entrega: `closed_at` es de donde el Master saca
-- el día de la entrega. La vigencia de la tarifa de Grupo GF no sale de ahí
-- sino del último movimiento (`costDay`, lib/costs.ts, MOM §14), y este relleno
-- —el UPDATE y su evento— lo mueve al día en que se aplica: estos pedidos toman
-- la tarifa del Tarifario vigente ese día. Lo de la caja
-- —consecutivo, `output_code`, QR, preparación, custodia— no se toca. Por cada
-- salida, un `route_output_filled` (el rastro que `writeCourierGuide` deja al
-- rellenar) con `payload` {outputCode, previousCourier, backfill, rider, fecha}.
--
-- QUÉ NO HACE. No cierra ninguna liquidación (decisión 3): los pedidos dejan
-- «Salida adicional activa» y pasan a Pendiente de liquidación. No crea salidas
-- ni toca las de otros couriers.
--
-- EL RECÁLCULO. El UPDATE mueve `shipments.updated_at` (`shipments_touch`,
-- 0204), así que `order_master_stale` (0123, 0240, 0265) da esos pedidos por
-- desfasados y el barrido del Master los recalcula solo; la subida a
-- `mom-v1.31` los recalcula también.
--
-- Correrla otra vez no cambia nada: la salida rellenada ya no es «por
-- definir» y el evento solo se escribe para la fila que se actualizó.
-- ============================================================================

do $$
declare
  v_filled int;
begin
  with pop as (
    select om.order_id, om.store_id, om.order_name
      from order_master om
      join orders o on o.id = om.order_id
     where om.coverage = 'lima'
       and om.macro_stage = 'por_cerrar'
       and om.macro_substage = 'salida_adicional_activa'
       and om.status_source = 'manual'
       and o.cancelled_at is null
  ),
  -- Las salidas vivas, como en la auditoría y en `planOwnSalida`.
  live as (
    select x.id, x.order_id, x.output_code, x.courier, x.created_via, x.delivery_status, x.custody_state,
           x.custody_transferred_at, x.preparation_state, x.ready_at, x.created_at
      from shipments x
      join pop p on p.order_id = x.order_id
     where x.delivery_status in ('pendiente', 'en_ruta')
       and x.returned_at is null
       and coalesce(x.custody_state, '') <> 'devuelto'
  ),
  a as (
    select distinct on (l.order_id) l.*, count(*) over (partition by l.order_id) as n_live
      from live l
     order by l.order_id, l.created_at desc
  ),
  ov as (
    select distinct on (e.order_id) e.order_id, lower(btrim(e.courier)) as rider, e.new_status,
           e.payload->>'fecha' as fecha, e.occurred_at
      from order_events e
      join pop p on p.order_id = e.order_id
     where e.kind = 'status_override'
     order by e.order_id, e.occurred_at desc, e.created_at desc
  ),
  target as (
    select p.order_id, p.store_id, a.id as shipment_id, ov.rider, ov.fecha,
           -- `manualRouteGuideCode(order_name, id, 'propio')` (lib/shipment-output.ts).
           'MOM-' || coalesce(
             nullif(regexp_replace(regexp_replace(upper(regexp_replace(btrim(coalesce(p.order_name, '')), '^#+', '')),
                                                  '[^A-Z0-9_-]+', '', 'g'), '_+', '-', 'g'), ''),
             upper(left(a.id::text, 8))
           ) || '-PROPIO-' || upper(left(a.id::text, 8)) as guide_code
      from pop p
      join a on a.order_id = p.order_id
      join ov on ov.order_id = p.order_id
     where a.n_live = 1
       and a.courier = 'por_definir'
       and a.created_via = 'mom_manual_route'
       and a.delivery_status = 'pendiente'
       and coalesce(a.custody_state, 'empresa') = 'empresa'
       and a.custody_transferred_at is null
       and a.preparation_state = 'listo_despacho'
       and ov.new_status = 'entregado'
       and ov.rider in ('alexis', 'propio')
       and ov.fecha ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
       and ov.fecha <= '2026-10-21'
       and not exists (select 1 from shipments y where y.order_id = p.order_id and y.delivery_status = 'entregado')
       and not exists (select 1 from urpi_report_rows r where r.order_id = p.order_id)
       and (ov.occurred_at at time zone 'America/Lima')::date >= (a.created_at at time zone 'America/Lima')::date - 30
       and ov.occurred_at >= coalesce(a.ready_at, a.created_at) - interval '1 day'
       and not exists (
         select 1
           from sheet_rows r
           join sheets sh on sh.id = r.sheet_id
           join sheet_domain_statuses st on st.domain_id = sh.domain_id and st.code = r.values->>'estado'
          where r.order_id = p.order_id
            and r.values->>'fecha' > ov.fecha
            and st.effect in ('devolucion', 'anulacion', 'sin_salida')
       )
  ),
  -- Las mismas guardas que el UPDATE de `writeCourierGuide`.
  filled as (
    update shipments s
       set courier = 'propio',
           created_via = 'cuaderno_gf',
           guide_code = t.guide_code,
           delivery_status = 'entregado',
           status_category = 'delivered',
           delivered_source = 'cuaderno_gf',
           dispatched_at = (t.fecha || 'T17:00:00Z')::timestamptz,
           closed_at = (t.fecha || 'T17:00:00Z')::timestamptz
      from target t
     where s.id = t.shipment_id
       and s.delivery_status = 'pendiente'
       and s.courier = 'por_definir'
       and s.created_via = 'mom_manual_route'
       and s.custody_transferred_at is null
       and not exists (select 1 from shipments z where z.courier = 'propio' and z.guide_code = t.guide_code)
    returning s.id, s.store_id, s.order_id, s.output_code, s.guide_code, t.rider, t.fecha
  )
  insert into order_events (store_id, order_id, kind, occurred_at, source, courier, guide_code, shipment_id, note, payload)
  select f.store_id, f.order_id, 'route_output_filled', now(), 'manual', 'propio', f.guide_code, f.id,
         coalesce(f.output_code, 'La salida') || ' tenía courier por definir; el cuaderno de '
           || case f.rider when 'alexis' then 'Alexis' else 'Reparto propio' end
           || ' la da por entregada el ' || to_char(f.fecha::date, 'DD/MM/YYYY')
           || ': pasó a salida entregada de Grupo GF Courier (relleno 0270).',
         jsonb_build_object('outputCode', f.output_code, 'previousCourier', 'por_definir', 'backfill', true,
                            'rider', f.rider, 'fecha', f.fecha)
    from filled f;
  get diagnostics v_filled = row_count;
  raise notice '0270: % caja(s) «por definir» pasaron a salida entregada de Grupo GF', v_filled;
end $$;
