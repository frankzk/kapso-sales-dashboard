-- Store distribution is an optional preference, independent of block/store authorization.
-- No advisor, block, reservation or lead is reassigned by installation.
alter table public.lead_routing_assignments add column store_weights jsonb
  check(store_weights is null or jsonb_typeof(store_weights)='object');
comment on column public.lead_routing_assignments.store_weights is 'NULL: existing priority. Otherwise target integer percentages by authorized store, sum 100; audited by save_lead_routing.';

create or replace function public.save_lead_routing(p_org uuid,p_actor uuid,p_revision integer,p_enabled boolean,p_hours integer,p_assignments jsonb)
returns integer language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_revision integer; v_before jsonb; v_after jsonb; v_assignment jsonb; v_weights jsonb; v_user uuid;
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
    v_user:=(v_assignment->>'userId')::uuid;
    v_weights:=case when v_assignment ? 'storeWeights' then nullif(v_assignment->'storeWeights','null'::jsonb)
      else (select nullif(a->'store_weights','null'::jsonb) from jsonb_array_elements(v_before->'assignments') a where a->>'user_id'=v_assignment->>'userId') end;
    if v_weights is not null then
      if jsonb_typeof(v_weights)<>'object' then raise exception 'Porcentajes inválidos.'; end if;
      if not exists(select 1 from jsonb_each(v_weights)) or (select count(*) from jsonb_each(v_weights))>100 then raise exception 'Indica las tiendas y sus porcentajes.'; end if;
      if exists(select 1 from jsonb_each(v_weights) e where e.key !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or jsonb_typeof(e.value)<>'number' or e.value::text !~ '^[0-9]{1,3}$') then raise exception 'Los porcentajes deben ser enteros entre 0 y 100.'; end if;
      if exists(select 1 from jsonb_each_text(v_weights) e where e.value::integer>100 or not exists(
        select 1 from stores s join memberships m on m.org_id=s.org_id and m.user_id=v_user
        where s.id=e.key::uuid and s.org_id=p_org and (m.role in ('owner','admin') or exists(select 1 from user_store_access sa where sa.user_id=v_user and sa.store_id=s.id))))
        or (select sum(value::integer) from jsonb_each_text(v_weights))<>100 then raise exception 'Usa tiendas de la asesora y porcentajes que sumen 100 %%.'; end if;
    end if;
    insert into lead_routing_assignments(org_id,user_id,blocks,backup,manual_take,store_weights)
    values(p_org,(v_assignment->>'userId')::uuid,array(select jsonb_array_elements_text(v_assignment->'blocks')),(v_assignment->>'backup')::boolean,coalesce((v_assignment->>'manualTake')::boolean,(select (a->>'manual_take')::boolean from jsonb_array_elements(v_before->'assignments') a where a->>'user_id'=v_assignment->>'userId'),false),v_weights);
  end loop;
  update lead_routing_settings set enabled=p_enabled,fresh_hours=p_hours,revision=revision+1,updated_at=clock_timestamp(),updated_by=p_actor where org_id=p_org;
  perform public.lead_routing_coverage(p_org);
  select jsonb_build_object('settings',to_jsonb(s),'assignments',coalesce((select jsonb_agg(to_jsonb(a) order by a.user_id) from lead_routing_assignments a where a.org_id=p_org),'[]'::jsonb))
    into v_after from lead_routing_settings s where s.org_id=p_org;
  insert into lead_routing_audit(org_id,actor,before_config,after_config) values(p_org,p_actor,v_before,v_after);
  return v_revision+1;
end $$;


-- Server-only: p_actor always comes from verified session, never a browser parameter.
create function public.lead_store_distribution(p_actor uuid,p_stores uuid[]) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_weights jsonb; v_completed jsonb;
begin
  if p_actor is null or p_stores is null or cardinality(p_stores) not between 1 and 100 or exists(
    select 1 from unnest(p_stores) requested(store_id) where not exists(select 1 from stores s join memberships m on m.org_id=s.org_id and m.user_id=p_actor
      where s.id=requested.store_id and (m.role in ('owner','admin') or exists(select 1 from user_store_access sa where sa.user_id=p_actor and sa.store_id=s.id)))) then
    raise exception 'Sin acceso a estas tiendas.';
  end if;
  select jsonb_object_agg(e.key,e.value) into v_weights
  from lead_routing_assignments a join lead_routing_settings cfg on cfg.org_id=a.org_id and cfg.enabled
  cross join lateral jsonb_each(a.store_weights) e
  join stores s on s.id=e.key::uuid and s.org_id=a.org_id
  join memberships m on m.user_id=a.user_id and m.org_id=a.org_id
  where a.user_id=p_actor and (m.role='vendedora' or exists(select 1 from membership_roles mr where mr.org_id=m.org_id and mr.user_id=m.user_id and mr.role='asesora'))
    and exists(select 1 from stores requested where requested.id=any(p_stores) and requested.org_id=a.org_id)
    and (m.role in ('owner','admin') or exists(select 1 from user_store_access sa where sa.user_id=p_actor and sa.store_id=s.id));
  if v_weights is null then return jsonb_build_object('weights',null,'completed','{}'::jsonb); end if;
  select coalesce(jsonb_object_agg(store_id,n),'{}'::jsonb) into v_completed from (
    select s.id as store_id,count(distinct c.lead_id) as n
    from stores s join jsonb_object_keys(v_weights) key on key::uuid=s.id
    join lead_calls c on c.store_id=s.id and c.vendedora=p_actor and c.kind='call'
      and c.occurred_at >= (date_trunc('day',statement_timestamp() at time zone coalesce(nullif(s.timezone,''),'America/Lima')) at time zone coalesce(nullif(s.timezone,''),'America/Lima'))
      and c.occurred_at <= statement_timestamp()
    group by s.id
  ) t;
  return jsonb_build_object('weights',v_weights,'completed',v_completed);
end $$;
revoke all on function public.lead_store_distribution(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.lead_store_distribution(uuid,uuid[]) to service_role;
-- Uses the same actor/day range as productivity; notes/system events never count.
create index if not exists lead_calls_store_mix_day_idx on public.lead_calls(vendedora,store_id,occurred_at) include(lead_id) where kind='call';
