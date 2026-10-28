-- MOM §38.18. Instalar antes del código; no termina ventas al instalarse.
create table if not exists public.woo_sale_returns (
  order_id uuid primary key references orders(id) on delete restrict,
  store_id uuid not null references stores(id) on delete restrict,
  actor uuid not null references auth.users(id) on delete restrict,
  reason text not null,
  shipment_ids uuid[] not null check(cardinality(shipment_ids)>0),
  stock_items jsonb not null,
  created_at timestamptz not null default now(),
  state text not null default 'pending' check(state in ('pending','syncing','synced')),
  lease_token uuid, lease_until timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text, synced_at timestamptz
);
alter table public.woo_sale_returns enable row level security;
revoke all on public.woo_sale_returns from public,anon,authenticated;
grant all on public.woo_sale_returns to service_role;
create index if not exists woo_sale_returns_due on public.woo_sale_returns(next_attempt_at,created_at) where state<>'synced';

create or replace function public.woo_end_sale_pending_return(p_order_id uuid,p_actor uuid,p_reason text,p_operation_id uuid)
returns uuid language plpgsql security invoker set search_path=public as $$
declare v_order orders%rowtype; v_ids uuid[];
begin
  if p_actor is null or p_operation_id is null or length(btrim(p_reason)) not between 5 and 600 then raise exception 'Falta actor, motivo o intento válido.'; end if;
  select * into v_order from orders where id=p_order_id for update;
  if not found or v_order.platform<>'woocommerce' or v_order.cancelled_at is not null then raise exception 'El pedido no es una venta vigente de WooCommerce.'; end if;
  if exists(select 1 from woo_sale_returns where order_id=p_order_id) then return p_order_id; end if;
  perform 1 from shipments where order_id=p_order_id order by id for update;
  if exists(select 1 from shipments where order_id=p_order_id and delivery_status='entregado')
    or exists(select 1 from delivery_stops where order_id=p_order_id and status='entregado')
    or exists(select 1 from order_events where order_id=p_order_id and (kind='delivered' or new_status='entregado'))
    or v_order.financial_status in ('paid','partially_paid','partially_refunded','refunded')
    or exists(select 1 from order_payments where order_id=p_order_id and validation_status is distinct from 'rechazado') then
    raise exception 'Hay entrega, dinero o comprobantes que requieren revisión antes de terminar la venta.';
  end if;
  select array_agg(id order by id) into v_ids from shipments where order_id=p_order_id and
    (dispatched_at is not null or custody_transferred_at is not null or custody_state in ('courier','retorno','devuelto'));
  if coalesce(cardinality(v_ids),0)=0 then raise exception 'La caja no salió: usa la anulación normal.'; end if;
  insert into woo_sale_returns(order_id,store_id,actor,reason,shipment_ids,stock_items) values(p_order_id,v_order.store_id,p_actor,p_reason,v_ids,coalesce(v_order.line_items,'[]'::jsonb));
  insert into order_events(store_id,order_id,kind,actor,source,new_status,new_operational,reason,note,operation_id,payload)
    values(v_order.store_id,p_order_id,'woo_sale_ended_pending_return',p_actor,'kapta','anulado','anulado',p_reason,
      'La venta terminó y no se reintentará. WooCommerce y el stock esperan la recepción e inventario en almacén; las salidas y liquidaciones siguen pendientes.',
      p_operation_id,jsonb_build_object('shipment_ids',v_ids,'scope','woo_return_pending'));
  return p_order_id;
end;
$$;
revoke all on function public.woo_end_sale_pending_return(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.woo_end_sale_pending_return(uuid,uuid,text,uuid) to service_role;

create or replace function public.woo_claim_sale_return(p_order_id uuid default null)
returns setof woo_sale_returns language sql security invoker set search_path=public as $$
  update woo_sale_returns set state='syncing',lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',attempts=attempts+1
  where order_id=(select q.order_id from woo_sale_returns q
    where (p_order_id is null or q.order_id=p_order_id) and q.state<>'synced' and q.next_attempt_at<=now()
      and (q.lease_until is null or q.lease_until<now())
      -- No se gastan turnos en las cajas aún en la calle ni en su inventario.
      and not exists(select 1 from unnest(q.shipment_ids) sid where not exists(
        select 1 from order_events r join order_events inv on inv.shipment_id=r.shipment_id and inv.order_id=q.order_id
        where r.order_id=q.order_id and r.shipment_id=sid and r.kind='return_received'
          and r.actor is not null and r.source in ('manual','dispatch')
          and inv.kind='inventory_reconciled' and inv.actor is not null and inv.source in ('manual','dispatch') and inv.occurred_at>=r.occurred_at))
    order by q.next_attempt_at,q.created_at for update skip locked limit 1)
  returning *;
$$;
revoke all on function public.woo_claim_sale_return(uuid) from public,anon,authenticated;
grant execute on function public.woo_claim_sale_return(uuid) to service_role;

-- También los RPC de arrastre GF respetan la venta terminada localmente.
create or replace function public.woo_block_ended_sale_dispatch()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if new.removed_at is not null then return new; end if;
  if tg_op='UPDATE' then
    if old.removed_at is null and old.shipment_id=new.shipment_id and old.manifest_id=new.manifest_id then return new; end if;
  end if;
  if exists(select 1 from shipments s join woo_sale_returns q on q.order_id=s.order_id where s.id=new.shipment_id) then
    raise exception 'La venta está terminada. Esa salida no admite otro despacho.';
  end if;
  return new;
end;
$$;
revoke all on function public.woo_block_ended_sale_dispatch() from public,anon,authenticated;
drop trigger if exists zzz_woo_block_ended_sale_dispatch on dispatch_manifest_items;
create trigger zzz_woo_block_ended_sale_dispatch before insert or update on dispatch_manifest_items
  for each row execute function public.woo_block_ended_sale_dispatch();

-- GF: la recepción conserva despacho, parada y retorno; nunca vuelve a por asignar.
create or replace function public.gf_return_to_office(p_item_id uuid, p_actor uuid)
returns uuid language plpgsql set search_path = public as $$
declare
  v_item dispatch_manifest_items%rowtype;
  v_manifest dispatch_manifests%rowtype;
  v_shipment shipments%rowtype;
  v_stop delivery_stops%rowtype;
  v_reason text;
  v_rider text;
  v_replaced boolean;
  v_code text;
begin
  select * into v_item from dispatch_manifest_items where id = p_item_id for update;
  if not found or v_item.removed_at is not null then raise exception 'Ese paquete ya no está en la caja.'; end if;
  select * into v_manifest from dispatch_manifests where id = v_item.manifest_id for update;
  if v_manifest.courier <> 'propio' then raise exception 'Solo para cajas de Grupo GF.'; end if;
  select * into v_stop from delivery_stops
    where shipment_id = v_item.shipment_id and dispatch_manifest_id = v_item.manifest_id
    order by reported_at desc nulls last limit 1 for update;
  if not found or v_stop.status <> 'no_entregado' then
    raise exception 'Solo se recibe en oficina un paquete reportado «No entregado».';
  end if;
  select * into v_shipment from shipments where id = v_item.shipment_id for update;
  v_rider := coalesce(v_manifest.driver_name, 'el motorizado');
  v_reason := 'No entregado por ' || v_rider || coalesce(' (' || v_stop.outcome_reason || ')', '') || ': recibido en oficina';

  -- A stock (0248): la salida reemplazada —el pedido ya salió con otra— y la
  -- que ya consta devuelta pero sigue en la caja. Queda devuelta; no vuelve a
  -- «por asignar» ni a la cola. Una en `retorno` sin reemplazo («Solicitar
  -- devolución») sigue el camino de siempre.
  v_replaced := gf_output_replaced(v_shipment.id);
  if v_shipment.custody_state = 'devuelto' or v_shipment.returned_at is not null
     or (v_shipment.custody_state = 'retorno' and v_replaced)
     or exists(select 1 from woo_sale_returns where order_id=v_shipment.order_id) then
    v_code := coalesce(v_shipment.output_code, v_shipment.guide_code, 'La salida');
    perform set_config('gf.withdraw', 'on', true);
    update dispatch_manifest_items
       set removed_at = now(), removed_by = p_actor,
           removal_reason = left(case when v_replaced
             then 'Salida reemplazada: recibida en oficina, vuelve a stock (' || v_rider || ')'
             else 'Venta terminada o salida devuelta: recibida en oficina, sale de la caja (' || v_rider || ')' end, 300)
     where id = p_item_id;
    perform set_config('gf.withdraw', 'off', true);

    -- Conserva `dispatched_at`: salió de verdad y la devolución está probada.
    -- Una recepción anterior conserva su sello.
    update shipments
       set custody_state = 'devuelto', returned_at = coalesce(returned_at, now()),
           returned_by = coalesce(returned_by, p_actor), returned_source = coalesce(returned_source, 'manual')
     where id = v_item.shipment_id;
    -- Defensivo: la solicitud ya pasó a la salida nueva al reemplazarla.
    update logistics_requests
       set status = 'cancelled', observation = 'Salida devuelta recibida en oficina'
     where shipment_id = v_item.shipment_id and status in ('accepted', 'scheduled');

    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
    values (v_manifest.org_id, v_item.manifest_id, v_item.shipment_id, p_actor, 'returned_to_office',
            jsonb_build_object('stop_id', v_stop.id, 'outcome_reason', v_stop.outcome_reason, 'replaced', v_replaced, 'to_stock', true));
    if v_shipment.order_id is not null and not exists (
      select 1 from order_events where shipment_id = v_item.shipment_id and kind = 'return_received'
    ) then
      insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
      values (v_shipment.store_id, v_shipment.order_id, 'return_received', p_actor, 'dispatch', 'propio',
              v_shipment.guide_code, v_item.shipment_id, v_stop.outcome_reason,
              case when v_replaced
                then v_code || ' recibida en oficina (' || v_rider
                  || '): era la caja reemplazada. Desármala y devuelve el producto a stock; no se reprograma.'
                else v_code || ' recibida en oficina (' || v_rider
                  || '): venta terminada o devolución confirmada. Sale de la caja; no vuelve a «por asignar».' end,
              jsonb_build_object('manifest_id', v_item.manifest_id, 'rider_id', v_manifest.rider_id,
                                 'route_date', v_manifest.route_date, 'stop_id', v_stop.id, 'replaced', v_replaced));
    end if;
    return v_shipment.order_id;
  end if;

  perform set_config('gf.withdraw', 'on', true);
  update dispatch_manifest_items
     set removed_at = now(), removed_by = p_actor, removal_reason = left(v_reason, 300)
   where id = p_item_id;
  perform set_config('gf.withdraw', 'off', true);

  -- Cualquier motivo, rechazo incluido: la caja vuelve a la empresa y la
  -- solicitud queda aceptada para el siguiente intento.
  update shipments
     set custody_state = 'empresa', custody_transferred_at = null, custody_transferred_by = null, dispatched_at = null
   where id = v_item.shipment_id;
  update logistics_requests
     set status = 'accepted', observation = left(v_reason, 300)
   where shipment_id = v_item.shipment_id and status = 'scheduled';

  insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
  values (v_manifest.org_id, v_item.manifest_id, v_item.shipment_id, p_actor, 'returned_to_office',
          jsonb_build_object('stop_id', v_stop.id, 'outcome_reason', v_stop.outcome_reason));
  if v_shipment.order_id is not null then
    insert into order_events(store_id, order_id, kind, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (v_shipment.store_id, v_shipment.order_id, 'returned_to_office', p_actor, 'dispatch', 'propio',
            v_shipment.guide_code, v_item.shipment_id, v_stop.outcome_reason,
            v_reason || '. Vuelve a «por asignar».',
            jsonb_build_object('manifest_id', v_item.manifest_id, 'rider_id', v_manifest.rider_id,
                               'route_date', v_manifest.route_date, 'stop_id', v_stop.id));
  end if;
  return v_shipment.order_id;
end;
$$;

revoke all on function public.gf_return_to_office(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gf_return_to_office(uuid, uuid) to service_role;
