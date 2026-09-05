-- Las tablas append-only tenían UPDATE, DELETE y TRUNCATE concedidos.
--
-- CÓMO SE VIO. Al aplicar 0144 en producción, los permisos reales de
-- `lead_experiments` no eran los que concede la migración: salían
-- DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE para anon,
-- authenticated y service_role. Lo mismo en `order_sales`. `order_events` (0045)
-- sí estaba bien, y esa diferencia es la pista: se creó antes de que el proyecto
-- tuviera la configuración por defecto de Supabase.
--
-- POR QUÉ PASA. Supabase trae
--   alter default privileges in schema public
--     grant all on tables to anon, authenticated, service_role;
-- así que toda tabla nueva NACE con todos los permisos. Un `grant select`
-- posterior no revoca nada — los grants suman. La migración creía estar
-- restringiendo y solo estaba confirmando algo que ya tenía.
--
-- POR QUÉ IMPORTA, y no es solo higiene. La cabecera de 0132 promete dos capas:
-- "la vía de la API queda cerrada por privilegios y el trigger es defensa en
-- profundidad". Había una. Y la que faltaba es la única que cubre TRUNCATE: los
-- triggers `reject_mutation` son de FILA sobre update/delete (tgtype = 27), y
-- TRUNCATE no dispara triggers de fila. O sea que "de quién es la venta,
-- decidido una vez y para siempre" se podía borrar entero con un truncate desde
-- cualquier rol que tuviera el permiso, anon incluido.
--
-- El alcance real era menor de lo que suena —PostgREST no expone TRUNCATE, así
-- que no se llegaba desde la app— pero la garantía que el código afirma tener no
-- existía, y eso es lo que se arregla.
--
-- REVOCAR ES SEGURO POR CONSTRUCCIÓN: lo que se quita ya estaba bloqueado por el
-- trigger para update y delete, así que ningún camino que funcione hoy puede
-- depender de ello. Lo único que se pierde es la capacidad de truncar, que es
-- justamente el agujero.
--
-- VA SOBRE LAS SIETE, no solo sobre las dos que estaban mal. En producción hoy
-- las otras cinco tienen los permisos correctos, pero eso es suerte de
-- calendario: nacieron antes de que el proyecto tuviera los privilegios por
-- defecto. Si la base se reconstruyera hoy sobre Supabase, `pickup_key_views`,
-- `dispatch_events` y compañía nacerían abiertas exactamente igual.
--
-- Dejarlo dependiente de la fecha de creación sería un invariante que solo se
-- cumple por accidente, y encima invisible: no hay nada en sus migraciones que
-- diga "estas están bien porque son viejas". Aplicándolo a todas, la regla pasa
-- a ser una que se puede comprobar —y que el test de arriba comprueba— sin
-- listas de excepciones.
--
-- Idempotente: revoke/grant se pueden repetir sin efecto. Las cinco que ya
-- estaban bien no cambian.

do $$
declare
  t text;
begin
  foreach t in array array[
    'order_sales', 'lead_experiments', 'order_events', 'dispatch_events',
    'pickup_key_views', 'aliclik_webhook_events', 'rider_settlement_line_corrections'
  ] loop
    -- `if exists` porque el orden de las migraciones no garantiza que todas
    -- estén creadas al llegar aquí en una base nueva.
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on public.%I from anon, authenticated, service_role', t);
      execute format('grant select on public.%I to authenticated', t);
      execute format('grant select, insert on public.%I to service_role', t);
    end if;
  end loop;
end $$;
