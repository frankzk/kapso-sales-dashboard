-- ============================================================================
-- 0043_fenix_direct_guides.sql — Guías Fenix DIRECTAS: creadas desde un pedido
-- Shopify sin guía Aliclik madre (urgencias que salen del almacén regional de
-- Fénix en vez de esperar 2–3 días de Aliclik).
--
-- Marcador permanente de origen en shipments (created_via='fenix_directo').
-- No se usa reroute_outcome porque el resultado del courier lo sobreescribe.
-- El stock NO se reserva al crear: la validación (cobertura + stock de todos
-- los productos del pedido) es un gate de creación, y el descuento sigue
-- ocurriendo al entregar (salida_entrega −1, como toda guía Fénix).
-- ============================================================================

alter table shipments add column if not exists created_via text; -- 'fenix_directo' | null
create index if not exists shipments_created_via_idx
  on shipments(created_via) where created_via is not null;
