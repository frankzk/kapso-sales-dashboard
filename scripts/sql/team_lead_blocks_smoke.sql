-- THROWAWAY DATABASE ONLY. No production configuration or business rows.
begin;
insert into auth.users(id,email) select ('cc029400-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'routing-'||n||'@test.invalid' from generate_series(10,14)n;
insert into organizations(id,name) values('cc029400-0000-0000-0000-000000000001','Routing test'),('cc029400-0000-0000-0000-000000000004','Other org');
insert into memberships(user_id,org_id,role) select ('cc029400-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'cc029400-0000-0000-0000-000000000001',case when n=10 then 'owner' else 'vendedora' end from generate_series(10,13)n;
insert into memberships values('cc029400-0000-0000-0000-000000000014','cc029400-0000-0000-0000-000000000004','owner',now());
insert into stores(id,org_id,name,shopify_domain) values
 ('cc029400-0000-0000-0000-000000000002','cc029400-0000-0000-0000-000000000001','Routing A','routing-a.test'),
 ('cc029400-0000-0000-0000-000000000003','cc029400-0000-0000-0000-000000000001','Routing B','routing-b.test');
insert into user_store_access(user_id,store_id) select m.user_id,s.id from memberships m cross join stores s where m.org_id='cc029400-0000-0000-0000-000000000001' and s.org_id=m.org_id;
-- Existing store setup tests re-apply column migrations in the same transaction.
alter table stores add column routing_smoke_tmp boolean;
alter table stores drop column routing_smoke_tmp;
set local role authenticated;
set local request.test_uid='cc029400-0000-0000-0000-000000000010';
update stores set org_id=org_id where id='cc029400-0000-0000-0000-000000000002';
reset role;
insert into leads(store_id,phone,name,status,category,first_seen_at,last_interaction_at,cart_item_count,district,inbound_count,call_attempt_count)
select 'cc029400-0000-0000-0000-000000000002','519994'||lpad(n::text,5,'0'),label,'nuevo','open',now()-age,now()-age,cart,district,inbound,attempts
from (values
 (1,'fresh-cart',interval '1 hour',1,null::text,0,0),
 (2,'fresh-interest',interval '1 hour',0,'Lima',0,0),
 (3,'fresh-cold',interval '1 hour',0,null::text,0,0),
 (4,'old-cart',interval '2 days',1,null::text,0,0),
 (5,'old-interest',interval '2 days',0,'Lima',0,0),
 (6,'old-cold',interval '2 days',0,null::text,0,0),
 (7,'old-conversation',interval '2 days',0,null::text,3,0),
 (8,'fresh-product',interval '1 hour',0,null::text,0,0),
 (9,'reactivated-cold',interval '100 days',0,null::text,0,1),
 (10,'retry-cold',interval '1 hour',0,null::text,0,1),
 (11,'retry-cart',interval '1 hour',1,null::text,0,1),
 (12,'own-held',interval '1 hour',1,null::text,0,0),
 (13,'own-appointment',interval '1 hour',1,null::text,0,1),
 (14,'real-new-cart',interval '100 days',1,null::text,0,1)
)f(n,label,age,cart,district,inbound,attempts);
update leads set first_inbound_text='https://kenku.pe/products/test-product' where name='fresh-product' and store_id='cc029400-0000-0000-0000-000000000002';
update leads set last_inbound_at=now()-interval '5 minutes' where name='reactivated-cold' and store_id='cc029400-0000-0000-0000-000000000002';
update leads set next_followup_at=now()+interval '1 hour' where name='own-appointment' and store_id='cc029400-0000-0000-0000-000000000002';
insert into lead_calls(lead_id,store_id,vendedora,kind,new_status,next_followup_at,occurred_at)
select id,store_id,'cc029400-0000-0000-0000-000000000012','call','volver_a_llamar',next_followup_at,now()-interval '10 minutes' from leads where store_id='cc029400-0000-0000-0000-000000000002' and name in ('reactivated-cold','retry-cold','retry-cart','own-appointment','real-new-cart');
update leads set claimed_by='cc029400-0000-0000-0000-000000000012',claimed_at=now() where name='own-held' and store_id='cc029400-0000-0000-0000-000000000002';
insert into draft_orders(store_id,shopify_draft_order_id,draft_order_gid,status,created_at) values('cc029400-0000-0000-0000-000000000002','294','gid://shopify/DraftOrder/294','open',now()-interval '1 minute');
update leads set draft_order_gid='gid://shopify/DraftOrder/294' where name='real-new-cart' and store_id='cc029400-0000-0000-0000-000000000002';
create temp table routing_before as select id,to_jsonb(l) as row from leads l where store_id='cc029400-0000-0000-0000-000000000002';
insert into leads(store_id,phone,name,status,category,first_seen_at)
select 'cc029400-0000-0000-0000-000000000003','519993'||lpad(n::text,5,'0'),'old-cold-'||n,'nuevo','open',now()-interval '2 days' from generate_series(1,1030)n;
create temp table routing_config as select '[
 {"userId":"cc029400-0000-0000-0000-000000000011","blocks":["carrito_reciente","interes_reciente","nuevo_sin_intencion","pendiente_con_interes"],"backup":false},
 {"userId":"cc029400-0000-0000-0000-000000000012","blocks":["recuperacion"],"backup":false},
 {"userId":"cc029400-0000-0000-0000-000000000013","blocks":[],"backup":false}]'::jsonb as config;
do $$
declare o uuid:='cc029400-0000-0000-0000-000000000001'; s uuid:='cc029400-0000-0000-0000-000000000002';
 owner_id uuid:='cc029400-0000-0000-0000-000000000010'; main_id uuid:='cc029400-0000-0000-0000-000000000011'; rec_id uuid:='cc029400-0000-0000-0000-000000000012'; backup_id uuid:='cc029400-0000-0000-0000-000000000013';
 r record; cfg jsonb; a jsonb; b jsonb; failed boolean;
begin
 select config into cfg from routing_config;
 if (lead_routing_scope(rec_id,array[s])->>'enabled')::boolean then raise exception 'installation activated routing'; end if;
 perform save_lead_routing(o,owner_id,0,true,24,cfg);
 for r in select * from leads where store_id=s loop
   a:=lead_routing_scope(main_id,array[s],r.id); b:=lead_routing_scope(rec_id,array[s],r.id);
   if r.name in ('old-cold','old-conversation','retry-cold','own-appointment') then
     if (a->>'allowed')::boolean or not (b->>'allowed')::boolean then raise exception 'wrong recovery/appointment classification: %',r.name; end if;
   else
     if not (a->>'allowed')::boolean then raise exception 'main lost interest/new lead: %',r.name; end if;
     if r.name<>'own-held' and (b->>'allowed')::boolean then raise exception 'recovery bypassed blocks: %',r.name; end if;
   end if;
 end loop;
 a:=lead_routing_scope(main_id,array[s]); b:=lead_routing_scope(rec_id,array[s]);
 if (a->'counts'->>'por_llamar')::int<>10 or (b->'counts'->>'por_llamar')::int<>5 then raise exception 'counts disagree with visible leads'; end if;
 if not (lead_routing_scope(owner_id,array[s])->>'allowed')::boolean then raise exception 'supervisor lost access'; end if;
 if jsonb_array_length(lead_routing_scope(main_id,array['cc029400-0000-0000-0000-000000000003'::uuid])->'blockedIds')<>1030 then raise exception 'routing truncated after 1000 rows'; end if;
 if (lead_routing_scope('cc029400-0000-0000-0000-000000000014',array[s])->>'allowed')::boolean then raise exception 'cross-org access'; end if;
 if exists(select 1 from routing_before old join leads l using(id) where old.row<>to_jsonb(l)) then raise exception 'settings changed customer/history data'; end if;
 -- Optimistic revision, authorization and all-or-nothing coverage.
 failed:=false; begin perform save_lead_routing(o,owner_id,0,true,24,cfg); exception when others then failed:=true; end;
 if not failed then raise exception 'stale configuration overwritten'; end if;
 failed:=false; begin perform save_lead_routing(o,rec_id,1,true,24,cfg); exception when others then failed:=true; end;
 if not failed then raise exception 'advisor changed own blocks'; end if;
 failed:=false; begin perform save_lead_routing(o,owner_id,1,true,24,'[]'); exception when others then failed:=true; end;
 if not failed or (select revision from lead_routing_settings where org_id=o)<>1 then raise exception 'uncovered config was not rolled back'; end if;
 -- Backup is opt-in, and only opens when there is no available assigned advisor.
 cfg:=jsonb_set(cfg,'{2,backup}','true'); perform save_lead_routing(o,owner_id,1,true,24,cfg);
 select id into r from leads where store_id=s and name='fresh-cart';
 if not (lead_routing_scope(backup_id,array[s],r.id)->>'allowed')::boolean then raise exception 'offline fallback missing'; end if;
 insert into user_presence(user_id,last_seen_at) values(main_id,now()) on conflict(user_id) do update set last_seen_at=excluded.last_seen_at;
 if (lead_routing_scope(backup_id,array[s],r.id)->>'allowed')::boolean then raise exception 'backup stole available principal'; end if;
 update leads set claimed_by=main_id,claimed_at=now() where store_id=s and name in ('fresh-interest','fresh-cold');
 if not (lead_routing_scope(backup_id,array[s],r.id)->>'allowed')::boolean then raise exception 'occupied principal blocked backup'; end if;
 failed:=false; begin perform claim_routed_lead(rec_id,r.id); exception when others then failed:=true; end;
 if not failed then raise exception 'claim bypassed the assigned blocks'; end if;
 if (select count(*) from claim_routed_lead(backup_id,r.id))<>1 then raise exception 'eligible backup cannot claim'; end if;
 failed:=false; begin perform claim_routed_lead(main_id,r.id); exception when others then failed:=true; end;
 if not failed then raise exception 'third simultaneous reservation accepted'; end if;
 -- A role/store removal may not orphan the remaining leads.
 failed:=false; begin
   delete from user_store_access where user_id=rec_id and store_id=s;
   set constraints all immediate;
 exception when others then failed:=true; end;
 if not failed then raise exception 'last recovery store access removed'; end if;
 if (select count(*) from lead_routing_audit where org_id=o)<>2 then raise exception 'settings audit missing/duplicated'; end if;
 if has_function_privilege('authenticated','public.save_lead_routing(uuid,uuid,integer,boolean,integer,jsonb)','execute')
 or has_function_privilege('anon','public.lead_routing_scope(uuid,uuid[],uuid)','execute')
 or has_function_privilege('authenticated','public.claim_routed_lead(uuid,uuid)','execute')
 or has_table_privilege('authenticated','public.lead_routing_assignments','update') then raise exception 'public configuration mutation'; end if;
end $$;
rollback;
