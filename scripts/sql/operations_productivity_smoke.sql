-- THROWAWAY DATABASE ONLY. Synthetic events, rolled back. Never production.
begin;
insert into auth.users(id,email) values
 ('cc033300-0000-0000-0000-000000000010','operations-a@test.invalid'),
 ('cc033300-0000-0000-0000-000000000011','operations-b@test.invalid');
insert into organizations(id,name) values('cc033300-0000-0000-0000-000000000001','Operations QA');
insert into stores(id,org_id,name,shopify_domain) values
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000001','Operations A','operations-a.test'),
 ('cc033300-0000-0000-0000-000000000003','cc033300-0000-0000-0000-000000000001','Operations B','operations-b.test');
insert into orders(id,store_id,shopify_order_id,name,total_amount) values
 ('cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000002','operations100','#QA100',150),
 ('cc033300-0000-0000-0000-000000000101','cc033300-0000-0000-0000-000000000003','operations101','#QA101',150);
insert into order_master(order_id,store_id,shopify_order_id,macro_stage,macro_substage,macro_operation,current_courier)
 values('cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000002','operations100','en_curso','pendiente_pago_diferencia','agencia','shalom')
 on conflict(order_id) do update set macro_stage='en_curso',macro_substage='pendiente_pago_diferencia',macro_operation='agencia',current_courier='shalom';
-- Simulate one OLD contact with no historical context; never rewrite it later.
alter table order_events disable trigger capture_productivity_context;
insert into order_events(id,store_id,order_id,actor,kind,source,occurred_at) values
 ('cc033300-0000-0000-0000-000000000304','cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000011','comment','manual','2026-11-12T14:01Z');
alter table order_events enable trigger capture_productivity_context;
insert into order_events(id,store_id,order_id,actor,kind,source,occurred_at,payload,operation_id) values
 ('cc033300-0000-0000-0000-000000000301','cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000010','confirmation_contact','manual','2026-11-12T14:00Z','{"result":"confirmado"}','cc033300-0000-0000-0000-000000000400'),
 ('cc033300-0000-0000-0000-000000000302','cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000010','confirmed','manual','2026-11-12T14:00Z','{}','cc033300-0000-0000-0000-000000000400');
insert into order_events(store_id,order_id,actor,kind,source,occurred_at) values
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000011','confirmed','automatico','2026-11-12T14:01Z'),
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000010','comment','manual','2026-11-12T15:00Z'),
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000011','package_ready','dispatch','2026-11-12T17:00Z'),
 ('cc033300-0000-0000-0000-000000000003','cc033300-0000-0000-0000-000000000101','cc033300-0000-0000-0000-000000000010','confirmed','manual','2026-11-12T14:00Z'),
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000011','lima_repro_agreed','repro_lima','2026-11-12T17:30Z'),
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000010','payment','manual','2026-11-12T14:30Z');
insert into shipments(id,store_id,order_id,guide_code) values
 ('cc033300-0000-0000-0000-000000000200','cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','QA-operations');
insert into shipment_calls(shipment_id,store_id,agent,kind,new_status,next_followup_at,occurred_at) values
 ('cc033300-0000-0000-0000-000000000200','cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000010','reroute',null,'2026-11-13T12:00Z','2026-11-12T16:00Z'),
 ('cc033300-0000-0000-0000-000000000200','cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000010','call',null,'2026-11-13T12:00Z','2026-11-12T16:15Z');
insert into lima_repro_cases(id,store_id,order_id,episode_key,episode_at) values
 ('cc033300-0000-0000-0000-000000000500','cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','qa-operations','2026-11-11');
insert into lima_repro_calls(case_id,store_id,order_id,operation_id,outcome,channel,agreed_on,courier,box_action,actor,occurred_at) values
 ('cc033300-0000-0000-0000-000000000500','cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000501','confirma','llamada','2026-11-13','propio','mantener','cc033300-0000-0000-0000-000000000011','2026-11-12T17:30Z');
insert into order_payments(store_id,order_id,kind,amount,validation_status,registered_by,registered_at,validated_by,validated_at) values
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','diferencia',50,'validado','cc033300-0000-0000-0000-000000000010','2026-11-12T14:30Z','cc033300-0000-0000-0000-000000000011','2026-11-12T15:30Z'),
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','adelanto',0,'pendiente_revision','cc033300-0000-0000-0000-000000000010','2026-11-12T14:32Z',null,null);
insert into leads(id,store_id,phone) values('cc033300-0000-0000-0000-000000000800','cc033300-0000-0000-0000-000000000002','51999833300');
insert into lead_calls(store_id,lead_id,vendedora,kind,occurred_at) values
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000800','cc033300-0000-0000-0000-000000000010','call','2026-11-12T14:33Z'),
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000800','cc033300-0000-0000-0000-000000000011','system','2026-11-12T14:34Z'),
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000800','cc033300-0000-0000-0000-000000000010','call','2026-11-12T04:59Z'),
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000800','cc033300-0000-0000-0000-000000000010','call','2026-11-13T05:00Z');
insert into order_sales(store_id,order_id,lead_id,vendedora,occurred_at) values
 ('cc033300-0000-0000-0000-000000000002','cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000800','cc033300-0000-0000-0000-000000000011','2026-11-12T16:30Z');
do $$
declare s uuid[]:=array['cc033300-0000-0000-0000-000000000002'::uuid]; r jsonb; a jsonb; failure boolean:=false;
begin
 r:=operations_productivity(s,'2026-11-12T05:00Z','2026-11-13T04:59:59.999Z');
 if (r->'totals'->>'actions')::int<>12 or (r->'totals'->>'orders')::int<>1 or (r->'totals'->>'leads')::int<>1 then raise exception 'Duplicate, automation, store or date isolation failed: %',r->'totals'; end if;
 if (r->'totals'->>'unclassifiedContacts')::int<>1 then raise exception 'Historical contact guessed a section'; end if;
 select p into a from jsonb_array_elements(r->'people')p where p->>'userId'='cc033300-0000-0000-0000-000000000010';
 if (a->>'actions')::int<>7 or (a->'counts'->'confirmed'->>'count')::int<>1 then raise exception 'Actor or confirmation double-count'; end if;
 if (a->'counts'->'province_rescheduled'->>'count')::int<>1 or (a->'counts'->'province_call'->>'count')::int<>1 then raise exception 'Callback mistaken for delivery reprogramming'; end if;
 r:=operations_productivity(s,'2026-11-12T05:00Z','2026-11-13T04:59:59.999Z','diferencia');
 if (r->'totals'->>'actions')::int<>3 then raise exception 'Difference contacts, register or validate missing'; end if;
 update order_master set macro_substage='en_transito',macro_operation='lima',current_courier='propio' where order_id='cc033300-0000-0000-0000-000000000100';
 r:=operations_productivity(s,'2026-11-12T05:00Z','2026-11-13T04:59:59.999Z','diferencia');
 if (r->'totals'->>'actions')::int<>3 then raise exception 'Current stage reattributed old work'; end if;
 r:=operations_productivity(s,'2026-11-12T05:00Z','2026-11-13T04:59:59.999Z','pagos');
 if (r->'totals'->>'actions')::int<>3 then raise exception 'Payments excludes differences or double-counted mirror event'; end if;
 r:=operations_productivity(s,'2026-11-12T05:00Z','2026-11-13T04:59:59.999Z','resumen','cc033300-0000-0000-0000-000000000010');
 if jsonb_array_length(r->'people')<>1 or (r->'totals'->>'actions')::int<>7 then raise exception 'Own-only scope leaked'; end if;
 begin perform operations_productivity(s,'2026-11-12','2026-11-13','forged'); exception when others then failure:=true; end;
 if not failure then raise exception 'Invalid section accepted'; end if;
 if has_function_privilege('authenticated','public.operations_productivity(uuid[],timestamptz,timestamptz,text,uuid,text)','execute')
   or has_function_privilege('anon','public.operations_productivity(uuid[],timestamptz,timestamptz,text,uuid,text)','execute') then raise exception 'Report RPC exposed to browsers'; end if;
 -- More than a REST page: all actions aggregate, only the last 50 are serialized.
 insert into order_events(store_id,order_id,actor,kind,source,occurred_at)
 select s[1],'cc033300-0000-0000-0000-000000000100','cc033300-0000-0000-0000-000000000010','comment','manual',
   '2026-11-12T19:00Z'::timestamptz+n*interval '1 second' from generate_series(1,1205)n;
 r:=operations_productivity(s,'2026-11-12T05:00Z','2026-11-13T04:59:59.999Z');
 if (r->'totals'->>'actions')::int<>1217 then raise exception 'Aggregation truncated at one REST page'; end if;
 select p into a from jsonb_array_elements(r->'people')p where p->>'userId'='cc033300-0000-0000-0000-000000000010';
 if jsonb_array_length(a->'recent')<>50 then raise exception 'Unbounded browser detail payload'; end if;
end $$;
rollback;
