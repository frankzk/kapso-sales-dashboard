-- ============================================================================
-- 0115_order_prefix_por_tienda.sql — el prefijo del pedido es POR TIENDA, y
-- limpieza de las conjeturas que se hicieron con el prefijo de otra.
--
-- El importador de Aliclik, cuando la NOTA trae el número de pedido pelado
-- ("119358 - referencia"), lo completaba con "#KP" fijo (lib/aliclik-import.ts).
-- Para Kenku acertaba por casualidad; para Aurela inventaba un pedido que no
-- existe.
--
-- Y no era cosmético: `shipment-auto-match` usa ese nombre para decidir EN QUÉ
-- TIENDA buscar el pedido (`pickStoresForOrderQuery`). Con un "#KP…" en una guía
-- de Aurela, la búsqueda salía al Shopify de Kenku, donde nunca iba a estar. Por
-- eso 153 guías de Aurela llevaban meses sin enlazar: no les faltaba el pedido,
-- se buscaba en la tienda equivocada.
-- ============================================================================

-- ── 1. El prefijo, tomado del propio dato ───────────────────────────────────
-- No se pide configurarlo: cada tienda ya lo declara en los nombres de sus
-- pedidos, y sale inequívoco (AUR 2373 pedidos, KP 10797, sin competencia).
alter table stores
  add column if not exists order_prefix text;

comment on column stores.order_prefix is
  'Prefijo de los nombres de pedido de Shopify de esta tienda, sin "#" (KP, AUR). Lo usa el importador de Aliclik para completar un número pelado, y el auto-match para saber en qué tienda buscar. NULL ⇒ no se adivina el pedido a partir de un número suelto.';

update stores s
   set order_prefix = p.prefijo
  from (
    select store_id,
           substring(name from '^#([A-Za-z]+)') as prefijo,
           row_number() over (
             partition by store_id
             order by count(*) desc
           ) as rn
      from orders
     where name is not null
     group by store_id, 2
  ) p
 where p.store_id = s.id
   and p.rn = 1
   and p.prefijo is not null
   and s.order_prefix is null;

-- ── 2. Las guías ya enlazadas: manda el nombre REAL del pedido ──────────────
-- El enlace (`order_id`) siempre estuvo bien —se verificó que apunta a la misma
-- tienda—; lo que quedó mal es el texto desnormalizado que se pintaba al lado.
-- Esto además cubre cualquier deriva futura, no solo la de este bug.
update shipments sh
   set order_name = o.name
  from orders o
 where sh.order_id = o.id
   and o.name is not null
   and sh.order_name is distinct from o.name;

-- ── 3. Las guías sin enlace y con prefijo ajeno: la conjetura se borra ──────
-- Un "#KP115389" en una guía de Aurela no es un pedido: es basura que además
-- desvía la búsqueda a la otra tienda. Dejarlo en NULL devuelve la guía a la
-- cola de auto-match, que ahora la buscará contra SU tienda — varias deberían
-- enlazarse solas.
--
-- La condición es general (prefijo distinto al de la tienda), no un parche a
-- Aurela: si mañana entra una tercera tienda, aplica igual.
update shipments sh
   set order_name = null
  from stores s
 where s.id = sh.store_id
   and sh.order_id is null
   and sh.order_name is not null
   and s.order_prefix is not null
   and upper(substring(sh.order_name from '^#?([A-Za-z]+)'))
       is distinct from upper(s.order_prefix);
