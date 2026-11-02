-- THROWAWAY DATABASE ONLY. Admin permissions must not bypass advisor blocks.
begin;
insert into auth.users(id,email)
select ('cc029900-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'routing-admin-'||n||'@test.invalid'
from generate_series(10,17)n;
insert into organizations(id,name) values('cc029900-0000-0000-0000-000000000001','Admin advisor routing');
insert into memberships(user_id,org_id,role)
select ('cc029900-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'cc029900-0000-0000-0000-000000000001',
  case when n=10 then 'owner' when n in (12,17) then 'vendedora' else 'admin' end
from generate_series(10,17)n;
insert into membership_roles(org_id,user_id,role)
select 'cc029900-0000-0000-0000-000000000001',('cc029900-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'asesora'
from unnest(array[11,13,15,16])n;
insert into membership_roles(org_id,user_id,role) values
 ('cc029900-0000-0000-0000-000000000001','cc029900-0000-0000-0000-000000000013','supervision'),
 ('cc029900-0000-0000-0000-000000000001','cc029900-0000-0000-0000-000000000016','administracion');
insert into stores(id,org_id,name,shopify_domain)
values('cc029900-0000-0000-0000-000000000002','cc029900-0000-0000-0000-000000000001','Admin routing store','admin-routing.test');
insert into user_store_access(user_id,store_id)
select user_id,'cc029900-0000-0000-0000-000000000002' from memberships where org_id='cc029900-0000-0000-0000-000000000001';
insert into leads(store_id,phone,name,status,category,first_seen_at,last_interaction_at,cart_item_count,call_attempt_count)
select 'cc029900-0000-0000-0000-000000000002','519992'||lpad(n::text,5,'0'),label,'nuevo','open',now()-age,now()-age,cart,attempts
from (values
 (1,'admin-fresh-cold',interval '1 hour',0,0),
 (2,'admin-old-cold',interval '2 days',0,0),
 (3,'admin-retry-cold',interval '1 hour',0,1),
 (4,'admin-fresh-cart',interval '1 hour',1,0),
 (5,'admin-own-held-cold',interval '2 days',0,0),
 (6,'admin-own-callback-cold',interval '2 days',0,1)
)f(n,label,age,cart,attempts);
update leads set claimed_by='cc029900-0000-0000-0000-000000000011',claimed_at=now()
where store_id='cc029900-0000-0000-0000-000000000002' and name='admin-own-held-cold';
update leads set next_followup_at=now()+interval '1 hour'
where store_id='cc029900-0000-0000-0000-000000000002' and name='admin-own-callback-cold';
insert into lead_calls(lead_id,store_id,vendedora,kind,new_status,next_followup_at,occurred_at)
select id,store_id,'cc029900-0000-0000-0000-000000000011','call','volver_a_llamar',next_followup_at,now()-interval '10 minutes'
from leads where store_id='cc029900-0000-0000-0000-000000000002' and name in ('admin-own-callback-cold','admin-retry-cold');
create temp table admin_routing_leads_before as
select id,to_jsonb(l) as row from leads l where store_id='cc029900-0000-0000-0000-000000000002';
create temp table admin_routing_members_before as
select user_id,to_jsonb(m) as row from memberships m where org_id='cc029900-0000-0000-0000-000000000001';
create temp table admin_routing_config as select '[
 {"userId":"cc029900-0000-0000-0000-000000000011","blocks":["carrito_reciente","interes_reciente","nuevo_sin_intencion","pendiente_con_interes"],"backup":false},
 {"userId":"cc029900-0000-0000-0000-000000000012","blocks":["recuperacion"],"backup":false},
 {"userId":"cc029900-0000-0000-0000-000000000013","blocks":["carrito_reciente"],"backup":false},
 {"userId":"cc029900-0000-0000-0000-000000000015","blocks":[],"backup":false},
 {"userId":"cc029900-0000-0000-0000-000000000016","blocks":["carrito_reciente"],"backup":false},
 {"userId":"cc029900-0000-0000-0000-000000000017","blocks":[],"backup":false}]'::jsonb as config;
do $$
declare
 o uuid:='cc029900-0000-0000-0000-000000000001';
 s uuid:='cc029900-0000-0000-0000-000000000002';
 owner_id uuid:='cc029900-0000-0000-0000-000000000010';
 main_id uuid:='cc029900-0000-0000-0000-000000000011';
 rec_id uuid:='cc029900-0000-0000-0000-000000000012';
 actor uuid; old_cold uuid; r record; a jsonb; b jsonb; failed boolean; cfg jsonb;
begin
 select config into cfg from admin_routing_config;
 if (lead_routing_scope(main_id,array[s])->>'enabled')::boolean then raise exception 'migration activated routing'; end if;
 perform save_lead_routing(o,owner_id,0,true,24,cfg);
 for r in select * from leads where store_id=s loop
   a:=lead_routing_scope(main_id,array[s],r.id);
   b:=lead_routing_scope(rec_id,array[s],r.id);
   if not (a->>'enabled')::boolean then raise exception 'admin advisor bypasses routing'; end if;
   if r.name in ('admin-old-cold','admin-retry-cold') then
     if (a->>'allowed')::boolean or not (b->>'allowed')::boolean then raise exception 'admin leaked recovery: %',r.name; end if;
   elsif not (a->>'allowed')::boolean then
     raise exception 'admin lost priority or own reservation/callback: %',r.name;
   end if;
 end loop;
 a:=lead_routing_scope(main_id,array[s]);
 if (a->'counts'->>'por_llamar')::int<>4 or jsonb_array_length(a->'blockedIds')<>2 then raise exception 'admin counters do not match filtered list'; end if;
 select id into old_cold from leads where store_id=s and name='admin-old-cold';
 -- Owner, functional oversight, and non-sales administrators retain oversight.
 foreach actor in array array[owner_id,'cc029900-0000-0000-0000-000000000013'::uuid,'cc029900-0000-0000-0000-000000000014'::uuid,'cc029900-0000-0000-0000-000000000016'::uuid] loop
   a:=lead_routing_scope(actor,array[s],old_cold);
   if (a->>'enabled')::boolean or not (a->>'allowed')::boolean then raise exception 'oversight was restricted: %',actor; end if;
 end loop;
 -- Empty assignments never grant sales admins the whole queue.
 foreach actor in array array['cc029900-0000-0000-0000-000000000015'::uuid,'cc029900-0000-0000-0000-000000000017'::uuid] loop
   a:=lead_routing_scope(actor,array[s]);
   if not (a->>'enabled')::boolean or (a->'counts'->>'por_llamar')::int<>0 then raise exception 'unassigned advisor sees queue: %',actor; end if;
 end loop;
 failed:=false; begin perform claim_routed_lead(main_id,old_cold); exception when others then failed:=true; end;
 if not failed then raise exception 'admin can claim outside assigned blocks'; end if;
 if exists(select 1 from admin_routing_leads_before old join leads l using(id) where old.row<>to_jsonb(l))
 or exists(select 1 from admin_routing_members_before old join memberships m using(user_id) where old.row<>to_jsonb(m)) then
   raise exception 'routing changed leads or admin permissions';
 end if;
 perform save_lead_routing(o,owner_id,1,false,24,cfg);
 a:=lead_routing_scope(main_id,array[s],old_cold);
 if (a->>'enabled')::boolean or not (a->>'allowed')::boolean then raise exception 'deactivation did not restore prior scope'; end if;
 if (select count(*) from lead_routing_audit where org_id=o)<>2 then raise exception 'activation/deactivation audit missing'; end if;
 if has_function_privilege('anon','public.lead_routing_scope(uuid,uuid[],uuid)','execute')
 or has_function_privilege('authenticated','public.lead_routing_scope(uuid,uuid[],uuid)','execute')
 or (select prosecdef from pg_proc where oid='public.lead_routing_scope(uuid,uuid[],uuid)'::regprocedure) then
   raise exception 'scope function privileges changed';
 end if;
end $$;
rollback;
