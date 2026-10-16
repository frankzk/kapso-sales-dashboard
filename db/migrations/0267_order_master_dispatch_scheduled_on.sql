-- ============================================================================
-- 0267_order_master_dispatch_scheduled_on.sql — «Programar envío»: la fecha
-- acordada para despachar un pedido confirmado que todavía no tiene guía
-- (MOM §6.2, 15-10-2026, pedido de Frankz).
--
-- POR QUÉ. Un pedido en Preparación · Por generar rótulo que el equipo tenía
-- programado en su Excel («enviar lunes 26-10») parecía olvidado en Kapta
-- (#KP140347). La fecha ahora es un hecho del historial (`dispatch_date_set`
-- con actor y nota; `dispatch_date_cleared` con motivo) y el Master la guarda
-- aquí para poder filtrar y enseñarla.
--
-- QUIÉN LA ESCRIBE. El recálculo del pedido (lib/dispatch-date.ts), y solo
-- mientras el pedido está en Por generar rótulo: con la guía creada vuelve a
-- null. No hace falta rellenar nada: hasta hoy nadie había programado un envío.
-- ============================================================================

alter table order_master add column if not exists dispatch_scheduled_on date;

create index if not exists order_master_store_dispatch_scheduled_idx
  on order_master(store_id, dispatch_scheduled_on)
  where dispatch_scheduled_on is not null;
