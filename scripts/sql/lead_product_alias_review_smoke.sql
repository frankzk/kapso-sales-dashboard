-- THROWAWAY DATABASE ONLY. Clarification keeps the original evidence/history.
begin;
insert into stores(id,org_id,name,shopify_domain) values
 ('cc033100-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','Alias A','aliases.test');
insert into leads(id,store_id,phone,name,status,category,kapso_conversation_id,first_seen_at,last_interaction_at)
 values ('cc033100-0000-0000-0000-000000000002','cc033100-0000-0000-0000-000000000001','51999833100','Synthetic alias lead','nuevo','open','alias-conv','2026-11-01','2026-11-09');
set local role service_role;
select record_lead_products('cc033100-0000-0000-0000-000000000001','alias-conv',null,
 '{"handle":null,"title":null,"source":"ambiguous","at":"2026-11-01T00:00:00Z","evidence":"Shampoo Biru","message_id":"one"}',
 '[{"handle":null,"title":null,"source":"ambiguous","at":"2026-11-01T00:00:00Z","evidence":"Shampoo Biru","message_id":"one"}]');
select record_lead_products_v2('cc033100-0000-0000-0000-000000000001','alias-conv',null,
 '{"handle":"biru","title":"Shampoo Biru","source":"customer_text","at":"2026-11-01T00:00:00Z","evidence":"Shampoo Biru","message_id":"one"}',
 '[{"handle":"biru","title":"Shampoo Biru","source":"customer_text","at":"2026-11-01T00:00:00Z","evidence":"Shampoo Biru","message_id":"one"}]');
reset role;
do $$ begin
 if not exists(select 1 from leads where id='cc033100-0000-0000-0000-000000000002'
   and entry_product->>'handle'='biru' and interest_product->>'handle'='biru') then raise exception 'Same-evidence clarification failed'; end if;
 if (select count(*) from lead_product_signals where lead_id='cc033100-0000-0000-0000-000000000002')<>2 then raise exception 'History rewritten or duplicated'; end if;
end $$;
set local role service_role;
-- An old initial consultation cannot replace the newer interest or positive entry.
select record_lead_products_v2('cc033100-0000-0000-0000-000000000001','alias-conv',null,
 '{"handle":"magic","source":"customer_text","at":"2026-11-01T00:00:00Z","evidence":"Other"}',
 '[{"handle":"oil","source":"customer_text","at":"2026-11-09T00:00:00Z","evidence":"Oil","message_id":"new"}]');
select record_lead_products_v2('cc033100-0000-0000-0000-000000000001','alias-conv',null,null,
 '[{"handle":"biru","source":"customer_text","at":"2026-11-01T00:00:00Z","evidence":"Shampoo Biru","message_id":"one"}]');
reset role;
do $$ begin
 if not exists(select 1 from leads where id='cc033100-0000-0000-0000-000000000002'
   and entry_product->>'handle'='biru' and interest_product->>'handle'='oil'
   and status='nuevo' and category='open' and last_interaction_at='2026-11-09') then raise exception 'Chronology, entry or queue fields changed'; end if;
 if has_function_privilege('authenticated','public.record_lead_products_v2(uuid,text,uuid,jsonb,jsonb)','execute')
   or has_function_privilege('anon','public.record_lead_product_openers_v2(uuid,jsonb)','execute') then raise exception 'Browser can write attribution'; end if;
end $$;
rollback;
