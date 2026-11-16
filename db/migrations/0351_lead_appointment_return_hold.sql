-- ============================================================================
-- 0351_lead_appointment_return_hold.sql — la clienta que responde vuelve 10
-- minutos a quien agendó «Volver a llamar» (decisión del owner, 16-11-2026;
-- MOM «Bloques por asesora»).
--
-- POR QUÉ. Caso real (16-11-2026): una asesora agendó «Volver a llamar» para
-- las 10:00 («mañana yapea»). La reserva por cita se soltó a las 12:00 (0322:
-- 2 h de gracia). A las 15:01 la clienta escribió y mandó el Yape; a las 15:03
-- otra asesora lo tomó del reparto, llamó y creó el pedido. Desde la 0322, que
-- la clienta escriba SUELTA la reserva; el owner pide lo contrario: «sí, por
-- 10 minutos nuevamente desde la respuesta del cliente», con un aviso a quien
-- lo agendó.
--
-- LA REGLA. Mientras el lead tenga la cita de esa asesora (`appointment_owner`,
-- la misma de la 0322: la cita sigue en `next_followup_at` y ninguna llamada
-- la consumió), un mensaje ENTRANTE de la clienta posterior a la llamada que la
-- agendó reserva el lead a esa asesora durante 10 minutos contados desde el
-- mensaje (`leads.last_inbound_at`), aunque la cita ya esté vencida. Cada
-- mensaje nuevo vuelve a contar 10 minutos. Pasados, se suelta como en la 0322
-- y el lead sigue el reparto normal. Fuera de esos 10 minutos todo es la 0322.
-- La reserva de 10 minutos de quien ya tenía el lead abierto (`claimed_by`)
-- sigue primero, igual que antes. Qué cuenta como mensaje de la clienta, igual
-- que la 0322: solo `last_inbound_at` (no `handoff_at` ni lo que manda una
-- asesora). La regla pura y su espejo: lib/lead-appointment-hold.ts.
--
-- ALCANCE. Se reescriben dos funciones con su cuerpo vigente letra a letra y
-- solo la condición de la reserva cambia:
--   * `lead_routing_scope` (0322): `appointment_released`.
--   * `lead_manual_take_check` (0332): la misma condición para «Tomar» manual.
-- Rendimiento: sin tablas ni índices nuevos; una comparación más por lead ya
-- leído. No cambia datos. Correrla otra vez no cambia nada.
-- ============================================================================

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
  -- 0312: dos ramas excluyentes en vez de un OR sobre p_lead. La cola entera
  -- (p_lead nulo) entra por leads_store_category_idx y un lead suelto por
  -- leads_pkey; el OR obligaba a recorrer `leads` entera en las dos. Mismas
  -- filas que el filtro de la 0299.
  from scope sc cross join lateral (
    select l.id,l.store_id,l.category,l.status,l.call_attempt_count,l.first_seen_at,l.last_inbound_at,l.draft_order_gid,l.next_followup_at,l.claimed_by,l.claimed_at,l.updated_at,l.needs_attention,l.handoff_at,l.call_queue_ready,l.contact_opt_out_at,l.has_order,l.order_id,l.cart_item_count,l.district,l.first_inbound_text from leads l
     where p_lead is null and sc.enabled and sc.advisor and l.store_id=sc.id and l.category in ('open','hot')
    union all
    select l.id,l.store_id,l.category,l.status,l.call_attempt_count,l.first_seen_at,l.last_inbound_at,l.draft_order_gid,l.next_followup_at,l.claimed_by,l.claimed_at,l.updated_at,l.needs_attention,l.handoff_at,l.call_queue_ready,l.contact_opt_out_at,l.has_order,l.order_id,l.cart_item_count,l.district,l.first_inbound_text from leads l
     where l.id=p_lead and l.store_id=sc.id
  ) l
), drafts as materialized (
  select d.store_id,d.draft_order_gid,max(d.created_at) as created_at from draft_orders d
  join (select distinct store_id,draft_order_gid from base where category in ('open','hot') and restricted and draft_order_gid is not null)b using(store_id,draft_order_gid)
  where d.created_at<=now() group by d.store_id,d.draft_order_gid
), calls as materialized (
  -- 0322: la llamada que agendó la cita vigente con una asesora habilitada se
  -- marca una vez (`appointment`) y da la dueña y CUÁNDO se agendó. Mismas
  -- filas y mismo índice que la 0312; `offset 0` evita que la marca se copie
  -- en los dos agregados.
  select x.lead_id,max(x.occurred_at) as last_call_at,
    (array_agg(x.vendedora order by x.occurred_at desc,x.id desc) filter(where x.appointment))[1] as appointment_owner,
    max(x.occurred_at) filter(where x.appointment) as appointment_booked_at
  from (
    select c.lead_id,c.occurred_at,c.id,c.vendedora,
      (b.next_followup_at is not null and c.next_followup_at=b.next_followup_at
      and exists(select 1 from memberships m join stores st on st.org_id=m.org_id and st.id=c.store_id
        where m.user_id=c.vendedora and (m.role in ('owner','admin') or exists(select 1 from user_store_access sa where sa.user_id=m.user_id and sa.store_id=st.id))
        and (m.role in ('owner','admin','vendedora') or exists(select 1 from membership_roles mr where mr.org_id=m.org_id and mr.user_id=m.user_id and mr.role='asesora')))) as appointment
    from lead_calls c join base b on b.id=c.lead_id and b.store_id=c.store_id
    where b.restricted and b.category in ('open','hot') and c.kind='call' and c.vendedora is not null and c.occurred_at<=now()
    offset 0
  ) x group by x.lead_id
), classified as materialized (
  select b.*,c.appointment_owner,
    -- 0322: la reserva por cita se suelta 2 h después de la hora de la cita, o
    -- cuando la clienta escribió después de que se agendó (lib/lead-appointment-hold.ts).
    -- 0351: salvo durante los 10 minutos que siguen a ese mensaje, en los que el
    -- lead vuelve a ser de quien agendó, aunque la cita ya esté vencida.
    -- `coalesce`: sin mensaje entrante la comparación da nulo, y un nulo en el
    -- `case` de `permitted` saltaría la reserva en vez de mantenerla.
    coalesce(c.appointment_owner is not null
      and not coalesce(b.last_inbound_at<=now() and b.last_inbound_at>c.appointment_booked_at
        and b.last_inbound_at>now()-interval '10 minutes',false)
      and (b.next_followup_at<=now()-interval '2 hours'
      or (b.last_inbound_at<=now() and b.last_inbound_at>c.appointment_booked_at)),false) as appointment_released,
    case
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
    -- 0322: una cita suelta ya no reserva; sigue el reparto normal de abajo.
    when appointment_owner is not null and not appointment_released then appointment_owner=p_actor
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
    -- 0312: solo la cola entera lee ganados/perdidos; un lead suelto no los cuenta.
    'ganados',case when p_lead is null and (select bool_or(enabled and advisor) from scope) then (select count(*) from leads l join scope s on s.id=l.store_id where l.category='won') else 0 end, 'perdidos',case when p_lead is null and (select bool_or(enabled and advisor) from scope) then (select count(*) from leads l join scope s on s.id=l.store_id where l.category='lost') else 0 end,
    'sin_llamar',count(*) filter(where allowed and public.lead_in_call_queue(status,category,call_queue_ready,contact_opt_out_at,has_order,order_id,next_followup_at)))
) from permitted
$$;
revoke all on function public.lead_routing_scope(uuid,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.lead_routing_scope(uuid,uuid[],uuid) to service_role;
comment on function public.lead_routing_scope(uuid,uuid[],uuid) is
  'Alcance del reparto de Leads por bloques (MOM «Bloques por asesora»; 0295, 0299, 0312). Desde la 0322 la reserva por cita se suelta 2 h después de la cita o cuando la clienta vuelve a escribir; desde la 0351 ese mensaje la devuelve 10 minutos a quien agendó.';

create or replace function public.lead_manual_take_check(p_actor uuid,p_lead uuid)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare l leads%rowtype; o uuid; routed boolean; appointment record;
begin
  select * into l from leads where id=p_lead;
  if not found then return jsonb_build_object('ok',false,'reason','store'); end if;
  select s.org_id into o from stores s join memberships m on m.org_id=s.org_id and m.user_id=p_actor
    where s.id=l.store_id
    and (m.role in ('owner','admin','vendedora') or exists(select 1 from membership_roles r where r.org_id=m.org_id and r.user_id=m.user_id and r.role='asesora'))
    and (m.role in ('owner','admin') or exists(select 1 from user_store_access sa where sa.user_id=p_actor and sa.store_id=s.id));
  if o is null then return jsonb_build_object('ok',false,'reason','store'); end if;
  if l.claimed_by is not null and l.claimed_by<>p_actor and l.claimed_at>now()-interval '10 minutes' then
    return jsonb_build_object('ok',false,'reason','claimed','holder',l.claimed_by);
  end if;
  -- Same appointment ownership/release rule as 0322 and 0351. A manual
  -- permission cannot take a different advisor's still-valid appointment.
  select c.vendedora,c.occurred_at into appointment from lead_calls c
    join memberships m on m.user_id=c.vendedora and m.org_id=o
    where c.lead_id=l.id and c.store_id=l.store_id and c.kind='call'
      and l.category in ('open','hot') and l.next_followup_at is not null and c.next_followup_at=l.next_followup_at
      and c.occurred_at<=now()
      and (m.role in ('owner','admin','vendedora') or exists(select 1 from membership_roles r where r.org_id=o and r.user_id=c.vendedora and r.role='asesora'))
      and (m.role in ('owner','admin') or exists(select 1 from user_store_access sa where sa.user_id=c.vendedora and sa.store_id=l.store_id))
    order by c.occurred_at desc,c.id desc limit 1;
  if appointment.vendedora is not null and appointment.vendedora<>p_actor
    and (coalesce(l.last_inbound_at<=now() and l.last_inbound_at>appointment.occurred_at
        and l.last_inbound_at>now()-interval '10 minutes',false)
      or (l.next_followup_at>now()-interval '2 hours'
        and not coalesce(l.last_inbound_at<=now() and l.last_inbound_at>appointment.occurred_at,false))) then
    return jsonb_build_object('ok',false,'reason','appointment','holder',appointment.vendedora);
  end if;
  routed:=coalesce((lead_routing_scope(p_actor,array[l.store_id],l.id)->>'allowed')::boolean,false);
  if not routed and not(l.store_id=any(lead_manual_take_stores(p_actor,array[l.store_id]))) then
    return jsonb_build_object('ok',false,'reason','permission');
  end if;
  if (select count(*) from leads held where held.claimed_by=p_actor and held.claimed_at>now()-interval '10 minutes'
    and held.id<>l.id and held.category not in ('won','lost'))>=2 then
    return jsonb_build_object('ok',false,'reason','capacity');
  end if;
  return jsonb_build_object('ok',true,'manualException',not routed);
end $$;

revoke all on function public.lead_manual_take_check(uuid,uuid) from public,anon,authenticated;
grant execute on function public.lead_manual_take_check(uuid,uuid) to service_role;
