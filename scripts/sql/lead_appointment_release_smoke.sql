-- THROWAWAY DATABASE ONLY. No production configuration or business rows.
-- 0322: an appointment («volver a llamar») reserves the lead to the advisor who
-- booked it only until 2 hours after the appointment time, or until the
-- customer writes again after it was booked (owner decision 08-11-2026, option
-- c). Once released the lead follows the normal block routing. The appointment
-- itself (lead_calls row, next_followup_at) is untouched, and against the 0312
-- body the only answers that change are those of released appointments.
begin;
insert into auth.users(id,email)
select ('cc032200-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'appt-release-'||n||'@test.invalid' from generate_series(10,13)n;
insert into organizations(id,name) values('cc032200-0000-0000-0000-000000000001','Appointment release');
insert into memberships(user_id,org_id,role)
select ('cc032200-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'cc032200-0000-0000-0000-000000000001',
  case when n=10 then 'owner' else 'vendedora' end
from generate_series(10,13)n;
insert into stores(id,org_id,name,shopify_domain) values
 ('cc032200-0000-0000-0000-000000000002','cc032200-0000-0000-0000-000000000001','Appt A','appt-release-a.test');
insert into user_store_access(user_id,store_id)
select m.user_id,'cc032200-0000-0000-0000-000000000002' from memberships m where m.org_id='cc032200-0000-0000-0000-000000000001';

-- Every lead is an old, cold retry (block «recuperacion») unless the customer
-- wrote after the last call, which makes it «nuevo_sin_intencion» again.
-- 11 = A (principal blocks, books every appointment), 12 = B (recuperacion),
-- 13 = C (principal blocks, like A).
create temp table appt_cases(name text primary key, followup interval, booked interval, inbound interval, handoff interval, expect text);
insert into appt_cases values
 ('future',               interval '1 hour',               interval '-10 minutes', null,                    null,                    'held'),
 ('grace',                interval '-1 hour',              interval '-5 hours',    null,                    null,                    'held'),
 ('grace-edge',           interval '-1 hour -59 minutes',  interval '-5 hours',    null,                    null,                    'held'),
 ('expired-edge',         interval '-2 hours',             interval '-5 hours',    null,                    null,                    'released'),
 ('expired',              interval '-3 hours',             interval '-5 hours',    null,                    null,                    'released'),
 -- A called again after the appointment time without a new date: the 0289
 -- trigger already consumes the expired appointment, so 0312 and 0322 agree.
 ('expired-called-after', interval '-3 hours',             interval '-5 hours',    null,                    null,                    'none'),
 ('old',                  interval '-10 days',             interval '-11 days',    null,                    null,                    'released'),
 ('came-back',            interval '5 hours',              interval '-10 minutes', interval '-1 minute',    null,                    'released-fresh'),
 ('wrote-before',         interval '5 hours',              interval '-10 minutes', interval '-1 hour',      null,                    'held'),
 ('wrote-in-future',      interval '5 hours',              interval '-10 minutes', interval '1 hour',       null,                    'held'),
 ('voice-handoff',        interval '5 hours',              interval '-10 minutes', null,                    interval '-1 minute',    'held'),
 ('no-appointment',       null,                            interval '-5 hours',    null,                    null,                    'none');
insert into leads(store_id,phone,name,status,category,first_seen_at,last_interaction_at,cart_item_count,district,inbound_count,call_attempt_count,
                  next_followup_at,last_inbound_at,handoff_at,needs_attention)
select 'cc032200-0000-0000-0000-000000000002','519983'||lpad(row_number() over (order by name)::text,5,'0'),name,'volver_a_llamar','open',
  now()-interval '2 days',now()-interval '2 days',0,null,0,1,
  now()+followup,now()+inbound,now()+handoff,handoff is not null
from appt_cases;
-- The call that booked each appointment, signed by A.
insert into lead_calls(lead_id,store_id,vendedora,kind,new_status,next_followup_at,occurred_at)
select l.id,l.store_id,'cc032200-0000-0000-0000-000000000011','call','volver_a_llamar',l.next_followup_at,now()+c.booked
from leads l join appt_cases c on c.name=l.name where l.store_id='cc032200-0000-0000-0000-000000000002';
-- A called again after the appointment time (no new date): no reservation.
insert into lead_calls(lead_id,store_id,vendedora,kind,new_status,next_followup_at,occurred_at)
select id,store_id,'cc032200-0000-0000-0000-000000000011','call','no_responde',null,now()-interval '1 hour'
from leads where store_id='cc032200-0000-0000-0000-000000000002' and name='expired-called-after';

do $$
begin
 perform save_lead_routing('cc032200-0000-0000-0000-000000000001','cc032200-0000-0000-0000-000000000010',0,true,24,'[
  {"userId":"cc032200-0000-0000-0000-000000000011","blocks":["carrito_reciente","interes_reciente","nuevo_sin_intencion","pendiente_con_interes"],"backup":false},
  {"userId":"cc032200-0000-0000-0000-000000000012","blocks":["recuperacion"],"backup":false},
  {"userId":"cc032200-0000-0000-0000-000000000013","blocks":["carrito_reciente","interes_reciente","nuevo_sin_intencion","pendiente_con_interes"],"backup":false}]'::jsonb);
end $$;

create temp table appt_before as
select l.id,l.next_followup_at,(select count(*) from lead_calls c where c.lead_id=l.id) calls
from leads l where l.store_id='cc032200-0000-0000-0000-000000000002';

-- Each advisor × (whole queue, each lead).
create temp table appt_runs as
select a.actor, l.id as lead, l.name, c.expect
from (values ('cc032200-0000-0000-0000-000000000011'::uuid),('cc032200-0000-0000-0000-000000000012'),('cc032200-0000-0000-0000-000000000013')) a(actor)
cross join leads l join appt_cases c on c.name=l.name
where l.store_id='cc032200-0000-0000-0000-000000000002';
create temp table appt_new as
select r.actor, r.lead,
  (lead_routing_scope(r.actor,array['cc032200-0000-0000-0000-000000000002'::uuid],r.lead)->>'allowed')::boolean as single,
  not ((lead_routing_scope(r.actor,array['cc032200-0000-0000-0000-000000000002'::uuid])->'blockedIds') ? r.lead::text) as queue
from appt_runs r;

do $$
declare r record; a_ok boolean; b_ok boolean; c_ok boolean;
 a uuid:='cc032200-0000-0000-0000-000000000011'; b uuid:='cc032200-0000-0000-0000-000000000012'; c uuid:='cc032200-0000-0000-0000-000000000013';
begin
 if exists(select 1 from appt_new where single<>queue) then
   raise exception 'single-lead and whole-queue scope disagree: %',(select string_agg(l.name||'/'||n.actor,', ') from appt_new n join leads l on l.id=n.lead where single<>queue);
 end if;
 for r in select distinct lead,name,expect from appt_runs loop
   select single into a_ok from appt_new where lead=r.lead and actor=a;
   select single into b_ok from appt_new where lead=r.lead and actor=b;
   select single into c_ok from appt_new where lead=r.lead and actor=c;
   if r.expect='held' and not (a_ok and not b_ok and not c_ok) then
     raise exception 'appointment % should stay reserved to its advisor (A %, B %, C %)',r.name,a_ok,b_ok,c_ok;
   elsif r.expect in ('released','none') and not (not a_ok and b_ok and not c_ok) then
     raise exception 'lead % should follow normal routing to recuperacion (A %, B %, C %)',r.name,a_ok,b_ok,c_ok;
   elsif r.expect='released-fresh' and not (a_ok and not b_ok and c_ok) then
     raise exception 'customer came back on %: normal routing to the fresh block (A %, B %, C %)',r.name,a_ok,b_ok,c_ok;
   end if;
 end loop;

 -- Once released anyone eligible can take it; a live reservation stays closed.
 if not exists(select 1 from claim_routed_lead(c,(select id from leads where name='came-back' and store_id='cc032200-0000-0000-0000-000000000002'))) then
   raise exception 'released appointment could not be claimed by another eligible advisor';
 end if;
 begin
   perform claim_routed_lead(c,(select id from leads where name='future' and store_id='cc032200-0000-0000-0000-000000000002'));
   raise exception 'reserved appointment was claimed by another advisor';
 exception when others then
   if sqlerrm not like '%no pertenece a tus bloques%' then raise; end if;
 end;
 -- Undo the claim so the 0312 comparison below sees the same rows.
 update leads set claimed_by=null,claimed_at=null where store_id='cc032200-0000-0000-0000-000000000002';
end $$;

-- The appointment stays as history: same date, same calls.
do $$
begin
 if exists(select 1 from appt_before b join leads l on l.id=b.id
           where l.next_followup_at is distinct from b.next_followup_at
              or (select count(*) from lead_calls c where c.lead_id=l.id)<>b.calls) then
   raise exception 'releasing a reservation changed the appointment';
 end if;
end $$;

-- Against the 0312 body (inside this transaction only): every advisor's answer
-- is the same except for released appointments, and each of those changes.
\ir ../../db/migrations/0312_lead_routing_scope_perf.sql
create temp table appt_old as
select r.actor, r.lead,
  (lead_routing_scope(r.actor,array['cc032200-0000-0000-0000-000000000002'::uuid],r.lead)->>'allowed')::boolean as single
from appt_runs r;
do $$
declare d text;
begin
 select string_agg(distinct r.name,', ') into d from appt_old o join appt_new w using(actor,lead) join appt_runs r using(actor,lead)
  where r.expect not like 'released%' and o.single is distinct from w.single;
 if d is not null then raise exception '0322 changed answers that are not released appointments: %',d; end if;
 select string_agg(x.name,', ') into d from (select distinct lead,name from appt_runs where expect like 'released%') x
  where not exists(select 1 from appt_old o join appt_new w using(actor,lead) where o.lead=x.lead and o.single is distinct from w.single);
 if d is not null then raise exception 'released appointments still answer like 0312: %',d; end if;
end $$;
rollback;
