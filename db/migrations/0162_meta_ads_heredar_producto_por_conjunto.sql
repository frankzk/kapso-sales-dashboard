-- 0162 — Un conjunto de anuncios promociona un solo producto.
--
-- El conjunto es la unidad de prueba de la cuenta: mismo público, mismo
-- presupuesto, mismo producto; lo que cambia entre sus anuncios es el creativo.
-- Asignar uno a mano y dejar los otros treinta en «Por mapear» no es información
-- que falte, es la misma información sin copiar.
--
-- Medido el 14-09-2026 contra producción:
--   * 5.213 anuncios en `meta_ads`, 68 con producto asignado a mano.
--   * CERO conjuntos con dos productos distintos asignados — la regla ya se
--     cumplía a mano, esto solo deja de exigir el trabajo manual.
--   * Esas 68 asignaciones alcanzan a 523 anuncios por herencia.
--
-- De aquí en adelante la herencia la hace `saveAdPromotedProduct` al guardar.
-- Esta migración es el una-sola-vez sobre lo que ya estaba.
--
-- SEGURIDAD: solo escribe donde `promoted_product_name IS NULL`. Una asignación
-- existente no se pisa nunca — si alguien mapeó un anuncio a otra cosa a
-- propósito, esa decisión gana. Y solo hereda desde conjuntos donde TODOS los
-- anuncios ya asignados coinciden en el mismo producto; un conjunto en conflicto
-- se deja intacto para que lo resuelva una persona.

-- Nota de implementación: `promoted_skus` es `text[]`, así que el «más reciente
-- del conjunto» NO se puede sacar con `(array_agg(promoted_skus order by …))[1]`
-- —agregar arrays los aplana y el subíndice devuelve `text`, no `text[]`, y el
-- UPDATE falla con «COALESCE types text and text[] cannot be matched»—. Va con
-- `distinct on`, que es la forma correcta de «una fila por grupo».

-- Conjuntos donde todos los anuncios ya asignados coinciden en el mismo
-- producto. Uno en conflicto se deja intacto: lo resuelve una persona.
with sanos as (
  select adset_id
  from meta_ads
  where adset_id is not null
    and promoted_product_name is not null
  group by adset_id
  having count(distinct promoted_product_name) = 1
),
-- De cada conjunto sano, la asignación más reciente: de ahí salen producto y SKU.
fuente as (
  select distinct on (m.adset_id)
         m.adset_id,
         m.promoted_product_name as producto,
         m.promoted_skus         as skus
  from meta_ads m
  join sanos s on s.adset_id = m.adset_id
  where m.promoted_product_name is not null
  order by m.adset_id, m.promoted_product_updated_at desc nulls last
)
update meta_ads m
set promoted_product_name       = f.producto,
    promoted_skus               = f.skus,
    promoted_product_updated_at = now()
from fuente f
where m.adset_id = f.adset_id
  and m.promoted_product_name is null;

-- Aplicada contra producción el 14-09-2026: 523 filas en 51 conjuntos,
-- 26 productos distintos. `meta_ads` pasó de 68 a 591 anuncios asignados,
-- con cero conjuntos en conflicto y cero huérfanos sin heredar.
-- Es idempotente: una segunda pasada no encuentra nulos que rellenar.
