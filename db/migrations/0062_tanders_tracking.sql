-- ============================================================================
-- 0062_tanders_tracking.sql — el código de guía de Tanders es el N° de
-- seguimiento, no su id interno.
--
-- La 0058 guardaba en `guide_code` el `id` que devuelve su API: un cuid
-- ("cms3ov8db00080mxdbvigryzy"). Pero ese identificador no aparece en ninguna
-- parte de la interfaz de Tanders ni lo conoce el cliente. Lo que su panel
-- muestra como "N° SEGUIMIENTO" —y lo único por lo que se puede buscar un
-- envío— es otro campo: `aliclikOrderNumber` ("TANDER17851846826402032").
--
-- El nombre del campo delata cómo funciona Tanders por dentro: sincroniza cada
-- pedido hacia Aliclik (`aliclikSyncStatus: "SYNCED"`) y adopta como número de
-- seguimiento el que genera en ese sistema.
--
-- Con el cuid en `guide_code`, buscar el envío en el Master por el número que
-- el equipo ve en Tanders no devolvía nada. El cuid sigue haciendo falta —es la
-- clave de `GET /orders/{id}`— así que se muda a su propia columna en vez de
-- perderse.
-- ============================================================================

alter table shipments
  add column if not exists tanders_order_id text;

comment on column shipments.tanders_order_id is
  'Id interno del pedido en Tanders (cuid). Clave para su API; el N° de seguimiento visible va en guide_code.';

-- Índice para resolver una guía desde su id de Tanders (consultas de estado).
create index if not exists shipments_tanders_order_idx
  on shipments(tanders_order_id) where tanders_order_id is not null;

-- ----------------------------------------------------------------------------
-- Corrección de las guías ya creadas con el cuid como código.
--
-- Solo se tocan las filas cuya respuesta cruda trae el número de seguimiento y
-- cuyo `guide_code` sigue siendo el cuid — así reaplicar esto no hace nada. El
-- índice único es (courier, guide_code): si el número ya lo lleva otra fila, esa
-- se deja como está y se revisa a mano, en vez de romper la migración.
-- ----------------------------------------------------------------------------

update shipments s
set tanders_order_id = s.guide_code,
    guide_code       = s.tanders_raw ->> 'aliclikOrderNumber'
where s.courier = 'tanders'
  and s.tanders_order_id is null
  and s.tanders_raw ->> 'aliclikOrderNumber' is not null
  and s.guide_code = s.tanders_raw ->> 'id'
  and not exists (
    select 1 from shipments other
    where other.courier = 'tanders'
      and other.guide_code = s.tanders_raw ->> 'aliclikOrderNumber'
      and other.id <> s.id
  );

-- `order_events` es append-only (0045): los movimientos ya escritos conservan el
-- cuid en su `guide_code`. Es correcto — son el registro de lo que pasó en ese
-- momento— y el envío se sigue encontrando por la fila de `shipments`.
