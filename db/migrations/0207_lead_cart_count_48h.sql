-- ============================================================================
-- 0207_lead_cart_count_48h.sql
-- Cuántos carritos armó la clienta en las 48 h que terminan en el último.
--
-- POR QUÉ. Quien arma dos o más carritos cierra más cuando se la llama, en los
-- cuatro tramos horarios de Kenku (medido en lib/lead-priority.ts:
-- REPEAT_CART_FACTOR). La cola se ordena en el navegador con la fila del lead,
-- así que el dato tiene que viajar en la fila: contarlo al leer serían miles de
-- consultas a `draft_orders` en cada refresco.
--
-- QUIÉN LO ESCRIBE. La sincronización de borradores (linkDraftOrdersToLeads),
-- la misma que escribe `draft_order_gid`: el número se calcula alrededor del
-- carrito que queda en la fila, así que los dos no pueden desincronizarse.
--
-- El relleno de abajo solo toca leads EN COLA con carrito. Es idempotente:
-- re-aplicado escribe los mismos números y `is distinct from` lo deja sin
-- cambios.
-- ============================================================================

alter table leads add column if not exists cart_count_48h integer;

comment on column leads.cart_count_48h is
  'Carritos (draft_orders) de este telefono en las 48 h que terminan en el carrito de la fila, incluido. 2+ sube la prioridad del carrito en la cola (lib/lead-priority.ts, REPEAT_CART_FACTOR).';

update leads l
   set cart_count_48h = x.n
  from (
    select l2.id,
           -- Nunca menos de 1, como cartsInWindow: el carrito de la fila existe
           -- aunque no tenga fecha con la que contarse.
           greatest(1, (select count(*)::int
              from draft_orders d2
             where d2.store_id = l2.store_id
               and d2.customer_phone = l2.phone
               and d2.created_at between d.created_at - interval '48 hours' and d.created_at)) as n
      from leads l2
      join draft_orders d on d.draft_order_gid = l2.draft_order_gid and d.store_id = l2.store_id
     where l2.category in ('open', 'hot')
  ) x
 where x.id = l.id
   and l.cart_count_48h is distinct from x.n;
