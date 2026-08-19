-- ============================================================================
-- 0123_order_master_stale.sql — qué filas del Master se quedaron viejas, sin
-- ventana de recencia y con la definición en UN solo sitio.
--
-- EL PROBLEMA. La cuarta puerta del barrido (#453) detecta el desfase comparando
-- el `updated_at` de la guía contra el `recomputed_at` de su fila del Master. La
-- regla es la correcta. Lo que estaba mal era de dónde salían los candidatos:
--
--     .order("updated_at", { ascending: false })
--     .limit(2000)                                  -- SHIPMENT_STALE_PAGE
--
-- Eso no es «los datos», es una VENTANA DE RECENCIA. PostgREST no sabe comparar
-- dos columnas de tablas distintas, así que la comparación se hacía en
-- TypeScript sobre las 2.000 escrituras más recientes de la tienda — y un pedido
-- que cae por debajo de esa línea no puede volver a entrar nunca: cada guía
-- nueva lo hunde un poco más.
--
-- MEDIDO EN PRODUCCIÓN (18-08-2026, tienda Kenku):
--
--     linea_de_flotacion │ atascados │ bajo_la_linea
--     2026-08-15 02:32   │    487    │      381
--
-- 381 pedidos invisibles de forma permanente, mostrando una etapa que dejó de
-- ser la suya hace días. Y no era un atasco pasajero: el barrido recalculaba 620
-- pedidos por hora en esa misma tienda. No es que no le diera tiempo — es que no
-- los veía.
--
-- LA CORRECCIÓN es preguntar por el DESFASE, que es lo que la MOM §19.1 decía
-- desde el principio: «el read-model se reconcilia contra los datos, no contra
-- las llamadas». Una ventana de las 2.000 más recientes seguía siendo una
-- llamada disfrazada de dato.
--
-- POR QUÉ EN LA BASE Y NO EN TYPESCRIPT. Porque la comparación entre dos tablas
-- es lo que TypeScript no podía hacer, y ese es justo el motivo de que existiera
-- la ventana. Puesta acá desaparece el techo, y de paso la definición de
-- «desfasado» pasa a vivir en UN solo sitio — igual que `order_coverage_for`
-- desde la 0104, y por la misma razón: dos definiciones de la misma regla es el
-- desperfecto que este repositorio lleva media docena de incidentes pagando.
-- `staleByShipment` en TypeScript se retira con esta migración.
--
-- EL ORDEN NO ES UN ADORNO. Se recorre por `recomputed_at` ASCENDENTE, del más
-- viejo al más nuevo, y por dos motivos:
--
--   1. Los pedidos más desatendidos salen PRIMERO. Un atraso se drena empezando
--      por lo que lleva más tiempo mintiendo en pantalla.
--   2. Permite parar pronto. Con el índice de abajo el planificador recorre en
--      ese orden y se detiene al juntar `p_limit`, sin visitar el resto.
--
-- EL TOPE DE RECORRIDO (`p_scan`) NO ES LA VENTANA DE ANTES, y la diferencia es
-- toda la migración. Aquella acotaba por *escritura reciente*, que es donde NO
-- están los desfasados. Este acota el recorrido en el orden que los pone
-- delante, así que lo que se queda fuera es siempre lo más recientemente
-- recalculado — es decir, lo que menos falta hace mirar. Existe solo para que
-- una pasada tenga coste acotado cuando no hay nada que hacer, que es el caso
-- normal.
-- ============================================================================

-- ⚠️ AL APLICAR ESTO EN PRODUCCIÓN, LEE ESTO PRIMERO.
--
-- Los dos `create index` de abajo BLOQUEAN LAS ESCRITURAS de su tabla mientras
-- se construyen. En el clúster desechable de CI son instantáneos porque está
-- vacío; sobre `shipments` en producción no lo son, y durante ese rato la
-- operación no puede escribir guías.
--
-- Aplícalos ANTES y por separado, en su forma concurrente, que no bloquea:
--
--   create index concurrently if not exists order_master_store_recomputed_idx
--     on order_master (store_id, recomputed_at);
--   create index concurrently if not exists shipments_order_updated_idx
--     on shipments (order_id, updated_at desc);
--
-- (`concurrently` no puede ir dentro de una transacción, y por eso no está
-- escrito así acá: db/apply.sql aplica las migraciones en bloque y fallaría.)
-- Después corre este fichero: al encontrarlos ya creados se los salta y solo
-- define la función.
--
-- Y APLÍCALA. Los despliegues NO aplican migraciones —`build` es `next build` a
-- secas— así que desplegar el código sin correr esto deja el RPC inexistente y
-- la cuarta puerta del barrido sin ver nada. Pasó el 19-08-2026: el código salió
-- con el #462 y la migración se quedó sin aplicar. Desde entonces el informe del
-- cron trae `staleDoorError` para que ese caso deje de parecerse a «no hay nada
-- desfasado».

-- Recorrido por antigüedad del recálculo, dentro de una tienda. Es el índice que
-- permite parar pronto: sin él, cada pasada leería la tabla entera.
create index if not exists order_master_store_recomputed_idx
  on order_master (store_id, recomputed_at);

-- La comprobación «¿alguna guía de este pedido se escribió después?». Con este
-- índice es una búsqueda, no un recorrido de las guías del pedido.
create index if not exists shipments_order_updated_idx
  on shipments (order_id, updated_at desc);

create or replace function order_master_stale(
  p_store_id uuid,
  p_limit int default 1000,
  p_scan int default 20000
)
returns table (order_id uuid, recomputed_at timestamptz, guide_updated_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- `exists` y no un join: en cuanto encuentra UNA guía posterior deja de mirar
  -- las demás del pedido. Un join tendría que reunirlas todas para descartarlas.
  select c.order_id, c.recomputed_at, c.guide_updated_at
  from (
    select m.order_id,
           m.recomputed_at,
           (select max(s.updated_at) from shipments s where s.order_id = m.order_id)
             as guide_updated_at
    from order_master m
    where m.store_id = p_store_id
    order by m.recomputed_at asc
    limit p_scan
  ) c
  where c.guide_updated_at is not null
    and c.guide_updated_at > c.recomputed_at
  limit p_limit;
$function$;

comment on function order_master_stale(uuid, int, int) is
  'Pedidos cuya fila del Master es anterior a la última escritura de sus guías. Definición canónica del desfase (0123): sin ventana de recencia, del recálculo más viejo al más nuevo. Reemplaza a staleByShipment en TypeScript.';

grant execute on function order_master_stale(uuid, int, int) to service_role;
