-- Read-only queues matching Master payment_state. No financial or operational writes.
create function public.agency_payment_bucket(p_state text,p_platform text,p_financial text,p_refunded numeric,p_status text,p_substage text)
returns text language sql immutable security invoker set search_path=public as $$
 select case
   when p_state='pago_completo' then 'complete'
   when p_platform='shopify' and lower(trim(p_financial))='paid' and coalesce(p_refunded,0)<=0 then 'historical'
   when p_status in ('anulado','devuelto') or p_substage in ('anulado_cerrado','devuelto_conciliado') then 'excluded'
   when p_state in ('adelanto_cargado','diferencia_cargada','pago_total_cargado','posible_duplicado') then 'validate'
   when p_state is null or p_state in ('sin_pago','adelanto_validado') then 'collect'
   else 'review' end
$$;
revoke all on function public.agency_payment_bucket(text,text,text,numeric,text,text) from public,anon;
grant execute on function public.agency_payment_bucket(text,text,text,numeric,text,text) to authenticated,service_role;

-- NULL dates are allowed only for the separate, global historical-paid filter.
create function public.order_master_agency_payments(p_store_ids uuid[],p_from date,p_to date,p_bucket text)
returns setof public.order_master language sql stable security invoker set search_path=public as $$
 select m.* from public.order_master m
 join public.orders o on o.id=m.order_id and o.store_id=m.store_id
 where m.store_id=any(p_store_ids)
   and p_bucket in ('all','complete','collect','validate','historical','review')
   and ((p_from is null and p_to is null and p_bucket='historical') or (
     p_to-p_from between 1 and 32 and exists(
       select 1 from public.shipments s where s.order_id=m.order_id and s.store_id=m.store_id
         and (lower(s.courier) like '%shalom%' or lower(s.courier) like '%olva%')
         and coalesce(s.dispatched_at,s.created_at)>=(p_from::timestamp at time zone 'America/Lima')
         and coalesce(s.dispatched_at,s.created_at)<(p_to::timestamp at time zone 'America/Lima')
     )))
   and case when p_bucket='all' then
     public.agency_payment_bucket(m.payment_state,o.platform,o.financial_status,o.total_refunded,m.general_status,m.macro_substage) in ('complete','collect','validate','review')
     else public.agency_payment_bucket(m.payment_state,o.platform,o.financial_status,o.total_refunded,m.general_status,m.macro_substage)=p_bucket end
$$;
revoke all on function public.order_master_agency_payments(uuid[],date,date,text) from public,anon;
grant execute on function public.order_master_agency_payments(uuid[],date,date,text) to authenticated,service_role;

-- Old bookmarks/callers now mean actual collection, not every unreconciled record.
create or replace function public.order_master_agency_unpaid(p_store_ids uuid[],p_from date,p_to date)
returns setof public.order_master language sql stable security invoker set search_path=public as $$
 select * from public.order_master_agency_payments(p_store_ids,p_from,p_to,'collect')
$$;
notify pgrst, 'reload schema';
