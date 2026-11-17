-- ============================================================================
-- 0353_lima_rider_district_share.sql — quién lleva cada distrito de Lima
-- (owner, 17-11-2026: «¿puedes obtener la sugerencia de motorizado? Si en base
-- a ese distrito se iría con Alexis, Roy, Yordani, Yhonny u otro»).
--
-- La API de GF Courier solo dice el motorizado cuando ya lo asignó. Kapta lo
-- sugiere con su propio historial: las paradas de reparto de los últimos
-- `p_days` días, por distrito del pedido y motorizado de la ruta. La regla de
-- la sugerencia vive en lib/lima-rider-suggest.ts (pura); esta función solo
-- cuenta.
--
-- Solo lectura, sin tablas ni índices nuevos: `delivery_routes` por fecha,
-- sus paradas y el distrito del Master. Solo el servidor (service_role).
-- ============================================================================

create or replace function public.lima_rider_district_share(p_days integer default 30)
returns table(district text, rider_name text, deliveries bigint)
language sql stable security invoker set search_path=public,pg_temp as $$
  select m.district, r.full_name as rider_name, count(*)::bigint as deliveries
  from delivery_routes dr
  join delivery_stops st on st.route_id = dr.id
  join riders r on r.id = dr.rider_id
  join order_master m on m.order_id = st.order_id
  where dr.route_date >= (now() at time zone 'America/Lima')::date - greatest(coalesce(p_days, 30), 1)
    and m.coverage = 'lima'
    and nullif(trim(m.district), '') is not null
  group by m.district, r.full_name
$$;

revoke all on function public.lima_rider_district_share(integer) from public, anon, authenticated;
grant execute on function public.lima_rider_district_share(integer) to service_role;
