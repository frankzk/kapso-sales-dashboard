-- 0200_gf_orphan_scheduled_requests.sql — solicitudes de Grupo GF «scheduled»
-- sin caja vuelven a «accepted» (MOM §29.13; 29-09-2026).
--
-- «Quitar» un paquete de una caja todavía sin custodia (removeManifestItem)
-- marcaba el ítem como retirado pero no tocaba la solicitud: quedaba
-- `scheduled` sin ningún `dispatch_manifest_items` activo. Medido el
-- 29-09-2026: #KP136039, #KP136010, #KP135989 (23-09), #KP137239 y #KP137430
-- (28-09). El código ya revierte al retirar; esto repara lo que quedó, con un
-- evento `route_removed_repair` por solicitud. Idempotente: una segunda
-- corrida no encuentra nada.

with orphan as (
  select r.id
    from logistics_requests r
   where r.status = 'scheduled'
     and r.shipment_id is not null
     and not exists (
       select 1 from dispatch_manifest_items i
        where i.shipment_id = r.shipment_id and i.removed_at is null
     )
), fixed as (
  update logistics_requests r
     set status = 'accepted'
    from orphan o
   where r.id = o.id
  returning r.id
)
insert into logistics_request_events (request_id, kind, status, note, payload)
select id, 'route_removed_repair', 'accepted',
       'Estaba «scheduled» sin caja: se retiró de la caja sin volver a «por asignar». Reparado en 0200.',
       jsonb_build_object('migration', '0200')
  from fixed;
