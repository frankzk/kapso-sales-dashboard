-- Agente de voz para leads (0247, MOM §33). Corre solo en el clúster desechable
-- de verify-db, dentro de una transacción que se deshace.
--
-- Las llamadas de pedido (§11.8) y las de lead viven en la MISMA tabla. Lo que
-- impide que una tool, el vigilante o el candado Swayp traten una como la otra
-- es lo que la base acepta, así que se prueba en la base y no en el código:
--   · cada fila apunta a un pedido O a un lead, nunca a los dos ni a ninguno;
--   · cada carril tiene sus resultados (un lead nunca `confirma`, que es la
--     marca que dispara la salida Swayp);
--   · el candado del reintento automático Swayp no corre por una fila de lead
--     (ni siquiera toma el lock de la organización);
--   · hay UNA llamada de leads abierta a la vez (carril `leads`).
begin;
do $$
declare
  a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  org uuid := '33333333-3333-3333-3333-333333333333';
  o1 uuid := gen_random_uuid();  -- pedido sin reintento automático
  o2 uuid := gen_random_uuid();  -- pedido con emisión automática Swayp
  l1 uuid := gen_random_uuid();
  r record;
  locks_0 int; locks_1 int; locks_2 int;
  v text;
begin
  insert into orders(id,store_id,shopify_order_id,created_at) values (o1,a,'vl-1',now()),(o2,a,'vl-2',now());
  insert into leads(id,store_id,phone) values (l1,a,'51999000111');
  insert into swayp_guide_emissions(source_key,order_id,store_id,org_id,automatic,city,state)
    values ('vl-auto-'||o2::text,o2,a,org,true,'arequipa','created');

  -- ── Defectos: todo apagado, nadie pidió nada ──────────────────────────────
  select voice_lead_enabled, voice_lead_auto, voice_lead_daily_cap, voice_lead_max_attempts,
         voice_lead_wait_minutes, voice_lead_max_age_hours, voice_lead_holdout_pct,
         voice_lead_hour_start, voice_lead_hour_end, voice_lead_campaign_ids
    into r from stores where id=a;
  if r.voice_lead_enabled or r.voice_lead_auto then raise exception 'lead agent on by default'; end if;
  if (r.voice_lead_daily_cap, r.voice_lead_max_attempts, r.voice_lead_wait_minutes, r.voice_lead_max_age_hours,
      r.voice_lead_holdout_pct, r.voice_lead_hour_start, r.voice_lead_hour_end) <> (40, 2, 120, 48, 50, 9, 20) then
    raise exception 'lead agent defaults drifted from MOM §33.4: %', r;
  end if;
  if r.voice_lead_campaign_ids <> '{}'::text[] then raise exception 'campaign list not empty by default'; end if;
  if (select contact_opt_out_at from leads where id=l1) is not null then raise exception 'new lead born opted out'; end if;
  begin
    update stores set voice_lead_holdout_pct=95 where id=a;
    raise exception 'holdout above 90 accepted';
  exception when check_violation then null;
  end;

  -- ── Un pedido o un lead, nunca los dos ni ninguno ─────────────────────────
  begin
    insert into voice_calls(store_id,purpose,lead_id,order_id,mode,agent_number,phone,status)
      values (a,'lead',l1,o1,'test','vl-x','999000111','completed');
    raise exception 'lead row with order_id accepted';
  exception when check_violation then null;
  end;
  begin
    insert into voice_calls(store_id,order_id,mode,agent_number,phone,status)
      values (a,null,'test','vl-x','999000111','completed');
    raise exception 'order row without order_id accepted';
  exception when check_violation then null;
  end;
  begin
    insert into voice_calls(store_id,purpose,order_id,lead_id,mode,agent_number,phone,status)
      values (a,'order',o1,l1,'test','vl-x','999000111','completed');
    raise exception 'order row carrying a lead_id accepted';
  exception when check_violation then null;
  end;
  begin
    insert into voice_calls(store_id,purpose,lead_id,mode,agent_number,phone,status)
      values (a,'otro',l1,'test','vl-x','999000111','completed');
    raise exception 'unknown purpose accepted';
  exception when check_violation then null;
  end;
  -- Lo que ya escribe Reproprovincia sin decir el propósito sigue siendo pedido.
  insert into voice_calls(store_id,order_id,mode,agent_number,phone,status,outcome)
    values (a,o1,'test','vl-x','999000111','completed','confirma') returning purpose into v;
  if v <> 'order' then raise exception 'default purpose is %, not order', v; end if;

  -- ── Cada carril con sus resultados ────────────────────────────────────────
  begin
    insert into voice_calls(store_id,order_id,mode,agent_number,phone,status,outcome)
      values (a,o1,'test','vl-x','999000111','completed','atender_ahora');
    raise exception 'lead outcome accepted on an order row';
  exception when check_violation then null;
  end;
  begin
    insert into voice_calls(store_id,purpose,lead_id,mode,agent_number,phone,status,outcome)
      values (a,'lead',l1,'test','vl-x','999000111','completed','confirma');
    raise exception 'confirma accepted on a lead row';
  exception when check_violation then null;
  end;
  foreach v in array array['atender_ahora','volver_a_llamar','no_compra','no_llamar','no_contesta','sin_resultado'] loop
    insert into voice_calls(store_id,purpose,lead_id,mode,agent_number,phone,status,outcome)
      values (a,'lead',l1,'test','vl-x','999000111','completed',v);
  end loop;

  -- ── El candado Swayp no corre por un lead ─────────────────────────────────
  -- Con `order_id` nulo la función nunca levantaba el error, pero tomaba el lock
  -- de la organización que también toma `swayp_emission_claim`. Se cuenta: el
  -- lock de transacción queda tomado hasta el final, así que si el trigger
  -- corrió, el conteo sube.
  select count(*) into locks_0 from pg_locks where locktype='advisory' and pid=pg_backend_pid();
  insert into voice_calls(store_id,purpose,lead_id,mode,agent_number,phone,status)
    values (a,'lead',l1,'real','vl-lock','999000111','completed');
  select count(*) into locks_1 from pg_locks where locktype='advisory' and pid=pg_backend_pid();
  if locks_1 <> locks_0 then raise exception 'real lead call took the Swayp org lock'; end if;
  -- La prueba sabe ver el lock: una llamada real de pedido sí lo toma.
  insert into voice_calls(store_id,order_id,mode,agent_number,phone,status)
    values (a,o1,'real','vl-lock','999000111','completed');
  select count(*) into locks_2 from pg_locks where locktype='advisory' and pid=pg_backend_pid();
  if locks_2 <= locks_1 then raise exception 'real order call did not take the Swayp org lock'; end if;
  -- Y el candado sigue de pie para los pedidos con reintento automático.
  begin
    insert into voice_calls(store_id,order_id,mode,agent_number,phone,status)
      values (a,o2,'real','vl-lock','999000111','completed');
    raise exception 'interlock skipped an order with automatic emission';
  exception when raise_exception then
    if sqlerrm <> 'Pedido con reintento automático sin llamada' then raise; end if;
  end;

  -- ── Una llamada de leads abierta a la vez ─────────────────────────────────
  insert into voice_calls(store_id,purpose,lead_id,mode,agent_number,phone,status)
    values (a,'lead',l1,'test','leads','999000111','dialing');
  begin
    insert into voice_calls(store_id,purpose,lead_id,mode,agent_number,phone,status)
      values (a,'lead',l1,'test','leads','999000222','dialing');
    raise exception 'second open call accepted on the leads lane';
  exception when unique_violation then null;
  end;
  -- El carril de leads no ocupa el de Reproprovincia (ni al revés).
  insert into voice_calls(store_id,order_id,mode,agent_number,phone,status)
    values (a,o1,'test','1-11','999000333','dialing');

  -- ── Borrar el lead se lleva sus llamadas (no quedan filas sin destino) ────
  delete from leads where id=l1;
  if exists(select 1 from voice_calls where lead_id=l1) then raise exception 'lead calls survived their lead'; end if;
end $$;
rollback;
