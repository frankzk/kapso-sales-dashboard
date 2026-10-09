-- ============================================================================
-- 0238_auto_order_ab.sql — Prueba A/B: pedido de recompra sin llamada vs. cola.
--
-- POR QUÉ (09-10-2026). La primera prueba (0214, `exp-recompra-1`) generó 30
-- pedidos elegidos a mano y los comparó contra la tasa histórica. Eso no dice
-- si generar el pedido VENDE MÁS que dejar el carrito a la asesora: un pedido
-- por carrito produce más pedidos, pero algunos se anulan; la llamada cierra
-- menos, pero entrega mejor. Para saberlo hace falta un grupo de control real.
--
-- CÓMO. Cada carrito de recompra de Provincia COD que cumple la regla se sortea
-- al llegar (moneda determinista por el gid del carrito):
--   - `auto`    → fila `pendiente`: el generador de 0214 lo convierte en pedido.
--   - `control` → fila `control`: no se toca; la asesora lo trabaja como siempre.
-- La métrica es PEDIDOS ENTREGADOS POR CARRITO en cada mitad
-- (`auto_order_ab_results`), no por pedido.
--
-- QUIÉN ENTRA (`auto_order_ab_candidates`, la regla entera en un solo sitio):
-- lead `nuevo` y sin gestión, carrito abierto de entre `min_cart_age_hours` y
-- `max_cart_age_hours`, último pedido del teléfono ENTREGADO y de 7+ días antes
-- del carrito, cobertura de la cohorte, dirección despachable, total > 0, el
-- cliente no escribió después del carrito, ningún pedido vivo posterior, y un
-- producto DISTINTO al de su última entrega (la causa más repetida de anulación
-- en `exp-recompra-1`: «ya lo tiene»).
--
-- APAGADO. `auto_order_cohorts.enabled` es el interruptor; además cada cohorte
-- tiene ventana (`starts_at`/`ends_at`) y tope diario de inscripciones.
-- ============================================================================

create table if not exists auto_order_cohorts (
  cohort              text primary key,
  enabled             boolean not null default false,
  coverage            text not null default 'provincia_cod',
  starts_at           timestamptz,
  ends_at             timestamptz,
  min_cart_age_hours  integer not null default 3,
  max_cart_age_hours  integer not null default 48,
  max_enroll_per_day  integer not null default 30,     -- por tienda, las dos mitades
  created_at          timestamptz not null default now()
);
alter table auto_order_cohorts enable row level security;
revoke all on auto_order_cohorts from anon, authenticated;
grant all privileges on auto_order_cohorts to service_role;

-- Apagada: se enciende a mano (update … set enabled = true) cuando el código
-- está en producción, con su ventana de dos semanas.
insert into auto_order_cohorts (cohort, enabled, coverage)
values ('ab-recompra-prov-1', false, 'provincia_cod')
on conflict (cohort) do nothing;

alter table auto_order_trials add column if not exists arm text;
alter table auto_order_trials add column if not exists phone9 text;
alter table auto_order_trials add column if not exists cart_created_at timestamptz;
alter table auto_order_trials drop constraint if exists auto_order_trials_arm_chk;
alter table auto_order_trials add constraint auto_order_trials_arm_chk
  check (arm is null or arm in ('auto', 'control'));
alter table auto_order_trials drop constraint if exists auto_order_trials_status_chk;
alter table auto_order_trials add constraint auto_order_trials_status_chk
  check (status in ('pendiente', 'procesando', 'generado', 'omitido', 'error', 'control'));
create index if not exists auto_order_trials_cohort_idx on auto_order_trials(cohort, store_id, created_at);

-- Candidatos de una cohorte para una tienda. Solo del servidor (service_role):
-- lee teléfonos y direcciones de clientes.
create or replace function auto_order_ab_candidates(p_store_id uuid, p_cohort text)
returns table (
  lead_id          uuid,
  draft_order_gid  text,
  draft_name       text,
  cart_created_at  timestamptz,
  phone9           text,
  same_district    boolean
)
language sql
stable
set search_path = public
as $$
  with cfg as (
    select * from auto_order_cohorts where cohort = p_cohort
  ), c as (
    select l.id lead_id, l.store_id, l.draft_order_gid, d.name draft_name, d.created_at cart_at,
           right(regexp_replace(coalesce(d.customer_phone, l.phone), '\D', '', 'g'), 9) p9,
           l.last_inbound_at, d.address1, d.district, d.province, d.region, d.total_amount, d.line_items
      from leads l
      join draft_orders d
        on d.store_id = l.store_id
       and d.shopify_draft_order_id = regexp_replace(l.draft_order_gid, '^.*/', '')
      cross join cfg
     where l.store_id = p_store_id
       and l.category = 'open' and l.status = 'nuevo'
       and d.status in ('open', 'invoice_sent')
       and d.created_at <= now() - make_interval(hours => cfg.min_cart_age_hours)
       and d.created_at >  now() - make_interval(hours => cfg.max_cart_age_hours)
       and coalesce(d.total_amount, 0) > 0
       and length(regexp_replace(coalesce(d.address1, ''), '[^[:alnum:]]', '', 'g')) >= 6
       and length(regexp_replace(coalesce(d.district, ''), '[^[:alpha:]]', '', 'g')) >= 3
       and not coalesce(l.last_inbound_at > d.created_at, false)
       and not exists (select 1 from auto_order_trials t where t.lead_id = l.id)
  ), m as (
    select om.order_id, om.order_created_at, om.general_status, om.district,
           right(regexp_replace(om.customer_phone, '\D', '', 'g'), 9) p9
      from order_master om
     where om.store_id = p_store_id
       and om.order_created_at > now() - interval '240 days'
       and right(regexp_replace(om.customer_phone, '\D', '', 'g'), 9) in (select p9 from c)
  ), ult as (
    select distinct on (c.lead_id) c.lead_id, m.order_id, m.order_created_at, m.general_status, m.district ult_district
      from c join m on m.p9 = c.p9 and m.order_created_at < c.cart_at
     order by c.lead_id, m.order_created_at desc
  )
  select c.lead_id, c.draft_order_gid, c.draft_name, c.cart_at, c.p9,
         lower(btrim(c.district)) = lower(btrim(u.ult_district))
    from c
    join ult u on u.lead_id = c.lead_id
    cross join cfg
   where length(c.p9) = 9
     and u.general_status = 'entregado'
     and c.cart_at - u.order_created_at >= interval '7 days'
     and order_coverage_for(p_store_id, c.region, c.province, c.district) = cfg.coverage
     and not exists (
       select 1 from m
        where m.p9 = c.p9 and m.order_created_at > c.cart_at and m.general_status <> 'anulado'
     )
     and not exists (
       select 1
         from orders o, jsonb_array_elements(o.line_items) b, jsonb_array_elements(c.line_items) a
        where o.id = u.order_id
          and lower(btrim(a->>'title')) = lower(btrim(b->>'title'))
     );
$$;
revoke all on function auto_order_ab_candidates(uuid, text) from public, anon, authenticated;
grant execute on function auto_order_ab_candidates(uuid, text) to service_role;

-- Resultado por carrito de las cohortes A/B. `auto`: el pedido generado.
-- `control`: el primer pedido del mismo teléfono en los 14 días siguientes al
-- carrito (el vivo antes que el anulado), lo haya cerrado quien lo haya cerrado.
create or replace view auto_order_ab_results with (security_invoker = true) as
select t.cohort,
       t.arm,
       t.store_id,
       t.draft_name,
       t.status,
       t.reason,
       t.cart_created_at,
       coalesce(ma.order_name, mc.order_name) order_name,
       coalesce(ma.coverage, mc.coverage) coverage,
       coalesce(ma.general_status, mc.general_status, 'sin_pedido') resultado,
       coalesce(ma.delivered_at, mc.delivered_at) delivered_at
  from auto_order_trials t
  left join orders o
    on t.arm = 'auto' and o.store_id = t.store_id and o.shopify_order_id = t.shopify_order_id
  left join order_master ma on ma.order_id = o.id
  left join lateral (
    select om.order_name, om.coverage, om.general_status, om.delivered_at
      from order_master om
     where t.arm = 'control'
       and om.store_id = t.store_id
       and right(regexp_replace(om.customer_phone, '\D', '', 'g'), 9) = t.phone9
       and om.order_created_at > t.cart_created_at
       and om.order_created_at < t.cart_created_at + interval '14 days'
     order by (om.general_status = 'anulado'), om.order_created_at
     limit 1
  ) mc on true
 where t.arm is not null;

revoke all on auto_order_ab_results from anon, authenticated;
grant select on auto_order_ab_results to authenticated;
grant select on auto_order_ab_results to service_role;
