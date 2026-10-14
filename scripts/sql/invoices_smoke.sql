-- Comprobantes electrónicos por RUC (0257, MOM §35). Corre solo en el clúster
-- desechable de verify-db, después de todas las migraciones, dentro de una
-- transacción que se deshace. Nunca llama a SimpleFact.
--
-- Reutiliza la organización y las tiendas A y B de rls_smoke.sql. Ya existían
-- cuando corrieron la 0126, la 0198 y la 0257, así que tienen la semilla real:
-- «Grupo GF S.A.C.» ···309, la pasarela «Aurela Kenku» y las dos cuentas
-- personales, y el RUC de GRUPO GF S.A.C. asignado por la 0257.
--
-- SimpleFact no tiene llave de idempotencia: la misma boleta mandada dos veces
-- son dos boletas ante SUNAT, y una boleta enviada no se borra. Lo que lo impide
-- vive en la base y no en el código, así que se prueba aquí:
--   a) la semilla: un RUC por organización, apagado y sin token, en las dos
--      cuentas de la empresa y en ninguna personal; volver a correr la 0257 no
--      pisa lo que el owner cambió y solo siembra donde se cobra en esa cuenta;
--   b) el emisor: RUC, subdominio de simplefact.pe (el token no viaja a otro
--      sitio), tope de 1 a 300, y «real» solo con token, «Emitir desde» y una
--      prueba que leyó el mismo RUC; un token nuevo lo baja a simulación;
--   c) una cuenta no apunta al RUC de otra organización;
--   d) invoice_claim: cada motivo, en simulación y en real, y el tope del día;
--   e) un solo comprobante real vivo por pedido, garantizado por el índice;
--   f) lo que pasó no se reescribe: los estados solo avanzan y nada se borra;
--   g) solo el servidor lee las tablas y pide el turno.
begin;
set local client_min_messages = warning;

-- ── Ayudas (temporales: se van con el rollback) ─────────────────────────────

-- Ejecuta `p_sql` y exige que falle con ese SQLSTATE (y ese mensaje, si se da).
-- Si pasa, o falla por otra cosa, la prueba se cae diciendo cuál.
create function pg_temp.debe_fallar(p_sql text, p_estado text, p_mensaje text default null) returns void
language plpgsql as $$
declare
  v_estado text;
  v_texto  text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_estado = returned_sqlstate, v_texto = message_text;
    if v_estado = p_estado and (p_mensaje is null or v_texto like p_mensaje) then
      return;
    end if;
    raise exception 'esperaba % «%» y falló con % «%»: %',
      p_estado, coalesce(p_mensaje, '*'), v_estado, v_texto, p_sql;
  end;
  raise exception 'se aceptó lo que tenía que fallar: %', p_sql;
end $$;

-- Los pedidos de esta prueba: 25700000-…-0000000000NN.
create function pg_temp.pedido(n integer) returns uuid language sql immutable as $$
  select ('25700000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- El RUC que sembró la 0257 en la organización de A y B.
create function pg_temp.gf() returns uuid language sql stable as $$
  select id from invoice_issuers
   where org_id = '33333333-3333-3333-3333-333333333333' and ruc = '20556792829'
$$;

-- El turno con lo que casi todas las pruebas comparten: la tienda A y ese RUC.
create function pg_temp.turno(
  p_order   uuid,
  p_total   numeric,
  p_paid_at timestamptz default now(),
  p_store   uuid default 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  p_issuer  uuid default null,
  p_request jsonb default '{"invoice_type": "03", "note": "Pedido #SMOKE · Kapta smoke"}'
) returns jsonb language sql as $$
  select invoice_claim(gen_random_uuid(), coalesce(p_issuer, pg_temp.gf()), p_store, p_order,
                       p_total, p_paid_at, '#SMOKE', '{"payments": []}'::jsonb, p_request)
$$;

-- Una fila escrita directo, como la escribe el servidor al registrar una
-- externa o al guardar lo que contestó SimpleFact.
create function pg_temp.fila(p_order uuid, p_mode text, p_status text) returns uuid
language sql as $$
  insert into order_invoices (id, org_id, store_id, order_id, issuer_id, ruc, mode, status, total, paid_at, request)
  values (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          p_order, pg_temp.gf(), '20556792829', p_mode, p_status, 100, now(), '{"invoice_type": "03"}')
  returning id
$$;

-- Las cuentas de una tienda en una línea: «final→RUC», la pasarela como «flow».
create function pg_temp.cuentas(p_store uuid, p_issuer uuid) returns text language sql stable as $$
  select string_agg(coalesce(phone_last_digits, 'flow') || '→' ||
           case when invoice_issuer_id is null then 'sin RUC'
                when invoice_issuer_id = p_issuer then 'RUC'
                else 'otro RUC' end,
           ', ' order by coalesce(phone_last_digits, 'flow') collate "C")
    from store_collection_accounts where store_id = p_store
$$;

-- ── a) La semilla ────────────────────────────────────────────────────────────
\echo '  semilla: GRUPO GF S.A.C. nace apagado y sin token, en las dos cuentas de la empresa'
do $$
declare
  v_org constant uuid := '33333333-3333-3333-3333-333333333333';
  v_iss invoice_issuers;
  v_store uuid;
begin
  -- Precondición: A y B ya existían cuando corrieron la 0126 y la 0198.
  if (select count(*) from store_collection_accounts
       where store_id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
         and ((phone_last_digits = '309' and label = 'Grupo GF S.A.C.')
           or (phone_last_digits is null and label = 'Aurela Kenku'))) <> 4 then
    raise exception 'faltan en A y B las cuentas que siembran la 0126 y la 0198';
  end if;

  if (select count(*) from invoice_issuers where org_id = v_org) <> 1 then
    raise exception 'semilla: % RUC en la organización, se esperaba uno',
      (select count(*) from invoice_issuers where org_id = v_org);
  end if;
  select * into v_iss from invoice_issuers where org_id = v_org;
  if (v_iss.ruc, v_iss.legal_name, v_iss.simplefact_subdomain, v_iss.mode, v_iss.daily_limit)
       is distinct from ('20556792829', 'GRUPO GF S.A.C.', 'grupogf', 'apagado', 40)
     or v_iss.token_enc is not null or v_iss.emit_from is not null
     or v_iss.checked_ruc is not null or v_iss.checked_at is not null then
    raise exception 'semilla: % % % % tope=% token=% desde=%', v_iss.ruc, v_iss.legal_name,
      v_iss.simplefact_subdomain, v_iss.mode, v_iss.daily_limit, v_iss.token_enc is not null, v_iss.emit_from;
  end if;

  -- El Yape ···309 y la pasarela Flow, sí; las cuentas personales de los dueños, no.
  foreach v_store in array array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[] loop
    if pg_temp.cuentas(v_store, v_iss.id) is distinct from '147→sin RUC, 309→RUC, 481→sin RUC, flow→RUC' then
      raise exception 'semilla en %: %', v_store, pg_temp.cuentas(v_store, v_iss.id);
    end if;
  end loop;
end $$;

\echo '  volver a correr la 0257 no pisa lo que el owner cambió, y siembra solo donde se cobra en esa cuenta'
-- El owner deja el Yape ···309 de la tienda A en «Sin comprobante».
update store_collection_accounts set invoice_issuer_id = null
 where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and phone_last_digits = '309';

-- Y: otra organización que cobra en la cuenta de la empresa. Z: una que no; el
-- mismo final 309 con otro titular no es esa cuenta.
insert into organizations (id, name) values
  ('25700000-0000-0000-0000-0000000000a1', 'Comprobantes Y'),
  ('25700000-0000-0000-0000-0000000000a2', 'Comprobantes Z');
insert into stores (id, org_id, name, shopify_domain) values
  ('25700000-0000-0000-0000-0000000000b1', '25700000-0000-0000-0000-0000000000a1', 'Tienda Y', 'inv-y.myshopify.com'),
  ('25700000-0000-0000-0000-0000000000b2', '25700000-0000-0000-0000-0000000000a2', 'Tienda Z', 'inv-z.myshopify.com');
insert into store_collection_accounts (store_id, label, phone_last_digits, note) values
  ('25700000-0000-0000-0000-0000000000b1', 'Grupo GF S.A.C.',     '309', 'Cuenta de la empresa'),
  ('25700000-0000-0000-0000-0000000000b1', 'Aurela Kenku',        null,  'Pasarela de pagos Flow'),
  ('25700000-0000-0000-0000-0000000000b1', 'Gabriela Reaño Vera', '147', 'Cuenta de una de las dueñas'),
  ('25700000-0000-0000-0000-0000000000b2', 'Otra Empresa S.A.C.', '309', 'Mismo final, otro titular');

-- La migración entera, no una copia de su semilla: si la semilla cambia, la
-- prueba prueba la nueva. Se declara idempotente (DEPLOY.md la aplica a mano).
\ir ../../db/migrations/0257_invoices.sql

do $$
declare
  v_gf uuid := pg_temp.gf();
  v_y  invoice_issuers;
begin
  if (select count(*) from invoice_issuers where org_id = '33333333-3333-3333-3333-333333333333') <> 1 then
    raise exception 'volver a correr la 0257 duplicó el RUC';
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'store_collection_accounts'::regclass and contype = 'f'
         and confrelid = 'invoice_issuers'::regclass) <> 1 then
    raise exception 'volver a correr la 0257 duplicó la llave cuenta → RUC';
  end if;
  if pg_temp.cuentas('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', v_gf) is distinct from '147→sin RUC, 309→sin RUC, 481→sin RUC, flow→RUC' then
    raise exception 'volver a correr la 0257 pisó lo que el owner cambió en A: %',
      pg_temp.cuentas('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', v_gf);
  end if;
  if pg_temp.cuentas('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', v_gf) is distinct from '147→sin RUC, 309→RUC, 481→sin RUC, flow→RUC' then
    raise exception 'B cambió: %', pg_temp.cuentas('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', v_gf);
  end if;

  -- Y recibe su propio RUC, apagado, en sus dos cuentas de la empresa.
  if (select count(*) from invoice_issuers where org_id = '25700000-0000-0000-0000-0000000000a1') <> 1 then
    raise exception 'Y: % RUC', (select count(*) from invoice_issuers where org_id = '25700000-0000-0000-0000-0000000000a1');
  end if;
  select * into v_y from invoice_issuers where org_id = '25700000-0000-0000-0000-0000000000a1';
  if (v_y.ruc, v_y.mode, v_y.simplefact_subdomain) is distinct from ('20556792829', 'apagado', 'grupogf')
     or v_y.token_enc is not null or v_y.id = v_gf then
    raise exception 'Y: % % %', v_y.ruc, v_y.mode, v_y.simplefact_subdomain;
  end if;
  if pg_temp.cuentas('25700000-0000-0000-0000-0000000000b1', v_y.id) is distinct from '147→sin RUC, 309→RUC, flow→RUC' then
    raise exception 'Y: %', pg_temp.cuentas('25700000-0000-0000-0000-0000000000b1', v_y.id);
  end if;

  -- Z no cobra en la cuenta de la empresa: no recibe nada.
  if exists (select 1 from invoice_issuers where org_id = '25700000-0000-0000-0000-0000000000a2') then
    raise exception 'Z recibió un RUC sin cobrar en la cuenta de la empresa';
  end if;
  if pg_temp.cuentas('25700000-0000-0000-0000-0000000000b2', v_gf) is distinct from '309→sin RUC' then
    raise exception 'Z: %', pg_temp.cuentas('25700000-0000-0000-0000-0000000000b2', v_gf);
  end if;
end $$;

-- Y cambia de idea: borra el RUC sembrado (sus cuentas quedan sin RUC por el
-- `on delete set null`) y da de alta otro, al que asigna el ···309. Volver a
-- correr la 0257 recrea GRUPO GF S.A.C. en Y, pero no le quita el ···309 al
-- RUC que eligió el owner: la semilla solo llena cuentas vacías.
delete from invoice_issuers where org_id = '25700000-0000-0000-0000-0000000000a1';
insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain)
values ('25700000-0000-0000-0000-0000000000a1', '20000000003', 'ELEGIDA POR EL OWNER S.A.C.', 'elegida');
update store_collection_accounts
   set invoice_issuer_id = (select id from invoice_issuers where ruc = '20000000003')
 where store_id = '25700000-0000-0000-0000-0000000000b1' and phone_last_digits = '309';

\ir ../../db/migrations/0257_invoices.sql

do $$
declare
  v_elegida uuid := (select id from invoice_issuers where ruc = '20000000003');
  v_gf_y    uuid := (select id from invoice_issuers
                      where org_id = '25700000-0000-0000-0000-0000000000a1' and ruc = '20556792829');
begin
  if v_gf_y is null then raise exception 'Y: la 0257 no recreó su RUC'; end if;
  if (select invoice_issuer_id from store_collection_accounts
       where store_id = '25700000-0000-0000-0000-0000000000b1' and phone_last_digits = '309') is distinct from v_elegida then
    raise exception 'Y: la 0257 le quitó el ···309 al RUC que eligió el owner';
  end if;
  if pg_temp.cuentas('25700000-0000-0000-0000-0000000000b1', v_gf_y) is distinct from '147→sin RUC, 309→otro RUC, flow→RUC' then
    raise exception 'Y tras la segunda pasada: %', pg_temp.cuentas('25700000-0000-0000-0000-0000000000b1', v_gf_y);
  end if;
end $$;

-- Deja la tienda A como la sembró la 0257 para el resto de la prueba.
update store_collection_accounts set invoice_issuer_id = pg_temp.gf()
 where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and phone_last_digits = '309';

-- ── b) El emisor ─────────────────────────────────────────────────────────────
\echo '  el RUC: once dígitos, subdominio de simplefact.pe, tope de 1 a 300 y «real» solo con token, fecha y prueba'
do $$
declare
  v_org constant uuid := '33333333-3333-3333-3333-333333333333';
  v_gf  constant uuid := pg_temp.gf();
  v_iss invoice_issuers;
  v_mal text;
begin
  -- RUC: once dígitos con un prefijo que existe.
  foreach v_mal in array array['2055679282', '205567928290', '30556792829', '2055679282a', ' 20556792829', ''] loop
    perform pg_temp.debe_fallar(format(
      $q$insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain) values (%L, %L, 'X S.A.C.', 'x')$q$,
      v_org, v_mal), '23514', '%invoice_issuers_ruc_check%');
  end loop;
  -- Razón social no vacía.
  perform pg_temp.debe_fallar(format(
    $q$insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain) values (%L, '20000000002', '   ', 'x')$q$,
    v_org), '23514', '%invoice_issuers_legal_name_check%');
  -- El mismo RUC dos veces en la organización: no.
  perform pg_temp.debe_fallar(format(
    $q$insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain) values (%L, '20556792829', 'GRUPO GF S.A.C.', 'grupogf')$q$,
    v_org), '23505');

  -- Solo el subdominio: con un dominio, un punto o mayúsculas el token podría
  -- viajar a otro sitio que no es *.simplefact.pe.
  foreach v_mal in array array['evil.com', 'Grupogf', 'grupogf.simplefact.pe', 'https://grupogf', 'grupo gf', '-grupogf', 'grupogf-', ''] loop
    perform pg_temp.debe_fallar(format(
      $q$update invoice_issuers set simplefact_subdomain = %L where id = %L$q$, v_mal, v_gf),
      '23514', '%invoice_issuers_simplefact_subdomain_check%');
  end loop;

  -- Tope diario de 1 a 300.
  perform pg_temp.debe_fallar(format('update invoice_issuers set daily_limit = 0 where id = %L', v_gf),
    '23514', '%invoice_issuers_daily_limit_check%');
  perform pg_temp.debe_fallar(format('update invoice_issuers set daily_limit = 301 where id = %L', v_gf),
    '23514', '%invoice_issuers_daily_limit_check%');
  update invoice_issuers set daily_limit = 1 where id = v_gf;
  update invoice_issuers set daily_limit = 300 where id = v_gf;
  update invoice_issuers set daily_limit = 40 where id = v_gf;

  -- «Real» exige token, «Emitir desde» y una prueba que leyó el mismo RUC.
  perform pg_temp.debe_fallar(format($q$update invoice_issuers set mode = 'real' where id = %L$q$, v_gf),
    '23514', '%invoice_issuers_real_ready%');
  -- Con token y una fecha de hace tres días, puesta con el RUC apagado (sin
  -- cambio de modo, la fecha no se toca). Sin prueba: no.
  update invoice_issuers set token_enc = 'enc:no-es-un-token', emit_from = now() - interval '3 days' where id = v_gf;
  if (select emit_from from invoice_issuers where id = v_gf) <> now() - interval '3 days' then
    raise exception 'la fecha se movió sin cambiar de modo';
  end if;
  perform pg_temp.debe_fallar(format($q$update invoice_issuers set mode = 'real' where id = %L$q$, v_gf),
    '23514', '%invoice_issuers_real_ready%');
  -- La prueba leyó OTRO RUC: no.
  update invoice_issuers set checked_ruc = '20000000001', checked_at = now() where id = v_gf;
  perform pg_temp.debe_fallar(format($q$update invoice_issuers set mode = 'real' where id = %L$q$, v_gf),
    '23514', '%invoice_issuers_real_ready%');
  -- Sin «Emitir desde»: no.
  update invoice_issuers set checked_ruc = '20556792829', emit_from = null where id = v_gf;
  perform pg_temp.debe_fallar(format($q$update invoice_issuers set mode = 'real' where id = %L$q$, v_gf),
    '23514', '%invoice_issuers_real_ready%');
  -- Sin token (en un alta: en un UPDATE, quitar el token ya borra la prueba): no.
  perform pg_temp.debe_fallar(format(
    $q$insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain, mode, emit_from, checked_ruc)
       values (%L, '20000000002', 'X S.A.C.', 'x', 'real', now(), '20000000002')$q$, v_org),
    '23514', '%invoice_issuers_real_ready%');

  -- Con todo, sí. Y «Emitir desde», que había quedado atrás, se mueve al
  -- momento del cambio: real no emite lo pagado durante la simulación.
  update invoice_issuers set emit_from = now() - interval '3 days' where id = v_gf;
  update invoice_issuers set mode = 'real' where id = v_gf;
  select * into v_iss from invoice_issuers where id = v_gf;
  if v_iss.mode <> 'real' or v_iss.emit_from <> now() then
    raise exception 'a real: modo % desde %', v_iss.mode, v_iss.emit_from;
  end if;

  -- Un token nuevo baja a simulación y borra la prueba: se prueba antes de emitir.
  update invoice_issuers set token_enc = 'enc:otro-que-no-es-token' where id = v_gf;
  select * into v_iss from invoice_issuers where id = v_gf;
  if v_iss.mode <> 'simulacion' or v_iss.checked_ruc is not null or v_iss.checked_at is not null then
    raise exception 'token nuevo en real: modo % prueba % %', v_iss.mode, v_iss.checked_ruc, v_iss.checked_at;
  end if;
  -- Igual un subdominio nuevo.
  update invoice_issuers set checked_ruc = '20556792829', checked_at = now() where id = v_gf;
  update invoice_issuers set mode = 'real' where id = v_gf;
  update invoice_issuers set simplefact_subdomain = 'grupogf2' where id = v_gf;
  select * into v_iss from invoice_issuers where id = v_gf;
  if v_iss.mode <> 'simulacion' or v_iss.checked_ruc is not null then
    raise exception 'subdominio nuevo en real: modo % prueba %', v_iss.mode, v_iss.checked_ruc;
  end if;
  update invoice_issuers set simplefact_subdomain = 'grupogf' where id = v_gf;

  -- Repetir la prueba con el RUC ya en real: si lee otro RUC, o no lee nada,
  -- se guarda lo que leyó y el RUC baja a simulación (antes chocaba con el
  -- check y Ajustes no podía registrar la prueba fallida).
  update invoice_issuers set checked_ruc = '20556792829', checked_at = now() where id = v_gf;
  update invoice_issuers set mode = 'real' where id = v_gf;
  update invoice_issuers set checked_ruc = '20000000001', checked_at = now(), check_error = 'Los archivos son de otro RUC'
   where id = v_gf;
  select * into v_iss from invoice_issuers where id = v_gf;
  if (v_iss.mode, v_iss.checked_ruc, v_iss.check_error)
       is distinct from ('simulacion', '20000000001', 'Los archivos son de otro RUC') then
    raise exception 'prueba con otro RUC en real: % % %', v_iss.mode, v_iss.checked_ruc, v_iss.check_error;
  end if;
  perform pg_temp.debe_fallar(format($q$update invoice_issuers set mode = 'real' where id = %L$q$, v_gf),
    '23514', '%invoice_issuers_real_ready%');
  update invoice_issuers set checked_ruc = '20556792829', check_error = null where id = v_gf;
  update invoice_issuers set mode = 'real' where id = v_gf;
  update invoice_issuers set checked_ruc = null, checked_at = now(), check_error = 'SimpleFact no contestó' where id = v_gf;
  if (select mode from invoice_issuers where id = v_gf) <> 'simulacion' then
    raise exception 'una prueba sin lectura dejó el RUC en real';
  end if;

  -- Una fecha futura no se toca al cambiar de modo.
  update invoice_issuers set mode = 'apagado', emit_from = now() + interval '1 day' where id = v_gf;
  update invoice_issuers set mode = 'simulacion' where id = v_gf;
  if (select emit_from from invoice_issuers where id = v_gf) <> now() + interval '1 day' then
    raise exception 'se movió una fecha futura';
  end if;

  -- Queda apagado, con token y con la prueba buena, para los turnos.
  update invoice_issuers set mode = 'apagado', checked_ruc = '20556792829', checked_at = now(), check_error = null
   where id = v_gf;
end $$;

-- ── c) Cuenta → RUC de la misma organización ────────────────────────────────
\echo '  una cuenta no apunta al RUC de otra organización'
do $$
declare
  v_z uuid;
begin
  -- Un alta directo en real, con todo, se acepta: es el RUC de Z.
  insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain, mode, token_enc, emit_from, checked_ruc, checked_at)
  values ('25700000-0000-0000-0000-0000000000a2', '20000000001', 'OTRA EMPRESA S.A.C.', 'otra', 'real',
          'enc:z-no-es-token', now(), '20000000001', now())
  returning id into v_z;
  -- Un alta ya encendido tampoco nace con «Emitir desde» atrás; uno apagado,
  -- sí puede: todavía no emite nada.
  insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain, mode, emit_from)
  values ('25700000-0000-0000-0000-0000000000a2', '20000000004', 'SIMULADA S.A.C.', 'simulada', 'simulacion',
          now() - interval '1 day'),
         ('25700000-0000-0000-0000-0000000000a2', '20000000005', 'APAGADA S.A.C.', 'apagada', 'apagado',
          now() - interval '1 day');
  if (select emit_from from invoice_issuers where ruc = '20000000004') <> now()
     or (select emit_from from invoice_issuers where ruc = '20000000005') <> now() - interval '1 day' then
    raise exception 'alta con «Emitir desde» atrás: % %',
      (select emit_from from invoice_issuers where ruc = '20000000004'),
      (select emit_from from invoice_issuers where ruc = '20000000005');
  end if;

  perform pg_temp.debe_fallar(format(
    $q$update store_collection_accounts set invoice_issuer_id = %L
        where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and phone_last_digits = '147'$q$, v_z),
    'P0001', 'El RUC no es de la organización de la tienda');
  perform pg_temp.debe_fallar(format(
    $q$insert into store_collection_accounts (store_id, label, phone_last_digits, invoice_issuer_id)
       values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Cuenta nueva', '999', %L)$q$, v_z),
    'P0001', 'El RUC no es de la organización de la tienda');
  -- Mover a una tienda de otra organización una cuenta que lleva RUC, tampoco.
  perform pg_temp.debe_fallar(
    $q$update store_collection_accounts set store_id = '25700000-0000-0000-0000-0000000000b2'
        where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and phone_last_digits is null$q$,
    'P0001', 'El RUC no es de la organización de la tienda');

  -- En su propia organización, sí, en cualquiera de sus tiendas.
  update store_collection_accounts set invoice_issuer_id = v_z
   where store_id = '25700000-0000-0000-0000-0000000000b2' and phone_last_digits = '309';
  update store_collection_accounts set invoice_issuer_id = pg_temp.gf()
   where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and phone_last_digits = '147';
  update store_collection_accounts set invoice_issuer_id = null
   where store_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and phone_last_digits = '147';
end $$;

-- ── d) El turno ──────────────────────────────────────────────────────────────
insert into orders (id, store_id, shopify_order_id, name, created_at, total_amount, currency, cancelled_at, total_refunded) values
  (pg_temp.pedido(1),  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-01', '#INV01', now(), 100.00, 'PEN', null, 0),   -- el principal
  (pg_temp.pedido(2),  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-02', '#INV02', now(), 700.01, 'PEN', null, 0),   -- un céntimo de más
  (pg_temp.pedido(3),  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-03', '#INV03', now(), 700.00, 'PEN', null, 0),   -- justo el tope
  (pg_temp.pedido(4),  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-04', '#INV04', now(), 100.00, 'PEN', null, 0),   -- los motivos
  (pg_temp.pedido(5),  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-05', '#INV05', now(), 100.00, 'PEN', now(), 0),  -- anulado
  (pg_temp.pedido(6),  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-06', '#INV06', now(), 100.00, 'PEN', null, 10),  -- reembolsado
  (pg_temp.pedido(7),  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-07', '#INV07', now(), 100.00, 'USD', null, 0),   -- otra moneda
  (pg_temp.pedido(8),  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-08', '#INV08', now(), 100.00, 'PEN', null, 0),   -- tope en simulación
  (pg_temp.pedido(9),  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-09', '#INV09', now(), 100.00, 'PEN', null, 0),   -- error y reintento
  (pg_temp.pedido(10), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-10', '#INV10', now(), 100.00, 'PEN', null, 0),   -- índices
  (pg_temp.pedido(11), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-11', '#INV11', now(), 100.00, 'PEN', null, 0),   -- emitida
  (pg_temp.pedido(12), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-12', '#INV12', now(), 100.00, 'PEN', null, 0),   -- en duda → error
  (pg_temp.pedido(13), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'inv-13', '#INV13', now(), 100.00, 'PEN', null, 0),   -- de la tienda B
  (pg_temp.pedido(14), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-14', '#INV14', now(), 100.00, 'PEN', null, 0),   -- sin conexión
  (pg_temp.pedido(15), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-15', '#INV15', now(), 100.00, 'PEN', null, 0);   -- tope en real

\echo '  invoice_claim en simulación: cada motivo, y la boleta se guarda sin enviarla'
do $$
declare
  v_a  constant uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_gf constant uuid := pg_temp.gf();
  v_z  constant uuid := (select id from invoice_issuers where ruc = '20000000001');
  r     jsonb;
  v_row order_invoices;
begin
  r := pg_temp.turno(pg_temp.pedido(1), 100);
  if r->>'reason' is distinct from 'ruc_apagado' then raise exception 'apagado: %', r; end if;

  update invoice_issuers set mode = 'simulacion', emit_from = now() where id = v_gf;

  r := pg_temp.turno(pg_temp.pedido(1), 100);
  if not r ? 'id' or r->>'mode' is distinct from 'simulacion' then raise exception 'simulación: %', r; end if;
  select * into v_row from order_invoices where id = (r->>'id')::uuid;
  if (v_row.status, v_row.mode, v_row.ruc, v_row.issuer_id, v_row.org_id, v_row.store_id, v_row.order_id,
      v_row.total, v_row.paid_at, v_row.invoice_type, v_row.order_name)
       is distinct from ('simulada', 'simulacion', '20556792829', v_gf, '33333333-3333-3333-3333-333333333333'::uuid,
                         v_a, pg_temp.pedido(1), 100.00::numeric, now(), '03', '#SMOKE') then
    raise exception 'fila simulada: % % % % %', v_row.status, v_row.mode, v_row.ruc, v_row.total, v_row.paid_at;
  end if;
  -- La boleta exacta que habría enviado, y nada de lo que contestaría SimpleFact.
  if v_row.request->>'invoice_type' is distinct from '03' or v_row.basis is distinct from '{"payments": []}'::jsonb
     or v_row.response is not null or v_row.http_status is not null or v_row.simplefact_id is not null then
    raise exception 'la simulación guardó otra cosa: % %', v_row.request, v_row.basis;
  end if;

  r := pg_temp.turno(pg_temp.pedido(1), 100);
  if r->>'reason' is distinct from 'ya_simulado' then raise exception 'segunda simulación: %', r; end if;

  -- S/ 700 es el tope: 700,01 no, 700,00 sí.
  r := pg_temp.turno(pg_temp.pedido(2), 700.01);
  if r->>'reason' is distinct from 'monto_mayor_700' then raise exception '700,01: %', r; end if;
  r := pg_temp.turno(pg_temp.pedido(3), 700.00);
  if not r ? 'id' then raise exception '700,00: %', r; end if;

  -- El total tiene que ser el de Kapta, al céntimo, y mayor que cero.
  r := pg_temp.turno(pg_temp.pedido(4), 99.99);
  if r->>'reason' is distinct from 'total_distinto' then raise exception '99,99 de 100: %', r; end if;
  r := pg_temp.turno(pg_temp.pedido(4), 100.01);
  if r->>'reason' is distinct from 'total_distinto' then raise exception '100,01 de 100: %', r; end if;
  r := pg_temp.turno(pg_temp.pedido(4), 0);
  if r->>'reason' is distinct from 'monto_cero' then raise exception 'cero: %', r; end if;
  r := pg_temp.turno(pg_temp.pedido(4), null);
  if r->>'reason' is distinct from 'monto_cero' then raise exception 'sin total: %', r; end if;

  -- Pagado antes de «Emitir desde», o sin fecha de pago: no.
  r := pg_temp.turno(pg_temp.pedido(4), 100, now() - interval '1 second');
  if r->>'reason' is distinct from 'antes_de_inicio' then raise exception 'un segundo antes: %', r; end if;
  r := pg_temp.turno(pg_temp.pedido(4), 100, null);
  if r->>'reason' is distinct from 'antes_de_inicio' then raise exception 'sin fecha de pago: %', r; end if;

  -- Sin boleta armada no hay turno.
  r := pg_temp.turno(pg_temp.pedido(4), 100, now(), v_a, null, null);
  if r->>'reason' is distinct from 'sin_boleta' then raise exception 'sin boleta: %', r; end if;
  r := pg_temp.turno(pg_temp.pedido(4), 100, now(), v_a, null, '[]');
  if r->>'reason' is distinct from 'sin_boleta' then raise exception 'boleta que no es objeto: %', r; end if;

  -- El pedido: anulado, reembolsado, en otra moneda o de otra tienda.
  r := pg_temp.turno(pg_temp.pedido(5), 100);
  if r->>'reason' is distinct from 'anulado' then raise exception 'anulado: %', r; end if;
  r := pg_temp.turno(pg_temp.pedido(6), 100);
  if r->>'reason' is distinct from 'reembolsado' then raise exception 'reembolsado: %', r; end if;
  r := pg_temp.turno(pg_temp.pedido(7), 100);
  if r->>'reason' is distinct from 'moneda' then raise exception 'en dólares: %', r; end if;
  r := pg_temp.turno(pg_temp.pedido(13), 100);
  if r->>'reason' is distinct from 'pedido' then raise exception 'pedido de B por A: %', r; end if;

  -- El RUC de otra organización, o uno que no existe.
  r := pg_temp.turno(pg_temp.pedido(4), 100, now(), v_a, v_z);
  if r->>'reason' is distinct from 'ruc_ajeno' then raise exception 'RUC de Z en A: %', r; end if;
  r := pg_temp.turno(pg_temp.pedido(4), 100, now(), v_a, gen_random_uuid());
  if r->>'reason' is distinct from 'ruc_ajeno' then raise exception 'RUC que no existe: %', r; end if;

  -- La tienda tiene que estar activa.
  r := pg_temp.turno(pg_temp.pedido(4), 100, now(), gen_random_uuid());
  if r->>'reason' is distinct from 'tienda' then raise exception 'tienda que no existe: %', r; end if;
  update stores set status = 'paused' where id = v_a;
  r := pg_temp.turno(pg_temp.pedido(4), 100);
  if r->>'reason' is distinct from 'tienda' then raise exception 'tienda pausada: %', r; end if;
  update stores set status = 'active' where id = v_a;

  -- Ningún rechazo dejó fila.
  if exists (select 1 from order_invoices
              where order_id in (pg_temp.pedido(2), pg_temp.pedido(4), pg_temp.pedido(5), pg_temp.pedido(6),
                                 pg_temp.pedido(7), pg_temp.pedido(13))) then
    raise exception 'un turno rechazado escribió una fila';
  end if;

  -- El tope del día: hoy hay dos simuladas (#1 y #3).
  update invoice_issuers set daily_limit = 1 where id = v_gf;
  r := pg_temp.turno(pg_temp.pedido(8), 100);
  if r->>'reason' is distinct from 'tope' then raise exception 'tope 1: %', r; end if;
  update invoice_issuers set daily_limit = 2 where id = v_gf;
  r := pg_temp.turno(pg_temp.pedido(8), 100);
  if r->>'reason' is distinct from 'tope' then raise exception 'tope 2: %', r; end if;
  update invoice_issuers set daily_limit = 3 where id = v_gf;
  r := pg_temp.turno(pg_temp.pedido(8), 100);
  if not r ? 'id' then raise exception 'tope 3: %', r; end if;
  update invoice_issuers set daily_limit = 40 where id = v_gf;
end $$;

\echo '  invoice_claim en real: emitiendo, uno por pedido aunque haya simulación, error previo, sin conexión y tope'
do $$
declare
  v_gf  constant uuid := pg_temp.gf();
  r     jsonb;
  v_err uuid;
  v_n   integer;
begin
  update invoice_issuers set mode = 'real' where id = v_gf;

  -- La simulación de #1 no impide la emisión real.
  r := pg_temp.turno(pg_temp.pedido(1), 100);
  if not r ? 'id' or r->>'mode' is distinct from 'real' then raise exception 'real: %', r; end if;
  if (select status from order_invoices where id = (r->>'id')::uuid) is distinct from 'emitiendo' then
    raise exception 'el turno real no quedó emitiendo';
  end if;
  r := pg_temp.turno(pg_temp.pedido(1), 100);
  if r->>'reason' is distinct from 'ya_tiene' then raise exception 'segundo turno real: %', r; end if;

  -- SimpleFact dijo que no (4xx): no hay boleta, pero no se reintenta solo.
  r := pg_temp.turno(pg_temp.pedido(9), 100);
  v_err := (r->>'id')::uuid;
  update order_invoices set status = 'error', http_status = 422, error = 'SimpleFact: datos inválidos',
         response = '{"message": "datos inválidos"}' where id = v_err;
  r := pg_temp.turno(pg_temp.pedido(9), 100);
  if r->>'reason' is distinct from 'error_previo' then raise exception 'error sin reintento: %', r; end if;
  -- Una persona pide volver a intentar: fila nueva, y el error se queda como historia.
  update order_invoices set retry_requested_at = now(), retry_requested_by = '00000000-0000-0000-0000-00000000000c'
   where id = v_err;
  r := pg_temp.turno(pg_temp.pedido(9), 100);
  if not r ? 'id' or (r->>'id')::uuid = v_err then raise exception 'reintento: %', r; end if;
  if (select string_agg(status, ',' order by status) from order_invoices where order_id = pg_temp.pedido(9))
       is distinct from 'emitiendo,error' then
    raise exception 'el reintento no dejó el error como historia';
  end if;

  -- El tope real cuenta lo emitiendo, emitido y en duda de real: ni las tres
  -- simuladas de hoy ni el error.
  select count(*) into v_n from order_invoices
   where issuer_id = v_gf and mode = 'real' and status in ('emitiendo', 'emitida', 'en_duda');
  if v_n <> 2 then raise exception 'en real van % comprobantes, se esperaban 2', v_n; end if;
  update invoice_issuers set daily_limit = v_n where id = v_gf;
  r := pg_temp.turno(pg_temp.pedido(15), 100);
  if r->>'reason' is distinct from 'tope' then raise exception 'tope real: %', r; end if;
  update invoice_issuers set daily_limit = v_n + 1 where id = v_gf;
  r := pg_temp.turno(pg_temp.pedido(15), 100);
  if not r ? 'id' then raise exception 'tope real + 1: %', r; end if;
  update invoice_issuers set daily_limit = 40 where id = v_gf;

  -- Sin conexión. En real, un RUC sin token o con una prueba de otro RUC no
  -- puede existir (lo prueba la sección b). El turno lo revisa igual: se
  -- levantan el check y el trigger en una subtransacción que se deshace.
  begin
    alter table invoice_issuers drop constraint invoice_issuers_real_ready;
    alter table invoice_issuers disable trigger invoice_issuers_touch;
    update invoice_issuers set checked_ruc = '20000000001' where id = v_gf;
    r := pg_temp.turno(pg_temp.pedido(14), 100);
    if r->>'reason' is distinct from 'sin_conexion' then raise exception 'prueba de otro RUC: %', r; end if;
    update invoice_issuers set checked_ruc = '20556792829', token_enc = null where id = v_gf;
    r := pg_temp.turno(pg_temp.pedido(14), 100);
    if r->>'reason' is distinct from 'sin_conexion' then raise exception 'sin token: %', r; end if;
    raise exception using errcode = 'KP257';
  exception when sqlstate 'KP257' then null;
  end;
  if not exists (select 1 from pg_constraint where conname = 'invoice_issuers_real_ready')
     or (select tgenabled from pg_trigger where tgname = 'invoice_issuers_touch') <> 'O'
     or (select token_enc from invoice_issuers where id = v_gf) is null then
    raise exception 'la subtransacción de «sin conexión» no se deshizo';
  end if;
  r := pg_temp.turno(pg_temp.pedido(14), 100);
  if not r ? 'id' then raise exception 'con conexión: %', r; end if;

  -- De vuelta en simulación, un pedido con comprobante real no se simula.
  update invoice_issuers set mode = 'simulacion' where id = v_gf;
  r := pg_temp.turno(pg_temp.pedido(9), 100);
  if r->>'reason' is distinct from 'ya_tiene' then raise exception 'simulación con real vivo: %', r; end if;
  update invoice_issuers set mode = 'real' where id = v_gf;
end $$;

-- ── e) Uno real vivo por pedido ──────────────────────────────────────────────
\echo '  un solo comprobante real vivo por pedido: lo garantiza el índice, no el código'
do $$
declare
  v_estado text;
begin
  -- #1 ya tiene uno emitiendo: ni otro vivo, ni uno registrado como externo.
  foreach v_estado in array array['emitiendo', 'emitida', 'en_duda', 'externa'] loop
    perform pg_temp.debe_fallar(format($q$select pg_temp.fila(%L, 'real', %L)$q$, pg_temp.pedido(1), v_estado),
      '23505', '%order_invoices_one_real%');
  end loop;
  -- Ni una segunda simulación.
  perform pg_temp.debe_fallar(format($q$select pg_temp.fila(%L, 'simulacion', 'simulada')$q$, pg_temp.pedido(1)),
    '23505', '%order_invoices_one_simulation%');

  -- Un error no es una boleta: dos errores y después uno emitiendo.
  perform pg_temp.fila(pg_temp.pedido(10), 'real', 'error');
  perform pg_temp.fila(pg_temp.pedido(10), 'real', 'error');
  perform pg_temp.fila(pg_temp.pedido(10), 'real', 'emitiendo');

  -- Simulación y «simulada» van juntas.
  perform pg_temp.debe_fallar(format($q$select pg_temp.fila(%L, 'real', 'simulada')$q$, pg_temp.pedido(11)),
    '23514', '%order_invoices_mode_status%');
  perform pg_temp.debe_fallar(format($q$select pg_temp.fila(%L, 'simulacion', 'emitida')$q$, pg_temp.pedido(11)),
    '23514', '%order_invoices_mode_status%');
end $$;

-- ── f) Lo que pasó no se reescribe ───────────────────────────────────────────
\echo '  lo que pasó no se reescribe: los estados solo avanzan y nada se borra'
do $$
declare
  v_c    constant uuid := '00000000-0000-0000-0000-00000000000c';
  v_emit uuid;
  v_duda uuid;
  v_otro uuid;
  v_sim  uuid;
  v_ext  uuid;
  v_set  text;
  r      jsonb;
begin
  v_emit := pg_temp.fila(pg_temp.pedido(11), 'real', 'emitiendo');
  perform pg_temp.debe_fallar(format('delete from order_invoices where id = %L', v_emit),
    'P0001', 'Un comprobante no se borra');
  -- Lo enviado no cambia, ni siquiera mientras se emite.
  foreach v_set in array array[
    'total = 99', $q$request = '{"invoice_type": "01"}'$q$, 'request = null', $q$paid_at = now() - interval '1 day'$q$,
    $q$basis = '{"payments": [1]}'$q$, $q$invoice_type = '01'$q$, $q$ruc = '20000000001'$q$, $q$mode = 'simulacion'$q$,
    format('order_id = %L', pg_temp.pedido(12)), format('created_by = %L', v_c),
    format('issuer_id = %L', (select id from invoice_issuers where ruc = '20000000001'))
  ] loop
    perform pg_temp.debe_fallar(format('update order_invoices set %s where id = %L', v_set, v_emit),
      'P0001', 'Lo enviado de un comprobante no cambia');
  end loop;

  -- emitiendo → emitida, con lo que contestó SimpleFact.
  update order_invoices set status = 'emitida', http_status = 200, simplefact_id = 4321, serie = 'B001',
         correlative = '15', response = '{"id": 4321}', pdf_url = 'https://grupogf.simplefact.pe/b001-15.pdf'
   where id = v_emit;
  -- Emitida, cerrada: ni el estado, ni un dato, ni se borra.
  foreach v_set in array array[$q$status = 'error'$q$, $q$status = 'en_duda'$q$, $q$status = 'emitida'$q$,
                               $q$note = 'una nota'$q$, $q$serie = 'B002'$q$] loop
    perform pg_temp.debe_fallar(format('update order_invoices set %s where id = %L', v_set, v_emit),
      'P0001', 'Un comprobante emitida no cambia');
  end loop;
  perform pg_temp.debe_fallar(format('delete from order_invoices where id = %L', v_emit),
    'P0001', 'Un comprobante no se borra');

  -- La simulada tampoco: no se «asciende» a emitida.
  v_sim := (select id from order_invoices where order_id = pg_temp.pedido(1) and mode = 'simulacion');
  perform pg_temp.debe_fallar(format($q$update order_invoices set status = 'emitida' where id = %L$q$, v_sim),
    'P0001', 'Un comprobante simulada no cambia');
  perform pg_temp.debe_fallar(format($q$update order_invoices set note = 'x' where id = %L$q$, v_sim),
    'P0001', 'Un comprobante simulada no cambia');

  -- Registrada como externa: cerrada, y Kapta no vuelve a emitir por ese pedido.
  v_ext := pg_temp.fila(pg_temp.pedido(3), 'real', 'externa');
  perform pg_temp.debe_fallar(format($q$update order_invoices set serie = 'B009' where id = %L$q$, v_ext),
    'P0001', 'Un comprobante externa no cambia');
  r := pg_temp.turno(pg_temp.pedido(3), 700.00);
  if r->>'reason' is distinct from 'ya_tiene' then raise exception 'turno con externa: %', r; end if;

  -- emitiendo → en_duda → error (una persona confirmó que no está en SimpleFact).
  v_duda := pg_temp.fila(pg_temp.pedido(12), 'real', 'emitiendo');
  update order_invoices set status = 'en_duda', error = 'SimpleFact no contestó' where id = v_duda;
  perform pg_temp.debe_fallar(format($q$update order_invoices set status = 'emitiendo' where id = %L$q$, v_duda),
    'P0001', 'Transición de comprobante no permitida%');
  perform pg_temp.debe_fallar(format($q$update order_invoices set status = 'externa' where id = %L$q$, v_duda),
    'P0001', 'Transición de comprobante no permitida%');
  update order_invoices set status = 'error', resolved_by = v_c, resolved_at = now() where id = v_duda;

  -- Un error solo admite que una persona pida el reintento, una vez.
  perform pg_temp.debe_fallar(format($q$update order_invoices set error = 'otro texto' where id = %L$q$, v_duda),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  perform pg_temp.debe_fallar(format(
    $q$update order_invoices set retry_requested_at = now(), error = 'otro texto' where id = %L$q$, v_duda),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  perform pg_temp.debe_fallar(format($q$update order_invoices set status = 'emitida' where id = %L$q$, v_duda),
    'P0001', 'Transición de comprobante no permitida%');
  update order_invoices set retry_requested_at = now(), retry_requested_by = v_c where id = v_duda;
  perform pg_temp.debe_fallar(format(
    $q$update order_invoices set retry_requested_at = now() + interval '1 minute' where id = %L$q$, v_duda),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  perform pg_temp.debe_fallar(format($q$update order_invoices set retry_requested_by = null where id = %L$q$, v_duda),
    'P0001', 'Un error solo admite pedir su reintento, una vez');

  -- emitiendo no salta a simulada ni a externa.
  v_otro := pg_temp.fila(pg_temp.pedido(12), 'real', 'emitiendo');
  perform pg_temp.debe_fallar(format($q$update order_invoices set status = 'simulada' where id = %L$q$, v_otro),
    'P0001', 'Transición de comprobante no permitida%');
  perform pg_temp.debe_fallar(format($q$update order_invoices set status = 'externa' where id = %L$q$, v_otro),
    'P0001', 'Transición de comprobante no permitida%');
end $$;

\echo '  la última revisión del barrido: una por pedido y modo'
do $$
begin
  insert into invoice_order_checks (order_id, mode, store_id, issuer_id, reason)
  values (pg_temp.pedido(2), 'simulacion', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.gf(), 'monto_mayor_700');
  perform pg_temp.debe_fallar(format(
    $q$insert into invoice_order_checks (order_id, mode, store_id, reason)
       values (%L, 'simulacion', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'tope')$q$, pg_temp.pedido(2)), '23505');
  insert into invoice_order_checks (order_id, mode, store_id, issuer_id, reason)
  values (pg_temp.pedido(2), 'simulacion', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.gf(), 'tope')
  on conflict (order_id, mode) do update set reason = excluded.reason, checked_at = now();
  if (select reason from invoice_order_checks where order_id = pg_temp.pedido(2) and mode = 'simulacion') <> 'tope' then
    raise exception 'la revisión no se reemplazó';
  end if;
  perform pg_temp.debe_fallar(format(
    $q$insert into invoice_order_checks (order_id, mode, store_id, reason)
       values (%L, 'apagado', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ruc_apagado')$q$, pg_temp.pedido(2)), '23514');
end $$;

-- ── g) Solo el servidor ──────────────────────────────────────────────────────
\echo '  solo el servidor: el navegador no lee el token ni los comprobantes, ni pide el turno'
do $$
declare
  v_rol   text;
  v_tabla text;
  v_priv  text;
begin
  foreach v_rol in array array['anon', 'authenticated'] loop
    foreach v_tabla in array array['invoice_issuers', 'order_invoices', 'invoice_order_checks'] loop
      foreach v_priv in array array['select', 'insert', 'update', 'delete'] loop
        if has_table_privilege(v_rol, 'public.' || v_tabla, v_priv) then
          raise exception '% tiene % sobre %', v_rol, v_priv, v_tabla;
        end if;
      end loop;
    end loop;
    if has_function_privilege(v_rol, 'public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)', 'execute') then
      raise exception '% puede pedir el turno', v_rol;
    end if;
  end loop;
  foreach v_tabla in array array['invoice_issuers', 'order_invoices', 'invoice_order_checks'] loop
    if not has_table_privilege('service_role', 'public.' || v_tabla, 'select') then
      raise exception 'service_role no lee %', v_tabla;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)', 'execute') then
    raise exception 'service_role no puede pedir el turno';
  end if;
end $$;

-- Ni siquiera el owner de la organización, con sesión.
set local request.test_uid = '00000000-0000-0000-0000-00000000000c';
set local role authenticated;
do $$
begin
  begin
    perform 1 from invoice_issuers;
    raise exception 'authenticated leyó invoice_issuers';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from order_invoices;
    raise exception 'authenticated leyó order_invoices';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from invoice_order_checks;
    raise exception 'authenticated leyó invoice_order_checks';
  exception when insufficient_privilege then null;
  end;
  begin
    perform invoice_claim(gen_random_uuid(), gen_random_uuid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                          '25700000-0000-0000-0000-000000000004', 100, now(), '#X', '{}', '{}');
    raise exception 'authenticated pidió el turno';
  exception when insufficient_privilege then null;
  end;
  -- Tampoco reasigna el RUC de una cuenta: store_collection_accounts no tiene
  -- policies, y la asignación pasa por la acción con `invoices.manage`.
  begin
    update store_collection_accounts set invoice_issuer_id = null
     where store_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    if found then raise exception 'authenticated reasignó el RUC de una cuenta'; end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role anon;
do $$
begin
  begin
    perform 1 from invoice_issuers;
    raise exception 'anon leyó invoice_issuers';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from order_invoices;
    raise exception 'anon leyó order_invoices';
  exception when insufficient_privilege then null;
  end;
  begin
    perform invoice_claim(gen_random_uuid(), gen_random_uuid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                          '25700000-0000-0000-0000-000000000004', 100, now(), '#X', '{}', '{}');
    raise exception 'anon pidió el turno';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- El servidor sí: lee y pide el turno (que aquí dice que #1 ya tiene).
set local role service_role;
do $$
declare
  r jsonb;
begin
  if not exists (select 1 from order_invoices) or not exists (select 1 from invoice_issuers)
     or not exists (select 1 from invoice_order_checks) then
    raise exception 'service_role no ve las tablas';
  end if;
  r := invoice_claim(gen_random_uuid(),
                     (select id from invoice_issuers
                       where org_id = '33333333-3333-3333-3333-333333333333' and ruc = '20556792829'),
                     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25700000-0000-0000-0000-000000000001',
                     100, now(), '#INV01', '{}', '{"invoice_type": "03"}');
  if r->>'reason' is distinct from 'ya_tiene' then raise exception 'service_role: %', r; end if;
end $$;
reset role;

rollback;
\echo '  invoices: semilla, emisor, cuenta → RUC, turno, índice, estados y permisos OK'
