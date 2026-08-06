-- 0104 — La cobertura del Master se pregunta a la base, no se recalcula en TS.
--
-- EL PROBLEMA. La 0100 enseñó a `order_coverage_for` a decidir la cobertura COD
-- por COORDENADA además de por nombre de tarifa. Arregló la columna
-- `order_master.coverage` —la escribe el trigger `order_master_coverage`— pero
-- no a `classifyOrderCoverage` en TypeScript, que siguió resolviendo solo por
-- nombre. Y ese valor de TS, no la columna, es el que alimenta a
-- `classifyOperation` y por tanto a `macro_operation`.
--
-- El resultado son filas que se contradicen a sí mismas: `coverage` dice
-- `provincia_cod` y `macro_operation` dice `agencia`. 585 pedidos, 578 de ellos
-- explicados exactamente por la regla de coordenada que al TS le falta. Como
-- `agencyPaymentReady` solo exige abono validado cuando la operación es
-- Agencia, esos pedidos de provincia COD quedaron congelados en «Por confirmar»
-- esperando un adelanto que su modalidad no pide. 212 estaban ahí, 56 con la
-- guía ya creada: el caso que lo destapó fue #KP125383, Puerto Maldonado por
-- Aliclik — la MISMA ciudad que la 0100 nombra como su caso motivador.
--
-- LA IDEA. No portar la regla de coordenada a TypeScript: eso deja dos
-- definiciones vivas y libres de divergir de nuevo, que es precisamente cómo
-- nació este bug. `order_coverage_for` ya es la definición canónica —así lo
-- declara el comentario de `recomputeOrderMaster`— así que el recompute pasa a
-- preguntársela a ella. Esta función es solo el envoltorio por lotes: un ida y
-- vuelta por tanda en vez de uno por pedido.
--
-- Devuelve una fila por elemento del arreglo, en el mismo orden. Las claves
-- ausentes o nulas llegan como null y `order_coverage_for` ya sabe tratarlas
-- (sin distrito devuelve `por_revisar`; sin coordenada, se salta el mapa COD).

create or replace function order_coverage_batch(
  p_rows jsonb,
  p_day date default current_date
)
returns table (order_id uuid, coverage text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    (r->>'order_id')::uuid,
    order_coverage_for(
      (r->>'store_id')::uuid,
      r->>'region',
      r->>'province',
      r->>'district',
      (r->>'latitude')::double precision,
      (r->>'longitude')::double precision,
      p_day
    )
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r;
$function$;

comment on function order_coverage_batch(jsonb, date) is
  'Cobertura canónica para una tanda de pedidos. Envoltorio de order_coverage_for '
  'para que el recompute del Master no reimplemente la clasificación en TypeScript.';

revoke all on function order_coverage_batch(jsonb, date) from public, anon, authenticated;
grant execute on function order_coverage_batch(jsonb, date) to service_role;
