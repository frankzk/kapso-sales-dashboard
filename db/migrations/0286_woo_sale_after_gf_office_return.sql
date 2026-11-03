-- MOM §38.18. Una recepción GF para reprogramar no borra el hecho de salida.
-- Instalar antes del código. La instalación no termina ventas ni recibe cajas.
create or replace function public.woo_end_sale_pending_return(p_order_id uuid,p_actor uuid,p_reason text,p_operation_id uuid)
returns uuid language plpgsql security invoker set search_path=public as $$
declare
  v_order orders%rowtype;
  v_ids uuid[];
  v_id uuid;
  v_shipment shipments%rowtype;
  v_receipt order_events%rowtype;
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
  select array_agg(s.id order by s.id) into v_ids from shipments s where s.order_id=p_order_id and
    (s.dispatched_at is not null or s.custody_transferred_at is not null or s.custody_state in ('courier','retorno','devuelto')
      or exists(select 1 from order_events e where e.order_id=p_order_id and e.shipment_id=s.id
        and e.kind='returned_to_office' and e.source='dispatch' and e.actor is not null));
  if coalesce(cardinality(v_ids),0)=0 then raise exception 'La caja no salió: usa la anulación normal.'; end if;
  insert into woo_sale_returns(order_id,store_id,actor,reason,shipment_ids,stock_items)
    values(p_order_id,v_order.store_id,p_actor,p_reason,v_ids,coalesce(v_order.line_items,'[]'::jsonb));

  -- Si almacén ya la recibió para reprogramar, la venta terminada la deja
  -- devuelta. Se enlaza el hecho original, con su fecha y actor, sin inventar
  -- una segunda recepción ni aprobar inventario. Las cajas afuera no se tocan.
  foreach v_id in array v_ids loop
    select * into v_shipment from shipments where id=v_id;
    if v_shipment.courier is distinct from 'propio' or v_shipment.custody_state is distinct from 'empresa'
      or exists(select 1 from dispatch_manifest_items where shipment_id=v_id and removed_at is null) then continue; end if;
    select * into v_receipt from order_events e where e.order_id=p_order_id and e.shipment_id=v_id
      and e.kind='returned_to_office' and e.source='dispatch' and e.actor is not null
      and (v_shipment.dispatched_at is null or e.occurred_at>=v_shipment.dispatched_at)
      and not exists(select 1 from order_events later where later.shipment_id=v_id
        and later.kind='custody_transferred' and later.occurred_at>e.occurred_at)
      order by e.occurred_at desc,e.id desc limit 1;
    if not found then continue; end if;
    update shipments set custody_state='devuelto',returned_at=v_receipt.occurred_at,
      returned_by=v_receipt.actor,returned_source='manual' where id=v_id;
    insert into order_events(store_id,order_id,shipment_id,kind,source,actor,occurred_at,note,payload)
      select v_order.store_id,p_order_id,v_id,'return_received','dispatch',v_receipt.actor,v_receipt.occurred_at,
        'Venta terminada después de recibir en oficina. Se conserva la recepción física original; falta inventario apto a stock.',
        jsonb_build_object('office_receipt_event_id',v_receipt.id,'registered_by',p_actor,'sale_operation_id',p_operation_id)
      where not exists(select 1 from order_events where shipment_id=v_id and kind='return_received'
        and actor is not null and source in ('manual','dispatch') and occurred_at>=v_receipt.occurred_at);
    with cancelled as (
      update logistics_requests set status='cancelled',observation='Venta terminada: recepción en oficina ya registrada'
        where shipment_id=v_id and status<>'cancelled' returning id
    ) insert into logistics_request_events(request_id,kind,status,actor,note,payload)
      select id,'sale_ended_return_received','cancelled',p_actor,'Venta terminada después de la recepción en oficina',
        jsonb_build_object('shipment_id',v_id,'office_receipt_event_id',v_receipt.id) from cancelled;
  end loop;
  insert into order_events(store_id,order_id,kind,actor,source,new_status,new_operational,reason,note,operation_id,payload)
    values(v_order.store_id,p_order_id,'woo_sale_ended_pending_return',p_actor,'kapta','anulado','anulado',p_reason,
      'La venta terminó y no se reintentará. WooCommerce y el stock esperan recepción e inventario; se conservan las recepciones de oficina ya registradas.',
      p_operation_id,jsonb_build_object('shipment_ids',v_ids,'scope','woo_return_pending'));
  return p_order_id;
end;
$$;
revoke all on function public.woo_end_sale_pending_return(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.woo_end_sale_pending_return(uuid,uuid,text,uuid) to service_role;
