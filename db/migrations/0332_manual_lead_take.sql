-- Explicit, per-person manual takes. Installation grants nobody this permission.
alter table public.lead_routing_assignments add column manual_take boolean not null default false;

create table public.lead_manual_takes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  store_id uuid not null references public.stores(id),
  lead_id uuid not null references public.leads(id),
  actor uuid not null references auth.users(id),
  origin text not null check(origin in ('busqueda','venta_telefonica')),
  occurred_at timestamptz not null default clock_timestamp()
);
create index lead_manual_takes_actor_time_idx on public.lead_manual_takes(actor,occurred_at desc);
alter table public.lead_manual_takes enable row level security;
revoke all on public.lead_manual_takes from public,anon,authenticated,service_role;
grant select,insert on public.lead_manual_takes to service_role;

create function public.lead_manual_take_stores(p_actor uuid,p_stores uuid[])
returns uuid[] language sql stable security invoker set search_path=public,pg_temp as $$
  select coalesce(array_agg(s.id),'{}'::uuid[]) from stores s
  join memberships m on m.org_id=s.org_id and m.user_id=p_actor
  join lead_routing_assignments a on a.org_id=s.org_id and a.user_id=p_actor and a.manual_take
  where s.id=any(p_stores)
    and (m.role in ('owner','admin','vendedora') or exists(select 1 from membership_roles r where r.org_id=m.org_id and r.user_id=m.user_id and r.role='asesora'))
    and (m.role in ('owner','admin') or exists(select 1 from user_store_access sa where sa.user_id=p_actor and sa.store_id=s.id))
$$;

create function public.lead_manual_take_check(p_actor uuid,p_lead uuid)
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
  -- Same appointment ownership/release rule as 0322. A manual permission
  -- cannot take a different advisor's still-valid appointment.
  select c.vendedora,c.occurred_at into appointment from lead_calls c
    join memberships m on m.user_id=c.vendedora and m.org_id=o
    where c.lead_id=l.id and c.store_id=l.store_id and c.kind='call'
      and l.category in ('open','hot') and l.next_followup_at is not null and c.next_followup_at=l.next_followup_at
      and c.occurred_at<=now()
      and (m.role in ('owner','admin','vendedora') or exists(select 1 from membership_roles r where r.org_id=o and r.user_id=c.vendedora and r.role='asesora'))
      and (m.role in ('owner','admin') or exists(select 1 from user_store_access sa where sa.user_id=c.vendedora and sa.store_id=l.store_id))
    order by c.occurred_at desc,c.id desc limit 1;
  if appointment.vendedora is not null and appointment.vendedora<>p_actor
    and l.next_followup_at>now()-interval '2 hours'
    and not coalesce(l.last_inbound_at<=now() and l.last_inbound_at>appointment.occurred_at,false) then
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

create function public.claim_manual_lead(p_actor uuid,p_lead uuid,p_origin text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare l leads%rowtype; o uuid; result jsonb;
begin
  if p_origin is null or p_origin not in ('busqueda','venta_telefonica') then raise exception 'Origen inválido.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('lead-claim:'||p_actor::text,0));
  select s.org_id into o from stores s join leads target on target.store_id=s.id where target.id=p_lead;
  perform 1 from lead_routing_settings where org_id=o for share;
  perform 1 from lead_routing_assignments where org_id=o and user_id=p_actor for share;
  select * into l from leads where id=p_lead for update;
  result:=lead_manual_take_check(p_actor,p_lead);
  if not coalesce((result->>'ok')::boolean,false) then return result; end if;
  update leads set claimed_by=p_actor,claimed_at=clock_timestamp() where id=p_lead;
  if (result->>'manualException')::boolean then
    insert into lead_manual_takes(org_id,store_id,lead_id,actor,origin) values(o,l.store_id,l.id,p_actor,p_origin);
    insert into lead_calls(lead_id,store_id,vendedora,kind,note)
      values(l.id,l.store_id,p_actor,'system','Toma puntual fuera de bloques · '||case when p_origin='busqueda' then 'Búsqueda' else 'Venta por teléfono' end);
  end if;
  return result||jsonb_build_object('id',p_lead);
end $$;

revoke all on function public.lead_manual_take_stores(uuid,uuid[]),public.lead_manual_take_check(uuid,uuid),public.claim_manual_lead(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.lead_manual_take_stores(uuid,uuid[]),public.lead_manual_take_check(uuid,uuid),public.claim_manual_lead(uuid,uuid,text) to service_role;

create or replace function public.save_lead_routing(p_org uuid,p_actor uuid,p_revision integer,p_enabled boolean,p_hours integer,p_assignments jsonb)
returns integer language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_revision integer; v_before jsonb; v_after jsonb; v_assignment jsonb;
begin
  if not exists(select 1 from memberships m where m.org_id=p_org and m.user_id=p_actor and
    (m.role in ('owner','admin') or exists(select 1 from membership_roles mr where mr.org_id=p_org and mr.user_id=p_actor and mr.role='administracion')
     or exists(select 1 from user_permissions up where up.org_id=p_org and up.user_id=p_actor and up.permission='team.manage' and up.granted))) then
    raise exception 'Sin permiso para configurar el equipo.';
  end if;
  if p_hours is null or p_hours not between 1 and 168 or p_enabled is null or jsonb_typeof(p_assignments) is distinct from 'array' or jsonb_array_length(p_assignments)>200 then
    raise exception 'Configuración inválida.'; end if;
  perform 1 from organizations where id=p_org for update;
  insert into lead_routing_settings(org_id) values(p_org) on conflict do nothing;
  select revision into v_revision from lead_routing_settings where org_id=p_org for update;
  if v_revision<>p_revision then raise exception 'La configuración cambió. Recarga Equipo antes de guardar.'; end if;
  select jsonb_build_object('settings',to_jsonb(s),'assignments',coalesce((select jsonb_agg(to_jsonb(a) order by a.user_id) from lead_routing_assignments a where a.org_id=p_org),'[]'::jsonb))
    into v_before from lead_routing_settings s where s.org_id=p_org;
  if (select count(*) from jsonb_array_elements(p_assignments))<>(select count(distinct a->>'userId') from jsonb_array_elements(p_assignments)a) then raise exception 'Persona repetida.'; end if;
  delete from lead_routing_assignments where org_id=p_org;
  for v_assignment in select * from jsonb_array_elements(p_assignments) loop
    if not exists(select 1 from memberships m where m.org_id=p_org and m.user_id=(v_assignment->>'userId')::uuid and (m.role='vendedora' or exists(select 1 from membership_roles mr where mr.org_id=m.org_id and mr.user_id=m.user_id and mr.role='asesora')))
      or jsonb_typeof(v_assignment->'blocks') is distinct from 'array' or jsonb_typeof(v_assignment->'backup') is distinct from 'boolean' or (v_assignment ? 'manualTake' and jsonb_typeof(v_assignment->'manualTake') is distinct from 'boolean') then raise exception 'Asesora o bloques inválidos.'; end if;
    insert into lead_routing_assignments(org_id,user_id,blocks,backup,manual_take)
    values(p_org,(v_assignment->>'userId')::uuid,array(select jsonb_array_elements_text(v_assignment->'blocks')),(v_assignment->>'backup')::boolean,coalesce((v_assignment->>'manualTake')::boolean,(select (a->>'manual_take')::boolean from jsonb_array_elements(v_before->'assignments') a where a->>'user_id'=v_assignment->>'userId'),false));
  end loop;
  update lead_routing_settings set enabled=p_enabled,fresh_hours=p_hours,revision=revision+1,updated_at=clock_timestamp(),updated_by=p_actor where org_id=p_org;
  perform public.lead_routing_coverage(p_org);
  select jsonb_build_object('settings',to_jsonb(s),'assignments',coalesce((select jsonb_agg(to_jsonb(a) order by a.user_id) from lead_routing_assignments a where a.org_id=p_org),'[]'::jsonb))
    into v_after from lead_routing_settings s where s.org_id=p_org;
  insert into lead_routing_audit(org_id,actor,before_config,after_config) values(p_org,p_actor,v_before,v_after);
  return v_revision+1;
end $$;

