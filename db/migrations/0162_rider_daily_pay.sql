-- MOM 29.9: personal rider earnings, never the courier's selling price.
-- No historical updates and no name-based Roy seed. Configure the exact rider ID.
create table rider_pay_rates (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references riders(id),
  district_key text references peru_districts(district_key),
  amount numeric(12,2) not null check (amount >= 0 and amount < 100000),
  effective_from date not null,
  reason text not null check (length(trim(reason)) >= 3),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp()
);
create index rider_pay_rates_lookup on rider_pay_rates(rider_id, effective_from desc, created_at desc);

create table rider_pay_adjustments (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references delivery_routes(id),
  stop_id uuid not null references delivery_stops(id),
  amount numeric(12,2) not null check (amount <> 0 and abs(amount) < 100000),
  reason text not null check (length(trim(reason)) >= 3),
  reverses_id uuid unique references rider_pay_adjustments(id),
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default clock_timestamp(),
  check ((reverses_id is null and amount > 0) or (reverses_id is not null and amount < 0))
);
create index rider_pay_adjustments_route on rider_pay_adjustments(route_id);

create table rider_daily_pay_closures (
  route_id uuid primary key references delivery_routes(id),
  snapshot jsonb not null,
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default clock_timestamp()
);

-- All writes through service-only RPCs with exact-organization permissions.
alter table rider_pay_rates enable row level security;
alter table rider_pay_adjustments enable row level security;
alter table rider_daily_pay_closures enable row level security;
revoke all on rider_pay_rates, rider_pay_adjustments, rider_daily_pay_closures from anon, authenticated;
grant select, insert on rider_pay_rates, rider_pay_adjustments, rider_daily_pay_closures to service_role;

create function rider_pay_immutable() returns trigger language plpgsql as $$
begin raise exception 'El historial de ganancia es inmutable; registra una nueva versión o contrapartida.'; end $$;
create trigger rider_pay_rates_immutable before update or delete on rider_pay_rates for each row execute function rider_pay_immutable();
create trigger rider_pay_adjustments_immutable before update or delete on rider_pay_adjustments for each row execute function rider_pay_immutable();
create trigger rider_daily_pay_immutable before update or delete on rider_daily_pay_closures for each row execute function rider_pay_immutable();

create function rider_pay_allowed(p_org uuid, p_actor uuid, p_permission text)
returns boolean language sql stable set search_path = public as $$
  select coalesce((select coalesce(
    (select granted from user_permissions where org_id = p_org and user_id = p_actor and permission = p_permission),
    m.role in ('owner', 'admin') or (m.role = 'vendedora' and p_permission = 'routes.manage'))
    from memberships m where m.org_id = p_org and m.user_id = p_actor), false);
$$;
revoke all on function rider_pay_allowed(uuid,uuid,text) from public, anon, authenticated;
grant execute on function rider_pay_allowed(uuid,uuid,text) to service_role;

create function rider_pay_save_rate(p_rider uuid, p_district text, p_amount numeric, p_from date, p_reason text, p_actor uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_id uuid;
begin
  select org_id into v_org from riders where id = p_rider for update;
  if not rider_pay_allowed(v_org, p_actor, 'costs.manage') then raise exception 'Sin permiso para configurar tarifas personales.'; end if;
  if p_amount is null or p_amount::text = 'NaN' or p_amount <> round(p_amount,2) then raise exception 'Importe inválido.'; end if;
  insert into rider_pay_rates(rider_id,district_key,amount,effective_from,reason,created_by)
    values(p_rider,nullif(p_district,''),p_amount,p_from,trim(p_reason),p_actor) returning id into v_id;
  return v_id;
end $$;

create function rider_pay_add_adjustment(p_route uuid, p_stop uuid, p_amount numeric, p_reason text, p_actor uuid, p_request uuid, p_reverse uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_route delivery_routes; v_original rider_pay_adjustments; v_id uuid;
begin
  select * into v_route from delivery_routes where id = p_route for update;
  if not rider_pay_allowed(v_route.org_id,p_actor,'settlements.close') then raise exception 'Sin permiso para aprobar adicionales.'; end if;
  if exists(select 1 from rider_pay_adjustments where id=p_request and route_id=p_route and stop_id=p_stop and approved_by=p_actor and reason=trim(p_reason)) then return p_request; end if;
  if exists(select 1 from rider_daily_pay_closures where route_id=p_route) then raise exception 'La liquidación diaria ya está aprobada.'; end if;
  if not exists(select 1 from delivery_stops where id=p_stop and route_id=p_route) then raise exception 'Punto ajeno a la ruta.'; end if;
  if p_reverse is not null then
    select * into v_original from rider_pay_adjustments where id=p_reverse and route_id=p_route and stop_id=p_stop and reverses_id is null;
    if not found then raise exception 'Adicional no encontrado.'; end if;
    p_amount := -v_original.amount;
  end if;
  if p_amount is null or p_amount::text = 'NaN' or p_amount <> round(p_amount,2) then raise exception 'Importe inválido.'; end if;
  insert into rider_pay_adjustments(id,route_id,stop_id,amount,reason,reverses_id,approved_by)
    values(p_request,p_route,p_stop,p_amount,trim(p_reason),p_reverse,p_actor) returning id into v_id;
  return v_id;
end $$;

-- One authoritative calculation for both the on-screen draft and approval.
create function rider_pay_preview(p_route uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_route delivery_routes; v_rows jsonb; v_adjustments jsonb; v_cash numeric; v_direct numeric;
  v_base numeric; v_extra numeric; v_missing int; v_pending int; v_evidence int; v_conflicts int;
begin
  select * into v_route from delivery_routes where id=p_route;
  if not (rider_pay_allowed(v_route.org_id,p_actor,'routes.manage') or rider_pay_allowed(v_route.org_id,p_actor,'settlements.close')) then
    raise exception 'Sin acceso al cálculo de esta ruta.';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.seq,x.stop_id),'[]'::jsonb) into v_rows from (
    select s.id stop_id,s.order_id,s.store_id,s.seq,s.status,s.outcome_reason,s.payment_method,
      s.collected_amount,s.reported_at,s.photo_path,s.voucher_path,
      om.order_name,om.district,
      t.id rate_id,t.effective_from,t.amount configured_rate,
      case when s.status='entregado' or (s.status='no_entregado' and s.outcome_reason='rechazado') then t.amount else 0 end base,
      coalesce((select sum(a.amount) from rider_pay_adjustments a where a.stop_id=s.id and a.route_id=p_route),0) extra
    from delivery_stops s
    left join order_master om on om.order_id=s.order_id
    left join lateral (
      select r.* from rider_pay_rates r where r.rider_id=v_route.rider_id and r.effective_from<=v_route.route_date
      and (r.district_key is null or r.district_key=case when resolve_lima_district(om.district,true)='lurigancho chosica' then 'lurigancho' else resolve_lima_district(om.district,true) end)
      order by (r.district_key is not null) desc,r.effective_from desc,r.created_at desc,r.id desc limit 1
    ) t on true
    where s.route_id=p_route
  ) x;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'stop_id',a.stop_id,'amount',a.amount,'reason',a.reason,
    'approved_by',a.approved_by,'approved_at',a.approved_at,'approved_label',coalesce(u.email,a.approved_by::text),
    'reverses_id',a.reverses_id) order by a.approved_at,a.id),'[]'::jsonb)
    into v_adjustments from rider_pay_adjustments a left join auth.users u on u.id=a.approved_by where a.route_id=p_route;
  select coalesce(sum(case when x->>'status'='entregado' and x->>'payment_method'='efectivo' then (x->>'collected_amount')::numeric else 0 end),0),
    coalesce(sum(case when x->>'status'='entregado' and x->>'payment_method' in ('yape','pos') then (x->>'collected_amount')::numeric else 0 end),0),
    coalesce(sum((x->>'base')::numeric),0),coalesce(sum((x->>'extra')::numeric),0),
    count(*) filter(where x->>'base' is null),count(*) filter(where x->>'status'='pendiente'),
    count(*) filter(where ((x->>'status'='entregado' or x->>'outcome_reason'='rechazado') and coalesce(x->>'photo_path','')='')
      or (x->>'status'='entregado' and x->>'payment_method'='yape' and coalesce(x->>'voucher_path','')='')),
    count(*) filter(where (x->>'status'='entregado' and coalesce(x->>'payment_method','') not in ('efectivo','yape','pos','sin_cobro'))
      or (x->>'status'='entregado' and x->>'payment_method'='sin_cobro' and coalesce((x->>'collected_amount')::numeric,0)<>0)
      or (x->>'status'='entregado' and x->>'payment_method' in ('efectivo','yape','pos') and coalesce((x->>'collected_amount')::numeric,0)<=0)
      or (x->>'status'='no_entregado' and coalesce((x->>'collected_amount')::numeric,0)<>0))
    into v_cash,v_direct,v_base,v_extra,v_missing,v_pending,v_evidence,v_conflicts from jsonb_array_elements(v_rows) x;
  return jsonb_build_object('route_id',p_route,'rider_id',v_route.rider_id,'day',v_route.route_date,'route_status',v_route.status,
    'rider_name',(select full_name from riders where id=v_route.rider_id),'rows',v_rows,'adjustments',v_adjustments,
    'cash',v_cash,'direct',v_direct,'base',v_base,'extra',v_extra,'earned',v_base+v_extra,
    'net_cash',case when v_missing=0 then v_cash-v_base-v_extra else null end,
    'missing',v_missing,'pending',v_pending,'evidence_missing',v_evidence,'conflicts',v_conflicts);
end $$;

create function rider_pay_approve(p_route uuid, p_expected jsonb, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_route delivery_routes; v_snapshot jsonb; v_existing jsonb;
begin
  select * into v_route from delivery_routes where id=p_route for update;
  if not rider_pay_allowed(v_route.org_id,p_actor,'settlements.close') then raise exception 'Sin permiso para aprobar la liquidación.'; end if;
  select snapshot into v_existing from rider_daily_pay_closures where route_id=p_route;
  if found then return v_existing; end if;
  -- Same lock as tariff creation, so a new version cannot enter halfway through approval.
  perform 1 from riders where id=v_route.rider_id for update;
  perform 1 from delivery_stops where route_id=p_route for update;
  if v_route.status <> 'cerrada' then raise exception 'Primero termina la ruta operativa.'; end if;
  v_snapshot := rider_pay_preview(p_route,p_actor);
  if p_expected is distinct from v_snapshot then raise exception 'El cálculo cambió. Actualiza y revisa el desglose antes de aprobar.'; end if;
  if jsonb_array_length(v_snapshot->'rows')=0 or (v_snapshot->>'missing')::int>0 or (v_snapshot->>'pending')::int>0
    or (v_snapshot->>'evidence_missing')::int>0 or (v_snapshot->>'conflicts')::int>0 then
    raise exception 'Revisa tarifas, reportes y evidencia antes de aprobar.';
  end if;
  if exists(select 1 from rider_settlements where route_id=p_route and status='cerrada') then
    raise exception 'Ya existe un cierre financiero anterior por tienda. Requiere conciliación, no otro pago.';
  end if;
  insert into rider_daily_pay_closures(route_id,snapshot,approved_by) values(p_route,v_snapshot,p_actor);
  return v_snapshot;
end $$;

-- Once frozen no parallel/stale report can change the facts used in the closure.
create function rider_pay_protect_report() returns trigger language plpgsql security definer set search_path=public as $$
begin
  -- Check both routes: moving a stop away must not bypass an approved snapshot.
  perform 1 from delivery_routes where id in (new.route_id,old.route_id) order by id for update;
  if exists(select 1 from rider_daily_pay_closures where route_id in (new.route_id,old.route_id)) then
    raise exception 'Ruta liquidada: conserva el historial y solicita una corrección financiera.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger rider_pay_protect_report before insert or update or delete on delivery_stops for each row execute function rider_pay_protect_report();

revoke all on function rider_pay_save_rate(uuid,text,numeric,date,text,uuid) from public,anon,authenticated;
revoke all on function rider_pay_add_adjustment(uuid,uuid,numeric,text,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function rider_pay_preview(uuid,uuid) from public,anon,authenticated;
revoke all on function rider_pay_approve(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function rider_pay_save_rate(uuid,text,numeric,date,text,uuid) to service_role;
grant execute on function rider_pay_add_adjustment(uuid,uuid,numeric,text,uuid,uuid,uuid) to service_role;
grant execute on function rider_pay_preview(uuid,uuid) to service_role;
grant execute on function rider_pay_approve(uuid,jsonb,uuid) to service_role;
