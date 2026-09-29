-- 0203_drop_swayp_inventory_sessions.sql — se retira la sesión guardada del
-- panel de Swayp y la llave de la extensión de Chrome (0202).
--
-- Ya no hacen falta: el 29-09-2026 se confirmó que GET /v1/integrations/products,
-- con la MISMA credencial de integración que las guías (`SWAYP_TOKEN`),
-- devuelve cada producto con su stock por bodega. El sync diario lee de ahí,
-- sin reutilizar sesiones de personas ni extensión. Borrar las tablas quita de
-- la base cualquier posibilidad de guardar un token de sesión del panel.
-- Estaban vacías: nunca se guardó una sesión ni se generó una llave.

--
-- Guarda (test/migrations-safe-to-rerun.test.ts): cada tabla se borra SÓLO si
-- existe y está vacía. En una base donde alguien alcanzó a guardar algo, esto no
-- hace nada y la tabla queda para revisarla a mano.

do $$
declare
  t text;
  hay boolean;
begin
  foreach t in array array['swayp_inventory_sessions', 'swayp_extension_keys'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select exists (select 1 from public.%I)', t) into hay;
      if not hay then
        execute format('drop table public.%I', t);
      end if;
    end if;
  end loop;
end $$;
