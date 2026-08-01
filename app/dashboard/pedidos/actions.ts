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
import { canRepeatCourier, normalizeOrderCode } from "@/lib/shipment-output";
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

const MANUAL_ROUTE_COURIERS = ["axel", "urpi", "propio", "olva"] as const;
export type ManualRouteCourier = (typeof MANUAL_ROUTE_COURIERS)[number];

const MANUAL_COURIER_LABEL: Record<ManualRouteCourier, string> = {
  axel: "Axel Courier",
  urpi: "Urpi",
  propio: "Motorizado propio",
  olva: "Olva",
};

export interface CreateManualRouteOutputInput {
  courier: RouteKey;
  dispatchDate: string;
  note?: string;
}

export interface CreateManualRouteOutputResult extends MasterActionState {
  shipmentId?: string;
  outputCode?: string;
  labelUrl?: string;
}

function isManualCourier(courier: RouteKey): courier is ManualRouteCourier {
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

  const operation = input.courier === "olva"
    ? "agencia"
    : routeOperation(ctx.row, outputs.map((output) => output.courier));
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
    note: `${outputCode} creada para ${MANUAL_COURIER_LABEL[input.courier]}; salida prevista ${dispatchDate}.`,
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
    notice: `${outputCode} creada. Imprime el rótulo y entrégala a almacén para el escaneo de preparación.${eventError ? ` Aviso: no se pudo escribir el evento de auditoría (${eventError}).` : ""}`,
    shipmentId,
    outputCode,
    labelUrl,
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
