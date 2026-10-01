-- MOM §11.9.1. An independent sub-cap inside the existing global daily cap.
alter table swayp_auto_settings add column if not exists pilot_enabled boolean not null default false;
alter table swayp_auto_settings add column if not exists pilot_daily_cap integer not null default 3 check(pilot_daily_cap between 1 and 3);
create or replace function swayp_auto_snapshot(p_source uuid) returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object(
    'order',jsonb_build_object('id',o.id,'store_id',o.store_id,'name',o.name,'created_at',o.created_at,
      'updated_at',o.updated_at,'customer_phone',o.customer_phone,'cancelled_at',o.cancelled_at,
      'financial_status',o.financial_status,'total_amount',o.total_amount,'total_refunded',o.total_refunded,
      'currency',o.currency,'line_items',o.line_items,'shopify_note',o.shopify_note,
      'raw',jsonb_build_object('shipping_address',o.raw->'shipping_address')),
    'payments',coalesce((select jsonb_agg(jsonb_build_object('validation_status',p.validation_status) order by p.id) from order_payments p where p.order_id=o.id),'[]'),
    'source',to_jsonb(s),
    'guides',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'courier',g.courier,'delivery_status',g.delivery_status,'reported_status',g.reported_status,'fenix_shipment_id',g.fenix_shipment_id) order by g.id) from shipments g where g.order_id=o.id),'[]'),
    'notes',coalesce((select jsonb_agg(jsonb_build_object('kind',e.kind,'reason',e.reason,'note',e.note,'new_status',e.new_status) order by e.id) from order_events e where e.order_id=o.id),'[]'),
    'calls',coalesce((select jsonb_agg(jsonb_build_object('note',c.note,'new_status',c.new_status) order by c.id) from shipment_calls c join shipments g on g.id=c.shipment_id where g.order_id=o.id),'[]'),
    'voice',coalesce((select jsonb_agg(jsonb_build_object('status',v.status,'outcome',v.outcome,'payload',v.outcome_payload) order by v.id) from voice_calls v where v.order_id=o.id and v.mode='real'),'[]'),
    'history',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'created_at',h.created_at,'cancelled_at',h.cancelled_at,'line_items',h.line_items,
       'delivered_at',m.delivered_at,'address',m.address,'district',m.district,'province',m.province,'region',m.region) order by h.id)
      from orders h join stores ht on ht.id=h.store_id left join order_master m on m.order_id=h.id
      where ht.org_id=t.org_id and h.id<>o.id
        and regexp_replace(h.customer_phone,'[^0-9]','','g') ~ '^(0051|51)?9[0-9]{8}$'
        and right(regexp_replace(h.customer_phone,'[^0-9]','','g'),9)=right(regexp_replace(o.customer_phone,'[^0-9]','','g'),9)
        and h.created_at>=now()-interval '365 days'),'[]'))
  from shipments s join orders o on o.id=s.order_id join stores t on t.id=o.store_id where s.id=p_source;
$$;
create or replace function swayp_emission_claim(p_store uuid,p_order uuid,p_key text,p_city text,p_products jsonb,
  p_auto boolean default false,p_evidence jsonb default '{}',p_stock jsonb default null,p_read_at timestamptz default null)
returns jsonb language plpgsql set search_path=public as $$
declare v_org uuid; v_id uuid; c swayp_auto_settings; v_source shipments; r record; v_reserved numeric; v_available numeric;
begin
  select org_id into v_org from stores where id=p_store and status='active';
  if v_org is null or not exists(select 1 from orders where id=p_order and store_id=p_store) then
    return jsonb_build_object('error','Pedido o tienda inválidos'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_org::text,209));
  if exists(select 1 from swayp_guide_emissions where source_key=p_key
    or (order_id=p_order and (state<>'created' or child_id is null))) then
    return jsonb_build_object('error','Emisión previa o incierta: revisar antes de emitir otra guía'); end if;
  if exists(select 1 from shipments where order_id=p_order and id::text<>p_key
    and delivery_status not in ('anulado','devuelto','transferido')) then
    return jsonb_build_object('error','El pedido tiene otra guía activa o entregada'); end if;
  if p_auto then
    select * into c from swayp_auto_settings where org_id=v_org;
    if c.org_id is null or not c.enabled then return jsonb_build_object('error','Automático desactivado'); end if;
    if exists(select 1 from swayp_guide_emissions where order_id=p_order and automatic) then
      return jsonb_build_object('error','El pedido ya tuvo su intento automático'); end if;
    if (select count(*) from swayp_guide_emissions where org_id=v_org and automatic
      and created_at>=(date_trunc('day',now() at time zone 'America/Lima') at time zone 'America/Lima'))>=c.daily_cap then
      return jsonb_build_object('error','Tope diario alcanzado'); end if;
    select * into v_source from shipments where id=p_key::uuid and order_id=p_order for update;
    if v_source.id is null or v_source.delivery_status<>'anulado' or v_source.fenix_shipment_id is not null
      or v_source.claimed_by is not null then return jsonb_build_object('error','La guía cambió o está tomada'); end if;
    if p_evidence->>'fingerprint' is distinct from md5(swayp_auto_snapshot(v_source.id)::text) then
      return jsonb_build_object('error','Los datos cambiaron; se reevaluará'); end if;
    if p_evidence->>'cohort'='recent_no_history' then
      if not c.pilot_enabled then return jsonb_build_object('error','Piloto desactivado'); end if;
      if (select count(*) from swayp_guide_emissions where org_id=v_org and automatic
        and evidence->>'cohort'='recent_no_history'
        and created_at>=(date_trunc('day',now() at time zone 'America/Lima') at time zone 'America/Lima'))>=c.pilot_daily_cap then
        return jsonb_build_object('error','Piloto: cupo diario alcanzado'); end if;
      if v_source.aliclik_attempts is distinct from 1
        or not exists(select 1 from orders where id=p_order and created_at between now()-interval '7 days' and now() and total_amount>0 and total_amount<=199)
        or exists(select 1 from order_payments where order_id=p_order and validation_status<>'rechazado')
        or p_evidence#>>'{location,ok}' is distinct from 'true' then
        return jsonb_build_object('error','El pedido no cumple el piloto sin historial'); end if;
    end if;
    if p_read_at is null or p_read_at<now()-interval '2 minutes' or p_stock is null then
      return jsonb_build_object('error','Se requiere inventario Swayp recién leído'); end if;
    for r in select value->>'codbar' codbar,sum((value->>'cantidad')::numeric) qty from jsonb_array_elements(p_products) group by 1 loop
      select coalesce(sum((x->>'disponible')::numeric),0) into v_available from jsonb_array_elements(p_stock) x where x->>'codbar'=r.codbar;
      select coalesce(sum((x->>'cantidad')::numeric),0) into v_reserved
        from swayp_guide_emissions e cross join lateral jsonb_array_elements(e.products) x
        where e.org_id=v_org and e.city=p_city and x->>'codbar'=r.codbar
          and (e.created_at>=p_read_at or e.state<>'created' or e.child_id is null);
      if v_available-v_reserved<r.qty then return jsonb_build_object('error','Stock insuficiente después de reservas'); end if;
    end loop;
    if jsonb_array_length(p_products)=0 then return jsonb_build_object('error','Sin productos vinculados'); end if;
  end if;
  insert into swayp_guide_emissions(source_key,order_id,store_id,org_id,automatic,city,products,evidence)
    values(p_key,p_order,p_store,v_org,p_auto,p_city,p_products,p_evidence) returning id into v_id;
  return jsonb_build_object('id',v_id);
end;
$$;

-- Caller RLS applies to both ledgers and child shipments. No privileged view.
create or replace view swayp_auto_metrics with (security_invoker=true) as
with rows as (
  select e.org_id,coalesce(e.evidence->>'cohort','prior_delivery') cohort,e.guide_code,e.state,
    s.delivery_status,
    coalesce(s.quoted_delivery_cost,(e.evidence->>'quotedDeliveryCost')::numeric) delivery_cost,
    s.quoted_return_cost return_cost
  from swayp_guide_emissions e left join shipments s on s.id=e.child_id where e.automatic
)
select org_id,cohort,count(*)::int attempts,
  count(*) filter(where guide_code is not null)::int issued,
  count(*) filter(where delivery_status='entregado')::int delivered,
  count(*) filter(where delivery_status='devuelto')::int returned,
  count(*) filter(where delivery_status='anulado')::int cancelled,
  count(*) filter(where state='review' or guide_code is null)::int review,
  count(*) filter(where guide_code is not null and delivery_status not in ('entregado','devuelto','anulado'))::int pending,
  count(*) filter(where guide_code is not null and (delivery_cost is null or (delivery_status='devuelto' and return_cost is null)))::int missing_cost,
  sum(delivery_cost + case when delivery_status='devuelto' then coalesce(return_cost,0) else 0 end) filter(where guide_code is not null) quoted_cost
from rows group by org_id,cohort;
grant select on swayp_auto_metrics to authenticated,service_role;
