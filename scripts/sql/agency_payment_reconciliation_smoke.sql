-- THROWAWAY ONLY. Deliberately exercise real Master state and RLS, no payment rewriting.
begin;
insert into organizations(id,name) values('cc033600-0000-0000-0000-000000000001','Agency reconciliation');
insert into stores(id,org_id,name,shopify_domain) values
 ('cc033600-0000-0000-0000-000000000002','cc033600-0000-0000-0000-000000000001','Allowed','reconcile-a.test'),
 ('cc033600-0000-0000-0000-000000000003','cc033600-0000-0000-0000-000000000001','Forbidden','reconcile-b.test');
insert into auth.users(id) values('cc033600-0000-0000-0000-000000000004');
insert into user_store_access(user_id,store_id) values('cc033600-0000-0000-0000-000000000004','cc033600-0000-0000-0000-000000000002');
insert into orders(id,store_id,shopify_order_id,name,platform,financial_status,payment_gateway,total_refunded)
select ('cc033600-0000-0000-0001-'||lpad(n::text,12,'0'))::uuid,
 case when n=12 then 'cc033600-0000-0000-0000-000000000003'::uuid else 'cc033600-0000-0000-0000-000000000002'::uuid end,
 'reconciliation-'||n,'#RC'||n,case when n=10 then 'woocommerce' else 'shopify' end,
 case when n in (2,3,9,10,12,15) then 'paid' else 'pending' end,'manual',case when n=9 then 10 else 0 end
from generate_series(1,15)n;
insert into order_master(order_id,store_id,shopify_order_id,order_name,order_total,general_status,macro_stage,payment_state)
select id,store_id,shopify_order_id,name,100,case when name='#RC6' then 'anulado' when name='#RC7' then 'devuelto' else 'en_proceso' end,'en_curso',
 case when name='#RC1' then 'pago_completo' when name='#RC5' then 'pago_total_cargado' when name='#RC11' then 'unknown_test' when name in ('#RC3','#RC4','#RC6','#RC7') then 'adelanto_validado' else null end
from orders where shopify_order_id like 'reconciliation-%';
insert into shipments(store_id,order_id,courier,guide_code,created_at)
select store_id,id,'shalom',name,case when name='#RC13' then '2026-10-01T04:59:59Z'::timestamptz when name='#RC14' then '2026-11-01T05:00:00Z'::timestamptz else '2026-10-01T05:00:00Z'::timestamptz end
from orders where shopify_order_id like 'reconciliation-%' and name<>'#RC15';
insert into shipments(store_id,order_id,courier,guide_code,created_at)
select store_id,id,'olva','second-RC4','2026-10-02T12:00:00Z' from orders where name='#RC4' and shopify_order_id='reconciliation-4';
set local role authenticated;
set local request.test_uid='cc033600-0000-0000-0000-000000000004';
set local request.jwt.claims='{"sub":"cc033600-0000-0000-0000-000000000004","role":"authenticated"}';
do $$
declare stores uuid[]:=array['cc033600-0000-0000-0000-000000000002'::uuid,'cc033600-0000-0000-0000-000000000003'::uuid]; ids text[];
begin
 select array_agg(order_name order by order_name) into ids from order_master_agency_payments(stores,'2026-10-01','2026-11-01','collect');
 if ids<>array['#RC10','#RC4','#RC8','#RC9'] then raise exception 'collection mismatch: %',ids; end if;
 if (select count(*) from order_master_agency_unpaid(stores,'2026-10-01','2026-11-01'))<>4 then raise exception 'legacy bookmark mismatch'; end if;
 if (select count(*) from order_master_agency_payments(stores,'2026-10-01','2026-11-01','all'))<>7 then raise exception 'denominator mismatch'; end if;
 if (select count(*) from order_master_agency_payments(stores,'2026-10-01','2026-11-01','complete') where payment_state='pago_completo')<>1 then raise exception 'complete mismatch'; end if;
 if (select count(*) from order_master_agency_payments(stores,'2026-10-01','2026-11-01','validate'))<>1 then raise exception 'validation mismatch'; end if;
 if (select count(*) from order_master_agency_payments(stores,'2026-10-01','2026-11-01','review'))<>1 then raise exception 'unknown state hidden'; end if;
 if (select count(*) from order_master_agency_payments(stores,'2026-10-01','2026-11-01','historical'))<>2 then raise exception 'historical cohort mismatch'; end if;
 if (select count(*) from order_master_agency_payments(stores,null,null,'historical'))<>3 then raise exception 'global history/RLS mismatch'; end if;
 if (select count(*) from order_master_agency_payments(stores,null,null,'historical') where payment_state='adelanto_validado')<>1 then raise exception 'history must combine with Estado de pago'; end if;
 if exists(select 1 from order_master_agency_payments(stores,null,null,'collect')) or exists(select 1 from order_master_agency_payments(stores,'2026-11-01','2026-10-01','all')) or exists(select 1 from order_master_agency_payments(stores,'2026-10-01','2026-11-01','invalid')) then raise exception 'invalid parameters opened cohort'; end if;
 if has_function_privilege('anon','order_master_agency_payments(uuid[],date,date,text)','execute') or (select prosecdef from pg_proc where oid='order_master_agency_payments(uuid[],date,date,text)'::regprocedure) then raise exception 'RLS bypass'; end if;
end $$;
reset role;
rollback;
