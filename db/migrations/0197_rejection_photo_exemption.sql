-- 0197: los rechazos de rutas anteriores al 28-09-2026 no exigen foto para
-- aprobar el pago del motorizado (MOM §29.7, decisión de Frankz, 28-09-2026).
--
-- Hasta el 27/09 el teléfono no pedía foto al rechazar —solo a la entrega— y
-- de 204 rechazos reportados ninguno la tenía: la puerta ya pasó y no hay foto
-- que conseguir. El cierre de la ruta ya los exime (`REJECTION_PHOTO_FROM` en
-- lib/routes.ts); aquí `rider_pay_preview` deja de contarlos en
-- `evidence_missing`, para que terminar la ruta y aprobar el pago digan lo
-- mismo. La entrega sin foto y el Yape sin captura siguen contando siempre.
--
-- Solo se reemplaza la función: el cuerpo es el de 0162 salvo el conteo de
-- evidencia. Los cierres ya aprobados guardan su snapshot congelado y no
-- cambian. Se puede volver a correr.

create or replace function rider_pay_preview(p_route uuid, p_actor uuid)
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
    -- La entrega exige foto siempre; el rechazo, solo en rutas desde el 28/09.
    count(*) filter(where ((x->>'status'='entregado'
        or (x->>'outcome_reason'='rechazado' and v_route.route_date >= date '2026-09-28'))
      and coalesce(x->>'photo_path','')='')
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

revoke all on function rider_pay_preview(uuid,uuid) from public,anon,authenticated;
grant execute on function rider_pay_preview(uuid,uuid) to service_role;
