-- ============================================================================
-- 0258_invoices_hardening.sql — comprobantes por RUC: los arreglos de la
-- revisión adversaria, sobre la 0257 que ya corrió (MOM §35, 15-10-2026).
--
-- QUÉ PASABA. La 0257 se aplicó en producción el 14-10-2026, antes de la
-- revisión adversaria, y sus arreglos se escribieron después DENTRO de la 0257.
-- Una migración que ya corrió no se vuelve a correr: lo que se le cambió nunca
-- iba a llegar a producción, y una base nueva y producción quedaban con
-- funciones distintas bajo el mismo número. La 0257 vuelve a ser, byte a byte,
-- la que corrió, y los arreglos van aquí.
--
-- QUÉ CAMBIA. Cuatro funciones, con `create or replace`:
--   · `invoice_issuers_touch`: un token, un subdominio o un RUC nuevo borra
--     también el motivo de la prueba anterior (`check_error`). Sin eso, Ajustes
--     lo mostraba como si Kapta hubiera apagado el RUC.
--   · `order_invoices_guard`: borrar una cuenta de auth.users deja en NULL
--     quién registró, pidió el reintento o resolvió, y nada más, solo dentro de
--     esa cascada (`pg_trigger_depth() > 1`). Sin eso no se podía borrar a
--     nadie que hubiera tocado un comprobante; a mano, sin borrar la cuenta,
--     sigue sin poderse.
--   · `invoice_claim`: el turno vuelve a sacar de los pagos de la base cuándo
--     quedó pagado el pedido (`pagos_en_revision` si queda uno vivo sin
--     validar; si no, el `registered_at` del último validado o la fecha del
--     pedido) y no da el turno si esa fecha o la que manda el código es
--     anterior a «Emitir desde». Un error en las reglas no manda a SUNAT una
--     boleta de antes.
--   · `invoice_candidates` (nueva): los pedidos que el barrido revisa en cada
--     pasada, sin los que ya tienen su comprobante ni los que esperan que una
--     persona pida reintentar un error. El barrido de este código la llama: sin
--     ella dice `sin_migracion` y no simula ni emite nada.
-- Los triggers de la 0257 no se recrean: guardan el oid de su función, y
-- `create or replace` lo conserva.
--
-- A QUIÉN NO. No toca datos: ni los RUC, ni sus cuentas, ni los comprobantes.
-- Es segura sobre lo que hay en producción (15-10-2026: un RUC en simulación y
-- ningún comprobante). Ninguna regla que el MOM no diga ya (§35.3, §35.4,
-- §35.6). El turno y la lista siguen solo para `service_role`, y el código que
-- hoy está en producción pide el mismo turno y conoce sus motivos. Va después
-- de la 0257, que crea las tablas que estas funciones usan.
--
-- Se aplica a mano ANTES del código (DEPLOY.md). Es idempotente.
-- ============================================================================

-- ── 1. Empresas emisoras: un token nuevo se prueba de cero ───────────────────
-- Lo nuevo frente a la 0257: también se borra el motivo de la prueba vieja.
--
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

-- ── 2. Comprobantes: quién, cuando se borra su cuenta ────────────────────────
-- Lo nuevo frente a la 0257: la cascada de auth.users pasa, y solo ella.
--
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

-- ── 3. El turno ──────────────────────────────────────────────────────────────
-- Lo nuevo frente a la 0257: cuándo quedó pagado lo dicen los pagos de la base.
--
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

-- ── 4. Los pedidos por revisar ───────────────────────────────────────────────
-- Nueva: la 0257 no la tenía.
--
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
