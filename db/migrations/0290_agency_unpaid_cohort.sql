-- Consolidado → Master: unpaid orders in the same Shalom/Olva shipment cohort.
-- Read-only, with the caller's RLS. No order, payment or shipment is changed.
create or replace function public.order_master_agency_unpaid(
  p_store_ids uuid[], p_from date, p_to date
)
returns setof public.order_master
language sql stable security invoker set search_path = public
as $$
  select m.*
    from public.order_master m
    join public.orders o on o.id = m.order_id and o.store_id = m.store_id
   where m.store_id = any(p_store_ids)
     and p_to - p_from between 1 and 32
     and exists (
       select 1 from public.shipments s
        where s.order_id = m.order_id and s.store_id = m.store_id
          and (lower(s.courier) like '%shalom%' or lower(s.courier) like '%olva%')
          and coalesce(s.dispatched_at, s.created_at) >= (p_from::timestamp at time zone 'America/Lima')
          and coalesce(s.dispatched_at, s.created_at) < (p_to::timestamp at time zone 'America/Lima')
     )
     and not (
       (coalesce(lower(trim(o.financial_status)), '') = 'paid'
        and coalesce(o.payment_gateway, '') = 'checkout' and coalesce(o.total_refunded, 0) <= 0)
       or (coalesce(m.order_total, 0) > 0 and coalesce((
         select sum(round(p.amount * 100)) from public.order_payments p
          where p.order_id = m.order_id and p.store_id = m.store_id
            and p.validation_status = 'validado' and p.amount > 0
       ), 0) >= round(m.order_total * 100))
     )
$$;
revoke all on function public.order_master_agency_unpaid(uuid[], date, date) from public, anon;
grant execute on function public.order_master_agency_unpaid(uuid[], date, date) to authenticated, service_role;
notify pgrst, 'reload schema';
