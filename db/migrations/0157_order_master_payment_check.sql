-- ============================================================================
-- 0157_order_master_payment_check.sql — que el Master pueda ENSEÑAR y FILTRAR
-- la verificación del cobro que hace el courier.
--
-- EL CASO. `shipments.payment_check_state` existe desde 0084 y bloquea de
-- verdad: una guía Tanders solo pasa a `entregado` con la constancia validada.
-- Pero el dato no salía de la base — ni se seleccionaba, ni llegaba al
-- navegador, ni había filtro. El 10-09-2026 había 21 guías con el cobro
-- RECHAZADO, una de ellas por comprobante reusado, y ninguna pantalla podía
-- listarlas. Un bloqueo que nadie puede ver es un pedido parado para siempre.
--
-- Se materializa en `order_master` desde la guía VIGENTE, igual que
-- `guide_code` o el costo real: si un pedido salió dos veces, lo que importa
-- es el cobro de la que está entregando.
--
-- LA COLUMNA NO ES DE TANDERS. Hoy es el único courier que sube constancia por
-- guía, pero el nombre y el filtro son genéricos: el día que otro lo haga, el
-- Master ya sabe enseñarlo sin tocar nada. Los que liquidan en bloque
-- (motorizados propios, vía rider_settlements) se quedan en NULL, que en el
-- filtro es una opción con nombre propio —«courier sin constancia por guía»— y
-- no un «no cobrado» que sería mentira.
-- ============================================================================

alter table order_master
  add column if not exists payment_check_state text;

comment on column order_master.payment_check_state is
  'Verificación de la constancia de cobro del courier en la guía vigente (0084): validado | rechazado | pendiente | revisado. NULL = ese courier no sube constancia por guía. No confundir con payment_state, que es el cobro del pedido.';

-- El filtro pide un estado concreto sobre las filas de una tienda. Parcial:
-- la inmensa mayoría de pedidos están en NULL y no hace falta indexarlos.
create index if not exists order_master_payment_check_idx
  on order_master(store_id, payment_check_state)
  where payment_check_state is not null;

-- Relleno inicial desde la guía vigente (la que `order_master.guide_code` ya
-- señala). Sin esto la columna nace vacía y el filtro no enseñaría los cobros
-- rechazados hasta que algo recalculara cada pedido uno por uno — justo los 21
-- bloqueos que motivan este cambio se quedarían invisibles otra temporada.
update order_master om
set payment_check_state = s.payment_check_state
from shipments s
where s.order_id = om.order_id
  and s.guide_code = om.guide_code
  and s.payment_check_state is not null
  and om.payment_check_state is distinct from s.payment_check_state;
