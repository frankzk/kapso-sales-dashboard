"use server";

// Acciones del Master de Pedidos.
//
// Patrón del repo: cada acción AUTORIZA con el cliente RLS (así confirma que el
// usuario puede ver ese pedido), escribe con el service role, deja el rastro en
// `order_events` — que es append-only — y recalcula `order_master`.
//
// En la primera etapa el Master es sobre todo visualización, control y registro
// (§11): registrar estados, comentarios y devoluciones, y corregir vínculos. No
// gestiona despachos ni asignaciones: eso sigue en Repro Provincia.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import {
  getOrderMasterDetail,
  searchOrderMaster,
  type OrderMasterDetail,
} from "@/lib/orders-master-access";
import {
  defaultOperationalFor,
  isGeneralStatus,
  isOperationalStatus,
  isTerminalGeneral,
  type GeneralStatus,
} from "@/lib/order-status";
import { limaTodayKey, normalizeDistrict } from "@/lib/shipments";
import { classifyOperation, type OperationKind } from "@/lib/order-macro-stage";
import {
  COURIER_TBD,
  MAX_OUTPUTS_PER_ORDER,
  canRepeatCourier,
  normalizeOrderCode,
} from "@/lib/shipment-output";
import type { RouteKey } from "@/lib/order-route-plan";
import type { OrderMasterRow } from "@/lib/types";

export interface MasterActionState {
  error?: string;
  notice?: string;
}

const MASTER_PATH = "/dashboard/pedidos";

interface OrderContext {
  userId: string;
  storeId: string;
  row: OrderMasterRow;
}

/**
 * Confirma que el usuario puede ver este pedido (la consulta va por RLS, así que
 * un pedido de otra tienda simplemente no aparece) y devuelve su estado actual,
 * que hace falta para registrar el "antes" en la auditoría.
 */
async function authorizeOrder(orderId: string): Promise<OrderContext | null> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await sb
    .from("order_master")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as OrderMasterRow;
  return { userId: user.id, storeId: row.store_id, row };
}

/** Escribe un movimiento en la línea de tiempo. Nunca se puede borrar (0045). */
async function recordEvent(
  admin: ReturnType<typeof createAdminSupabase>,
  ctx: OrderContext,
  event: {
    kind: string;
    source?: string;
    courier?: string | null;
    guideCode?: string | null;
    previousStatus?: string | null;
    newStatus?: string | null;
    previousOperational?: string | null;
    newOperational?: string | null;
    reason?: string | null;
    note?: string | null;
    commentType?: string | null;
    shipmentId?: string | null;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  },
): Promise<string | null> {
  const { error } = await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: ctx.row.order_id,
    kind: event.kind,
    occurred_at: event.occurredAt ?? new Date().toISOString(),
    actor: ctx.userId,
    source: event.source ?? "manual",
    courier: event.courier ?? null,
    guide_code: event.guideCode ?? null,
    previous_status: event.previousStatus ?? null,
    new_status: event.newStatus ?? null,
    previous_operational: event.previousOperational ?? null,
    new_operational: event.newOperational ?? null,
    reason: event.reason ?? null,
    note: event.note ?? null,
    comment_type: event.commentType ?? null,
    shipment_id: event.shipmentId ?? null,
    payload: event.payload ?? {},
  });
  return error ? error.message : null;
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export async function loadOrderDetail(
  orderId: string,
): Promise<{ detail: OrderMasterDetail } | { error: string }> {
  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const detail = await getOrderMasterDetail(orderId);
  if (!detail) return { error: "No encontrado." };
  return { detail };
}

/** Búsqueda global, para encontrar un pedido fuera de la pestaña activa. */
export async function searchOrders(query: string): Promise<OrderMasterRow[]> {
  return searchOrderMaster(query);
}

// ---------------------------------------------------------------------------
// Fase 3 — salidas manuales con rótulo interno y QR
// ---------------------------------------------------------------------------

// `por_definir` es una salida rotulada sin courier decidido: el almacén arma y
// pega el rótulo, y el courier se fija cuando la caja entra a una ruta (§4).
const MANUAL_ROUTE_COURIERS = ["axel", "urpi", "propio", "olva", COURIER_TBD] as const;
export type ManualRouteCourier = (typeof MANUAL_ROUTE_COURIERS)[number];

const MANUAL_COURIER_LABEL: Record<ManualRouteCourier, string> = {
  axel: "Axel Courier",
  urpi: "Urpi",
  propio: "Motorizado propio",
  olva: "Olva",
  [COURIER_TBD]: "Sin courier definido",
};

export interface CreateManualRouteOutputInput {
  /** Courier manual, o `por_definir` para decidirlo al entrar a la ruta (§4). */
  courier: RouteKey | ManualRouteCourier;
  dispatchDate: string;
  note?: string;
}

export interface CreateManualRouteOutputResult extends MasterActionState {
  shipmentId?: string;
  outputCode?: string;
  labelUrl?: string;
}

function isManualCourier(courier: string): courier is ManualRouteCourier {
  return (MANUAL_ROUTE_COURIERS as readonly string[]).includes(courier);
}

function routeOperation(row: OrderMasterRow, couriers: string[]): OperationKind {
  if (["lima", "provincia_cod", "agencia"].includes(row.macro_operation ?? "")) {
    return row.macro_operation as OperationKind;
  }
  return classifyOperation(row, couriers.map((courier) => ({ courier })));
}

/**
 * Registra una salida que no tiene API propia. La caja nace en custodia de la
 * empresa y con rótulo generado; recién la mesa de despacho puede marcarla
 * lista, cotejarla y transferirla al motorizado.
 */
export async function createManualRouteOutput(
  orderId: string,
  input: CreateManualRouteOutputInput,
): Promise<CreateManualRouteOutputResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) return { error: "Tu rol no permite crear salidas." };
  if (!isManualCourier(input.courier)) return { error: "Ese courier usa un flujo de guía propio." };

  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  if (isTerminalGeneral(ctx.row.general_status)) {
    return { error: "El pedido está cerrado. Reábrelo antes de crear otra salida." };
  }

  const dispatchDate = input.dispatchDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dispatchDate)) {
    return { error: "Elige una fecha de salida válida." };
  }
  if (dispatchDate < limaTodayKey()) return { error: "La fecha de salida no puede estar en el pasado." };

  const admin = createAdminSupabase();
  const { data: existing, error: existingError } = await admin
    .from("shipments")
    .select("id,courier,delivery_status,custody_state")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  if (existingError) return { error: existingError.message };
  const outputs = (existing ?? []) as {
    id: string;
    courier: string;
    delivery_status: string;
    custody_state: string | null;
  }[];
  const active = outputs.filter(
    (output) =>
      output.custody_state !== "devuelto" &&
      ["pendiente", "en_ruta", "por_preparar"].includes(output.delivery_status),
  );
  const note = input.note?.trim() ?? "";
  if (active.length > 0 && !note) {
    return {
      error: `Este pedido todavía tiene ${active.length} salida${active.length === 1 ? "" : "s"} activa${active.length === 1 ? "" : "s"}. Escribe el motivo de la salida adicional.`,
    };
  }

  // Sin courier decidido no se puede juzgar la repetición por modalidad (§4):
  // esa regla se aplica cuando la salida adopta un courier al entrar a la ruta.
  // El máximo de cinco salidas sí rige siempre, porque no depende del courier.
  const courier: ManualRouteCourier = input.courier;
  const tbd = courier === COURIER_TBD;
  const operation = input.courier === "olva"
    ? "agencia"
    : routeOperation(ctx.row, outputs.map((output) => output.courier));
  if (tbd) {
    if (outputs.length >= MAX_OUTPUTS_PER_ORDER) {
      return { error: "El pedido ya alcanzó el máximo de cinco salidas." };
    }
  } else {
    const priorOutputsWithCourier = outputs.filter((output) => {
      const current = output.courier.trim().toLowerCase();
      if (input.courier === "axel") return current === "axel" || current === "axel courier";
      if (input.courier === "propio") return current === "propio" || current === "motorizado propio";
      return current === input.courier;
    }).length;
    const repetition = canRepeatCourier({
      courier: MANUAL_COURIER_LABEL[input.courier],
      operation,
      priorOutputsWithCourier,
      totalOutputs: outputs.length,
    });
    if (!repetition.allowed) {
      return {
        error:
          repetition.reason === "max_outputs"
            ? "El pedido ya alcanzó el máximo de cinco salidas."
            : `${MANUAL_COURIER_LABEL[input.courier]} ya fue usado y no puede repetirse en esta modalidad.`,
      };
    }
  }

  if (input.courier === "olva") {
    const { data: payments, error: paymentError } = await admin
      .from("order_payments")
      .select("amount")
      .eq("order_id", orderId)
      .eq("validation_status", "validado");
    if (paymentError) return { error: `No se pudo validar el adelanto: ${paymentError.message}` };
    const validated = (payments ?? []).reduce(
      (sum, payment) => sum + Number((payment as { amount: number | string | null }).amount ?? 0),
      0,
    );
    if (validated < 30) {
      return { error: `Olva Agencia requiere al menos S/ 30 validados. Hay S/ ${validated.toFixed(2)}.` };
    }
  }

  const { data: order } = await admin
    .from("orders")
    .select("line_items")
    .eq("id", orderId)
    .maybeSingle();
  const lineItems = ((order as { line_items?: { title?: string | null; quantity?: number | null }[] } | null)
    ?.line_items ?? []);
  const product = lineItems
    .map((item) => `${item.title ?? "Producto"}${(item.quantity ?? 1) > 1 ? ` ×${item.quantity}` : ""}`)
    .join(" | ") || null;

  const shipmentId = crypto.randomUUID();
  const base = normalizeOrderCode(ctx.row.order_name) || orderId.slice(0, 8).toUpperCase();
  const guideCode = `MOM-${base}-${input.courier.toUpperCase()}-${shipmentId.slice(0, 8).toUpperCase()}`;
  const labelUrl = `/api/pedidos/rotulo/${shipmentId}`;
  const assignedAt = new Date().toISOString();
  const { data: inserted, error: insertError } = await admin
    .from("shipments")
    .insert({
      id: shipmentId,
      store_id: ctx.storeId,
      courier: input.courier,
      guide_code: guideCode,
      delivery_status: "pendiente",
      status_category: "pending",
      order_id: orderId,
      matched: true,
      match_method: "manual",
      order_name: ctx.row.order_name,
      customer_name: ctx.row.customer_name,
      customer_phone: ctx.row.customer_phone,
      product,
      district: ctx.row.district,
      province: ctx.row.province,
      city: ctx.row.district,
      region: ctx.row.region,
      delivery_address: ctx.row.address,
      delivery_reference: ctx.row.reference,
      latitude: ctx.row.latitude,
      longitude: ctx.row.longitude,
      assigned_at: assignedAt,
      next_followup_at: `${dispatchDate}T12:00:00-05:00`,
      preparation_state: "rotulo_generado",
      custody_state: "empresa",
      created_via: "mom_manual_route",
      label_url: labelUrl,
      ...(input.courier === "olva" ? { pickup_state: "pendiente_de_envio" } : {}),
    })
    .select("id,output_code")
    .single();
  if (insertError || !inserted) {
    return { error: insertError?.message ?? "No se pudo crear la salida." };
  }

  const outputCode = (inserted as { output_code?: string | null }).output_code ?? guideCode;
  const eventError = await recordEvent(admin, ctx, {
    kind: "route_output_created",
    source: input.courier === "olva" ? "olva" : "manual",
    courier: input.courier,
    guideCode,
    shipmentId,
    reason: note || null,
    note: tbd
      ? `${outputCode} creada sin courier definido; se fijará al entrar a una ruta. Salida prevista ${dispatchDate}.`
      : `${outputCode} creada para ${MANUAL_COURIER_LABEL[input.courier]}; salida prevista ${dispatchDate}.`,
    payload: {
      outputCode,
      dispatchDate,
      activeOutputsAtCreation: active.map((output) => output.id),
      labelUrl,
    },
  });

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  revalidatePath("/dashboard/pedidos/despacho");
  return {
    notice: `${outputCode} creada. Imprime el rótulo y entrégala a almacén para el escaneo de preparación.${tbd ? " El courier se fija cuando la caja entre a una ruta en la mesa de despacho." : ""}${eventError ? ` Aviso: no se pudo escribir el evento de auditoría (${eventError}).` : ""}`,
    shipmentId,
    outputCode,
    labelUrl,
  };
}


// ---------------------------------------------------------------------------
// Salidas en lote
// ---------------------------------------------------------------------------

export interface BulkRouteOutputFailure {
  orderId: string;
  error: string;
}

export interface BulkRouteOutputResult extends MasterActionState {
  /** Salidas creadas, en el orden en que se pidieron los pedidos. */
  created: { orderId: string; shipmentId: string; outputCode: string }[];
  /** Pedidos que no pudieron crear su salida, con el motivo exacto de cada uno. */
  failed: BulkRouteOutputFailure[];
}

// Cuántos pedidos se procesan por tanda: evita agotar el tiempo del servidor.
// No se exporta: en un módulo "use server" solo pueden salir funciones async.
const MAX_BULK_OUTPUTS = 50;

/**
 * Crea la salida de varios pedidos con el mismo courier y fecha —el caso real
 * del almacén: "todos estos salen hoy con motorizado propio".
 *
 * Reutiliza `createManualRouteOutput` pedido por pedido a propósito: las reglas
 * (máximo de cinco salidas, motivo obligatorio si ya hay una activa, adelanto de
 * Olva) son de negocio y no pueden divergir entre la versión individual y la de
 * lote. El precio es una tanda más lenta; el beneficio, que no existan dos
 * verdades sobre cuándo se puede crear una salida.
 *
 * Un pedido que falla NO detiene a los demás: el resultado dice exactamente cuál
 * falló y por qué, porque en una tanda de cuarenta el operador necesita saber
 * qué le quedó pendiente, no un "hubo un error".
 */
export async function createManualRouteOutputsBulk(
  orderIds: string[],
  input: CreateManualRouteOutputInput,
): Promise<BulkRouteOutputResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) {
    return { error: "Tu rol no permite crear salidas.", created: [], failed: [] };
  }
  const unique = Array.from(new Set(orderIds.filter(Boolean)));
  if (!unique.length) return { error: "No hay pedidos seleccionados.", created: [], failed: [] };
  if (unique.length > MAX_BULK_OUTPUTS) {
    return {
      error: `Demasiados pedidos de una vez (máximo ${MAX_BULK_OUTPUTS}).`,
      created: [],
      failed: [],
    };
  }

  const created: BulkRouteOutputResult["created"] = [];
  const failed: BulkRouteOutputFailure[] = [];

  // Secuencial: cada salida lee y escribe las salidas previas de SU pedido, y
  // una tanda de cuarenta no justifica pelear por conexiones de base de datos.
  for (const orderId of unique) {
    try {
      const result = await createManualRouteOutput(orderId, input);
      if (result.error || !result.shipmentId) {
        failed.push({ orderId, error: result.error ?? "No se pudo crear la salida." });
        continue;
      }
      created.push({
        orderId,
        shipmentId: result.shipmentId,
        outputCode: result.outputCode ?? result.shipmentId,
      });
    } catch (error) {
      failed.push({ orderId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const notice = created.length
    ? `${created.length} salida${created.length === 1 ? "" : "s"} creada${created.length === 1 ? "" : "s"}.${failed.length ? ` ${failed.length} sin crear.` : ""}`
    : undefined;
  return {
    created,
    failed,
    notice,
    error: created.length ? undefined : "Ningún pedido pudo crear su salida.",
  };
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

/**
 * Registra el estado de un pedido. Es un override manual: congela el estado
 * frente al recálculo automático hasta que alguien lo vuelva a mover a mano.
 *
 * Cambiar un pedido ya cerrado (entregado, anulado o devuelto) exige el permiso
 * `master.override_status` y un motivo obligatorio — §4: "los cambios
 * posteriores sobre un pedido entregado deberán requerir una modificación
 * manual y deberán quedar registrados en el historial".
 */
export async function setOrderStatus(
  orderId: string,
  input: { general: string; operational?: string | null; reason?: string },
): Promise<MasterActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) {
    return { error: "Tu rol no permite modificar pedidos." };
  }
  if (!isGeneralStatus(input.general)) {
    return { error: "Estado general inválido." };
  }
  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const target: GeneralStatus = input.general;
  const wasClosed = isTerminalGeneral(ctx.row.general_status);
  const reason = input.reason?.trim() ?? "";

  if (wasClosed && target !== ctx.row.general_status) {
    if (!perms.can("master.override_status")) {
      return {
        error: `Este pedido ya está ${ctx.row.general_status.replace("_", " ")}; solo un administrador puede cambiarlo.`,
      };
    }
    if (!reason) {
      return { error: "Describe el motivo del cambio: quedará en el historial." };
    }
  }

  const operational =
    input.operational && isOperationalStatus(input.operational)
      ? input.operational
      : defaultOperationalFor(target);

  const admin = createAdminSupabase();
  const eventError = await recordEvent(admin, ctx, {
    kind: "status_override",
    previousStatus: ctx.row.general_status,
    newStatus: target,
    previousOperational: ctx.row.operational_status,
    newOperational: operational,
    reason: reason || null,
  });
  if (eventError) return { error: eventError };

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return { notice: `Estado actualizado a ${target.replace("_", " ")}.` };
}

/** Comentario interno del equipo (§12). Complementa al estado, no lo sustituye. */
export async function addOrderComment(
  orderId: string,
  input: { text: string; type?: string | null },
): Promise<MasterActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) {
    return { error: "Tu rol no permite registrar comentarios." };
  }
  const text = input.text.trim();
  if (!text) return { error: "El comentario está vacío." };
  if (text.length > 2000) return { error: "El comentario es demasiado largo (máx. 2000)." };

  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const admin = createAdminSupabase();
  const eventError = await recordEvent(admin, ctx, {
    kind: "comment",
    note: text,
    commentType: input.type?.trim() || null,
  });
  if (eventError) return { error: eventError };

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return { notice: "Comentario registrado." };
}

/**
 * Registra una devolución (§3.5). Solo cierra el pedido como Devuelto cuando hay
 * evidencia de que el paquete salió: despacho previo y guía. Sin eso queda en
 * proceso de retorno, que es lo que corresponde mientras el paquete no vuelva.
 */
export async function registerReturn(
  orderId: string,
  input: { reason: string; guideCode?: string | null; occurredAt?: string },
): Promise<MasterActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) {
    return { error: "Tu rol no permite registrar devoluciones." };
  }
  const reason = input.reason?.trim() ?? "";
  if (!reason) return { error: "Indica el motivo de la devolución." };

  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const guideCode = input.guideCode?.trim() || ctx.row.guide_code;
  const dispatched = Boolean(ctx.row.dispatched_at);
  if (!dispatched || !guideCode) {
    // No es un fallo: es la regla. Se deja el rastro y el pedido queda visible
    // como retorno en curso, sin contabilizarse todavía como devolución.
    const admin = createAdminSupabase();
    const eventError = await recordEvent(admin, ctx, {
      kind: "return_started",
      reason,
      guideCode,
      note: "Retorno iniciado sin despacho o guía confirmados.",
    });
    if (eventError) return { error: eventError };
    await recomputeOrderMasterSafe(admin, [orderId]);
    revalidatePath(MASTER_PATH);
    return {
      notice:
        "Retorno registrado. El pedido no se marca como devuelto todavía: falta el despacho o la guía que lo respalde.",
    };
  }

  const admin = createAdminSupabase();
  const occurredAt = input.occurredAt || new Date().toISOString();
  const eventError = await recordEvent(admin, ctx, {
    kind: "returned",
    reason,
    guideCode,
    occurredAt,
    previousStatus: ctx.row.general_status,
    newStatus: "devuelto",
    previousOperational: ctx.row.operational_status,
    newOperational: "devuelto_al_origen",
  });
  if (eventError) return { error: eventError };
  // La devolución confirmada fija el estado; queda auditada como cualquier
  // cambio manual y el recálculo la respeta.
  const overrideError = await recordEvent(admin, ctx, {
    kind: "status_override",
    reason,
    previousStatus: ctx.row.general_status,
    newStatus: "devuelto",
    previousOperational: ctx.row.operational_status,
    newOperational: "devuelto_al_origen",
    occurredAt,
  });
  if (overrideError) return { error: overrideError };

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return { notice: "Devolución registrada." };
}

// ---------------------------------------------------------------------------
// Fase 4 — cierre operativo, físico y financiero
// ---------------------------------------------------------------------------

export type ClosureActionKey =
  | "return_request"
  | "return_receive"
  | "inventory_restock"
  | "inventory_merma"
  | "liquidation_observe"
  | "liquidation_close"
  | "indemnity_request"
  | "indemnity_resolve"
  | "refund_request"
  | "refund_complete"
  | "customer_return_start"
  | "customer_return_resolve"
  | "finalize"
  | "reopen";

export interface ClosureActionInput {
  action: ClosureActionKey;
  note: string;
  shipmentId?: string | null;
  amount?: number | null;
  reference?: string | null;
}

const CLOSURE_EVENT: Record<ClosureActionKey, string> = {
  return_request: "return_requested",
  return_receive: "return_received",
  inventory_restock: "inventory_reconciled",
  inventory_merma: "merma_closed",
  liquidation_observe: "liquidation_observed",
  liquidation_close: "liquidation_closed",
  indemnity_request: "indemnity_requested",
  indemnity_resolve: "indemnity_resolved",
  refund_request: "refund_requested",
  refund_complete: "refund_completed",
  customer_return_start: "customer_return_started",
  customer_return_resolve: "customer_return_resolved",
  finalize: "order_finalized",
  reopen: "order_reopened",
};

function workflowIsOpen(
  events: readonly { kind: string; occurred_at: string; shipment_id?: string | null }[],
  starts: readonly string[],
  closes: readonly string[],
  shipmentId?: string | null,
): boolean {
  const scoped = shipmentId
    ? events.filter((event) => event.shipment_id === shipmentId)
    : events;
  const latest = (kinds: readonly string[]) =>
    scoped
      .filter((event) => kinds.includes(event.kind))
      .reduce<{ kind: string; occurred_at: string } | null>(
        (best, event) => (!best || event.occurred_at > best.occurred_at ? event : best),
        null,
      );
  const opened = latest(starts);
  const closed = latest(closes);
  return Boolean(opened && (!closed || closed.occurred_at < opened.occurred_at));
}

/**
 * Registra un hecho de cierre sin sobrescribir el pasado. Las acciones sensibles
 * se autorizan por dimensión y las precondiciones se vuelven a validar en el
 * servidor; ocultar un botón en el navegador nunca es la única protección.
 */
export async function registerClosureAction(
  orderId: string,
  input: ClosureActionInput,
): Promise<MasterActionState> {
  const perms = await getMasterPermissions();
  const action = input.action;
  if (!Object.prototype.hasOwnProperty.call(CLOSURE_EVENT, action)) {
    return { error: "La acción de cierre no es válida." };
  }
  const canAct =
    (["return_request", "return_receive", "customer_return_start", "customer_return_resolve"] as ClosureActionKey[])
      .includes(action)
      ? perms.can("closure.return")
      : (["inventory_restock", "inventory_merma"] as ClosureActionKey[]).includes(action)
        ? perms.can("closure.inventory")
        : (["liquidation_observe", "liquidation_close", "indemnity_request", "indemnity_resolve", "refund_request"] as ClosureActionKey[])
            .includes(action)
          ? perms.can("closure.finance")
          : action === "refund_complete"
            ? perms.can("closure.refund")
            : action === "reopen"
              ? perms.can("master.override_status") && perms.can("closure.finalize")
              : perms.can("closure.finalize");
  if (!canAct) return { error: "Tu rol no permite realizar esta acción de cierre." };

  const note = input.note?.trim() ?? "";
  const reference = input.reference?.trim() || null;
  if (!note) return { error: "Escribe una nota breve. El cierre debe quedar auditado." };
  if (note.length > 2000) return { error: "La nota es demasiado larga (máx. 2000)." };
  if (reference && reference.length > 500) {
    return { error: "La referencia o evidencia es demasiado larga (máx. 500)." };
  }
  const amount = input.amount == null ? null : Number(input.amount);
  if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
    return { error: "El monto no es válido." };
  }

  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const admin = createAdminSupabase();
  const [{ data: guides, error: guidesError }, { data: events, error: eventsError }] = await Promise.all([
    admin
      .from("shipments")
      .select("id,courier,guide_code,delivery_status,custody_state,returned_at")
      .eq("order_id", orderId),
    admin
      .from("order_events")
      .select("kind,occurred_at,shipment_id")
      .eq("order_id", orderId)
      .order("occurred_at", { ascending: true }),
  ]);
  if (guidesError) return { error: guidesError.message };
  if (eventsError) return { error: eventsError.message };

  const shipmentRows = (guides ?? []) as {
    id: string;
    courier: string | null;
    guide_code: string | null;
    delivery_status: string;
    custody_state: string | null;
    returned_at: string | null;
  }[];
  const eventRows = (events ?? []) as { kind: string; occurred_at: string; shipment_id: string | null }[];
  const selectedShipment = input.shipmentId
    ? shipmentRows.find((shipment) => shipment.id === input.shipmentId)
    : null;
  if (input.shipmentId && !selectedShipment) {
    return { error: "La salida elegida no pertenece a este pedido." };
  }

  if (
    [
      "return_request",
      "return_receive",
      "inventory_restock",
      "inventory_merma",
      "indemnity_request",
      "indemnity_resolve",
    ].includes(action) &&
    !selectedShipment
  ) {
    return { error: "Elige la salida física concreta sobre la que registrarás la acción." };
  }
  if (["return_request", "return_receive"].includes(action) && selectedShipment?.custody_state === "empresa") {
    return { error: "Esta salida todavía figura en la empresa; no existe custodia externa que retornar." };
  }
  if (["return_request", "return_receive"].includes(action) && selectedShipment?.delivery_status === "entregado") {
    return { error: "Una entrega confirmada no se recibe como retorno del courier; abre una devolución del cliente." };
  }
  if (action === "return_request" && selectedShipment?.custody_state === "retorno") {
    return { error: "El retorno de esta salida ya fue solicitado." };
  }
  if (
    ["return_request", "return_receive"].includes(action) &&
    (selectedShipment?.custody_state === "devuelto" || Boolean(selectedShipment?.returned_at))
  ) {
    return { error: "Esta salida ya fue recibida físicamente en almacén." };
  }
  const selectedReturnReceived =
    selectedShipment?.custody_state === "devuelto" || Boolean(selectedShipment?.returned_at);
  if (["inventory_restock", "inventory_merma"].includes(action) && !selectedReturnReceived) {
    return { error: "Primero registra la recepción física de la devolución." };
  }
  if (
    ["inventory_restock", "inventory_merma"].includes(action) &&
    selectedShipment &&
    eventRows.some(
      (event) =>
        event.shipment_id === selectedShipment.id &&
        ["inventory_reconciled", "merma_closed"].includes(event.kind),
    )
  ) {
    return { error: "Esta salida ya fue conciliada en inventario." };
  }
  if (["liquidation_observe", "liquidation_close"].includes(action) && ctx.row.general_status !== "entregado") {
    return { error: "Solo se puede conciliar una liquidación cuando la entrega ya está confirmada." };
  }
  if (action === "liquidation_close" && ctx.row.logistics_cost == null) {
    return { error: "Falta el costo logístico. Regístralo en Costos antes de cerrar la liquidación." };
  }
  if (action === "indemnity_request") {
    if (selectedShipment?.courier?.toLowerCase() !== "aliclik") {
      return { error: "La indemnización formal solo aplica a una salida Aliclik." };
    }
    if (!amount || amount <= 0) return { error: "Indica el valor del producto reclamado." };
  }
  if (
    action === "indemnity_resolve" &&
    (selectedShipment?.courier?.toLowerCase() !== "aliclik" ||
      !workflowIsOpen(
        eventRows,
        ["indemnity_requested"],
        ["indemnity_resolved"],
        selectedShipment.id,
      ))
  ) {
    return { error: "No hay una indemnización abierta para resolver." };
  }
  if (action === "refund_complete") {
    if (!workflowIsOpen(eventRows, ["refund_requested"], ["refund_completed"])) {
      return { error: "No hay un reembolso pendiente." };
    }
    if (!amount || amount <= 0) return { error: "Indica el monto que Frankz ya reembolsó." };
  }
  if (action === "refund_request" && (!amount || amount <= 0)) {
    return { error: "Indica el monto que se solicita reembolsar." };
  }
  if (action === "customer_return_start" && ctx.row.general_status !== "entregado") {
    return { error: "La devolución del cliente se abre sobre un pedido previamente entregado." };
  }
  if (
    action === "customer_return_resolve" &&
    !workflowIsOpen(eventRows, ["customer_return_started"], ["customer_return_resolved"])
  ) {
    return { error: "No hay una devolución del cliente abierta." };
  }
  if (action === "reopen" && ctx.row.macro_stage !== "finalizado") {
    return { error: "Solo se reabre un pedido que ya está Finalizado." };
  }
  if (action === "finalize") {
    const active = shipmentRows.filter(
      (shipment) =>
        shipment.custody_state !== "devuelto" &&
        ["pendiente", "en_ruta", "por_preparar"].includes(shipment.delivery_status),
    );
    if (active.length) return { error: "Todavía existen salidas activas. Cancélalas o recibe su retorno antes de finalizar." };
    const blockers = (ctx.row.macro_reasons ?? []).filter(
      (reason) => reason !== "validacion_cierre_pendiente",
    );
    if (blockers.length) {
      return { error: `Resuelve primero: ${blockers.join(", ").replaceAll("_", " ")}.` };
    }
  }

  const occurredAt = new Date().toISOString();
  const eventError = await recordEvent(admin, ctx, {
    kind: CLOSURE_EVENT[action],
    source: "manual",
    courier: selectedShipment?.courier ?? null,
    guideCode: selectedShipment?.guide_code ?? null,
    shipmentId: selectedShipment?.id ?? null,
    reason: note,
    note,
    occurredAt,
    payload: {
      amount,
      reference,
      phase: 4,
    },
  });
  if (eventError) return { error: eventError };

  if (action === "return_request" && selectedShipment) {
    const { error } = await admin
      .from("shipments")
      .update({ custody_state: "retorno", pickup_state: "retorno_solicitado" })
      .eq("id", selectedShipment.id)
      .eq("order_id", orderId);
    if (error) return { error: `La solicitud quedó auditada, pero no se pudo actualizar la salida: ${error.message}` };
  }
  if (action === "return_receive" && selectedShipment) {
    const { error } = await admin
      .from("shipments")
      .update({ custody_state: "devuelto", returned_at: occurredAt, pickup_state: "devuelto" })
      .eq("id", selectedShipment.id)
      .eq("order_id", orderId);
    if (error) return { error: `La recepción quedó auditada, pero no se pudo actualizar la salida: ${error.message}` };
  }

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return { notice: "Acción de cierre registrada. El expediente fue recalculado." };
}

/**
 * Corrige el vínculo entre una guía y un pedido (§11). Mueve la guía al pedido
 * indicado y recalcula AMBOS: el que la pierde y el que la gana.
 */
export async function relinkGuide(
  guideCode: string,
  targetOrderId: string,
): Promise<MasterActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) {
    return { error: "Tu rol no permite corregir vínculos." };
  }
  const code = guideCode.trim();
  if (!code) return { error: "Indica la guía a vincular." };

  const ctx = await authorizeOrder(targetOrderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const sb = await createServerSupabase();
  const { data: guide } = await sb
    .from("shipments")
    .select("id,order_id,store_id,courier,guide_code")
    .eq("guide_code", code)
    .maybeSingle();
  if (!guide) return { error: `No se encontró la guía ${code}.` };

  const previousOrderId = (guide as { order_id: string | null }).order_id;
  const admin = createAdminSupabase();
  const { error: updateError } = await admin
    .from("shipments")
    .update({
      order_id: targetOrderId,
      store_id: ctx.storeId,
      order_name: ctx.row.order_name,
      matched: true,
      match_method: "manual",
    })
    .eq("id", (guide as { id: string }).id);
  if (updateError) return { error: updateError.message };

  await recordEvent(admin, ctx, {
    kind: "guide_registered",
    guideCode: code,
    courier: (guide as { courier: string }).courier,
    note: previousOrderId
      ? `Guía re-vinculada desde otro pedido (corrección manual).`
      : `Guía vinculada manualmente.`,
  });

  const affected = [targetOrderId, previousOrderId].filter((v): v is string => Boolean(v));
  await recomputeOrderMasterSafe(admin, affected);
  revalidatePath(MASTER_PATH);
  revalidatePath("/dashboard/envios");
  return { notice: `Guía ${code} vinculada a ${ctx.row.order_name ?? "el pedido"}.` };
}

// ---------------------------------------------------------------------------
// Corrección de la ubicación (§11 "corregir información")
// ---------------------------------------------------------------------------

export interface OrderGeoInput {
  region?: string | null;
  province?: string | null;
  district?: string | null;
  address?: string | null;
  reference?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  note?: string | null;
  /** Recordar el par distrito→provincia para los próximos pedidos de ese distrito. */
  rememberDistrict?: boolean;
}

function coord(value: string | number | null | undefined, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || Math.abs(n) > max) return null;
  return n;
}

function trimmed(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v || null;
}

/**
 * Corrige la ubicación de un pedido. La dirección de Shopify sale del formulario
 * que llenó el cliente y Shopify mismo la marca como problemática a menudo; el
 * punto del mapa suele estar desplazado y la provincia se infiere del distrito,
 * que puede venir mal escrito.
 *
 * La corrección se guarda APARTE de `orders` (que es el reflejo de Shopify y se
 * reescribe en cada sincronización) y gana sobre todas las demás fuentes al
 * recalcular. Mismo criterio que `shipments.address_override`.
 */
export async function updateOrderGeo(
  orderId: string,
  input: OrderGeoInput,
): Promise<MasterActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) {
    return { error: "Tu rol no permite corregir la ubicación." };
  }
  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const latitude = coord(input.latitude, 90);
  const longitude = coord(input.longitude, 180);
  if ((input.latitude && latitude === null) || (input.longitude && longitude === null)) {
    return { error: "Coordenadas inválidas. Usa grados decimales, p. ej. -12.0464, -77.0428." };
  }
  // Media coordenada no ubica nada: o las dos o ninguna.
  if ((latitude === null) !== (longitude === null)) {
    return { error: "Indica latitud y longitud, o ninguna de las dos." };
  }

  const patch = {
    order_id: orderId,
    store_id: ctx.storeId,
    region: trimmed(input.region),
    province: trimmed(input.province),
    district: trimmed(input.district),
    address: trimmed(input.address),
    reference: trimmed(input.reference),
    latitude,
    longitude,
    note: trimmed(input.note),
    updated_by: ctx.userId,
    updated_at: new Date().toISOString(),
  };

  const admin = createAdminSupabase();
  const { error } = await admin
    .from("order_geo_overrides")
    .upsert(patch, { onConflict: "order_id" });
  if (error) return { error: error.message };

  // Si el equipo arregló la provincia de un distrito, se aprende para los
  // siguientes pedidos de ese distrito: el ubigeo del INEI no siempre está
  // cargado y esta es la forma barata de irlo completando con datos reales.
  let learned = false;
  if (input.rememberDistrict && patch.district && patch.province) {
    const key = normalizeDistrict(patch.district);
    if (key) {
      const { error: geoError } = await admin.from("peru_districts").upsert(
        {
          district_key: key,
          district: patch.district,
          province: patch.province,
          department: patch.region,
          source: "manual",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "district_key" },
      );
      learned = !geoError;
    }
  }

  const detail = [
    patch.district && `distrito: ${patch.district}`,
    patch.province && `provincia: ${patch.province}`,
    patch.region && `región: ${patch.region}`,
    patch.address && `dirección: ${patch.address}`,
    latitude !== null && `coordenadas: ${latitude}, ${longitude}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const eventError = await recordEvent(admin, ctx, {
    kind: "comment",
    commentType: "ubicacion",
    reason: patch.note,
    note: `Ubicación corregida manualmente. ${detail}`.trim(),
  });
  if (eventError) return { error: eventError };

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return {
    notice: learned
      ? "Ubicación corregida. La provincia queda recordada para los próximos pedidos de ese distrito."
      : "Ubicación corregida.",
  };
}

/** Devuelve la corrección vigente, para poblar el formulario. */
export async function loadOrderGeo(
  orderId: string,
): Promise<OrderGeoInput & { hasOverride: boolean }> {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("order_geo_overrides")
    .select("region,province,district,address,reference,latitude,longitude,note")
    .eq("order_id", orderId)
    .maybeSingle();
  const row = data as (OrderGeoInput & Record<string, unknown>) | null;
  return { ...(row ?? {}), hasOverride: Boolean(row) };
}

/**
 * Quita la corrección manual y devuelve el pedido a lo que digan Shopify, los
 * reportes y el ubigeo. No borra el rastro: el historial conserva el cambio.
 */
export async function clearOrderGeo(orderId: string): Promise<MasterActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) return { error: "Tu rol no permite corregir la ubicación." };
  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const admin = createAdminSupabase();
  const { error } = await admin.from("order_geo_overrides").delete().eq("order_id", orderId);
  if (error) return { error: error.message };

  await recordEvent(admin, ctx, {
    kind: "comment",
    commentType: "ubicacion",
    note: "Corrección manual de ubicación retirada: vuelve a la dirección de origen.",
  });
  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return { notice: "Corrección retirada." };
}
