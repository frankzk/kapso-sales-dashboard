-- Comprobantes electrónicos por RUC (0257, 0260 y 0261, MOM §35). Corre solo en
-- el clúster desechable de verify-db, después de todas las migraciones, dentro
-- de una transacción que se deshace. Nunca llama a SimpleFact.
--
-- La 0257 es la que corrió en producción el 14-10-2026, la 0260 cambia cuatro
-- de sus funciones (los arreglos de la revisión adversaria) y la 0261 trae el
-- modo «Manual» (el turno con `p_mode` y `p_created_by`). Cada vez que esta
-- prueba vuelve a correr la 0257, corre la 0260 y la 0261 justo después: la
-- 0257 sola deja las funciones de antes (y el turno de nueve argumentos, que
-- junto al de once vuelve ambigua una llamada por nombre), y el resto de la
-- prueba es sobre las de ahora.
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
--      cuentas de la empresa y en ninguna personal; volver a correr la 0257 (y
--      la 0260) no pisa lo que el owner cambió y solo siembra donde se cobra en
--      esa cuenta;
--   b) el emisor: RUC, subdominio de simplefact.pe (el token no viaja a otro
--      sitio), tope de 1 a 300, y «real» solo con token, «Emitir desde» y una
--      prueba que leyó el mismo RUC; un token nuevo lo baja a simulación;
--   c) una cuenta no apunta al RUC de otra organización;
--   d) invoice_claim: cada motivo, en simulación y en real, y el tope del día;
--      cuándo quedó pagado lo vuelve a calcular con los pagos de la base;
--   e) un solo comprobante real vivo por pedido, garantizado por el índice;
--   f) lo que pasó no se reescribe: los estados solo avanzan y nada se borra,
--      salvo quién lo hizo cuando se borra su cuenta (y solo por la cascada:
--      a mano, ni con service_role);
--   g) solo el servidor lee las tablas y pide el turno;
--   h) invoice_candidates: qué pedidos revisa el barrido en cada pasada;
--   i) la 0260 sobre la 0257 que corrió en producción: la 0257 sola deja las
--      cuatro funciones de antes de la revisión; la 0260 las cambia sin tocar
--      un dato ni recrear un trigger, y correrla dos veces es correrla una;
--   j) la 0261 y el modo «Manual»: sobre lo que hay en producción admite el
--      modo sin tocar datos ni triggers y deja un solo turno, al que el código
--      de hoy sigue llamando con sus nueve argumentos por nombre; Manual exige
--      lo que exige Real y baja como Real; el turno da la fila que se pide
--      (`modo_distinto` si el RUC no está en ese modo), guarda quién la pidió
--      y cuenta el tope por el modo pedido; y correrla dos veces es correrla
--      una.
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

\echo '  volver a correr la 0257 (y la 0260 y la 0261) no pisa lo que el owner cambió, y siembra solo donde se cobra en esa cuenta'
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
-- La 0260 y la 0261 van justo después: la 0257 sola vuelve a dejar las
-- funciones de antes de la revisión, y las pruebas que siguen son de las de
-- ahora (sin la 0261 quedarían dos turnos, el de nueve argumentos y el de once).
\ir ../../db/migrations/0257_invoices.sql
\ir ../../db/migrations/0260_invoices_hardening.sql
\ir ../../db/migrations/0261_invoices_manual.sql

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
-- correr la 0257 (y la 0260 y la 0261) recrea GRUPO GF S.A.C. en Y, pero no le
-- quita el ···309 al RUC que eligió el owner: la semilla solo llena cuentas
-- vacías.
delete from invoice_issuers where org_id = '25700000-0000-0000-0000-0000000000a1';
insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain)
values ('25700000-0000-0000-0000-0000000000a1', '20000000003', 'ELEGIDA POR EL OWNER S.A.C.', 'elegida');
update store_collection_accounts
   set invoice_issuer_id = (select id from invoice_issuers where ruc = '20000000003')
 where store_id = '25700000-0000-0000-0000-0000000000b1' and phone_last_digits = '309';

\ir ../../db/migrations/0257_invoices.sql
\ir ../../db/migrations/0260_invoices_hardening.sql
\ir ../../db/migrations/0261_invoices_manual.sql

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
  -- También el motivo de la prueba anterior: sin fecha de prueba y con motivo
  -- queda solo lo que apagó el barrido («Apagado por Kapta», MOM §35.4).
  update invoice_issuers set check_error = 'Token rechazado (401).' where id = v_gf;
  update invoice_issuers set token_enc = 'enc:otro-que-no-es-token' where id = v_gf;
  select * into v_iss from invoice_issuers where id = v_gf;
  if v_iss.mode <> 'simulacion' or v_iss.checked_ruc is not null or v_iss.checked_at is not null
     or v_iss.check_error is not null then
    raise exception 'token nuevo en real: modo % prueba % % motivo %',
      v_iss.mode, v_iss.checked_ruc, v_iss.checked_at, v_iss.check_error;
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
  (pg_temp.pedido(15), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-15', '#INV15', now(), 100.00, 'PEN', null, 0),   -- tope en real
  (pg_temp.pedido(16), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-16', '#INV16', now() - interval '3 days', 100.00, 'PEN', null, 0), -- pagado antes, según la base
  (pg_temp.pedido(17), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-17', '#INV17', now(), 100.00, 'PEN', null, 0),   -- pagos en revisión
  (pg_temp.pedido(18), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'inv-18', '#INV18', now() - interval '1 day', 100.00, 'PEN', null, 0); -- sin pagos: la fecha del pedido

-- Los pagos de esos tres, como los deja Kapta. #16: el adelanto validado se
-- registró hace dos días y el total de hoy se rechazó. #17: el total validado
-- hoy y una diferencia que todavía nadie revisó.
insert into order_payments (store_id, order_id, kind, amount, validation_status, registered_at, validated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.pedido(16), 'adelanto',   50, 'validado',  now() - interval '2 days', now()),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.pedido(16), 'total',     100, 'rechazado', now(), null),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.pedido(17), 'total',     100, 'validado',  now(), now()),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.pedido(17), 'diferencia',  1, 'pendiente_revision', now(), null);

\echo '  invoice_claim en simulación: cada motivo, y la boleta se guarda sin enviarla'
do $$
declare
  v_a  constant uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_gf constant uuid := pg_temp.gf();
  v_z  constant uuid := (select id from invoice_issuers where ruc = '20000000001');
  r     jsonb;
  v_row order_invoices;
  v_estado text;
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

  -- La fecha que manda el código no basta: la base la vuelve a calcular con sus
  -- propios pagos. #16 llega con «pagado ahora», pero su último pago vivo se
  -- registró hace dos días (el total de hoy está rechazado y no cuenta).
  r := pg_temp.turno(pg_temp.pedido(16), 100, now());
  if r->>'reason' is distinct from 'antes_de_inicio' then raise exception 'pagado antes según la base: %', r; end if;
  -- Con una diferencia validada que entró hoy, el último pago vivo es de hoy:
  -- pasa la fecha (y se detiene en la boleta que falta, sin dejar fila).
  insert into order_payments (store_id, order_id, kind, amount, validation_status, registered_at, validated_at)
  values (v_a, pg_temp.pedido(16), 'diferencia', 50, 'validado', now(), now());
  r := pg_temp.turno(pg_temp.pedido(16), 100, now(), v_a, null, null);
  if r->>'reason' is distinct from 'sin_boleta' then raise exception 'último pago de hoy: %', r; end if;

  -- Un pago vivo sin validar —en cualquiera de sus estados— no deja pedir el
  -- turno, aunque lo validado cubra el total.
  foreach v_estado in array array['pendiente_revision', 'posible_duplicado', 'info_incompleta', 'revision_admin'] loop
    update order_payments set validation_status = v_estado
     where order_id = pg_temp.pedido(17) and kind = 'diferencia';
    r := pg_temp.turno(pg_temp.pedido(17), 100);
    if r->>'reason' is distinct from 'pagos_en_revision' then raise exception 'pago %: %', v_estado, r; end if;
  end loop;
  -- Rechazado deja de contar.
  update order_payments set validation_status = 'rechazado'
   where order_id = pg_temp.pedido(17) and kind = 'diferencia';
  r := pg_temp.turno(pg_temp.pedido(17), 100, now(), v_a, null, null);
  if r->>'reason' is distinct from 'sin_boleta' then raise exception 'diferencia rechazada: %', r; end if;

  -- Sin pagos vivos (el prepago web) cuenta la fecha del pedido: `processed_at`
  -- y, si falta, `created_at`. #18 se creó ayer.
  r := pg_temp.turno(pg_temp.pedido(18), 100, now());
  if r->>'reason' is distinct from 'antes_de_inicio' then raise exception 'pedido de ayer sin pagos: %', r; end if;
  update orders set processed_at = now() where id = pg_temp.pedido(18);
  r := pg_temp.turno(pg_temp.pedido(18), 100, now(), v_a, null, null);
  if r->>'reason' is distinct from 'sin_boleta' then raise exception 'procesado hoy: %', r; end if;
  update orders set processed_at = now() - interval '1 second' where id = pg_temp.pedido(18);
  r := pg_temp.turno(pg_temp.pedido(18), 100, now());
  if r->>'reason' is distinct from 'antes_de_inicio' then raise exception 'procesado un segundo antes: %', r; end if;

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
                                 pg_temp.pedido(7), pg_temp.pedido(13), pg_temp.pedido(16), pg_temp.pedido(17),
                                 pg_temp.pedido(18))) then
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

  -- En real, igual: la base decide con sus pagos cuándo quedó pagado.
  r := pg_temp.turno(pg_temp.pedido(18), 100, now());
  if r->>'reason' is distinct from 'antes_de_inicio' then raise exception 'real, pagado antes según la base: %', r; end if;
  insert into order_payments (store_id, order_id, kind, amount, validation_status, registered_at)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.pedido(17), 'diferencia', 1, 'pendiente_revision', now());
  r := pg_temp.turno(pg_temp.pedido(17), 100);
  if r->>'reason' is distinct from 'pagos_en_revision' then raise exception 'real, pago en revisión: %', r; end if;
  if exists (select 1 from order_invoices where order_id in (pg_temp.pedido(17), pg_temp.pedido(18))) then
    raise exception 'un turno real rechazado escribió una fila';
  end if;

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

  -- emitiendo → en_duda → emitida (una persona la encontró en SimpleFact y
  -- registró su serie): pasa la serie, la nota y quién; el RUC y el total no.
  v_duda := pg_temp.fila(pg_temp.pedido(13), 'real', 'emitiendo');
  update order_invoices set status = 'en_duda', error = 'SimpleFact no contestó' where id = v_duda;
  perform pg_temp.debe_fallar(format(
    $q$update order_invoices set status = 'emitida', serie = 'B001', correlative = '97', ruc = '20000000001' where id = %L$q$,
    v_duda), 'P0001', 'Lo enviado de un comprobante no cambia');
  perform pg_temp.debe_fallar(format(
    $q$update order_invoices set status = 'emitida', serie = 'B001', correlative = '97', total = 1 where id = %L$q$,
    v_duda), 'P0001', 'Lo enviado de un comprobante no cambia');
  update order_invoices
     set status = 'emitida', serie = 'B001', correlative = '97', note = 'Está en SimpleFact con su nota',
         resolved_by = v_c, resolved_at = now()
   where id = v_duda;
  if (select (status, serie, correlative) from order_invoices where id = v_duda)
       is distinct from ('emitida'::text, 'B001'::text, '97'::text) then
    raise exception 'en_duda → emitida a mano no quedó';
  end if;
  perform pg_temp.debe_fallar(format($q$update order_invoices set note = 'otra' where id = %L$q$, v_duda),
    'P0001', 'Un comprobante emitida no cambia');

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
  -- El reintento pedido no se borra, ni quién lo pidió. (Dejar en NULL solo
  -- quién lo pidió lo hace borrar su cuenta, por la cascada: lo prueba el
  -- bloque siguiente. A mano, no.)
  perform pg_temp.debe_fallar(format($q$update order_invoices set retry_requested_at = null where id = %L$q$, v_duda),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  perform pg_temp.debe_fallar(format(
    $q$update order_invoices set retry_requested_by = null, retry_requested_at = null where id = %L$q$, v_duda),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  perform pg_temp.debe_fallar(format($q$update order_invoices set retry_requested_by = null where id = %L$q$, v_duda),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  perform pg_temp.debe_fallar(format($q$update order_invoices set resolved_by = null where id = %L$q$, v_duda),
    'P0001', 'Un error solo admite pedir su reintento, una vez');

  -- emitiendo no salta a simulada ni a externa.
  v_otro := pg_temp.fila(pg_temp.pedido(12), 'real', 'emitiendo');
  perform pg_temp.debe_fallar(format($q$update order_invoices set status = 'simulada' where id = %L$q$, v_otro),
    'P0001', 'Transición de comprobante no permitida%');
  perform pg_temp.debe_fallar(format($q$update order_invoices set status = 'externa' where id = %L$q$, v_otro),
    'P0001', 'Transición de comprobante no permitida%');
end $$;

\echo '  borrar una cuenta que tocó comprobantes deja en NULL quién fue, y nada más'
insert into auth.users (id, email) values ('25700000-0000-0000-0000-0000000000c1', 'se-va@kapta.test');
do $$
declare
  v_u     constant uuid := '25700000-0000-0000-0000-0000000000c1';
  v_c     constant uuid := '00000000-0000-0000-0000-00000000000c';
  v_ext   uuid;
  v_err   uuid;
  v_res   uuid;
begin
  -- Una externa que registró (cerrada), un error cuyo reintento pidió, y un
  -- en duda que resolvió y cuyo reintento también pidió: dos llaves a la misma
  -- cuenta en una fila.
  insert into order_invoices (id, org_id, store_id, order_id, issuer_id, ruc, mode, status, total, paid_at, request,
                              serie, correlative, note, created_by)
  values (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          pg_temp.pedido(5), pg_temp.gf(), '20556792829', 'real', 'externa', 100, now(), '{"invoice_type": "03"}',
          'B001', '99', 'Emitida a mano en SimpleFact', v_u)
  returning id into v_ext;
  insert into order_invoices (id, org_id, store_id, order_id, issuer_id, ruc, mode, status, total, paid_at, request,
                              http_status, error, retry_requested_at, retry_requested_by)
  values (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          pg_temp.pedido(6), pg_temp.gf(), '20556792829', 'real', 'error', 100, now(), '{"invoice_type": "03"}',
          422, 'SimpleFact: datos inválidos', now(), v_u)
  returning id into v_err;
  insert into order_invoices (id, org_id, store_id, order_id, issuer_id, ruc, mode, status, total, paid_at, request,
                              error, resolved_by, resolved_at, retry_requested_at, retry_requested_by)
  values (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          pg_temp.pedido(7), pg_temp.gf(), '20556792829', 'real', 'error', 100, now(), '{"invoice_type": "03"}',
          'No está en SimpleFact', v_u, now(), now(), v_u)
  returning id into v_res;

  -- A mano, poner en NULL quién fue Y cambiar cualquier otra cosa sigue sin pasar.
  perform pg_temp.debe_fallar(format($q$update order_invoices set created_by = null, note = 'otra' where id = %L$q$, v_ext),
    'P0001', 'Lo enviado de un comprobante no cambia');
  perform pg_temp.debe_fallar(format(
    $q$update order_invoices set created_by = null, updated_at = now() - interval '1 day' where id = %L$q$, v_ext),
    'P0001', 'Lo enviado de un comprobante no cambia');
  perform pg_temp.debe_fallar(format(
    $q$update order_invoices set created_by = null, status = 'emitida' where id = %L$q$, v_ext),
    'P0001', 'Lo enviado de un comprobante no cambia');
  perform pg_temp.debe_fallar(format(
    $q$update order_invoices set retry_requested_by = null, error = 'otro texto' where id = %L$q$, v_err),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  perform pg_temp.debe_fallar(format(
    $q$update order_invoices set resolved_by = null, resolved_at = null where id = %L$q$, v_res),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  -- Ni cambiar quién fue por otra persona.
  perform pg_temp.debe_fallar(format($q$update order_invoices set created_by = %L where id = %L$q$, v_c, v_ext),
    'P0001', 'Lo enviado de un comprobante no cambia');
  perform pg_temp.debe_fallar(format($q$update order_invoices set resolved_by = %L where id = %L$q$, v_c, v_res),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  -- Y un UPDATE que no cambia nada sobre una fila cerrada sigue fallando.
  perform pg_temp.debe_fallar(format($q$update order_invoices set note = note where id = %L$q$, v_ext),
    'P0001', 'Un comprobante externa no cambia');

  -- Poner en NULL SOLO quién fue, a mano, tampoco: eso lo hace únicamente la
  -- cascada de borrar la cuenta. Es el mismo UPDATE que hace la cascada, pero
  -- el candado corre un nivel más arriba (`pg_trigger_depth()` = 1).
  perform pg_temp.debe_fallar(format($q$update order_invoices set created_by = null where id = %L$q$, v_ext),
    'P0001', 'Lo enviado de un comprobante no cambia');
  perform pg_temp.debe_fallar(format($q$update order_invoices set retry_requested_by = null where id = %L$q$, v_err),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  perform pg_temp.debe_fallar(format($q$update order_invoices set resolved_by = null where id = %L$q$, v_res),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
  perform pg_temp.debe_fallar(format(
    $q$update order_invoices set retry_requested_by = null, resolved_by = null where id = %L$q$, v_res),
    'P0001', 'Un error solo admite pedir su reintento, una vez');
end $$;

-- Ni con el rol del servidor, que es el que escribe los comprobantes.
set local role service_role;
do $$
declare
  v_u   constant uuid := '25700000-0000-0000-0000-0000000000c1';
  v_col text;
  v_id  uuid;
  v_n   integer := 0;
begin
  foreach v_col in array array['created_by', 'retry_requested_by', 'resolved_by'] loop
    for v_id in execute format('select id from order_invoices where %I = %L', v_col, v_u) loop
      begin
        execute format('update order_invoices set %I = null where id = %L', v_col, v_id);
        raise exception 'service_role dejó en NULL % a mano', v_col;
      exception when sqlstate 'P0001' then
        if sqlerrm not in ('Lo enviado de un comprobante no cambia', 'Un error solo admite pedir su reintento, una vez') then
          raise;
        end if;
      end;
      v_n := v_n + 1;
    end loop;
  end loop;
  -- La externa (created_by), el error (retry_requested_by) y el resuelto (las dos).
  if v_n <> 4 then raise exception 'service_role probó % columnas, se esperaban 4', v_n; end if;
end $$;
reset role;

do $$
declare
  v_u     constant uuid := '25700000-0000-0000-0000-0000000000c1';
  v_by    constant text[] := array['created_by', 'retry_requested_by', 'resolved_by'];
  v_ids   uuid[];
  v_antes jsonb;
begin
  select array_agg(id) into v_ids
    from order_invoices where v_u in (created_by, retry_requested_by, resolved_by);
  if coalesce(array_length(v_ids, 1), 0) <> 3 then
    raise exception 'antes de borrar la cuenta: % filas suyas, se esperaban 3', coalesce(array_length(v_ids, 1), 0);
  end if;
  select jsonb_object_agg(id, to_jsonb(i) - v_by) into v_antes
    from order_invoices i where id = any (v_ids);

  -- Borrar la cuenta: `on delete set null` en las tres columnas, por el candado.
  delete from auth.users where id = v_u;

  if exists (select 1 from order_invoices
              where v_u in (created_by, retry_requested_by, resolved_by)) then
    raise exception 'quedó una referencia a la cuenta borrada';
  end if;
  if (select count(*) from order_invoices
       where id = any (v_ids)
         and created_by is null and retry_requested_by is null and resolved_by is null) <> 3 then
    raise exception 'las filas no quedaron con quién fue en NULL';
  end if;
  -- Todo lo demás, igual: estado, fechas (también `updated_at` y el reintento
  -- pedido), lo enviado y lo contestado.
  if (select jsonb_object_agg(id, to_jsonb(i) - v_by) from order_invoices i where id = any (v_ids))
       is distinct from v_antes then
    raise exception 'borrar la cuenta cambió algo más que quién fue: %',
      (select jsonb_object_agg(id, to_jsonb(i) - v_by) from order_invoices i where id = any (v_ids));
  end if;
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
    if has_function_privilege(v_rol, 'public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)', 'execute') then
      raise exception '% puede pedir el turno', v_rol;
    end if;
    if has_function_privilege(v_rol, 'public.invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)', 'execute') then
      raise exception '% puede listar los pedidos por revisar', v_rol;
    end if;
  end loop;
  foreach v_tabla in array array['invoice_issuers', 'order_invoices', 'invoice_order_checks'] loop
    if not has_table_privilege('service_role', 'public.' || v_tabla, 'select') then
      raise exception 'service_role no lee %', v_tabla;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)', 'execute') then
    raise exception 'service_role no puede pedir el turno';
  end if;
  if not has_function_privilege('service_role', 'public.invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)', 'execute') then
    raise exception 'service_role no puede listar los pedidos por revisar';
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
  begin
    perform 1 from invoice_candidates('33333333-3333-3333-3333-333333333333', 'real', now() - interval '1 day', 10, '{}');
    raise exception 'authenticated listó los pedidos por revisar';
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

-- ── h) Los pedidos por revisar ───────────────────────────────────────────────
\echo '  invoice_candidates: pagados de tiendas activas, sin lo resuelto, desde «Emitir desde», 60 días, los más nuevos primero'
-- Una organización aparte, para que nada de otras pruebas entre en la lista.
insert into organizations (id, name) values ('25700000-0000-0000-0000-0000000000a3', 'Comprobantes C');
insert into stores (id, org_id, name, shopify_domain, status) values
  ('25700000-0000-0000-0000-0000000000b3', '25700000-0000-0000-0000-0000000000a3', 'Tienda C1', 'inv-c1.myshopify.com', 'active'),
  ('25700000-0000-0000-0000-0000000000b4', '25700000-0000-0000-0000-0000000000a3', 'Tienda C2', 'inv-c2.myshopify.com', 'active'),
  ('25700000-0000-0000-0000-0000000000b5', '25700000-0000-0000-0000-0000000000a3', 'Tienda C pausada', 'inv-c3.myshopify.com', 'paused');
insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain)
values ('25700000-0000-0000-0000-0000000000a3', '20000000007', 'CANDIDATOS S.A.C.', 'candidatos');

-- Un pedido con su fila del Master y, si se da, un pago registrado entonces.
create function pg_temp.candidato(
  n            integer,
  p_created    interval,
  p_registered interval default null,
  p_store      uuid default '25700000-0000-0000-0000-0000000000b3',
  p_state      text default 'pago_completo',
  p_gateway    text default 'manual',
  p_financial  text default 'pending',
  p_validation text default 'validado'
) returns uuid language plpgsql as $$
declare
  v_id uuid := pg_temp.pedido(n);
begin
  insert into orders (id, store_id, shopify_order_id, name, created_at, total_amount, currency)
  values (v_id, p_store, 'inv-c' || n, '#INVC' || n, now() - p_created, 100, 'PEN');
  insert into order_master (order_id, store_id, shopify_order_id, order_name, order_created_at,
                            payment_state, payment_gateway, financial_status)
  values (v_id, p_store, 'inv-c' || n, '#INVC' || n, now() - p_created, p_state, p_gateway, p_financial);
  if p_registered is not null then
    insert into order_payments (store_id, order_id, kind, amount, validation_status, registered_at, validated_at)
    values (p_store, v_id, 'total', 100, p_validation, now() - p_registered,
            case when p_validation = 'validado' then now() else null end);
  end if;
  return v_id;
end $$;

-- Un comprobante de un pedido de la organización C (un error, con o sin su
-- reintento pedido).
create function pg_temp.comprobante_c(n integer, p_mode text, p_status text, p_retry timestamptz default null)
returns void language sql as $$
  insert into order_invoices (id, org_id, store_id, order_id, issuer_id, ruc, mode, status, total, paid_at, request,
                              retry_requested_at)
  values (gen_random_uuid(), '25700000-0000-0000-0000-0000000000a3', '25700000-0000-0000-0000-0000000000b3',
          pg_temp.pedido(n), (select id from invoice_issuers where ruc = '20000000007'), '20000000007',
          p_mode, p_status, 100, now(), '{"invoice_type": "03"}', p_retry)
$$;

-- La revisión del barrido de un pedido, hace tanto.
create function pg_temp.revision_c(n integer, p_mode text, p_reason text, p_hace interval) returns void language sql as $$
  insert into invoice_order_checks (order_id, mode, store_id, reason, checked_at)
  values (pg_temp.pedido(n), p_mode, '25700000-0000-0000-0000-0000000000b3', p_reason, now() - p_hace)
$$;

-- La lista como «n,n,n», en el orden en que la devuelve la función.
create function pg_temp.candidatos(
  p_mode    text,
  p_since   timestamptz default now() - interval '10 days',
  p_limit   integer default 100,
  p_blocked text[] default array['editado', 'propina'],
  p_store   uuid default null,
  p_org     uuid default '25700000-0000-0000-0000-0000000000a3'
) returns text language sql as $$
  select coalesce(string_agg(right(c.order_id::text, 12)::integer::text, ',' order by c.n), '')
    from invoice_candidates(p_org, p_mode, p_since, p_limit, p_blocked, p_store) with ordinality as c(order_id, n)
$$;

do $$
begin
  -- Entran: pagados completos con un pago validado registrado desde «Emitir desde».
  perform pg_temp.candidato(40, interval '2 days', interval '1 day');
  perform pg_temp.candidato(41, interval '3 days', interval '1 day', '25700000-0000-0000-0000-0000000000b4'); -- otra tienda de C
  perform pg_temp.candidato(43, interval '4 days', interval '1 day');   -- con un error real ya con su reintento pedido
  perform pg_temp.candidato(44, interval '5 days', interval '1 day');   -- con su simulación: entra solo en real
  perform pg_temp.candidato(45, interval '6 days', interval '1 day');   -- Shopify lo bloqueó en real hace 1 h
  perform pg_temp.candidato(46, interval '7 days', interval '1 day');   -- … hace 7 h: se relee
  perform pg_temp.candidato(47, interval '8 days', interval '1 day');   -- bloqueado hace 1 h por algo que no es de Shopify
  perform pg_temp.candidato(49, interval '36 hours', null, p_state => null, p_gateway => 'checkout', p_financial => 'paid'); -- prepago web
  perform pg_temp.candidato(54, interval '59 days', interval '1 day');  -- viejo, pagado hoy: entra
  perform pg_temp.candidato(60, interval '20 days', interval '10 days'); -- registrado justo en «Emitir desde»
  -- Con un error real sin reintento pedido: el turno real diría `error_previo`,
  -- así que en real no ocupa lugar. En simulación el turno no lo mira: entra.
  perform pg_temp.candidato(62, interval '21 days', interval '1 day');
  -- Lo mismo si el reintento pedido volvió a terminar en error.
  perform pg_temp.candidato(63, interval '22 days', interval '1 day');

  -- No entran.
  perform pg_temp.candidato(42, interval '1 day', interval '1 day');    -- emitida
  perform pg_temp.candidato(57, interval '16 days', interval '1 day');  -- externa
  perform pg_temp.candidato(58, interval '17 days', interval '1 day');  -- en duda
  perform pg_temp.candidato(59, interval '18 days', interval '1 day');  -- emitiendo
  perform pg_temp.candidato(48, interval '9 days', interval '1 day', p_state => 'pago_parcial'); -- no está pagado
  perform pg_temp.candidato(50, interval '11 days', null, p_state => null, p_gateway => 'checkout', p_financial => 'paid'); -- prepago antes del inicio
  perform pg_temp.candidato(51, interval '12 days', interval '11 days'); -- pagado antes del inicio
  perform pg_temp.candidato(52, interval '13 days', interval '1 day', p_validation => 'pendiente_revision'); -- pago sin validar
  perform pg_temp.candidato(53, interval '61 days', interval '1 day');  -- más de 60 días: Shopify ya no lo deja leer
  perform pg_temp.candidato(55, interval '14 days', interval '1 day', '25700000-0000-0000-0000-0000000000b5'); -- tienda pausada
  perform pg_temp.candidato(56, interval '15 days', interval '1 day', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); -- otra organización
  -- Registrado antes del inicio y validado hoy: cuenta cuándo se registró.
  perform pg_temp.candidato(61, interval '19 days', interval '11 days');

  perform pg_temp.comprobante_c(42, 'real', 'emitida');
  perform pg_temp.comprobante_c(57, 'real', 'externa');
  perform pg_temp.comprobante_c(58, 'real', 'en_duda');
  perform pg_temp.comprobante_c(59, 'real', 'emitiendo');
  perform pg_temp.comprobante_c(43, 'real', 'error', now());   -- un error no es boleta, y su reintento se pidió
  perform pg_temp.comprobante_c(62, 'real', 'error');
  perform pg_temp.comprobante_c(63, 'real', 'error', now() - interval '1 hour');
  perform pg_temp.comprobante_c(63, 'real', 'error');
  perform pg_temp.comprobante_c(44, 'simulacion', 'simulada');
  perform pg_temp.revision_c(45, 'real', 'editado', interval '1 hour');
  perform pg_temp.revision_c(46, 'real', 'editado', interval '7 hours');
  perform pg_temp.revision_c(47, 'real', 'pago_sin_cuenta', interval '1 hour');

  -- En real, sin 62 ni 63: esperan que una persona pida reintentar su error.
  if pg_temp.candidatos('real') is distinct from '49,40,41,43,44,46,47,60,54' then
    raise exception 'real: %', pg_temp.candidatos('real');
  end if;
  -- En simulación: sin la simulada (44); el bloqueo de Shopify es de real (45
  -- entra), y un error real no frena una simulación (62 y 63 entran).
  if pg_temp.candidatos('simulacion') is distinct from '49,40,41,43,45,46,47,60,62,63,54' then
    raise exception 'simulación: %', pg_temp.candidatos('simulacion');
  end if;
  -- Sin la lista de motivos de Shopify, nada se salta.
  if pg_temp.candidatos('real', p_blocked => null) is distinct from '49,40,41,43,44,45,46,47,60,54' then
    raise exception 'sin motivos bloqueados: %', pg_temp.candidatos('real', p_blocked => null);
  end if;
  -- Un día más tarde de inicio: se va el registrado justo al borde (60).
  if pg_temp.candidatos('real', now() - interval '9 days') is distinct from '49,40,41,43,44,46,47,54' then
    raise exception 'desde hace 9 días: %', pg_temp.candidatos('real', now() - interval '9 days');
  end if;
  -- El límite se queda con los más nuevos.
  if pg_temp.candidatos('real', p_limit => 2) is distinct from '49,40' then
    raise exception 'límite 2: %', pg_temp.candidatos('real', p_limit => 2);
  end if;
  if pg_temp.candidatos('real', p_limit => 0) <> '' or pg_temp.candidatos('real', p_limit => null) <> ''
     or pg_temp.candidatos('real', p_limit => -1) <> '' then
    raise exception 'un límite de cero, nulo o negativo devolvió algo';
  end if;
  -- Una sola tienda.
  if pg_temp.candidatos('real', p_store => '25700000-0000-0000-0000-0000000000b4') is distinct from '41' then
    raise exception 'tienda C2: %', pg_temp.candidatos('real', p_store => '25700000-0000-0000-0000-0000000000b4');
  end if;
  -- Sin «Emitir desde», o con un modo que no es de escritura: nada.
  if pg_temp.candidatos('real', null) <> '' then raise exception 'sin inicio: %', pg_temp.candidatos('real', null); end if;
  if pg_temp.candidatos('apagado') <> '' or pg_temp.candidatos(null) <> '' then
    raise exception 'un modo que no es de escritura devolvió algo';
  end if;
  -- El de la tienda A es de su organización, no de C.
  if position(',56,' in ',' || pg_temp.candidatos('real', p_org => '33333333-3333-3333-3333-333333333333', p_limit => 1000) || ',') = 0 then
    raise exception 'el pedido 56 no salió en su organización';
  end if;

  -- Una persona pide reintentar el error de 62: vuelve a entrar en real. El de
  -- 63 sigue esperando (su primer reintento ya terminó en otro error).
  update order_invoices set retry_requested_at = now()
   where order_id = pg_temp.pedido(62) and status = 'error';
  if pg_temp.candidatos('real') is distinct from '49,40,41,43,44,46,47,60,62,54' then
    raise exception 'real con el reintento de 62 pedido: %', pg_temp.candidatos('real');
  end if;
end $$;

-- Solo el servidor la llama.
set local request.test_uid = '00000000-0000-0000-0000-00000000000c';
set local role authenticated;
do $$
begin
  perform 1 from invoice_candidates('25700000-0000-0000-0000-0000000000a3', 'real', now() - interval '10 days', 10, '{}');
  raise exception 'authenticated listó los pedidos por revisar';
exception when insufficient_privilege then null;
end $$;
reset role;
set local role anon;
do $$
begin
  perform 1 from invoice_candidates('25700000-0000-0000-0000-0000000000a3', 'real', now() - interval '10 days', 10, '{}');
  raise exception 'anon listó los pedidos por revisar';
exception when insufficient_privilege then null;
end $$;
reset role;
set local role service_role;
do $$
begin
  if (select count(*) from invoice_candidates('25700000-0000-0000-0000-0000000000a3', 'real',
                                              now() - interval '10 days', 100, array['editado'])) <> 10 then
    raise exception 'service_role no ve los pedidos por revisar';
  end if;
end $$;
reset role;

-- ── i) La 0260 sobre la 0257 que corrió en producción ───────────────────────
\echo '  0260 sobre la 0257 de producción: las cuatro funciones de la revisión, sin tocar datos ni recrear triggers, y dos veces es una'
-- Producción tenía la 0257 tal como está en el repositorio (14-10-2026), un RUC
-- en simulación y ningún comprobante, cuando corrió la 0260. La 0260 cambia
-- cuatro funciones y nada más. Aquí, con un RUC en simulación y los
-- comprobantes de las pruebas de arriba: la 0257 sola deja las funciones de
-- antes de la revisión (es la que corrió: lo nuevo no se le escribe a ella);
-- la 0260 deja las de ahora con los mismos oids, así que los triggers de la
-- 0257 —que guardan el oid— las llaman sin recrearse; ninguna fila cambia; y
-- correr la 0260 otra vez no cambia nada.
--
-- Después vino la 0261, y lo que deja la cadena entera ya no es la 0260 en dos
-- de esas funciones: `invoice_issuers_touch` y el turno, que pasó a tener once
-- argumentos. La 0257 y la 0260 vuelven a crear el de nueve junto al de once;
-- la 0261, al final, lo borra y deja todo como lo dejó la cadena.
update invoice_issuers set mode = 'simulacion', emit_from = now()
 where org_id = '25700000-0000-0000-0000-0000000000a1' and ruc = '20556792829';

-- Una foto por paso: cada función (su oid y su definición), los triggers que
-- las llaman y los datos de comprobantes.
create temp table foto_0260 (paso text, cosa text, valor text, primary key (paso, cosa));
create function pg_temp.foto_0260(p_paso text) returns void language sql as $$
  insert into foto_0260 (paso, cosa, valor)
  select p_paso, f, coalesce(to_regprocedure(f)::oid::text, '-') || ' ' || coalesce(pg_get_functiondef(to_regprocedure(f)), '-')
    from unnest(array[
      'invoice_issuers_touch()',
      'order_invoices_guard()',
      'invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)',
      'invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)',
      'invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)'
    ]) as f
  union all
  select p_paso, 'triggers', string_agg(format('%s/%s→%s', tgname, oid, tgfoid::regprocedure), ', ' order by tgname)
    from pg_trigger where tgname in ('invoice_issuers_touch', 'order_invoices_guard')
  union all
  select p_paso, 'datos', md5(concat_ws('|',
    (select jsonb_agg(to_jsonb(i) order by i.id)::text from invoice_issuers i),
    (select jsonb_agg(jsonb_build_array(a.id, a.invoice_issuer_id) order by a.id)::text from store_collection_accounts a),
    (select jsonb_agg(to_jsonb(o) order by o.id)::text from order_invoices o),
    (select jsonb_agg(to_jsonb(c) order by c.order_id, c.mode)::text from invoice_order_checks c)))
$$;
create function pg_temp.en_0260(p_paso text, p_cosa text) returns text language sql stable as $$
  select valor from foto_0260 where paso = p_paso and cosa = p_cosa
$$;

do $$ begin perform pg_temp.foto_0260('antes'); end $$;
\ir ../../db/migrations/0257_invoices.sql
do $$ begin perform pg_temp.foto_0260('0257'); end $$;
\ir ../../db/migrations/0260_invoices_hardening.sql
do $$ begin perform pg_temp.foto_0260('0260'); end $$;
\ir ../../db/migrations/0260_invoices_hardening.sql
do $$ begin perform pg_temp.foto_0260('0260 otra vez'); end $$;
\ir ../../db/migrations/0261_invoices_manual.sql
do $$ begin perform pg_temp.foto_0260('0261'); end $$;

do $$
declare
  c_touch      constant text := 'invoice_issuers_touch()';
  c_guard      constant text := 'order_invoices_guard()';
  c_claim      constant text := 'invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)';
  c_claim11    constant text := 'invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)';
  c_candidates constant text := 'invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)';
  v_fn   text;
  v_paso text;
  v_rol  text;
  v_n    integer;
begin
  if (select count(*) from invoice_issuers where mode = 'simulacion') = 0
     or (select count(*) from order_invoices) = 0 then
    raise exception 'la foto no tiene un RUC en simulación ni comprobantes que cuidar';
  end if;
  -- Cada paso con sus siete cosas, y cada función existe en cada paso: sin
  -- esto, un NULL haría pasar en silencio las comparaciones de abajo. La única
  -- que falta es el turno de nueve antes y después de la cadena: la 0261 lo
  -- borra, y la 0257 y la 0260 lo vuelven a crear.
  if (select count(*) from foto_0260 where valor is not null and valor not like '-%') <> 5 * 7 - 2
     or (pg_temp.en_0260('antes', c_claim) like '-%') is not true
     or (pg_temp.en_0260('0261', c_claim) like '-%') is not true then
    raise exception 'foto incompleta: %', (select string_agg(paso || '/' || cosa, ', ') from foto_0260
                                           where valor is null or valor like '-%');
  end if;

  -- La 0257 sola: las funciones de antes de la revisión. Si esto falla, alguien
  -- volvió a escribir lo nuevo dentro de la 0257, que ya corrió en producción.
  if (pg_temp.en_0260('0257', c_touch) like '%new.check_error := null;%') is not false then
    raise exception 'la 0257 ya borra check_error: lo nuevo va en otra migración';
  end if;
  if (pg_temp.en_0260('0257', c_guard) like '%pg_trigger_depth()%') is not false then
    raise exception 'la 0257 ya tiene la excepción de la cascada: lo nuevo va en otra migración';
  end if;
  if (pg_temp.en_0260('0257', c_claim) like '%pagos_en_revision%') is not false
     or (pg_temp.en_0260('0257', c_claim) like '%max(registered_at)%') is not false then
    raise exception 'la 0257 ya revisa los pagos en el turno: lo nuevo va en otra migración';
  end if;
  -- La 0257 no crea ni borra invoice_candidates, ni toca el turno de once: los
  -- que había siguen igual.
  if pg_temp.en_0260('0257', c_candidates) is distinct from pg_temp.en_0260('antes', c_candidates) then
    raise exception 'la 0257 tocó invoice_candidates';
  end if;
  if pg_temp.en_0260('0257', c_claim11) is distinct from pg_temp.en_0260('antes', c_claim11) then
    raise exception 'la 0257 tocó el turno de once argumentos';
  end if;

  -- La 0260: las cuatro de ahora.
  if (pg_temp.en_0260('0260', c_touch) like '%new.check_error := null;%') is not true then
    raise exception '0260: invoice_issuers_touch no borra check_error';
  end if;
  if (pg_temp.en_0260('0260', c_guard) like '%if pg_trigger_depth() > 1%') is not true then
    raise exception '0260: order_invoices_guard sin la excepción de la cascada';
  end if;
  if (pg_temp.en_0260('0260', c_claim) like '%''reason'', ''pagos_en_revision''%') is not true
     or (pg_temp.en_0260('0260', c_claim) like '%max(registered_at) into v_live, v_paid%') is not true
     or (pg_temp.en_0260('0260', c_claim) like '%greatest(p_paid_at, v_paid)%') is not true then
    raise exception '0260: invoice_claim no saca de la base cuándo quedó pagado';
  end if;
  if to_regprocedure(c_candidates) is null
     or (pg_temp.en_0260('0260', c_candidates) like '%from order_master m%') is not true then
    raise exception '0260: falta invoice_candidates';
  end if;
  -- La 0260 no conoce «Manual»: eso lo trae la 0261.
  if (pg_temp.en_0260('0260', c_touch) like '%manual%') is not false
     or (pg_temp.en_0260('0260', c_claim) like '%manual%') is not false then
    raise exception 'la 0260 ya habla de «Manual»: lo nuevo va en otra migración';
  end if;

  -- Lo que dejó verify-db (todas las migraciones, en orden): la 0260 en las dos
  -- que la 0261 no toca, y la 0261 en las otras dos.
  foreach v_fn in array array[c_guard, c_candidates] loop
    if pg_temp.en_0260('antes', v_fn) is distinct from pg_temp.en_0260('0260', v_fn) then
      raise exception 'la cadena de migraciones no deja % como la 0260', v_fn;
    end if;
  end loop;
  foreach v_fn in array array[c_touch, c_claim, c_claim11, c_candidates, c_guard] loop
    if pg_temp.en_0260('antes', v_fn) is distinct from pg_temp.en_0260('0261', v_fn) then
      raise exception 'la 0261 al final no deja % como la dejó la cadena', v_fn;
    end if;
  end loop;

  -- `create or replace` conserva el oid: lo que los triggers guardan.
  foreach v_fn in array array[c_touch, c_guard, c_claim11, c_candidates] loop
    foreach v_paso in array array['0257', '0260', '0260 otra vez', '0261'] loop
      if split_part(pg_temp.en_0260(v_paso, v_fn), ' ', 1) is distinct from split_part(pg_temp.en_0260('antes', v_fn), ' ', 1) then
        raise exception '% cambió de oid en el paso %', v_fn, v_paso;
      end if;
    end loop;
  end loop;
  -- El turno de nueve: lo crea la 0257 y la 0260 lo reemplaza en su lugar.
  foreach v_paso in array array['0260', '0260 otra vez'] loop
    if split_part(pg_temp.en_0260(v_paso, c_claim), ' ', 1) is distinct from split_part(pg_temp.en_0260('0257', c_claim), ' ', 1) then
      raise exception 'el turno de nueve cambió de oid en el paso %', v_paso;
    end if;
  end loop;

  foreach v_fn in array array[c_touch, c_guard, c_claim11, c_candidates] loop
    -- Una sola versión de cada una: ninguna sobrecarga olvidada (tampoco el
    -- turno de nueve, que la 0261 borró).
    select count(*) into v_n from pg_proc
     where pronamespace = 'public'::regnamespace and proname = split_part(v_fn, '(', 1);
    if v_n <> 1 then raise exception '% tiene % versiones', split_part(v_fn, '(', 1), v_n; end if;
    -- Ni el navegador ni nadie más la ejecuta.
    foreach v_rol in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_rol, v_fn, 'execute') then
        raise exception '% puede ejecutar %', v_rol, v_fn;
      end if;
    end loop;
  end loop;
  if not has_function_privilege('service_role', c_claim11, 'execute')
     or not has_function_privilege('service_role', c_candidates, 'execute') then
    raise exception 'service_role no puede pedir el turno o la lista';
  end if;

  -- Ni la 0260 ni la 0261 recrean los triggers: los mismos, llamando a las
  -- mismas funciones.
  foreach v_paso in array array['0260', '0260 otra vez', '0261'] loop
    if pg_temp.en_0260(v_paso, 'triggers') is distinct from pg_temp.en_0260('0257', 'triggers') then
      raise exception 'el paso % recreó triggers: % → %', v_paso, pg_temp.en_0260('0257', 'triggers'),
        pg_temp.en_0260(v_paso, 'triggers');
    end if;
  end loop;
  if (pg_temp.en_0260('0260', 'triggers') like '%invoice_issuers_touch/%→invoice_issuers_touch()%') is not true
     or (pg_temp.en_0260('0260', 'triggers') like '%order_invoices_guard/%→order_invoices_guard()%') is not true then
    raise exception 'triggers: %', pg_temp.en_0260('0260', 'triggers');
  end if;

  -- Ningún dato cambia, en ningún paso; y la segunda 0260 es la primera.
  foreach v_paso in array array['0257', '0260', '0260 otra vez', '0261'] loop
    if pg_temp.en_0260(v_paso, 'datos') is distinct from pg_temp.en_0260('antes', 'datos') then
      raise exception 'el paso % cambió datos de comprobantes', v_paso;
    end if;
  end loop;
  if exists (
    select 1
      from (select cosa, valor from foto_0260 where paso = '0260') a
      full join (select cosa, valor from foto_0260 where paso = '0260 otra vez') b using (cosa)
     where a.valor is distinct from b.valor
  ) then
    raise exception 'correr la 0260 otra vez cambió algo';
  end if;
end $$;

-- Y el trigger de siempre ya llama a la función de ahora: un token nuevo borra
-- el motivo de la prueba anterior.
do $$
declare
  v_y invoice_issuers;
begin
  update invoice_issuers set check_error = 'Token rechazado (401).'
   where org_id = '25700000-0000-0000-0000-0000000000a1' and ruc = '20556792829';
  update invoice_issuers set token_enc = 'enc:otro-token'
   where org_id = '25700000-0000-0000-0000-0000000000a1' and ruc = '20556792829'
  returning * into v_y;
  if v_y.check_error is not null or v_y.checked_at is not null or v_y.mode <> 'simulacion' then
    raise exception 'token nuevo tras la 0260 y la 0261: % % %', v_y.check_error, v_y.checked_at, v_y.mode;
  end if;
end $$;

-- ── j) El modo «Manual» (0261) ───────────────────────────────────────────────
\echo '  0261 sobre lo que hay en producción: admite «Manual», deja un solo turno y no toca datos ni triggers'
-- Producción (15-10-2026) tiene la 0257 y la 0260: el CHECK del modo que la
-- 0257 escribió dentro de la columna (sin 'manual', con el nombre que le puso
-- Postgres), `invoice_issuers_real_ready` solo para Real, el turno de nueve
-- argumentos y no el de once. Se deja la base así, con los RUC y los
-- comprobantes de las pruebas de arriba, y se corre la 0261 encima.
alter table invoice_issuers drop constraint invoice_issuers_mode_check;
alter table invoice_issuers add check (mode in ('apagado', 'simulacion', 'real'));
alter table invoice_issuers drop constraint invoice_issuers_real_ready;
alter table invoice_issuers add constraint invoice_issuers_real_ready check (
  mode <> 'real'
  or (token_enc is not null and emit_from is not null and checked_ruc is not null and checked_ruc = ruc)
);
drop function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid);
\ir ../../db/migrations/0260_invoices_hardening.sql

-- Una foto por paso: cada función (oid, definición y permisos), cada CHECK de
-- los RUC (oid y definición), los triggers, los datos y los comentarios.
create temp table foto_0261 (paso text, cosa text, valor text, primary key (paso, cosa));
create function pg_temp.foto_0261(p_paso text) returns void language sql as $$
  insert into foto_0261 (paso, cosa, valor)
  select p_paso, f, coalesce(p.oid::text, '-') || ' ' || coalesce(pg_get_functiondef(p.oid), '-')
                    || ' ' || coalesce(p.proacl::text, '-')
    from unnest(array[
      'invoice_issuers_touch()',
      'order_invoices_guard()',
      'invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)',
      'invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)',
      'invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)'
    ]) as f
    left join pg_proc p on p.oid = to_regprocedure(f)
  union all
  select p_paso, 'check ' || c.conname, c.oid::text || ' ' || pg_get_constraintdef(c.oid)
    from pg_constraint c where c.conrelid = 'invoice_issuers'::regclass and c.contype = 'c'
  union all
  select p_paso, 'triggers', string_agg(format('%s/%s→%s', tgname, oid, tgfoid::regprocedure), ', ' order by tgname)
    from pg_trigger where tgname in ('invoice_issuers_touch', 'order_invoices_guard')
  union all
  select p_paso, 'datos', md5(concat_ws('|',
    (select jsonb_agg(to_jsonb(i) order by i.id)::text from invoice_issuers i),
    (select jsonb_agg(jsonb_build_array(a.id, a.invoice_issuer_id) order by a.id)::text from store_collection_accounts a),
    (select jsonb_agg(to_jsonb(o) order by o.id)::text from order_invoices o),
    (select jsonb_agg(to_jsonb(c) order by c.order_id, c.mode)::text from invoice_order_checks c)))
  union all
  select p_paso, 'comentarios', concat_ws(' | ',
    col_description('invoice_issuers'::regclass,
                    (select attnum from pg_attribute where attrelid = 'invoice_issuers'::regclass and attname = 'mode')),
    col_description('order_invoices'::regclass,
                    (select attnum from pg_attribute where attrelid = 'order_invoices'::regclass and attname = 'created_by')))
$$;
create function pg_temp.en_0261(p_paso text, p_cosa text) returns text language sql stable as $$
  select valor from foto_0261 where paso = p_paso and cosa = p_cosa
$$;
-- Los CHECK de una sola columna sobre `mode`, por nombre.
create function pg_temp.checks_del_modo() returns text language sql stable as $$
  select coalesce(string_agg(c.conname, ', ' order by c.conname), '')
    from pg_constraint c
   where c.conrelid = 'invoice_issuers'::regclass and c.contype = 'c'
     and c.conkey = array[(select attnum from pg_attribute where attrelid = 'invoice_issuers'::regclass and attname = 'mode')]
$$;

do $$ begin perform pg_temp.foto_0261('produccion'); end $$;
\ir ../../db/migrations/0261_invoices_manual.sql
do $$ begin perform pg_temp.foto_0261('0261'); end $$;

do $$
declare
  c_touch   constant text := 'invoice_issuers_touch()';
  c_guard   constant text := 'order_invoices_guard()';
  c_claim9  constant text := 'invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)';
  c_claim11 constant text := 'invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)';
  c_cand    constant text := 'invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)';
  v_cosa text;
begin
  -- La foto de producción es la de producción: RUC y comprobantes que cuidar,
  -- el CHECK del modo sin 'manual' con el nombre que le puso Postgres, real
  -- listo solo para Real, y el turno de nueve sin el de once.
  if (select count(*) from invoice_issuers where mode in ('simulacion', 'real')) = 0
     or (select count(*) from order_invoices) = 0 then
    raise exception 'la foto de producción no tiene RUC encendidos ni comprobantes que cuidar';
  end if;
  if (pg_temp.en_0261('produccion', 'check invoice_issuers_mode_check') like '%''real''%') is not true
     or (pg_temp.en_0261('produccion', 'check invoice_issuers_mode_check') like '%''manual''%') is not false
     or (pg_temp.en_0261('produccion', 'check invoice_issuers_real_ready') like '%''real''%') is not true
     or (pg_temp.en_0261('produccion', 'check invoice_issuers_real_ready') like '%''manual''%') is not false
     or (pg_temp.en_0261('produccion', c_claim9) like '-%') is not false
     or (pg_temp.en_0261('produccion', c_claim11) like '-%') is not true then
    raise exception 'la foto de producción no es la de producción: %',
      (select string_agg(cosa || ' = ' || left(valor, 60), '; ') from foto_0261 where paso = 'produccion');
  end if;

  -- Los CHECK: el del modo y el de real listo admiten Manual, con los mismos
  -- nombres; un solo CHECK de la columna `mode`; los otros cuatro, intactos
  -- (ni su oid cambia).
  if (pg_temp.en_0261('0261', 'check invoice_issuers_mode_check') like '%''manual''%') is not true
     or (pg_temp.en_0261('0261', 'check invoice_issuers_mode_check') like '%''apagado''%') is not true
     or (pg_temp.en_0261('0261', 'check invoice_issuers_mode_check') like '%''simulacion''%') is not true
     or (pg_temp.en_0261('0261', 'check invoice_issuers_mode_check') like '%''real''%') is not true
     or (pg_temp.en_0261('0261', 'check invoice_issuers_real_ready') like '%''manual''%') is not true
     or (pg_temp.en_0261('0261', 'check invoice_issuers_real_ready') like '%''real''%') is not true then
    raise exception '0261: los CHECK no admiten Manual: % / %',
      pg_temp.en_0261('0261', 'check invoice_issuers_mode_check'), pg_temp.en_0261('0261', 'check invoice_issuers_real_ready');
  end if;
  if pg_temp.checks_del_modo() <> 'invoice_issuers_mode_check' then
    raise exception '0261: CHECK de la columna mode: %', pg_temp.checks_del_modo();
  end if;
  if (select array_agg(cosa order by cosa) from foto_0261 where paso = '0261' and cosa like 'check %')
       is distinct from (select array_agg(cosa order by cosa) from foto_0261 where paso = 'produccion' and cosa like 'check %') then
    raise exception '0261: cambió la lista de CHECK';
  end if;
  for v_cosa in select cosa from foto_0261 where paso = 'produccion' and cosa like 'check %'
                   and cosa not in ('check invoice_issuers_mode_check', 'check invoice_issuers_real_ready') loop
    if pg_temp.en_0261('0261', v_cosa) is distinct from pg_temp.en_0261('produccion', v_cosa) then
      raise exception '0261 tocó %', v_cosa;
    end if;
  end loop;

  -- Un solo turno, el de once: sin el de nueve, la llamada por nombre del código
  -- de hoy no es ambigua.
  if (pg_temp.en_0261('0261', c_claim9) like '-%') is not true
     or (pg_temp.en_0261('0261', c_claim11) like '-%') is not false
     or (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'invoice_claim') <> 1 then
    raise exception '0261: los turnos quedaron así: nueve %, once %', left(pg_temp.en_0261('0261', c_claim9), 20),
      left(pg_temp.en_0261('0261', c_claim11), 20);
  end if;
  if (pg_temp.en_0261('0261', c_claim11) like '%p_mode text DEFAULT NULL::text, p_created_by uuid DEFAULT NULL::uuid%') is not true then
    raise exception '0261: el turno de once sin sus dos argumentos opcionales';
  end if;

  -- `invoice_issuers_touch` cambia en su lugar (mismo oid: el trigger de la
  -- 0257 la llama sin recrearse); las otras dos funciones, intactas.
  if split_part(pg_temp.en_0261('0261', c_touch), ' ', 1) is distinct from split_part(pg_temp.en_0261('produccion', c_touch), ' ', 1)
     or (pg_temp.en_0261('0261', c_touch) like '%if new.mode in (''real'', ''manual'') then%') is not true
     or (pg_temp.en_0261('produccion', c_touch) like '%manual%') is not false then
    raise exception '0261: invoice_issuers_touch no baja Manual en su lugar';
  end if;
  foreach v_cosa in array array[c_guard, c_cand] loop
    if pg_temp.en_0261('0261', v_cosa) is distinct from pg_temp.en_0261('produccion', v_cosa) then
      raise exception '0261 tocó %', v_cosa;
    end if;
  end loop;
  if pg_temp.en_0261('0261', 'triggers') is distinct from pg_temp.en_0261('produccion', 'triggers') then
    raise exception '0261 recreó triggers: % → %', pg_temp.en_0261('produccion', 'triggers'), pg_temp.en_0261('0261', 'triggers');
  end if;
  -- Ningún dato cambia.
  if pg_temp.en_0261('0261', 'datos') is distinct from pg_temp.en_0261('produccion', 'datos') then
    raise exception '0261 cambió datos de comprobantes';
  end if;
  if (pg_temp.en_0261('0261', 'comentarios') like '%manual = el barrido simula%') is not true then
    raise exception '0261: el comentario del modo no dice qué es Manual';
  end if;
end $$;

-- Y si el CHECK de la 0257 se llamara de otra forma, igual: la 0261 no adivina
-- el nombre, busca el CHECK de la columna `mode`.
savepoint nombre_raro;
alter table invoice_issuers drop constraint invoice_issuers_mode_check;
alter table invoice_issuers add constraint invoice_issuers_modo_0257 check (mode in ('apagado', 'simulacion', 'real'));
\ir ../../db/migrations/0261_invoices_manual.sql
do $$
begin
  if pg_temp.checks_del_modo() <> 'invoice_issuers_mode_check' then
    raise exception 'con el CHECK de otro nombre, quedaron: %', pg_temp.checks_del_modo();
  end if;
end $$;
rollback to savepoint nombre_raro;
release savepoint nombre_raro;

\echo '  «Manual» exige lo que exige Real —token, «Emitir desde» y la prueba del RUC— y baja como Real'
-- Una organización aparte, con su RUC apagado y sin token.
insert into organizations (id, name) values ('25700000-0000-0000-0000-0000000000a4', 'Comprobantes M');
insert into stores (id, org_id, name, shopify_domain, status) values
  ('25700000-0000-0000-0000-0000000000b6', '25700000-0000-0000-0000-0000000000a4', 'Tienda M', 'inv-m.myshopify.com', 'active');
insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain)
values ('25700000-0000-0000-0000-0000000000a4', '20000000009', 'MANUAL S.A.C.', 'manual');

create function pg_temp.m() returns uuid language sql stable as $$
  select id from invoice_issuers
   where org_id = '25700000-0000-0000-0000-0000000000a4' and legal_name = 'MANUAL S.A.C.'
$$;

do $$
declare
  v_org constant uuid := '25700000-0000-0000-0000-0000000000a4';
  v_m   constant uuid := pg_temp.m();
  v_iss invoice_issuers;
begin
  -- Un modo que no existe, no.
  perform pg_temp.debe_fallar(format($q$update invoice_issuers set mode = 'automatico' where id = %L$q$, v_m),
    '23514', '%invoice_issuers_mode_check%');

  -- Manual sin token: no.
  perform pg_temp.debe_fallar(format($q$update invoice_issuers set mode = 'manual' where id = %L$q$, v_m),
    '23514', '%invoice_issuers_real_ready%');
  -- Con token y una fecha de hace tres días, puesta con el RUC apagado. Sin
  -- prueba: no.
  update invoice_issuers set token_enc = 'enc:m-no-es-token', emit_from = now() - interval '3 days' where id = v_m;
  perform pg_temp.debe_fallar(format($q$update invoice_issuers set mode = 'manual' where id = %L$q$, v_m),
    '23514', '%invoice_issuers_real_ready%');
  -- La prueba leyó OTRO RUC: no.
  update invoice_issuers set checked_ruc = '20000000001', checked_at = now() where id = v_m;
  perform pg_temp.debe_fallar(format($q$update invoice_issuers set mode = 'manual' where id = %L$q$, v_m),
    '23514', '%invoice_issuers_real_ready%');
  -- Sin «Emitir desde»: no.
  update invoice_issuers set checked_ruc = '20000000009', emit_from = null where id = v_m;
  perform pg_temp.debe_fallar(format($q$update invoice_issuers set mode = 'manual' where id = %L$q$, v_m),
    '23514', '%invoice_issuers_real_ready%');
  -- Un alta ya en Manual sin token: no. Con todo, sí, y no nace con «Emitir
  -- desde» atrás.
  perform pg_temp.debe_fallar(format(
    $q$insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain, mode, emit_from, checked_ruc)
       values (%L, '20000000010', 'OTRA MANUAL S.A.C.', 'otramanual', 'manual', now(), '20000000010')$q$, v_org),
    '23514', '%invoice_issuers_real_ready%');
  insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain, mode, token_enc, emit_from, checked_ruc, checked_at)
  values (v_org, '20000000010', 'OTRA MANUAL S.A.C.', 'otramanual', 'manual', 'enc:otra', now() - interval '1 day',
          '20000000010', now())
  returning * into v_iss;
  if (v_iss.mode, v_iss.emit_from) is distinct from ('manual', now()) then
    raise exception 'alta en Manual: % desde %', v_iss.mode, v_iss.emit_from;
  end if;
  delete from invoice_issuers where id = v_iss.id;

  -- Con todo, sí. Y «Emitir desde», que había quedado atrás, se mueve al
  -- momento del cambio: Manual cuenta como encendido.
  update invoice_issuers set emit_from = now() - interval '3 days' where id = v_m;
  update invoice_issuers set mode = 'manual' where id = v_m;
  select * into v_iss from invoice_issuers where id = v_m;
  if (v_iss.mode, v_iss.emit_from) is distinct from ('manual', now()) then
    raise exception 'a Manual: modo % desde %', v_iss.mode, v_iss.emit_from;
  end if;

  -- Un token nuevo baja a Simulación y borra la prueba y su motivo, como en Real.
  update invoice_issuers set check_error = 'Token rechazado (401).' where id = v_m;
  update invoice_issuers set token_enc = 'enc:m-otro' where id = v_m;
  select * into v_iss from invoice_issuers where id = v_m;
  if v_iss.mode <> 'simulacion' or v_iss.checked_ruc is not null or v_iss.checked_at is not null
     or v_iss.check_error is not null then
    raise exception 'token nuevo en Manual: modo % prueba % % motivo %',
      v_iss.mode, v_iss.checked_ruc, v_iss.checked_at, v_iss.check_error;
  end if;
  -- Igual un subdominio nuevo.
  update invoice_issuers set checked_ruc = '20000000009', checked_at = now() where id = v_m;
  update invoice_issuers set mode = 'manual' where id = v_m;
  update invoice_issuers set simplefact_subdomain = 'manual2' where id = v_m;
  select * into v_iss from invoice_issuers where id = v_m;
  if v_iss.mode <> 'simulacion' or v_iss.checked_ruc is not null then
    raise exception 'subdominio nuevo en Manual: modo % prueba %', v_iss.mode, v_iss.checked_ruc;
  end if;
  update invoice_issuers set simplefact_subdomain = 'manual' where id = v_m;
  -- Igual un RUC nuevo.
  update invoice_issuers set checked_ruc = '20000000009', checked_at = now() where id = v_m;
  update invoice_issuers set mode = 'manual' where id = v_m;
  update invoice_issuers set ruc = '20000000011' where id = v_m;
  select * into v_iss from invoice_issuers where id = v_m;
  if v_iss.mode <> 'simulacion' or v_iss.checked_ruc is not null then
    raise exception 'RUC nuevo en Manual: modo % prueba %', v_iss.mode, v_iss.checked_ruc;
  end if;
  update invoice_issuers set ruc = '20000000009' where id = v_m;

  -- Repetir la prueba en Manual: si lee otro RUC, o no lee nada, se guarda lo
  -- que leyó y el RUC baja a Simulación (sin esto chocaba con el check, y
  -- Ajustes no podía registrar la prueba fallida).
  update invoice_issuers set checked_ruc = '20000000009', checked_at = now() where id = v_m;
  update invoice_issuers set mode = 'manual' where id = v_m;
  update invoice_issuers set checked_ruc = '20000000001', checked_at = now(), check_error = 'Los archivos son de otro RUC'
   where id = v_m;
  select * into v_iss from invoice_issuers where id = v_m;
  if (v_iss.mode, v_iss.checked_ruc, v_iss.check_error)
       is distinct from ('simulacion', '20000000001', 'Los archivos son de otro RUC') then
    raise exception 'prueba con otro RUC en Manual: % % %', v_iss.mode, v_iss.checked_ruc, v_iss.check_error;
  end if;
  update invoice_issuers set checked_ruc = '20000000009', check_error = null where id = v_m;
  update invoice_issuers set mode = 'manual' where id = v_m;
  update invoice_issuers set checked_ruc = null, checked_at = now(), check_error = 'SimpleFact no contestó' where id = v_m;
  if (select mode from invoice_issuers where id = v_m) <> 'simulacion' then
    raise exception 'una prueba sin lectura dejó el RUC en Manual';
  end if;

  -- Pedir a la vez otro modo encendido y guardar una prueba que no confirma no
  -- se calla: falla. Solo baja sola la prueba repetida sin cambiar de modo.
  update invoice_issuers set checked_ruc = '20000000009', check_error = null where id = v_m;
  update invoice_issuers set mode = 'manual' where id = v_m;
  perform pg_temp.debe_fallar(format(
    $q$update invoice_issuers set mode = 'real', checked_ruc = '20000000001' where id = %L$q$, v_m),
    '23514', '%invoice_issuers_real_ready%');

  -- De Manual a Real y de vuelta, con la prueba buena, se puede; y «Emitir
  -- desde» que quedó atrás se mueve en cada cambio (sin cambio, no).
  update invoice_issuers set emit_from = now() - interval '1 day' where id = v_m;
  if (select emit_from from invoice_issuers where id = v_m) <> now() - interval '1 day' then
    raise exception 'la fecha se movió sin cambiar de modo';
  end if;
  update invoice_issuers set mode = 'real' where id = v_m;
  if (select (mode, emit_from) from invoice_issuers where id = v_m) is distinct from ('real'::text, now()) then
    raise exception 'de Manual a Real: %', (select (mode, emit_from) from invoice_issuers where id = v_m);
  end if;
  update invoice_issuers set emit_from = now() - interval '1 day' where id = v_m;
  update invoice_issuers set mode = 'manual' where id = v_m;
  if (select (mode, emit_from) from invoice_issuers where id = v_m) is distinct from ('manual'::text, now()) then
    raise exception 'de Real a Manual: %', (select (mode, emit_from) from invoice_issuers where id = v_m);
  end if;
end $$;

\echo '  el turno da la fila que se pide: en Manual, sin p_mode, una simulada; una real solo si se pide, con quién la pidió; modo_distinto si el RUC no está en ese modo'
-- Los pedidos de la tienda M: S/ 100, pagados hoy (sin pagos: el prepago web).
insert into orders (id, store_id, shopify_order_id, name, created_at, total_amount, currency, cancelled_at, total_refunded)
select pg_temp.pedido(n), '25700000-0000-0000-0000-0000000000b6', 'inv-m' || n, '#INVM' || n, now(), 100.00, 'PEN', null, 0
  from generate_series(70, 79) as n;

-- El turno del RUC de M, con los argumentos por nombre, como los pide el código.
create function pg_temp.turno_m(p_order uuid, p_modo text default null, p_quien uuid default null)
returns jsonb language sql as $$
  select invoice_claim(p_id => gen_random_uuid(), p_issuer => pg_temp.m(),
                       p_store => '25700000-0000-0000-0000-0000000000b6', p_order => p_order,
                       p_total => 100, p_paid_at => now(), p_order_name => '#SMOKE-M',
                       p_basis => '{"payments": []}', p_request => '{"invoice_type": "03", "note": "Pedido #SMOKE-M · Kapta smoke"}',
                       p_mode => p_modo, p_created_by => p_quien)
$$;

-- Los comprobantes de M como «n:modo:estado:quién», en orden.
create function pg_temp.comprobantes_m() returns text language sql stable as $$
  select coalesce(string_agg(format('%s:%s:%s:%s', right(order_id::text, 2), mode, status,
                                    case when created_by is null then '-' else 'c' end),
                             ', ' order by right(order_id::text, 2), mode, status), '')
    from order_invoices where issuer_id = pg_temp.m()
$$;

do $$
declare
  v_c constant uuid := '00000000-0000-0000-0000-00000000000c';
  r     jsonb;
  v_row order_invoices;
  v_mal text;
begin
  if (select mode from invoice_issuers where id = pg_temp.m()) <> 'manual' then
    raise exception 'el RUC de M no quedó en Manual';
  end if;

  -- Sin `p_mode` —lo que pide el barrido de hoy—, en Manual: una simulada.
  -- Nunca una boleta real que nadie pulsó.
  r := pg_temp.turno_m(pg_temp.pedido(70));
  if not r ? 'id' or r->>'mode' is distinct from 'simulacion' then raise exception 'Manual sin p_mode: %', r; end if;
  select * into v_row from order_invoices where id = (r->>'id')::uuid;
  if (v_row.mode, v_row.status, v_row.created_by) is distinct from ('simulacion', 'simulada', null::uuid) then
    raise exception 'Manual sin p_mode dejó % % %', v_row.mode, v_row.status, v_row.created_by;
  end if;
  -- Pedida como simulación: la de siempre, una por pedido.
  r := pg_temp.turno_m(pg_temp.pedido(70), 'simulacion');
  if r->>'reason' is distinct from 'ya_simulado' then raise exception 'segunda simulación en Manual: %', r; end if;

  -- Pedida como real SIN persona detrás: en Manual, nada. El barrido nunca la
  -- pide así, y si un error del código la pidiera, la base no la da.
  r := pg_temp.turno_m(pg_temp.pedido(70), 'real');
  if r->>'reason' is distinct from 'modo_distinto' then raise exception 'real en Manual sin quién: %', r; end if;

  -- Pedida como real por una persona: emitiendo, con quién la pidió, aunque el
  -- pedido ya tenga su simulación.
  r := pg_temp.turno_m(pg_temp.pedido(70), 'real', v_c);
  if not r ? 'id' or r->>'mode' is distinct from 'real' then raise exception 'real en Manual: %', r; end if;
  select * into v_row from order_invoices where id = (r->>'id')::uuid;
  if (v_row.mode, v_row.status, v_row.created_by, v_row.ruc, v_row.total, v_row.order_name)
       is distinct from ('real', 'emitiendo', v_c, '20000000009', 100.00::numeric, '#SMOKE-M') then
    raise exception 'real en Manual dejó % % % % %', v_row.mode, v_row.status, v_row.created_by, v_row.ruc, v_row.total;
  end if;
  -- Una segunda: ya tiene. Y un pedido con su boleta real ya no se simula.
  r := pg_temp.turno_m(pg_temp.pedido(70), 'real', v_c);
  if r->>'reason' is distinct from 'ya_tiene' then raise exception 'segunda real en Manual: %', r; end if;
  r := pg_temp.turno_m(pg_temp.pedido(70));
  if r->>'reason' is distinct from 'ya_tiene' then raise exception 'simulación con real vivo en Manual: %', r; end if;

  -- Lo que no es la fila de un modo: nada, ni siquiera el nombre del modo del RUC.
  foreach v_mal in array array['manual', 'apagado', '', 'REAL', 'Simulacion', ' real'] loop
    r := pg_temp.turno_m(pg_temp.pedido(71), v_mal, v_c);
    if r->>'reason' is distinct from 'modo_distinto' then raise exception 'p_mode «%»: %', v_mal, r; end if;
  end loop;
  -- Quién la pidió es una cuenta que existe: si no, ni turno ni fila.
  perform pg_temp.debe_fallar(format($q$select pg_temp.turno_m(%L, 'real', %L)$q$, pg_temp.pedido(71), gen_random_uuid()),
    '23503');

  -- Lo que se revisa depende de la fila pedida: con un error real sin reintento
  -- pedido, la real espera a una persona; la simulada del barrido no lo mira.
  r := pg_temp.turno_m(pg_temp.pedido(71), 'real', v_c);
  update order_invoices set status = 'error', http_status = 422, error = 'SimpleFact: datos inválidos'
   where id = (r->>'id')::uuid;
  r := pg_temp.turno_m(pg_temp.pedido(71), 'real', v_c);
  if r->>'reason' is distinct from 'error_previo' then raise exception 'real con error previo en Manual: %', r; end if;
  r := pg_temp.turno_m(pg_temp.pedido(71), 'simulacion');
  if not r ? 'id' or r->>'mode' is distinct from 'simulacion' then raise exception 'simulada con error real en Manual: %', r; end if;

  -- El tope cuenta las filas del modo pedido. Hoy M tiene dos simuladas (70 y
  -- 71) y una real viva (70; la de 71 es un error y no cuenta). Con tope 2, la
  -- simulada no entra y la real sí; con esa, tampoco otra real.
  update invoice_issuers set daily_limit = 2 where id = pg_temp.m();
  r := pg_temp.turno_m(pg_temp.pedido(72), 'simulacion');
  if r->>'reason' is distinct from 'tope' then raise exception 'tope de simuladas en Manual: %', r; end if;
  r := pg_temp.turno_m(pg_temp.pedido(72));
  if r->>'reason' is distinct from 'tope' then raise exception 'tope de simuladas en Manual, sin p_mode: %', r; end if;
  r := pg_temp.turno_m(pg_temp.pedido(72), 'real', v_c);
  if not r ? 'id' or r->>'mode' is distinct from 'real' then raise exception 'real con lugar en Manual: %', r; end if;
  r := pg_temp.turno_m(pg_temp.pedido(73), 'real', v_c);
  if r->>'reason' is distinct from 'tope' then raise exception 'tope de reales en Manual: %', r; end if;
  update invoice_issuers set daily_limit = 40 where id = pg_temp.m();

  -- Sin conexión, una real en Manual no sale; una simulada, sí. Un RUC en
  -- Manual sin token o con la prueba de otro RUC no puede existir: se levantan
  -- el check y el trigger en una subtransacción que se deshace.
  begin
    alter table invoice_issuers drop constraint invoice_issuers_real_ready;
    alter table invoice_issuers disable trigger invoice_issuers_touch;
    update invoice_issuers set checked_ruc = '20000000001' where id = pg_temp.m();
    r := pg_temp.turno_m(pg_temp.pedido(73), 'real', v_c);
    if r->>'reason' is distinct from 'sin_conexion' then raise exception 'Manual, prueba de otro RUC: %', r; end if;
    update invoice_issuers set checked_ruc = '20000000009', token_enc = null where id = pg_temp.m();
    r := pg_temp.turno_m(pg_temp.pedido(73), 'real', v_c);
    if r->>'reason' is distinct from 'sin_conexion' then raise exception 'Manual sin token: %', r; end if;
    r := pg_temp.turno_m(pg_temp.pedido(73), 'simulacion');
    if not r ? 'id' then raise exception 'simulada en Manual sin token: %', r; end if;
    raise exception using errcode = 'KP261';
  exception when sqlstate 'KP261' then null;
  end;
  if not exists (select 1 from pg_constraint where conname = 'invoice_issuers_real_ready')
     or (select tgenabled from pg_trigger where tgname = 'invoice_issuers_touch') <> 'O'
     or (select token_enc from invoice_issuers where id = pg_temp.m()) is null then
    raise exception 'la subtransacción de «sin conexión» no se deshizo';
  end if;

  -- En Simulación, una real pedida no: `modo_distinto`. La simulada, sí.
  update invoice_issuers set mode = 'simulacion' where id = pg_temp.m();
  r := pg_temp.turno_m(pg_temp.pedido(74), 'real', v_c);
  if r->>'reason' is distinct from 'modo_distinto' then raise exception 'real en Simulación: %', r; end if;
  r := pg_temp.turno_m(pg_temp.pedido(74), 'simulacion');
  if not r ? 'id' or r->>'mode' is distinct from 'simulacion' then raise exception 'simulada en Simulación: %', r; end if;

  -- En Real, una simulada pedida no: `modo_distinto`. La real pedida, sí; y sin
  -- `p_mode`, la real de siempre.
  update invoice_issuers set mode = 'real' where id = pg_temp.m();
  r := pg_temp.turno_m(pg_temp.pedido(75), 'simulacion');
  if r->>'reason' is distinct from 'modo_distinto' then raise exception 'simulada en Real: %', r; end if;
  r := pg_temp.turno_m(pg_temp.pedido(75), 'real', v_c);
  if not r ? 'id' or r->>'mode' is distinct from 'real' then raise exception 'real pedida en Real: %', r; end if;
  r := pg_temp.turno_m(pg_temp.pedido(76));
  if not r ? 'id' or r->>'mode' is distinct from 'real' then raise exception 'Real sin p_mode: %', r; end if;

  -- Apagado: `ruc_apagado` antes que `modo_distinto`, pida lo que pida.
  update invoice_issuers set mode = 'apagado' where id = pg_temp.m();
  foreach v_mal in array array['real', 'simulacion', 'manual'] loop
    r := pg_temp.turno_m(pg_temp.pedido(77), v_mal, v_c);
    if r->>'reason' is distinct from 'ruc_apagado' then raise exception 'apagado, p_mode %: %', v_mal, r; end if;
  end loop;
  r := pg_temp.turno_m(pg_temp.pedido(77));
  if r->>'reason' is distinct from 'ruc_apagado' then raise exception 'apagado sin p_mode: %', r; end if;
  update invoice_issuers set mode = 'manual' where id = pg_temp.m();

  -- Lo que quedó: cada fila con su modo y quién la pidió; ningún rechazo dejó
  -- fila (73 y 77 no tienen ninguna).
  if pg_temp.comprobantes_m() is distinct from
       '70:real:emitiendo:c, 70:simulacion:simulada:-, 71:real:error:c, 71:simulacion:simulada:-, '
       '72:real:emitiendo:c, 74:simulacion:simulada:-, 75:real:emitiendo:c, 76:real:emitiendo:-' then
    raise exception 'comprobantes de M: %', pg_temp.comprobantes_m();
  end if;
end $$;

\echo '  el código de hoy llama al turno con sus nueve argumentos por nombre, y sigue andando; solo el servidor pide el turno'
-- Lo mismo que manda `admin.rpc("invoice_claim", { p_id, …, p_request })` en
-- producción, con el rol del servidor.
set local role service_role;
do $$
declare
  v_m constant uuid := (select id from invoice_issuers
                         where org_id = '25700000-0000-0000-0000-0000000000a4' and legal_name = 'MANUAL S.A.C.');
  r jsonb;
begin
  -- En Manual: una simulada.
  r := invoice_claim(p_id => gen_random_uuid(), p_issuer => v_m, p_store => '25700000-0000-0000-0000-0000000000b6',
                     p_order => '25700000-0000-0000-0000-000000000078', p_total => 100, p_paid_at => now(),
                     p_order_name => '#INVM78', p_basis => '{"payments": []}'::jsonb,
                     p_request => '{"invoice_type": "03"}'::jsonb);
  if not r ? 'id' or r->>'mode' is distinct from 'simulacion' then raise exception 'nueve por nombre, Manual: %', r; end if;
  -- Y los once por nombre: la boleta que pidió una persona.
  r := invoice_claim(p_id => gen_random_uuid(), p_issuer => v_m, p_store => '25700000-0000-0000-0000-0000000000b6',
                     p_order => '25700000-0000-0000-0000-000000000078', p_total => 100, p_paid_at => now(),
                     p_order_name => '#INVM78', p_basis => '{"payments": []}'::jsonb,
                     p_request => '{"invoice_type": "03"}'::jsonb,
                     p_mode => 'real', p_created_by => '00000000-0000-0000-0000-00000000000c');
  if not r ? 'id' or r->>'mode' is distinct from 'real' then raise exception 'once por nombre, Manual: %', r; end if;
  -- En Real: la real de siempre, con los nueve.
  update invoice_issuers set mode = 'real' where id = v_m;
  r := invoice_claim(p_id => gen_random_uuid(), p_issuer => v_m, p_store => '25700000-0000-0000-0000-0000000000b6',
                     p_order => '25700000-0000-0000-0000-000000000079', p_total => 100, p_paid_at => now(),
                     p_order_name => '#INVM79', p_basis => '{"payments": []}'::jsonb,
                     p_request => '{"invoice_type": "03"}'::jsonb);
  if not r ? 'id' or r->>'mode' is distinct from 'real' then raise exception 'nueve por nombre, Real: %', r; end if;
  update invoice_issuers set mode = 'manual' where id = v_m;
end $$;
reset role;

-- El navegador, ni con los nueve ni con los once.
do $$
declare
  c_claim11 constant text := 'invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)';
  v_rol text;
begin
  foreach v_rol in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_rol, c_claim11, 'execute') then
      raise exception '% puede pedir el turno de once', v_rol;
    end if;
  end loop;
  -- Tampoco PUBLIC: una función nace ejecutable por todos.
  if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
              where p.oid = to_regprocedure(c_claim11) and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'PUBLIC puede pedir el turno de once';
  end if;
  if not has_function_privilege('service_role', c_claim11, 'execute') then
    raise exception 'service_role no puede pedir el turno de once';
  end if;
end $$;
set local request.test_uid = '00000000-0000-0000-0000-00000000000c';
set local role authenticated;
do $$
begin
  begin
    perform invoice_claim(p_id => gen_random_uuid(), p_issuer => gen_random_uuid(),
                          p_store => '25700000-0000-0000-0000-0000000000b6', p_order => '25700000-0000-0000-0000-000000000077',
                          p_total => 100, p_paid_at => now(), p_order_name => '#X', p_basis => '{}', p_request => '{}');
    raise exception 'authenticated pidió el turno con los nueve por nombre';
  exception when insufficient_privilege then null;
  end;
  begin
    perform invoice_claim(p_id => gen_random_uuid(), p_issuer => gen_random_uuid(),
                          p_store => '25700000-0000-0000-0000-0000000000b6', p_order => '25700000-0000-0000-0000-000000000077',
                          p_total => 100, p_paid_at => now(), p_order_name => '#X', p_basis => '{}', p_request => '{}',
                          p_mode => 'real', p_created_by => '00000000-0000-0000-0000-00000000000c');
    raise exception 'authenticated pidió una boleta real';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  perform invoice_claim(p_id => gen_random_uuid(), p_issuer => gen_random_uuid(),
                        p_store => '25700000-0000-0000-0000-0000000000b6', p_order => '25700000-0000-0000-0000-000000000077',
                        p_total => 100, p_paid_at => now(), p_order_name => '#X', p_basis => '{}', p_request => '{}',
                        p_mode => 'real');
  raise exception 'anon pidió una boleta real';
exception when insufficient_privilege then null;
end $$;
reset role;

\echo '  correr la 0261 otra vez, con un RUC en Manual y sus boletas, no cambia nada'
do $$ begin perform pg_temp.foto_0261('manual'); end $$;
\ir ../../db/migrations/0261_invoices_manual.sql
do $$ begin perform pg_temp.foto_0261('0261 otra vez'); end $$;
do $$
begin
  if (select mode from invoice_issuers where id = pg_temp.m()) <> 'manual'
     or not exists (select 1 from order_invoices where issuer_id = pg_temp.m() and mode = 'real' and created_by is not null) then
    raise exception 'no hay un RUC en Manual con boletas que cuidar';
  end if;
  -- Las mismas cosas en las dos fotos, todas con valor.
  if (select count(*) from foto_0261 where paso = 'manual' and valor is not null)
       <> (select count(*) from foto_0261 where paso = '0261') then
    raise exception 'foto incompleta tras Manual';
  end if;
  if exists (
    select 1
      from (select cosa, valor from foto_0261 where paso = 'manual') a
      full join (select cosa, valor from foto_0261 where paso = '0261 otra vez') b using (cosa)
     where a.valor is distinct from b.valor
  ) then
    raise exception 'correr la 0261 otra vez cambió: %', (
      select string_agg(cosa, ', ')
        from (select cosa, valor from foto_0261 where paso = 'manual') a
        full join (select cosa, valor from foto_0261 where paso = '0261 otra vez') b using (cosa)
       where a.valor is distinct from b.valor);
  end if;
end $$;

rollback;
\echo '  invoices: semilla, emisor, cuenta → RUC, turno, índice, estados, cuentas borradas, pedidos por revisar, permisos, la 0260 sobre la 0257 y la 0261 con el modo «Manual» OK'
