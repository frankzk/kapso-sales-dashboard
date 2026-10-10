-- 0239_swayp_link_emission_on_fill.sql — la emisión Swayp se enlaza con su guía
-- también cuando la guía RELLENA una salida «por definir».
--
-- QUÉ PASABA (10-10-2026). `swayp_link_emission` (0209) solo corría al INSERTAR
-- una guía. Cuando la guía Swayp directa rellena una salida que ya existía
-- (lib/route-output-fill.ts), la fila no se inserta: se ACTUALIZA, y la emisión
-- quedaba con `child_id` vacío. Eran 32 emisiones `created` sin hija, del 02 al
-- 10-10, todas de salidas rellenadas. Dos efectos:
--   - `swayp_emission_claim` rechaza cualquier emisión Swayp posterior de ese
--     pedido («Emisión previa o incierta»), porque lee el `child_id` vacío como
--     una emisión a medio hacer;
--   - sus productos siguen restando como stock reservado.
--
-- QUÉ CAMBIA. Un segundo trigger, en UPDATE, con la misma función, cuando la
-- fila pasa a ser una guía Swayp con número (cambia `swayp_guide` o `courier`).
-- Y el enlace de las que quedaron sueltas: cada una casa con UNA sola guía (misma
-- tienda, pedido y número), medido antes de escribir. Idempotente: solo toca
-- `child_id` vacío.

drop trigger if exists swayp_link_emission_on_fill on shipments;
create trigger swayp_link_emission_on_fill after update of swayp_guide, courier on shipments for each row
  when (new.courier = 'fenix' and new.swayp_guide is not null
    and (old.swayp_guide is distinct from new.swayp_guide or old.courier is distinct from new.courier))
  execute function swayp_link_emission();

update swayp_guide_emissions e
   set child_id = s.id
  from shipments s
 where e.child_id is null
   and e.guide_code is not null
   and s.store_id = e.store_id
   and s.order_id = e.order_id
   and s.courier = 'fenix'
   and s.swayp_guide = e.guide_code;
