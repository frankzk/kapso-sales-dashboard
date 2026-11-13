-- THROWAWAY DATABASE ONLY: private configuration and day/actor counts.
begin;
insert into auth.users(id,email) select ('cc033500-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'mix-'||n||'@test.invalid' from generate_series(10,13)n;
insert into organizations(id,name) values('cc033500-0000-0000-0000-000000000001','Distribution'),('cc033500-0000-0000-0000-000000000004','Foreign');
insert into memberships(user_id,org_id,role) select ('cc033500-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'cc033500-0000-0000-0000-000000000001',case when n=10 then 'owner' else 'vendedora' end from generate_series(10,12)n;
insert into memberships(user_id,org_id,role) values('cc033500-0000-0000-0000-000000000013','cc033500-0000-0000-0000-000000000004','owner');
insert into stores(id,org_id,name,shopify_domain,timezone) values
 ('cc033500-0000-0000-0000-000000000002','cc033500-0000-0000-0000-000000000001','A','mix-a.test','America/Lima'),
 ('cc033500-0000-0000-0000-000000000003','cc033500-0000-0000-0000-000000000001','B','mix-b.test','America/Lima'),
 ('cc033500-0000-0000-0000-000000000005','cc033500-0000-0000-0000-000000000004','Foreign','mix-f.test','America/Lima');
insert into user_store_access(user_id,store_id) select ('cc033500-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,s from generate_series(10,11)n cross join unnest(array['cc033500-0000-0000-0000-000000000002'::uuid,'cc033500-0000-0000-0000-000000000003'::uuid])s;
insert into user_store_access(user_id,store_id) values('cc033500-0000-0000-0000-000000000012','cc033500-0000-0000-0000-000000000002');
insert into leads(id,store_id,phone,status,category) select ('cc033500-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'cc033500-0000-0000-0000-000000000002','51933500'||n,'nuevo','open' from generate_series(101,104)n;
do $$
declare
 o uuid:='cc033500-0000-0000-0000-000000000001'; boss uuid:='cc033500-0000-0000-0000-000000000010';
 a uuid:='cc033500-0000-0000-0000-000000000011'; b uuid:='cc033500-0000-0000-0000-000000000012';
 sa uuid:='cc033500-0000-0000-0000-000000000002'; sb uuid:='cc033500-0000-0000-0000-000000000003';
 foreign_store uuid:='cc033500-0000-0000-0000-000000000005'; cfg jsonb; bad jsonb; result jsonb; failed boolean; before_leads jsonb;
 day_start timestamptz := date_trunc('day',statement_timestamp() at time zone 'America/Lima') at time zone 'America/Lima';
begin
 cfg:=jsonb_build_array(jsonb_build_object('userId',a,'blocks',array['carrito_reciente','interes_reciente','nuevo_sin_intencion','pendiente_con_interes','recuperacion'],'backup',false,'manualTake',true),jsonb_build_object('userId',b,'blocks',array['recuperacion'],'backup',false));
 perform save_lead_routing(o,boss,0,true,24,cfg);
 if (lead_store_distribution(a,array[sa,sb])->'weights')<>'null'::jsonb then raise exception 'default must preserve priority'; end if;
 select jsonb_agg(to_jsonb(l) order by l.id) into before_leads from leads l where store_id in(sa,sb);
 cfg:=jsonb_set(cfg,'{0,storeWeights}',jsonb_build_object(sa,80,sb,20));
 perform save_lead_routing(o,boss,1,true,24,cfg);
 if before_leads<>(select jsonb_agg(to_jsonb(l) order by l.id) from leads l where store_id in(sa,sb)) then raise exception 'configuration modified leads'; end if;
 if (lead_store_distribution(a,array[sa,sb])->'weights')<>jsonb_build_object(sa,80,sb,20) then raise exception 'target missing'; end if;
 if (lead_store_distribution(b,array[sa])->'weights')<>'null'::jsonb then raise exception 'other advisor target changed'; end if;
 -- Same lead managed twice counts once; notes/system, other actors, yesterday and future do not count.
 insert into lead_calls(lead_id,store_id,vendedora,kind,occurred_at) values
 ('cc033500-0000-0000-0000-000000000101',sa,a,'call',statement_timestamp()),
 ('cc033500-0000-0000-0000-000000000101',sa,a,'call',statement_timestamp()),
 ('cc033500-0000-0000-0000-000000000102',sa,a,'note',statement_timestamp()),
 ('cc033500-0000-0000-0000-000000000103',sa,a,'system',statement_timestamp()),
 ('cc033500-0000-0000-0000-000000000104',sa,b,'call',statement_timestamp()),
 ('cc033500-0000-0000-0000-000000000102',sa,a,'call',day_start-interval '1 second'),
 ('cc033500-0000-0000-0000-000000000103',sa,a,'call',statement_timestamp()+interval '1 day');
 -- Call-attempt triggers legitimately update leads. Snapshot after those writes
 -- to test that this new distribution read itself changes nothing.
 select jsonb_agg(to_jsonb(l) order by l.id) into before_leads from leads l where store_id in(sa,sb);
 result:=lead_store_distribution(a,array[sa,sb]);
 if (result->'completed'->>sa::text)::integer<>1 then raise exception 'management counts not actor/day/distinct'; end if;
 if before_leads<>(select jsonb_agg(to_jsonb(l) order by l.id) from leads l where store_id in(sa,sb)) then raise exception 'distribution modified leads'; end if;
 -- Legacy clients preserve a custom target and manual permission.
 perform save_lead_routing(o,boss,2,true,24,cfg#-'{0,storeWeights}'#-'{0,manualTake}');
 if (lead_store_distribution(a,array[sa])->'weights')<>jsonb_build_object(sa,80,sb,20) or not (select manual_take from lead_routing_assignments where org_id=o and user_id=a) then raise exception 'legacy save erased config'; end if;
 for bad in select * from unnest(array[jsonb_build_object(sa,80,sb,10),jsonb_build_object(sa,80.5,sb,19.5),jsonb_build_object(sa,80,foreign_store,20),'[]'::jsonb,'{}'::jsonb,jsonb_build_object('invalid',100)]) loop
   failed:=false; begin perform save_lead_routing(o,boss,3,true,24,jsonb_set(cfg,'{0,storeWeights}',bad)); exception when others then failed:=true; end;
   if not failed then raise exception 'invalid weights accepted: %',bad; end if;
 end loop;
 failed:=false; begin perform save_lead_routing(o,boss,3,true,24,jsonb_set(cfg,'{1,storeWeights}',jsonb_build_object(sb,100))); exception when others then failed:=true; end;
 if not failed then raise exception 'ungranted store configured'; end if;
 failed:=false; begin perform save_lead_routing(o,a,3,true,24,cfg); exception when others then failed:=true; end;
 if not failed then raise exception 'advisor changed team routing'; end if;
 failed:=false; begin perform lead_store_distribution(a,array[foreign_store]); exception when others then failed:=true; end;
 if not failed then raise exception 'cross tenant read'; end if;
 failed:=false; begin perform lead_store_distribution(b,array[sb]); exception when others then failed:=true; end;
 if not failed then raise exception 'ungranted store read'; end if;
 failed:=false; begin perform save_lead_routing(o,boss,1,true,24,cfg); exception when others then failed:=true; end;
 if not failed then raise exception 'stale overwrite'; end if;
 perform save_lead_routing(o,boss,3,true,24,jsonb_set(cfg,'{0,storeWeights}','null'));
 if (lead_store_distribution(a,array[sa,sb])->'weights')<>'null'::jsonb then raise exception 'priority reset failed'; end if;
 if (select count(*) from lead_routing_audit where org_id=o)<>4 then raise exception 'audit count'; end if;
 if has_function_privilege('anon','public.lead_store_distribution(uuid,uuid[])','execute') or has_function_privilege('authenticated','public.lead_store_distribution(uuid,uuid[])','execute') or has_function_privilege('authenticated','public.save_lead_routing(uuid,uuid,integer,boolean,integer,jsonb)','execute') then raise exception 'private functions exposed'; end if;
end $$;
rollback;
