-- 0096 — Dos tipos de ruta en la Mesa de despacho.
--
-- POR QUÉ. La Mesa trataba igual dos cosas distintas:
--
--   * una CAJA QUE SE LE ENTREGA A UN MOTORIZADO, donde el doble cotejo tiene
--     sentido porque hay alguien del otro lado que confirma lo que recibe; y
--   * una ENTREGA AL COURIER (Aliclik recoge, o la caja se lleva a Shalom/Olva),
--     donde el segundo cotejo no puede ocurrir: nadie del otro lado escanea.
--
-- Con un solo tipo, las rutas de Aliclik y agencia se quedaban trabadas para
-- siempre en `ready_for_pickup` esperando un cotejo que nunca iba a llegar, y la
-- custodia no pasaba nunca al courier.
--
-- `kind` separa los dos casos. `received_by` guarda quién recogió físicamente
-- cuando no hay motorizado que coteje: es la única prueba de la entrega, así que
-- finalizar una ruta de ese tipo lo exige.

alter table dispatch_manifests
  add column if not exists kind text not null default 'reparto',
  add column if not exists received_by text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'dispatch_manifests_kind_check'
  ) then
    alter table dispatch_manifests
      add constraint dispatch_manifests_kind_check
      check (kind in ('reparto', 'entrega_courier'));
  end if;
end $$;

comment on column dispatch_manifests.kind is
  'reparto = caja para un motorizado, con doble cotejo. '
  'entrega_courier = Aliclik recoge o se lleva a agencia: cotejo de oficina y '
  'nombre de quien recoge, sin segundo cotejo (MOM §5, Fase 2).';
comment on column dispatch_manifests.received_by is
  'Quién recogió físicamente los paquetes cuando la ruta no tiene motorizado que '
  'coteje. Obligatorio para cerrar una ruta entrega_courier.';

-- Las rutas ya creadas son todas de reparto salvo las de couriers que no
-- reparten con motorizado nuestro. Se corrige el histórico abierto para que no
-- quede esperando un cotejo imposible.
update dispatch_manifests
   set kind = 'entrega_courier'
 where kind = 'reparto'
   and lower(trim(courier)) in ('aliclik', 'shalom', 'olva');

-- ---------------------------------------------------------------------------
-- finalize_dispatch_manifest: el segundo cotejo solo se exige donde existe.
-- ---------------------------------------------------------------------------
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
  v_note text;
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

  if v_manifest.kind = 'reparto' then
    if v_pickup <> v_total then
      raise exception 'El cotejo del motorizado no está completo (%/%).', v_pickup, v_total;
    end if;
    v_note := 'Paquete cotejado y recibido por el motorizado.';
  else
    -- Sin motorizado que coteje, la prueba de la entrega es el nombre de quien
    -- recogió. Sin eso no hay a quién reclamarle una caja que no llegó.
    if length(trim(coalesce(v_manifest.received_by, ''))) = 0 then
      raise exception 'Anota quién recoge antes de cerrar la entrega al courier.';
    end if;
    v_note := 'Paquete entregado al courier: ' || v_manifest.received_by || '.';
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
         v_note,
         jsonb_build_object(
           'manifest_id', p_manifest_id,
           'route_label', v_manifest.route_label,
           'route_date', v_manifest.route_date,
           'route_kind', v_manifest.kind,
           'driver_name', v_manifest.driver_name,
           'received_by', v_manifest.received_by
         )
    from dispatch_manifest_items i
    join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id
     and i.removed_at is null
     and s.order_id is not null;

  insert into dispatch_events (org_id, manifest_id, actor, kind, payload)
  values (
    v_manifest.org_id, p_manifest_id, p_actor, 'custody_transferred',
    jsonb_build_object(
      'packages', v_total,
      'route_kind', v_manifest.kind,
      'driver_name', v_manifest.driver_name,
      'received_by', v_manifest.received_by
    )
  );

  return v_order_ids;
end;
$$;

-- `create or replace` conserva los permisos, pero se repiten para que la
-- migración sea válida también aplicada sola sobre una base limpia.
revoke all on function public.finalize_dispatch_manifest(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_dispatch_manifest(uuid, uuid)
  to service_role;
