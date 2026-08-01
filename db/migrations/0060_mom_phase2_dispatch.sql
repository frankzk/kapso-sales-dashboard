-- ============================================================================
-- 0060_mom_phase2_dispatch.sql — Mesa de despacho y transferencia de custodia.
--
-- Una ruta es un manifiesto de un courier en una fecha. La oficina coteja el
-- 100 % de los paquetes y el motorizado vuelve a cotejar el 100 %. Crear o
-- enviar la ruta jamás prueba custodia: esta cambia únicamente en la función
-- atómica finalize_dispatch_manifest().
-- ============================================================================

create table if not exists dispatch_manifests (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id) on delete cascade,
  courier               text not null,
  route_date            date not null default current_date,
  route_label           text not null,
  driver_name           text,
  state                 text not null default 'draft'
    check (state in (
      'draft', 'office_check', 'ready_for_pickup',
      'pickup_check', 'in_custody', 'cancelled'
    )),
  created_by            uuid references auth.users(id) on delete set null,
  office_completed_at   timestamptz,
  office_completed_by   uuid references auth.users(id) on delete set null,
  custody_completed_at  timestamptz,
  custody_completed_by  uuid references auth.users(id) on delete set null,
  cancelled_at          timestamptz,
  cancelled_by          uuid references auth.users(id) on delete set null,
  cancellation_reason   text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (length(trim(courier)) > 0),
  check (length(trim(route_label)) > 0)
);

create index if not exists dispatch_manifests_active_idx
  on dispatch_manifests(org_id, route_date desc, state)
  where state not in ('in_custody', 'cancelled');
create index if not exists dispatch_manifests_history_idx
  on dispatch_manifests(org_id, route_date desc, created_at desc);
create unique index if not exists dispatch_manifest_route_uniq
  on dispatch_manifests(org_id, route_date, lower(trim(courier)), lower(trim(route_label)))
  where state <> 'cancelled';

drop trigger if exists dispatch_manifests_touch on dispatch_manifests;
create trigger dispatch_manifests_touch before update on dispatch_manifests
  for each row execute function public.touch_updated_at();

create table if not exists dispatch_manifest_items (
  id                 uuid primary key default gen_random_uuid(),
  manifest_id        uuid not null references dispatch_manifests(id) on delete cascade,
  shipment_id        uuid not null references shipments(id) on delete restrict,
  store_id           uuid not null references stores(id) on delete cascade,
  added_by           uuid references auth.users(id) on delete set null,
  added_at           timestamptz not null default now(),
  office_checked_by  uuid references auth.users(id) on delete set null,
  office_checked_at  timestamptz,
  pickup_checked_by  uuid references auth.users(id) on delete set null,
  pickup_checked_at  timestamptz,
  removed_by         uuid references auth.users(id) on delete set null,
  removed_at         timestamptz,
  removal_reason     text,
  created_at         timestamptz not null default now(),
  unique (manifest_id, shipment_id),
  check (
    (removed_at is null and removal_reason is null)
    or (removed_at is not null and length(trim(coalesce(removal_reason, ''))) > 0)
  )
);

-- Una salida física no puede estar activa en dos rutas a la vez. Si se retira
-- expresamente, puede incorporarse a una ruta posterior conservando el rastro.
create unique index if not exists dispatch_item_active_shipment_uniq
  on dispatch_manifest_items(shipment_id) where removed_at is null;
create index if not exists dispatch_items_manifest_idx
  on dispatch_manifest_items(manifest_id, removed_at, added_at);
create index if not exists dispatch_items_store_idx
  on dispatch_manifest_items(store_id, added_at desc);

-- Auditoría propia de la ruta. Es append-only igual que order_events.
create table if not exists dispatch_events (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  manifest_id  uuid references dispatch_manifests(id) on delete set null,
  shipment_id  uuid references shipments(id) on delete set null,
  actor        uuid references auth.users(id) on delete set null,
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now()
);

create index if not exists dispatch_events_manifest_idx
  on dispatch_events(manifest_id, occurred_at desc);
create index if not exists dispatch_events_org_idx
  on dispatch_events(org_id, occurred_at desc);

alter table dispatch_manifests enable row level security;
alter table dispatch_manifest_items enable row level security;
alter table dispatch_events enable row level security;

drop policy if exists dispatch_manifests_select on dispatch_manifests;
create policy dispatch_manifests_select on dispatch_manifests for select to authenticated
  using (org_id in (select auth_org_ids()));

drop policy if exists dispatch_manifest_items_select on dispatch_manifest_items;
create policy dispatch_manifest_items_select on dispatch_manifest_items for select to authenticated
  using (store_id in (select auth_store_ids()));

drop policy if exists dispatch_events_select on dispatch_events;
create policy dispatch_events_select on dispatch_events for select to authenticated
  using (org_id in (select auth_org_ids()));

revoke all on dispatch_manifests, dispatch_manifest_items, dispatch_events
  from anon, authenticated, service_role;
grant select on dispatch_manifests, dispatch_manifest_items, dispatch_events
  to authenticated;
grant all privileges on dispatch_manifests, dispatch_manifest_items to service_role;
grant select, insert on dispatch_events to service_role;

drop trigger if exists dispatch_events_append_only on dispatch_events;
create trigger dispatch_events_append_only before update or delete on dispatch_events
  for each row execute function public.reject_mutation();

-- Última cerradura: bloquea la ruta, vuelve a comprobar ambos cotejos y mueve
-- todos sus paquetes en una sola transacción. Devuelve los pedidos afectados
-- para que el server action refresque el read-model del Master.
create or replace function public.finalize_dispatch_manifest(
  p_manifest_id uuid,
  p_actor uuid
)
returns uuid[]
language plpgsql
set search_path = public
as $$
declare
  v_manifest dispatch_manifests%rowtype;
  v_total integer;
  v_office integer;
  v_pickup integer;
  v_order_ids uuid[];
begin
  select * into v_manifest
    from dispatch_manifests
   where id = p_manifest_id
   for update;

  if not found then
    raise exception 'Ruta no encontrada.';
  end if;
  if v_manifest.state = 'cancelled' then
    raise exception 'La ruta está cancelada.';
  end if;
  if v_manifest.state = 'in_custody' then
    return coalesce((
      select array_agg(distinct s.order_id) filter (where s.order_id is not null)
        from dispatch_manifest_items i
        join shipments s on s.id = i.shipment_id
       where i.manifest_id = p_manifest_id and i.removed_at is null
    ), '{}'::uuid[]);
  end if;

  select count(*),
         count(*) filter (where office_checked_at is not null),
         count(*) filter (where pickup_checked_at is not null)
    into v_total, v_office, v_pickup
    from dispatch_manifest_items
   where manifest_id = p_manifest_id and removed_at is null;

  if v_total = 0 then
    raise exception 'La ruta no tiene paquetes activos.';
  end if;
  if v_office <> v_total then
    raise exception 'El cotejo de oficina no está completo (%/%).', v_office, v_total;
  end if;
  if v_pickup <> v_total then
    raise exception 'El cotejo del motorizado no está completo (%/%).', v_pickup, v_total;
  end if;

  select coalesce(array_agg(distinct s.order_id) filter (where s.order_id is not null), '{}'::uuid[])
    into v_order_ids
    from dispatch_manifest_items i
    join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id and i.removed_at is null;

  update shipments s
     set custody_state = 'courier',
         custody_transferred_at = now(),
         custody_transferred_by = p_actor,
         dispatched_at = coalesce(s.dispatched_at, now())
    from dispatch_manifest_items i
   where i.manifest_id = p_manifest_id
     and i.removed_at is null
     and s.id = i.shipment_id;

  update dispatch_manifests
     set state = 'in_custody',
         custody_completed_at = now(),
         custody_completed_by = p_actor
   where id = p_manifest_id;

  insert into order_events (
    store_id, order_id, kind, occurred_at, actor, source, courier,
    guide_code, shipment_id, note, payload
  )
  select s.store_id, s.order_id, 'custody_transferred', now(), p_actor,
         'dispatch', s.courier, s.guide_code, s.id,
         'Paquete cotejado y recibido por el motorizado.',
         jsonb_build_object(
           'manifest_id', p_manifest_id,
           'route_label', v_manifest.route_label,
           'route_date', v_manifest.route_date,
           'driver_name', v_manifest.driver_name
         )
    from dispatch_manifest_items i
    join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id
     and i.removed_at is null
     and s.order_id is not null;

  insert into dispatch_events (org_id, manifest_id, actor, kind, payload)
  values (
    v_manifest.org_id, p_manifest_id, p_actor, 'custody_transferred',
    jsonb_build_object('packages', v_total, 'driver_name', v_manifest.driver_name)
  );

  return v_order_ids;
end;
$$;

revoke all on function public.finalize_dispatch_manifest(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_dispatch_manifest(uuid, uuid)
  to service_role;

