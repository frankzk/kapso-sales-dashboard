-- ============================================================================
-- 0267_invoices_backfill.sql — comprobantes por RUC: «Emitir esta boleta» para
-- lo pagado antes de «Emitir desde», desde el 01/10/2026 (MOM §35, owner
-- 15-10-2026).
--
-- QUÉ PASABA. El turno (`invoice_claim`, 0262) no da fila a un pedido pagado
-- antes de «Emitir desde» (`antes_de_inicio`), y «Emitir desde» nunca queda
-- atrás: al pasar el RUC a Manual se movió al momento del cambio. Lo pagado
-- desde el 01/10/2026 hasta ese momento se quedaba sin boleta en Kapta: sin
-- botón y sin barrido. Antes de Kapta las boletas se emitían a mano en
-- SimpleFact, y Kapta no sabe si uno de esos pedidos ya tiene la suya. Una
-- boleta de más es pagar el impuesto dos veces, y una boleta enviada no se
-- borra.
--
-- QUÉ CAMBIA. Decisión del owner (15-10-2026): «Emitir esta boleta» también
-- sirve para lo pagado antes de «Emitir desde», si se pagó desde el 01/10/2026
-- 00:00 (hora de Lima). Solo `invoice_claim`, con un argumento nuevo al final,
-- `p_backfill boolean default false`: se borra la firma de once argumentos de
-- la 0261 y nace la de doce, con el cuerpo de la 0262 tal cual salvo dos cosas:
--   · la fecha: lo pagado antes de «Emitir desde» pasa solo con `p_backfill`,
--     una fila real, el RUC en Manual, una persona detrás (`p_created_by`) y
--     las dos fechas —la que manda el código y la de la base— del 01/10/2026
--     00:00 (hora de Lima) en adelante, y también el primer dinero: la fecha
--     más temprana entre la del comprobante (`paid_at`, cuándo se movió la
--     plata) y la de registro de cada pago validado. Un pago cuyo comprobante
--     dice 29/09 y que entró a Kapta el 01/10 no pasa. Y solo con «Emitir
--     desde» ya llegado (`emit_from <= now()`): Ajustes acepta una fecha en el
--     futuro, y lo pagado antes de ella no sale, ni con el botón. Sin «Emitir
--     desde» o sin fecha de pago, `antes_de_inicio`, como siempre;
--   · la fila que nace así lo dice en su base:
--     `pagado_antes_de_emitir_desde: true`.
-- El código manda `p_backfill` solo desde el botón, y solo después de que la
-- persona marcó «Revisé en SimpleFact y este pedido no tiene boleta»: lo que
-- la base no puede saber lo confirma una persona.
--
-- A QUIÉN NO. El barrido nunca va hacia atrás: no manda `p_backfill`, y en
-- Simulación, en una simulada de Manual y en Real, lo pagado antes de «Emitir
-- desde» sigue en `antes_de_inicio`, se pida como se pida. Con «Emitir desde»
-- en el futuro, también: la excepción es para lo pagado antes de un inicio
-- que ya pasó, nunca para emitir antes de la fecha que puso el owner.
-- «Emitir desde» no cambia: Ajustes sigue sin aceptar una fecha pasada (sí
-- una futura), y un cambio de modo solo mueve la que quedó atrás. No toca
-- datos, ni triggers, ni otra función. El código que hoy está en producción
-- pide el turno por nombre, con nueve u once argumentos: con un solo turno, el
-- de doce, esas llamadas van a él con `p_backfill` en falso, y hace lo mismo
-- que antes. El turno sigue solo para `service_role`. Va después de la 0262:
-- si sigue el turno de nueve argumentos, o no hay ni el de once ni el de
-- doce, se detiene sin cambiar nada. Si después alguien vuelve a correr la
-- 0261, quedan dos turnos —el de once y éste— y la llamada por nombre del
-- código se vuelve ambigua (falla, no emite) hasta que se vuelva a correr la
-- 0267. En el SQL Editor corre en una sola transacción; con psql,
-- `psql -1 -v ON_ERROR_STOP=1`.
--
-- Se aplica a mano ANTES del código (DEPLOY.md). Es idempotente. El código
-- tolera que falte: lo pagado desde «Emitir desde» se emite como hoy, y un
-- pedido pagado antes contesta `sin_migracion`, nombrando la 0267.
-- ============================================================================

-- ── 1. Solo sobre la 0262 ────────────────────────────────────────────────────
-- Con el turno de nueve en pie (la 0260 corrida otra vez después de la 0261),
-- el de doce nacería a su lado y la llamada por nombre con nueve argumentos
-- del código dejaría de saber a cuál ir. Sin el de once ni el de doce, falta
-- la 0261. Con el de doce ya puesto (y sin el de once), es correrla otra vez:
-- pasa, y no cambia nada.
do $$
begin
  if to_regprocedure('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)') is not null
     or (to_regprocedure('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)') is null
         and to_regprocedure('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid, boolean)') is null) then
    raise exception 'La 0267 va después de la 0262: aplica primero db/migrations/0261_invoices_manual.sql y db/migrations/0262_invoices_claim_coverage.sql.';
  end if;
end $$;

-- ── 2. El turno ──────────────────────────────────────────────────────────────
-- Lo nuevo frente a la 0262: `p_backfill`, la excepción de la fecha para lo que
-- pide una persona con el RUC en Manual y «Emitir desde» ya llegado, y la marca
-- en la base de esa fila. Lo demás, igual, letra por letra.
--
-- Revisa DENTRO de la base, con un candado por RUC, todo lo que no puede fallar:
-- modo, conexión, monto, pagos validados que cubren el total, fecha de inicio,
-- uno por pedido y el tope del día. Deja la fila en `emitiendo` (real) o
-- `simulada`. Sin desbloqueo por tiempo: una fila `emitiendo` que se quedó sin
-- respuesta se concilia, no se repite.
--
-- La firma de once argumentos se borra antes de crear la de doce: con las dos,
-- `invoice_claim(p_id => …, …, p_created_by => …)` —como llama el código— calza
-- en ambas, y Postgres no elige. Con una sola, esa llamada va a ésta con
-- `p_backfill` en falso. En una transacción, nadie ve el instante entre el
-- `drop` y el `create`.
drop function if exists invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid);

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
  p_created_by uuid default null,
  p_backfill boolean default false
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
  v_backfill  boolean := false;
  v_first     timestamptz;
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
  if v_iss.emit_from is null or p_paid_at is null or v_paid is null then
    return jsonb_build_object('reason', 'antes_de_inicio');
  end if;
  -- Pagado antes de «Emitir desde»: no, salvo lo que pide una persona con
  -- «Emitir esta boleta» después de revisar en SimpleFact que el pedido no
  -- tiene boleta (0267, owner 15-10-2026): una fila real, con el RUC en Manual,
  -- quién la pidió, «Emitir desde» ya llegado y las dos fechas del 01/10/2026
  -- 00:00 (hora de Lima) en adelante. Más atrás las boletas se emitían a mano
  -- y no se sabe cuál tiene la suya. Con «Emitir desde» en el futuro (Ajustes
  -- lo acepta), nada pagado antes de él pasa: la excepción no adelanta la
  -- fecha que puso el owner. `v_iss` se leyó bajo el candado del RUC. El
  -- barrido nunca manda `p_backfill`, y en Real no pasa: ahí no hay botón. Con
  -- `p_backfill` y un pedido pagado desde «Emitir desde», nada cambia: no
  -- entra aquí.
  --
  -- El piso también para el primer dinero (`v_first`): la fecha más temprana
  -- entre la del comprobante (`paid_at`, cuándo se movió la plata; puede
  -- faltar) y la de registro de cada pago validado. Un pago cuyo comprobante
  -- dice 29/09 y que entró a Kapta el 01/10 movió la plata cuando las boletas
  -- se emitían a mano: no pasa. Sin pagos validados (el prepago web), la fecha
  -- del pedido.
  if p_paid_at < v_iss.emit_from or v_paid < v_iss.emit_from then
    select min(least(coalesce(paid_at, registered_at), registered_at)) into v_first
      from order_payments
     where order_id = p_order and validation_status = 'validado';
    if v_live = 0 then
      v_first := v_paid;
    end if;
    if coalesce(p_backfill, false)
       and v_mode = 'real' and v_iss.mode = 'manual' and p_created_by is not null
       and v_iss.emit_from <= now()
       and p_paid_at >= timestamptz '2026-10-01 00:00:00-05'
       and v_paid >= timestamptz '2026-10-01 00:00:00-05'
       and v_first >= timestamptz '2026-10-01 00:00:00-05' then
      v_backfill := true;
    else
      return jsonb_build_object('reason', 'antes_de_inicio');
    end if;
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

  -- La fila de lo pagado antes de «Emitir desde» lo dice en su base (0267):
  -- quien la mire sabe que salió por la excepción, después de que una persona
  -- revisó SimpleFact.
  insert into order_invoices (
    id, org_id, store_id, order_id, issuer_id, ruc, mode, status,
    order_name, total, paid_at, basis, request, created_by
  ) values (
    p_id, v_org, p_store, p_order, p_issuer, v_iss.ruc, v_mode,
    case when v_mode = 'real' then 'emitiendo' else 'simulada' end,
    p_order_name, p_total, greatest(p_paid_at, v_paid),
    case when v_backfill
         then coalesce(p_basis, '{}'::jsonb) || jsonb_build_object('pagado_antes_de_emitir_desde', true)
         else coalesce(p_basis, '{}'::jsonb) end,
    p_request,
    p_created_by
  );
  return jsonb_build_object('id', p_id, 'mode', v_mode);
end;
$$;
revoke all on function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid, boolean)
  to service_role;
