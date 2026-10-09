-- 0237_swayp_auto_metrics_estado_swayp.sql — el resultado del automático
-- Aliclik → Swayp (MOM §11.9) se lee del ESTADO DE SWAYP, no del
-- `delivery_status` de Kapta.
--
-- QUÉ PASABA (09-10-2026). La vista de la 0210 contaba como devuelta solo una
-- guía con `delivery_status = 'devuelto'`, y Swayp nunca llega ahí: su
-- Devolución (8) queda `en_ruta` con `swayp_state = 8`, y la confirmada (9, 12)
-- queda `anulado` (lib/swayp.ts, `mapSwaypState`). La pantalla del automático
-- decía «1 entregada · 0 devueltas · 25 pendientes» con 18 guías en Devolución,
-- y el costo por entrega no sumaba ningún retorno.
--
-- QUÉ CAMBIA. Cada guía tiene UN resultado, en este orden:
--   entregada  `delivery_status = 'entregado'` o Swayp 7;
--   devuelta   Swayp 8, 9 o 12, la caja ya de vuelta (`returned_at`) o
--              `delivery_status = 'devuelto'`;
--   anulada    el resto de las `anulado` (Cancelada antes de salir);
--   pendiente  lo demás con guía emitida.
-- Mismas columnas que la 0210, así que la pantalla no cambia. Un retorno sin
-- costo registrado sigue contando en `missing_cost`: nunca se suma como cero.

create or replace view swayp_auto_metrics with (security_invoker=true) as
with rows as (
  select e.org_id,coalesce(e.evidence->>'cohort','prior_delivery') cohort,e.guide_code,e.state,
    case
      when s.id is null then null
      when s.delivery_status='entregado' or s.swayp_state=7 then 'entregado'
      when s.swayp_state in (8,9,12) or s.returned_at is not null or s.delivery_status='devuelto' then 'devuelto'
      when s.delivery_status='anulado' then 'anulado'
      else 'pendiente'
    end as delivery_status,
    coalesce(s.quoted_delivery_cost,(e.evidence->>'quotedDeliveryCost')::numeric) delivery_cost,
    s.quoted_return_cost return_cost
  from swayp_guide_emissions e left join shipments s on s.id=e.child_id where e.automatic
)
select org_id,cohort,count(*)::int attempts,
  count(*) filter(where guide_code is not null)::int issued,
  count(*) filter(where delivery_status='entregado')::int delivered,
  count(*) filter(where delivery_status='devuelto')::int returned,
  count(*) filter(where delivery_status='anulado')::int cancelled,
  count(*) filter(where state='review' or guide_code is null)::int review,
  count(*) filter(where guide_code is not null and delivery_status not in ('entregado','devuelto','anulado'))::int pending,
  count(*) filter(where guide_code is not null and (delivery_cost is null or (delivery_status='devuelto' and return_cost is null)))::int missing_cost,
  sum(delivery_cost + case when delivery_status='devuelto' then coalesce(return_cost,0) else 0 end) filter(where guide_code is not null) quoted_cost
from rows group by org_id,cohort;
grant select on swayp_auto_metrics to authenticated,service_role;
