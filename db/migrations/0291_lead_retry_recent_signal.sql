-- Owner-approved fix, 29-10-2026: retries need REAL intent within seven days.
-- Do not use lead creation, mirror updates, outbound messages or system notes.
create or replace function public.lead_retry_signal_at(p_lead public.leads, p_now timestamptz default now())
returns timestamptz language sql stable security invoker set search_path = public as $$
  select max(signal_at) from (
    select (p_lead).last_inbound_at as signal_at
    union all
    select d.created_at from public.draft_orders d
    where d.store_id = (p_lead).store_id
      and d.shopify_draft_order_id = regexp_replace((p_lead).draft_order_gid, '^gid://shopify/DraftOrder/', '')
      and d.draft_order_gid = (p_lead).draft_order_gid
    union all
    select max(c.occurred_at) from public.lead_calls c
    where c.store_id = (p_lead).store_id and c.lead_id = (p_lead).id
      and c.occurred_at <= p_now
      and (p_lead).next_followup_at is not null
      and c.next_followup_at = (p_lead).next_followup_at
      and (
        (c.kind = 'call' and c.vendedora is not null)
        or (c.kind = 'voice_agent' and c.new_status in ('casi_cierra','volver_a_llamar'))
      )
  ) signals where signal_at <= p_now
$$;
revoke all on function public.lead_retry_signal_at(public.leads,timestamptz) from public, anon, authenticated;
grant execute on function public.lead_retry_signal_at(public.leads,timestamptz) to service_role;

create or replace function public.retire_stale_lead_retries(p_store_id uuid, p_limit integer default 500)
returns integer language plpgsql security invoker set search_path = public as $$
declare r public.leads%rowtype; v_n integer := 0;
begin
  for r in
    select l.* from public.leads l
    where l.store_id = p_store_id and l.call_queue_ready
      and coalesce(public.lead_retry_signal_at(l), '-infinity'::timestamptz) < now() - interval '7 days'
      -- Do not interrupt a call that is already in progress.
      and (l.claimed_by is null or l.claimed_at is null or l.claimed_at <= now() - interval '10 minutes')
    order by l.id limit greatest(0, least(coalesce(p_limit,500),500))
    for update of l skip locked
  loop
    update public.leads set call_queue_ready = false where id = r.id;
    insert into public.lead_calls(lead_id,store_id,kind,note)
      values(r.id,r.store_id,'system',
        'Retirado de Por llamar: sin carrito, respuesta o llamada acordada en los últimos 7 días. Conserva su estado e historial en En seguimiento.');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.retire_stale_lead_retries(uuid,integer) from public, anon, authenticated;
grant execute on function public.retire_stale_lead_retries(uuid,integer) to service_role;

create or replace function public.requeue_leads_for_calls(p_store_id uuid, p_limit integer default 500)
returns integer language plpgsql security invoker set search_path = public as $$
declare r public.leads%rowtype; v_n integer := 0; v_reason text;
begin
  perform public.retire_stale_lead_retries(p_store_id,p_limit);
  for r in
    select l.* from public.leads l
    where l.store_id = p_store_id and l.category in ('open','hot')
      and l.status in ('nuevo','no_responde','buzon','cuelga','casi_cierra','volver_a_llamar','contactado_dejo_wsp','otros_productos')
      and not l.call_queue_ready and l.call_attempt_count < 3
      and l.contact_opt_out_at is null and l.phone is not null
      and not l.has_order and l.order_id is null
      and public.lead_retry_signal_at(l) >= now() - interval '7 days'
      and (l.claimed_by is null or l.claimed_at is null or l.claimed_at <= now() - interval '10 minutes')
      and (
        (l.next_followup_at is not null and l.next_followup_at <= now())
        or (
          l.next_followup_at is null and l.status in ('no_responde','buzon','cuelga')
          and l.call_attempt_count > 0
          and (l.cart_item_count > 0 or nullif(l.draft_order_gid,'') is not null)
          and l.last_interaction_at < now() - interval '48 hours'
        )
      )
    order by l.next_followup_at nulls last, l.last_interaction_at, l.id
    limit greatest(0, least(coalesce(p_limit,500),500))
    for update of l skip locked
  loop
    v_reason := case when r.next_followup_at is not null then 'Llegó la fecha de llamada'
      else 'Carrito sin contacto durante 48 h' end;
    update public.leads set call_queue_ready = true, needs_attention = true where id = r.id;
    insert into public.lead_calls(lead_id,store_id,kind,note)
      values (r.id,r.store_id,'system',v_reason || ' · actividad real en los últimos 7 días · vuelve a Por llamar · intento ' || (r.call_attempt_count+1)::text || ' de 3');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.requeue_leads_for_calls(uuid,integer) from public, anon, authenticated;
grant execute on function public.requeue_leads_for_calls(uuid,integer) to service_role;

-- Repair the overly broad 0289 activation, once per pending row, with audit.
-- Reapplying is harmless: retired rows no longer match and are never requeued here.
do $$
declare s record; v_n integer;
begin
  for s in select distinct store_id from public.leads where call_queue_ready loop
    loop
      v_n := public.retire_stale_lead_retries(s.store_id,500);
      exit when v_n = 0;
    end loop;
  end loop;
end $$;
