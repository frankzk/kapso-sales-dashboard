-- Runs only in verify-db's disposable cluster. Never requests an external guide.
begin;
do $$
declare
  org uuid := '33333333-3333-3333-3333-333333333333';
  a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  o1 uuid := gen_random_uuid(); o2 uuid := gen_random_uuid(); o3 uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid(); s3 uuid := gen_random_uuid();
  r jsonb; fingerprint text;
  products jsonb := '[{"codbar":"TEST","cantidad":1}]';
begin
  insert into orders(id,store_id,shopify_order_id,created_at) values(o1,a,'auto-test1',now()),(o2,b,'auto-test2',now()),(o3,b,'auto-test3',now());
  insert into shipments(id,store_id,order_id,courier,guide_code,delivery_status,status_category,reported_status,returned_at) values
    (s1,a,o1,'aliclik','AUTO1','anulado','cancelled','CANCEL · RETURNED',now()),
    (s2,b,o2,'aliclik','AUTO2','anulado','cancelled','NOT_RESPOND · RETURNED',now()),
    (s3,b,o3,'aliclik','AUTO3','anulado','cancelled','CANCEL · RETURNED',now());
  insert into swayp_auto_settings(org_id,enabled,daily_cap) values(org,true,2);
  if not exists(select 1 from swayp_auto_candidates(org) where id=s1) then raise exception 'candidate missing'; end if;
  fingerprint := swayp_auto_inspect(s1)->>'fingerprint';
  r:=swayp_emission_claim(a,o1,s1::text,'arequipa',products,true,jsonb_build_object('fingerprint',fingerprint),'[{"codbar":"TEST","disponible":2}]',now());
  if not r ? 'id' then raise exception 'first claim failed: %',r; end if;
  r:=swayp_emission_claim(a,o1,s1::text,'arequipa',products);
  if not r ? 'error' then raise exception 'manual duplicated automatic'; end if;
  r:=swayp_emission_claim(b,o2,s2::text,'arequipa',products,true,jsonb_build_object('fingerprint',swayp_auto_inspect(s2)->>'fingerprint'),'[{"codbar":"TEST","disponible":1}]',now());
  if r->>'error' <> 'Stock insuficiente después de reservas' then raise exception 'reservation not respected: %',r; end if;
  fingerprint:=swayp_auto_inspect(s2)->>'fingerprint';
  update orders set shopify_note='changed after evaluation' where id=o2;
  r:=swayp_emission_claim(b,o2,s2::text,'arequipa',products,true,jsonb_build_object('fingerprint',fingerprint),'[{"codbar":"TEST","disponible":2}]',now());
  if r->>'error' <> 'Los datos cambiaron; se reevaluará' then raise exception 'stale evidence accepted: %',r; end if;
  r:=swayp_emission_claim(b,o2,s2::text,'arequipa',products,true,jsonb_build_object('fingerprint',swayp_auto_inspect(s2)->>'fingerprint'),'[{"codbar":"TEST","disponible":2}]',now());
  if not r ? 'id' then raise exception 'second claim failed: %',r; end if;
  r:=swayp_emission_claim(b,o3,s3::text,'arequipa',products,true,jsonb_build_object('fingerprint',swayp_auto_inspect(s3)->>'fingerprint'),'[{"codbar":"TEST","disponible":50}]',now());
  if r->>'error' <> 'Tope diario alcanzado' then raise exception 'cap not shared across stores: %',r; end if;
  if has_function_privilege('authenticated','swayp_auto_snapshot(uuid)','execute') then raise exception 'snapshot exposed to browser'; end if;
  if has_function_privilege('anon','swayp_emission_claim(uuid,uuid,text,text,jsonb,boolean,jsonb,jsonb,timestamptz)','execute') then raise exception 'claim exposed'; end if;
end $$;
set request.test_uid='00000000-0000-0000-0000-00000000000a';
set local role authenticated;
do $$ begin
  if (select count(*) from swayp_guide_emissions)<>1 then raise exception 'emission RLS leaks another store'; end if;
end $$;
reset role;
rollback;
