-- ============================================================================
-- 0156_orders_utm_meta.sql — sacar los UTM del carrito COD a una columna, para
-- que leerlos no cueste tres segundos.
--
-- QUÉ HAY DENTRO. Los pedidos del formulario COD de la web (EasySell) traen los
-- UTM de Meta en `orders.raw.note_attributes`, que es la única pista de qué
-- anuncio los trajo: esos pedidos no tienen conversación de WhatsApp y por
-- tanto no tienen lead (488 de 591 en 30 días), así que «Rendimiento por
-- anuncio» no los ve. El porqué y las reglas de emparejamiento están en
-- `lib/cod-cart-attribution.ts`.
--
-- POR QUÉ UNA COLUMNA Y NO UNA CONSULTA. `raw` es un jsonb grande y vive en
-- TOAST. Medido el 11-09-2026 en producción, filtrar 30 días por
-- `raw->'note_attributes' @> '[{"name":"utm_id"}]'` tarda 2.953 ms y toca
-- 30.304 buffers para devolver 591 filas: hay que descomprimir el `raw` entero
-- de los 7.554 pedidos del rango para mirar diez atributos. Eso en cada carga
-- del tablero. La 0155 existe por exactamente esta clase de lectura, que cerró
-- un ciclo de Supabase en 333 GB sobre 250.
--
-- La columna es GENERADA Y ALMACENADA: se calcula en la escritura, se mantiene
-- sola en cada insert y en cada update de `raw`, y no hay que tocar el ingest
-- ni acordarse de rellenarla.
--
-- POR QUÉ `jsonb_path_query_array` Y NO `jsonb_build_object`, que es lo que
-- pide el cuerpo: una columna generada exige una expresión IMMUTABLE, y
-- `jsonb_build_object` es STABLE —convierte con las funciones de salida del
-- tipo, que dependen de ajustes de sesión—. Postgres rechaza la migración
-- entera con «generation expression is not immutable». `jsonb_path_query_array`
-- sí es immutable, y devuelve los atributos tal cual: una lista de
-- `{name, value}` que el lector indexa por nombre. El orden en que Shopify los
-- guarda cambia de un pedido a otro, así que indexar por posición sería un
-- error esperando a pasar.
--
-- Guarda SOLO los `utm_*` y no el resto de `note_attributes`: el `full_url`
-- trae la URL completa con el `fbclid` —que no sirve para atribuir, es opaco y
-- solo Meta lo resuelve— y meterlo aquí sería arrastrar otra vez el peso del
-- que se venía huyendo.
--
-- El índice es PARCIAL. Son 591 pedidos de 7.554 en 30 días (y 0 antes de
-- agosto de 2026, cuando se montó el formulario), así que un índice sobre la
-- tabla entera ordenaría 21.000 filas para servir 600.
--
-- Idempotente. No borra ni reescribe ningún dato: la columna se deriva de `raw`.
-- ============================================================================

alter table public.orders
  add column if not exists utm_meta jsonb generated always as (
    case
      when raw -> 'note_attributes' @> '[{"name": "utm_id"}]'::jsonb then
        jsonb_path_query_array(raw, '$.note_attributes[*] ? (@.name starts with "utm_")')
      else null
    end
  ) stored;

comment on column public.orders.utm_meta is
  'Los utm_* del carrito COD de la web, sacados de raw.note_attributes en la escritura, como lista de {name,value} SIN orden garantizado. NULL cuando el pedido no trae utm_id (todos los de WhatsApp). Existe para no descomprimir raw en cada carga del tablero: la consulta equivalente sobre raw tardaba 2,9 s. Reglas de emparejamiento en lib/cod-cart-attribution.ts.';

create index if not exists orders_utm_meta_idx
  on public.orders (store_id, created_at desc)
  where utm_meta is not null;
