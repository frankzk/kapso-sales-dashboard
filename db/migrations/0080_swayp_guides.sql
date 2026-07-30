-- Guías creadas por la API de Swayp (el courier antes llamado Fenix).
--
-- `guide_code` sigue siendo el identificador que ve y usa el operador. Estas
-- columnas guardan lo que aporta la API y que antes no existía:
--
--   swayp_guide  — el número de guía que EMITE Swayp (ej. 10000022753). Hasta
--                  ahora el código de guía se inventaba localmente
--                  (autoFenixGuideCode); con la API el número lo asigna Swayp y
--                  es el identificador permanente para consultar, imprimir,
--                  cancelar y resolver novedades. Único: dos envíos no pueden
--                  compartir guía, y el webhook busca por acá.
--
--   swayp_state  — el estado CRUDO de Swayp (1..12). El modelo de la app tiene
--                  5 estados y ninguno significa "en devolución", así que
--                  mapSwaypState() es lossy a propósito. Guardar el original
--                  evita perder información (p. ej. distinguir 8 Revisión de 6
--                  Novedad, que mapean ambos a 'pendiente').
--
--   swayp_synced_at — cuándo se recibió la última notificación de Swayp. Sirve
--                  para detectar guías que dejaron de reportar.

alter table shipments add column if not exists swayp_guide text;
alter table shipments add column if not exists swayp_state smallint;
alter table shipments add column if not exists swayp_synced_at timestamptz;

-- El webhook llega con {guide_number} y nada más: sin este índice cada
-- notificación haría un scan de shipments. Único porque una guía de Swayp
-- pertenece a un solo envío — protege además contra la doble creación que
-- provocaría un reintento del POST /v2/guias (la API no tiene idempotencia).
create unique index if not exists shipments_swayp_guide_uniq
  on shipments(swayp_guide) where swayp_guide is not null;

comment on column shipments.swayp_guide is
  'Guide number issued by Swayp (permanent id for their API). Null for manual guides.';
comment on column shipments.swayp_state is
  'Raw Swayp state id 1..12; delivery_status holds the lossy mapping of it.';
comment on column shipments.swayp_synced_at is
  'Last time a Swayp webhook updated this shipment.';
