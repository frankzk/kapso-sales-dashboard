-- Por llamar = new leads + worthwhile, due retries. Last disposition stays intact.
-- Installing this migration does NOT enqueue anyone. The existing sync calls
-- requeue_leads_for_calls after the application is deployed.
alter table public.leads add column if not exists call_queue_ready boolean not null default false;
alter table public.leads add column if not exists call_attempt_count integer not null default 0;

-- Historical calls count; notes, imports, automated waves and sales do not.
-- Do not reset this on subsequent migration applications.
update public.leads l set call_attempt_count = c.n
from (
  select lead_id, count(*)::integer as n from public.lead_calls
  where kind = 'call' and vendedora is not null group by lead_id
) c where l.id = c.lead_id and l.call_attempt_count < c.n;

create or replace function public.lead_record_call_attempt()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.kind = 'call' and new.vendedora is not null then
    update public.leads set
      call_attempt_count = call_attempt_count + 1,
      call_queue_ready = false,
      needs_attention = false,
      last_interaction_at = greatest(last_interaction_at, new.occurred_at),
      -- Consume the old appointment. A new date is written by the call action.
      next_followup_at = case when next_followup_at <= new.occurred_at then null else next_followup_at end
    where id = new.lead_id and store_id = new.store_id;
  end if;
  return new;
end $$;
revoke all on function public.lead_record_call_attempt() from public, anon, authenticated;
grant execute on function public.lead_record_call_attempt() to service_role;
drop trigger if exists lead_record_call_attempt on public.lead_calls;
create trigger lead_record_call_attempt after insert on public.lead_calls
for each row execute function public.lead_record_call_attempt();

-- Pure membership shared by rollups. Mirrors lib/lead-call-queue.ts.
create or replace function public.lead_in_call_queue(p_status text, p_category text, p_ready boolean, p_opt_out timestamptz, p_has_order boolean, p_order_id uuid)
returns boolean language sql immutable security invoker set search_path = public as $$
  select p_category in ('open','hot') and p_opt_out is null and (
    p_status = 'nuevo' or (p_ready and not p_has_order and p_order_id is null and p_status in (
      'no_responde','buzon','cuelga','casi_cierra','volver_a_llamar','contactado_dejo_wsp','otros_productos'
    ))
  )
$$;
revoke all on function public.lead_in_call_queue(text,text,boolean,timestamptz,boolean,uuid) from public, anon;
grant execute on function public.lead_in_call_queue(text,text,boolean,timestamptz,boolean,uuid) to authenticated, service_role;

create or replace function public.requeue_leads_for_calls(p_store_id uuid, p_limit integer default 500)
returns integer language plpgsql security invoker set search_path = public as $$
declare r public.leads%rowtype; v_n integer := 0; v_reason text;
begin
  for r in
    select l.* from public.leads l
    where l.store_id = p_store_id and l.category in ('open','hot')
      and l.status in ('no_responde','buzon','cuelga','casi_cierra','volver_a_llamar','contactado_dejo_wsp','otros_productos')
      and not l.call_queue_ready and l.call_attempt_count < 3
      and l.contact_opt_out_at is null and l.phone is not null
      and not l.has_order and l.order_id is null
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
    limit greatest(0, least(p_limit, 500))
    for update of l skip locked
  loop
    v_reason := case when r.next_followup_at is not null then 'Llegó la fecha de llamada'
      else 'Carrito sin contacto durante 48 h' end;
    update public.leads set call_queue_ready = true, needs_attention = true where id = r.id;
    insert into public.lead_calls(lead_id,store_id,kind,note)
      values (r.id,r.store_id,'system',v_reason || ' · vuelve a Por llamar · intento ' || (r.call_attempt_count+1)::text || ' de 3');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.requeue_leads_for_calls(uuid,integer) from public, anon, authenticated;
grant execute on function public.requeue_leads_for_calls(uuid,integer) to service_role;

create or replace function public.lead_queue_counts(p_store_id uuid,p_handoff_cutoff timestamptz,p_now timestamptz)
returns table(por_llamar bigint,handoff bigint,yape bigint,seguimientos bigint,ganados bigint,perdidos bigint,sin_llamar bigint,total bigint,last_change timestamptz)
language sql stable security invoker set search_path = public as $$
  select
    count(*) filter (where category in ('open','hot') and status <> 'yape_por_verificar'),
    count(*) filter (where needs_attention and handoff_at >= p_handoff_cutoff),
    count(*) filter (where status = 'yape_por_verificar'),
    count(*) filter (where next_followup_at is not null and next_followup_at <= p_now),
    count(*) filter (where category = 'won'), count(*) filter (where category = 'lost'),
    count(*) filter (where public.lead_in_call_queue(status,category,call_queue_ready,contact_opt_out_at,has_order,order_id)),
    count(*),max(updated_at)
  from public.leads where store_id = p_store_id
$$;
revoke all on function public.lead_queue_counts(uuid,timestamptz,timestamptz) from public, anon;
grant execute on function public.lead_queue_counts(uuid,timestamptz,timestamptz) to authenticated, service_role;

create or replace function public.lead_insights_rollup(p_store_ids uuid[],p_window_start timestamptz,p_tz text,p_today text)
returns table(bucket text,key text,n bigint)
language sql stable security invoker set search_path = public as $$
  select 'sin_llamar', to_char(coalesce(last_interaction_at,first_seen_at) at time zone p_tz,'YYYY-MM-DD'),count(*)
  from public.leads
  where store_id = any(p_store_ids)
    and public.lead_in_call_queue(status,category,call_queue_ready,contact_opt_out_at,has_order,order_id)
    and coalesce(last_interaction_at,first_seen_at) is not null group by 2
$$;
revoke all on function public.lead_insights_rollup(uuid[],timestamptz,text,text) from public, anon;
grant execute on function public.lead_insights_rollup(uuid[],timestamptz,text,text) to authenticated, service_role;
