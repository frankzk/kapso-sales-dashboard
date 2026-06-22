-- RLS isolation assertions. Run after test_prelude + migrations + policies on a
-- throwaway cluster. Each block RAISEs on a wrong count, so with ON_ERROR_STOP
-- the script exits non-zero if any rule is violated.

insert into auth.users(id,email) values
  ('00000000-0000-0000-0000-00000000000a','a@x.com'),
  ('00000000-0000-0000-0000-00000000000b','b@x.com'),
  ('00000000-0000-0000-0000-00000000000c','c@x.com'),
  ('00000000-0000-0000-0000-00000000000d','d@x.com');

insert into organizations(id,name) values ('33333333-3333-3333-3333-333333333333','RLS Org');

insert into stores(id,org_id,name,shopify_domain,currency,timezone,status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','33333333-3333-3333-3333-333333333333','Store A','a.myshopify.com','PEN','America/Lima','active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','33333333-3333-3333-3333-333333333333','Store B','b.myshopify.com','PEN','America/Lima','active');

-- ua viewer→A (explicit grant), ub viewer→B, uc org owner (implicit both),
-- ud viewer membership but NO explicit grant (must see nothing).
insert into user_store_access(user_id,store_id) values
  ('00000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('00000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
insert into memberships(user_id,org_id,role) values
  ('00000000-0000-0000-0000-00000000000c','33333333-3333-3333-3333-333333333333','owner'),
  ('00000000-0000-0000-0000-00000000000d','33333333-3333-3333-3333-333333333333','viewer');

insert into orders(store_id,shopify_order_id,created_at,total_amount,currency) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','A1','2026-06-20T15:00:00Z',100,'PEN'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','A2','2026-06-20T16:00:00Z',200,'PEN'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','B1','2026-06-20T15:00:00Z',300,'PEN'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','B2','2026-06-20T16:00:00Z',400,'PEN'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','B3','2026-06-20T17:00:00Z',500,'PEN');

\echo '  user A (viewer of A): stores=1, A orders=2, B orders=0'
set request.test_uid = '00000000-0000-0000-0000-00000000000a';
set role authenticated;
do $$ begin
  if (select count(*) from stores) <> 1 then raise exception 'A: expected 1 store, saw %', (select count(*) from stores); end if;
  if (select count(*) from orders where store_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') <> 0 then raise exception 'A: store B orders leaked!'; end if;
  if (select count(*) from orders where store_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') <> 2 then raise exception 'A: expected 2 store A orders'; end if;
end $$;
reset role;

\echo '  user B (viewer of B): stores=1, B orders=3, A orders=0'
set request.test_uid = '00000000-0000-0000-0000-00000000000b';
set role authenticated;
do $$ begin
  if (select count(*) from stores) <> 1 then raise exception 'B: expected 1 store'; end if;
  if (select count(*) from orders where store_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') <> 0 then raise exception 'B: store A orders leaked!'; end if;
  if (select count(*) from orders where store_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') <> 3 then raise exception 'B: expected 3 store B orders'; end if;
end $$;
reset role;

\echo '  user C (org owner): stores=2, orders=5'
set request.test_uid = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
do $$ begin
  if (select count(*) from stores) <> 2 then raise exception 'C: expected 2 stores'; end if;
  if (select count(*) from orders) <> 5 then raise exception 'C: expected 5 orders'; end if;
end $$;
reset role;

\echo '  user D (viewer, no grant): stores=0, orders=0'
set request.test_uid = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
do $$ begin
  if (select count(*) from stores) <> 0 then raise exception 'D: expected 0 stores, saw %', (select count(*) from stores); end if;
  if (select count(*) from orders) <> 0 then raise exception 'D: expected 0 orders'; end if;
end $$;
reset role;

\echo '  anon (no uid): stores=0'
set request.test_uid = '';
set role authenticated;
do $$ begin
  if (select count(*) from stores) <> 0 then raise exception 'anon: expected 0 stores'; end if;
end $$;
reset role;
