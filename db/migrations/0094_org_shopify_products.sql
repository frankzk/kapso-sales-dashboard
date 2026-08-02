-- 0094_org_shopify_products.sql — catálogo de productos derivado de Shopify.
--
-- Kapta no crea productos: son siempre los de Shopify (principios 1 y 3). No hay
-- tabla de catálogo propia; el SKU y el título llegan embebidos en
-- `orders.line_items` (ver 0055_aliclik_catalog). La pestaña «Costos de
-- productos» necesita esa lista real para asignar costo a lo que existe, en vez
-- de que un administrador teclee el SKU a mano.
--
-- Esta función deriva, por organización, los SKU distintos vistos en pedidos,
-- con un nombre representativo (el título más reciente) y en cuántos pedidos
-- aparecen. La agrupación es case-insensitive (lower) para no partir el mismo
-- producto en dos por diferencias de mayúsculas; devuelve un SKU representativo.
-- La resolución de costo (lib/costs.ts) ya compara SKU sin distinguir mayúsculas
-- ni acentos, así que el costo asignado calza con el SKU del pedido igual.

create or replace function public.org_shopify_products(p_org_id uuid)
returns table (sku text, product_name text, order_count bigint)
language sql
stable
set search_path = public
as $$
  with valid as (
    select
      o.id as order_id,
      o.created_at,
      btrim(elem->>'sku') as sku,
      nullif(btrim(elem->>'title'), '') as title
    from orders o
    join stores s on s.id = o.store_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
    ) as elem
    where s.org_id = p_org_id
      and btrim(elem->>'sku') <> ''
  ),
  names as (
    select distinct on (lower(sku))
      lower(sku) as sku_key,
      title
    from valid
    where title is not null
    order by lower(sku), created_at desc nulls last
  ),
  counts as (
    select
      lower(sku) as sku_key,
      min(sku) as sku_display,
      count(distinct order_id) as order_count
    from valid
    group by lower(sku)
  )
  select c.sku_display as sku, n.title as product_name, c.order_count
  from counts c
  left join names n on n.sku_key = c.sku_key
  order by c.order_count desc, c.sku_display;
$$;

-- Solo el service role la invoca, desde la acción de servidor que ya exige rol
-- de administrador de la organización antes de pasarle el org_id.
revoke all on function public.org_shopify_products(uuid) from public;
grant execute on function public.org_shopify_products(uuid) to service_role;
