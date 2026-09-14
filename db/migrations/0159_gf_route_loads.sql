-- MOM §29: one daily delivery route, multiple independently checked loads.
-- No shipment, QR, receipt or delivery report is replaced.
alter table dispatch_manifests
  add column if not exists delivery_route_id uuid references delivery_routes(id),
  add column if not exists load_number integer not null default 1 check (load_number > 0);
alter table delivery_stops
  add column if not exists shipment_id uuid references shipments(id),
  add column if not exists dispatch_manifest_id uuid references dispatch_manifests(id);

drop index if exists dispatch_manifest_rider_day_uniq;
create unique index dispatch_manifest_rider_day_uniq
  on dispatch_manifests(org_id, route_date, rider_id, load_number)
  where rider_id is not null and state <> 'cancelled';
create unique index if not exists delivery_stop_shipment_uniq
  on delivery_stops(shipment_id) where shipment_id is not null;

create or replace function public.gf_dispatch_load(p_org_id uuid, p_rider_id uuid, p_day date, p_actor uuid)
returns uuid language plpgsql set search_path = public as $$
declare
  v_rider riders%rowtype;
  v_route delivery_routes%rowtype;
  v_load dispatch_manifests%rowtype;
  v_number integer;
begin
  -- Serialize even the first creation; the route row does not exist yet.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || p_rider_id::text || p_day::text, 0));
  select * into v_rider from riders where id = p_rider_id and org_id = p_org_id and active;
  if not found or lower(trim(coalesce(v_rider.courier, ''))) not in
    ('', 'propio', 'motorizado propio', 'grupo gf courier') then
    raise exception 'Motorizado de Grupo GF no disponible.';
  end if;
  insert into delivery_routes(org_id, rider_id, route_date, status, created_by)
  values (p_org_id, p_rider_id, p_day, 'planificada', p_actor)
  on conflict (org_id, rider_id, route_date) do nothing;
  select * into v_route from delivery_routes
    where org_id = p_org_id and rider_id = p_rider_id and route_date = p_day for update;
  if v_route.status = 'cerrada' then raise exception 'La ruta diaria ya está liquidada.'; end if;
  select * into v_load from dispatch_manifests
    where org_id = p_org_id and rider_id = p_rider_id and route_date = p_day and state <> 'cancelled'
    order by load_number desc limit 1 for update;
  if found then
    if v_load.courier <> 'propio' then raise exception 'La ruta pertenece a otro operador.'; end if;
    update dispatch_manifests set delivery_route_id = v_route.id where id = v_load.id;
    if v_load.state = 'draft' then return v_load.id; end if;
    if v_load.state <> 'in_custody' then
      raise exception 'Termina de verificar y recibir la carga actual antes de agregar otra.';
    end if;
  end if;
  select coalesce(max(load_number), 0) + 1 into v_number from dispatch_manifests
    where org_id = p_org_id and rider_id = p_rider_id and route_date = p_day;
  insert into dispatch_manifests(org_id, courier, kind, route_date, route_label, rider_id,
    driver_name, created_by, delivery_route_id, load_number)
  values (p_org_id, 'propio', 'reparto', p_day, v_rider.full_name, p_rider_id,
    v_rider.full_name, p_actor, v_route.id, v_number) returning * into v_load;
  insert into dispatch_events(org_id, manifest_id, actor, kind, payload)
  values (p_org_id, v_load.id, p_actor, 'manifest_created',
    jsonb_build_object('source', 'grupo_gf_courier', 'delivery_route_id', v_route.id, 'load_number', v_number));
  return v_load.id;
end;
$$;
revoke all on function public.gf_dispatch_load(uuid, uuid, date, uuid) from public, anon, authenticated;
grant execute on function public.gf_dispatch_load(uuid, uuid, date, uuid) to service_role;

-- The existing atomic finalizer still owns custody. This trigger runs IN that
-- transaction: if linking the route fails, custody does not partially change.
create or replace function public.gf_received_load_to_delivery()
returns trigger language plpgsql set search_path = public as $$
declare
  v_route delivery_routes%rowtype;
  v_item record;
  v_existing delivery_stops%rowtype;
  v_seq integer;
begin
  if new.courier <> 'propio' or new.rider_id is null or new.state <> 'in_custody'
    or old.state = 'in_custody' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text || new.rider_id::text || new.route_date::text, 0));
  insert into delivery_routes(org_id, rider_id, route_date, status, created_by)
    values(new.org_id, new.rider_id, new.route_date, 'planificada', new.created_by)
    on conflict (org_id, rider_id, route_date) do nothing;
  select * into v_route from delivery_routes where org_id = new.org_id
    and rider_id = new.rider_id and route_date = new.route_date for update;
  if v_route.status = 'cerrada' then raise exception 'La ruta diaria ya está liquidada.'; end if;
  select coalesce(max(seq), 0) into v_seq from delivery_stops where route_id = v_route.id;
  for v_item in select i.*, s.order_id from dispatch_manifest_items i
    join shipments s on s.id = i.shipment_id where i.manifest_id = new.id and i.removed_at is null
  loop
    if v_item.order_id is null then raise exception 'Un paquete no tiene pedido para reparto.'; end if;
    select * into v_existing from delivery_stops where route_id = v_route.id and order_id = v_item.order_id;
    if found then
      if v_existing.shipment_id is distinct from v_item.shipment_id then
        raise exception 'El pedido ya tiene una parada previa; revisa su identidad antes de recibir.';
      end if;
    else
      v_seq := v_seq + 1;
      insert into delivery_stops(route_id, order_id, store_id, seq, shipment_id, dispatch_manifest_id)
        values(v_route.id, v_item.order_id, v_item.store_id, v_seq, v_item.shipment_id, new.id);
    end if;
  end loop;
  update delivery_routes set status = 'en_curso', started_at = coalesce(started_at, now()) where id = v_route.id;
  new.delivery_route_id := v_route.id;
  return new;
end;
$$;
drop trigger if exists gf_received_load_to_delivery on dispatch_manifests;
create trigger gf_received_load_to_delivery before update of state on dispatch_manifests
  for each row execute function public.gf_received_load_to_delivery();

-- Serialize assignment and scans on the same manifest lock as finalization.
-- Once checks start, the planned membership cannot silently grow.
create or replace function public.gf_guard_load_items()
returns trigger language plpgsql set search_path = public as $$
declare v_manifest dispatch_manifests%rowtype;
begin
  select * into v_manifest from dispatch_manifests where id = new.manifest_id for update;
  if v_manifest.courier = 'propio' then
    if tg_op = 'INSERT' and (v_manifest.state <> 'draft' or exists (
      select 1 from dispatch_manifest_items where manifest_id = new.manifest_id and removed_at is null
      and (office_checked_at is not null or pickup_checked_at is not null)
    )) then
      raise exception 'La carga ya inició el cotejo; no se pueden agregar paquetes.';
    end if;
    if tg_op = 'UPDATE' and v_manifest.state in ('in_custody', 'cancelled') then
      raise exception 'La carga ya está cerrada; sus cotejos son históricos.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists gf_guard_load_items on dispatch_manifest_items;
create trigger gf_guard_load_items before insert or update on dispatch_manifest_items
  for each row execute function public.gf_guard_load_items();

create or replace function public.gf_rider_receive(p_manifest_id uuid, p_code text, p_actor uuid)
returns uuid[] language plpgsql set search_path = public as $$
declare v_manifest dispatch_manifests%rowtype; v_item uuid; v_count integer;
begin
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if not found or v_manifest.courier <> 'propio' or not exists (
    select 1 from riders where id = v_manifest.rider_id and user_id = p_actor and active
  ) then raise exception 'La carga no pertenece a tu cuenta.'; end if;
  if v_manifest.state not in ('ready_for_pickup', 'pickup_check') then
    raise exception 'La oficina debe completar primero la verificación de la caja.';
  end if;
  if exists(select 1 from dispatch_manifest_items where manifest_id = p_manifest_id
    and removed_at is null and office_checked_at is null) then
    raise exception 'La caja todavía tiene paquetes sin verificar.';
  end if;
  select count(*), (array_agg(i.id))[1] into v_count, v_item
    from dispatch_manifest_items i join shipments s on s.id = i.shipment_id
    where i.manifest_id = p_manifest_id and i.removed_at is null and (
      s.qr_token::text = p_code or lower(s.output_code) = lower(p_code)
      or lower(s.guide_code) = lower(p_code)
      or lower(ltrim(s.order_name, '#')) = lower(ltrim(p_code, '#')));
  if v_count <> 1 then raise exception 'Escanea el QR de un paquete de esta carga.'; end if;
  if exists(select 1 from dispatch_manifest_items where id = v_item and pickup_checked_at is null) then
    update dispatch_manifest_items set pickup_checked_at = now(), pickup_checked_by = p_actor where id = v_item;
    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind)
      select v_manifest.org_id, p_manifest_id, shipment_id, p_actor, 'pickup_checked'
      from dispatch_manifest_items where id = v_item;
  end if;
  update dispatch_manifests set state = 'pickup_check' where id = p_manifest_id;
  if not exists(select 1 from dispatch_manifest_items where manifest_id = p_manifest_id
    and removed_at is null and pickup_checked_at is null) then
    return public.finalize_dispatch_manifest(p_manifest_id, p_actor);
  end if;
  return '{}'::uuid[];
end;
$$;
revoke all on function public.gf_rider_receive(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.gf_rider_receive(uuid, text, uuid) to service_role;
