-- 0228_lead_shopify_location.sql — la dirección que Shopify tiene del cliente,
-- como tercera pista del filtro de cobertura de la cola de leads.
--
-- POR QUÉ. Después de mirar lo que dijo el lead (su carrito, su chat) y el
-- último pedido de su celular (0225), quedan ~1.900 «Sin llamar» sin ubicación
-- (medido el 05-10-2026). La base ya tiene TODOS los pedidos desde que abrió
-- cada tienda, pero NO todos los carritos: los de Kenku empiezan el 06-05-2026.
-- Cada carrito del formulario COD de antes creó en Shopify un cliente con su
-- dirección, y esa dirección solo está allá. La sincronización la busca por
-- celular con la conexión de la tienda (`read_customers`, que ya se usa para
-- «Pedidos anteriores») y la guarda aquí.
--
-- POR QUÉ UNA TABLA Y NO COLUMNAS EN `leads`. Dos razones:
--   1. Separa lo que dijo el lead de lo que sabe Shopify. `leads.district` es
--      «dio su distrito» y decide el segmento `interes`; un carrito de hace un
--      año no es una señal de compra de hoy.
--   2. Escribir en `leads` dispara `leads_touch`, que mueve la firma de la cola
--      (0059) y hace que todas las pantallas abiertas recarguen la cola entera.
--      Esta tabla no la toca.
--
-- UNA FILA POR LEAD CONSULTADO, haya o no dirección: `checked_at` es lo que
-- impide volver a preguntarle a Shopify por el mismo celular en cada corrida.

create table if not exists lead_shopify_locations (
  lead_id    uuid primary key references leads(id) on delete cascade,
  store_id   uuid not null references stores(id) on delete cascade,
  -- `defaultAddress.province` y `.city` del cliente, como los manda Shopify:
  -- la región («Lima (provincia)», «Arequipa») y la ciudad o distrito.
  province   text,
  city       text,
  checked_at timestamptz not null default now()
);

-- La cola solo lee las filas que encontraron algo.
create index if not exists lead_shopify_locations_found_idx
  on lead_shopify_locations (store_id)
  where province is not null or city is not null;

comment on table lead_shopify_locations is
  'Dirección por defecto del cliente en Shopify, buscada por celular para los leads sin ubicación. Pista del filtro de cobertura (lib/lead-coverage.ts), no la dirección del lead. Una fila por lead consultado, con o sin dirección.';

alter table lead_shopify_locations enable row level security;

drop policy if exists lead_shopify_locations_select on lead_shopify_locations;
create policy lead_shopify_locations_select on lead_shopify_locations for select to authenticated
  using (store_id in (select auth_store_ids()));

-- REVOKE ANTES DE GRANT: Supabase da `all` por defecto a las tablas nuevas.
revoke all on lead_shopify_locations from anon, authenticated, service_role;
grant select on lead_shopify_locations to authenticated;
grant select, insert, update on lead_shopify_locations to service_role;

-- ----------------------------------------------------------------------------
-- lead_shopify_location_candidates — a quién buscar en esta corrida
-- ----------------------------------------------------------------------------
-- Los leads de la cola (open/hot, fuera de Yape) que no dicen dónde viven, que
-- no tienen un pedido anterior con el mismo celular (0225 ya los ubica) y que
-- todavía no se consultaron. Los más nuevos primero: son los que se van a
-- llamar antes. Va en SQL porque el `not exists` contra dos tablas no se puede
-- escribir en PostgREST.
create or replace function public.lead_shopify_location_candidates(
  p_store_id uuid,
  p_limit integer default 30
)
returns table (lead_id uuid, phone text)
language sql
stable
security invoker
set search_path = public
as $fn$
  select l.id, l.phone
  from leads l
  where l.store_id = p_store_id
    and l.category in ('open', 'hot')
    and l.status <> 'yape_por_verificar'
    and l.phone is not null
    and l.draft_order_gid is null
    and coalesce(trim(l.district), '') = ''
    and coalesce(trim(l.region), '') = ''
    and coalesce(trim(l.province), '') = ''
    and not exists (select 1 from lead_shopify_locations s where s.lead_id = l.id)
    and not exists (
      select 1 from order_master o
      where o.customer_phone = l.phone
        and o.coverage in ('lima', 'provincia_cod', 'agencia')
    )
  order by l.first_seen_at desc nulls last
  limit greatest(p_limit, 0);
$fn$;

revoke all on function public.lead_shopify_location_candidates(uuid, integer) from public, anon, authenticated;
grant execute on function public.lead_shopify_location_candidates(uuid, integer) to service_role;

-- ----------------------------------------------------------------------------
-- lead_shopify_location_hints — lo que lee la cola
-- ----------------------------------------------------------------------------
-- Las direcciones encontradas de los leads que están HOY en «Por llamar». La
-- tabla guarda también las de leads ya cerrados; filtrarlas aquí evita
-- mandarle a la pantalla filas que no va a usar. `security invoker`: la RLS de
-- las dos tablas decide qué tiendas ve quien mira.
create or replace function public.lead_shopify_location_hints(p_store_ids uuid[])
returns table (lead_id uuid, province text, city text)
language sql
stable
security invoker
set search_path = public
as $fn$
  select s.lead_id, s.province, s.city
  from lead_shopify_locations s
  join leads l on l.id = s.lead_id
  where s.store_id = any(p_store_ids)
    and (s.province is not null or s.city is not null)
    and l.category in ('open', 'hot')
    and l.status <> 'yape_por_verificar';
$fn$;

revoke all on function public.lead_shopify_location_hints(uuid[]) from public, anon;
grant execute on function public.lead_shopify_location_hints(uuid[]) to authenticated, service_role;
