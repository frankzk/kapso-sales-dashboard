-- 0213_rollups_solo_service_role.sql — `recompute_daily_rollups` solo la
-- ejecuta el servidor.
--
-- QUÉ PASABA (02-10-2026). Las migraciones 0002–0006 y la 0212 hacen
-- `revoke all … from public`, pero en Supabase las funciones nuevas del esquema
-- `public` reciben además un EXECUTE explícito para `anon` y `authenticated`
-- (privilegios por defecto), y ese revoke no los quita. Como la función es
-- `security definer`, cualquiera con la clave pública podía llamarla por
-- /rest/v1/rpc y hacer que borrara y recalculara las métricas de cualquier
-- tienda. No pierde datos —recalcula desde `orders` y `conversations`—, pero es
-- un recálculo pesado que nadie fuera del servidor debería poder disparar.
--
-- Quién la llama: lib/ingest.ts, app/dashboard/leads/actions.ts y
-- scripts/seed.ts, todos con el cliente de servicio. Nada cambia para la app.

revoke execute on function public.recompute_daily_rollups(uuid, date, date) from anon, authenticated;
grant execute on function public.recompute_daily_rollups(uuid, date, date) to service_role;
