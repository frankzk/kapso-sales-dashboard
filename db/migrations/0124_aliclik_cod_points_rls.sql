-- ============================================================================
-- 0124_aliclik_cod_points_rls.sql — cerrar la única tabla del esquema que
-- cualquiera con la clave anon podía leer, escribir y vaciar.
--
-- EL AGUJERO. `aliclik_cod_points` salió de la 0100 sin RLS y con los GRANT por
-- defecto de Supabase intactos. Medido en producción (20-08-2026):
--
--     relrowsecurity │ políticas │ filas
--          false     │     0     │  684
--
--     grantee       │ privilegios
--     anon          │ SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--     authenticated │ SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--
-- La clave anon es pública por diseño: viaja en el bundle del navegador. O sea
-- que esos 684 puntos COD —la geografía de dónde reparte Aliclik, que es
-- inteligencia comercial— eran legibles por cualquiera, y `truncate` estaba a
-- una llamada de distancia. Vaciarla no rompe nada visible de inmediato: hace
-- que `order_coverage_for` deje de encontrar puntos cercanos y empiece a
-- clasificar como `agencia` pedidos que sí tienen cobertura a domicilio. Un
-- borrado silencioso que se manifiesta como decisiones logísticas equivocadas.
--
-- POR QUÉ RLS SIN POLÍTICAS ES LA RESPUESTA CORRECTA AQUÍ, Y NO UN DESCUIDO.
-- Activar RLS sin definir políticas bloquea a anon y authenticated por completo.
-- Eso normalmente sería romper la tabla; en esta no, porque NADIE la lee con esos
-- roles. Los tres únicos accesos que existen son:
--
--   · `refresh_aliclik_cod_points` la reescribe entera — SECURITY DEFINER, y su
--     dueño es `postgres`, que es también el dueño de la tabla. RLS no se aplica
--     al dueño salvo que se FUERCE, y abajo se explica por qué no se fuerza.
--   · `aliclik_cod_point_near` la consulta — SECURITY INVOKER, pero la 0100 ya la
--     revocó de anon y authenticated: solo `service_role` puede ejecutarla, y
--     service_role salta RLS.
--   · `order_coverage_for` la consulta a través de la anterior — SECURITY
--     DEFINER, mismo dueño, mismo razonamiento.
--
-- Y es además el patrón que este esquema YA usa para las tablas que solo toca el
-- servidor: `meta_ads`, `whatsapp_numbers`, `chatby_webhook_log`,
-- `shalom_pickup_keys`, `user_presence` y `shipments_status_backup_0108` corren
-- todas con RLS activo y cero políticas. Esta era la excepción, no la regla.
--
-- NO se usa FORCE ROW LEVEL SECURITY. Forzarlo aplicaría RLS también al dueño de
-- la tabla, y como no hay políticas, dejaría a `refresh_aliclik_cod_points` sin
-- poder insertar: el mapa de cobertura se quedaría vacío para siempre y en
-- silencio. El agujero era el GRANT a anon, no la exención del dueño.
-- ============================================================================

-- 1. La raíz del problema: los privilegios. RLS filtra filas, pero el permiso de
--    tabla es la puerta de antes. Se cierra primero para que la tabla quede
--    protegida por dos capas independientes y no por una sola.
revoke all on table public.aliclik_cod_points from anon, authenticated;

-- 2. La segunda capa. Sin políticas: no hay ningún caso de uso legítimo desde el
--    navegador (ver cabecera). Si algún día lo hay, se añade una política que
--    filtre por `auth_org_ids()`, igual que hace supabase/policies.sql en el
--    resto del esquema — no se vuelve a abrir el GRANT.
alter table public.aliclik_cod_points enable row level security;

comment on table public.aliclik_cod_points is
  'Mapa de puntos donde Aliclik ya entregó COD, redondeados a ~1,1 km. Solo servidor: lo reescribe refresh_aliclik_cod_points() y lo consulta order_coverage_for(). RLS activo y sin políticas a propósito (0124) — anon y authenticated no tienen nada que hacer aquí.';
