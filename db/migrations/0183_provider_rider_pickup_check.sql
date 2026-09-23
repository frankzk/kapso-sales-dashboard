-- ============================================================================
-- 0183_provider_rider_pickup_check.sql — la verificación de la caja por el
-- motorizado es OPCIONAL, gobernada por un flag en la base (MOM §29.13).
--
-- `logistics_providers.rider_pickup_check_required`:
--   true  = como hasta ahora: oficina coteja, el motorizado escanea su caja y
--           la custodia cambia al 100 % de los aceptados (gf_rider_receive).
--   false = basta con ASIGNAR. En cuanto el supervisor pone paquetes en la
--           caja del día, la custodia pasa al motorizado (gf_assign_custody), el
--           trigger crea las paradas y /reparto le muestra su ruta. El cotejo
--           de oficina y la recepción del motorizado quedan como pasos
--           opcionales que no bloquean nada: si se hacen, se registran igual
--           (el guard de ítems los admite sobre una carga ya en custodia).
--
-- Se decide en datos y no en código ni en variables de entorno para poder
-- encender o apagar la verificación sin desplegar:
--   update logistics_providers set rider_pickup_check_required = true
--    where code = 'grupo-gf-courier';
-- El valor de arranque en producción quedó en FALSE por decisión de la
-- operación el 19-09-2026 (la verificación queda separada del flujo).
-- ============================================================================
alter table logistics_providers
  add column if not exists rider_pickup_check_required boolean not null default true;

-- Custodia al asignar: el mismo cambio de custodia que finalize_dispatch_manifest
-- (shipments a `courier`, manifiesto `in_custody`, eventos), sin exigir cotejos.
create or replace function public.gf_assign_custody(p_manifest_id uuid, p_actor uuid)
returns uuid[] language plpgsql set search_path = public as $$
declare
  v_manifest dispatch_manifests%rowtype;
  v_required boolean;
  v_total integer;
  v_order_ids uuid[];
  v_note text := 'Custodia al asignar: verificación del motorizado desactivada.';
begin
  select * into v_manifest from dispatch_manifests where id = p_manifest_id for update;
  if not found then raise exception 'Caja no encontrada.'; end if;
  if v_manifest.courier <> 'propio' or v_manifest.rider_id is null then
    raise exception 'La custodia al asignar solo aplica a cajas de motorizados de Grupo GF.';
  end if;
  select rider_pickup_check_required into v_required from logistics_providers
    where org_id = v_manifest.org_id and code = 'grupo-gf-courier';
  if coalesce(v_required, true) then
    raise exception 'La verificación del motorizado está activada: la custodia cambia al recibir la caja.';
  end if;
  if v_manifest.state = 'in_custody' then
    return coalesce((select array_agg(distinct s.order_id) filter (where s.order_id is not null)
      from dispatch_manifest_items i join shipments s on s.id = i.shipment_id
      where i.manifest_id = p_manifest_id and i.removed_at is null), '{}'::uuid[]);
  end if;
  if v_manifest.state = 'cancelled' then raise exception 'La caja está cancelada.'; end if;
  select count(*) into v_total from dispatch_manifest_items where manifest_id = p_manifest_id and removed_at is null;
  if v_total = 0 then raise exception 'La caja no tiene paquetes.'; end if;

  select coalesce(array_agg(distinct s.order_id) filter (where s.order_id is not null), '{}'::uuid[])
    into v_order_ids
    from dispatch_manifest_items i join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id and i.removed_at is null;

  update shipments s
     set custody_state = 'courier', custody_transferred_at = now(), custody_transferred_by = p_actor,
         dispatched_at = coalesce(s.dispatched_at, now())
    from dispatch_manifest_items i
   where i.manifest_id = p_manifest_id and i.removed_at is null and s.id = i.shipment_id;

  update dispatch_manifests
     set state = 'in_custody', custody_completed_at = now(), custody_completed_by = p_actor
   where id = p_manifest_id;

  insert into order_events (store_id, order_id, kind, occurred_at, actor, source, courier, guide_code, shipment_id, note, payload)
  select s.store_id, s.order_id, 'custody_transferred', now(), p_actor, 'dispatch', s.courier, s.guide_code, s.id, v_note,
         jsonb_build_object('manifest_id', p_manifest_id, 'route_label', v_manifest.route_label, 'route_date', v_manifest.route_date,
                            'route_kind', v_manifest.kind, 'driver_name', v_manifest.driver_name, 'auto', true)
    from dispatch_manifest_items i join shipments s on s.id = i.shipment_id
   where i.manifest_id = p_manifest_id and i.removed_at is null and s.order_id is not null;

  insert into dispatch_events (org_id, manifest_id, actor, kind, payload)
  values (v_manifest.org_id, p_manifest_id, p_actor, 'custody_transferred',
          jsonb_build_object('packages', v_total, 'route_kind', v_manifest.kind, 'driver_name', v_manifest.driver_name, 'auto', true, 'note', v_note));
  return v_order_ids;
end;
$$;
revoke all on function public.gf_assign_custody(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_assign_custody(uuid, uuid) to service_role;

-- Con la verificación desactivada, cotejar o recibir después de la custodia es
-- un registro opcional: el guard lo admite en vez de decir «carga cerrada».
create or replace function public.gf_guard_load_items()
returns trigger language plpgsql set search_path = public as $$
declare v_manifest dispatch_manifests%rowtype; v_required boolean;
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
      select rider_pickup_check_required into v_required from logistics_providers
        where org_id = v_manifest.org_id and code = 'grupo-gf-courier';
      if v_manifest.state = 'cancelled' or coalesce(v_required, true) then
        raise exception 'La carga ya está cerrada; sus cotejos son históricos.';
      end if;
      -- Verificación desactivada: solo se admiten los cotejos, nunca alterar la
      -- pertenencia de una carga ya en custodia.
      if new.removed_at is distinct from old.removed_at or new.shipment_id <> old.shipment_id then
        raise exception 'La carga ya está en poder del motorizado; sus paquetes no se retiran desde aquí.';
      end if;
    end if;
  end if;
  return new;
end;
$$;
