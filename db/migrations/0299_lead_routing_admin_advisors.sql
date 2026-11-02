-- Sales advisors with the legacy admin role still work only their assigned blocks.
-- Functional Administracion/Supervision and the owner keep oversight access.
-- Does not activate routing, alter assignments, or change membership permissions.
create or replace function public.lead_routing_scope(p_actor uuid,p_stores uuid[],p_lead uuid default null)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
with scope as materialized (
  select s.id,s.org_id,coalesce(cfg.enabled,false) as enabled,coalesce(cfg.fresh_hours,24) as hours,coalesce(cfg.revision,0) as revision,
    (m.role='vendedora' or exists(select 1 from membership_roles r where r.org_id=m.org_id and r.user_id=m.user_id and r.role='asesora'))
    and m.role<>'owner' and not exists(select 1 from membership_roles r where r.org_id=m.org_id and r.user_id=m.user_id and r.role in ('administracion','supervision')) as advisor,
    coalesce(a.blocks,'{}'::text[]) as blocks,coalesce(a.backup,false) as backup
  from stores s join memberships m on m.org_id=s.org_id and m.user_id=p_actor
  left join lead_routing_settings cfg on cfg.org_id=s.org_id
  left join lead_routing_assignments a on a.org_id=s.org_id and a.user_id=p_actor
  where s.id=any(p_stores) and (m.role in ('owner','admin') or exists(select 1 from user_store_access sa where sa.store_id=s.id and sa.user_id=p_actor))
), base as materialized (
  select l.id,l.store_id,l.category,l.status,l.call_attempt_count,l.first_seen_at,l.last_inbound_at,l.draft_order_gid,l.next_followup_at,l.claimed_by,l.claimed_at,l.updated_at,l.needs_attention,l.handoff_at,l.call_queue_ready,l.contact_opt_out_at,l.has_order,l.order_id,sc.hours,sc.revision,sc.enabled and sc.advisor as restricted,sc.blocks,sc.backup,
    (coalesce(l.cart_item_count,0)>0 or nullif(l.draft_order_gid,'') is not null) as cart,
    (nullif(trim(l.district),'') is not null or coalesce(l.first_inbound_text,'') ~* 'https?://[^[:space:]]*/products/[^[:space:]]' or l.status in ('casi_cierra','yape_por_verificar')) as interest
  from leads l join scope sc on sc.id=l.store_id where (p_lead is null or l.id=p_lead) and ((sc.enabled and sc.advisor and l.category in ('open','hot')) or p_lead is not null)
), drafts as materialized (
  select d.store_id,d.draft_order_gid,max(d.created_at) as created_at from draft_orders d
  join (select distinct store_id,draft_order_gid from base where category in ('open','hot') and restricted and draft_order_gid is not null)b using(store_id,draft_order_gid)
  where d.created_at<=now() group by d.store_id,d.draft_order_gid
), calls as materialized (
  select c.lead_id,max(c.occurred_at) as last_call_at,
    (array_agg(c.vendedora order by c.occurred_at desc,c.id desc) filter(where b.next_followup_at is not null and c.next_followup_at=b.next_followup_at
      and exists(select 1 from memberships m join stores st on st.org_id=m.org_id and st.id=c.store_id
        where m.user_id=c.vendedora and (m.role in ('owner','admin') or exists(select 1 from user_store_access sa where sa.user_id=m.user_id and sa.store_id=st.id))
        and (m.role in ('owner','admin','vendedora') or exists(select 1 from membership_roles mr where mr.org_id=m.org_id and mr.user_id=m.user_id and mr.role='asesora')))))[1] as appointment_owner
  from lead_calls c join base b on b.id=c.lead_id and b.store_id=c.store_id
  where b.restricted and b.category in ('open','hot') and c.kind='call' and c.vendedora is not null and c.occurred_at<=now() group by c.lead_id
), classified as materialized (
  select b.*,c.appointment_owner,case
    when status='yape_por_verificar' then 'interes_reciente'
    when greatest(case when b.first_seen_at<=now() then b.first_seen_at end,case when b.last_inbound_at<=now() then b.last_inbound_at end,d.created_at)>=now()-make_interval(hours=>b.hours)
      and (coalesce(call_attempt_count,0)=0 or c.last_call_at is null or greatest(case when b.first_seen_at<=now() then b.first_seen_at end,case when b.last_inbound_at<=now() then b.last_inbound_at end,d.created_at)>c.last_call_at)
      then case when cart then 'carrito_reciente' when interest then 'interes_reciente' else 'nuevo_sin_intencion' end
    when cart or interest then 'pendiente_con_interes' else 'recuperacion' end as block
  from base b left join drafts d using(store_id,draft_order_gid) left join calls c on c.lead_id=b.id
), available as materialized (
  select a.org_id,sa.store_id,a.user_id,a.blocks from lead_routing_assignments a
  join memberships m on m.user_id=a.user_id and m.org_id=a.org_id
  join user_store_access sa on sa.user_id=a.user_id
  join scope s on s.id=sa.store_id and s.org_id=a.org_id
  join user_presence p on p.user_id=a.user_id and p.last_seen_at>=now()-interval '40 seconds'
  where (m.role='vendedora' or exists(select 1 from membership_roles mr where mr.org_id=m.org_id and mr.user_id=m.user_id and mr.role='asesora'))
  and (select count(*) from leads held where held.claimed_by=a.user_id and held.claimed_at>now()-interval '10 minutes' and held.category not in ('won','lost'))<2
), permitted as materialized (
  select c.*,case
    when not restricted or category not in ('open','hot') then true
    when claimed_by=p_actor and claimed_at>now()-interval '10 minutes' then true
    when appointment_owner is not null then appointment_owner=p_actor
    when block=any(blocks) then true
    when backup and block<>'recuperacion' and not exists(select 1 from available av where av.store_id=c.store_id and c.block=any(av.blocks)) then true
    else false end as allowed from classified c
)
select jsonb_build_object(
  'enabled',coalesce((select bool_or(enabled and advisor) from scope),false),
  'blocks',coalesce((select jsonb_agg(distinct b) from scope cross join unnest(blocks)b),'[]'::jsonb),
  'blockedIds',coalesce(jsonb_agg(id) filter(where not allowed),'[]'::jsonb),
  'allowed',case when p_lead is null then exists(select 1 from scope) else coalesce(bool_and(allowed),false) end,
  'signature',concat(max(updated_at),'|',max(revision),'|',md5(coalesce(string_agg(id::text,',' order by id) filter(where not allowed),'')),'|',floor(extract(epoch from now())/60)),
  'counts',jsonb_build_object(
    'por_llamar',count(*) filter(where allowed and category in ('open','hot') and status<>'yape_por_verificar'),
    'handoff',count(*) filter(where allowed and needs_attention and handoff_at>=now()-interval '24 hours'),
    'yape',count(*) filter(where allowed and status='yape_por_verificar'),
    'seguimientos',count(*) filter(where allowed and next_followup_at<=now()),
    'ganados',case when (select bool_or(enabled and advisor) from scope) then (select count(*) from leads l join scope s on s.id=l.store_id where l.category='won') else 0 end, 'perdidos',case when (select bool_or(enabled and advisor) from scope) then (select count(*) from leads l join scope s on s.id=l.store_id where l.category='lost') else 0 end,
    'sin_llamar',count(*) filter(where allowed and public.lead_in_call_queue(status,category,call_queue_ready,contact_opt_out_at,has_order,order_id,next_followup_at)))
) from permitted
$$;
revoke all on function public.lead_routing_scope(uuid,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.lead_routing_scope(uuid,uuid[],uuid) to service_role;
