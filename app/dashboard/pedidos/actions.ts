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
import { randomUUID } from "node:crypto";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { applyConfirmationCycleToStore, recomputeOrderMasterSafe } from "@/lib/order-master";
import {
  getOrderConfirmationBrief,
  getOrderMasterDetail,
  OrderMasterReadError,
  searchOrderMaster,
  type OrderConfirmationBrief,
  type OrderMasterDetail,
} from "@/lib/orders-master-access";
import {
  defaultOperationalFor,
  isGeneralStatus,
  isOperationalStatus,
  isTerminalGeneral,
  type GeneralStatus,
} from "@/lib/order-status";
import { etiquetaDiceTerminoSinEntregar } from "@/lib/aliclik-status";
import { limaTodayKey, normalizeDistrict } from "@/lib/shipments";
import { loadGroupGfCourierRouteCheck } from "@/lib/grupo-gf-courier-route-access";
import { agencyPaymentReady, classifyOperation, type OperationKind } from "@/lib/order-macro-stage";
import {
  CONFIRMATION_CYCLE_MAX_DAYS,
  CONFIRMATION_CYCLE_MIN_DAYS,
  CONFIRMATION_MAX_DAYS,
  confirmationReminderDueAt,
  confirmationResult,
  isConfirmationChannel,
} from "@/lib/order-confirmation";
import {
  COURIER_TBD,
  MANUAL_ROUTE_CREATED_VIA,
  MAX_OUTPUTS_PER_ORDER,
  canRepeatCourier,
  manualRouteGuideCode,
  manualOutputIsCancelable,
  normalizeOrderCode,
} from "@/lib/shipment-output";
import {
  decideLabelAction,
  listNames,
  type OutputForDecision,
} from "@/lib/labels/resolve-output";
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
  const { data, error } = await sb
    .from("order_master")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();
  // Que la consulta falle no significa que el pedido sea de otra tienda. Sin
  // esto, un error de la base salía como "Sin acceso a este pedido" y mandaba a
  // revisar permisos que estaban bien.
  if (error) throw new OrderMasterReadError("el pedido", error);
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
  try {
    const ctx = await authorizeOrder(orderId);
    if (!ctx) return { error: "Sin acceso a este pedido." };
    const detail = await getOrderMasterDetail(orderId);
    if (!detail) return { error: "No encontrado." };
    return { detail };
  } catch (cause) {
    // El drawer enseña este texto y nada más, así que tiene que decir la verdad:
    // "No encontrado" solo cuando la base respondió que no hay fila. Si respondió
    // un error, va el error — es la diferencia entre borrar un pedido de la
    // cabeza del equipo y ver "column ... does not exist" y aplicar la migración.
    if (cause instanceof OrderMasterReadError) return { error: cause.message };
    throw cause;
  }
}

/** Búsqueda global, para encontrar un pedido fuera de la pestaña activa. */
export async function searchOrders(query: string): Promise<OrderMasterRow[]> {
  return searchOrderMaster(query);
}

/**
 * Huella liviana para refrescar el listado solo cuando cambió algo. Evita
 * recargar 100 filas cada pocos segundos si la operación está quieta.
 */
export async function getOrderMasterChangeToken(): Promise<string | null> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb
    .from("order_master")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { updated_at?: string } | null)?.updated_at ?? null;
}

/**
 * Cambia el ciclo de recontacto de una tienda desde la propia cola (§6.1).
 *
 * VIVE EN EL MASTER Y NO SOLO EN AJUSTES porque el efecto se mide acá: quien lo
 * mueve ve en el mismo renglón cómo cambia «Hoy». Ajustes guarda el mismo campo
 * para quien está configurando una tienda nueva.
 *
 * PIDE OWNER/ADMIN. El ciclo reparte la carga diaria de todo el equipo, así que
 * no es una preferencia de quien mira la pantalla. La comprobación va contra la
 * organización DE ESA TIENDA: ser admin en una empresa no da mando sobre otra.
 */
export async function setStoreConfirmationCycle(
  storeId: string,
  days: number,
): Promise<MasterActionState> {
  const requested = Math.trunc(Number(days));
  if (
    !Number.isFinite(requested)
    || requested < CONFIRMATION_CYCLE_MIN_DAYS
    || requested > CONFIRMATION_CYCLE_MAX_DAYS
  ) {
    return {
      error: `El ciclo debe estar entre ${CONFIRMATION_CYCLE_MIN_DAYS} y ${CONFIRMATION_CYCLE_MAX_DAYS} días.`,
    };
  }

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  // La tienda se lee por RLS: si el usuario no la ve, no existe para él.
  const { data: store } = await sb
    .from("stores")
    .select("id,org_id,name")
    .eq("id", storeId)
    .maybeSingle();
  if (!store) return { error: "Sin acceso a esta tienda." };

  const { data: membership } = await sb
    .from("memberships")
    .select("role")
    .eq("org_id", (store as { org_id: string }).org_id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = (membership as { role?: string } | null)?.role;
  if (role !== "owner" && role !== "admin") {
    return { error: "Solo un owner o admin de la tienda puede cambiar el ciclo." };
  }

  const admin = createAdminSupabase();
  const { error } = await admin
    .from("stores")
    .update({ confirmation_cycle_days: requested })
    .eq("id", storeId);
  if (error) return { error: `No se pudo guardar el ciclo: ${error.message}` };

  // Sin esto el ajuste no se notaría hasta que el barrido pasara por cada
  // pedido: la cola seguiría repartida con el ciclo viejo durante horas.
  const touched = await applyConfirmationCycleToStore(admin, storeId, requested);
  revalidatePath(MASTER_PATH);
  revalidatePath(`/dashboard/${storeId}/settings`);

  const name = (store as { name?: string }).name ?? "la tienda";
  return {
    notice:
      `Ciclo de ${name}: ${requested} ${requested === 1 ? "día" : "días"}.`
      + (touched ? ` ${touched} pedidos reprogramados.` : ""),
  };
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
  // Token legado hasta que la migración de rutas vincule provider_id. Toda
  // salida nueva que lo usa ya se valida contra el operador Grupo GF.
  propio: "Grupo GF Courier",
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

  const dispatchDate = input.dispatchDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dispatchDate)) {
    return { error: "Elige una fecha de salida válida." };
  }
  if (dispatchDate < limaTodayKey()) return { error: "La fecha de salida no puede estar en el pasado." };

  const admin = createAdminSupabase();
  // Las salidas se leen ANTES del cierre a propósito: para saber si un pedido
  // cerrado merece otro intento hay que preguntarle a su guía POR QUÉ se cerró.
  const { data: existing, error: existingError } = await admin
    .from("shipments")
    .select("id,courier,delivery_status,custody_state,reported_status")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  if (existingError) return { error: existingError.message };

  // UN PEDIDO CERRADO PORQUE LA ENTREGA FALLÓ SÍ MERECE OTRA SALIDA. El MOM §11
  // nombra «guía cancelada por courier y devolución» como entrada elegible a
  // Reproprovincia, y su sección de Swayp dice que «una salida Swayp puede
  // coexistir con la devolución Aliclik». Pero una devolución deja el pedido en
  // `devuelto` —terminal— y este guarda lo bloqueaba: con stock ya puesto en
  // provincia, no había forma de emitir la Swayp que lo aprovechara. Eran 844
  // guías sobre 842 pedidos.
  //
  // El guarda NO se quita: sigue vivo para lo que sí está cerrado de verdad. Lo
  // que se distingue es POR QUÉ se cerró, y eso no lo dice el estado del pedido
  // —`anulado` cubre tanto «lo canceló el courier» como «lo cancelamos nosotros»—
  // sino la etiqueta que Aliclik puso en la guía.
  const cerradoPorEntregaFallida = ((existing ?? []) as { reported_status?: string | null }[]).some(
    (o) => etiquetaDiceTerminoSinEntregar(o.reported_status),
  );
  if (isTerminalGeneral(ctx.row.general_status) && !cerradoPorEntregaFallida) {
    return { error: "El pedido está cerrado. Reábrelo antes de crear otra salida." };
  }
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
  if (input.courier === "propio") {
    // La tarjeta no es un permiso. Entre abrir el pedido y confirmar pudieron
    // pausar el distrito, vencer la tarifa o suspender el contrato; por eso se
    // repite exactamente la misma lectura justo antes de crear la salida.
    // La pausa gobierna el momento de ASIGNAR, no una fecha futura escrita en
    // el formulario. Elegir mañana no puede saltarse una pausa vigente hoy.
    const grupoGf = await loadGroupGfCourierRouteCheck(admin, ctx.row);
    if (!grupoGf.eligible) {
      return { error: grupoGf.reason };
    }
  }
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
  // El mismo generador que usa la restauración al deshacer un relleno: si las
  // dos fórmulas divergieran, devolver una salida a «por definir» le pondría un
  // código distinto del que tuvo, y el rótulo pegado a la caja dejaría de casar.
  const guideCode = manualRouteGuideCode(ctx.row.order_name, shipmentId, input.courier);
  // El rótulo es un PDF de 100 × 150 mm: el HTML imprimía a tamaño A4 y salía
  // diminuto en una esquina de la hoja.
  const labelUrl = `/api/pedidos/rotulos?ids=${shipmentId}`;
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
      created_via: MANUAL_ROUTE_CREATED_VIA,
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


/**
 * Anula una salida de ruta manual que todavía no salió de la empresa (§4).
 *
 * El sistema ya exigía anular —«el pedido ya tiene una guía activa: …, anúlala
 * antes de crear otra» en los modales de Shalom y Tanders, «Cancélalas o recibe
 * su retorno antes de finalizar» en el cierre— pero solo había botón para las
 * guías de Shalom. Una salida `por_definir` creada por error bloqueaba el pedido
 * entero sin dar forma de deshacerla.
 *
 * Marca `anulado`; no borra. Ver `manualOutputIsCancelable`.
 */
export async function cancelManualRouteOutput(
  shipmentId: string,
  input: { note?: string } = {},
): Promise<MasterActionState> {
  const perms = await getMasterPermissions();
  // Mismo permiso que crearla: es una corrección de registro interno, no una
  // escritura hacia el courier (esas piden permisos propios, ver `permissions`).
  if (!perms.can("master.edit")) return { error: "Tu rol no permite anular salidas." };

  const admin = createAdminSupabase();
  const { data: shipmentRow, error: shipmentError } = await admin
    .from("shipments")
    .select("id,order_id,courier,guide_code,output_code,delivery_status,custody_state,custody_transferred_at,created_via")
    .eq("id", shipmentId)
    .maybeSingle();
  if (shipmentError) return { error: `No se pudo leer la salida: ${shipmentError.message}` };
  if (!shipmentRow) return { error: "No se encontró la salida." };
  const output = shipmentRow as {
    id: string;
    order_id: string | null;
    courier: string;
    guide_code: string | null;
    output_code: string | null;
    delivery_status: string;
    custody_state: string | null;
    custody_transferred_at: string | null;
    created_via: string | null;
  };
  if (!output.order_id) return { error: "Esa salida no está vinculada a ningún pedido." };

  const ctx = await authorizeOrder(output.order_id);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  // Se revalida acá y no solo en la interfaz: un botón que no se pinta no es una
  // autorización, y entre que se abrió el drawer y se confirmó, la caja pudo
  // haber pasado al motorizado.
  if (output.created_via !== MANUAL_ROUTE_CREATED_VIA) {
    return {
      error:
        "Esa salida no es de ruta manual. Las guías de Aliclik, Shalom y Tanders se anulan desde su propio botón, que además avisa al courier.",
    };
  }
  if (!manualOutputIsCancelable(output)) {
    return {
      error:
        output.delivery_status !== "pendiente"
          ? `La salida está ${output.delivery_status.replace("_", " ")}: ya no es un registro por corregir. Registra su retorno desde el cierre.`
          : "La caja ya salió con el motorizado. Recibe su retorno en vez de anularla.",
    };
  }

  const label = output.output_code ?? output.guide_code ?? shipmentId.slice(0, 8).toUpperCase();
  const note = input.note?.trim() ?? "";
  if (note.length > 2000) return { error: "La nota es demasiado larga (máx. 2000)." };

  const occurredAt = new Date().toISOString();
  const { error: updateError } = await admin
    .from("shipments")
    .update({
      delivery_status: "anulado",
      status_category: "closed",
      pickup_state: null,
      next_followup_at: null,
      updated_at: occurredAt,
    })
    .eq("id", shipmentId)
    // Vuelve a exigir las condiciones EN LA ESCRITURA: si otra pestaña despachó
    // la caja entre la lectura de arriba y este update, no la anula igual.
    .eq("delivery_status", "pendiente")
    .eq("created_via", MANUAL_ROUTE_CREATED_VIA)
    .is("custody_transferred_at", null);
  if (updateError) return { error: `No se pudo anular la salida: ${updateError.message}` };

  const eventError = await recordEvent(admin, ctx, {
    kind: "route_output_cancelled",
    source: "manual",
    courier: output.courier,
    guideCode: output.guide_code,
    shipmentId,
    reason: note || null,
    note: `${label} anulada; la caja nunca salió de la empresa.${note ? ` Motivo: ${note}` : ""}`,
    occurredAt,
    payload: { outputCode: output.output_code, previousStatus: output.delivery_status },
  });

  await recomputeOrderMasterSafe(admin, [output.order_id]);
  revalidatePath(MASTER_PATH);
  revalidatePath("/dashboard/pedidos/despacho");
  return {
    notice: `${label} anulada. El pedido ya puede recibir otra salida.${eventError ? ` Aviso: no se pudo escribir el evento de auditoría (${eventError}).` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Rótulos: resolver la salida de cada pedido (crear si hace falta)
// ---------------------------------------------------------------------------

export interface ResolveLabelsResult extends MasterActionState {
  /** Salidas a imprimir, en el orden en que se pidieron los pedidos. */
  shipmentIds: string[];
  created: number;
  reused: number;
  /**
   * Los pedidos cuyo rótulo se REIMPRIMIÓ, por nombre.
   *
   * Antes esto era solo el contador `reused`, y el aviso decía "3 rótulos
   * reimpresos" sin decir cuáles — la primera pregunta de quien lo lee, y no
   * había forma de responderla: la reimpresión no crea salida ni deja evento, o
   * sea que el dato no se podía recuperar después de ninguna manera. El bucle
   * tenía el pedido delante en el momento de decidir y lo tiraba.
   */
  reusedOrders: string[];
  /** Pedidos que exigen una salida adicional justificada (§23). */
  blocked: { orderId: string; error: string }[];
}

/**
 * Prepara los rótulos de una tanda: por cada pedido, reusa la salida que sigue
 * en la empresa o crea una nueva sin courier decidido.
 *
 * El almacén pide "el rótulo", no "una salida": crear la salida es el efecto
 * interno de rotular. Por eso este paso no pregunta courier ni fecha — el
 * courier se fija cuando la caja entra a una ruta (§4).
 *
 * Reusar gana a crear: pulsar el botón dos veces no puede quemar el límite de
 * cinco salidas del pedido.
 */
export async function resolveLabelsForOrders(orderIds: string[]): Promise<ResolveLabelsResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) {
    return { error: "Tu rol no permite crear salidas.", shipmentIds: [], created: 0, reused: 0, reusedOrders: [], blocked: [] };
  }
  const unique = Array.from(new Set(orderIds.filter(Boolean)));
  if (!unique.length) {
    return { error: "No hay pedidos seleccionados.", shipmentIds: [], created: 0, reused: 0, reusedOrders: [], blocked: [] };
  }
  if (unique.length > MAX_BULK_OUTPUTS) {
    return {
      error: `Demasiados pedidos de una vez (máximo ${MAX_BULK_OUTPUTS}).`,
      shipmentIds: [], created: 0, reused: 0, reusedOrders: [], blocked: [],
    };
  }

  const admin = createAdminSupabase();
  const { data: shipmentRows } = await admin
    .from("shipments")
    .select("id,order_id,order_name,custody_state,delivery_status,created_at,output_number")
    .in("order_id", unique);

  const byOrder = new Map<string, OutputForDecision[]>();
  const nameByOrder = new Map<string, string>();
  for (const row of (shipmentRows ?? []) as (OutputForDecision & {
    order_id: string | null;
    order_name: string | null;
  })[]) {
    if (!row.order_id) continue;
    const list = byOrder.get(row.order_id) ?? [];
    list.push(row);
    byOrder.set(row.order_id, list);
    if (row.order_name) nameByOrder.set(row.order_id, row.order_name);
  }

  const shipmentIds: string[] = [];
  const blocked: ResolveLabelsResult["blocked"] = [];
  const reusedOrders: string[] = [];
  let created = 0;
  let reused = 0;

  for (const orderId of unique) {
    const decision = decideLabelAction(byOrder.get(orderId) ?? []);
    if (decision.kind === "reuse") {
      shipmentIds.push(decision.shipmentId);
      reused += 1;
      // El nombre sale de la salida que se reusa, que por definición existe.
      const name = nameByOrder.get(orderId);
      if (name) reusedOrders.push(name);
      continue;
    }
    if (decision.kind === "needs_justification") {
      blocked.push({
        orderId,
        error: `Tiene ${decision.activeOutputs} salida${decision.activeOutputs === 1 ? "" : "s"} todavía en la calle. Una salida adicional exige justificación: créala desde el pedido.`,
      });
      continue;
    }
    // La fecha prevista es solo seguimiento; hoy es la estimación honesta
    // mientras no exista la ruta que la fije de verdad.
    const result = await createManualRouteOutput(orderId, {
      courier: COURIER_TBD,
      dispatchDate: limaTodayKey(),
    });
    if (result.error || !result.shipmentId) {
      blocked.push({ orderId, error: result.error ?? "No se pudo crear la salida." });
      continue;
    }
    shipmentIds.push(result.shipmentId);
    created += 1;
  }

  const parts: string[] = [];
  if (created) parts.push(`${created} salida${created === 1 ? "" : "s"} creada${created === 1 ? "" : "s"}`);
  if (reused) {
    parts.push(
      `${reused} rótulo${reused === 1 ? "" : "s"} reimpreso${reused === 1 ? "" : "s"}` +
        (reusedOrders.length ? ` (${listNames(reusedOrders)})` : ""),
    );
  }
  return {
    shipmentIds,
    created,
    reused,
    reusedOrders,
    blocked,
    notice: parts.length ? parts.join(" · ") : undefined,
    error: shipmentIds.length ? undefined : "Ningún pedido tiene un rótulo que imprimir.",
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

export interface BulkStatusResult extends MasterActionState {
  /** Pedidos que quedaron en el estado pedido. */
  applied: string[];
  /** Los que no, con el motivo exacto de cada uno. */
  failed: BulkRouteOutputFailure[];
}

/**
 * El mismo gesto de «Gestión manual», aplicado a la selección: cerrar de una
 * tanda los pedidos que ya se entregaron y cobraron.
 *
 * Se hacía pedido por pedido, abriendo el drawer de cada uno. Con cincuenta
 * cerrados de la semana eso son cien clics y ninguna forma de saber cuáles
 * quedaron a medias.
 *
 * Reutiliza `setOrderStatus` y `addOrderComment` uno por uno a propósito: el
 * permiso para tocar un pedido ya cerrado, el motivo obligatorio y el registro
 * en el historial son reglas de negocio, y no pueden divergir entre la versión
 * individual y la de lote. El precio es una tanda más lenta.
 *
 * Si el estado falla, el comentario NO se escribe: un «PAGADO» sobre un pedido
 * que no cambió de estado es peor que no haber hecho nada, porque parece que sí.
 */
export async function applyOrderStatusBulk(
  orderIds: string[],
  input: { general: string; operational?: string | null; reason?: string; comment?: string },
): Promise<BulkStatusResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) {
    return { error: "Tu rol no permite modificar pedidos.", applied: [], failed: [] };
  }
  if (!isGeneralStatus(input.general)) {
    return { error: "Estado general inválido.", applied: [], failed: [] };
  }
  const comment = input.comment?.trim() ?? "";
  if (comment.length > 2000) {
    return { error: "El comentario es demasiado largo (máx. 2000).", applied: [], failed: [] };
  }

  const unique = Array.from(new Set(orderIds.filter(Boolean)));
  if (!unique.length) return { error: "No hay pedidos seleccionados.", applied: [], failed: [] };
  if (unique.length > MAX_BULK_OUTPUTS) {
    return {
      error: `Demasiados pedidos de una vez (máximo ${MAX_BULK_OUTPUTS}).`,
      applied: [],
      failed: [],
    };
  }

  const applied: string[] = [];
  const failed: BulkRouteOutputFailure[] = [];

  for (const orderId of unique) {
    try {
      const status = await setOrderStatus(orderId, {
        general: input.general,
        operational: input.operational,
        reason: input.reason,
      });
      if (status.error) {
        failed.push({ orderId, error: status.error });
        continue;
      }
      if (comment) {
        const note = await addOrderComment(orderId, { text: comment, type: "lote" });
        if (note.error) {
          // El estado SÍ cambió: decirlo fallido escondería un cambio real.
          failed.push({ orderId, error: `Estado aplicado, comentario no: ${note.error}` });
        }
      }
      applied.push(orderId);
    } catch (error) {
      failed.push({ orderId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  revalidatePath(MASTER_PATH);
  return {
    applied,
    failed,
    notice: applied.length
      ? `${applied.length} pedido${applied.length === 1 ? "" : "s"} actualizado${applied.length === 1 ? "" : "s"}.${failed.length ? ` ${failed.length} con problemas.` : ""}`
      : undefined,
    error: applied.length ? undefined : "Ningún pedido pudo actualizarse.",
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

/**
 * La ficha que se mira antes de marcar (§8): historial del cliente, duplicados
 * y cobertura. Solo lee; la autorización la impone la RLS de la consulta.
 */
export async function loadConfirmationBrief(
  orderId: string,
): Promise<{ brief: OrderConfirmationBrief } | { error: string }> {
  const brief = await getOrderConfirmationBrief(orderId);
  if (!brief) return { error: "Sin acceso a este pedido." };
  return { brief };
}

/**
 * Un intento de contacto de la gestión de confirmación (§6.1 y §8).
 *
 * Hasta ahora no existía dónde registrarlo: el resolvedor de macroetapas leía
 * `confirmation_contact` y nadie lo escribía nunca, así que el 100 % de los
 * pedidos vivía en «Sin llamar» por más llamadas que hiciera el equipo. Los
 * comentarios servían de bitácora pero no mueven nada, y «Guardar estado» es un
 * override que CONGELA el pedido frente al recálculo: usarlo como registro de
 * llamadas habría ido clavando pedidos contra el propio MOM.
 *
 * Cada gesto escribe un hecho, no un estado. La subetapa y el conteo de días
 * salen de esos hechos.
 */
export async function registerConfirmationAttempt(
  orderId: string,
  input: {
    result: string;
    channel: string;
    note?: string;
    nextContactOn?: string;
    operationId?: string;
  },
): Promise<MasterActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) {
    return { error: "Tu rol no permite registrar la gestión de confirmación." };
  }

  const result = confirmationResult(input.result);
  if (!result) return { error: "Resultado de contacto inválido." };
  if (!isConfirmationChannel(input.channel)) return { error: "Canal de contacto inválido." };

  const nextContactOn = input.nextContactOn?.trim() ?? "";
  if (result.schedulesFollowup) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextContactOn)) {
      return { error: "Indica la fecha del próximo contacto." };
    }
    // Una fecha ya pasada no es un compromiso: el pedido nacería vencido y la
    // cola de «Volver a contactar» dejaría de significar algo.
    if (nextContactOn < limaTodayKey()) {
      return { error: "La fecha del próximo contacto no puede ser anterior a hoy." };
    }
  }

  const note = input.note?.trim() ?? "";
  if (note.length > 2000) return { error: "La nota es demasiado larga (máx. 2000)." };

  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const admin = createAdminSupabase();
  const occurredAt = new Date().toISOString();
  const reminderDueAt = ["sin_respuesta", "se_deja_mensaje"].includes(result.code)
    ? confirmationReminderDueAt(occurredAt)
    : null;
  const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    input.operationId ?? "",
  )
    ? input.operationId!
    : randomUUID();
  const { data, error } = await admin.rpc("register_confirmation_attempt_v1", {
    p_store_id: ctx.storeId,
    p_order_id: orderId,
    p_actor: ctx.userId,
    p_operation_id: operationId,
    p_result: result.code,
    p_channel: input.channel,
    p_note: note || null,
    p_next_contact_on: result.schedulesFollowup ? nextContactOn : null,
    p_occurred_at: occurredAt,
    p_reminder_due_at: reminderDueAt,
  });
  if (error) return { error: `No se pudo registrar el intento: ${error.message}` };

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);

  const response = (data ?? {}) as {
    duplicate?: boolean;
    day_count?: number;
    last_attempt?: boolean;
  };
  const days = Number(response.day_count ?? 0);
  if (result.confirms) {
    // Agencia no queda confirmada por la palabra del cliente: el pedido sigue en
    // confirmación hasta que el abono se valide (§6.1). Decir «pasa a
    // Preparación» aquí mandaría a Milagros a buscarlo donde no está.
    const paymentReady = agencyPaymentReady(
      (ctx.row.macro_operation as OperationKind | null) ?? "desconocida",
      ctx.row.payment_state,
    );
    return {
      notice: paymentReady
        ? "Pedido confirmado; pasa a Preparación."
        : "Confirmado de palabra. Sigue en confirmación hasta validar el pago exigido.",
    };
  }
  if (days >= CONFIRMATION_MAX_DAYS) {
    return {
      notice: `Día ${days} de ${CONFIRMATION_MAX_DAYS}: se creó la tarea para revisar y anular manualmente en Shopify.`,
    };
  }
  return {
    notice: response.duplicate
      ? `Este intento ya estaba registrado; no se duplicó.`
      : `Intento registrado, día ${days} de ${CONFIRMATION_MAX_DAYS}.`,
  };
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
      // Sello de persona, con nombre (0118). Es el único de los tres que no
      // tiene constancia del courier detrás, y la cola de recuperación lo
      // muestra distinto por eso: de acá sale un mensaje pidiendo un adelanto.
      .update({
        custody_state: "devuelto",
        returned_at: occurredAt,
        pickup_state: "devuelto",
        returned_source: "manual",
        returned_by: ctx.userId,
      })
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
