-- ============================================================================
-- 0300_order_master_product_titles.sql — el filtro «Producto» del Master de
-- Pedidos (MOM §6, «Los filtros del Master», pedido del owner 02-11-2026).
--
-- POR QUÉ UNA COLUMNA. El Master filtra en la base y pagina (~35.000 pedidos),
-- y `order_master` no sabía qué productos lleva cada pedido: eso vive en
-- `orders.line_items`. Resolverlo trayendo ids al navegador o con un `in(...)`
-- de miles de ids no cabe en la URL ni cuenta bien las pestañas. Con la columna
-- y su índice GIN el filtro es un `&&` más, como «Salió con» (0266).
--
-- QUÉ GUARDA. Los títulos de producto del pedido (`line_items[].title`, que en
-- Shopify y WooCommerce ya es el producto SIN la variante), con los espacios
-- recortados y juntados, sin repetir y en el orden de las líneas. La escribe el
-- recálculo del pedido (lib/order-master.ts con `orderProductTitles`,
-- lib/order-product-titles.ts); `order_product_titles` es la misma regla en SQL
-- y aquí solo rellena lo que ya existe. test/order-product-titles.test.ts
-- comprueba que las dos digan lo mismo.
--
-- COSTO DEL RELLENO (medido el 02-11-2026 con un SELECT de solo lectura). Un
-- solo UPDATE sobre las 35.322 filas: calcular los títulos tarda ~1,2 s; la
-- escritura reescribe cada fila una vez (184 MB la tabla con índices). Se
-- espera del orden de segundos a pocas decenas de segundos. Mientras dura, el
-- recálculo del Master que toque esas filas espera el commit; no se cae. El
-- índice se crea DESPUÉS del UPDATE para que este no lo mantenga fila a fila
-- (y pueda ser HOT). Re-aplicarla no reescribe nada: solo toca la fila cuyo
-- valor difiere de la regla. Como 0264, mueve `order_master.updated_at` (el
-- trigger `order_master_touch`) de las filas que rellena.
--
-- OPCIONES. `order_master_product_options(p_store_ids)` devuelve, por tienda y
-- producto, cuántos pedidos lo llevan. Un solo jsonb (como `master_facets`) para
-- no chocar con el tope de filas de PostgREST. SECURITY INVOKER: respeta la RLS
-- de `order_master` con el cliente de sesión.
-- ============================================================================

alter table order_master add column if not exists product_titles text[] not null default '{}';

create or replace function public.order_product_titles(p_line_items jsonb)
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(x.title order by x.first_line), '{}'::text[])
  from (
    select btrim(regexp_replace(e.li ->> 'title', '\s+', ' ', 'g')) as title,
           min(e.pos) as first_line
    from jsonb_array_elements(
           case when jsonb_typeof(p_line_items) = 'array' then p_line_items else '[]'::jsonb end
         ) with ordinality as e(li, pos)
    where jsonb_typeof(e.li -> 'title') in ('string', 'number')
    group by 1
  ) x
  where x.title <> ''
$$;

-- Relleno de lo existente, en un solo UPDATE (ver el costo arriba).
update order_master om
   set product_titles = order_product_titles(o.line_items)
  from orders o
 where o.id = om.order_id
   and om.product_titles is distinct from order_product_titles(o.line_items);

create index if not exists order_master_product_titles_idx
  on order_master using gin (product_titles);

create or replace function public.order_master_product_options(p_store_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('store_id', q.store_id, 'title', q.title, 'orders', q.order_count)
      order by q.order_count desc, q.title
    ),
    '[]'::jsonb
  )
  from (
    select om.store_id, t.title, count(*) as order_count
    from order_master om
    cross join lateral unnest(om.product_titles) as t(title)
    where om.store_id = any(p_store_ids)
    group by om.store_id, t.title
  ) q
$$;

revoke all on function public.order_master_product_options(uuid[]) from public, anon;
grant execute on function public.order_master_product_options(uuid[]) to authenticated, service_role;
