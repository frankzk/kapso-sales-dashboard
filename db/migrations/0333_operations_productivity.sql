-- Productividad operativa. Read-only reporting, no operational transitions.
-- A snapshot on NEW human contacts prevents later stages reattributing old work.
create index order_payments_registered_productivity_idx on public.order_payments(store_id,registered_at) where registered_by is not null;
create index order_payments_validated_productivity_idx on public.order_payments(store_id,validated_at) where validated_by is not null;
create function public.capture_productivity_context()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare context jsonb;
begin
  if new.actor is not null and new.kind in ('comment','chatby_message','kapso_message','browser_call','anura_call') then
    select jsonb_build_object('stage',m.macro_stage,'substage',m.macro_substage,
      'operation',m.macro_operation,'courier',m.current_courier,'payment_state',m.payment_state) into context
      from order_master m where m.order_id=new.order_id and m.store_id=new.store_id;
    new.payload:=coalesce(new.payload,'{}'::jsonb)||jsonb_build_object('productivity_context',coalesce(context,'{}'::jsonb));
  end if;
  return new;
end $$;
revoke all on function public.capture_productivity_context() from public,anon,authenticated;
create trigger capture_productivity_context before insert on public.order_events
for each row execute function public.capture_productivity_context();

create function public.operations_productivity(p_stores uuid[],p_start timestamptz,p_end timestamptz,
  p_section text default 'resumen',p_actor uuid default null,p_tz text default 'America/Lima')
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare result jsonb;
begin
  if p_start is null or p_end is null or p_end<p_start or p_end-p_start>interval '366 days'
    or p_section is null or p_section not in ('resumen','leads','master','repro_provincia','repro_lima','diferencia','pagos','almacen','despacho')
    or not exists(select 1 from pg_timezone_names where name=p_tz) then raise exception 'Periodo o sección inválidos.'; end if;
  with order_facts as (
    select 'event:'||e.id as id,e.actor,e.store_id,e.order_id,null::uuid as lead_id,e.occurred_at as at,
      case when e.kind in ('package_ready','package_removed','return_received','returned_to_office') then 'almacen'
        when e.kind in ('office_checked','pickup_checked','custody_transferred','dispatch_route_assigned','dispatch_route_reassigned','stop_reported','liquidation_closed') then 'despacho'
        when e.kind in ('key_shared','key_registered') then 'diferencia'
        when e.kind in ('comment','chatby_message','kapso_message','browser_call','anura_call')
          and lower(e.payload->'productivity_context'->>'courier') in ('shalom','olva')
          and (e.payload->'productivity_context'->>'substage' in ('pendiente_pago_diferencia','recogido_sin_pago_completo')
            or (e.payload->'productivity_context'->>'operation'='agencia'
              and e.payload->'productivity_context'->>'substage' in ('en_transito','en_destino')
              and coalesce(e.payload->'productivity_context'->>'payment_state','')<>'pago_completo')) then 'diferencia'
        else 'master' end as area,
      case when e.kind='confirmation_contact' and e.payload->>'result'='confirmado' then 'confirmed' else e.kind end as action,0::numeric as amount,
      e.payload->>'result' as outcome,
      e.kind in ('comment','chatby_message','kapso_message','browser_call','anura_call') and not(coalesce(e.payload,'{}'::jsonb) ? 'productivity_context') as historical
    from order_events e where e.store_id=any(p_stores) and e.occurred_at between p_start and p_end
      and e.actor is not null and (p_actor is null or e.actor=p_actor)
      and lower(coalesce(e.source,'')) not in ('system','automatico','automatic','sync','webhook','chatby_auto','voice_agent')
      and e.kind in ('confirmation_contact','confirmed','comment','chatby_message','kapso_message','browser_call','anura_call',
        'status_override','dispatch_date_set','guide_created','guide_registered','cancelled_woocommerce','legacy_shopify_sale_cancelled',
        'woo_sale_ended_pending_return','customer_name_updated','coverage_changed','key_shared','key_registered',
        'package_ready','package_removed','return_received','returned_to_office','office_checked','pickup_checked',
        'custody_transferred','dispatch_route_assigned','dispatch_route_reassigned','stop_reported','liquidation_closed')
      and not(e.kind='comment' and lower(coalesce(e.comment_type,''))='ubicacion')
      -- The confirmation RPC writes a contact + its technical confirmed event.
      -- Count that single gesture once, preserving its result and actor.
      and not(e.kind='confirmed' and e.operation_id is not null and exists(
        select 1 from order_events contact where contact.store_id=e.store_id and contact.order_id=e.order_id
          and contact.actor=e.actor and contact.operation_id=e.operation_id and contact.kind='confirmation_contact'
          and contact.payload->>'result'='confirmado'))
  ), facts as (
    select * from order_facts
    union all
    select 'shipment:'||c.id,c.agent,c.store_id,s.order_id,null::uuid,c.occurred_at,'repro_provincia',
      case when c.next_followup_at is not null and ((c.kind='reroute' and coalesce(c.new_status,'en_ruta')='en_ruta')
        or (c.kind='call' and c.new_status='en_ruta')) then 'province_rescheduled'
        when c.kind='call' then 'province_call' else 'province_management' end,
      0::numeric,c.new_status,false
    from shipment_calls c join shipments s on s.id=c.shipment_id and s.store_id=c.store_id
    where c.store_id=any(p_stores) and c.occurred_at between p_start and p_end and c.agent is not null
      and (p_actor is null or c.agent=p_actor) and c.kind in ('call','reroute','address_change')
    union all
    select 'lima:'||c.id,c.actor,c.store_id,c.order_id,null::uuid,c.occurred_at,'repro_lima',
      case when c.outcome='confirma' and c.agreed_on is not null then 'lima_scheduled' else 'lima_management' end,
      0::numeric,c.outcome,false from lima_repro_calls c where c.store_id=any(p_stores)
      and c.occurred_at between p_start and p_end and c.actor is not null and (p_actor is null or c.actor=p_actor)
    union all
    select 'payment-register:'||p.id,p.registered_by,p.store_id,p.order_id,null::uuid,p.registered_at,
      case when p.kind='diferencia' then 'diferencia' else 'pagos' end,'payment_registered',greatest(coalesce(p.amount,0),0),p.kind,false
    from order_payments p where p.store_id=any(p_stores) and p.registered_at between p_start and p_end
      and p.registered_by is not null and (p_actor is null or p.registered_by=p_actor)
    union all
    select 'payment-validate:'||p.id,p.validated_by,p.store_id,p.order_id,null::uuid,p.validated_at,
      case when p.kind='diferencia' then 'diferencia' else 'pagos' end,'payment_validated',p.amount,p.kind,false
    from order_payments p where p.store_id=any(p_stores) and p.validated_at between p_start and p_end
      and p.validated_by is not null and (p_actor is null or p.validated_by=p_actor)
      and p.validation_status='validado' and p.amount>0
    union all
    select 'lead:'||c.id,c.vendedora,c.store_id,null::uuid,c.lead_id,c.occurred_at,'leads',
      case when c.kind='call' then 'lead_call' else 'lead_management' end,0::numeric,null::text,false
    from lead_calls c where c.store_id=any(p_stores) and c.occurred_at between p_start and p_end
      and c.vendedora is not null and (p_actor is null or c.vendedora=p_actor) and c.kind not in ('system','voice_agent')
    union all
    select 'sale:'||s.order_id,s.vendedora,s.store_id,s.order_id,s.lead_id,s.occurred_at,'leads','sale_closed',
      greatest(coalesce(o.total_amount,0)-coalesce(o.total_refunded,0),0),null::text,false
    from order_sales s left join orders o on o.id=s.order_id and o.store_id=s.store_id
    where s.store_id=any(p_stores) and s.occurred_at between p_start and p_end and s.vendedora is not null
      and (p_actor is null or s.vendedora=p_actor)
  ), selected as materialized (
    select f.*,coalesce('order:'||f.order_id,'lead:'||f.lead_id,f.id) as ref,
      (f.at at time zone p_tz)::date as local_day,extract(hour from f.at at time zone p_tz)::int as local_hour
    from facts f where p_section='resumen' or f.area=p_section
      or (p_section='pagos' and f.action in ('payment_registered','payment_validated'))
  ), prior as (
    select actor,at,local_day,lag(at) over(partition by actor,local_day order by at,id) as previous_at from selected
  ), hours as (
    select actor,coalesce(sum(case when at-previous_at<=interval '45 minutes' then extract(epoch from at-previous_at)/3600 else 0 end),0) as n
    from prior group by actor
  ), action_counts as (
    select actor,action,count(*) as n,count(distinct order_id) as orders,coalesce(sum(amount),0) as amount from selected group by actor,action
  ), area_counts as (
    select actor,area,count(*) as n,count(distinct order_id) as orders from selected group by actor,area
  ), heat as (
    select actor,local_hour,count(*) as n from selected group by actor,local_hour
  ), recent_ranked as (
    select s.*,row_number() over(partition by actor order by at desc,id desc) as position from selected s
  ), people as (
    select s.actor as "userId",count(*) as actions,count(distinct s.ref) as objects,count(distinct s.order_id) as orders,
      count(distinct s.lead_id) as leads,max(s.at) as "lastAt",max(h.n) as hours,count(*) filter(where s.historical) as "unclassifiedContacts",
      (select jsonb_object_agg(a.action,jsonb_build_object('count',a.n,'orders',a.orders,'amount',a.amount)) from action_counts a where a.actor=s.actor) as counts,
      (select jsonb_object_agg(a.area,jsonb_build_object('count',a.n,'orders',a.orders)) from area_counts a where a.actor=s.actor) as areas,
      (select jsonb_object_agg(t.local_hour::text,t.n) from heat t where t.actor=s.actor) as heat,
      (select jsonb_agg(jsonb_build_object('id',r.id,'at',r.at,'area',r.area,'action',r.action,'orderId',r.order_id,
        'leadId',r.lead_id,'orderName',o.name,'amount',r.amount,'outcome',r.outcome) order by r.at desc,r.id desc)
        from recent_ranked r left join orders o on o.id=r.order_id and o.store_id=r.store_id
        where r.actor=s.actor and r.position<=50) as recent
    from selected s join hours h on h.actor=s.actor group by s.actor
  )
  select jsonb_build_object('people',coalesce((select jsonb_agg(to_jsonb(p) order by p.actions desc,p."userId") from people p),'[]'::jsonb),
    'totals',jsonb_build_object('actions',count(*),'orders',count(distinct order_id),'leads',count(distinct lead_id),
      'people',count(distinct actor),'unclassifiedContacts',count(*) filter(where historical)),
    'asOf',statement_timestamp()) into result from selected;
  return result;
end $$;
revoke all on function public.operations_productivity(uuid[],timestamptz,timestamptz,text,uuid,text) from public,anon,authenticated;
grant execute on function public.operations_productivity(uuid[],timestamptz,timestamptz,text,uuid,text) to service_role;
