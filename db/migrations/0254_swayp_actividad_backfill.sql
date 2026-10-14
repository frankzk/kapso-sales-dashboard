-- 0254_swayp_actividad_backfill.sql — la Actividad de los pedidos Swayp, completa.
--
-- QUÉ PASABA (13-10-2026). El webhook y el barrido de Swayp escribían el estado
-- en la guía y en nada más: #KP140633 decía «Entregado» en Salidas y guías y la
-- pestaña Actividad no tenía una sola línea de la entrega. Aliclik y Shalom
-- dejan un `courier_status` por transición; Swayp no dejaba ninguno. Desde este
-- cambio lo deja (`swaypStatusEvent`, lib/swayp-ingest.ts).
--
-- ESTE RELLENO deja, para cada guía Swayp que ya se movió (estado 5 en
-- adelante: reparto, novedad, entregada, devolución) y no tiene ninguna línea,
-- UNA línea con su último estado conocido. El camino que tuvo hasta ahí no se
-- puede reconstruir: Swayp no lo guardamos. La nota lo dice.
--
-- La hora: el cierre si lo hay (entregada, devolución confirmada); si no, la
-- salida a reparto o el despacho. Idempotente: no toca una guía que ya tenga su
-- `courier_status` de Swayp.

insert into order_events (store_id, order_id, kind, occurred_at, actor, source, courier, guide_code, shipment_id, new_status, note, payload)
select s.store_id, s.order_id, 'courier_status',
       coalesce(s.closed_at, s.out_for_delivery_at, s.dispatched_at, s.updated_at),
       null, 'fenix', 'fenix', s.guide_code, s.id, s.delivery_status,
       'Swayp: ' ||
         case s.swayp_state
           when 5 then 'Reparto' when 6 then 'Novedad' when 7 then 'Entregada' when 8 then 'Devolución'
           when 9 then 'Devolución confirmada' when 10 then 'Cancelada' when 11 then 'Indemnizada'
           when 12 then 'Devolución confirmada con cobro' else 'Estado ' || s.swayp_state
         end || ' (' || s.swayp_state || ')' ||
         case when s.reported_status like 'Swayp · %' then ' · ' || substr(s.reported_status, 9) else '' end ||
         '. Último estado conocido, registrado el 13-10-2026 al completar la Actividad.',
       jsonb_build_object('swayp_state', s.swayp_state, 'relleno', true)
  from shipments s
 where s.courier = 'fenix'
   and s.swayp_state >= 5
   and s.order_id is not null
   and s.store_id is not null
   and not exists (
     select 1 from order_events e
      where e.order_id = s.order_id and e.kind = 'courier_status' and e.source = 'fenix'
        and e.guide_code is not distinct from s.guide_code
   );
