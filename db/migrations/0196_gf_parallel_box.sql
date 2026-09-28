-- ============================================================================
-- 0196_gf_parallel_box.sql — la caja del motorizado sigue abierta mientras se
-- coteja (MOM §29.2 y §29.13; decisión de Frankz, 28-09-2026).
--
-- Modo `exigir`. Hasta aquí, en cuanto oficina cotejaba el primer paquete de
-- una caja, al motorizado ya no se le podía sumar nada hasta que él recibiera
-- la caja entera: primero «La carga ya inició el cotejo; no se pueden agregar
-- paquetes» y después «Termina de verificar y recibir la carga actual antes de
-- agregar otra». Medido del 23 al 26-09: ventanas de 9 a 74 minutos sin poder
-- sumar. El 25-09 lo escaneado para Yhoni a las 10:46 no salió con él; el 26-09
-- la carga 2 se abrió cuando él ya salía, nunca la recibió y quedó vacía,
-- bloqueando la liquidación del día.
--
-- La regla de la operación: se le siguen sumando paquetes EN PARALELO mientras
-- se coteja la caja. Al final todo debe quedar cotejado —por oficina y por el
-- motorizado— o retirada la diferencia que no irá. La custodia, y con ella la
-- ruta del día, sigue pasando solo con el 100 % de los paquetes activos
-- cotejados dos veces: eso no cambia.
--
--   gf_dispatch_load        devuelve la MISMA caja mientras no esté en
--                           custodia (borrador, cotejo de oficina, lista o
--                           recibiéndose). Solo abre una carga adicional cuando
--                           el motorizado ya salió con la anterior.
--   gf_guard_load_items     admite el paquete nuevo en cualquier caja sin
--                           custodia. Si oficina ya la había dado por
--                           verificada, vuelve a «cotejo de oficina»: el
--                           paquete nuevo entra sin cotejar. Los cotejos
--                           anteriores no se tocan.
--   gf_rider_receive        el motorizado recibe cada paquete que oficina ya
--                           verificó, aunque queden otros por verificar. Un
--                           paquete sin verificar se rechaza diciendo por qué.
--   gf_rider_decline        «No lo recojo» también mientras oficina coteja: es
--                           como el motorizado retira la diferencia que no irá.
--   gf_finalize_if_complete nuevo: pasa la custodia si, tras retirar un paquete,
--                           todo lo que queda está cotejado dos veces. Sin él,
--                           retirar el último pendiente dejaba la caja completa
--                           y sin dueño.
--
-- Aplicar a mano antes de desplegar el código que la usa (DEPLOY.md). Con el
-- código anterior funciona, pero una caja que vuelve a cotejo de oficina se
-- esconde de «Recibir mi caja» hasta que oficina termina.
-- ============================================================================

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
    -- 0196: mientras la caja no salga, lo nuevo entra en ella aunque oficina
    -- la esté cotejando o el motorizado recibiendo.
    if v_load.state <> 'in_custody' then return v_load.id; end if;
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

create or replace function public.gf_guard_load_items()
returns trigger language plpgsql set search_path = public as $$
declare v_manifest dispatch_manifests%rowtype; v_mode text; v_withdraw boolean;
begin
  select * into v_manifest from dispatch_manifests where id = new.manifest_id for update;
  if v_manifest.courier = 'propio' then
    v_mode := public.gf_rider_pickup_mode(v_manifest.org_id);
    v_withdraw := coalesce(current_setting('gf.withdraw', true), '') = 'on';
    if tg_op = 'INSERT' then
      if v_manifest.state = 'in_custody' and v_mode <> 'exigir' then
        return new;
      end if;
      if v_manifest.state in ('in_custody', 'cancelled') then
        raise exception 'Esa caja ya salió con el motorizado o está cancelada: lo nuevo va en una carga adicional.';
      end if;
      -- 0196: la caja sigue abierta durante el cotejo. Un paquete nuevo entra
      -- sin cotejar; si oficina ya la había terminado, vuelve a cotejo de
      -- oficina solo por él.
      if new.office_checked_at is null and v_manifest.state in ('ready_for_pickup', 'pickup_check') then
        update dispatch_manifests
           set state = 'office_check', office_completed_at = null, office_completed_by = null
         where id = new.manifest_id;
      end if;
    end if;
    if tg_op = 'UPDATE' and v_manifest.state in ('in_custody', 'cancelled') then
      if v_manifest.state = 'cancelled' or (v_mode = 'exigir' and not v_withdraw) then
        raise exception 'La carga ya está cerrada; sus cotejos son históricos.';
      end if;
      if (new.removed_at is distinct from old.removed_at or new.shipment_id <> old.shipment_id)
         and not v_withdraw then
        raise exception 'La carga ya está en poder del motorizado; sus paquetes no se retiran desde aquí.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.gf_rider_receive(p_manifest_id uuid, p_code text, p_actor uuid)
returns uuid[] language plpgsql set search_path = public as $$
declare v_manifest dispatch_manifests%rowtype; v_item dispatch_manifest_items%rowtype; v_item_id uuid; v_count integer;
begin
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if not found or v_manifest.courier <> 'propio' or not exists (
    select 1 from riders where id = v_manifest.rider_id and user_id = p_actor and active
  ) then raise exception 'La carga no pertenece a tu cuenta.'; end if;
  if v_manifest.state = 'in_custody' then raise exception 'Esta caja ya la recibiste completa.'; end if;
  if v_manifest.state = 'cancelled' then raise exception 'Esta caja fue cancelada.'; end if;
  if v_manifest.state not in ('office_check', 'ready_for_pickup', 'pickup_check') then
    raise exception 'La oficina todavía no empieza a verificar esta caja.';
  end if;
  select count(*), (array_agg(i.id))[1] into v_count, v_item_id
    from dispatch_manifest_items i join shipments s on s.id = i.shipment_id
    where i.manifest_id = p_manifest_id and i.removed_at is null and (
      s.qr_token::text = p_code or lower(s.output_code) = lower(p_code)
      or lower(s.guide_code) = lower(p_code)
      or lower(ltrim(s.order_name, '#')) = lower(ltrim(p_code, '#')));
  if v_count <> 1 then raise exception 'Escanea el QR de un paquete de esta carga.'; end if;
  select * into v_item from dispatch_manifest_items where id = v_item_id;
  -- 0196: se recibe por paquete. Lo que oficina ya verificó se puede recibir
  -- aunque la caja siga en cotejo; lo que no, espera.
  if v_item.office_checked_at is null then
    raise exception 'Ese paquete todavía no lo verifica oficina. Recibe los demás y vuelve a escanearlo cuando lo cotejen.';
  end if;
  if v_item.pickup_checked_at is null then
    update dispatch_manifest_items set pickup_checked_at = now(), pickup_checked_by = p_actor where id = v_item_id;
    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind)
      values (v_manifest.org_id, p_manifest_id, v_item.shipment_id, p_actor, 'pickup_checked');
  end if;
  if not exists(select 1 from dispatch_manifest_items where manifest_id = p_manifest_id
    and removed_at is null and pickup_checked_at is null) then
    -- Todo recibido implica todo verificado: solo se recibe lo verificado.
    return public.finalize_dispatch_manifest(p_manifest_id, p_actor);
  end if;
  update dispatch_manifests
     set state = case when exists (select 1 from dispatch_manifest_items where manifest_id = p_manifest_id
                                     and removed_at is null and office_checked_at is null)
                      then 'office_check' else 'pickup_check' end
   where id = p_manifest_id;
  return '{}'::uuid[];
end;
$$;
revoke all on function public.gf_rider_receive(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.gf_rider_receive(uuid, text, uuid) to service_role;

-- «No lo recojo» (0182/0185). Sin custodia ahora también vale con la caja en
-- cotejo de oficina, y el estado se recalcula con lo que queda.
create or replace function public.gf_rider_decline(p_manifest_id uuid, p_shipment_id uuid, p_reason text, p_actor uuid)
returns uuid[] language plpgsql set search_path = public as $$
declare
  v_manifest dispatch_manifests%rowtype;
  v_rider riders%rowtype;
  v_item dispatch_manifest_items%rowtype;
  v_shipment shipments%rowtype;
  v_reason text := left(trim(coalesce(p_reason, '')), 200);
  v_active integer;
  v_pending integer;
  v_unverified integer;
  v_order uuid;
begin
  if length(v_reason) < 2 then raise exception 'Di por qué no lo llevas.'; end if;
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if not found or v_manifest.courier <> 'propio' then raise exception 'La carga no pertenece a tu cuenta.'; end if;
  select * into v_rider from riders where id = v_manifest.rider_id and user_id = p_actor and active;
  if not found then raise exception 'La carga no pertenece a tu cuenta.'; end if;

  -- Modo 'confirmar': la caja ya salió con custodia; «No lo llevo» retira el
  -- paquete, borra su parada pendiente y lo devuelve a «por asignar».
  if v_manifest.state = 'in_custody' then
    if public.gf_rider_pickup_mode(v_manifest.org_id) <> 'confirmar' then
      raise exception 'La caja ya está en tu poder; avisa al supervisor para retirar un paquete.';
    end if;
    select * into v_item from dispatch_manifest_items
      where manifest_id = p_manifest_id and shipment_id = p_shipment_id and removed_at is null;
    if not found then raise exception 'Ese paquete ya no está en tu caja.'; end if;
    if v_item.pickup_checked_at is not null then raise exception 'Ya confirmaste que lo llevas; avisa al supervisor para retirarlo.'; end if;
    update dispatch_manifest_items
       set pickup_declined_at = now(), pickup_declined_by = p_actor, pickup_declined_reason = v_reason
     where id = v_item.id;
    v_order := public.gf_withdraw_in_custody(v_item.id, 'No lo llevó ' || v_rider.full_name || ': ' || v_reason, p_actor,
      'pickup_declined', 'No lo llevó ' || v_rider.full_name || ': ' || v_reason,
      jsonb_build_object('rider_id', v_rider.id, 'declined_reason', v_reason));
    return case when v_order is null then '{}'::uuid[] else array[v_order] end;
  end if;

  if v_manifest.state = 'cancelled' then raise exception 'Esta caja fue cancelada.'; end if;
  if v_manifest.state not in ('office_check', 'ready_for_pickup', 'pickup_check') then
    raise exception 'La oficina todavía no empieza a verificar esta caja.';
  end if;
  select * into v_item from dispatch_manifest_items
    where manifest_id = p_manifest_id and shipment_id = p_shipment_id and removed_at is null for update;
  if not found then raise exception 'Ese paquete ya no está en tu caja.'; end if;
  if v_item.pickup_checked_at is not null then raise exception 'Ya recibiste ese paquete; avisa al supervisor para retirarlo.'; end if;
  select * into v_shipment from shipments where id = p_shipment_id;

  update dispatch_manifest_items
     set pickup_declined_at = now(), pickup_declined_by = p_actor, pickup_declined_reason = v_reason,
         removed_at = now(), removed_by = p_actor,
         removal_reason = 'No recogido por ' || v_rider.full_name || ': ' || v_reason
   where id = v_item.id;

  insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
  values (v_manifest.org_id, p_manifest_id, p_shipment_id, p_actor, 'pickup_declined',
          jsonb_build_object('reason', v_reason, 'rider_id', v_rider.id));
  if v_shipment.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (v_shipment.store_id, v_shipment.order_id, 'pickup_declined', p_actor, 'reparto', 'propio',
            v_shipment.guide_code, p_shipment_id, v_reason,
            'No lo llevó ' || v_rider.full_name || ' al recibir su caja: ' || v_reason,
            jsonb_build_object('manifest_id', p_manifest_id, 'rider_id', v_rider.id, 'route_date', v_manifest.route_date));
  end if;
  update logistics_requests
     set status = 'accepted', observation = 'No recogido por ' || v_rider.full_name || ': ' || v_reason
   where shipment_id = p_shipment_id and status = 'scheduled';

  select count(*), count(*) filter (where pickup_checked_at is null), count(*) filter (where office_checked_at is null)
    into v_active, v_pending, v_unverified
    from dispatch_manifest_items where manifest_id = p_manifest_id and removed_at is null;
  if v_active = 0 then
    update dispatch_manifests set state = 'draft', office_completed_at = null, office_completed_by = null where id = p_manifest_id;
    return '{}'::uuid[];
  end if;
  if v_pending = 0 then
    return public.finalize_dispatch_manifest(p_manifest_id, p_actor);
  end if;
  -- 0196: si lo que no se recoge era lo único sin verificar, oficina queda completa.
  update dispatch_manifests
     set state = case when v_unverified > 0 then 'office_check'
                      when v_pending < v_active then 'pickup_check'
                      else 'ready_for_pickup' end,
         office_completed_at = case when v_unverified > 0 then null else coalesce(office_completed_at, now()) end,
         office_completed_by = case when v_unverified > 0 then null else office_completed_by end
   where id = p_manifest_id;
  return '{}'::uuid[];
end;
$$;
revoke all on function public.gf_rider_decline(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.gf_rider_decline(uuid, uuid, text, uuid) to service_role;

-- Retirar el último paquete pendiente puede dejar la caja completa: todo lo que
-- queda, cotejado por oficina y recibido por el motorizado. Nadie más iba a
-- pasar la custodia. Lo llaman las acciones de retiro y mover de caja; en
-- cualquier otro caso no hace nada.
create or replace function public.gf_finalize_if_complete(p_manifest_id uuid, p_actor uuid)
returns uuid[] language plpgsql set search_path = public as $$
declare v_manifest dispatch_manifests%rowtype;
begin
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if not found or v_manifest.courier <> 'propio' or v_manifest.kind <> 'reparto'
     or v_manifest.state in ('in_custody', 'cancelled') then
    return '{}'::uuid[];
  end if;
  if not exists (select 1 from dispatch_manifest_items where manifest_id = p_manifest_id and removed_at is null)
     or exists (select 1 from dispatch_manifest_items where manifest_id = p_manifest_id and removed_at is null
                  and (office_checked_at is null or pickup_checked_at is null)) then
    return '{}'::uuid[];
  end if;
  return public.finalize_dispatch_manifest(p_manifest_id, p_actor);
end;
$$;
revoke all on function public.gf_finalize_if_complete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_finalize_if_complete(uuid, uuid) to service_role;
