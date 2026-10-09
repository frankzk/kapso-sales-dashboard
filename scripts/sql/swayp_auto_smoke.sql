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
  update orders set raw=jsonb_build_object('note','changed after evaluation') where id=o2;
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
do $$
declare
  org uuid := '33333333-3333-3333-3333-333333333333';
  a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  o4 uuid := gen_random_uuid(); o5 uuid := gen_random_uuid();
  s4 uuid := gen_random_uuid(); s5 uuid := gen_random_uuid(); r jsonb; evidence jsonb;
begin
  update swayp_auto_settings set daily_cap=10,pilot_daily_cap=1 where org_id=org;
  insert into orders(id,store_id,shopify_order_id,created_at,total_amount) values(o4,a,'pilot4',now(),500.01),(o5,b,'pilot5',now(),149);
  insert into shipments(id,store_id,order_id,courier,guide_code,delivery_status,status_category,reported_status,closed_at,aliclik_attempts) values
    (s4,a,o4,'aliclik','PILOT4','anulado','cancelled','CANCEL · TO_RETURN · CONFIRMED',now(),1),
    (s5,b,o5,'aliclik','PILOT5','anulado','cancelled','CANCEL · TO_RETURN · CONFIRMED',now(),1);
  evidence:=jsonb_build_object('fingerprint',swayp_auto_inspect(s4)->>'fingerprint','cohort','recent_no_history','location',jsonb_build_object('ok',true));
  r:=swayp_emission_claim(a,o4,s4::text,'arequipa','[{"codbar":"TEST","cantidad":1}]',true,evidence,'[{"codbar":"TEST","disponible":50}]',now());
  if r->>'error'<>'Piloto desactivado' then raise exception 'pilot flag bypass: %',r; end if;
  update swayp_auto_settings set pilot_enabled=true where org_id=org;
  r:=swayp_emission_claim(a,o4,s4::text,'arequipa','[{"codbar":"TEST","cantidad":1}]',true,evidence,'[{"codbar":"TEST","disponible":50}]',now());
  if r->>'error'<>'El pedido no cumple el piloto sin historial' then raise exception 'amount above 500 accepted: %',r; end if;
  update orders set total_amount=500 where id=o4;
  evidence:=jsonb_build_object('fingerprint',swayp_auto_inspect(s4)->>'fingerprint','cohort','recent_no_history','location',jsonb_build_object('ok',true));
  r:=swayp_emission_claim(a,o4,s4::text,'arequipa','[{"codbar":"TEST","cantidad":1}]',true,evidence||'{"location":{"ok":false}}','[{"codbar":"TEST","disponible":50}]',now());
  if r->>'error'<>'El pedido no cumple el piloto sin historial' then raise exception 'location bypass: %',r; end if;
  -- 0231: sin visita de Aliclik no hay reenvío del piloto.
  update shipments set aliclik_attempts=0 where id=s4;
  evidence:=jsonb_build_object('fingerprint',swayp_auto_inspect(s4)->>'fingerprint','cohort','recent_no_history','location',jsonb_build_object('ok',true));
  r:=swayp_emission_claim(a,o4,s4::text,'arequipa','[{"codbar":"TEST","cantidad":1}]',true,evidence,'[{"codbar":"TEST","disponible":50}]',now());
  if r->>'error'<>'El pedido no cumple el piloto sin historial' then raise exception 'zero attempts accepted: %',r; end if;
  update shipments set aliclik_attempts=1,reported_status='CANCEL · LEFT_IN_WAREHOUSE · CONFIRMED' where id=s4;
  evidence:=jsonb_build_object('fingerprint',swayp_auto_inspect(s4)->>'fingerprint','cohort','recent_no_history','location',jsonb_build_object('ok',true));
  r:=swayp_emission_claim(a,o4,s4::text,'arequipa','[{"codbar":"TEST","cantidad":1}]',true,evidence,'[{"codbar":"TEST","disponible":50}]',now());
  if r->>'error'<>'El pedido no cumple el piloto sin historial' then raise exception 'package never left accepted: %',r; end if;
  update shipments set reported_status='CANCEL · TO_RETURN · CONFIRMED' where id=s4;
  evidence:=jsonb_build_object('fingerprint',swayp_auto_inspect(s4)->>'fingerprint','cohort','recent_no_history','location',jsonb_build_object('ok',true));
  r:=swayp_emission_claim(a,o4,s4::text,'arequipa','[{"codbar":"TEST","cantidad":1}]',true,evidence,'[{"codbar":"TEST","disponible":50}]',now());
  if not r ? 'id' then raise exception 'pilot claim failed: %',r; end if;
  evidence:=jsonb_build_object('fingerprint',swayp_auto_inspect(s5)->>'fingerprint','cohort','recent_no_history','location',jsonb_build_object('ok',true));
  r:=swayp_emission_claim(b,o5,s5::text,'arequipa','[{"codbar":"TEST","cantidad":1}]',true,evidence,'[{"codbar":"TEST","disponible":50}]',now());
  if r->>'error'<>'Piloto: cupo diario alcanzado' then raise exception 'pilot cap not shared across stores: %',r; end if;
  if (select attempts from swayp_auto_metrics where org_id=org and cohort='recent_no_history')<>1 then raise exception 'cohort metrics missing'; end if;
  -- 0236: una guía Swayp en Devolución (8) cuenta como devuelta, no pendiente,
  -- aunque Kapta la tenga `en_ruta`.
  update swayp_guide_emissions set guide_code='SWTEST4',state='created' where order_id=o4 and automatic;
  insert into shipments(store_id,order_id,courier,guide_code,swayp_guide,delivery_status,status_category,swayp_state)
    values(a,o4,'fenix','SWTEST4','SWTEST4','en_ruta','in_route',8);
  if (select returned from swayp_auto_metrics where org_id=org and cohort='recent_no_history')<>1
    or (select pending from swayp_auto_metrics where org_id=org and cohort='recent_no_history')<>0 then
    raise exception 'Swayp return counted as pending: %',(select row_to_json(m) from swayp_auto_metrics m where org_id=org and cohort='recent_no_history');
  end if;
end $$;
set local role authenticated;
do $$ begin
  if (select sum(attempts) from swayp_auto_metrics)<>2 then raise exception 'metrics bypass RLS'; end if;
end $$;
reset role;
rollback;
