-- ============================================================================
-- 0346_gf_requests_lock_en_curso.sql — el candado de GF Courier cuenta solo la
-- creación EN CURSO (MOM §29.17; owner, 15-11-2026).
--
-- POR QUÉ. La 0344 creó `gf_order_requests_live_uniq` sobre `order_id` con
-- `status <> 'failed'`: una intención ENVIADA ('sent') seguía ocupando el
-- candado para siempre. El owner decidió que GF Courier no tiene tope de salidas
-- —una guía por día de despacho, la siguiente con `-S2`, `-S3`…— y con ese
-- índice la segunda guía de un pedido chocaba (23505) y Kapta respondía «Ya hay
-- una creación de guía GF en curso» aunque la primera estuviera anulada o
-- devuelta.
--
-- QUÉ CAMBIA. El candado pasa a ser «una creación en curso por pedido»
-- (`status = 'pending'`), que es lo que protege de dos POST a la vez. Que no haya
-- dos guías GF VIVAS lo sigue diciendo `createGfGuideFor` mirando las salidas, y
-- dos clics simultáneos calculan la misma `-Sn` y chocan en
-- `gf_order_requests_key_uniq` (la misma Idempotency-Key).
--
-- No toca filas. Correrla otra vez no cambia nada.
-- ============================================================================

drop index if exists public.gf_order_requests_live_uniq;
create unique index if not exists gf_order_requests_live_uniq
  on public.gf_order_requests (order_id) where status = 'pending';
comment on index public.gf_order_requests_live_uniq is
  'GF Courier (0346, MOM §29.17): una creación EN CURSO por pedido. Las enviadas no ocupan el candado: la -S2 se crea cuando la anterior está cerrada.';
