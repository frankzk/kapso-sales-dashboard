-- MOM §11.9. Disabled until explicitly enabled for an organization.
create table if not exists swayp_auto_settings (
  org_id uuid primary key references organizations(id),
  enabled boolean not null default false,
  daily_cap integer not null default 10 check (daily_cap between 1 and 50),
  max_order_days integer not null default 14 check (max_order_days between 1 and 30),
  history_days integer not null default 180 check (history_days between 1 and 365),
  updated_at timestamptz not null default now()
);
create table if not exists swayp_auto_decisions (
  shipment_id uuid primary key references shipments(id),
  order_id uuid not null references orders(id),
  store_id uuid not null references stores(id),
  org_id uuid not null references organizations(id),
  reason text not null,
  evidence jsonb not null default '{}',
  checked_at timestamptz not null default now()
);
create table if not exists swayp_guide_emissions (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  order_id uuid not null references orders(id),
  store_id uuid not null references stores(id),
  org_id uuid not null references organizations(id),
  automatic boolean not null default false,
  state text not null default 'sending' check (state in ('sending','created','review')),
  city text not null,
  products jsonb not null default '[]',
  evidence jsonb not null default '{}',
  guide_code text,
  swayp_state integer,
  child_id uuid references shipments(id) on delete set null,
  error text,
  created_at timestamptz not null default now()
);
create unique index if not exists swayp_auto_once_per_order on swayp_guide_emissions(order_id) where automatic;
create index if not exists swayp_emissions_org_created on swayp_guide_emissions(org_id,created_at);
create index if not exists swayp_auto_decisions_checked on swayp_auto_decisions(org_id,checked_at);
create table if not exists swayp_auto_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  summary jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists swayp_auto_runs_org_created on swayp_auto_runs(org_id,created_at desc);
alter table swayp_auto_settings enable row level security;
alter table swayp_auto_decisions enable row level security;
alter table swayp_guide_emissions enable row level security;
alter table swayp_auto_runs enable row level security;
drop policy if exists swayp_auto_settings_read on swayp_auto_settings;
create policy swayp_auto_settings_read on swayp_auto_settings for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists swayp_auto_decisions_read on swayp_auto_decisions;
create policy swayp_auto_decisions_read on swayp_auto_decisions for select to authenticated using (store_id in (select auth_store_ids()));
drop policy if exists swayp_emissions_read on swayp_guide_emissions;
create policy swayp_emissions_read on swayp_guide_emissions for select to authenticated using (store_id in (select auth_store_ids()));
drop policy if exists swayp_auto_runs_read on swayp_auto_runs;
create policy swayp_auto_runs_read on swayp_auto_runs for select to authenticated using (org_id in (select auth_org_ids()));
grant select on swayp_auto_settings,swayp_auto_decisions,swayp_guide_emissions,swayp_auto_runs to authenticated;
grant all on swayp_auto_settings,swayp_auto_decisions,swayp_guide_emissions,swayp_auto_runs to service_role;

-- A bounded queue, rotating oldest checks first so exclusions cannot starve new arrivals.
create or replace function swayp_auto_candidates(p_org uuid) returns table(id uuid) language sql stable set search_path=public as $$
  select s.id from shipments s join orders o on o.id=s.order_id
  join stores t on t.id=s.store_id join swayp_auto_settings c on c.org_id=t.org_id
  left join swayp_auto_decisions d on d.shipment_id=s.id
  where t.org_id=p_org and t.status='active' and s.courier='aliclik'
    and s.delivery_status='anulado' and s.fenix_shipment_id is null
    and split_part(s.reported_status,' · ',1) in ('CANCEL','NOT_RESPOND')
    and o.created_at >= now()-make_interval(days=>c.max_order_days)
    and not exists(select 1 from swayp_guide_emissions e where e.order_id=o.id and e.automatic)
  order by d.checked_at nulls first, o.created_at desc, s.id limit 50;
$$;

-- One consistent snapshot, no REST row limits and no cross-organization history.
create or replace function swayp_auto_snapshot(p_source uuid) returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object(
    'order',jsonb_build_object('id',o.id,'store_id',o.store_id,'name',o.name,'created_at',o.created_at,
      'updated_at',o.updated_at,'customer_phone',o.customer_phone,'cancelled_at',o.cancelled_at,
      'financial_status',o.financial_status,'total_amount',o.total_amount,'total_refunded',o.total_refunded,
      'currency',o.currency,'line_items',o.line_items,'shopify_note',o.shopify_note,
      'raw',jsonb_build_object('shipping_address',o.raw->'shipping_address')),
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
create or replace function swayp_auto_inspect(p_source uuid) returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object('snapshot',s,'fingerprint',md5(s::text)) from (select swayp_auto_snapshot(p_source) s) q;
$$;

-- Shared by automatic, voice and manual API issuance. No timeout unlock: Swayp
-- has no idempotency key. An unanswered POST must be reconciled, never repeated.
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
revoke all on function swayp_auto_candidates(uuid),swayp_auto_snapshot(uuid),swayp_auto_inspect(uuid),swayp_emission_claim(uuid,uuid,text,text,jsonb,boolean,jsonb,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function swayp_auto_candidates(uuid),swayp_auto_snapshot(uuid),swayp_auto_inspect(uuid),swayp_emission_claim(uuid,uuid,text,text,jsonb,boolean,jsonb,jsonb,timestamptz) to service_role;

create or replace function swayp_link_emission() returns trigger language plpgsql security definer set search_path=public as $$
begin
  update swayp_guide_emissions set child_id=new.id
    where store_id=new.store_id and order_id=new.order_id and guide_code=new.swayp_guide and child_id is null;
  return new;
end;
$$;
revoke all on function swayp_link_emission() from public,anon,authenticated;
drop trigger if exists swayp_link_emission on shipments;
create trigger swayp_link_emission after insert on shipments for each row
  when (new.courier='fenix' and new.swayp_guide is not null) execute function swayp_link_emission();

create or replace function swayp_auto_voice_interlock() returns trigger language plpgsql security definer set search_path=public as $$
declare v_org uuid;
begin
  select org_id into v_org from stores where id=new.store_id;
  perform pg_advisory_xact_lock(hashtextextended(v_org::text,209));
  if exists(select 1 from swayp_guide_emissions where order_id=new.order_id and automatic) then
    raise exception 'Pedido con reintento automático sin llamada';
  end if;
  return new;
end;
$$;
revoke all on function swayp_auto_voice_interlock() from public,anon,authenticated;
drop trigger if exists swayp_auto_voice_interlock on voice_calls;
create trigger swayp_auto_voice_interlock before insert on voice_calls for each row
  when (new.mode='real') execute function swayp_auto_voice_interlock();
