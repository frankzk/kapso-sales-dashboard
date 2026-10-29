\set ON_ERROR_STOP on
-- 0288: atenciones de primer despacho/seguimiento, sin inventar un fallo.
begin;
insert into orders(id,store_id,shopify_order_id,name) values
 ('28800000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','attention-0288','#AT288');
insert into order_master(order_id,store_id,shopify_order_id,order_name,coverage,macro_stage,macro_substage) values
 ('28800000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','attention-0288','#AT288','lima','preparacion','por_armar');
do $$
declare
  o uuid := '28800000-0000-0000-0000-000000000001';
  s uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  a uuid := '00000000-0000-0000-0000-00000000000a';
  b uuid := '00000000-0000-0000-0000-00000000000c';
  v jsonb; c uuid; stage text; test text;
begin
  foreach stage in array array['por_confirmar','preparacion','por_despachar','en_curso'] loop
    update order_master set macro_stage=stage,macro_substage=null where order_id=o;
    v := lima_repro_claim(o,s,a,'attention:' || o::text);
    if not (v->>'claimed')::boolean then raise exception 'FAIL pending stage %', stage; end if;
    c := (v->>'case_id')::uuid;
  end loop;
  if (select count(*) from lima_repro_cases where order_id=o) <> 1 then raise exception 'FAIL duplicated attention case'; end if;
  if exists(select 1 from shipments where order_id=o) or exists(select 1 from delivery_stops where order_id=o) then raise exception 'FAIL invented physical facts'; end if;
  v := lima_repro_claim(o,s,b,'attention:' || o::text);
  if (v->>'claimed')::boolean then raise exception 'FAIL ignored another advisor claim'; end if;
  perform lima_repro_record(c,a,'28800000-0000-0000-0000-000000000002','attention:' || o::text,'no_contesta','llamada');
  if (select call_count from lima_repro_cases where id=c) <> 1 then raise exception 'FAIL pending contact missing'; end if;
  if (select macro_substage from order_master where order_id=o) = 'por_reprogramar_lima' then raise exception 'FAIL invented a failed delivery'; end if;

  foreach test in array array['coverage','por_cerrar','finalizado','cancelled','wrong_store','wrong_context','fake_failure'] loop
    update order_master set coverage='lima',macro_stage='preparacion',macro_substage='por_armar' where order_id=o;
    update orders set cancelled_at=null where id=o;
    if test='coverage' then update order_master set coverage='provincia_cod' where order_id=o; end if;
    if test in ('por_cerrar','finalizado') then update order_master set macro_stage=test where order_id=o; end if;
    if test='cancelled' then update orders set cancelled_at=now() where id=o; end if;
    begin
      perform lima_repro_claim(o,case when test='wrong_store' then 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid else s end,a,
        case when test='wrong_context' then 'attention:otro' when test='fake_failure' then 's:fallo-falso' else 'attention:' || o::text end);
      raise exception 'FAIL allowed %',test;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
    end;
    if (select count(*) from lima_repro_cases where order_id=o and closed_at is null) <> 1 then raise exception 'FAIL rejection closed the existing case'; end if;
  end loop;

  -- Un fallo posterior toma su episodio real y conserva la atención anterior.
  update orders set cancelled_at=null where id=o;
  update order_master set coverage='lima',macro_stage='en_curso',macro_substage='por_reprogramar_lima' where order_id=o;
  v := lima_repro_claim(o,s,a,'s:fallo-real',now());
  if not (v->>'claimed')::boolean then raise exception 'FAIL real failure not attendable'; end if;
  if (select close_reason from lima_repro_cases where id=c) <> 'nuevo_intento' then raise exception 'FAIL previous attention history lost'; end if;
  if (select count(*) from lima_repro_calls where case_id=c) <> 1 then raise exception 'FAIL previous call history lost'; end if;
end $$;
rollback;
