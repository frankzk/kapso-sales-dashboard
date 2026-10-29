\set ON_ERROR_STOP on
begin;
insert into organizations(id,name) values ('29000000-0000-0000-0000-000000000001','Agency cohort smoke');
insert into stores(id,org_id,name,shopify_domain) values
 ('29000000-0000-0000-0000-000000000002','29000000-0000-0000-0000-000000000001','Agency A','agency-a.test'),
 ('29000000-0000-0000-0000-000000000003','29000000-0000-0000-0000-000000000001','Agency B','agency-b.test');
insert into auth.users(id) values ('29000000-0000-0000-0000-000000000004');
insert into user_store_access(user_id,store_id) values
 ('29000000-0000-0000-0000-000000000004','29000000-0000-0000-0000-000000000002');
insert into orders(id,store_id,shopify_order_id,name,financial_status,payment_gateway,total_refunded)
 select ('29000000-0000-0000-0001-' || lpad(n::text,12,'0'))::uuid,
   case when n=9 then '29000000-0000-0000-0000-000000000003'::uuid else '29000000-0000-0000-0000-000000000002'::uuid end,
   'agency-'||n,'#AG'||n,case when n in (3,4,5) then 'paid' else 'pending' end,
   case when n in (3,5) then 'checkout' else 'manual' end,case when n=5 then 1 else 0 end
 from generate_series(1,9) n;
insert into order_master(order_id,store_id,shopify_order_id,order_name,order_total,macro_stage,macro_substage)
 select id,store_id,shopify_order_id,name,100,'en_curso','en_reparto' from orders where shopify_order_id like 'agency-%';
insert into shipments(store_id,order_id,courier,guide_code,created_at)
 select store_id,id,'shalom',name,case when name='#AG7' then '2026-10-30T05:00:00Z'::timestamptz
   when name='#AG8' then '2026-10-01T04:59:59Z'::timestamptz else '2026-10-01T05:00:00Z'::timestamptz end
 from orders where shopify_order_id like 'agency-%';
-- Two guides must not duplicate an order in the queue or its counts.
insert into shipments(store_id,order_id,courier,guide_code,created_at)
 select store_id,id,'olva','second-guide','2026-10-02T15:00:00Z' from orders where name='#AG1';
insert into order_payments(store_id,order_id,kind,amount,validation_status)
 select store_id,id,'adelanto',case when name='#AG1' then 20 else 100 end,
   case when name='#AG6' then 'pendiente_revision' else 'validado' end
 from orders where name in ('#AG1','#AG2','#AG6') and shopify_order_id like 'agency-%';

set local role authenticated;
set local request.jwt.claims = '{"sub":"29000000-0000-0000-0000-000000000004","role":"authenticated"}';
do $$
declare n integer; names text[];
begin
 select count(*),array_agg(order_name order by order_name) into n,names from order_master_agency_unpaid(
   array['29000000-0000-0000-0000-000000000002'::uuid,'29000000-0000-0000-0000-000000000003'::uuid], '2026-10-01','2026-10-30');
 if n<>4 or names<>array['#AG1','#AG4','#AG5','#AG6'] then raise exception 'FAIL cohort, checkout, partial, validation, boundaries, dedup or RLS: %',names; end if;
 if exists(select 1 from order_master_agency_unpaid(array['29000000-0000-0000-0000-000000000003'::uuid],'2026-10-01','2026-10-30'))
   then raise exception 'FAIL cross-store access'; end if;
 if exists(select 1 from order_master_agency_unpaid(array['29000000-0000-0000-0000-000000000002'::uuid],'2026-10-30','2026-10-01'))
   then raise exception 'FAIL invalid window'; end if;
 if has_function_privilege('anon','order_master_agency_unpaid(uuid[],date,date)','execute')
   then raise exception 'FAIL anon access'; end if;
 if (select prosecdef from pg_proc where oid='order_master_agency_unpaid(uuid[],date,date)'::regprocedure)
   then raise exception 'FAIL function bypasses RLS'; end if;
end $$;
reset role;
-- A newly validated balance removes the order without any Master update.
insert into order_payments(store_id,order_id,kind,amount,validation_status)
 select store_id,id,'diferencia',80,'validado' from orders where name='#AG1' and shopify_order_id='agency-1';
do $$ begin
 if exists(select 1 from order_master_agency_unpaid(array['29000000-0000-0000-0000-000000000002'::uuid],'2026-10-01','2026-10-30') where order_name='#AG1')
   then raise exception 'FAIL validated balance still pending'; end if;
end $$;
rollback;
