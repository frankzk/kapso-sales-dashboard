-- 0220_swayp_pilot_14_dias_0_a_2_intentos.sql — el piloto sin historial del
-- reintento automático Aliclik → Swayp (MOM §11.9.1) admite pedidos de hasta
-- 14 días y guías Aliclik con 0, 1 o 2 intentos informados.
--
-- POR QUÉ (03-10-2026, decisión del owner). En 70 pasadas el piloto emitió 4
-- guías y en las últimas no encontró ni un elegible: el cupo de 3 diarios no
-- era el límite. De los 126 pedidos apartados por `pilot_limits`, 95 tenían
-- más de 7 días —la edad se cuenta desde la compra y Aliclik suele fallar entre
-- el día 5 y el 10—, 68 traían 0 intentos (el courier cerró sin llegar a ir) y
-- 26 traían 2 o más.
--
-- QUÉ CAMBIA. Solo la condición del piloto dentro de `swayp_emission_claim`:
-- 7 → 14 días y `aliclik_attempts` entre 0 y 2. Un intento sin dato sigue
-- fuera: ausencia no es cero. Tope de S/500, cupo, pin corroborado, pagos y
-- todo lo demás quedan como en la 0219. La app aplica lo mismo con
-- `PILOT_MAX_ORDER_DAYS` y `pilotAttemptsOk` (lib/swayp-auto-policy.ts).

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
  if p_auto then
    -- Solo el automático exige que no quede otra salida viva: su origen es una
    -- guía Aliclik ya anulada. Por botón o voz, la salida «por definir» se
    -- rellena y la adicional de Lima lleva motivo (puertaDeSalidaAdicional, MOM
    -- §9); este chequeo las rechazaba todas (0219).
    if exists(select 1 from shipments where order_id=p_order and id::text<>p_key
      and delivery_status not in ('anulado','devuelto','transferido')) then
      return jsonb_build_object('error','El pedido tiene otra guía activa o entregada'); end if;
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
    if p_evidence->>'cohort'='recent_no_history' then
      if not c.pilot_enabled then return jsonb_build_object('error','Piloto desactivado'); end if;
      if (select count(*) from swayp_guide_emissions where org_id=v_org and automatic
        and evidence->>'cohort'='recent_no_history'
        and created_at>=(date_trunc('day',now() at time zone 'America/Lima') at time zone 'America/Lima'))>=c.pilot_daily_cap then
        return jsonb_build_object('error','Piloto: cupo diario alcanzado'); end if;
      if v_source.aliclik_attempts is null or v_source.aliclik_attempts not between 0 and 2
        or not exists(select 1 from orders where id=p_order and created_at between now()-interval '14 days' and now() and total_amount>0 and total_amount<=500)
        or exists(select 1 from order_payments where order_id=p_order and validation_status<>'rechazado')
        or p_evidence#>>'{location,ok}' is distinct from 'true' then
        return jsonb_build_object('error','El pedido no cumple el piloto sin historial'); end if;
    end if;
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
