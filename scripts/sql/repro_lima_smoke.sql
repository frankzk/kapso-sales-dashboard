\set ON_ERROR_STOP on
-- 0249: «Repro Lima» (MOM §9.5, §11.4). Corre en el clúster desechable de
-- verify-db, después de todas las migraciones, dentro de una transacción que se
-- deshace. Reutiliza las tiendas y usuarios de rls_smoke.sql: A (viewer de la
-- tienda A), B (viewer de la B), C (owner de las dos), D (viewer sin tiendas).
--
-- Lo que se fija aquí lo garantiza la base y no solo el código:
--   · la fecha que pidió el cliente solo existe en un «No entregado ·
--     Reprogramado»;
--   · un caso abierto por pedido, perezoso, con episodio: un fallo más nuevo
--     cierra el caso viejo (`nuevo_intento`) y uno más viejo no lo toca;
--   · el candado de 10 minutos: otra persona recibe `claimed:false`, uno
--     vencido se puede tomar, sin candado no se registra nada;
--   · un «Desarmar y cerrar» del mismo episodio no se reabre sin el segundo
--     clic (`needs_reopen`, `p_reopen`, E29); un episodio nuevo sí abre caso;
--   · cuatro resultados con su forma, idempotencia por `operation_id` (y
--     rechazo del mismo envío con otro contenido), el acuerdo que fija
--     `confirma` y vacían `llamar_despues`/`no_quiere`, el cierre atómico con su
--     evento, también sin llamada (`sin_contacto`);
--   · llamadas append-only, lecturas por tienda, escrituras solo del servidor.
--
-- Ojo: dentro de una transacción `now()` no avanza. Un candado «vencido» se
-- simula moviendo `claimed_until` hacia atrás.
begin;

insert into orders(id,store_id,shopify_order_id,name) values
 -- #RL1: el caso principal (en la etapa).
 ('24900000-0000-0000-0000-000000000011','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','rl-1','#RL1'),
 -- #RL2: en curso, pero en otra subetapa.
 ('24900000-0000-0000-0000-000000000012','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','rl-2','#RL2'),
 -- #RL3: en la etapa al abrir el caso; después sale de ella.
 ('24900000-0000-0000-0000-000000000013','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','rl-3','#RL3'),
 -- #RL4: «Desarmar y cerrar» sin llamada.
 ('24900000-0000-0000-0000-000000000014','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','rl-4','#RL4'),
 -- #RL5: de la tienda B (lecturas por tienda).
 ('24900000-0000-0000-0000-000000000015','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','rl-5','#RL5'),
 -- #RL6: sin fila en el Master.
 ('24900000-0000-0000-0000-000000000016','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','rl-6','#RL6');
insert into order_master(order_id,store_id,shopify_order_id,order_name,macro_stage,macro_substage,macro_since) values
 ('24900000-0000-0000-0000-000000000011','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','rl-1','#RL1','en_curso','por_reprogramar_lima',now() - interval '2 days'),
 ('24900000-0000-0000-0000-000000000012','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','rl-2','#RL2','en_curso','en_ruta',now() - interval '1 day'),
 ('24900000-0000-0000-0000-000000000013','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','rl-3','#RL3','en_curso','por_reprogramar_lima',now() - interval '1 day'),
 ('24900000-0000-0000-0000-000000000014','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','rl-4','#RL4','en_curso','por_reprogramar_lima',now() - interval '12 days'),
 ('24900000-0000-0000-0000-000000000015','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','rl-5','#RL5','en_curso','por_reprogramar_lima',now() - interval '1 day');

-- ── La fecha que pidió el cliente ───────────────────────────────────────────
do $$
declare
  v_route uuid := '24900000-0000-0000-0000-000000000021';
  v_stop  uuid := '24900000-0000-0000-0000-000000000022';
begin
  insert into riders(id,org_id,full_name,courier) values
    ('24900000-0000-0000-0000-000000000020','33333333-3333-3333-3333-333333333333','Roy smoke 0249','Grupo GF Courier');
  insert into delivery_routes(id,org_id,store_id,rider_id,route_date) values
    (v_route,'33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','24900000-0000-0000-0000-000000000020',current_date);
  insert into delivery_stops(id,route_id,order_id,store_id) values
    (v_stop,v_route,'24900000-0000-0000-0000-000000000011','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

  -- Pendiente con fecha: no.
  begin
    update delivery_stops set requested_date = current_date + 2 where id = v_stop;
    raise exception 'FAIL requested_date on a pending stop';
  exception when check_violation then null;
  end;
  -- Un «No entregado» por otro motivo con fecha: no.
  begin
    update delivery_stops set status='no_entregado', outcome_reason='no_contesta', reported_at=now(),
           requested_date = current_date + 2 where id = v_stop;
    raise exception 'FAIL requested_date on a no_contesta stop';
  exception when check_violation then null;
  end;
  -- «No entregado · Reprogramado» con fecha: sí.
  update delivery_stops set status='no_entregado', outcome_reason='reprogramado', reported_at=now(),
         requested_date = current_date + 2 where id = v_stop;
  -- Una fecha que ya pasó también: el cuaderno se carga días después.
  update delivery_stops set requested_date = current_date - 3 where id = v_stop;
  -- Cambiar el motivo dejando la fecha: no.
  begin
    update delivery_stops set outcome_reason='no_contesta' where id = v_stop;
    raise exception 'FAIL reason changed with the date kept';
  exception when check_violation then null;
  end;
  -- Entregarla dejando la fecha: no.
  begin
    update delivery_stops set status='entregado', payment_method='efectivo', collected_amount=0 where id = v_stop;
    raise exception 'FAIL delivered with the date kept';
  exception when check_violation then null;
  end;
  -- Cambiar el motivo borrando la fecha: sí (lo que hace writeStopReport).
  update delivery_stops set outcome_reason='no_contesta', requested_date = null where id = v_stop;
  if (select requested_date from delivery_stops where id = v_stop) is not null then raise exception 'requested_date not cleared'; end if;
end $$;

-- ── Tomar el caso ───────────────────────────────────────────────────────────
do $$
declare
  a  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  b  uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  ua uuid := '00000000-0000-0000-0000-00000000000a';
  uc uuid := '00000000-0000-0000-0000-00000000000c';
  o1 uuid := '24900000-0000-0000-0000-000000000011';
  o2 uuid := '24900000-0000-0000-0000-000000000012';
  o3 uuid := '24900000-0000-0000-0000-000000000013';
  o6 uuid := '24900000-0000-0000-0000-000000000016';
  t1 timestamptz := now() - interval '1 day';
  v  jsonb;
  c1 uuid;
  c2 uuid;
  c3 uuid;
  r  record;
begin
  -- El pedido tiene que ser de la tienda indicada.
  begin
    perform lima_repro_claim(o1, b, ua, 's:1|o:-', t1, 10);
    raise exception 'FAIL claimed with the wrong store';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'El pedido no pertenece a la tienda indicada.' then raise exception 'expected the store check, got %', sqlerrm; end if;
  end;
  -- El candado dura entre 1 y 15 minutos.
  begin
    perform lima_repro_claim(o1, a, ua, 's:1|o:-', t1, 0);
    raise exception 'FAIL ttl 0 accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    perform lima_repro_claim(o1, a, ua, 's:1|o:-', t1, 16);
    raise exception 'FAIL ttl 16 accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  if exists (select 1 from lima_repro_cases where order_id = o1) then raise exception 'a refused claim opened a case'; end if;

  -- El primer gesto abre el caso y entrega el candado.
  v := lima_repro_claim(o1, a, ua, 's:1|o:-', t1, 10);
  if not (v->>'claimed')::boolean then raise exception 'first claim not granted: %', v; end if;
  c1 := (v->>'case_id')::uuid;
  select * into r from lima_repro_cases where id = c1;
  if r.order_id <> o1 or r.store_id <> a or r.episode_key <> 's:1|o:-' or r.episode_at <> t1 or r.opened_by <> ua then
    raise exception 'case opened wrong: %', row_to_json(r);
  end if;
  if r.claimed_by <> ua or r.claimed_until <> now() + interval '10 minutes' then raise exception 'claim not set: %', row_to_json(r); end if;
  if r.call_count <> 0 or r.closed_at is not null or r.agreed_on is not null then raise exception 'new case not empty: %', row_to_json(r); end if;

  -- Otra persona: `claimed:false` con quién y hasta cuándo.
  v := lima_repro_claim(o1, a, uc, 's:1|o:-', t1, 10);
  if (v->>'claimed')::boolean then raise exception 'second user got the claim: %', v; end if;
  if (v->>'case_id')::uuid <> c1 or (v->>'holder')::uuid <> ua or (v->>'until')::timestamptz <> now() + interval '10 minutes' then
    raise exception 'claimed:false without holder/until: %', v;
  end if;
  if (select claimed_by from lima_repro_cases where id = c1) <> ua then raise exception 'second user moved the claim'; end if;
  -- La misma persona lo renueva sobre el mismo caso.
  v := lima_repro_claim(o1, a, ua, 's:1|o:-', t1, 5);
  if not (v->>'claimed')::boolean or (v->>'case_id')::uuid <> c1 then raise exception 'renew failed: %', v; end if;
  if (select claimed_until from lima_repro_cases where id = c1) <> now() + interval '5 minutes' then raise exception 'renew did not move until'; end if;

  -- Un segundo caso abierto del mismo pedido: lo impide el índice.
  begin
    insert into lima_repro_cases(store_id,order_id,episode_key,episode_at) values (a, o1, 's:1|o:-', t1);
    raise exception 'FAIL second open case';
  exception when unique_violation then null;
  end;

  -- Candado vencido: otra persona lo toma.
  update lima_repro_cases set claimed_until = now() - interval '1 minute' where id = c1;
  v := lima_repro_claim(o1, a, uc, 's:1|o:-', t1, 10);
  if not (v->>'claimed')::boolean or (v->>'case_id')::uuid <> c1 then raise exception 'expired claim not taken over: %', v; end if;
  if (select claimed_by from lima_repro_cases where id = c1) <> uc then raise exception 'take-over did not set the holder'; end if;

  -- Un episodio MÁS VIEJO no cierra el caso: quien llama leyó hechos de antes.
  begin
    perform lima_repro_claim(o1, a, ua, 's:0|o:-', t1 - interval '1 hour', 10);
    raise exception 'FAIL an older episode was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'El pedido cambió mientras lo abrías: vuelve a intentarlo.' then raise exception 'expected the stale-episode refusal, got %', sqlerrm; end if;
  end;
  -- Ni uno del mismo momento, ni uno sin momento.
  begin
    perform lima_repro_claim(o1, a, ua, 's:0|o:-', t1, 10);
    raise exception 'FAIL a same-time episode was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'El pedido cambió mientras lo abrías: vuelve a intentarlo.' then raise exception 'expected the stale-episode refusal, got %', sqlerrm; end if;
  end;
  begin
    perform lima_repro_claim(o1, a, ua, 'order:' || o1::text, null, 10);
    raise exception 'FAIL an episode without time was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'El pedido cambió mientras lo abrías: vuelve a intentarlo.' then raise exception 'expected the stale-episode refusal, got %', sqlerrm; end if;
  end;
  select * into r from lima_repro_cases where id = c1;
  if r.closed_at is not null or r.episode_key <> 's:1|o:-' or r.claimed_by <> uc then raise exception 'stale episode touched the case: %', row_to_json(r); end if;

  -- Un episodio MÁS NUEVO cierra el caso viejo (`nuevo_intento`, sin candado,
  -- sin quién) y abre otro, aunque el viejo tuviera un candado vivo.
  v := lima_repro_claim(o1, a, ua, 's:2|o:-', t1 + interval '1 hour', 10);
  if not (v->>'claimed')::boolean then raise exception 'newer episode not claimed: %', v; end if;
  c2 := (v->>'case_id')::uuid;
  if c2 = c1 then raise exception 'newer episode reused the old case'; end if;
  select * into r from lima_repro_cases where id = c1;
  if r.closed_at is null or r.close_reason <> 'nuevo_intento' or r.claimed_by is not null or r.claimed_until is not null or r.closed_by is not null then
    raise exception 'old episode not closed as nuevo_intento: %', row_to_json(r);
  end if;
  select * into r from lima_repro_cases where id = c2;
  if r.episode_key <> 's:2|o:-' or r.episode_at <> t1 + interval '1 hour' or r.claimed_by <> ua or r.closed_at is not null then
    raise exception 'new episode case wrong: %', row_to_json(r);
  end if;
  if (select count(*) from lima_repro_cases where order_id = o1 and closed_at is null) <> 1 then raise exception 'not exactly one open case'; end if;
  -- El cierre automático no escribe evento.
  if exists (select 1 from order_events where order_id = o1 and kind like 'lima_repro_%') then raise exception 'automatic close wrote an event'; end if;

  -- Fuera de la etapa no se abre caso.
  begin
    perform lima_repro_claim(o2, a, ua, 's:9|o:-', t1, 10);
    raise exception 'FAIL claimed an order out of the stage';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'Este pedido ya no está en «Por reprogramar Lima».' then raise exception 'expected the stage check, got %', sqlerrm; end if;
  end;
  begin
    perform lima_repro_claim(o6, a, ua, 's:9|o:-', t1, 10);
    raise exception 'FAIL claimed an order without Master row';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'Este pedido ya no está en «Por reprogramar Lima».' then raise exception 'expected the stage check, got %', sqlerrm; end if;
  end;
  if exists (select 1 from lima_repro_cases where order_id in (o2, o6)) then raise exception 'out-of-stage claim opened a case'; end if;

  -- Ni se toma el caso abierto de un pedido que ya salió de la etapa, aunque
  -- sea del mismo episodio y de la misma persona.
  v := lima_repro_claim(o3, a, ua, 's:3|o:-', t1, 10);
  c3 := (v->>'case_id')::uuid;
  update order_master set macro_substage = 'en_ruta' where order_id = o3;
  update lima_repro_cases set claimed_until = now() - interval '1 minute' where id = c3;
  begin
    perform lima_repro_claim(o3, a, uc, 's:3|o:-', t1, 10);
    raise exception 'FAIL claimed an open case out of the stage';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'Este pedido ya no está en «Por reprogramar Lima».' then raise exception 'expected the stage check, got %', sqlerrm; end if;
  end;
  begin
    perform lima_repro_claim(o3, a, ua, 's:3|o:-', t1, 10);
    raise exception 'FAIL renewed an open case out of the stage';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'Este pedido ya no está en «Por reprogramar Lima».' then raise exception 'expected the stage check, got %', sqlerrm; end if;
  end;
  if (select claimed_by from lima_repro_cases where id = c3) <> ua then raise exception 'out-of-stage claim moved the holder'; end if;
  -- Un fallo nuevo tampoco abre caso fuera de la etapa (y el viejo no se pierde).
  begin
    perform lima_repro_claim(o3, a, ua, 's:4|o:-', t1 + interval '1 hour', 10);
    raise exception 'FAIL newer episode opened a case out of the stage';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'Este pedido ya no está en «Por reprogramar Lima».' then raise exception 'expected the stage check, got %', sqlerrm; end if;
  end;
  if (select closed_at from lima_repro_cases where id = c3) is not null then raise exception 'refused claim closed the case'; end if;
end $$;

-- ── Registrar llamadas ──────────────────────────────────────────────────────
do $$
declare
  a     uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  ua    uuid := '00000000-0000-0000-0000-00000000000a';
  uc    uuid := '00000000-0000-0000-0000-00000000000c';
  o1    uuid := '24900000-0000-0000-0000-000000000011';
  op1   uuid := '24900000-0000-0000-0000-0000000000a1';
  op2   uuid := '24900000-0000-0000-0000-0000000000a2';
  op3   uuid := '24900000-0000-0000-0000-0000000000a3';
  op4   uuid := '24900000-0000-0000-0000-0000000000a4';
  op5   uuid := '24900000-0000-0000-0000-0000000000a5';
  op6   uuid := '24900000-0000-0000-0000-0000000000a6';
  op7   uuid := '24900000-0000-0000-0000-0000000000a7';
  opx   uuid := '24900000-0000-0000-0000-0000000000af';
  k     text := 's:2|o:-';
  today date := (now() at time zone 'America/Lima')::date;
  c     uuid;
  v     jsonb;
  call1 uuid;
  call2 uuid;
  call4 uuid;
  r     record;
  e     record;
begin
  select id into c from lima_repro_cases where order_id = o1 and closed_at is null;

  -- Sin el caso.
  begin
    perform lima_repro_record(gen_random_uuid(), ua, opx, k, 'no_contesta', 'llamada');
    raise exception 'FAIL recorded on a missing case';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'No encontramos el caso.' then raise exception 'expected the missing case, got %', sqlerrm; end if;
  end;
  -- Sin el candado: el caso es de A.
  begin
    perform lima_repro_record(c, uc, opx, k, 'no_contesta', 'llamada');
    raise exception 'FAIL recorded without the claim';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'Ya no tienes este caso: vuelve a tomarlo.' then raise exception 'expected the claim check, got %', sqlerrm; end if;
  end;
  -- Con el candado propio vencido, tampoco.
  update lima_repro_cases set claimed_until = now() - interval '1 second' where id = c;
  begin
    perform lima_repro_record(c, ua, opx, k, 'no_contesta', 'llamada');
    raise exception 'FAIL recorded with an expired claim';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'Ya no tienes este caso: vuelve a tomarlo.' then raise exception 'expected the claim check, got %', sqlerrm; end if;
  end;
  update lima_repro_cases set claimed_until = now() + interval '10 minutes' where id = c;
  -- Con otro episodio: el pedido tuvo otro intento.
  begin
    perform lima_repro_record(c, ua, opx, 's:1|o:-', 'no_contesta', 'llamada');
    raise exception 'FAIL recorded on another episode';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'El pedido tuvo otro intento de entrega: vuelve a abrirlo.' then raise exception 'expected the episode check, got %', sqlerrm; end if;
  end;
  -- Resultado y canal del catálogo.
  begin
    perform lima_repro_record(c, ua, opx, k, 'confirmado', 'llamada');
    raise exception 'FAIL unknown outcome';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'no_contesta', 'mensaje');
    raise exception 'FAIL unknown channel';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  -- «No contesta»: cuenta el intento y renueva el candado.
  v := lima_repro_record(c, ua, op1, k, 'no_contesta', 'llamada',
                         p_next_call_at => now() + interval '2 hours', p_note => 'Buzón de voz',
                         p_event_note => 'Repro Lima · No contesta (intento 1). Próxima: hoy 15:00.');
  if (v->>'duplicate')::boolean then raise exception 'first call flagged duplicate'; end if;
  call1 := (v->>'call_id')::uuid;
  select * into r from lima_repro_cases where id = c;
  if r.call_count <> 1 or r.no_answer_count <> 1 or r.last_outcome <> 'no_contesta' or r.last_call_at <> now()
     or r.next_call_at <> now() + interval '2 hours' or r.claimed_until <> now() + interval '10 minutes' then
    raise exception 'no_contesta counters wrong: %', row_to_json(r);
  end if;
  select * into e from order_events where order_id = o1 and operation_id = op1;
  if e.kind <> 'lima_repro_call' or e.source <> 'repro_lima' or e.actor <> ua
     or e.note <> 'Repro Lima · No contesta (intento 1). Próxima: hoy 15:00.'
     or (e.payload->>'case_id')::uuid <> c or (e.payload->>'call_id')::uuid <> call1
     or e.payload->>'outcome' <> 'no_contesta' or e.payload->>'channel' <> 'llamada' then
    raise exception 'no_contesta event wrong: %', row_to_json(e);
  end if;
  if (select note from lima_repro_calls where id = call1) <> 'Buzón de voz' then raise exception 'call note not kept'; end if;

  -- El mismo envío otra vez: la misma llamada, nada se cuenta dos veces.
  v := lima_repro_record(c, ua, op1, k, 'no_contesta', 'llamada', p_next_call_at => now() + interval '2 hours');
  if not (v->>'duplicate')::boolean or (v->>'call_id')::uuid <> call1 then raise exception 'repeat not a duplicate: %', v; end if;
  select * into r from lima_repro_cases where id = c;
  if r.call_count <> 1 or r.no_answer_count <> 1 then raise exception 'duplicate counted twice: %', row_to_json(r); end if;
  if (select count(*) from lima_repro_calls where operation_id = op1) <> 1 then raise exception 'duplicate call row'; end if;
  if (select count(*) from order_events where operation_id = op1) <> 1 then raise exception 'duplicate event'; end if;
  -- El mismo envío con otro resultado es otro formulario: se rechaza.
  begin
    perform lima_repro_record(c, ua, op1, k, 'llamar_despues', 'llamada', p_next_call_at => now() + interval '1 day');
    raise exception 'FAIL same operation with another outcome';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'Ya se guardó otra llamada con este envío: vuelve a abrir el caso.' then raise exception 'expected the content mismatch, got %', sqlerrm; end if;
  end;

  -- «Confirma»: fija el acuerdo, sin programar, y su evento.
  v := lima_repro_record(c, ua, op2, k, 'confirma', 'whatsapp',
                         p_agreed_on => today + 2, p_courier => 'propio',
                         p_changes => '{"direccion": true}'::jsonb, p_box_action => 'reimprimir_misma_salida',
                         p_box_location => 'con_motorizado',
                         p_event_note => 'Repro Lima · Confirma (WhatsApp): sale con Grupo GF.');
  call2 := (v->>'call_id')::uuid;
  select * into r from lima_repro_cases where id = c;
  if r.agreement_call_id <> call2 or r.agreed_on <> today + 2 or r.agreed_courier <> 'propio'
     or r.changes <> '{"direccion": true}'::jsonb or r.box_action <> 'reimprimir_misma_salida'
     or r.box_location <> 'con_motorizado' or r.decided_by <> ua or r.decided_at <> now()
     or r.materialized_at is not null or r.next_call_at is not null
     or r.call_count <> 2 or r.no_answer_count <> 1 or r.last_outcome <> 'confirma' or r.claimed_by <> ua then
    raise exception 'confirma did not set the agreement: %', row_to_json(r);
  end if;
  select * into e from order_events where order_id = o1 and operation_id = op2;
  if e.kind <> 'lima_repro_agreed' or (e.payload->>'agreed_on')::date <> today + 2 or e.payload->>'courier' <> 'propio'
     or e.payload->>'box_action' <> 'reimprimir_misma_salida' or e.payload->'changes' <> '{"direccion": true}'::jsonb then
    raise exception 'confirma event wrong: %', row_to_json(e);
  end if;
  -- El mismo envío con otra fecha: se rechaza; con la misma, duplicado.
  begin
    perform lima_repro_record(c, ua, op2, k, 'confirma', 'whatsapp', p_agreed_on => today + 3, p_courier => 'propio',
                              p_box_action => 'reimprimir_misma_salida');
    raise exception 'FAIL same operation with another date';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'Ya se guardó otra llamada con este envío: vuelve a abrir el caso.' then raise exception 'expected the content mismatch, got %', sqlerrm; end if;
  end;
  v := lima_repro_record(c, ua, op2, k, 'confirma', 'whatsapp', p_agreed_on => today + 2, p_courier => 'propio',
                         p_box_action => 'reimprimir_misma_salida');
  if not (v->>'duplicate')::boolean or (v->>'call_id')::uuid <> call2 then raise exception 'confirma repeat not a duplicate: %', v; end if;
  if (select call_count from lima_repro_cases where id = c) <> 2 then raise exception 'confirma duplicate counted'; end if;

  -- Fechas: hoy (Lima) a 60 días; la próxima llamada, futura y a 60 días.
  begin
    perform lima_repro_record(c, ua, opx, k, 'confirma', 'llamada', p_agreed_on => today - 1, p_courier => 'propio', p_box_action => 'mantener');
    raise exception 'FAIL past agreed_on';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'La nueva fecha no puede ser anterior a hoy.' then raise exception 'expected the past-date check, got %', sqlerrm; end if;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'confirma', 'llamada', p_agreed_on => today + 61, p_courier => 'propio', p_box_action => 'mantener');
    raise exception 'FAIL agreed_on in 61 days';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'La nueva fecha no puede pasar de 60 días.' then raise exception 'expected the 60-day check, got %', sqlerrm; end if;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'llamar_despues', 'llamada', p_next_call_at => now() - interval '1 minute');
    raise exception 'FAIL past next_call_at';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'Elige una hora que todavía no pasó.' then raise exception 'expected the past-call check, got %', sqlerrm; end if;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'no_contesta', 'llamada', p_next_call_at => now() + interval '61 days');
    raise exception 'FAIL next_call_at in 61 days';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'La próxima llamada no puede pasar de 60 días.' then raise exception 'expected the 60-day call check, got %', sqlerrm; end if;
  end;

  -- La forma de cada resultado.
  begin
    perform lima_repro_record(c, ua, opx, k, 'confirma', 'llamada', p_agreed_on => today, p_courier => 'propio', p_box_action => 'desarmar_cerrar');
    raise exception 'FAIL confirma with desarmar_cerrar';
  exception when check_violation then null;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'confirma', 'llamada', p_agreed_on => today, p_box_action => 'mantener');
    raise exception 'FAIL confirma without courier';
  exception when check_violation then null;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'confirma', 'llamada', p_courier => 'propio', p_box_action => 'mantener');
    raise exception 'FAIL confirma without date';
  exception when check_violation then null;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'confirma', 'llamada', p_agreed_on => today, p_courier => 'swayp', p_box_action => 'mantener');
    raise exception 'FAIL courier swayp (it is fenix)';
  exception when check_violation then null;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'llamar_despues', 'llamada');
    raise exception 'FAIL llamar_despues without time';
  exception when check_violation then null;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'no_contesta', 'llamada', p_agreed_on => today);
    raise exception 'FAIL no_contesta with a date';
  exception when check_violation then null;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'no_quiere', 'llamada', p_box_action => 'desarmar_cerrar', p_note => 'corto  ');
    raise exception 'FAIL no_quiere with a short reason';
  exception when check_violation then null;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'no_quiere', 'llamada', p_note => 'Ya lo compró en otra tienda');
    raise exception 'FAIL no_quiere without desarmar_cerrar';
  exception when check_violation then null;
  end;
  begin
    perform lima_repro_record(c, ua, opx, k, 'no_contesta', 'sin_contacto');
    raise exception 'FAIL sin_contacto on a call outcome';
  exception when check_violation then null;
  end;
  if exists (select 1 from lima_repro_calls where operation_id = opx) then raise exception 'a refused call was stored'; end if;
  if (select call_count from lima_repro_cases where id = c) <> 2 then raise exception 'a refused call was counted'; end if;

  -- Programado (la marca condicional del servidor) y después «No contesta»:
  -- el acuerdo vigente se conserva tal cual.
  update lima_repro_cases set materialized_at = now(), materialized_on = today + 2
   where id = c and agreement_call_id = call2 and materialized_at is null and closed_at is null;
  if not found then raise exception 'materialization mark failed'; end if;
  perform lima_repro_record(c, ua, op3, k, 'no_contesta', 'llamada');
  select * into r from lima_repro_cases where id = c;
  if r.agreement_call_id <> call2 or r.agreed_on <> today + 2 or r.box_action <> 'reimprimir_misma_salida'
     or r.materialized_on <> today + 2 or r.decided_by <> ua or r.next_call_at is not null
     or r.call_count <> 3 or r.no_answer_count <> 2 then
    raise exception 'no_contesta did not keep the agreement: %', row_to_json(r);
  end if;

  -- Un acuerdo nuevo reemplaza al anterior y queda sin programar.
  v := lima_repro_record(c, ua, op4, k, 'confirma', 'llamada', p_agreed_on => today, p_courier => 'tanders',
                         p_box_action => 'salida_nueva_rearmar', p_box_location => 'volviendo_courier');
  call4 := (v->>'call_id')::uuid;
  select * into r from lima_repro_cases where id = c;
  if r.agreement_call_id <> call4 or r.agreed_on <> today or r.agreed_courier <> 'tanders'
     or r.changes <> '{}'::jsonb or r.materialized_at is not null or r.materialized_on is not null then
    raise exception 'new agreement not reset: %', row_to_json(r);
  end if;

  -- «Llamar después» vacía el acuerdo; la historia queda en las llamadas.
  perform lima_repro_record(c, ua, op5, k, 'llamar_despues', 'llamada', p_next_call_at => now() + interval '1 day',
                            p_event_note => 'Repro Lima · Llamar el lun 13/10 15:00.');
  select * into r from lima_repro_cases where id = c;
  if r.agreement_call_id is not null or r.agreed_on is not null or r.agreed_courier is not null or r.changes <> '{}'::jsonb
     or r.box_action is not null or r.box_location is not null or r.decided_by is not null or r.decided_at is not null
     or r.materialized_at is not null or r.next_call_at <> now() + interval '1 day' or r.last_outcome <> 'llamar_despues'
     or r.call_count <> 5 or r.closed_at is not null or r.claimed_by <> ua then
    raise exception 'llamar_despues did not clear the agreement: %', row_to_json(r);
  end if;
  if (select kind from order_events where operation_id = op5) <> 'lima_repro_call' then raise exception 'llamar_despues event kind'; end if;
  if (select count(*) from lima_repro_calls where case_id = c and outcome = 'confirma') <> 2 then raise exception 'agreement history lost'; end if;

  -- «No quiere» con un acuerdo vigente: cierra, suelta el candado y vacía el
  -- acuerdo, todo con su evento.
  perform lima_repro_record(c, ua, op6, k, 'confirma', 'llamada', p_agreed_on => today + 1, p_courier => 'propio',
                            p_box_action => 'mantener', p_box_location => 'en_oficina');
  perform lima_repro_record(c, ua, op7, k, 'no_quiere', 'llamada', p_box_action => 'desarmar_cerrar',
                            p_box_location => 'en_oficina', p_note => '  Ya lo compró en otra tienda  ',
                            p_event_note => 'Repro Lima · No quiere: «Ya lo compró en otra tienda». Desarmar y cerrar; no anula la venta.');
  select * into r from lima_repro_cases where id = c;
  if r.closed_at <> now() or r.closed_by <> ua or r.close_reason <> 'desarmar_cerrar' or r.close_note <> 'Ya lo compró en otra tienda'
     or r.claimed_by is not null or r.claimed_until is not null or r.box_action <> 'desarmar_cerrar'
     or r.agreement_call_id is not null or r.agreed_on is not null or r.decided_at is not null or r.box_location is not null
     or r.next_call_at is not null or r.last_outcome <> 'no_quiere' or r.call_count <> 7 then
    raise exception 'no_quiere did not close: %', row_to_json(r);
  end if;
  select * into e from order_events where order_id = o1 and operation_id = op7;
  if e.kind <> 'lima_repro_closed' or e.payload->>'box_action' <> 'desarmar_cerrar' or e.note not like 'Repro Lima · No quiere:%' then
    raise exception 'no_quiere event wrong: %', row_to_json(e);
  end if;
  -- El reintento del cierre es un duplicado, no un error.
  v := lima_repro_record(c, ua, op7, k, 'no_quiere', 'llamada', p_box_action => 'desarmar_cerrar', p_note => 'Ya lo compró en otra tienda');
  if not (v->>'duplicate')::boolean then raise exception 'close retry not a duplicate: %', v; end if;
  -- Otra llamada sobre el caso cerrado, no.
  begin
    perform lima_repro_record(c, ua, opx, k, 'no_contesta', 'llamada');
    raise exception 'FAIL recorded on a closed case';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'El caso ya está cerrado.' then raise exception 'expected the closed check, got %', sqlerrm; end if;
  end;
  if (select count(*) from order_events where order_id = o1 and kind like 'lima_repro_%') <> 7 then
    raise exception 'expected one event per call, got %', (select count(*) from order_events where order_id = o1 and kind like 'lima_repro_%');
  end if;

  -- Tomarlo otra vez en el mismo episodio, sin el segundo clic: no abre caso
  -- (`needs_reopen`), lo mismo con `p_reopen` nulo (E29). Cuenta el ÚLTIMO
  -- cerrado: el `nuevo_intento` del episodio anterior se cerró antes (aquí
  -- `now()` no avanza, así que se mueve hacia atrás).
  update lima_repro_cases set opened_at = now() - interval '2 hours', closed_at = now() - interval '1 hour'
   where order_id = o1 and close_reason = 'nuevo_intento';
  v := lima_repro_claim(o1, a, ua, k, now() - interval '1 day', 10);
  if (v->>'claimed')::boolean or not coalesce((v->>'needs_reopen')::boolean, false) or v ? 'case_id' then
    raise exception 'same-episode claim after desarmar_cerrar did not ask to reopen: %', v;
  end if;
  v := lima_repro_claim(o1, a, uc, k, now() - interval '1 day', 10, null);
  if (v->>'claimed')::boolean or not coalesce((v->>'needs_reopen')::boolean, false) then
    raise exception 'null p_reopen reopened the case: %', v;
  end if;
  if exists (select 1 from lima_repro_cases where order_id = o1 and closed_at is null) then
    raise exception 'needs_reopen opened a case';
  end if;
  -- Un fallo nuevo (otro episodio) sí abre caso sin el segundo clic. Se
  -- deshace en el acto: el resto del archivo cuenta los casos de #RL1.
  begin
    v := lima_repro_claim(o1, a, ua, 's:7|o:-', now(), 10);
    if not (v->>'claimed')::boolean or v ? 'needs_reopen' then raise exception 'FAIL new episode asked to reopen: %', v; end if;
    raise exception 'ROLLBACK new episode probe';
  exception when others then
    if sqlerrm <> 'ROLLBACK new episode probe' then raise; end if;
  end;
  -- «Volver a atender» el mismo episodio (`p_reopen`): otro caso, el cerrado
  -- queda como está.
  v := lima_repro_claim(o1, a, ua, k, now() - interval '1 day', 10, p_reopen => true);
  if not (v->>'claimed')::boolean or (v->>'case_id')::uuid = c then raise exception 'reopen did not open a new case: %', v; end if;
  if (select close_reason from lima_repro_cases where id = c) <> 'desarmar_cerrar' then raise exception 'reopen touched the closed case'; end if;
  -- Ya abierto, tomarlo otra vez no pide reabrir: es el mismo caso.
  v := lima_repro_claim(o1, a, ua, k, now() - interval '1 day', 10);
  if not (v->>'claimed')::boolean or v ? 'needs_reopen' then raise exception 'open reopened case asked to reopen: %', v; end if;
end $$;

-- ── «Desarmar y cerrar» sin llamada ─────────────────────────────────────────
do $$
declare
  a   uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  uc  uuid := '00000000-0000-0000-0000-00000000000c';
  o4  uuid := '24900000-0000-0000-0000-000000000014';
  op  uuid := '24900000-0000-0000-0000-0000000000b1';
  c   uuid;
  v   jsonb;
  r   record;
  e   record;
begin
  v := lima_repro_claim(o4, a, uc, 's:4|o:-', now() - interval '12 days', 10);
  c := (v->>'case_id')::uuid;
  v := lima_repro_record(c, uc, op, 's:4|o:-', 'no_quiere', 'sin_contacto',
                         p_box_action => 'desarmar_cerrar', p_box_location => 'en_oficina',
                         p_note => 'Diez días en oficina y tres llamadas sin respuesta',
                         p_event_note => 'Repro Lima · Desarmar y cerrar sin llamada; no anula la venta.');
  select * into r from lima_repro_cases where id = c;
  if r.close_reason <> 'desarmar_cerrar' or r.closed_by <> uc or r.claimed_by is not null or r.box_action <> 'desarmar_cerrar' then
    raise exception 'sin_contacto did not close: %', row_to_json(r);
  end if;
  -- No fue una llamada: no cuenta como intento.
  if r.call_count <> 0 or r.last_call_at is not null or r.last_outcome is not null then
    raise exception 'sin_contacto counted as a call: %', row_to_json(r);
  end if;
  if (select channel from lima_repro_calls where id = (v->>'call_id')::uuid) <> 'sin_contacto' then raise exception 'sin_contacto call row'; end if;
  select * into e from order_events where order_id = o4 and operation_id = op;
  if e.kind <> 'lima_repro_closed' or e.payload->>'channel' <> 'sin_contacto' or e.actor <> uc then
    raise exception 'sin_contacto event wrong: %', row_to_json(e);
  end if;
end $$;

-- ── Llamadas append-only ────────────────────────────────────────────────────
do $$
begin
  begin
    update lima_repro_calls set note = 'reescrito' where order_id = '24900000-0000-0000-0000-000000000011';
    raise exception 'FAIL updated a call';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'La tabla lima_repro_calls es append-only%' then raise exception 'expected append-only, got %', sqlerrm; end if;
  end;
  begin
    delete from lima_repro_calls where order_id = '24900000-0000-0000-0000-000000000011';
    raise exception 'FAIL deleted a call';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'La tabla lima_repro_calls es append-only%' then raise exception 'expected append-only, got %', sqlerrm; end if;
  end;
  -- Un caso cerrado no conserva el candado.
  begin
    update lima_repro_cases set claimed_by = '00000000-0000-0000-0000-00000000000a', claimed_until = now() + interval '5 minutes'
     where order_id = '24900000-0000-0000-0000-000000000014';
    raise exception 'FAIL claim on a closed case';
  exception when check_violation then null;
  end;
end $$;

-- ── El servidor cierra lo que salió de la etapa (la carga de la pantalla) ───
set role service_role;
do $$
declare n int;
begin
  update lima_repro_cases
     set closed_at = now(), close_reason = 'fuera_de_etapa', claimed_by = null, claimed_until = null
   where order_id = '24900000-0000-0000-0000-000000000013' and closed_at is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'stale close by the server closed % rows', n; end if;
  -- Un acuerdo sin la llamada que lo fijó, no.
  begin
    update lima_repro_cases set agreed_on = current_date where order_id = '24900000-0000-0000-0000-000000000011' and closed_at is null;
    raise exception 'FAIL half an agreement';
  exception when check_violation then null;
  end;
  -- El servidor tampoco reescribe ni borra la historia.
  begin
    delete from lima_repro_cases where order_id = '24900000-0000-0000-0000-000000000013';
    raise exception 'FAIL service_role deleted a case';
  exception when insufficient_privilege then null;
  end;
  begin
    update lima_repro_calls set note = 'x' where order_id = '24900000-0000-0000-0000-000000000011';
    raise exception 'FAIL service_role updated a call';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── Lecturas por tienda; escrituras solo del servidor ───────────────────────
do $$
declare v jsonb;
begin
  v := lima_repro_claim('24900000-0000-0000-0000-000000000015', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                        '00000000-0000-0000-0000-00000000000b', 's:5|o:-', now() - interval '1 day', 10);
  perform lima_repro_record((v->>'case_id')::uuid, '00000000-0000-0000-0000-00000000000b',
                            '24900000-0000-0000-0000-0000000000c1', 's:5|o:-', 'no_contesta', 'llamada');

  if has_table_privilege('authenticated', 'public.lima_repro_cases', 'INSERT')
     or has_table_privilege('authenticated', 'public.lima_repro_cases', 'UPDATE')
     or has_table_privilege('authenticated', 'public.lima_repro_cases', 'DELETE')
     or has_table_privilege('authenticated', 'public.lima_repro_cases', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.lima_repro_calls', 'INSERT')
     or has_table_privilege('authenticated', 'public.lima_repro_calls', 'UPDATE')
     or has_table_privilege('authenticated', 'public.lima_repro_calls', 'DELETE')
     or has_table_privilege('authenticated', 'public.lima_repro_calls', 'TRUNCATE') then
    raise exception 'authenticated can write Repro Lima tables';
  end if;
  if has_table_privilege('anon', 'public.lima_repro_cases', 'SELECT') or has_table_privilege('anon', 'public.lima_repro_calls', 'SELECT') then
    raise exception 'anon can read Repro Lima tables';
  end if;
  if has_table_privilege('service_role', 'public.lima_repro_cases', 'DELETE')
     or has_table_privilege('service_role', 'public.lima_repro_cases', 'TRUNCATE')
     or has_table_privilege('service_role', 'public.lima_repro_calls', 'UPDATE')
     or has_table_privilege('service_role', 'public.lima_repro_calls', 'DELETE')
     or has_table_privilege('service_role', 'public.lima_repro_calls', 'TRUNCATE') then
    raise exception 'service_role can rewrite Repro Lima history';
  end if;
  if not (has_table_privilege('service_role', 'public.lima_repro_cases', 'UPDATE')
          and has_table_privilege('service_role', 'public.lima_repro_calls', 'INSERT')) then
    raise exception 'service_role lost its writes';
  end if;
  if has_function_privilege('authenticated', 'public.lima_repro_claim(uuid,uuid,uuid,text,timestamptz,integer,boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.lima_repro_claim(uuid,uuid,uuid,text,timestamptz,integer,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.lima_repro_record(uuid,uuid,uuid,text,text,text,timestamptz,date,text,jsonb,text,text,text,text,integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.lima_repro_record(uuid,uuid,uuid,text,text,text,timestamptz,date,text,jsonb,text,text,text,text,integer)', 'EXECUTE') then
    raise exception 'authenticated or anon can execute the Repro Lima RPCs';
  end if;
  if not (has_function_privilege('service_role', 'public.lima_repro_claim(uuid,uuid,uuid,text,timestamptz,integer,boolean)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.lima_repro_record(uuid,uuid,uuid,text,text,text,timestamptz,date,text,jsonb,text,text,text,text,integer)', 'EXECUTE')) then
    raise exception 'service_role cannot execute the Repro Lima RPCs';
  end if;
end $$;

-- A (viewer de A): solo lo de A, y no escribe ni llama a las RPC.
set request.test_uid = '00000000-0000-0000-0000-00000000000a';
set role authenticated;
do $$
begin
  if (select count(*) from lima_repro_cases where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') <> 0 then raise exception 'A: store B cases leaked'; end if;
  if (select count(*) from lima_repro_calls where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') <> 0 then raise exception 'A: store B calls leaked'; end if;
  if (select count(*) from lima_repro_cases where order_id = '24900000-0000-0000-0000-000000000011') <> 3 then raise exception 'A: own cases not visible'; end if;
  if (select count(*) from lima_repro_calls where order_id = '24900000-0000-0000-0000-000000000011') <> 7 then raise exception 'A: own calls not visible'; end if;
  begin
    insert into lima_repro_cases(store_id,order_id,episode_key,episode_at)
      values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','24900000-0000-0000-0000-000000000012','s:x|o:-',now());
    raise exception 'FAIL authenticated inserted a case';
  exception when insufficient_privilege then null;
  end;
  begin
    update lima_repro_cases set claimed_by = null, claimed_until = null where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    raise exception 'FAIL authenticated updated a case';
  exception when insufficient_privilege then null;
  end;
  begin
    perform lima_repro_claim('24900000-0000-0000-0000-000000000011','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                             '00000000-0000-0000-0000-00000000000a','s:2|o:-',now(),10);
    raise exception 'FAIL authenticated executed lima_repro_claim';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- B (viewer de B): solo lo de B.
set request.test_uid = '00000000-0000-0000-0000-00000000000b';
set role authenticated;
do $$
begin
  if (select count(*) from lima_repro_cases where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') <> 0 then raise exception 'B: store A cases leaked'; end if;
  if (select count(*) from lima_repro_cases where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') <> 1 then raise exception 'B: own case not visible'; end if;
  if (select count(*) from lima_repro_calls where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') <> 1 then raise exception 'B: own call not visible'; end if;
end $$;
reset role;

-- C (owner): las dos tiendas. D (sin tiendas): nada.
set request.test_uid = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
do $$
begin
  if (select count(distinct store_id) from lima_repro_cases where order_id::text like '24900000-%') <> 2 then raise exception 'C: owner does not see both stores'; end if;
end $$;
reset role;
set request.test_uid = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
do $$
begin
  if (select count(*) from lima_repro_cases) <> 0 or (select count(*) from lima_repro_calls) <> 0 then raise exception 'D: ungranted viewer sees Repro Lima'; end if;
end $$;
reset role;
set request.test_uid = '';

rollback;
