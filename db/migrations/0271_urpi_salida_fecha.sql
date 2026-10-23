-- ============================================================================
-- 0271_urpi_salida_fecha.sql — la salida de Urpi rellenada lleva el día de la
-- entrega, y las cajas «por definir» de entregas viejas de Urpi pasan a su
-- salida entregada (MOM §30.11, §4; 23-10-2026).
--
-- POR QUÉ. Al rellenar la caja «por definir» como salida de Urpi
-- (`urpiSalidaRow`, lib/urpi-salida.ts) el código escribía `dispatched_at` (el
-- primer intento) pero no `closed_at`. El Master saca el día de la entrega de
-- `closed_at` de la salida entregada y, sin él, de su último movimiento
-- (lib/order-status.ts): el `delivered_at` de esos pedidos era el día en que se
-- rellenó, no el del reporte. Medido el 23-10-2026: 107 salidas con
-- `created_via = urpi_report`, todas entregadas y todas sin `closed_at`; en las
-- 107 la fila más reciente de Urpi del pedido es «Entregado» con fecha, y en 106
-- ese día no es el del relleno (días del 24-08 al 21-10-2026). Desde este cambio
-- el código escribe `closed_at`; esto (1) completa las que ya estaban.
--
-- Y (2): la carga del reporte rellena solo lo de los últimos 60 días
-- (`urpiDeliveredOrderIds`). Lo que Urpi entregó antes se quedó con su caja «por
-- definir» y en «Por cerrar · Salida adicional activa»: 32 pedidos medidos el
-- 23-10-2026, entregados en Kapta y no anulados, con reportes del 10-08 al
-- 22-08-2026. Otros 13 con la misma caja no están entregados en Kapta (12
-- anulados en Shopify): el flujo de Urpi tampoco los toca y quedan fuera.
--
-- 1) EL DÍA DE LA ENTREGA. A las salidas `created_via = urpi_report`
--    entregadas y sin `closed_at`, `closed_at` = el día de la fila más reciente
--    de Urpi del pedido (la de mayor `urpi_row`, la misma de la que el código
--    saca la entrega del Master), a mediodía de Lima (17:00Z) como el evento de
--    la entrega, solo si esa fila es «Entregado» y tiene fecha. Sin evento: no
--    se sobrescribe ningún hecho (MOM §2.6) —`closed_at` estaba vacío y el día
--    sale de la fila de Urpi, que se conserva con su historial—, la salida ya
--    tiene el `route_output_filled` de su relleno y lo que falta es un campo
--    que ese relleno tenía que haber escrito: el código lo escribe en el mismo
--    UPDATE del relleno, sin un evento aparte.
--
-- 2) LAS CAJAS VIEJAS. La salida de un pedido que cumple TODO esto, la misma
--    regla con la que el código decide (`planUrpiSalida`):
--   · su fila más reciente de Urpi es «Entregado», con fecha;
--   · está entregado en Kapta (`general_status = entregado`) y no anulado en
--     Shopify;
--   · no tiene ya una salida de Urpi entregada;
--   · su ÚNICA salida viva (pendiente o en ruta, sin custodia devuelta ni
--     `returned_at`) es la «por definir» de ruta manual, pendiente, en la
--     empresa y nunca transferida.
--    Escribe lo mismo que el código (`urpiSalidaRow`): courier `urpi`,
--    `created_via` y `delivered_source` `urpi_report`, entregada (`delivered`),
--    la guía interna `MOM-<pedido>-URPI-<id>` (`manualRouteGuideCode`),
--    `dispatched_at` = el día del primer intento de Urpi y `closed_at` = el de la
--    fila más reciente, los dos a las 17:00Z. Lo de la caja —consecutivo,
--    `output_code`, QR, preparación, custodia— no se toca. Por cada salida, un
--    `route_output_filled` (el rastro que deja `writeCourierGuide`) con
--    `payload` {outputCode, previousCourier, backfill, urpi_row, fecha}.
--
-- QUÉ NO HACE. No marca entregado ningún pedido (eso es de la puerta única,
-- §11.4), no crea salidas, no toca las de otros couriers ni cierra ninguna
-- liquidación: los 32 dejan «Salida adicional activa» y pasan a Pendiente de
-- liquidación, o a donde los lleve su liquidación si ya está cerrada.
--
-- EL RECÁLCULO. Los UPDATE mueven `shipments.updated_at` (`shipments_touch`,
-- 0204), así que `order_master_stale` (0123, 0240, 0265) da esos pedidos por
-- desfasados y el barrido del Master los recalcula solo: `delivered_at` pasa
-- al día del reporte. Como con la 0270, eso lleva su último movimiento —el día
-- al que se imputa el costo (MOM §14) y el que mira «Sin movimiento por 60
-- días» (§17.1)— al día en que se aplica, en los dos pasos.
--
-- Correrla otra vez no cambia nada: (1) solo toca salidas sin `closed_at`, y
-- (2) la salida rellenada ya no es «por definir» y el evento solo se escribe
-- para la fila que se actualizó.
-- ============================================================================

do $$
declare
  v_dated int;
  v_filled int;
begin
  -- 1) El día de la entrega en las salidas de Urpi ya rellenadas. `report_date`
  -- es `date`: el día + 17:00 leído en UTC, sin pasar por texto (no depende
  -- del `DateStyle` de la sesión).
  with latest as (
    select distinct on (r.order_id) r.order_id, r.result_code, r.report_date
      from urpi_report_rows r
     where r.order_id is not null
     order by r.order_id, r.urpi_row desc
  )
  update shipments s
     set closed_at = (l.report_date + time '17:00') at time zone 'UTC'
    from latest l
   where l.order_id = s.order_id
     and s.created_via = 'urpi_report'
     and s.delivery_status = 'entregado'
     and s.closed_at is null
     and l.result_code = 'entregado'
     and l.report_date is not null;
  get diagnostics v_dated = row_count;
  raise notice '0271: % salida(s) de Urpi con el día de la entrega', v_dated;

  -- 2) Las cajas «por definir» de entregas de Urpi que nunca se rellenaron.
  with latest as (
    select distinct on (r.order_id) r.order_id, r.urpi_row, r.result_code, r.report_date
      from urpi_report_rows r
     where r.order_id is not null
     order by r.order_id, r.urpi_row desc
  ),
  -- El primer intento de Urpi: el día más temprano de sus filas.
  first_try as (
    select r.order_id, min(r.report_date) as first_on
      from urpi_report_rows r
     where r.order_id is not null
       and r.report_date is not null
     group by r.order_id
  ),
  pop as (
    select om.order_id, om.store_id, om.order_name, l.urpi_row, l.report_date as delivered_on, f.first_on
      from latest l
      join first_try f on f.order_id = l.order_id
      join order_master om on om.order_id = l.order_id
      join orders o on o.id = om.order_id
     where l.result_code = 'entregado'
       and l.report_date is not null
       and om.general_status = 'entregado'
       and o.cancelled_at is null
       and not exists (select 1 from shipments y where y.order_id = om.order_id and y.courier = 'urpi' and y.delivery_status = 'entregado')
  ),
  -- Las salidas vivas, como en `planUrpiSalida`.
  live as (
    select x.id, x.order_id, x.courier, x.created_via, x.delivery_status, x.custody_state, x.custody_transferred_at,
           count(*) over (partition by x.order_id) as n_live
      from shipments x
      join pop p on p.order_id = x.order_id
     where x.delivery_status in ('pendiente', 'en_ruta')
       and x.returned_at is null
       and coalesce(x.custody_state, '') <> 'devuelto'
  ),
  target as (
    select p.order_id, p.store_id, l.id as shipment_id, p.urpi_row, p.delivered_on, p.first_on,
           -- `manualRouteGuideCode(order_name, id, 'urpi')` (lib/shipment-output.ts).
           'MOM-' || coalesce(
             nullif(regexp_replace(regexp_replace(upper(regexp_replace(btrim(coalesce(p.order_name, '')), '^#+', '')),
                                                  '[^A-Z0-9_-]+', '', 'g'), '_+', '-', 'g'), ''),
             upper(left(l.id::text, 8))
           ) || '-URPI-' || upper(left(l.id::text, 8)) as guide_code
      from pop p
      join live l on l.order_id = p.order_id
     where l.n_live = 1
       and lower(btrim(l.courier)) = 'por_definir'
       and l.created_via = 'mom_manual_route'
       and l.delivery_status = 'pendiente'
       and coalesce(l.custody_state, 'empresa') = 'empresa'
       and l.custody_transferred_at is null
  ),
  -- Las mismas guardas que el UPDATE de `writeCourierGuide`.
  filled as (
    update shipments s
       set courier = 'urpi',
           created_via = 'urpi_report',
           guide_code = t.guide_code,
           delivery_status = 'entregado',
           status_category = 'delivered',
           delivered_source = 'urpi_report',
           dispatched_at = (t.first_on + time '17:00') at time zone 'UTC',
           closed_at = (t.delivered_on + time '17:00') at time zone 'UTC'
      from target t
     where s.id = t.shipment_id
       and s.delivery_status = 'pendiente'
       and s.courier = 'por_definir'
       and s.created_via = 'mom_manual_route'
       and s.custody_transferred_at is null
       and not exists (select 1 from shipments z where z.courier = 'urpi' and z.guide_code = t.guide_code)
    returning s.id, s.store_id, s.order_id, s.output_code, s.guide_code, t.urpi_row, t.delivered_on
  )
  insert into order_events (store_id, order_id, kind, occurred_at, source, courier, guide_code, shipment_id, note, payload)
  select f.store_id, f.order_id, 'route_output_filled', now(), 'manual', 'urpi', f.guide_code, f.id,
         coalesce(f.output_code, 'La salida') || ' tenía courier por definir; el reporte de Urpi la da por entregada el '
           || to_char(f.delivered_on, 'DD/MM/YYYY') || ' (fila ' || f.urpi_row
           || '): pasó a salida de Urpi entregada (relleno 0271).',
         jsonb_build_object('outputCode', f.output_code, 'previousCourier', 'por_definir', 'backfill', true,
                            'urpi_row', f.urpi_row, 'fecha', to_char(f.delivered_on, 'YYYY-MM-DD'))
    from filled f;
  get diagnostics v_filled = row_count;
  raise notice '0271: % caja(s) «por definir» pasaron a salida de Urpi entregada', v_filled;
end $$;
