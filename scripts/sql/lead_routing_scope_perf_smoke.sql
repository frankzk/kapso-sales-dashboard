-- THROWAWAY DATABASE ONLY. No production configuration or business rows.
-- 0312 changes HOW lead_routing_scope finds its rows, never WHAT it returns:
-- every (actor, stores, lead) answer must equal the 0299 body's, the new
-- indexes must exist with the shape the queries use, and the function keeps
-- the 0299 privileges, volatility and search_path.
begin;
insert into auth.users(id,email)
select ('cc031200-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'routing-perf-'||n||'@test.invalid' from generate_series(10,16)n;
insert into organizations(id,name) values
 ('cc031200-0000-0000-0000-000000000001','Routing perf'),
 ('cc031200-0000-0000-0000-000000000004','Routing perf other');
insert into memberships(user_id,org_id,role)
select ('cc031200-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'cc031200-0000-0000-0000-000000000001',
  case when n=10 then 'owner' when n=14 then 'admin' when n=15 then 'viewer' else 'vendedora' end
from generate_series(10,15)n;
insert into memberships(user_id,org_id,role) values('cc031200-0000-0000-0000-000000000016','cc031200-0000-0000-0000-000000000004','owner');
insert into membership_roles(org_id,user_id,role) values('cc031200-0000-0000-0000-000000000001','cc031200-0000-0000-0000-000000000014','asesora');
insert into stores(id,org_id,name,shopify_domain) values
 ('cc031200-0000-0000-0000-000000000002','cc031200-0000-0000-0000-000000000001','Perf A','routing-perf-a.test'),
 ('cc031200-0000-0000-0000-000000000003','cc031200-0000-0000-0000-000000000001','Perf B','routing-perf-b.test');
insert into user_store_access(user_id,store_id)
select m.user_id,s.id from memberships m cross join stores s
 where m.org_id='cc031200-0000-0000-0000-000000000001' and s.org_id=m.org_id and m.role<>'viewer';
insert into user_store_access(user_id,store_id) values('cc031200-0000-0000-0000-000000000015','cc031200-0000-0000-0000-000000000002');

insert into leads(store_id,phone,name,status,category,first_seen_at,last_interaction_at,cart_item_count,district,inbound_count,call_attempt_count)
select st,'519981'||lpad(n::text,5,'0'),label,status,category,now()-age,now()-age,cart,district,0,attempts
from (values
 ('cc031200-0000-0000-0000-000000000002'::uuid,1,'fresh-cart','nuevo','open',interval '1 hour',1,null::text,0),
 ('cc031200-0000-0000-0000-000000000002',2,'fresh-interest','nuevo','open',interval '1 hour',0,'Lima',0),
 ('cc031200-0000-0000-0000-000000000002',3,'fresh-cold','nuevo','hot',interval '1 hour',0,null,0),
 ('cc031200-0000-0000-0000-000000000002',4,'old-cart','nuevo','open',interval '2 days',1,null,0),
 ('cc031200-0000-0000-0000-000000000002',5,'old-cold','nuevo','open',interval '2 days',0,null,0),
 ('cc031200-0000-0000-0000-000000000002',6,'retry-cold','nuevo','open',interval '1 hour',0,null,1),
 ('cc031200-0000-0000-0000-000000000002',7,'own-appointment','nuevo','open',interval '1 hour',1,null,1),
 ('cc031200-0000-0000-0000-000000000002',8,'held-by-main','nuevo','open',interval '2 days',0,null,0),
 ('cc031200-0000-0000-0000-000000000002',9,'real-new-cart','nuevo','open',interval '100 days',1,null,1),
 ('cc031200-0000-0000-0000-000000000002',10,'yape','yape_por_verificar','hot',interval '3 days',0,null,0),
 ('cc031200-0000-0000-0000-000000000002',11,'won','nuevo','won',interval '3 days',0,null,0),
 ('cc031200-0000-0000-0000-000000000002',12,'lost','nuevo','lost',interval '3 days',0,null,0),
 ('cc031200-0000-0000-0000-000000000003',13,'b-fresh-cold','nuevo','open',interval '1 hour',0,null,0),
 ('cc031200-0000-0000-0000-000000000003',14,'b-old-cold','nuevo','open',interval '2 days',0,null,0),
 ('cc031200-0000-0000-0000-000000000003',15,'b-won','nuevo','won',interval '2 days',0,null,0)
)f(st,n,label,status,category,age,cart,district,attempts);
update leads set next_followup_at=now()+interval '1 hour' where name='own-appointment' and store_id='cc031200-0000-0000-0000-000000000002';
update leads set needs_attention=true,handoff_at=now()-interval '1 hour' where name='fresh-cold' and store_id='cc031200-0000-0000-0000-000000000002';
update leads set claimed_by='cc031200-0000-0000-0000-000000000011',claimed_at=now() where name='held-by-main' and store_id='cc031200-0000-0000-0000-000000000002';
-- Calls the routing reads (asesora + kind call) and rows it must ignore (a
-- note, a call without asesora): the partial index leaves these out.
insert into lead_calls(lead_id,store_id,vendedora,kind,new_status,next_followup_at,occurred_at)
select id,store_id,'cc031200-0000-0000-0000-000000000012','call','volver_a_llamar',next_followup_at,now()-interval '10 minutes'
from leads where store_id='cc031200-0000-0000-0000-000000000002' and name in ('retry-cold','own-appointment','real-new-cart');
insert into lead_calls(lead_id,store_id,vendedora,kind,new_status,next_followup_at,occurred_at)
select id,store_id,'cc031200-0000-0000-0000-000000000011','note',null,null,now()-interval '1 minute'
from leads where store_id='cc031200-0000-0000-0000-000000000002' and name in ('fresh-cold','old-cold');
insert into lead_calls(lead_id,store_id,vendedora,kind,new_status,next_followup_at,occurred_at)
select id,store_id,null,'call','volver_a_llamar',null,now()-interval '1 minute'
from leads where store_id='cc031200-0000-0000-0000-000000000002' and name='fresh-interest';
insert into draft_orders(store_id,shopify_draft_order_id,draft_order_gid,status,created_at) values
 ('cc031200-0000-0000-0000-000000000002','31201','gid://shopify/DraftOrder/31201','open',now()-interval '1 minute'),
 ('cc031200-0000-0000-0000-000000000002','31202','gid://shopify/DraftOrder/31202','open',now()-interval '3 days');
update leads set draft_order_gid='gid://shopify/DraftOrder/31201' where name='real-new-cart' and store_id='cc031200-0000-0000-0000-000000000002';
update leads set draft_order_gid='gid://shopify/DraftOrder/31202' where name='old-cart' and store_id='cc031200-0000-0000-0000-000000000002';
insert into user_presence(user_id,last_seen_at) values('cc031200-0000-0000-0000-000000000012',now())
 on conflict(user_id) do update set last_seen_at=excluded.last_seen_at;

do $$
declare o uuid:='cc031200-0000-0000-0000-000000000001'; owner_id uuid:='cc031200-0000-0000-0000-000000000010';
begin
 perform save_lead_routing(o,owner_id,0,true,24,'[
  {"userId":"cc031200-0000-0000-0000-000000000011","blocks":["carrito_reciente","interes_reciente","nuevo_sin_intencion","pendiente_con_interes"],"backup":false},
  {"userId":"cc031200-0000-0000-0000-000000000012","blocks":["recuperacion"],"backup":false},
  {"userId":"cc031200-0000-0000-0000-000000000013","blocks":[],"backup":true},
  {"userId":"cc031200-0000-0000-0000-000000000014","blocks":["carrito_reciente"],"backup":false}]'::jsonb);
end $$;

-- Every actor × store set × (whole queue, each lead, an unknown id).
create temp table perf_cases as
select row_number() over () as case_id, a.actor, s.stores, l.lead
from (select ('cc031200-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid actor from generate_series(10,16)n) a
cross join (values
  (array['cc031200-0000-0000-0000-000000000002']::uuid[]),
  (array['cc031200-0000-0000-0000-000000000003']::uuid[]),
  (array['cc031200-0000-0000-0000-000000000002','cc031200-0000-0000-0000-000000000003']::uuid[])) s(stores)
cross join (
  select null::uuid lead
  union all select id from leads where store_id in ('cc031200-0000-0000-0000-000000000002','cc031200-0000-0000-0000-000000000003')
  union all select 'cc031200-0000-0000-0000-0000000000ff'::uuid) l;
create temp table perf_new as select case_id, lead_routing_scope(actor,stores,lead) j from perf_cases;

do $$
declare n int; d text;
begin
 -- The routing really is on, and blocks something, so the comparison bites.
 if not exists(select 1 from perf_new where (j->>'enabled')::boolean and jsonb_array_length(j->'blockedIds')>0) then
   raise exception 'seed does not exercise blocked leads';
 end if;
 -- A single-lead answer blocks the lead exactly when the whole-queue answer
 -- does: the Yape rotation and the alert pop-up rely on it (0312 code side).
 select count(*) into n
   from perf_cases c join perf_new s using(case_id)
   join perf_cases fc on fc.actor=c.actor and fc.stores=c.stores and fc.lead is null
   join perf_new f on f.case_id=fc.case_id
  where c.lead is not null and ((s.j->'blockedIds') ? c.lead::text) <> ((f.j->'blockedIds') ? c.lead::text);
 if n>0 then raise exception 'single-lead and whole-queue scope disagree in % cases',n; end if;

 -- Indexes, with the shape the function and return_manifest_expected read.
 select string_agg(i.relname,',') into d from pg_index x join pg_class i on i.oid=x.indexrelid
  where i.relname in ('lead_calls_call_lead_idx','draft_orders_store_gid_idx','delivery_stops_shipment_manifest_idx') and x.indisvalid;
 if coalesce(d,'') !~ 'lead_calls_call_lead_idx' or d !~ 'draft_orders_store_gid_idx' or d !~ 'delivery_stops_shipment_manifest_idx' then
   raise exception 'missing 0312 index: %',d;
 end if;
 if pg_get_indexdef('public.lead_calls_call_lead_idx'::regclass) !~ 'WHERE \(\(kind = ''call''::text\) AND \(vendedora IS NOT NULL\)\)' then
   raise exception 'lead_calls index predicate changed: %',pg_get_indexdef('public.lead_calls_call_lead_idx'::regclass);
 end if;

 -- Same contract as 0299.
 if has_function_privilege('anon','public.lead_routing_scope(uuid,uuid[],uuid)','execute')
 or has_function_privilege('authenticated','public.lead_routing_scope(uuid,uuid[],uuid)','execute')
 or not has_function_privilege('service_role','public.lead_routing_scope(uuid,uuid[],uuid)','execute')
 or exists(select 1 from pg_proc where oid='public.lead_routing_scope(uuid,uuid[],uuid)'::regprocedure
            and (prosecdef or provolatile<>'s' or proconfig is distinct from array['search_path=public, pg_temp'])) then
   raise exception 'scope function contract changed';
 end if;
end $$;

-- The last stop of a package in its box goes through the new index.
set local enable_seqscan=off;
set local enable_bitmapscan=off;
do $$
declare line text; hit boolean:=false;
begin
 for line in execute $q$explain select ds.id, ds.status, ds.outcome_reason from delivery_stops ds
   where ds.shipment_id='cc031200-0000-0000-0000-0000000000aa' and ds.dispatch_manifest_id='cc031200-0000-0000-0000-0000000000bb'
   order by ds.reported_at desc nulls last limit 1$q$ loop
   if line ~ 'delivery_stops_shipment_manifest_idx' then hit:=true; end if;
 end loop;
 if not hit then raise exception 'return_manifest_expected lookup cannot use delivery_stops_shipment_manifest_idx'; end if;
end $$;
reset enable_seqscan;
reset enable_bitmapscan;

-- The 0299 body, inside this transaction only, answers the same cases.
\ir ../../db/migrations/0299_lead_routing_admin_advisors.sql
create temp table perf_old as select case_id, lead_routing_scope(actor,stores,lead) j from perf_cases;
do $$
declare n int; total int;
begin
 select count(*) into total from perf_cases;
 select count(*) into n from perf_old o join perf_new w using(case_id)
  where (o.j-'blockedIds') is distinct from (w.j-'blockedIds')
     or (select coalesce(array_agg(x order by x),'{}') from jsonb_array_elements_text(o.j->'blockedIds') x)
        is distinct from (select coalesce(array_agg(x order by x),'{}') from jsonb_array_elements_text(w.j->'blockedIds') x);
 if n>0 then raise exception '0312 scope differs from 0299 in % of % cases',n,total; end if;
 if total<300 then raise exception 'too few cases compared: %',total; end if;
end $$;
rollback;
