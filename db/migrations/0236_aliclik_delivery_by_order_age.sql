-- La entrega de Aliclik según los días que lleva el pedido al crear la guía
-- (09-10-2026). La ficha avisa antes de crear la guía de un pedido viejo:
-- «Pedido de 5 días · Aliclik entrega ~27 %».
--
-- La unidad es la GUÍA, no el pedido: `order_master.dispatched_at` se mueve
-- cuando un envío falla y se reprograma, así que medir el pedido por su
-- despacho le ponía más días justo a los que fallaron y exageraba la caída.
-- Aquí cuenta:
--   - la primera guía del pedido (un reenvío es otra historia), creada por la
--     API de Aliclik (su `created_at` es la hora real de creación);
--   - que salió del almacén (las anuladas antes de recoger no son entregas
--     fallidas);
--   - con resultado: entregada (`delivered`) o cerrada/transferida sin entrega;
--   - creada entre 70 y 14 días atrás, para que el resultado ya se sepa.
-- Los días son de calendario en Lima, de la creación del pedido a la de la
-- guía; el tramo 3 junta «3 días o más».
--
-- SECURITY INVOKER: con RLS, cada usuario ve solo las tiendas a las que tiene
-- acceso.

create or replace function public.aliclik_delivery_by_order_age()
returns table (
  store_id uuid,
  age_bucket integer,
  settled integer,
  delivered integer,
  window_from date,
  window_to date
)
language sql
stable
security invoker
set search_path = public
as $$
  with w as (
    select (now() at time zone 'America/Lima')::date - 70 as d_from,
           (now() at time zone 'America/Lima')::date - 14 as d_to
  ),
  g as (
    select s.store_id,
           (s.created_at at time zone 'America/Lima')::date
             - (o.created_at at time zone 'America/Lima')::date as age,
           s.status_category
    from shipments s
    join orders o on o.id = s.order_id
    cross join w
    where s.courier = 'aliclik'
      and s.created_via = 'aliclik_api'
      and s.created_at >= (w.d_from::timestamp at time zone 'America/Lima')
      and s.created_at < (w.d_to::timestamp at time zone 'America/Lima')
      and s.status_category in ('delivered', 'closed', 'transferred')
      and (s.dispatched_at is not null or s.status_category = 'delivered' or s.returned_at is not null)
      and not exists (
        select 1 from shipments p
        where p.order_id = s.order_id and p.id <> s.id and p.created_at < s.created_at
      )
  )
  select g.store_id,
         least(g.age, 3)::integer as age_bucket,
         count(*)::integer as settled,
         (count(*) filter (where g.status_category = 'delivered'))::integer as delivered,
         w.d_from as window_from,
         w.d_to as window_to
  from g cross join w
  where g.age >= 0
  group by g.store_id, least(g.age, 3), w.d_from, w.d_to
$$;

revoke all on function public.aliclik_delivery_by_order_age() from public;
grant execute on function public.aliclik_delivery_by_order_age() to authenticated, service_role;
