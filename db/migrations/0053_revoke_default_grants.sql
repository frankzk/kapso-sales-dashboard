-- ============================================================================
-- 0053_revoke_default_grants.sql — quitar los privilegios que Supabase concede
-- por defecto sobre las tablas sensibles.
--
-- QUÉ PASÓ. Supabase deja configurado, en el esquema `public`:
--     alter default privileges ... grant all on tables to anon, authenticated, service_role;
-- así que CADA tabla nueva nace con TODOS los privilegios para los tres roles.
-- Un `grant select, insert to service_role` no resta nada: solo añade sobre un
-- permiso que ya era total.
--
-- Por eso 0045 y 0049 no lograron lo que documentaban:
--   * `order_events` y `pickup_key_views` se declaran APPEND-ONLY, pero
--     conservaban UPDATE/DELETE por privilegio. (El trigger `reject_mutation`
--     sí los bloqueaba — la inmutabilidad nunca estuvo rota, pero la segunda
--     cerradura no existía.)
--   * `shalom_pickup_keys` se declara ilegible, y aunque RLS activo SIN policy
--     ya deniega a `authenticated`, el privilegio de SELECT seguía concedido:
--     a una policy de distancia de exponer la clave de recojo.
--
-- Esta migración revoca todo y vuelve a conceder solo lo necesario. Es
-- idempotente y no toca datos.
--
-- POR QUÉ NO LO DETECTARON LAS PRUEBAS: el Postgres desechable de
-- scripts/verify-db.sh no traía las default privileges de Supabase, así que la
-- comprobación pasaba. `scripts/sql/test_prelude.sql` ahora las replica, para
-- que este tipo de fallo se vea en CI y no en producción.
-- ============================================================================

-- ── Auditoría append-only ────────────────────────────────────────────────────
-- Solo leer e insertar. Ni el rol con el que escriben los server actions puede
-- reescribir el historial.
revoke all on order_events     from anon, authenticated, service_role;
revoke all on pickup_key_views from anon, authenticated, service_role;

grant select         on order_events     to authenticated;
grant select, insert on order_events     to service_role;
grant select         on pickup_key_views to authenticated;
grant select, insert on pickup_key_views to service_role;

-- ── Clave de recojo ──────────────────────────────────────────────────────────
-- NADIE salvo el service role la toca, y aun así solo a través del server action
-- que comprueba permisos y deja auditoría. Sin privilegio y sin policy: dos
-- cerraduras independientes.
revoke all on shalom_pickup_keys from anon, authenticated;
grant all privileges on shalom_pickup_keys to service_role;

-- ── Comprobantes y entregas de clave ─────────────────────────────────────────
-- Lectura para el equipo (acotada por RLS), escritura solo por el service role.
revoke all on order_payments     from anon, authenticated;
revoke all on pickup_key_shares  from anon, authenticated, service_role;
grant select on order_payments to authenticated;
grant all privileges on order_payments to service_role;
grant select         on pickup_key_shares to authenticated;
grant select, insert on pickup_key_shares to service_role;

-- ── Read-model del Master ────────────────────────────────────────────────────
-- `order_master` se deriva por completo del recálculo; que un cliente pudiera
-- escribirla directamente no tendría sentido (y RLS no lo impide por sí solo:
-- su policy es solo de SELECT).
revoke all on order_master from anon, authenticated;
grant select on order_master to authenticated;
grant all privileges on order_master to service_role;

revoke all on order_geo_overrides from anon, authenticated;
grant select on order_geo_overrides to authenticated;
grant all privileges on order_geo_overrides to service_role;

-- ── Referencia geográfica ────────────────────────────────────────────────────
revoke all on peru_districts from anon, authenticated;
grant select on peru_districts to authenticated;
grant all privileges on peru_districts to service_role;

-- ── Permisos por usuario ─────────────────────────────────────────────────────
-- Que un usuario pudiera concederse permisos a sí mismo vaciaría el modelo.
revoke all on user_permissions from anon, authenticated;
grant select on user_permissions to authenticated;
grant all privileges on user_permissions to service_role;

-- ── Costos ───────────────────────────────────────────────────────────────────
-- Aquí SÍ escribe el usuario autenticado: la policy `..._write` lo acota a los
-- administradores de la organización (patrón de fenix_stock, 0025). Se quitan
-- TRUNCATE y REFERENCES, que nunca hacen falta desde la API.
revoke all on cost_tariffs     from anon, authenticated;
revoke all on product_costs    from anon, authenticated;
revoke all on additional_costs from anon, authenticated;
grant select, insert, update, delete on cost_tariffs     to authenticated;
grant select, insert, update, delete on product_costs    to authenticated;
grant select, insert, update, delete on additional_costs to authenticated;
grant all privileges on cost_tariffs, product_costs, additional_costs to service_role;
