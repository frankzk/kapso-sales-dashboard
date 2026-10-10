-- 0235_order_master_swayp_availability.sql — la disponibilidad Swayp de cada
-- pedido, para filtrar el Master como Repro Provincia filtra sus guías
-- (MOM §11.10, 08-10-2026, pedido de Frankz).
--
-- QUÉ ES. El mismo resultado que el badge «Swayp ok / Sin stock Swayp / Fuera
-- de cobertura» de Repro Provincia (`evaluateFenix`), por pedido: `ok` si la
-- ciudad de destino tiene almacén Swayp y hay stock del producto; `sin_stock`
-- si hay almacén y falta stock; `sin_cobertura` si no hay almacén. Null fuera
-- de Por confirmar, Preparación, Por despachar y En curso: ahí el stock de hoy
-- no decide nada.
--
-- QUIÉN LA ESCRIBE. `recalcularDisponibilidadSwaypMaster`
-- (lib/master-swayp-availability.ts), al terminar el sync de inventario y cada
-- hora en el cron `swayp-inventory`. El recálculo del pedido no la toca: su
-- upsert nombra sus columnas y esta no está entre ellas.
--
-- El Master filtra en la base y pagina, así que el filtro necesita la columna;
-- el índice parcial cubre el filtro sin pesar sobre los ~10.000 finalizados.

alter table order_master add column if not exists swayp_availability text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_master_swayp_availability_check') then
    alter table order_master add constraint order_master_swayp_availability_check
      check (swayp_availability in ('ok', 'sin_stock', 'sin_cobertura'));
  end if;
end $$;

create index if not exists order_master_store_swayp_idx
  on order_master(store_id, swayp_availability)
  where swayp_availability is not null;
