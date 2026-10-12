-- ============================================================================
-- 0242_gf_same_day_cutoff_noon.sql — el corte del mismo día de Grupo GF pasa de
-- las 11:30 a las 12:00.
--
-- DECISIÓN DEL OWNER (11-10-2026, «Reprogramación en Lima: quién hace qué»):
-- lo que se toma o se programa hasta las 12:00 del mismo día sale esa tarde,
-- porque Alexis recoge a las 12:30 y cubre todo Lima. Ver MOM §29.6 y §9.1.
--
-- QUÉ CAMBIA:
--
--   * `logistics_providers.same_day_cutoff` del proveedor `grupo-gf-courier`:
--     es el valor que lee Kapta (Despacho del día, Mesa de ruta y la toma de
--     pedidos). Solo se mueve el que sigue en 11:30: un corte que alguien ya
--     cambió a mano no se pisa.
--   * Los convenios activos de ese proveedor, por coherencia: hoy nadie lee su
--     columna, pero dice lo mismo y no debe contradecir al proveedor.
--   * El valor por defecto de la columna del proveedor, para un proveedor nuevo
--     (la acción de activar ya escribe 12:00 de forma explícita).
--
-- Idempotente: correrla dos veces no cambia nada.
-- ============================================================================

begin;

update public.logistics_providers
   set same_day_cutoff = time '12:00'
 where code = 'grupo-gf-courier'
   and same_day_cutoff = time '11:30';

update public.logistics_service_agreements a
   set same_day_cutoff = time '12:00'
  from public.logistics_providers p
 where a.provider_id = p.id
   and p.code = 'grupo-gf-courier'
   and a.same_day_cutoff = time '11:30';

alter table public.logistics_providers
  alter column same_day_cutoff set default time '12:00';

commit;
