-- Paridad de `lead_queue_counts` (migración 0059) con los filtros que usaba
-- lib/leads-access.ts consulta a consulta. Se ejecuta sobre un clúster
-- desechable, después de aplicar todas las migraciones.
--
-- POR QUÉ ESTA PRUEBA. Los siete conteos de las pestañas de Leads pasaron de
-- siete `count(*)` exactos vía PostgREST a un único recorrido en SQL. Son dos
-- escrituras del MISMO criterio en dos sitios distintos: si divergen, las
-- pestañas muestran números que no cuadran con su propia lista y nadie se entera
-- hasta que alguien los suma a mano.
--
-- El filtro delicado es `status <> 'yape_por_verificar'`: en SQL —y por tanto en
-- el `neq` de PostgREST— una fila con status NULL no pasaría el filtro, porque
-- la comparación da NULL en vez de true. Aquí no puede pasar (status es NOT NULL
-- desde 0004, igual que category y needs_attention), y por eso la función lo
-- escribe con `<>` y no con `is distinct from`: son equivalentes mientras la
-- columna siga siendo obligatoria, y `<>` es lo que hacía el código anterior.
-- Lo que sí varía en los datos reales —y está en el fixture— es la frescura del
-- handoff y el vencimiento del seguimiento.
--
-- Reutiliza las fixtures de org/tienda de rls_smoke.sql.

\set store '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''

delete from leads where store_id = :store;

insert into leads (store_id, phone, category, status, needs_attention, handoff_at, next_followup_at)
values
  -- Cola normal: cuentan en "Por llamar"; los `nuevo` también en "Sin llamar".
  (:store, '+51900000001', 'open', 'nuevo',              false, null,              null),
  (:store, '+51900000002', 'hot',  'nuevo',              false, null,              null),
  (:store, '+51900000003', 'open', 'casi_cierra',        false, null,              null),
  -- Pago por verificar: sale de "Por llamar" y es toda la pestaña Yape/Shalom.
  (:store, '+51900000005', 'open', 'yape_por_verificar', false, null,              null),
  -- "⚡ Atender ahora": needs_attention + handoff fresco. El viejo NO cuenta.
  (:store, '+51900000006', 'open', 'casi_cierra',        true,  now() - interval '1 hour',  null),
  (:store, '+51900000007', 'open', 'casi_cierra',        true,  now() - interval '40 hours', null),
  -- needs_attention en false con handoff fresco: tampoco cuenta.
  (:store, '+51900000008', 'open', 'casi_cierra',        false, now() - interval '1 hour',  null),
  -- Seguimientos: solo los vencidos (next_followup_at <= ahora).
  (:store, '+51900000009', 'open', 'volver_a_llamar',    false, null, now() - interval '2 hours'),
  (:store, '+51900000010', 'open', 'volver_a_llamar',    false, null, now() + interval '2 hours'),
  -- Cerrados.
  (:store, '+51900000011', 'won',  'pedido_generado',    false, null, null),
  (:store, '+51900000012', 'lost', 'no_contesto',        false, null, null);

do $$
declare
  v_store    uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_cutoff   timestamptz := now() - interval '24 hours';  -- HANDOFF_FRESH_HOURS
  v_now      timestamptz := now();
  r          record;
  e_por_llamar   bigint;
  e_handoff      bigint;
  e_yape         bigint;
  e_seguimientos bigint;
  e_ganados      bigint;
  e_perdidos     bigint;
  e_sin_llamar   bigint;
begin
  select * into r from public.lead_queue_counts(v_store, v_cutoff, v_now);

  -- Los "esperados" son la traducción LITERAL de cada consulta que hacía
  -- getLeadCounts contra PostgREST, una por una.
  select count(*) into e_por_llamar   from leads
    where store_id = v_store and category in ('open','hot') and status <> 'yape_por_verificar';
  select count(*) into e_handoff      from leads
    where store_id = v_store and needs_attention = true and handoff_at >= v_cutoff;
  select count(*) into e_yape         from leads
    where store_id = v_store and status = 'yape_por_verificar';
  select count(*) into e_seguimientos from leads
    where store_id = v_store and next_followup_at is not null and next_followup_at <= v_now;
  select count(*) into e_ganados      from leads where store_id = v_store and category = 'won';
  select count(*) into e_perdidos     from leads where store_id = v_store and category = 'lost';
  select count(*) into e_sin_llamar   from leads
    where store_id = v_store and category in ('open','hot') and status = 'nuevo';

  if r.por_llamar <> e_por_llamar then
    raise exception 'por_llamar: RPC % vs filtro original %', r.por_llamar, e_por_llamar using errcode = 'ZZ001';
  end if;
  if r.handoff <> e_handoff then
    raise exception 'handoff: RPC % vs filtro original %', r.handoff, e_handoff using errcode = 'ZZ001';
  end if;
  if r.yape <> e_yape then
    raise exception 'yape: RPC % vs filtro original %', r.yape, e_yape using errcode = 'ZZ001';
  end if;
  if r.seguimientos <> e_seguimientos then
    raise exception 'seguimientos: RPC % vs filtro original %', r.seguimientos, e_seguimientos using errcode = 'ZZ001';
  end if;
  if r.ganados <> e_ganados then
    raise exception 'ganados: RPC % vs filtro original %', r.ganados, e_ganados using errcode = 'ZZ001';
  end if;
  if r.perdidos <> e_perdidos then
    raise exception 'perdidos: RPC % vs filtro original %', r.perdidos, e_perdidos using errcode = 'ZZ001';
  end if;
  if r.sin_llamar <> e_sin_llamar then
    raise exception 'sin_llamar: RPC % vs filtro original %', r.sin_llamar, e_sin_llamar using errcode = 'ZZ001';
  end if;

  -- Y los valores concretos que dicta el fixture, para que la prueba falle
  -- también si AMBOS lados se rompen igual.
  if r.por_llamar <> 8 then
    raise exception 'por_llamar esperaba 8 (el yape por verificar no cuenta), dio %', r.por_llamar using errcode = 'ZZ001';
  end if;
  if r.handoff <> 1 then
    raise exception 'handoff esperaba 1 (solo el fresco con needs_attention=true), dio %', r.handoff using errcode = 'ZZ001';
  end if;
  if r.seguimientos <> 1 then
    raise exception 'seguimientos esperaba 1 (solo el vencido), dio %', r.seguimientos using errcode = 'ZZ001';
  end if;
  if r.sin_llamar <> 2 then
    raise exception 'sin_llamar esperaba 2, dio %', r.sin_llamar using errcode = 'ZZ001';
  end if;

  -- Firma de la cola: total de filas + último cambio. Es lo que hace que el
  -- refresco en vivo sepa que NO tiene que recargar nada.
  if r.total <> 11 then
    raise exception 'total esperaba 11, dio %', r.total using errcode = 'ZZ001';
  end if;
  if r.last_change is null then
    raise exception 'last_change vino NULL: el refresco en vivo se quedaría ciego' using errcode = 'ZZ001';
  end if;
end;
$$;

-- La firma tiene que MOVERSE cuando se toca un lead (de eso vive el refresco en
-- vivo). Lo garantiza el trigger `leads_touch` sobre updated_at.
do $$
declare
  v_store  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_before timestamptz;
  v_after  timestamptz;
begin
  select last_change into v_before
    from public.lead_queue_counts(v_store, now() - interval '24 hours', now());
  perform pg_sleep(0.01);
  update leads set status = 'contactado'
   where store_id = v_store and phone = '+51900000001';
  select last_change into v_after
    from public.lead_queue_counts(v_store, now() - interval '24 hours', now());
  if v_after is not distinct from v_before then
    raise exception 'la firma no cambió al editar un lead: el refresco en vivo nunca recargaría'
      using errcode = 'ZZ001';
  end if;
end;
$$;

delete from leads where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
