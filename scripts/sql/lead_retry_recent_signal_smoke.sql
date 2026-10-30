-- THROWAWAY DATABASE ONLY. Reproduces the July carts that flooded Por llamar.
begin;
insert into stores(id,org_id,name,shopify_domain) values
 ('cc029100-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','Fresh retries A','fresh-a.test'),
 ('cc029100-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','Fresh retries B','fresh-b.test');
insert into draft_orders(store_id,shopify_draft_order_id,draft_order_gid,status,created_at,updated_at) values
 ('cc029100-0000-0000-0000-000000000001','29101','gid://shopify/DraftOrder/29101','open',now()-interval '3 days',now()),
 ('cc029100-0000-0000-0000-000000000001','29102','gid://shopify/DraftOrder/29102','open',now()-interval '100 days',now()),
 ('cc029100-0000-0000-0000-000000000001','29103','gid://shopify/DraftOrder/29103','open',now()-interval '7 days',now()),
 ('cc029100-0000-0000-0000-000000000001','29104','gid://shopify/DraftOrder/29104','open',now()-interval '7 days 1 second',now()),
 ('cc029100-0000-0000-0000-000000000002','29199','gid://shopify/DraftOrder/29199','open',now()-interval '1 day',now());

insert into leads(store_id,phone,name,status,category,cart_item_count,call_attempt_count,first_seen_at,last_interaction_at,draft_order_gid,next_followup_at)
select 'cc029100-0000-0000-0000-000000000001','5199979'||lpad(n::text,4,'0'),label,status,'open',1,
 case when label in ('no-human-call','new-only') then 0 when label='three-calls' then 3 else 1 end,
 now()-interval '120 days',now()-interval '3 days',case when cart is null then null else 'gid://shopify/DraftOrder/'||cart end,
 case when days is null then null else now()-make_interval(days=>days) end
from (values
 (1,'old-cart','no_responde','29102',null::integer),
 (2,'recent-cart','no_responde','29101',null::integer),
 (3,'recent-message','no_responde','29102',null::integer),
 (4,'updated-old-cart','no_responde','29102',null::integer),
 (5,'unknown-date','no_responde',null::text,null::integer),
 (6,'old-appointment','contactado_dejo_wsp','29102',90),
 (7,'recent-appointment','volver_a_llamar','29102',1),
 (8,'failed-call','no_responde','29102',null::integer),
 (9,'wrong-appointment','volver_a_llamar','29102',90),
 (10,'voice-appointment','volver_a_llamar','29102',1),
 (11,'voice-not-applied','volver_a_llamar','29102',1),
 (12,'system-note','no_responde','29102',1),
 (13,'locked-stale','no_responde','29102',null::integer),
 (14,'future-signal','no_responde','29102',null::integer),
 (15,'recent-ready','no_responde','29101',null::integer),
 (16,'other-store-cart','no_responde','29199',null::integer),
 (17,'boundary','no_responde','29103',null::integer),
 (18,'three-calls','no_responde','29101',null::integer),
 (19,'new-lead-old-cart','no_responde','29102',null::integer),
 (20,'no-human-call','no_responde','29101',null::integer),
 (21,'new-only','nuevo','29102',null::integer),
 (22,'outside-window','no_responde','29104',null::integer)
) f(n,label,status,cart,days);
update leads set last_inbound_at=now()-interval '3 days' where name='recent-message' and store_id='cc029100-0000-0000-0000-000000000001';
update leads set last_inbound_at=now()+interval '1 day' where name='future-signal' and store_id='cc029100-0000-0000-0000-000000000001';
update leads set first_seen_at=now()-interval '1 day' where name='new-lead-old-cart' and store_id='cc029100-0000-0000-0000-000000000001';
insert into lead_calls(lead_id,store_id,vendedora,kind,new_status,next_followup_at,occurred_at,note)
select id,store_id,case when name in ('old-appointment','recent-appointment','failed-call','wrong-appointment') then '00000000-0000-0000-0000-00000000000a'::uuid else null end,
 case when name like 'voice-%' then 'voice_agent' when name='system-note' then 'system' else 'call' end,
 case when name='voice-not-applied' then null when name='failed-call' then 'no_responde' else 'volver_a_llamar' end,
 case when name='failed-call' then null when name='wrong-appointment' then now()+interval '1 day' else next_followup_at end,
 case when name='old-appointment' then now()-interval '100 days' else now()-interval '3 days' end,
 'Existing history preserved'
from leads where store_id='cc029100-0000-0000-0000-000000000001'
 and name in ('old-appointment','recent-appointment','failed-call','wrong-appointment','voice-appointment','voice-not-applied','system-note');
update leads set next_followup_at=now()-interval '90 days' where name='wrong-appointment' and store_id='cc029100-0000-0000-0000-000000000001';
update leads set call_queue_ready=true,needs_attention=true
 where store_id='cc029100-0000-0000-0000-000000000001' and name in ('old-cart','unknown-date','old-appointment','locked-stale','recent-ready');
update leads set claimed_by='00000000-0000-0000-0000-00000000000a',claimed_at=now()
 where name='locked-stale' and store_id='cc029100-0000-0000-0000-000000000001';
create temp table retry_before as select id,status,call_attempt_count,last_interaction_at,next_followup_at,needs_attention,claimed_by,claimed_at
 from leads where store_id='cc029100-0000-0000-0000-000000000001';
create temp table retry_calls_before as select c.* from lead_calls c where c.store_id='cc029100-0000-0000-0000-000000000001';

-- Prove the installation itself repairs the overly broad activation.
\ir ../../db/migrations/0291_lead_retry_recent_signal.sql

do $$
declare s uuid:='cc029100-0000-0000-0000-000000000001'; l public.leads%rowtype;
begin
 if exists(select 1 from leads where store_id=s and call_queue_ready and name in ('old-cart','unknown-date','old-appointment'))
 then raise exception 'stale retries survived repair'; end if;
 if not exists(select 1 from leads where store_id=s and name='recent-ready' and call_queue_ready)
 then raise exception 'recent cart was withdrawn'; end if;
 if not exists(select 1 from leads where store_id=s and name='locked-stale' and call_queue_ready and claimed_by is not null)
 then raise exception 'active advisor was interrupted'; end if;
 if (select count(*) from lead_calls where store_id=s and note like 'Retirado de Por llamar:%') <> 3
 then raise exception 'missing retirement audit'; end if;
 if exists(select * from retry_before except select id,status,call_attempt_count,last_interaction_at,next_followup_at,needs_attention,claimed_by,claimed_at from leads where store_id=s)
 then raise exception 'retirement changed disposition, attempts, dates, attention or ownership'; end if;
 if exists(select * from retry_calls_before except select c.* from lead_calls c where c.store_id=s)
 then raise exception 'existing history changed'; end if;

 select * into l from leads where store_id=s and name='boundary';
 if public.lead_retry_signal_at(l) is distinct from now()-interval '7 days' then raise exception 'seven-day boundary lost'; end if;
 select * into l from leads where store_id=s and name='updated-old-cart';
 if public.lead_retry_signal_at(l) >= now()-interval '7 days' then raise exception 'mirror update treated as new intent'; end if;
 select * into l from leads where store_id=s and name='other-store-cart';
 if public.lead_retry_signal_at(l) is not null then raise exception 'cross-store cart used'; end if;
 select * into l from leads where store_id=s and name='new-lead-old-cart';
 if public.lead_retry_signal_at(l) >= now()-interval '7 days' then raise exception 'lead creation treated as new intent'; end if;

 if has_function_privilege('authenticated','public.retire_stale_lead_retries(uuid,integer)','execute')
 or has_function_privilege('anon','public.retire_stale_lead_retries(uuid,integer)','execute')
 or has_function_privilege('authenticated','public.lead_retry_signal_at(public.leads,timestamptz)','execute')
 then raise exception 'internal mutation or data helper exposed'; end if;
end $$;

set local role service_role;
do $$
declare s uuid:='cc029100-0000-0000-0000-000000000001'; n integer;
begin
 n:=public.requeue_leads_for_calls(s);
 if n<>5 then raise exception 'expected five fresh candidates, got %',n; end if;
 if exists(select 1 from leads where store_id=s and call_queue_ready and name not in
   ('recent-cart','recent-message','recent-appointment','voice-appointment','boundary','recent-ready','locked-stale'))
 then raise exception 'non-recent or ineligible lead entered'; end if;
 if exists(select 1 from leads where store_id=s and name in
   ('recent-cart','recent-message','recent-appointment','voice-appointment','boundary') and not call_queue_ready)
 then raise exception 'fresh customer or callback was missed'; end if;
 if public.requeue_leads_for_calls(s)<>0 then raise exception 'repeat sweep duplicated reentry'; end if;

 -- The protected lease is eventually cleaned up without releasing its owner.
 update leads set claimed_at=now()-interval '11 minutes' where store_id=s and name='locked-stale';
 if public.retire_stale_lead_retries(s)<>1 then raise exception 'expired stale lease was not cleaned'; end if;
 if not exists(select 1 from leads where store_id=s and name='locked-stale' and claimed_by is not null and not call_queue_ready)
 then raise exception 'retirement released the advisor'; end if;
 -- A pending retry that loses its signal is withdrawn on the next sync.
 update leads set draft_order_gid='gid://shopify/DraftOrder/29102' where store_id=s and name='recent-ready';
 if public.retire_stale_lead_retries(s)<>1 then raise exception 'outdated queued lead was not retired'; end if;
 if public.requeue_leads_for_calls(s)<>0 then raise exception 'retirement/system note rejuvenated stale intent'; end if;
 if not exists(select 1 from leads where store_id=s and name='new-only' and status='nuevo' and not call_queue_ready)
 then raise exception 'never-called new lead changed'; end if;
end $$;
reset role;
create temp table retry_audit_after as select count(*) as n from lead_calls where store_id='cc029100-0000-0000-0000-000000000001';
\ir ../../db/migrations/0291_lead_retry_recent_signal.sql
do $$ begin
 if (select count(*) from lead_calls where store_id='cc029100-0000-0000-0000-000000000001')<>(select n from retry_audit_after)
 then raise exception 'reapplying migration duplicated retirement audit'; end if;
end $$;
rollback;
