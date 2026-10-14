-- ============================================================================
-- 0257_invoices.sql — comprobantes electrónicos por RUC con SimpleFact (MOM §35,
-- 14-10-2026).
--
-- QUÉ PASABA. Grupo GF tiene cuatro razones sociales, cada una con su RUC y su
-- propia cuenta de SimpleFact, y la boleta de una venta la emite la empresa que
-- recibió el dinero. Kapta no sabía a qué empresa pertenece cada cuenta de
-- cobro, ni dejaba rastro de ningún comprobante.
--
-- QUÉ CAMBIA.
--   · `invoice_issuers`: las empresas emisoras de la organización (RUC, razón
--     social, subdominio de SimpleFact, token cifrado, modo, «Emitir desde» y
--     tope diario). Pasar a «real» exige token, fecha de inicio y una prueba de
--     conexión que leyó el mismo RUC.
--   · `store_collection_accounts.invoice_issuer_id`: el RUC de cada cuenta de
--     cobro. Una cuenta sin RUC no emite.
--   · `order_invoices`: una fila por intento, simulado o real. Un índice único
--     deja un solo comprobante real vivo por pedido, y un trigger impide editar
--     o borrar lo que ya pasó.
--   · `invoice_order_checks`: la última revisión del barrido por pedido.
--   · `invoice_claim`: reserva el turno ANTES de llamar a SimpleFact. SimpleFact
--     no tiene llave de idempotencia: un envío sin respuesta se concilia, nunca
--     se repite (el mismo criterio que `swayp_emission_claim`, 0209). Vuelve a
--     calcular con los pagos de la base cuándo quedó pagado el pedido.
--   · `invoice_candidates`: los pedidos que el barrido revisa en cada pasada,
--     sin los que ya tienen su comprobante ni los que esperan que una persona
--     pida reintentar un error.
--   · Semilla: GRUPO GF S.A.C. (RUC 20556792829, subdominio `grupogf`) con el
--     Yape ···309 y la pasarela Flow «Aurela Kenku», como lo dijo el owner.
--
-- A QUIÉN NO. Nace APAGADO y sin token: nada se emite ni se simula hasta que el
-- owner ponga el token en Ajustes y encienda el RUC. Las cuentas personales de
-- los dueños quedan sin RUC. Todo lo escribe y lo lee solo el servidor.
--
-- Se aplica a mano ANTES del código (DEPLOY.md). Es idempotente.
-- ============================================================================

-- ── 1. Empresas emisoras ─────────────────────────────────────────────────────
create table if not exists invoice_issuers (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id) on delete cascade,
  ruc                  text not null
                         check (ruc ~ '^(10|15|16|17|20)[0-9]{9}$'),
  legal_name           text not null
                         check (length(btrim(legal_name)) between 1 and 200),
  -- Solo el subdominio: el token nunca viaja fuera de *.simplefact.pe.
  simplefact_subdomain text not null
                         check (simplefact_subdomain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  token_enc            text,
  mode                 text not null default 'apagado'
                         check (mode in ('apagado', 'simulacion', 'real')),
  emit_from            timestamptz,
  daily_limit          integer not null default 40
                         check (daily_limit between 1 and 300),
  -- La última prueba de conexión: qué RUC dicen los archivos de esa cuenta.
  checked_at           timestamptz,
  checked_ruc          text,
  check_error          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, ruc),
  -- `checked_ruc is not null` va escrito: sin él, un RUC SIN prueba daba
  -- `null = ruc` → NULL, y un CHECK con NULL pasa. Se podía poner en real sin
  -- haber probado la conexión nunca.
  constraint invoice_issuers_real_ready check (
    mode <> 'real'
    or (token_enc is not null and emit_from is not null and checked_ruc is not null and checked_ruc = ruc)
  )
);

comment on table invoice_issuers is
  'Empresas emisoras (RUC) de la organización, cada una con su cuenta de SimpleFact (MOM §35.2). Solo la lee el servidor.';
comment on column invoice_issuers.token_enc is
  'Token de la API de SimpleFact cifrado con lib/crypto.ts (AES-256-GCM). Nunca sale al navegador.';
comment on column invoice_issuers.mode is
  'apagado = no hace nada; simulacion = arma la boleta y la guarda sin enviarla; real = emite (MOM §35.8).';
comment on column invoice_issuers.emit_from is
  'Solo se emiten pedidos que quedaron pagados desde esta fecha: ningún RUC emite hacia atrás. Al encender o cambiar de modo, si quedó atrás, se mueve sola a ese momento (MOM §35.4).';
comment on column invoice_issuers.checked_ruc is
  'RUC leído en los archivos de la cuenta por «Probar conexión». Pasar a real exige que sea el RUC declarado.';

-- Cambiar el token, el subdominio o el RUC invalida la prueba de conexión, y un
-- RUC en real baja a simulación: un token nuevo se prueba antes de emitir.
--
-- Lo mismo si la prueba se repite con el RUC ya en real y no confirma el RUC
-- (leyó otro, o no pudo leer): sin esto, guardar el resultado de esa prueba
-- chocaba con `invoice_issuers_real_ready` y Ajustes no podía registrarlo, con
-- el RUC emitiendo sobre la prueba vieja. Real exige, mientras dure, que la
-- última prueba sea la del RUC declarado.
--
-- «Emitir desde» no queda atrás al encender ni al cambiar de modo (MOM §35.4):
-- la fecha que sirvió para la simulación de ayer no habilita, al pasar a real,
-- las boletas de todo lo que se pagó desde entonces.
create or replace function invoice_issuers_touch() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and (
    new.token_enc is distinct from old.token_enc
    or new.simplefact_subdomain is distinct from old.simplefact_subdomain
    or new.ruc is distinct from old.ruc
  ) then
    new.checked_at := null;
    new.checked_ruc := null;
    -- El motivo de la prueba anterior era de otro token: sin borrarlo, Ajustes
    -- lo mostraría como si Kapta hubiera apagado el RUC (solo el barrido deja
    -- una fila sin fecha de prueba y con motivo, MOM §35.4).
    new.check_error := null;
    if new.mode = 'real' then
      new.mode := 'simulacion';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.mode = 'real' and new.mode = 'real'
     and new.checked_ruc is distinct from new.ruc then
    new.mode := 'simulacion';
  end if;
  if new.mode <> 'apagado'
     and (tg_op = 'INSERT' or new.mode is distinct from old.mode)
     and new.emit_from < now() then
    new.emit_from := now();
  end if;
  return new;
end;
$$;
revoke all on function invoice_issuers_touch() from public, anon, authenticated;
drop trigger if exists invoice_issuers_touch on invoice_issuers;
create trigger invoice_issuers_touch before insert or update on invoice_issuers
  for each row execute function invoice_issuers_touch();

-- ── 2. Cuenta de cobro → RUC ─────────────────────────────────────────────────
alter table store_collection_accounts
  add column if not exists invoice_issuer_id uuid references invoice_issuers(id) on delete set null;

comment on column store_collection_accounts.invoice_issuer_id is
  'Empresa emisora del dinero que entra a esta cuenta (MOM §35.2). NULL = «Sin comprobante»: no emite.';

create or replace function store_collection_accounts_issuer_org() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if new.invoice_issuer_id is not null and not exists (
    select 1
    from invoice_issuers i
    join stores s on s.org_id = i.org_id
    where i.id = new.invoice_issuer_id and s.id = new.store_id
  ) then
    raise exception 'El RUC no es de la organización de la tienda';
  end if;
  return new;
end;
$$;
revoke all on function store_collection_accounts_issuer_org() from public, anon, authenticated;
drop trigger if exists store_collection_accounts_issuer_org on store_collection_accounts;
create trigger store_collection_accounts_issuer_org
  before insert or update of invoice_issuer_id, store_id on store_collection_accounts
  for each row execute function store_collection_accounts_issuer_org();

-- ── 3. Comprobantes ──────────────────────────────────────────────────────────
create table if not exists order_invoices (
  id                 uuid primary key,
  org_id             uuid not null references organizations(id),
  store_id           uuid not null references stores(id),
  order_id           uuid not null references orders(id),
  issuer_id          uuid not null references invoice_issuers(id),
  -- Copiado: el comprobante es de ese RUC aunque la fila del emisor cambie.
  ruc                text not null,
  mode               text not null check (mode in ('simulacion', 'real')),
  status             text not null
                       check (status in ('simulada', 'emitiendo', 'emitida', 'en_duda', 'error', 'externa')),
  invoice_type       text not null default '03' check (invoice_type in ('01', '03')),
  order_name         text,
  total              numeric(12, 2) not null check (total > 0),
  -- Cuándo quedó pagado el pedido: el último pago validado, o la fecha del
  -- pedido si fue prepago web.
  paid_at            timestamptz,
  -- En qué se basó: los pagos, sus cuentas y la señal de cada una.
  basis              jsonb not null default '{}'::jsonb,
  request            jsonb,
  response           jsonb,
  http_status        integer,
  simplefact_id      bigint,
  serie              text,
  correlative        text,
  pdf_url            text,
  xml_url            text,
  sunat_status       text,
  -- SimpleFact contestó con archivos de OTRO RUC. Se marca y el RUC se apaga.
  ruc_mismatch       boolean not null default false,
  error              text,
  note               text,
  created_by         uuid references auth.users(id) on delete set null,
  retry_requested_by uuid references auth.users(id) on delete set null,
  retry_requested_at timestamptz,
  resolved_by        uuid references auth.users(id) on delete set null,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint order_invoices_mode_status check ((mode = 'simulacion') = (status = 'simulada'))
);

comment on table order_invoices is
  'Comprobantes por pedido, simulados o reales (MOM §35.6). Una fila por intento; lo emitido no se edita ni se borra.';
comment on column order_invoices.status is
  'simulada | emitiendo (turno reservado, llamando) | emitida | en_duda (puede existir: se concilia, nunca se repite) | error (SimpleFact dijo que no) | externa (emitida a mano fuera de Kapta).';

-- UNO POR PEDIDO, EN LA BASE: un solo comprobante real vivo, y una sola
-- simulación. Un `error` no cuenta: no hay boleta.
create unique index if not exists order_invoices_one_real
  on order_invoices (order_id)
  where mode = 'real' and status in ('emitiendo', 'emitida', 'en_duda', 'externa');
create unique index if not exists order_invoices_one_simulation
  on order_invoices (order_id)
  where mode = 'simulacion';
create index if not exists order_invoices_issuer_created
  on order_invoices (issuer_id, created_at desc);
create index if not exists order_invoices_store_created
  on order_invoices (store_id, created_at desc);
create index if not exists order_invoices_order
  on order_invoices (order_id, created_at desc);
create index if not exists order_invoices_open
  on order_invoices (issuer_id, created_at)
  where status in ('emitiendo', 'en_duda');

-- LO QUE PASÓ NO SE REESCRIBE. Los estados solo avanzan, lo enviado no cambia y
-- nada se borra (§2, principio 6).
create or replace function order_invoices_guard() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Un comprobante no se borra';
  end if;
  -- Borrar una cuenta de auth.users deja en NULL quién registró, pidió el
  -- reintento o resolvió (`on delete set null`), y Postgres lo hace con un
  -- UPDATE que pasa por este candado: sin esto, no se podía borrar a nadie que
  -- hubiera tocado un comprobante. Pasa solo un UPDATE cuyo único cambio es
  -- poner en NULL alguna de esas tres columnas: todo lo demás de la fila, hasta
  -- `updated_at`, queda igual. Se pierde quién; el hecho (`retry_requested_at`,
  -- `resolved_at`) se queda. Un UPDATE que no cambia nada sigue por el camino
  -- de siempre (y en una fila cerrada, falla).
  --
  -- Y pasa SOLO si viene de esa cascada. La acción de la llave foránea es un
  -- trigger del sistema que hace el UPDATE por dentro, así que este candado
  -- corre un nivel más hondo (`pg_trigger_depth()` = 2; un UPDATE directo, 1).
  -- Sin esa condición, el servidor (o cualquiera con service_role) podía borrar
  -- a mano quién emitió, pidió el reintento o resolvió, sin borrar la cuenta.
  if pg_trigger_depth() > 1
     and (to_jsonb(new) - array['created_by', 'retry_requested_by', 'resolved_by'])
       = (to_jsonb(old) - array['created_by', 'retry_requested_by', 'resolved_by'])
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.retry_requested_by is null or new.retry_requested_by = old.retry_requested_by)
     and (new.resolved_by is null or new.resolved_by = old.resolved_by)
     and (new.created_by is distinct from old.created_by
          or new.retry_requested_by is distinct from old.retry_requested_by
          or new.resolved_by is distinct from old.resolved_by) then
    return new;
  end if;
  if new.id <> old.id or new.org_id <> old.org_id or new.store_id <> old.store_id
     or new.order_id <> old.order_id or new.issuer_id <> old.issuer_id or new.ruc <> old.ruc
     or new.mode <> old.mode or new.invoice_type <> old.invoice_type or new.total <> old.total
     or new.paid_at is distinct from old.paid_at or new.basis <> old.basis
     or new.request is distinct from old.request or new.created_at <> old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'Lo enviado de un comprobante no cambia';
  end if;
  -- Cerrada no cambia: lo simulado, lo emitido y lo registrado como externo.
  if old.status in ('simulada', 'emitida', 'externa') then
    raise exception 'Un comprobante % no cambia', old.status;
  end if;
  if not (
    new.status = old.status
    or (old.status = 'emitiendo' and new.status in ('emitida', 'error', 'en_duda'))
    or (old.status = 'en_duda' and new.status in ('emitida', 'error'))
  ) then
    raise exception 'Transición de comprobante no permitida: % → %', old.status, new.status;
  end if;
  -- Un error solo admite que una persona pida su reintento, una vez. El
  -- reintento es una fila nueva; esta se queda como historia.
  if old.status = 'error' and (
    old.retry_requested_at is not null
    or new.retry_requested_at is null
    or row(new.response, new.http_status, new.simplefact_id, new.serie, new.correlative,
           new.pdf_url, new.xml_url, new.sunat_status, new.ruc_mismatch, new.error, new.note,
           new.resolved_by, new.resolved_at)
       is distinct from
       row(old.response, old.http_status, old.simplefact_id, old.serie, old.correlative,
           old.pdf_url, old.xml_url, old.sunat_status, old.ruc_mismatch, old.error, old.note,
           old.resolved_by, old.resolved_at)
  ) then
    raise exception 'Un error solo admite pedir su reintento, una vez';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function order_invoices_guard() from public, anon, authenticated;
drop trigger if exists order_invoices_guard on order_invoices;
create trigger order_invoices_guard before update or delete on order_invoices
  for each row execute function order_invoices_guard();

-- ── 4. La última revisión del barrido ────────────────────────────────────────
create table if not exists invoice_order_checks (
  order_id   uuid not null references orders(id) on delete cascade,
  mode       text not null check (mode in ('simulacion', 'real')),
  store_id   uuid not null references stores(id) on delete cascade,
  issuer_id  uuid references invoice_issuers(id) on delete set null,
  reason     text not null,
  detail     text,
  checked_at timestamptz not null default now(),
  primary key (order_id, mode)
);

comment on table invoice_order_checks is
  'Por qué el barrido no emitió un pedido, la última vez que lo miró (MOM §35.6). Es una caché de la revisión, no un hecho.';

create index if not exists invoice_order_checks_store
  on invoice_order_checks (store_id, checked_at desc);

-- ── 5. Solo el servidor ──────────────────────────────────────────────────────
alter table invoice_issuers enable row level security;
alter table order_invoices enable row level security;
alter table invoice_order_checks enable row level security;
-- SIN policies: ni el token cifrado ni los comprobantes se leen desde el
-- navegador. Las pantallas pasan por acciones de servidor con permiso.
revoke all on invoice_issuers, order_invoices, invoice_order_checks from anon, authenticated;
grant all privileges on invoice_issuers, order_invoices, invoice_order_checks to service_role;

-- ── 6. El turno ──────────────────────────────────────────────────────────────
-- Revisa DENTRO de la base, con un candado por RUC, todo lo que no puede fallar:
-- modo, conexión, monto, pagos validados, fecha de inicio, uno por pedido y el
-- tope del día. Deja la fila en `emitiendo` (real) o `simulada`. Sin desbloqueo
-- por tiempo: una fila `emitiendo` que se quedó sin respuesta se concilia, no se
-- repite.
create or replace function invoice_claim(
  p_id uuid,
  p_issuer uuid,
  p_store uuid,
  p_order uuid,
  p_total numeric,
  p_paid_at timestamptz,
  p_order_name text,
  p_basis jsonb,
  p_request jsonb
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_org   uuid;
  v_order orders;
  v_iss   invoice_issuers;
  v_count integer;
  v_live  integer;
  v_paid  timestamptz;
begin
  select org_id into v_org from stores where id = p_store and status = 'active';
  if v_org is null then
    return jsonb_build_object('reason', 'tienda');
  end if;
  select * into v_order from orders where id = p_order and store_id = p_store;
  if v_order.id is null then
    return jsonb_build_object('reason', 'pedido');
  end if;
  if v_order.cancelled_at is not null then
    return jsonb_build_object('reason', 'anulado');
  end if;
  if coalesce(v_order.total_refunded, 0) <> 0 then
    return jsonb_build_object('reason', 'reembolsado');
  end if;
  -- La boleta va en soles: un total en otra moneda se emitiría como si lo fuera.
  if upper(coalesce(v_order.currency, '')) <> 'PEN' then
    return jsonb_build_object('reason', 'moneda');
  end if;

  -- Cuándo quedó pagado, con los pagos de la base y no con lo que manda quien
  -- pide el turno (MOM §35.3, condiciones 2 y 8). `p_paid_at` lo calcula el
  -- código: si una regla o una lectura se equivocara, la boleta de algo pagado
  -- antes de «Emitir desde» iría igual a SUNAT, y una boleta enviada no se
  -- borra. Es la misma cuenta que `invoiceEligibility`: todos los pagos vivos
  -- (no rechazados) validados, y el `registered_at` del último, que no cambia
  -- si el pago se observa y se vuelve a validar; sin pagos vivos, la fecha del
  -- pedido (el prepago web).
  if exists (
    select 1 from order_payments
    where order_id = p_order
      and validation_status is distinct from 'rechazado'
      and validation_status is distinct from 'validado'
  ) then
    return jsonb_build_object('reason', 'pagos_en_revision');
  end if;
  select count(*), max(registered_at) into v_live, v_paid
  from order_payments
  where order_id = p_order and validation_status = 'validado';
  if v_live = 0 then
    v_paid := coalesce(v_order.processed_at, v_order.created_at);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_issuer::text, 257));
  select * into v_iss from invoice_issuers where id = p_issuer for update;
  if v_iss.id is null or v_iss.org_id <> v_org then
    return jsonb_build_object('reason', 'ruc_ajeno');
  end if;
  if v_iss.mode = 'apagado' then
    return jsonb_build_object('reason', 'ruc_apagado');
  end if;
  if p_total is null or p_total <= 0 then
    return jsonb_build_object('reason', 'monto_cero');
  end if;
  if p_total > 700 then
    return jsonb_build_object('reason', 'monto_mayor_700');
  end if;
  if v_order.total_amount is null or abs(v_order.total_amount - p_total) >= 0.005 then
    return jsonb_build_object('reason', 'total_distinto');
  end if;
  -- Las dos fechas: la que manda el código y la que dice la base. Sin una de
  -- ellas no se sabe cuándo quedó pagado, y no se emite.
  if v_iss.emit_from is null
     or p_paid_at is null or p_paid_at < v_iss.emit_from
     or v_paid is null or v_paid < v_iss.emit_from then
    return jsonb_build_object('reason', 'antes_de_inicio');
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    return jsonb_build_object('reason', 'sin_boleta');
  end if;

  if exists (
    select 1 from order_invoices
    where order_id = p_order and mode = 'real'
      and status in ('emitiendo', 'emitida', 'en_duda', 'externa')
  ) then
    return jsonb_build_object('reason', 'ya_tiene');
  end if;

  if v_iss.mode = 'simulacion' then
    if exists (select 1 from order_invoices where order_id = p_order and mode = 'simulacion') then
      return jsonb_build_object('reason', 'ya_simulado');
    end if;
  else
    if v_iss.token_enc is null or v_iss.checked_ruc is distinct from v_iss.ruc then
      return jsonb_build_object('reason', 'sin_conexion');
    end if;
    if exists (
      select 1 from order_invoices
      where order_id = p_order and mode = 'real' and status = 'error' and retry_requested_at is null
    ) then
      return jsonb_build_object('reason', 'error_previo');
    end if;
  end if;

  select count(*) into v_count
  from order_invoices
  where issuer_id = p_issuer
    and mode = v_iss.mode
    and status in ('simulada', 'emitiendo', 'emitida', 'en_duda')
    and created_at >= (date_trunc('day', now() at time zone 'America/Lima') at time zone 'America/Lima');
  if v_count >= v_iss.daily_limit then
    return jsonb_build_object('reason', 'tope');
  end if;

  insert into order_invoices (
    id, org_id, store_id, order_id, issuer_id, ruc, mode, status,
    order_name, total, paid_at, basis, request
  ) values (
    p_id, v_org, p_store, p_order, p_issuer, v_iss.ruc, v_iss.mode,
    case when v_iss.mode = 'real' then 'emitiendo' else 'simulada' end,
    p_order_name, p_total, greatest(p_paid_at, v_paid), coalesce(p_basis, '{}'::jsonb), p_request
  );
  return jsonb_build_object('id', p_id, 'mode', v_iss.mode);
end;
$$;
revoke all on function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)
  to service_role;

-- ── 7. Los pedidos por revisar ───────────────────────────────────────────────
-- Qué pedidos mira el barrido en cada pasada, por organización y modo (MOM
-- §35.4). Antes eran los 300 más nuevos del Master y los 300 pagos validados
-- más nuevos: con ~26 pedidos pagados al día cubrían ~11 días, y los pedidos ya
-- resueltos ocupaban los lugares, así que uno que quedaba elegible tarde podía
-- no entrar nunca. Aquí lo resuelto no entra y el límite es para lo pendiente.
--
-- Entra un pedido de una tienda ACTIVA de la organización (o solo de
-- `p_store`) que:
--   · está pagado según el Master: pagado completo, o prepago web confirmado;
--   · es de los últimos 60 días: Shopify no deja leer pedidos más viejos sin
--     `read_all_orders`, y el barrido relee cada pedido antes de emitir;
--   · no tiene comprobante real vivo y, en simulación, tampoco su simulación;
--   · en real, no tiene un `error` real sin reintento pedido: el turno lo
--     rechaza (`error_previo`) y solo ocupaba un lugar. Vuelve a entrar cuando
--     una persona pide reintentar. En simulación el turno no lo mira, y entra;
--   · no lo bloqueó Shopify en este modo hace menos de 6 horas. `p_blocked` son
--     los motivos de Shopify, y los manda el barrido (SHOPIFY_LEVEL_REASONS en
--     lib/invoicing/server.ts): la lista vive en un solo lugar;
--   · quedó pagado desde `p_since` (el «Emitir desde» más antiguo de los RUC en
--     ese modo): un pago validado registrado desde entonces, o el prepago web
--     de un pedido creado desde entonces. Sin `p_since`, nada.
-- Del más nuevo al más viejo, a lo más `p_limit`. Solo elige qué mirar: lo que
-- decide es `invoiceEligibility` y, al final, `invoice_claim`.
create or replace function invoice_candidates(
  p_org uuid,
  p_mode text,
  p_since timestamptz,
  p_limit integer,
  p_blocked text[],
  p_store uuid default null
) returns table (order_id uuid)
language sql stable security invoker set search_path = public as $$
  select m.order_id
  from order_master m
  join stores s on s.id = m.store_id
  where s.org_id = p_org
    and s.status = 'active'
    and (p_store is null or m.store_id = p_store)
    and p_mode in ('simulacion', 'real')
    and (m.payment_state = 'pago_completo'
         or (m.payment_gateway = 'checkout' and m.financial_status = 'paid'))
    and m.order_created_at >= now() - interval '60 days'
    and not exists (
      select 1 from order_invoices i
      where i.order_id = m.order_id and i.mode = 'real'
        and i.status in ('emitiendo', 'emitida', 'en_duda', 'externa')
    )
    and (p_mode = 'real' or not exists (
      select 1 from order_invoices i where i.order_id = m.order_id and i.mode = 'simulacion'
    ))
    and (p_mode <> 'real' or not exists (
      select 1 from order_invoices i
      where i.order_id = m.order_id and i.mode = 'real'
        and i.status = 'error' and i.retry_requested_at is null
    ))
    and not exists (
      select 1 from invoice_order_checks c
      where c.order_id = m.order_id and c.mode = p_mode
        and c.reason = any (coalesce(p_blocked, '{}'::text[]))
        and c.checked_at > now() - interval '6 hours'
    )
    and (
      exists (
        select 1 from order_payments p
        where p.order_id = m.order_id and p.validation_status = 'validado' and p.registered_at >= p_since
      )
      or (m.payment_gateway = 'checkout' and m.financial_status = 'paid' and m.order_created_at >= p_since)
    )
  order by m.order_created_at desc, m.order_id
  limit greatest(coalesce(p_limit, 0), 0)
$$;
revoke all on function invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)
  from public, anon, authenticated;
grant execute on function invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)
  to service_role;

-- ── 8. Semilla: GRUPO GF S.A.C. ──────────────────────────────────────────────
-- Decisión del owner (14-10-2026): el Yape ···309, el BCP ···0-12 (mismo
-- titular, Kapta no los distingue: MOM §35.2) y la cuenta de Flow son de GRUPO
-- GF S.A.C., RUC 20556792829. Solo en las organizaciones que cobran en esa
-- cuenta, y solo la primera vez: si el owner cambia una asignación, volver a
-- correr esta migración no la pisa.
do $$
declare
  v_org    record;
  v_issuer uuid;
begin
  for v_org in
    select distinct s.org_id
    from stores s
    join store_collection_accounts a on a.store_id = s.id
    where a.phone_last_digits = '309' and lower(a.label) = lower('Grupo GF S.A.C.')
  loop
    if not exists (
      select 1 from invoice_issuers where org_id = v_org.org_id and ruc = '20556792829'
    ) then
      insert into invoice_issuers (org_id, ruc, legal_name, simplefact_subdomain)
      values (v_org.org_id, '20556792829', 'GRUPO GF S.A.C.', 'grupogf')
      returning id into v_issuer;

      update store_collection_accounts a
      set invoice_issuer_id = v_issuer
      from stores s
      where s.id = a.store_id
        and s.org_id = v_org.org_id
        and a.invoice_issuer_id is null
        and (
          (a.phone_last_digits = '309' and lower(a.label) = lower('Grupo GF S.A.C.'))
          or (a.phone_last_digits is null and lower(a.label) = lower('Aurela Kenku'))
        );
    end if;
  end loop;
end $$;
