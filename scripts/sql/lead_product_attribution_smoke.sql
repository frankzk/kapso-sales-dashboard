-- THROWAWAY DATABASE ONLY; all evidence is synthetic and rolls back.
begin;
insert into stores(id,org_id,name,shopify_domain) values
 ('cc033000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','Products A','products-a.test'),
 ('cc033000-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','Products B','products-b.test');
insert into leads(id,store_id,phone,name,status,category,kapso_conversation_id,first_seen_at,last_interaction_at)
 values ('cc033000-0000-0000-0000-000000000003','cc033000-0000-0000-0000-000000000001',
 '51999833000','Synthetic product lead','nuevo','open','products-conv','2026-11-01','2026-11-09');

set local role service_role;
select record_lead_products('cc033000-0000-0000-0000-000000000001','products-conv',null,
 '{"handle":"oil","title":"Black Seed Oil","source":"customer_text","at":"2026-11-01T00:00:00Z","evidence":"Quiero Black Seed Oil","message_id":"first"}',
 '[{"handle":"asta","title":"Astaxantina","source":"customer_text","at":"2026-11-09T15:00:00Z","evidence":"Ahora astaxantina","message_id":"new"}]');
-- Out-of-order backfill and replay must not change either identity or add history.
select record_lead_products('cc033000-0000-0000-0000-000000000001','products-conv',null,
 '{"handle":"other","source":"customer_text","at":"2026-11-02","evidence":"Other"}',
 '[{"handle":"old","title":"Old","source":"customer_text","at":"2026-11-02T00:00:00Z","evidence":"Old","message_id":"old"},
 {"handle":"asta","title":"Astaxantina","source":"customer_text","at":"2026-11-09T15:00:00Z","evidence":"Ahora astaxantina","message_id":"new"}]');
-- A conversation in store A must never be updated through store B.
select record_lead_products('cc033000-0000-0000-0000-000000000002','products-conv',null,null,
 '[{"handle":"wrong-store","source":"customer_text","at":"2026-11-10T00:00:00Z","evidence":"Wrong"}]');
reset role;
do $$ begin
  if not exists (select 1 from leads where id='cc033000-0000-0000-0000-000000000003'
    and entry_product->>'handle'='oil' and interest_product->>'handle'='asta'
    and status='nuevo' and category='open' and first_seen_at='2026-11-01' and last_interaction_at='2026-11-09')
  then raise exception 'Attribution changed identity, chronology or queue fields'; end if;
  if (select count(*) from lead_product_signals where lead_id='cc033000-0000-0000-0000-000000000003') <> 4
  then raise exception 'History lost or replay duplicated'; end if;
  if has_function_privilege('authenticated','public.record_lead_products(uuid,text,uuid,jsonb,jsonb)','execute')
    or has_function_privilege('anon','public.record_lead_products(uuid,text,uuid,jsonb,jsonb)','execute')
    or has_table_privilege('authenticated','public.lead_product_signals','select')
    or has_table_privilege('service_role','public.lead_product_signals','delete')
    or has_table_privilege('service_role','public.lead_product_signals','update')
  then raise exception 'Browser can read or modify private attribution history'; end if;
end $$;
rollback;
