-- 0224_lead_prior_order_coverage.sql — la cobertura del último pedido del
-- mismo teléfono, para el filtro Lima / Provincia de la cola de leads.
--
-- POR QUÉ. La cola se quiere partir por cobertura, pero el 71 % de los leads
-- «Sin llamar» no dejó ni distrito ni región (medido el 04-10-2026: ~2.140 de
-- ~3.000). Una parte de ellos ya compró antes, y su pedido sí tiene la
-- cobertura calculada por `order_coverage_for`: 290 de esos leads sin dato
-- tienen pedido previo con el mismo teléfono, 106 de ellos en Lima. Es la
-- mejor pista que hay después de la dirección del propio lead (lib/lead-coverage.ts).
--
-- QUÉ NO ES. No escribe nada ni le pone cobertura al lead: la cola lo lee y
-- decide en el cliente, donde ya se cuentan los demás filtros. La cobertura
-- canónica sigue siendo la del pedido (MOM §5).
--
-- El universo es el de «Por llamar» (`getStoreLeads`): open/hot y fuera de
-- Yape. Se cruza por teléfono EXACTO —leads y pedidos lo guardan con el mismo
-- formato «51 9…»— y sin acotar por tienda, como el historial del cliente
-- (0101): la persona es la misma compre en Kenku o en Aurela. La RLS decide qué
-- pedidos ve cada quien, por eso la función es `security invoker`.
--
-- Coste medido sobre producción: 34 ms para los ~6.900 leads de la cola de las
-- dos tiendas (hash join contra los ~27.400 pedidos); 806 leads con pedido.
-- Mientras la migración no corra, la cola se dibuja igual sin esta pista.

create or replace function public.lead_prior_order_coverage(p_store_ids uuid[])
returns table (lead_id uuid, coverage text)
language sql
stable
security invoker
set search_path = public
as $fn$
  select distinct on (l.id) l.id, o.coverage
  from leads l
  join order_master o on o.customer_phone = l.phone
  where l.store_id = any(p_store_ids)
    and l.category in ('open', 'hot')
    and l.status <> 'yape_por_verificar'
    and l.phone is not null
    and o.customer_phone is not null
    -- «Por revisar» no dice nada de dónde vive: no es pista.
    and o.coverage in ('lima', 'provincia_cod', 'agencia')
  -- El MÁS RECIENTE: si se mudó, su último pedido lo sabe mejor.
  order by l.id, o.order_created_at desc nulls last;
$fn$;

comment on function public.lead_prior_order_coverage(uuid[]) is
  'Cobertura del último pedido del mismo teléfono para los leads de «Por llamar». Pista para el filtro de cobertura de la cola (lib/lead-coverage.ts); no es la cobertura del lead.';

revoke all on function public.lead_prior_order_coverage(uuid[]) from public, anon;
grant execute on function public.lead_prior_order_coverage(uuid[]) to authenticated, service_role;
