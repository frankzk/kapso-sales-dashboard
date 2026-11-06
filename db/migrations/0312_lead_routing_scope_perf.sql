-- ============================================================================
-- 0312_lead_routing_scope_perf.sql — `lead_routing_scope` y «lo esperado» de
-- devoluciones, sin recorrer tablas enteras. SOLO RENDIMIENTO: ninguna regla
-- de negocio cambia (MOM §16 y §30 intactos) y ningún resultado cambia.
--
-- POR QUÉ. El 06-11-2026 ~20:00 UTC la base se quedó sin CPU («Unhealthy»):
-- en la pestaña de cada asesora los clics no respondían. `lead_routing_scope`
-- suma 47.000 s de base desde el reinicio del 05-11 (103.000 llamadas, 458 ms
-- de media; la cola entera de una asesora, ~1 s y 119.000 bloques). Y
-- `return_manifest_expected` tarda 2,6 s por motorizado (5.110 llamadas).
--
-- QUÉ HACE.
--   1. `lead_routing_scope`: el CTE `base` filtraba con
--      `(p_lead is null or l.id = p_lead) and (… or p_lead is not null)`. Una
--      función SQL se planifica con parámetros genéricos y ese OR no se puede
--      simplificar: recorría las ~80.000 filas de `leads` en CADA llamada,
--      también en la de un solo lead. Ahora son dos ramas excluyentes (UNION
--      ALL): la cola por `leads_store_category_idx`, el lead suelto por
--      `leads_pkey`. Medido en producción con plan genérico (Samantha, dos
--      tiendas): 1.076 ms / 119.512 bloques → 418 ms / 89.101 bloques, y
--      resultado idéntico (mismo JSON; `blockedIds`, que nadie lee en orden,
--      con los mismos elementos). Lo demás de la función, los permisos, el
--      `security invoker` y el `search_path` son los de la 0299, letra a letra.
--   2. `lead_calls_call_lead_idx`: el CTE `calls` hacía 11.160 búsquedas en
--      `lead_calls_lead_idx` con lectura de la fila (65.700 bloques, ~74 % de
--      lo que queda). Índice parcial con lo que la función lee: las llamadas
--      con asesora, que son 33.000 de 178.000 filas.
--   3. `draft_orders_store_gid_idx`: el CTE `drafts` recorría `draft_orders`
--      entera (29.000 filas, 7.000 bloques) aunque se pidiera un solo lead.
--   4. `delivery_stops_shipment_manifest_idx`: `return_manifest_expected`
--      busca la última parada de cada paquete en SU caja
--      (`shipment_id`, `dispatch_manifest_id`, `reported_at desc nulls last`)
--      y no había índice: 1.074 recorridos de `delivery_stops` por motorizado
--      (2.025 ms, 277.000 bloques). Con el índice son ~1.000 búsquedas.
--   5. ANALYZE de `delivery_stops` y `draft_orders`: el planificador creía que
--      `delivery_stops` tenía 238 filas (tiene ~7.900).
--
-- NO CAMBIA el cuerpo de `return_manifest_expected` ni de ninguna otra función.
--
-- EN PRODUCCIÓN, LOS ÍNDICES PRIMERO Y `concurrently` (DEPLOY.md): un
-- `create index` normal bloquea las escrituras de la tabla mientras se
-- construye. Aquí van con `if not exists` para CI y bases nuevas; corrido
-- después de los `concurrently`, este fichero solo los encuentra hechos.
--
-- EL CÓDIGO NO LA NECESITA PARA FUNCIONAR: sin ella todo devuelve lo mismo,
-- solo más lento. Puede aplicarse antes o después del despliegue.
-- ============================================================================

-- Aun con el índice ya creado, `if not exists` toma por un instante un bloqueo
-- sobre la tabla: si tuviera que esperar a otra transacción, que falle en
-- limpio en vez de encolar escrituras.
set lock_timeout = '5s';

create index if not exists lead_calls_call_lead_idx
  on public.lead_calls (lead_id, occurred_at desc, id desc)
  include (store_id, vendedora, next_followup_at)
  where kind = 'call' and vendedora is not null;

create index if not exists draft_orders_store_gid_idx
  on public.draft_orders (store_id, draft_order_gid)
  include (created_at);

create index if not exists delivery_stops_shipment_manifest_idx
  on public.delivery_stops (shipment_id, dispatch_manifest_id, reported_at desc nulls last)
  include (id, status, outcome_reason);

reset lock_timeout;

comment on index public.lead_calls_call_lead_idx is
  'Última llamada y cita de cada lead para lead_routing_scope (bloques de Leads, MOM §16; 0312).';
comment on index public.draft_orders_store_gid_idx is
  'Fecha del carrito de un lead para lead_routing_scope (0312).';
comment on index public.delivery_stops_shipment_manifest_idx is
  'Última parada de un paquete en su caja: return_manifest_expected y return_manifest_note (MOM §30; 0312).';

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

analyze public.delivery_stops;
analyze public.draft_orders;
