-- ============================================================================
-- 0241_order_master_stale_cerrada.sql — la función del desfase, como corre en
-- producción: sin `p_scan`, con un solo agregado y cerrada al navegador.
--
-- POR QUÉ HAY DOS. El 10-10-2026 el tope de 20.000 filas de la 0123 se arregló
-- dos veces en paralelo: la 0240 (#920) le quitó el recorte dejando `p_scan`
-- opcional, y el #918 rehízo la función sin `p_scan`. En producción quedó la
-- del #918, aplicada a mano en el SQL Editor a las 22:45 UTC. Esta migración
-- lleva al repositorio lo que corre allí, para que una base nueva y la de
-- producción tengan la misma función.
--
-- QUÉ CAMBIA RESPECTO DE LA 0240:
--
--   * Un agregado de las guías y un hash join, en vez de un `lateral` por
--     pedido. Mismo resultado, medido en producción sobre Kenku (23.939
--     pedidos, 18.855 guías): 52 ms, contra 90 ms de la 0240 y 82 ms de la
--     0123. El agregado sale del índice `shipments_order_updated_idx` (0123).
--   * Sin `p_scan`. Nadie lo pasa —el barrido llama con `p_store_id` y
--     `p_limit` por nombre— y un tope por cantidad es justo lo que dejó fuera a
--     los pedidos vivos. Sin el argumento, nadie puede volver a ponerlo.
--   * PERMISOS. La 0123 y la 0240 concedían a `service_role`, pero en Postgres
--     una función nace ejecutable por PUBLIC, y `anon` y `authenticated` la
--     podían llamar. Siendo SECURITY DEFINER se salta la RLS: con la clave
--     pública y el id de una tienda devolvía ids de pedidos ajenos. Se cierra
--     como las funciones recientes (0230, 0236, 0238).
--
-- Se aplica en una sola transacción: quien llame durante la migración ve una
-- función o la otra, nunca ninguna. En producción ya está aplicada; correrla
-- otra vez no cambia nada (`drop ... if exists` y `create or replace`).
-- ============================================================================

drop function if exists order_master_stale(uuid, int, int);

create or replace function order_master_stale(
  p_store_id uuid,
  p_limit int default 1000
)
returns table (order_id uuid, recomputed_at timestamptz, guide_updated_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select m.order_id, m.recomputed_at, g.guide_updated_at
  from order_master m
  join (
    select s.order_id, max(s.updated_at) as guide_updated_at
    from shipments s
    group by s.order_id
  ) g on g.order_id = m.order_id
  where m.store_id = p_store_id
    and g.guide_updated_at > m.recomputed_at
  order by m.recomputed_at asc
  limit p_limit;
$function$;

comment on function order_master_stale(uuid, int) is
  'Pedidos cuya fila del Master es anterior a la última escritura de sus guías. Definición canónica del desfase (0123); sin tope de recorrido desde la 0240: mira todos los pedidos de la tienda, del recálculo más viejo al más nuevo.';

revoke all on function order_master_stale(uuid, int) from public, anon, authenticated;
grant execute on function order_master_stale(uuid, int) to service_role;
