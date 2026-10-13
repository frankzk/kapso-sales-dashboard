-- ============================================================================
-- 0252_ltv_cohorts.sql — LTV : CPA por mes de primera compra (MOM §17,
-- 13-10-2026).
--
-- QUÉ ES. La métrica que el dueño eligió para saber si el negocio se sostiene:
-- lo que vende cada clienta nueva en sus primeros días, por cada sol que costó
-- traerla. Dos funciones que agregan en Postgres —para no bajar decenas de
-- miles de filas en cada carga de Consolidado— y dejan el cálculo del ratio en
-- lib/ltv.ts:
--
--   - `ltv_cohorts`: por tienda y mes de la PRIMERA entrega de cada clienta,
--     cuántas clientas nuevas hubo, lo que compraron (ingreso bruto de pedidos
--     entregados) dentro de 30, 60, 90, 180 y 365 días desde esa primera
--     compra, y cuántas volvieron a comprar en 90 días.
--   - `meta_spend_by_month`: el gasto de Meta por tienda, mes y moneda. La
--     conversión de dólares a soles la hace el código (lib/ltv.ts): la cuenta
--     de Meta puede estar en USD aunque la tienda venda en soles.
--
-- La clienta es su teléfono: los últimos nueve dígitos (MOM §8.1, en un COD de
-- Shopify no hay cuenta ni documento). El mes es el de Lima. Solo cuentan los
-- pedidos entregados: en contraentrega, lo que no se entrega no se cobra.
--
-- SECURITY INVOKER a propósito: las políticas de `order_master` y de
-- `meta_ad_insights_daily` siguen mandando, así que cada persona ve solo sus
-- tiendas.
-- ============================================================================

create or replace function public.ltv_cohorts(p_store_ids uuid[], p_since date)
returns table (
  store_id uuid,
  cohort_month date,
  new_customers integer,
  last_first_at timestamptz,
  value_30 numeric,
  value_60 numeric,
  value_90 numeric,
  value_180 numeric,
  value_365 numeric,
  repeat_90 integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with entregas as (
    select om.store_id,
           right(regexp_replace(om.customer_phone, '\D', '', 'g'), 9) as tel,
           om.order_created_at as t,
           coalesce(om.order_total, 0) as total
      from public.order_master om
     where om.store_id = any(p_store_ids)
       and om.general_status = 'entregado'
       and om.order_created_at >= p_since
       and length(regexp_replace(coalesce(om.customer_phone, ''), '\D', '', 'g')) >= 9
  ), primeras as (
    select e.store_id, e.tel, min(e.t) as primera
      from entregas e
     group by e.store_id, e.tel
  ), por_clienta as (
    select p.store_id, p.primera,
           sum(e.total) filter (where e.t < p.primera + interval '30 days')  as v30,
           sum(e.total) filter (where e.t < p.primera + interval '60 days')  as v60,
           sum(e.total) filter (where e.t < p.primera + interval '90 days')  as v90,
           sum(e.total) filter (where e.t < p.primera + interval '180 days') as v180,
           sum(e.total) filter (where e.t < p.primera + interval '365 days') as v365,
           count(*) filter (where e.t < p.primera + interval '90 days')       as n90
      from primeras p
      join entregas e on e.store_id = p.store_id and e.tel = p.tel
     group by p.store_id, p.tel, p.primera
  )
  select c.store_id,
         date_trunc('month', c.primera at time zone 'America/Lima')::date as cohort_month,
         count(*)::integer as new_customers,
         max(c.primera) as last_first_at,
         coalesce(sum(c.v30), 0)  as value_30,
         coalesce(sum(c.v60), 0)  as value_60,
         coalesce(sum(c.v90), 0)  as value_90,
         coalesce(sum(c.v180), 0) as value_180,
         coalesce(sum(c.v365), 0) as value_365,
         (count(*) filter (where c.n90 >= 2))::integer as repeat_90
    from por_clienta c
   group by c.store_id, date_trunc('month', c.primera at time zone 'America/Lima')
   order by c.store_id, cohort_month;
$$;

revoke all on function public.ltv_cohorts(uuid[], date) from public, anon;
grant execute on function public.ltv_cohorts(uuid[], date) to authenticated, service_role;

create or replace function public.meta_spend_by_month(p_store_ids uuid[], p_since date)
returns table (
  store_id uuid,
  month date,
  currency text,
  spend numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select i.store_id,
         date_trunc('month', i.date)::date as month,
         upper(coalesce(nullif(i.currency, ''), '?')) as currency,
         coalesce(sum(i.spend), 0) as spend
    from public.meta_ad_insights_daily i
   where i.store_id = any(p_store_ids)
     and i.date >= p_since
   group by i.store_id, date_trunc('month', i.date), upper(coalesce(nullif(i.currency, ''), '?'))
   order by i.store_id, month;
$$;

revoke all on function public.meta_spend_by_month(uuid[], date) from public, anon;
grant execute on function public.meta_spend_by_month(uuid[], date) to authenticated, service_role;
