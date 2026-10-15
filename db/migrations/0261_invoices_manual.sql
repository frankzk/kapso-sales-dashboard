-- ============================================================================
-- 0261_invoices_manual.sql — comprobantes por RUC: el modo «Manual», un paso
-- entre la simulación y lo automático (MOM §35, 15-10-2026).
--
-- QUÉ PASABA. De Simulación a Real había un solo salto: desde ese momento el
-- barrido emitía solo, hasta el tope del día, y la primera boleta real que el
-- owner podía revisar en SimpleFact ya llegaba con otras detrás. Una boleta
-- enviada a SUNAT no se borra.
--
-- QUÉ CAMBIA. Decisión del owner (15-10-2026): un paso manual antes de lo
-- automático. En «Manual» el barrido solo simula, y una persona con
-- `invoices.manage` pulsa «Emitir esta boleta» pedido por pedido, con los
-- mismos candados. Las primeras boletas reales salen una a una y se revisan en
-- SimpleFact antes de pasar a Real.
--   · `invoice_issuers.mode` admite 'manual' (`invoice_issuers_mode_check`,
--     ahora con nombre).
--   · `invoice_issuers_real_ready`: Manual exige lo mismo que Real —token,
--     «Emitir desde» y una prueba de conexión que leyó el RUC declarado—,
--     porque también emite boletas reales.
--   · `invoice_issuers_touch`: un token, un subdominio o un RUC nuevo, o una
--     prueba repetida que no confirma el RUC, baja Manual a Simulación, como
--     baja Real. «Emitir desde» se mueve al cambiar de modo como hasta hoy:
--     Manual cuenta como encendido.
--   · `invoice_claim` recibe dos argumentos nuevos, con valor por defecto:
--     `p_mode`, la fila que pide quien llama ('simulacion', 'real' o NULL), y
--     `p_created_by`, quién pulsó «Emitir». Sin `p_mode`, lo de siempre: un RUC
--     en Real da una fila real, y uno en Simulación o en Manual, una simulada.
--     'real' solo si el RUC está en Real o en Manual; 'simulacion', solo si
--     está en Simulación o en Manual; si no, `modo_distinto`. El tope del día
--     cuenta las filas del modo pedido. La firma de nueve argumentos se borra:
--     con las dos, una llamada por nombre con los nueve de siempre no sabría a
--     cuál ir.
--
-- A QUIÉN NO. No toca datos: el RUC de producción sigue en Simulación (15-10-
-- 2026: un RUC en simulación y ningún comprobante) y nada pasa a Manual solo.
-- El código que hoy está en producción pide el turno con los nueve argumentos
-- por nombre: los dos nuevos quedan en NULL y el turno hace lo mismo que
-- antes. Ese código no conoce «Manual» y trata un RUC en Manual como apagado;
-- y si pidiera el turno de uno, sin `p_mode` recibiría una simulada: una
-- boleta real en Manual solo sale si quien llama la pide. `invoice_candidates`
-- no cambia (el barrido la llama con 'simulacion' para un RUC en Manual). El
-- turno sigue solo para `service_role`. Va después de la 0260: sus funciones
-- son la base de las de aquí. En el SQL Editor corre en una sola transacción:
-- quien pida el turno mientras tanto ve la firma de antes o la de ahora, nunca
-- ninguna ni las dos.
--
-- Se aplica a mano ANTES del código (DEPLOY.md). Es idempotente.
-- ============================================================================

-- ── 1. Manual exige lo mismo que Real ────────────────────────────────────────
-- Va antes de admitir el modo: en ningún momento puede existir un RUC en Manual
-- sin token, sin «Emitir desde» o sin la prueba de su RUC.
--
-- `checked_ruc is not null` va escrito por lo mismo que en la 0257: sin él, un
-- RUC sin prueba daba `null = ruc` → NULL, y un CHECK con NULL pasa.
--
-- Se rehace solo si todavía es la de la 0257 (no nombra 'manual'): correr esta
-- migración otra vez no la toca.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoice_issuers'::regclass
       and conname = 'invoice_issuers_real_ready'
       and pg_get_constraintdef(oid) like '%''manual''%'
  ) then
    alter table invoice_issuers drop constraint if exists invoice_issuers_real_ready;
    alter table invoice_issuers add constraint invoice_issuers_real_ready check (
      mode not in ('real', 'manual')
      or (token_enc is not null and emit_from is not null and checked_ruc is not null and checked_ruc = ruc)
    );
  end if;
end $$;

-- ── 2. El modo «Manual» ──────────────────────────────────────────────────────
-- La 0257 escribió el CHECK del modo dentro de la columna, sin nombre, y
-- Postgres le puso uno. No se adivina: se borra todo CHECK de la columna `mode`
-- sola que todavía no admite 'manual', y se crea con nombre. Es el mismo que
-- Postgres le había puesto, y Ajustes lo reconoce («Ese modo no existe.»).
-- Correr esta migración otra vez no lo toca.
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.invoice_issuers'::regclass
       and c.contype = 'c'
       and c.conkey = array[(select a.attnum from pg_attribute a
                              where a.attrelid = 'public.invoice_issuers'::regclass and a.attname = 'mode')]
       and pg_get_constraintdef(c.oid) not like '%''manual''%'
  loop
    execute format('alter table invoice_issuers drop constraint %I', v_name);
  end loop;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoice_issuers'::regclass and conname = 'invoice_issuers_mode_check'
  ) then
    alter table invoice_issuers add constraint invoice_issuers_mode_check
      check (mode in ('apagado', 'simulacion', 'manual', 'real'));
  end if;
end $$;

comment on column invoice_issuers.mode is
  'apagado = no hace nada; simulacion = arma la boleta y la guarda sin enviarla; manual = el barrido simula y una persona emite pedido por pedido con «Emitir esta boleta»; real = el barrido emite (MOM §35.8).';
comment on column order_invoices.created_by is
  'Quién pulsó «Emitir esta boleta» (modo manual) o registró la externa. NULL: la escribió el barrido, o se borró la cuenta de esa persona.';

-- ── 3. Empresas emisoras: Manual baja como Real ──────────────────────────────
-- Lo nuevo frente a la 0260: lo que bajaba Real a Simulación baja también
-- Manual, que emite boletas reales con el mismo token.
--
-- Cambiar el token, el subdominio o el RUC invalida la prueba de conexión, y un
-- RUC en Real o en Manual baja a Simulación: un token nuevo se prueba antes de
-- emitir. Se borra también el motivo de la prueba anterior (0260).
--
-- Lo mismo si la prueba se repite sin cambiar de modo y no confirma el RUC
-- (leyó otro, o no pudo leer): sin esto, guardar el resultado de esa prueba
-- chocaba con `invoice_issuers_real_ready` y Ajustes no podía registrarlo, con
-- el RUC emitiendo sobre la prueba vieja. Pedir a la vez otro modo encendido y
-- guardar una prueba que no confirma sigue fallando: no se calla.
--
-- «Emitir desde» no queda atrás al encender ni al cambiar de modo (MOM §35.4):
-- la fecha que sirvió para la simulación de ayer no habilita, al pasar a Manual
-- o a Real, las boletas de todo lo que se pagó desde entonces.
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
    if new.mode in ('real', 'manual') then
      new.mode := 'simulacion';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.mode in ('real', 'manual') and new.mode = old.mode
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

-- ── 4. El turno ──────────────────────────────────────────────────────────────
-- Lo nuevo frente a la 0260: quien llama dice qué fila pide (`p_mode`) y quién
-- la pidió (`p_created_by`).
--
-- Revisa DENTRO de la base, con un candado por RUC, todo lo que no puede fallar:
-- modo, conexión, monto, pagos validados, fecha de inicio, uno por pedido y el
-- tope del día. Deja la fila en `emitiendo` (real) o `simulada`. Sin desbloqueo
-- por tiempo: una fila `emitiendo` que se quedó sin respuesta se concilia, no se
-- repite.
--
-- La firma de nueve argumentos se borra antes de crear la de once: con las dos,
-- `invoice_claim(p_id => …, …, p_request => …)` —como llama el código que hoy
-- está en producción— calza en ambas, y Postgres no elige. Con una sola, esa
-- llamada va a esta con `p_mode` y `p_created_by` en NULL.
drop function if exists invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb);

create or replace function invoice_claim(
  p_id uuid,
  p_issuer uuid,
  p_store uuid,
  p_order uuid,
  p_total numeric,
  p_paid_at timestamptz,
  p_order_name text,
  p_basis jsonb,
  p_request jsonb,
  p_mode text default null,
  p_created_by uuid default null
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_org   uuid;
  v_order orders;
  v_iss   invoice_issuers;
  v_mode  text;
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
  -- Qué fila, con el modo del RUC leído bajo el candado. Sin `p_mode`, la de
  -- siempre: real solo en Real; en Manual, una simulada, porque una boleta real
  -- en Manual la pide una persona, pedido por pedido (MOM §35.8). Con `p_mode`,
  -- la pedida, si el RUC está en un modo que la da; si no —el owner cambió el
  -- modo mientras tanto, o un valor que no es un modo—, nada.
  -- En Manual, una boleta real solo con una persona detrás (`p_created_by`):
  -- el barrido nunca la pide, y si un error del código la pidiera sin nadie,
  -- la base la rechaza.
  v_mode := case
    when p_mode is null then case when v_iss.mode = 'real' then 'real' else 'simulacion' end
    when p_mode = 'real' and v_iss.mode = 'real' then 'real'
    when p_mode = 'real' and v_iss.mode = 'manual' and p_created_by is not null then 'real'
    when p_mode = 'simulacion' and v_iss.mode in ('simulacion', 'manual') then 'simulacion'
  end;
  if v_mode is null then
    return jsonb_build_object('reason', 'modo_distinto');
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

  -- Lo que se revisa depende de la fila pedida, no del modo del RUC: una
  -- simulada en Manual no mira la conexión ni los errores reales, y una real
  -- en Manual los mira como en Real.
  if v_mode = 'simulacion' then
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

  -- El tope del día cuenta las filas del modo pedido: en Manual, las simuladas
  -- del barrido no le quitan lugar a las boletas reales, ni al revés.
  select count(*) into v_count
  from order_invoices
  where issuer_id = p_issuer
    and mode = v_mode
    and status in ('simulada', 'emitiendo', 'emitida', 'en_duda')
    and created_at >= (date_trunc('day', now() at time zone 'America/Lima') at time zone 'America/Lima');
  if v_count >= v_iss.daily_limit then
    return jsonb_build_object('reason', 'tope');
  end if;

  insert into order_invoices (
    id, org_id, store_id, order_id, issuer_id, ruc, mode, status,
    order_name, total, paid_at, basis, request, created_by
  ) values (
    p_id, v_org, p_store, p_order, p_issuer, v_iss.ruc, v_mode,
    case when v_mode = 'real' then 'emitiendo' else 'simulada' end,
    p_order_name, p_total, greatest(p_paid_at, v_paid), coalesce(p_basis, '{}'::jsonb), p_request,
    p_created_by
  );
  return jsonb_build_object('id', p_id, 'mode', v_mode);
end;
$$;
revoke all on function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)
  to service_role;
