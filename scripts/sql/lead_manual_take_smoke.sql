-- THROWAWAY DATABASE ONLY. Permission and operational tests; never run on production.
begin;
insert into auth.users(id,email) select ('cc033200-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'manual-take-'||n||'@test.invalid' from generate_series(10,15)n;
insert into organizations(id,name) values('cc033200-0000-0000-0000-000000000001','Manual take'),('cc033200-0000-0000-0000-000000000004','Other');
insert into memberships(user_id,org_id,role) select ('cc033200-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'cc033200-0000-0000-0000-000000000001',case when n=10 then 'owner' when n=15 then 'viewer' else 'vendedora' end from generate_series(10,13)n;
insert into memberships(user_id,org_id,role) values('cc033200-0000-0000-0000-000000000014','cc033200-0000-0000-0000-000000000004','owner'),('cc033200-0000-0000-0000-000000000015','cc033200-0000-0000-0000-000000000001','viewer');
insert into stores(id,org_id,name,shopify_domain) values('cc033200-0000-0000-0000-000000000002','cc033200-0000-0000-0000-000000000001','Manual A','manual-a.test'),('cc033200-0000-0000-0000-000000000003','cc033200-0000-0000-0000-000000000004','Foreign','manual-b.test');
insert into user_store_access(user_id,store_id) select user_id,'cc033200-0000-0000-0000-000000000002' from memberships where org_id='cc033200-0000-0000-0000-000000000001';
insert into leads(id,store_id,phone,name,status,category,first_seen_at,last_interaction_at,call_attempt_count)
select ('cc033200-0000-0000-0000-'||lpad((100+n)::text,12,'0'))::uuid,'cc033200-0000-0000-0000-000000000002','5193300000'||n,'Manual '||n,'nuevo','open',now()-interval '4 days',now()-interval '4 days',1 from generate_series(1,7)n;
insert into leads(id,store_id,phone,status,category) values('cc033200-0000-0000-0000-000000000108','cc033200-0000-0000-0000-000000000003','51933000008','nuevo','open');
do $$
declare
 o uuid:='cc033200-0000-0000-0000-000000000001'; s uuid:='cc033200-0000-0000-0000-000000000002';
 boss uuid:='cc033200-0000-0000-0000-000000000010'; a uuid:='cc033200-0000-0000-0000-000000000011'; b uuid:='cc033200-0000-0000-0000-000000000012';
 l uuid:='cc033200-0000-0000-0000-000000000101'; reserved uuid:='cc033200-0000-0000-0000-000000000102';
 cfg jsonb; result jsonb; before_row jsonb; failure boolean;
begin
 cfg:=jsonb_build_array(jsonb_build_object('userId',a,'blocks',array['carrito_reciente','interes_reciente','nuevo_sin_intencion','pendiente_con_interes'],'backup',false),jsonb_build_object('userId',b,'blocks',array['recuperacion'],'backup',false));
 perform save_lead_routing(o,boss,0,true,24,cfg);
 if exists(select 1 from lead_routing_assignments where org_id=o and manual_take) then raise exception 'installation or old client granted permission'; end if;
 if (lead_manual_take_check(a,l)->>'reason')<>'permission' then raise exception 'missing permission did not block'; end if;
 if (claim_manual_lead(a,l,'busqueda')->>'ok')::boolean then raise exception 'unpermitted manual claim'; end if;
 cfg:=jsonb_set(cfg,'{0,manualTake}','true'); perform save_lead_routing(o,boss,1,true,24,cfg);
 if not s=any(lead_manual_take_stores(a,array[s])) then raise exception 'manual search store missing'; end if;
 if (lead_routing_scope(a,array[s],l)->>'allowed')::boolean then raise exception 'manual flag expanded automatic queue'; end if;
 select to_jsonb(x)-'claimed_by'-'claimed_at'-'updated_at' into before_row from leads x where id=l;
 result:=claim_manual_lead(a,l,'busqueda');
 if not (result->>'ok')::boolean or not (result->>'manualException')::boolean then raise exception 'manual exception failed'; end if;
 if (select to_jsonb(x)-'claimed_by'-'claimed_at'-'updated_at' from leads x where id=l)<>before_row then raise exception 'manual take modified lead operational history'; end if;
 if not (lead_routing_scope(a,array[s],l)->>'allowed')::boolean then raise exception 'drawer cannot read newly owned reservation'; end if;
 perform claim_manual_lead(a,l,'busqueda');
 if (select count(*) from lead_manual_takes where lead_id=l)<>1 or (select count(*) from lead_calls where lead_id=l and kind='system')<>1 then raise exception 'audit missing or duplicate'; end if;
 if (claim_manual_lead(b,l,'venta_telefonica')->>'reason')<>'claimed' then raise exception 'second advisor stole reservation'; end if;
 update leads set claimed_at=now()-interval '11 minutes' where id=l;
 if (lead_routing_scope(a,array[s],l)->>'allowed')::boolean then raise exception 'manual permission gave permanent block access'; end if;
 -- Appointment owned by a currently authorized advisor remains protected.
 update leads set next_followup_at=now()+interval '1 hour' where id=reserved;
 insert into lead_calls(lead_id,store_id,vendedora,kind,next_followup_at,occurred_at)
 select id,store_id,b,'call',next_followup_at,now()-interval '1 hour' from leads where id=reserved;
 if (claim_manual_lead(a,reserved,'busqueda')->>'reason')<>'appointment' then raise exception 'manual take stole appointment'; end if;
 update leads set last_inbound_at=now()-interval '1 minute' where id=reserved;
 if not (claim_manual_lead(a,reserved,'busqueda')->>'ok')::boolean then raise exception 'released appointment stayed blocked'; end if;
 -- Two live reservations remain the atomic ceiling.
 perform claim_manual_lead(a,l,'venta_telefonica');
 if (claim_manual_lead(a,'cc033200-0000-0000-0000-000000000103','busqueda')->>'reason')<>'capacity' then raise exception 'capacity exceeded'; end if;
 if (lead_manual_take_check(a,'cc033200-0000-0000-0000-000000000108')->>'reason')<>'store' then raise exception 'cross-store access'; end if;
 if (lead_manual_take_check('cc033200-0000-0000-0000-000000000014',l)->>'reason')<>'store' then raise exception 'cross-org access'; end if;
 if (lead_manual_take_check('cc033200-0000-0000-0000-000000000015',l)->>'reason')<>'store' then raise exception 'viewer gained advisor permission'; end if;
 failure:=false; begin perform claim_manual_lead(a,l,'queue'); exception when others then failure:=true; end;
 if not failure then raise exception 'arbitrary origin accepted'; end if;
 -- Legacy saves retain the separate permission; stale revisions still fail.
 cfg:=cfg#-'{0,manualTake}'; perform save_lead_routing(o,boss,2,true,24,cfg);
 if not (select manual_take from lead_routing_assignments where org_id=o and user_id=a) then raise exception 'legacy save erased manual flag'; end if;
 failure:=false; begin perform save_lead_routing(o,boss,2,true,24,cfg); exception when others then failure:=true; end;
 if not failure then raise exception 'stale revision accepted'; end if;
 cfg:=jsonb_set(cfg,'{0,manualTake}','false'); perform save_lead_routing(o,boss,3,true,24,cfg);
 if (lead_manual_take_check(a,'cc033200-0000-0000-0000-000000000103')->>'reason')<>'permission' then raise exception 'revoked permission still allowed'; end if;
 if (select count(*) from lead_routing_audit where org_id=o)<>4 then raise exception 'configuration audit missing'; end if;
 if has_function_privilege('anon','public.claim_manual_lead(uuid,uuid,text)','execute') or has_function_privilege('authenticated','public.claim_manual_lead(uuid,uuid,text)','execute') or has_function_privilege('authenticated','public.lead_manual_take_check(uuid,uuid)','execute') or has_table_privilege('authenticated','public.lead_manual_takes','select') then raise exception 'private manual take exposed'; end if;
end $$;
rollback;
