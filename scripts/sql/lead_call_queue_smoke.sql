-- THROWAWAY DATABASE ONLY, invoked by verify-db.sh. No business data touched.
begin;
insert into stores(id,org_id,name,shopify_domain) values
 ('cc028900-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','Call queue A','queue-a.test'),
 ('cc028900-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','Call queue B','queue-b.test');
insert into user_store_access(user_id,store_id) values
 ('00000000-0000-0000-0000-00000000000a','cc028900-0000-0000-0000-000000000001');

insert into leads(store_id,phone,name,status,category,cart_item_count,call_attempt_count,last_interaction_at,next_followup_at)
select 'cc028900-0000-0000-0000-000000000001', '5199989'||lpad(n::text,4,'0'),
  label,status,category,cart,attempts,now()-quiet,case when due is null then null else now()+due end
from (values
 (1,'nr','no_responde','open',1,1,interval '49 hours',null::interval),
 (2,'buzon','buzon','open',1,2,interval '49 hours',null::interval),
 (3,'due','casi_cierra','hot',0,0,interval '1 hour',interval '-1 minute'),
 (4,'due-no-cart','volver_a_llamar','open',0,1,interval '1 hour',interval '-1 minute'),
 (5,'new','nuevo','open',1,0,interval '1 hour',null::interval),
 (6,'no-cart','no_responde','open',0,1,interval '49 hours',null::interval),
 (7,'recent','no_responde','open',1,1,interval '47 hours',null::interval),
 (8,'future','no_responde','open',1,1,interval '49 hours',interval '1 hour'),
 (9,'stock','sin_stock','open',1,1,interval '49 hours',interval '-1 minute'),
 (10,'lost','cancelado_cliente','lost',1,1,interval '49 hours',interval '-1 minute'),
 (11,'won','pedido_generado','won',1,1,interval '49 hours',interval '-1 minute'),
 (12,'opt-out','no_responde','open',1,1,interval '49 hours',null::interval),
 (13,'order','no_responde','open',1,1,interval '49 hours',null::interval),
 (14,'held','no_responde','open',1,1,interval '49 hours',null::interval),
 (15,'three','no_responde','open',1,3,interval '49 hours',null::interval),
 (16,'no-call','no_responde','open',1,0,interval '49 hours',null::interval)
) f(n,label,status,category,cart,attempts,quiet,due);
-- These fixtures test 0289's guards with a recent real message (0291).
update leads set last_inbound_at=now()-interval '3 days'
 where store_id='cc028900-0000-0000-0000-000000000001';
update leads set contact_opt_out_at=now() where name='opt-out' and store_id='cc028900-0000-0000-0000-000000000001';
update leads set has_order=true where name='order' and store_id='cc028900-0000-0000-0000-000000000001';
update leads set claimed_by='00000000-0000-0000-0000-00000000000b',claimed_at=now()
 where name='held' and store_id='cc028900-0000-0000-0000-000000000001';
insert into leads(store_id,phone,name,status,cart_item_count,call_attempt_count,last_interaction_at)
 values ('cc028900-0000-0000-0000-000000000002','51999899999','other-store','no_responde',1,1,now()-interval '49 hours');

set local role service_role;
do $$
declare n integer; r record; l public.leads%rowtype; s uuid := 'cc028900-0000-0000-0000-000000000001';
begin
 n := public.requeue_leads_for_calls(s);
 if n <> 4 then raise exception 'expected 4 worthwhile returns, got %',n; end if;
 if exists(select 1 from leads where store_id=s and call_queue_ready and name not in ('nr','buzon','due','due-no-cart'))
 then raise exception 'ineligible lead was queued'; end if;
 if exists(select 1 from leads where name='other-store' and call_queue_ready) then raise exception 'cross-store write'; end if;
 if (select status from leads where store_id=s and name='nr') <> 'no_responde' then raise exception 'disposition erased'; end if;
 if (select count(*) from lead_calls where store_id=s and kind='system') <> 4 then raise exception 'audit missing'; end if;
 if public.requeue_leads_for_calls(s) <> 0 then raise exception 'repeated sweep duplicated a retry'; end if;
 select * into r from public.lead_queue_counts(s,now()-interval '24 hours',now());
 if r.sin_llamar <> 5 then raise exception 'queue counter is %, expected new + 4',r.sin_llamar; end if;
 select sum(x.n)::integer into n from public.lead_insights_rollup(array[s],now(),'America/Lima','2026-10-29') x;
 if n <> 5 then raise exception 'insights counter is %, expected 5',n; end if;

 select * into l from leads where store_id=s and name='nr';
 insert into lead_calls(lead_id,store_id,vendedora,kind,new_status,note)
 values(l.id,s,'00000000-0000-0000-0000-00000000000a','call','no_responde','Second call');
 select * into l from leads where id=l.id;
 if l.call_queue_ready or l.call_attempt_count <> 2 or l.last_interaction_at < now()-interval '1 minute'
 then raise exception 'recorded call did not consume retry or update the attempt clock'; end if;
 if public.requeue_leads_for_calls(s) <> 0 then raise exception 'recorded call immediately requeued'; end if;
 update leads set last_interaction_at=now()-interval '49 hours' where id=l.id;
 if public.requeue_leads_for_calls(s) <> 1 then raise exception 'third attempt was not offered'; end if;
 insert into lead_calls(lead_id,store_id,vendedora,kind,new_status,note)
 values(l.id,s,'00000000-0000-0000-0000-00000000000a','call','no_responde','Third call');
 update leads set last_interaction_at=now()-interval '49 hours' where id=l.id;
 if public.requeue_leads_for_calls(s) <> 0 then raise exception 'fourth automatic attempt offered'; end if;
 if (select count(*) from lead_calls where lead_id=l.id and kind='call') <> 2 then raise exception 'call history changed'; end if;

 select * into l from leads where store_id=s and name='due-no-cart';
 insert into lead_calls(lead_id,store_id,vendedora,kind,note) values(l.id,s,'00000000-0000-0000-0000-00000000000a','call','Followup completed');
 select * into l from leads where id=l.id;
 if l.next_followup_at is not null or l.call_queue_ready then raise exception 'expired appointment not consumed'; end if;
 insert into lead_calls(lead_id,store_id,kind,note) values(l.id,s,'system','note is not an attempt');
 if (select call_attempt_count from leads where id=l.id) <> 2 then raise exception 'system note counted as call'; end if;

 -- Postponement by a different writer (e.g. voice agent) invalidates readiness.
 select * into l from leads where store_id=s and name='due';
 update leads set next_followup_at=now()+interval '1 day' where id=l.id;
 if (select call_queue_ready from leads where id=l.id) then raise exception 'future appointment still queued'; end if;
 if public.requeue_leads_for_calls(s) <> 0 then raise exception 'future appointment requeued early'; end if;
 update leads set next_followup_at=now()-interval '1 minute' where id=l.id;
 if public.requeue_leads_for_calls(s) <> 1 then raise exception 'postponed appointment did not return when due'; end if;
 update leads set status='sin_stock' where id=l.id;
 if (select call_queue_ready from leads where id=l.id) then raise exception 'stock shortage kept ready flag'; end if;

 -- A first call scheduled without changing nuevo must wait for its date too.
 insert into leads(id,store_id,phone,status,next_followup_at,last_inbound_at)
 values('cc028900-0000-0000-0000-000000000088',s,'51999898888','nuevo',now()+interval '1 day',now()-interval '3 days');
 select * into l from leads where id='cc028900-0000-0000-0000-000000000088';
 if public.lead_in_call_queue(l.status,l.category,l.call_queue_ready,l.contact_opt_out_at,l.has_order,l.order_id,l.next_followup_at)
 then raise exception 'new lead with future appointment entered early'; end if;
 update leads set next_followup_at=now()-interval '1 minute' where id=l.id;
 if public.requeue_leads_for_calls(s) <> 1 then raise exception 'scheduled first attempt did not return'; end if;

 if has_function_privilege('authenticated','public.requeue_leads_for_calls(uuid,integer)','EXECUTE')
 or has_function_privilege('anon','public.requeue_leads_for_calls(uuid,integer)','EXECUTE')
 then raise exception 'retry mutation exposed'; end if;
end $$;

set local request.test_uid='00000000-0000-0000-0000-00000000000a';
set local role authenticated;
do $$ declare r record; begin
 select * into r from public.lead_queue_counts('cc028900-0000-0000-0000-000000000002',now(),now());
 if r.total <> 0 then raise exception 'queue counts bypass RLS'; end if;
end $$;
reset role;
rollback;
