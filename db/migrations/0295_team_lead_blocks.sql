-- Optional until the team saves and enables it. Installation never redistributes leads.
create table public.lead_routing_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  fresh_hours integer not null default 24 check(fresh_hours between 1 and 168),
  revision integer not null default 0,
  updated_at timestamptz not null default now(), updated_by uuid references auth.users(id)
);
create table public.lead_routing_assignments (
  org_id uuid not null references public.lead_routing_settings(org_id) on delete cascade,
  user_id uuid not null,
  blocks text[] not null default '{}', backup boolean not null default false,
  primary key(org_id,user_id),
  foreign key(user_id,org_id) references public.memberships(user_id,org_id) on delete cascade,
  check(array_position(blocks,null) is null and blocks <@ array['carrito_reciente','interes_reciente','nuevo_sin_intencion','pendiente_con_interes','recuperacion']::text[])
);
create table public.lead_routing_audit (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id), actor uuid not null references auth.users(id),
  occurred_at timestamptz not null default now(), before_config jsonb not null, after_config jsonb not null
);
alter table public.lead_routing_settings enable row level security;
alter table public.lead_routing_assignments enable row level security;
alter table public.lead_routing_audit enable row level security;
revoke all on public.lead_routing_settings,public.lead_routing_assignments,public.lead_routing_audit from anon,authenticated;
grant all on public.lead_routing_settings,public.lead_routing_assignments,public.lead_routing_audit to service_role;
grant usage,select on sequence public.lead_routing_audit_id_seq to service_role;

create function public.lead_routing_coverage(p_org uuid) returns void
language plpgsql security invoker set search_path=public as $$
declare missing text;
begin
  perform 1 from lead_routing_settings where org_id=p_org and enabled for update;
  if not found then return; end if;
  select s.name || ': ' || b into missing from stores s cross join unnest(array[
    'carrito_reciente','interes_reciente','nuevo_sin_intencion','pendiente_con_interes','recuperacion']) b
  where s.org_id=p_org and not exists (
    select 1 from lead_routing_assignments a join memberships m on m.org_id=a.org_id and m.user_id=a.user_id
    join user_store_access sa on sa.user_id=a.user_id and sa.store_id=s.id
    where a.org_id=p_org and b=any(a.blocks) and (m.role='vendedora' or exists(
      select 1 from membership_roles mr where mr.org_id=m.org_id and mr.user_id=m.user_id and mr.role='asesora'))
  ) order by s.id,b limit 1;
  if missing is not null then raise exception 'Quedaría un bloque sin asesora asignada (%). Ajusta Leads en Equipo primero.',missing; end if;
end $$;

create function public.lead_routing_guard_coverage() returns trigger
language plpgsql security invoker set search_path=public as $$
declare o uuid;
begin
  for o in select org_id from lead_routing_settings where enabled order by org_id loop
    perform public.lead_routing_coverage(o);
  end loop;
  return null;
end $$;
-- Deferred: a batch can move people/blocks, provided the final configuration covers every store.
create constraint trigger lead_routing_members after insert or update or delete on public.memberships
  deferrable initially deferred for each row execute function public.lead_routing_guard_coverage();
create constraint trigger lead_routing_access after insert or update or delete on public.user_store_access
  deferrable initially deferred for each row execute function public.lead_routing_guard_coverage();
create constraint trigger lead_routing_roles after insert or update or delete on public.membership_roles
  deferrable initially deferred for each row execute function public.lead_routing_guard_coverage();
create constraint trigger lead_routing_stores after insert or update on public.stores
  deferrable initially deferred for each row execute function public.lead_routing_guard_coverage();

create function public.save_lead_routing(p_org uuid,p_actor uuid,p_revision integer,p_enabled boolean,p_hours integer,p_assignments jsonb)
returns integer language plpgsql security invoker set search_path=public as $$
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
      or jsonb_typeof(v_assignment->'blocks') is distinct from 'array' or jsonb_typeof(v_assignment->'backup') is distinct from 'boolean' then raise exception 'Asesora o bloques inválidos.'; end if;
    insert into lead_routing_assignments(org_id,user_id,blocks,backup)
    values(p_org,(v_assignment->>'userId')::uuid,array(select jsonb_array_elements_text(v_assignment->'blocks')),(v_assignment->>'backup')::boolean);
  end loop;
  update lead_routing_settings set enabled=p_enabled,fresh_hours=p_hours,revision=revision+1,updated_at=clock_timestamp(),updated_by=p_actor where org_id=p_org;
  perform public.lead_routing_coverage(p_org);
  select jsonb_build_object('settings',to_jsonb(s),'assignments',coalesce((select jsonb_agg(to_jsonb(a) order by a.user_id) from lead_routing_assignments a where a.org_id=p_org),'[]'::jsonb))
    into v_after from lead_routing_settings s where s.org_id=p_org;
  insert into lead_routing_audit(org_id,actor,before_config,after_config) values(p_org,p_actor,v_before,v_after);
  return v_revision+1;
end $$;

-- Batched narrow reads: no correlated scan per lead, no PostgREST 1,000-row truncation.
-- p_actor always comes from the verified server session, never browser input.
create function public.lead_routing_scope(p_actor uuid,p_stores uuid[],p_lead uuid default null)
returns jsonb language sql stable security invoker set search_path=public as $$
with scope as materialized (
  select s.id,s.org_id,coalesce(cfg.enabled,false) as enabled,coalesce(cfg.fresh_hours,24) as hours,coalesce(cfg.revision,0) as revision,
    (m.role='vendedora' or exists(select 1 from membership_roles r where r.org_id=m.org_id and r.user_id=m.user_id and r.role='asesora'))
    and m.role not in ('owner','admin') and not exists(select 1 from membership_roles r where r.org_id=m.org_id and r.user_id=m.user_id and r.role in ('administracion','supervision')) as advisor,
    coalesce(a.blocks,'{}'::text[]) as blocks,coalesce(a.backup,false) as backup
  from stores s join memberships m on m.org_id=s.org_id and m.user_id=p_actor
  left join lead_routing_settings cfg on cfg.org_id=s.org_id
  left join lead_routing_assignments a on a.org_id=s.org_id and a.user_id=p_actor
  where s.id=any(p_stores) and (m.role in ('owner','admin','viewer') or exists(select 1 from user_store_access sa where sa.store_id=s.id and sa.user_id=p_actor))
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
    (array_agg(c.vendedora order by c.occurred_at desc,c.id desc) filter(where b.next_followup_at is not null and c.next_followup_at=b.next_followup_at))[1] as appointment_owner
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
revoke all on function public.lead_routing_coverage(uuid),public.lead_routing_guard_coverage(),public.save_lead_routing(uuid,uuid,integer,boolean,integer,jsonb),public.lead_routing_scope(uuid,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.lead_routing_coverage(uuid),public.lead_routing_guard_coverage(),public.save_lead_routing(uuid,uuid,integer,boolean,integer,jsonb),public.lead_routing_scope(uuid,uuid[],uuid) to service_role;

-- Recheck under locks at the actual claim, including the per-person limit.
create function public.claim_routed_lead(p_actor uuid,p_lead uuid) returns table(id uuid)
language plpgsql security invoker set search_path=public as $$
declare v_lead leads%rowtype; v_org uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('lead-claim:'||p_actor::text,0));
  select s.org_id into v_org from leads l join stores s on s.id=l.store_id where l.id=p_lead;
  perform 1 from lead_routing_settings where org_id=v_org for share;
  select * into v_lead from leads l where l.id=p_lead for update;
  if not found then return; end if;
  if not coalesce((lead_routing_scope(p_actor,array[v_lead.store_id],p_lead)->>'allowed')::boolean,false) then raise exception 'Este lead no pertenece a tus bloques.'; end if;
  if (select count(*) from leads l where l.claimed_by=p_actor and l.claimed_at>now()-interval '10 minutes' and l.id<>p_lead and l.category not in ('won','lost'))>=2 then raise exception 'Ya tienes dos leads abiertos.'; end if;
  return query update leads l set claimed_by=p_actor,claimed_at=clock_timestamp()
    where l.id=p_lead and (l.claimed_by is null or l.claimed_by=p_actor or l.claimed_at<now()-interval '10 minutes') returning l.id;
end $$;
revoke all on function public.claim_routed_lead(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_routed_lead(uuid,uuid) to service_role;
