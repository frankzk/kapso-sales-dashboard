-- ============================================================================
-- 0262_invoices_claim_coverage.sql — comprobantes por RUC: el turno vuelve a
-- revisar que la empresa recibió el pago (MOM §35, 15-10-2026).
--
-- QUÉ PASABA. El turno (`invoice_claim`, 0260 y 0261) volvía a sacar de la base
-- CUÁNDO quedó pagado el pedido, pero no SI quedó pagado. La condición 3 de
-- §35.3 —lo validado cubre el total, o es un prepago web— la decidía solo el
-- código, con lo que leyó antes de pedir el turno, y entre esa lectura y el
-- turno pasa la lectura de Shopify. Un pago validado se puede rechazar
-- (`validado → rechazado`) en ese rato. Si se rechazaba el único, el turno se
-- quedaba sin pagos validados y lo tomaba por un prepago web —con la fecha del
-- pedido— sin mirar si lo era; si se rechazaba uno de varios, lo validado que
-- quedaba ya no cubría el total. En los dos casos daba una fila real, y la
-- boleta iba a SUNAT por un dinero que la empresa no recibió. Una boleta
-- enviada no se borra.
--
-- QUÉ CAMBIA. Solo `invoice_claim`, con `create or replace` y la firma de once
-- argumentos de la 0261 tal cual (los mismos nombres y valores por defecto: no
-- nace otra versión al lado, y la llamada por nombre del código no se vuelve
-- ambigua). Justo después de `pagos_en_revision`, la condición 3 se revisa con
-- los pagos y el pedido guardados, por el camino que dice la base del
-- comprobante que manda el código (`p_basis`):
--   · Sin prepago (`prepaid` falso o ausente): tiene que haber pagos validados
--     y su suma tiene que cubrir el total que se va a emitir; si no,
--     `sin_pago_completo`. Si el pedido guardado es un prepago web y tiene
--     pagos validados, `prepago_con_comprobantes`, como en las reglas.
--   · Con prepago: ningún pago vivo (`prepago_con_comprobantes`), y el pedido
--     tiene que ser de verdad un prepago web —`financial_status` pagado,
--     `payment_gateway` el checkout y nada reembolsado—; si no,
--     `sin_pago_completo`.
--   · Cada pago que nombra `p_basis` sigue validado y es de este pedido; si
--     no, `sin_pago_completo`.
-- Y los pagos del pedido quedan bloqueados (`for share`) hasta que el turno
-- termina: un rechazo que llega mientras tanto espera a que la fila exista, y
-- lo ve el aviso de nota de crédito (§35.9), en vez de colarse entre la
-- revisión y la fila.
--
-- A QUIÉN NO. No toca datos, ni triggers, ni otra función. Los dos motivos ya
-- existen en las reglas, y el código los conoce. El código que hoy está en
-- producción pide el turno con sus nueve argumentos por nombre y ya manda
-- `prepaid` y los pagos en `p_basis`: lo que estaba bien pagado sigue dando su
-- fila. El turno sigue solo para `service_role`. Va después de la 0261: si
-- sigue el turno de nueve argumentos, o falta el de once, se detiene sin
-- cambiar nada. Si después alguien vuelve a correr la 0261, el turno queda otra
-- vez sin esta revisión hasta que se vuelva a correr la 0262. En el SQL Editor
-- corre en una sola transacción; con psql, `psql -1 -v ON_ERROR_STOP=1`.
--
-- Se aplica a mano ANTES del código (DEPLOY.md). Es idempotente.
-- ============================================================================

-- ── 1. Solo sobre la 0261 ────────────────────────────────────────────────────
-- Sobre la 0260 sin la 0261, el `create or replace` de abajo crearía el turno de
-- once al lado del de nueve, y la llamada por nombre del código de producción
-- dejaría de saber a cuál ir. Peor: al aplicar después la 0261, su turno
-- reemplazaría a éste y la revisión se perdería sin que nadie lo note.
do $$
begin
  if to_regprocedure('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)') is not null
     or to_regprocedure('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)') is null then
    raise exception 'La 0262 va después de la 0261: aplica primero db/migrations/0261_invoices_manual.sql.';
  end if;
end $$;

-- ── 2. El turno ──────────────────────────────────────────────────────────────
-- Lo nuevo frente a la 0261: los pagos del pedido bloqueados mientras dura el
-- turno, y la condición 3 de §35.3 revisada dentro de la base. Lo demás, igual.
--
-- Revisa DENTRO de la base, con un candado por RUC, todo lo que no puede fallar:
-- modo, conexión, monto, pagos validados que cubren el total, fecha de inicio,
-- uno por pedido y el tope del día. Deja la fila en `emitiendo` (real) o
-- `simulada`. Sin desbloqueo por tiempo: una fila `emitiendo` que se quedó sin
-- respuesta se concilia, no se repite.
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
  v_org       uuid;
  v_order     orders;
  v_iss       invoice_issuers;
  v_mode      text;
  v_count     integer;
  v_live      integer;
  v_paid      timestamptz;
  v_validated numeric;
  v_prepaid   boolean;
  v_web       boolean;
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

  -- Los pagos del pedido, bloqueados hasta que termine el turno (0262). Cada
  -- consulta de una función ve lo último que se guardó, así que sin esto un
  -- pago rechazado entre la revisión de abajo y la fila se colaba igual. Con
  -- esto, quien rechaza u observa un pago espera a que el turno termine y
  -- encuentra la fila ya tomada: lo emitido no se toca, y el panel avisa que
  -- un pago del comprobante ya no está validado (§35.9).
  perform 1 from order_payments where order_id = p_order for share;

  -- Cuándo quedó pagado, con los pagos de la base y no con lo que manda quien
  -- pide el turno (MOM §35.3, condiciones 2 y 8). `p_paid_at` lo calcula el
  -- código: si una regla o una lectura se equivocara, la boleta de algo pagado
  -- antes de «Emitir desde» iría igual a SUNAT, y una boleta enviada no se
  -- borra. Es la misma cuenta que `invoiceEligibility`: todos los pagos vivos
  -- (no rechazados) validados, y el `registered_at` del último, que no cambia
  -- si el pago se observa y se vuelve a validar; sin pagos vivos, la fecha del
  -- pedido (el prepago web, que se comprueba abajo).
  if exists (
    select 1 from order_payments
    where order_id = p_order
      and validation_status is distinct from 'rechazado'
      and validation_status is distinct from 'validado'
  ) then
    return jsonb_build_object('reason', 'pagos_en_revision');
  end if;
  select count(*), max(registered_at), coalesce(sum(amount), 0) into v_live, v_paid, v_validated
  from order_payments
  where order_id = p_order and validation_status = 'validado';
  if v_live = 0 then
    v_paid := coalesce(v_order.processed_at, v_order.created_at);
  end if;

  -- La empresa recibió el pago (MOM §35.3, condición 3), con los pagos y el
  -- pedido de la base (0262). El código lo decide con lo que leyó antes de la
  -- lectura de Shopify, y un pago validado se puede rechazar en ese rato: sin
  -- esto, rechazar el único dejaba al turno sin pagos y lo tomaba por un prepago
  -- web, y rechazar uno de varios dejaba un total sin cubrir. `p_basis` dice
  -- qué camino tomó el código, y aquí ese camino se comprueba con lo guardado.
  --
  -- Prepago web, como `isWebPrepaid`: pagado en Shopify, por el checkout y sin
  -- reembolsos. Nada se deduce: sin `payment_gateway`, no es prepago.
  v_web := coalesce(lower(v_order.financial_status) = 'paid', false)
           and coalesce(v_order.payment_gateway = 'checkout', false)
           and coalesce(v_order.total_refunded, 0) = 0;
  v_prepaid := coalesce((p_basis->>'prepaid')::boolean, false);
  if v_prepaid then
    -- Un prepago con comprobantes cargados no se adivina (§35.3): ¿pagó dos
    -- veces, o subió la captura del checkout? Lo ve una persona.
    if exists (
      select 1 from order_payments
      where order_id = p_order and validation_status is distinct from 'rechazado'
    ) then
      return jsonb_build_object('reason', 'prepago_con_comprobantes');
    end if;
    if not v_web then
      return jsonb_build_object('reason', 'sin_pago_completo');
    end if;
  else
    -- Lo mismo al revés: si mientras tanto el pedido pasó a prepago web y tiene
    -- pagos validados, no se elige uno de los dos dineros.
    if v_web and v_live > 0 then
      return jsonb_build_object('reason', 'prepago_con_comprobantes');
    end if;
    -- Lo validado cubre el total que se va a emitir, al céntimo y sin redondeos
    -- (los montos son numeric). Un total nulo lo rechaza `monto_cero` más abajo.
    if v_live = 0 or v_validated < p_total then
      return jsonb_build_object('reason', 'sin_pago_completo');
    end if;
  end if;
  -- Cada pago en que se apoya el comprobante sigue validado y es de este pedido.
  -- La suma puede seguir cubriendo con otro pago, pero el comprobante diría que
  -- lo pagó uno que ya no cuenta, en la cuenta (y el RUC) de ése. Un id que no
  -- es el de un pago validado de este pedido, cualquiera que sea, no pasa.
  if exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(p_basis->'payments') = 'array'
                                     then p_basis->'payments' else '[]'::jsonb end) as b(pago)
     where b.pago->>'id' is not null
       and not exists (
         select 1 from order_payments op
          where op.order_id = p_order and op.validation_status = 'validado'
            and op.id::text = b.pago->>'id'
       )
  ) then
    return jsonb_build_object('reason', 'sin_pago_completo');
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
