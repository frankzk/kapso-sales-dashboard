-- ============================================================================
-- 0333_lista_negra_rechazo.sql — Lista negra automática: quien rechazó en la
-- puerta y nunca recibió (MOM §41.11; owner 12-11-2026).
--
-- POR QUÉ. En Lima un rechazo en la puerta termina `anulado` (solo la
-- anulación en Shopify termina la venta, v1.23), y la regla solo tomaba «1+
-- devuelto» o «5+ pedidos con 75 % anulados». El 12-11-2026 había 135
-- clientes de Lima que rechazaron el pedido en la puerta —121 sin haber
-- recibido nunca nada— y solo 1 estaba en la lista. El owner: «Sí, desde 1
-- rechazo».
--
-- QUÉ CAMBIA.
--   * (C) `rechazo`: con CERO entregados, entra quien rechazó al menos un
--     pedido contra entrega (sin hecho de la migración) en la puerta: el
--     motorizado de Grupo GF lo reportó «Rechazó el pedido»
--     (`stop_reported`, `outcome_reason = 'rechazado'`) o la guía del courier
--     dice `REFUSED` (Aliclik, `etiquetaDiceRechazoEnPuerta`). Cuenta aunque el
--     pedido siga en reprogramación: el rechazo es el hecho.
--   * Prioridad del motivo: devuelto, rechazo, anulador. `failed` es la
--     cuenta de lo que lo hizo entrar (pedidos rechazados, para `rechazo`).
--   * `pago_online_phones.reason` acepta `rechazo`; `pago_online_runs` guarda
--     `rechazos` (cuántos entraron por esta regla) y `pago_online_build` lo
--     devuelve.
-- Es `pagoOnlineListOf` en lib/pago-online.ts.
--
-- No cambia datos. Correrla otra vez no cambia nada. La lista nueva aparece
-- con la corrida siguiente (05:00 de Lima, o «Calcular ahora»).
-- ============================================================================

alter table public.pago_online_phones drop constraint if exists pago_online_phones_reason_check;
alter table public.pago_online_phones
  add constraint pago_online_phones_reason_check check (reason in ('devuelto', 'anulador', 'rechazo'));

alter table public.pago_online_runs add column if not exists rechazos integer not null default 0;

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
  -- 0333: los pedidos rechazados en la puerta.
  rej as materialized (
    select ev.order_id from public.order_events ev join st on st.id = ev.store_id
    where ev.kind = 'stop_reported' and ev.payload->>'outcome_reason' = 'rechazado'
    union
    select sh.order_id from public.shipments sh join st on st.id = sh.store_id
    where sh.order_id is not null
      and upper(btrim(split_part(coalesce(sh.reported_status, ''), ' · ', 1))) = 'REFUSED'
  ),
  h as materialized (
    select right(regexp_replace(coalesce(om.customer_phone, ''), '\D', '', 'g'), 9) as phone,
      count(*)::int as orders,
      count(*) filter (where om.general_status = 'devuelto')::int as devueltos,
      count(*) filter (where om.general_status = 'anulado')::int as anulados,
      count(*) filter (where exists (select 1 from rej where rej.order_id = om.order_id))::int as rechazos
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
      case when h.devueltos >= 1 then h.devueltos
           when h.rechazos >= 1 then h.rechazos
           else h.anulados end as failed,
      case when h.devueltos >= 1 then 'devuelto'
           when h.rechazos >= 1 then 'rechazo'
           else 'anulador' end as reason,
      h.orders
    from h
    where length(h.phone) = 9
      and not exists (select 1 from rcv where rcv.phone = h.phone)
      and (h.devueltos >= 1
           -- (C) 0333: rechazó en la puerta al menos una vez.
           or h.rechazos >= 1
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

create or replace function public.pago_online_build(p_org uuid, p_run uuid, p_requirement text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_rows jsonb;
  v_phones text[];
  v_emails integer;
  v_two integer;
  v_anul integer;
  v_rech integer;
  v_exc integer;
  v_pc jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('p', c.phone, 'f', c.failed, 'r', c.reason, 'o', c.orders, 'e', to_jsonb(c.emails))
                  order by c.phone) filter (where not c.excepted), '[]'::jsonb),
         coalesce(array_agg(c.phone order by c.phone) filter (where not c.excepted), '{}'::text[]),
         coalesce(sum(cardinality(c.emails)) filter (where not c.excepted), 0)::int,
         -- «2 o más»: dos o más devueltos (los anuladores no entran en esta cuenta).
         count(*) filter (where not c.excepted and c.reason = 'devuelto' and c.failed >= 2)::int,
         count(*) filter (where not c.excepted and c.reason = 'anulador')::int,
         count(*) filter (where not c.excepted and c.reason = 'rechazo')::int,
         count(*) filter (where c.excepted)::int
    into v_rows, v_phones, v_emails, v_two, v_anul, v_rech, v_exc
    from public.pago_online_candidates(p_org) c;

  if p_run is not null then
    insert into public.pago_online_phones (run_id, org_id, phone, failed, reason, orders, emails)
    select p_run, p_org, r->>'p', (r->>'f')::int, r->>'r', (r->>'o')::int, array(select jsonb_array_elements_text(r->'e'))
    from jsonb_array_elements(v_rows) r
    on conflict (run_id, phone) do nothing;
  end if;

  v_pc := public.pago_online_por_confirmar(p_org, v_phones, p_requirement);
  return jsonb_build_object(
    'phones', cardinality(v_phones),
    'emails', v_emails,
    'two_or_more', v_two,
    'anuladores', v_anul,
    'rechazos', v_rech,
    'excepted', v_exc,
    'por_confirmar_listed', coalesce((v_pc->>'listed')::int, 0),
    'por_confirmar_braked', coalesce((v_pc->>'braked')::int, 0)
  );
end;
$$;

revoke all on function public.pago_online_build(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.pago_online_build(uuid, uuid, text) to service_role;
