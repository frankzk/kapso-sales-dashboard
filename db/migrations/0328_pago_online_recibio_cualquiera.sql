-- ============================================================================
-- 0328_pago_online_recibio_cualquiera.sql — «Pago solo online»: cualquier
-- pedido entregado saca al cliente de la lista (MOM §41.11; owner 09-11-2026).
--
-- POR QUÉ. La 0326 contaba como «recibido» solo un `entregado` contra entrega
-- y sin hecho de la migración de plataforma. Así quedaban en la lista 5
-- clientes que sí habían recibido: 4 por agencia (Shalom) y 1 con un contra
-- entrega entregado de la época de la migración. El owner: si ya pagó y
-- recibió una vez, no es un cliente de riesgo.
--
-- QUÉ CAMBIA. Solo `pago_online_candidates`: `received` cuenta CUALQUIER
-- pedido `entregado` del celular en la organización (cualquier `coverage`,
-- con o sin hecho de la migración). Las fallas (devuelto, anulador) y el
-- total de pedidos siguen contándose solo en contra entrega sin la migración,
-- como en la 0326. Misma firma: `pago_online_build` y el freno no cambian.
-- Es `pagoOnlineListOf` en lib/pago-online.ts.
--
-- No cambia datos. Correrla otra vez no cambia nada. Medido el 09-11-2026:
-- la lista pasa de 3.149 a 3.144 clientes.
-- ============================================================================

create or replace function public.pago_online_candidates(p_org uuid)
returns table(phone text, failed integer, reason text, orders integer, emails text[], excepted boolean)
language sql stable
set search_path = public
as $$
  with st as materialized (select s.id from public.stores s where s.org_id = p_org),
  mig as materialized (
    select distinct ev.order_id from public.order_events ev join st on st.id = ev.store_id
    where ev.kind in ('cancelled_woocommerce', 'legacy_shopify_sale_cancelled', 'woo_sale_ended_pending_return')
  ),
  h as materialized (
    select right(regexp_replace(coalesce(om.customer_phone, ''), '\D', '', 'g'), 9) as phone,
      count(*)::int as orders,
      count(*) filter (where om.general_status = 'devuelto')::int as devueltos,
      count(*) filter (where om.general_status = 'anulado')::int as anulados
    from public.order_master om join st on st.id = om.store_id
    where om.coverage in ('lima', 'provincia_cod')
      and not exists (select 1 from mig where mig.order_id = om.order_id)
    group by 1
  ),
  -- 0328: «recibió» es cualquier pedido entregado del celular, sea cual sea su
  -- cobertura y aunque tenga un hecho de la migración.
  rcv as materialized (
    select distinct right(regexp_replace(coalesce(om.customer_phone, ''), '\D', '', 'g'), 9) as phone
    from public.order_master om join st on st.id = om.store_id
    where om.general_status = 'entregado'
  ),
  l as materialized (
    select h.phone,
      case when h.devueltos >= 1 then h.devueltos else h.anulados end as failed,
      case when h.devueltos >= 1 then 'devuelto' else 'anulador' end as reason,
      h.orders
    from h
    where length(h.phone) = 9
      and not exists (select 1 from rcv where rcv.phone = h.phone)
      and (h.devueltos >= 1
           -- (B) el anulador: 5 y 0,75, los mismos de lib/pago-online.ts.
           or (h.orders >= 5 and h.anulados::numeric >= 0.75 * h.orders))
  ),
  e as materialized (
    select right(regexp_replace(coalesce(o.customer_phone, ''), '\D', '', 'g'), 9) as phone,
      lower(btrim(coalesce(o.raw->'woo'->'billing'->>'email', o.raw->'billing'->>'email', o.raw->>'email'))) as email
    from public.orders o join st on st.id = o.store_id
    where coalesce(o.raw->'woo'->'billing'->>'email', o.raw->'billing'->>'email', o.raw->>'email') like '%@%'
  ),
  ev as materialized (
    select e.email, min(e.phone) as phone from e
    where e.email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(e.email) <= 254 and length(e.phone) = 9
    group by e.email having count(distinct e.phone) = 1
  ),
  em as materialized (select ev.phone, array_agg(ev.email order by ev.email) as emails from ev group by ev.phone)
  select l.phone, l.failed, l.reason, l.orders, coalesce(em.emails, '{}'::text[]),
    exists (select 1 from public.pago_online_exceptions x where x.org_id = p_org and x.phone = l.phone and x.removed_at is null)
  from l left join em on em.phone = l.phone
  order by l.phone;
$$;

revoke all on function public.pago_online_candidates(uuid) from public, anon, authenticated;
grant execute on function public.pago_online_candidates(uuid) to service_role;
