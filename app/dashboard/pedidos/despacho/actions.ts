"use server";

import { cancelledScanNotice } from "@/lib/scan-cancelled";
import { legacySaleManifestBlock } from "@/lib/legacy-sale-cancel-access";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { riderPickupMode } from "@/lib/grupo-gf-courier-route-access";
import { isCourierTbd } from "@/lib/shipment-output";
import {
  courierKey,
  deriveDispatchManifestState,
  dispatchScanLabel,
  needsRiderCheck,
  normalizeDispatchScan,
  pickDispatchScanTarget,
  type DispatchManifestState,
  type DispatchRouteKind,
  type DispatchScanStage,
} from "@/lib/dispatch";
import { operationFitsCourier, routeKindForCourier } from "@/lib/dispatch-routing";
import { courierLabelFor } from "@/lib/couriers/catalog";
import { limaClock, nextDay } from "@/lib/grupo-gf-courier";
import { isSwaypDispatchDay } from "@/lib/swayp-dispatch-days";
import { swaypDayLabel, swaypExitReason } from "@/lib/warehouse-swayp";
import {
  SWAYP_HANDOVER_ALREADY,
  SWAYP_HANDOVER_CLOSED,
  SWAYP_HANDOVER_CLOSED_STATES,
  SWAYP_HANDOVER_EMPTY,
  SWAYP_HANDOVER_NOT_DISPATCH_DAY,
  SWAYP_HANDOVER_NOT_FOUND,
  SWAYP_HANDOVER_NO_VINO_DONE,
  SWAYP_HANDOVER_OTRA_RUTA,
  SWAYP_HANDOVER_RESTORED,
  SWAYP_HANDOVER_ROUTE_LABEL,
  SWAYP_HANDOVER_SCAN_NOTE,
  SWAYP_HANDOVER_SCANNED,
  SWAYP_HANDOVER_STALE_REASON,
  SWAYP_HANDOVER_UNDONE,
  SWAYP_MANIFEST_FROM_ALMACEN,
  SWAYP_NO_SALE_AUTO_CLOSED,
  SWAYP_NO_SALE_DONE,
  SWAYP_NO_VINO_REASON,
  SWAYP_SCAN_USE_HANDOVER,
  swaypCloseError,
  swaypHandoverVerdict,
  swaypNoSaleError,
  swaypNoSaleNote,
  swaypNoSaleText,
  swaypStateName,
  type SwaypHandoverShipment,
  type SwaypNoSaleCode,
} from "@/lib/swayp-handover";
import { decideReception } from "@/lib/returns-reception";
import { gfReceptionOutcome, gfReturnDecision } from "@/lib/gf-returns-scan";
import {
  courierReceptionOutcome,
  earliestOccurredAt,
  gfReceivedWhenRemoved,
  latestOccurredAt,
  type ReturnScanCourier,
  type ReturnScanOutcome,
  type ReturnScanReception,
} from "@/lib/returns-scan-outcome";
import { gfOfficeReceiptNotice, readSaleEnded } from "@/lib/gf-office-receipt";
import { OUTPUT_REPLACED_KIND, officeReturnOutcome, replacedOutputIds } from "@/lib/gf-replaced-output";
import { materializeWaitingAgreementsSafe, reproReceptionNotice, REPRO_LIMA_PATH } from "@/lib/repro-lima-program";
import { boxWho, notInThisBoxMessage, oldLabelHint } from "@/lib/scan-other-box";
import {
  ambiguousScanError,
  findScanCandidatesWith,
  NO_SCAN_CANDIDATES,
  SCAN_NOT_FOUND,
  type ScanCandidates,
} from "@/lib/dispatch-scan-lookup";
import type { OutputForDecision } from "@/lib/labels/resolve-output";
import { loadPickupKeyFacts } from "@/lib/shalom/pickup-facts";
import {
  decideShalomReception,
  shalomReceptionPatch,
  type ShalomReturnGuide,
} from "@/lib/shalom/return-reception";
import { normalizeReturnGuide } from "@/lib/shalom/returns";
import type { OperationKind } from "@/lib/order-macro-stage";
import {
  DISPATCH_SHIPMENT_COLUMNS,
  getDispatchWorkspaceData,
  type DispatchManifest,
  type DispatchManifestItem,
  type DispatchShipment,
  type DispatchWorkspaceData,
} from "@/lib/dispatch-access";

const DISPATCH_PATH = "/dashboard/pedidos/despacho";
/** El armado vive en su propia pantalla: la mesa gestiona rutas, no cajas. */
const WAREHOUSE_PATH = "/dashboard/pedidos/almacen";
/** La recepción de devoluciones: mismo gesto, otro contexto (§29.13). */
const RETURNS_PATH = "/dashboard/pedidos/devoluciones";

/** Tope defensivo al armar una ruta de golpe: una tanda real son decenas. */
const MAX_ROUTE_BATCH = 100;

export interface DispatchActionResult {
  error?: string;
  notice?: string;
  shipment?: DispatchShipment;
  manifestId?: string;
  /**
   * Solo `receiveReturnedPackage` (05-11-2026): qué fue el escaneo —recepción
   * nueva, repetida o solo un aviso— para que Devoluciones cuente la tanda y
   * pinte la repetida en ámbar («no suma»). `notice` / `error` no cambian.
   */
  reception?: ReturnScanReception;
}

/** El resultado legible por máquina de un escaneo de Devoluciones. */
function receptionOf(
  courier: ReturnScanCourier,
  label: string,
  outcome: ReturnScanOutcome,
  firstReceivedAt: string | null = null,
): ReturnScanReception {
  return outcome === "repetida" ? { outcome, courier, label, firstReceivedAt } : { outcome, courier, label };
}

async function currentUser() {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  return { sb, user };
}

/**
 * Devuelve TODAS las salidas que un escaneo puede estar designando, con el
 * cliente del usuario (RLS). El buscador vive en lib/dispatch-scan-lookup.ts
 * para que el manifiesto de devolución (0307) use el MISMO.
 */
async function findScanCandidates(rawCode: string, auth?: Awaited<ReturnType<typeof currentUser>>): Promise<ScanCandidates> {
  if (!normalizeDispatchScan(rawCode)) return NO_SCAN_CANDIDATES;
  const { sb } = auth ?? await currentUser();
  return findScanCandidatesWith(sb, rawCode);
}

async function visibleManifest(manifestId: string, auth?: Awaited<ReturnType<typeof currentUser>>): Promise<DispatchManifest | null> {
  const { sb } = auth ?? await currentUser();
  const { data } = await sb
    .from("dispatch_manifests")
    .select("*")
    .eq("id", manifestId)
    .maybeSingle();
  return data as unknown as DispatchManifest | null;
}

async function auditDispatch(input: {
  orgId: string;
  manifestId?: string | null;
  shipment?: DispatchShipment | null;
  actor: string;
  kind: string;
  payload?: Record<string, unknown>;
  orderNote?: string;
}) {
  const admin = createAdminSupabase();
  await admin.from("dispatch_events").insert({
    org_id: input.orgId,
    manifest_id: input.manifestId ?? null,
    shipment_id: input.shipment?.id ?? null,
    actor: input.actor,
    kind: input.kind,
    payload: input.payload ?? {},
  });
  if (input.shipment?.order_id) {
    await admin.from("order_events").insert({
      store_id: input.shipment.store_id,
      order_id: input.shipment.order_id,
      kind: input.kind,
      actor: input.actor,
      source: "dispatch",
      courier: input.shipment.courier,
      guide_code: input.shipment.guide_code,
      shipment_id: input.shipment.id,
      note: input.orderNote ?? null,
      payload: { manifest_id: input.manifestId ?? null, ...(input.payload ?? {}) },
    });
  }
}

async function orgForStore(storeId: string): Promise<string | null> {
  const admin = createAdminSupabase();
  const { data } = await admin.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  return (data?.org_id as string | undefined) ?? null;
}

/** Operación del pedido (Lima / Provincia COD / Agencia), para validar la ruta. */
async function operationForOrder(orderId: string | null): Promise<OperationKind | null> {
  if (!orderId) return null;
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("order_master")
    .select("macro_operation")
    .eq("order_id", orderId)
    .maybeSingle();
  const value = (data?.macro_operation as string | undefined) ?? null;
  return value && ["lima", "provincia_cod", "agencia", "desconocida"].includes(value)
    ? (value as OperationKind)
    : null;
}

async function recalculateManifest(manifestId: string, actor?: string): Promise<DispatchManifestState> {
  const admin = createAdminSupabase();
  const [{ data: manifest }, { data: items }] = await Promise.all([
    admin.from("dispatch_manifests").select("state,kind").eq("id", manifestId).single(),
    admin
      .from("dispatch_manifest_items")
      .select("removed_at,office_checked_at,pickup_checked_at")
      .eq("manifest_id", manifestId),
  ]);
  const current = (manifest?.state ?? "draft") as DispatchManifestState;
  const kind = (manifest?.kind ?? "reparto") as DispatchRouteKind;
  const next = deriveDispatchManifestState(items ?? [], current, kind);
  const active = (items ?? []).filter((item) => !item.removed_at);
  const officeComplete = active.length > 0 && active.every((item) => !!item.office_checked_at);
  await admin
    .from("dispatch_manifests")
    .update({
      state: next,
      office_completed_at: officeComplete ? new Date().toISOString() : null,
      office_completed_by: officeComplete ? (actor ?? null) : null,
    })
    .eq("id", manifestId);
  return next;
}

export async function loadDispatchWorkspace(requestedId?: string | null): Promise<DispatchWorkspaceData> {
  return getDispatchWorkspaceData(requestedId);
}

/**
 * `byOrderName`: el código era el número de pedido, no la caja. `scanHold`: el
 * pedido tiene una caja reemplazada fuera y el número no elige (`replacedOutHold`).
 */
export async function lookupDispatchShipment(code: string): Promise<DispatchActionResult & { byOrderName?: boolean; scanHold?: boolean }> {
  const { candidates, byOrderName, hold } = await findScanCandidates(code);
  if (hold) return { error: hold, byOrderName, scanHold: true };
  const pick = pickDispatchScanTarget(candidates);
  if (pick.kind === "ambigua") return { error: ambiguousScanError(pick.options), byOrderName };
  return pick.kind === "unica" ? { shipment: pick.shipment, byOrderName } : { error: SCAN_NOT_FOUND };
}

/**
 * El rótulo viejo de la caja que volvió (09-10-2026, `oldLabelHint`): solo en
 * el camino que ya falla, así que el escaneo normal no paga la lectura. Lee las
 * salidas del pedido y, en «Verificar caja», cuáles están en esa caja.
 */
async function oldLabelError(
  shipment: DispatchShipment,
  where: "caja" | "pedido",
  manifestId?: string,
): Promise<string | null> {
  if (!shipment.order_id) return null;
  const admin = createAdminSupabase();
  const [{ data }, { data: order }] = await Promise.all([
    admin
      .from("shipments")
      .select("id,courier,output_code,output_number,created_at,custody_state,delivery_status,reported_status,swayp_state,dispatched_at,returned_at")
      .eq("order_id", shipment.order_id),
    admin.from("order_master").select("macro_substage").eq("order_id", shipment.order_id).maybeSingle(),
  ]);
  const outputs = (data ?? []) as unknown as OutputForDecision[];
  const reprogramming = (order as { macro_substage?: string | null } | null)?.macro_substage === "por_reprogramar_lima";
  let inThisBox = new Set<string>();
  if (where === "caja" && manifestId && outputs.length > 1) {
    const { data: items } = await admin
      .from("dispatch_manifest_items")
      .select("shipment_id")
      .eq("manifest_id", manifestId)
      .in("shipment_id", outputs.map((output) => output.id))
      .is("removed_at", null);
    inThisBox = new Set(((items ?? []) as { shipment_id: string }[]).map((item) => item.shipment_id));
  }
  return oldLabelHint(shipment.id, outputs, where, { inThisBox, reprogramming });
}

export async function markShipmentReady(code: string): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("warehouse.prepare")) return { error: "No tienes permiso para preparar paquetes." };
  // Quien arma busca lo que le falta armar: entre las salidas del pedido, esa es
  // la preferencia que desempata cuando el escaneo trae el número de pedido.
  const scan = await findScanCandidates(code);
  if (scan.hold) return { error: scan.hold };
  const pick = pickDispatchScanTarget(
    scan.candidates,
    (candidate) => candidate.custody_state === "empresa" && candidate.preparation_state !== "listo_despacho",
  );
  if (pick.kind === "ninguna") return { error: SCAN_NOT_FOUND };
  if (pick.kind === "ambigua") return { error: ambiguousScanError(pick.options) };
  const shipment = pick.shipment;
  // Un pedido anulado no se arma: lo primero que hay que decir (lib/scan-cancelled.ts).
  const cancelledReady = await cancelledScanNotice(createAdminSupabase(), shipment.order_id);
  if (cancelledReady) return { error: cancelledReady };
  if (shipment.custody_state !== "empresa") {
    // Swayp carga su ruta hacia las 05:45 y la sincronización pone custodia
    // `courier` sin persona antes de que el chofer pase a las 07:00: esa caja
    // sigue aquí y se arma escaneándola en «Entregar a Swayp» (MOM §9.1).
    if (courierKey(shipment.courier) === "fenix" && shipment.custody_state === "courier") {
      const { data: custody } = await createAdminSupabase()
        .from("shipments")
        .select("custody_transferred_by,swayp_state")
        .eq("id", shipment.id)
        .maybeSingle();
      const row = custody as { custody_transferred_by: string | null; swayp_state: number | null } | null;
      // Solo la de Lima que Swayp tiene cargada y aún no cerró (1 a 6): provincia
      // la arma Swayp, y una cerrada no se entrega.
      if (row && !row.custody_transferred_by && row.swayp_state != null && row.swayp_state >= 1 && row.swayp_state <= 6
        && (await operationForOrder(shipment.order_id)) === "lima") {
        return { error: SWAYP_SCAN_USE_HANDOVER };
      }
    }
    // La caja que volvió con el rótulo de Tanders encima: se nombra la salida
    // con la que sale. No hay alias, el QR viejo no se marca listo (§29.4).
    return { error: (await oldLabelError(shipment, "pedido")) ?? "Ese paquete ya no figura en custodia de la empresa." };
  }
  if (shipment.preparation_state === "listo_despacho") {
    return { notice: `${dispatchScanLabel(shipment)} ya estaba listo para despacho.`, shipment };
  }
  const { user } = await currentUser();
  const orgId = await orgForStore(shipment.store_id);
  if (!orgId) return { error: "No pudimos identificar la organización de la salida." };

  const now = new Date().toISOString();
  const admin = createAdminSupabase();
  const { error } = await admin
    .from("shipments")
    .update({ preparation_state: "listo_despacho", ready_at: now, ready_by: user.id })
    .eq("id", shipment.id)
    .eq("custody_state", "empresa");
  if (error) return { error: error.message };
  await auditDispatch({
    orgId,
    shipment,
    actor: user.id,
    kind: "package_ready",
    orderNote: "Paquete escaneado y dejado listo para despacho.",
  });
  if (shipment.order_id) await recomputeOrderMasterSafe(admin, [shipment.order_id]);
  revalidatePath(WAREHOUSE_PATH);
  revalidatePath(DISPATCH_PATH);
  revalidatePath("/dashboard/pedidos");
  return { notice: `${dispatchScanLabel(shipment)} quedó listo para despacho.`, shipment };
}

/** Los couriers cuyas cajas devueltas se reciben escaneando (MOM §9.4). */
const RETURN_SCAN_COURIERS = new Set(["tanders", "shalom"]);

/**
 * Registra que una caja devuelta LLEGÓ al almacén. Es el escaneo de la pantalla
 * de devoluciones, y vive acá —junto a `markShipmentReady`— porque usa el mismo
 * buscador de escaneos y la misma auditoría: una sola forma de resolver un QR.
 *
 * NO reescribe el sello del courier. Si Tanders ya dio la guía por devuelta,
 * su `returned_at` y su procedencia (`tanders_api`) se quedan como están
 * (0118: la procedencia de una devolución no se pisa) y la llegada física se
 * escribe como el evento canónico `return_received`, con la persona que la
 * escaneó. Si el courier todavía no la había reportado, quien la tiene en la
 * mano la sella — exactamente lo que hacía el botón manual del drawer.
 *
 * Tanders y Shalom. Shalom tiene su propia decisión (`receiveShalomReturn`):
 * una guía que dio por recogida también se recibe si la clienta nunca tuvo la
 * clave. Aliclik sigue con su vía de sellado y su cola de recuperación.
 *
 * `returnGuide` es la guía de retorno de la etiqueta de Shalom, si se anotó.
 */
export async function receiveReturnedPackage(
  code: string,
  opts: { returnGuide?: string | null } = {},
): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("warehouse.prepare")) return { error: "No tienes permiso para recibir paquetes." };
  const returnGuide = normalizeReturnGuide(opts.returnGuide);
  if (returnGuide === false) {
    return { error: "La guía de retorno no es válida: escribe solo el número que trae la etiqueta de Shalom." };
  }
  const scan = await findScanCandidates(code);
  if (scan.hold) return { error: scan.hold };
  const pick = pickDispatchScanTarget(
    scan.candidates,
    (candidate) => RETURN_SCAN_COURIERS.has(candidate.courier),
  );
  if (pick.kind === "ninguna") return { error: SCAN_NOT_FOUND };
  if (pick.kind === "ambigua") return { error: ambiguousScanError(pick.options) };
  const shipment = pick.shipment;
  if (shipment.courier === "propio" || isCourierTbd(shipment.courier)) return receiveGrupoGfReturn(shipment);
  if (!RETURN_SCAN_COURIERS.has(shipment.courier)) {
    return { error: `${dispatchScanLabel(shipment)} no es de Tanders, Shalom ni Grupo GF: su devolución se registra desde el Master.` };
  }
  if (shipment.courier === "shalom") return receiveShalomReturn(shipment, returnGuide);

  const admin = createAdminSupabase();
  const [{ data: guide }, { data: received }] = await Promise.all([
    admin
      .from("shipments")
      .select("delivery_status,custody_state,returned_at")
      .eq("id", shipment.id)
      .maybeSingle(),
    // Con su hora: una repetida dice cuándo se recibió (05-11-2026).
    admin
      .from("order_events")
      .select("id,occurred_at")
      .eq("shipment_id", shipment.id)
      .eq("kind", "return_received")
      .limit(50),
  ]);
  if (!guide) return { error: SCAN_NOT_FOUND };
  const decision = decideReception(
    guide as { delivery_status: string; custody_state: string | null; returned_at: string | null },
    Boolean(received?.length),
  );
  if (!decision.ok) {
    // «Ya recibida» no es un error de quien escanea: es la caja que pasó dos
    // veces por el lector. Se avisa sin alarma, en ámbar y sin sumar.
    return courierReceptionOutcome(decision) === "repetida"
      ? {
          notice: `${dispatchScanLabel(shipment)}: ${decision.message}`,
          shipment,
          reception: receptionOf(
            "tanders",
            dispatchScanLabel(shipment),
            "repetida",
            earliestOccurredAt(received as { occurred_at?: string | null }[] | null, (guide as { returned_at: string | null }).returned_at),
          ),
        }
      : { error: `${dispatchScanLabel(shipment)}: ${decision.message}` };
  }

  const { user } = await currentUser();
  const orgId = await orgForStore(shipment.store_id);
  if (!orgId) return { error: "No pudimos identificar la organización de la salida." };
  const now = new Date().toISOString();

  if (decision.seal) {
    const { data: sealed, error } = await admin
      .from("shipments")
      .update({
        custody_state: "devuelto",
        returned_at: now,
        pickup_state: "devuelto",
        returned_source: "manual",
        returned_by: user.id,
      })
      .eq("id", shipment.id)
      .is("returned_at", null)
      .select("id");
    if (error) return { error: error.message };
    // Nada escrito: otra lectura (otro teléfono, un reintento) o el courier la
    // sellaron entre la lectura y la escritura. Sin evento de auditoría: si ya
    // está recibida es una repetida; si no, se pide volver a escanear.
    if (!sealed?.length) return tandersSealLost(admin, shipment);
  } else {
    // El courier ya la selló: la custodia puede seguir en `retorno` si el
    // último reporte fue RETURNING; con la caja acá, ya es nuestra.
    await admin.from("shipments").update({ custody_state: "devuelto" }).eq("id", shipment.id);
  }
  await auditDispatch({
    orgId,
    shipment,
    actor: user.id,
    kind: "return_received",
    orderNote: "Devolución recibida en almacén: la caja se escaneó al llegar.",
    payload: { via: "escaneo", courier_ya_la_habia_sellado: !decision.seal },
  });
  if (shipment.order_id) await recomputeOrderMasterSafe(admin, [shipment.order_id]);
  revalidatePath(RETURNS_PATH);
  revalidatePath("/dashboard/pedidos");
  return {
    notice: `${dispatchScanLabel(shipment)} recibida en almacén.`,
    shipment,
    reception: receptionOf("tanders", dispatchScanLabel(shipment), "nueva"),
  };
}

/** Lo que en `order_events` dice que una salida de Grupo GF se recibió en oficina. */
const GF_RECEPTION_KINDS = ["returned_to_office", "reclaimed_in_office", "return_received"];

/**
 * `gf_return_to_office` falló porque el paquete ya no está en la caja del
 * motorizado: ¿lo recibió otra lectura? Solo si la caja lo soltó al recibirlo
 * —una recepción registrada en la misma transacción que lo sacó de la caja
 * (`now()` es el mismo)—; si lo sacaron por otra vía, o no se puede leer,
 * sigue siendo el error de siempre.
 */
async function gfReceptionWonElsewhere(
  admin: ReturnType<typeof createAdminSupabase>,
  shipmentId: string,
  itemId: string,
  message: string,
): Promise<{ at: string | null } | null> {
  if (!/ya no está en la caja/i.test(message)) return null;
  const [itemRead, eventsRead] = await Promise.all([
    admin.from("dispatch_manifest_items").select("removed_at").eq("id", itemId).maybeSingle(),
    admin
      .from("order_events")
      .select("id,occurred_at")
      .eq("shipment_id", shipmentId)
      .in("kind", GF_RECEPTION_KINDS)
      .order("occurred_at", { ascending: false })
      .limit(1),
  ]);
  if (itemRead.error || eventsRead.error) return null;
  const at = latestOccurredAt(eventsRead.data as { occurred_at?: string | null }[] | null);
  return gfReceivedWhenRemoved((itemRead.data as { removed_at?: string | null } | null)?.removed_at ?? null, at) ? { at } : null;
}

/** Tanders: el sello no se escribió porque la guía cambió mientras se escaneaba. */
async function tandersSealLost(
  admin: ReturnType<typeof createAdminSupabase>,
  shipment: DispatchShipment,
): Promise<DispatchActionResult> {
  const label = dispatchScanLabel(shipment);
  const { data } = await admin
    .from("order_events")
    .select("id,occurred_at")
    .eq("shipment_id", shipment.id)
    .eq("kind", "return_received")
    .limit(50);
  if (!data?.length) return { error: `${label}: la guía cambió mientras escaneabas. Vuelve a escanearla.` };
  return {
    notice: `${label}: Esta caja ya se había recibido en almacén.`,
    shipment,
    reception: receptionOf("tanders", label, "repetida", earliestOccurredAt(data as { occurred_at?: string | null }[])),
  };
}

/**
 * Un paquete de Grupo GF (o sin courier aún) escaneado en Devoluciones (MOM
 * §29.13, `lib/gf-returns-scan.ts`). Un «No entregado» se recibe en oficina
 * como en Despacho del día y el pedido queda por asignar para reprogramarlo;
 * lo que nunca salió solo se explica. Un pedido anulado en la tienda se recibe
 * igual —la caja tiene que salir de la del motorizado— y va a inventario
 * (0307, owner 04-11-2026): Almacén decide stock o merma.
 */
async function receiveGrupoGfReturn(shipment: DispatchShipment): Promise<DispatchActionResult> {
  const label = dispatchScanLabel(shipment);
  const admin = createAdminSupabase();
  const [{ data: items }, { data: received }, cancelled, { data: replacedEvents }, saleEndedBefore] = await Promise.all([
    admin
      .from("dispatch_manifest_items")
      .select("id,manifest_id,dispatch_manifests!inner(courier,route_date,driver_name)")
      .eq("shipment_id", shipment.id)
      .is("removed_at", null)
      .eq("dispatch_manifests.courier", "propio")
      .limit(1),
    // Con su hora: una repetida dice cuándo se recibió (05-11-2026). También
    // `return_received`: es lo único que deja en `order_events` la rama a stock
    // de `gf_return_to_office` (la reemplazada, el anulado en la tienda, la que
    // ya constaba devuelta; 0248/0307). Lo más nuevo primero.
    admin
      .from("order_events")
      .select("id,occurred_at")
      .eq("shipment_id", shipment.id)
      .in("kind", GF_RECEPTION_KINDS)
      .order("occurred_at", { ascending: false })
      .limit(50),
    cancelledScanNotice(admin, shipment.order_id),
    // La caja reemplazada por otra salida (0248): vuelve a stock, no a la cola.
    admin
      .from("order_events")
      .select("id")
      .eq("shipment_id", shipment.id)
      .eq("kind", "output_replaced")
      .limit(1),
    // Anulado en la tienda o venta Woo terminada: una ya recibida fue a inventario.
    readSaleEnded(admin, shipment.order_id ? [shipment.order_id] : []),
  ]);
  // La marca es el evento: «Solicitar devolución» también deja `retorno`, y esa
  // vuelve a «por asignar» como siempre.
  const replaced = Boolean(replacedEvents?.length);
  const item = (items ?? [])[0] as
    | { id: string; manifest_id: string; dispatch_manifests: { route_date: string; driver_name: string | null } | { route_date: string; driver_name: string | null }[] }
    | undefined;
  const manifest = item ? (Array.isArray(item.dispatch_manifests) ? item.dispatch_manifests[0] : item.dispatch_manifests) : null;
  let stopStatus: string | null = null;
  if (item) {
    const { data: stop } = await admin
      .from("delivery_stops")
      .select("status")
      .eq("shipment_id", shipment.id)
      .eq("dispatch_manifest_id", item.manifest_id)
      .order("reported_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    stopStatus = (stop as { status?: string } | null)?.status ?? null;
  }
  const decision = gfReturnDecision(label, {
    box: item && manifest ? { riderName: manifest.driver_name ?? "el motorizado", routeDate: manifest.route_date, stopStatus } : null,
    custodyState: shipment.custody_state,
    receivedInOffice: Boolean(received?.length),
    replaced,
    saleEnded: Boolean(shipment.order_id && saleEndedBefore.has(shipment.order_id)),
  });
  if (decision.kind === "error") return { error: decision.message };
  // Ya recibida y a inventario: el anulado ya está resuelto, no es una alarma.
  if (decision.kind === "aviso") {
    // La ÚLTIMA recepción: la salida conserva su id de vuelta en vuelta, y la
    // que se repite es la de esta vuelta, no la de un «No entregado» anterior.
    const reception = receptionOf(
      "grupo_gf",
      label,
      gfReceptionOutcome(decision) ?? "informativa",
      latestOccurredAt(received as { occurred_at?: string | null }[] | null),
    );
    return cancelled && !decision.toInventory ? { error: cancelled, reception } : { notice: decision.message, shipment, reception };
  }
  // De aquí en adelante este escaneo escribe la recepción: es nueva, también
  // si el aviso sale en rojo (anulado solo en Kapta) o la caja va a stock.
  const receivedNow = receptionOf("grupo_gf", label, "nueva");

  const { user } = await currentUser();
  const { data: orderId, error } = await admin.rpc("gf_return_to_office", { p_item_id: item!.id, p_actor: user.id });
  if (error) {
    // Dos lecturas a la vez (dos teléfonos, o un reintento mientras la primera
    // seguía): la otra la recibió primero. Con su recepción a la vista es una
    // repetida, no un error.
    const lost = await gfReceptionWonElsewhere(admin, shipment.id, item!.id, error.message);
    if (lost) return { notice: `${label} ya se recibió en oficina en otra lectura: no se registra otra vez.`, shipment, reception: receptionOf("grupo_gf", label, "repetida", lost.at) };
    return { error: `${label}: ${error.message}` };
  }
  if (orderId) await recomputeOrderMasterSafe(admin, [orderId as string]);
  revalidatePath(RETURNS_PATH);
  revalidatePath("/dashboard/courier");
  revalidatePath("/dashboard/pedidos");
  // El aviso dice lo que la base hizo, releído: un reemplazo que terminó
  // mientras tanto la manda a stock aunque lo leído arriba dijera otra cosa.
  // Un pedido anulado en la tienda va a inventario (0307, owner 04-11-2026).
  const [{ data: after }, { data: replacedAfter }, saleEnded] = await Promise.all([
    admin.from("shipments").select("custody_state").eq("id", shipment.id).maybeSingle(),
    admin.from("order_events").select("id").eq("shipment_id", shipment.id).eq("kind", OUTPUT_REPLACED_KIND).limit(1),
    readSaleEnded(admin, orderId ? [orderId as string] : []),
  ]);
  const outcome = officeReturnOutcome(
    (after as { custody_state?: string | null } | null)?.custody_state,
    Boolean(replacedAfter?.length),
    Boolean(orderId && saleEnded.has(orderId as string)),
  );
  const notice = {
    label,
    outcome,
    riderName: manifest?.driver_name ?? "el motorizado",
    routeDate: manifest?.route_date ?? "",
    cancelledNotice: cancelled,
  };
  if (outcome === "a_stock_reemplazada" || outcome === "a_inventario_anulado" || outcome === "ya_devuelta") {
    return { ...gfOfficeReceiptNotice({ ...notice, reproParts: [] }), shipment, reception: receivedNow };
  }
  // Repro Lima (§29.13): el acuerdo que esperaba esta caja se programa para su
  // día y el aviso lo dice; o dice que el cliente ya no lo quiere. Sin RPC ni
  // recálculo: nunca lanza (E30).
  const repro = orderId
    ? await materializeWaitingAgreementsSafe(admin, [orderId as string], user.id, { via: "recepcion" })
    : null;
  const reproParts = repro ? reproReceptionNotice(repro, { single: true }) : [];
  revalidatePath(REPRO_LIMA_PATH);
  return { ...gfOfficeReceiptNotice({ ...notice, reproParts }), shipment, reception: receivedNow };
}

/**
 * La caja de Shalom llegó al almacén (MOM §9.4 y §12).
 *
 * Shalom no sella devoluciones: o el rastreo la dejó en `retorno` al sacarla de
 * la agencia, o la dio por recogida. En el segundo caso solo se recibe si la
 * clienta nunca tuvo la clave, y entonces la guía se corrige: deja de ser un
 * recojo y queda anulada, y el pedido pasa a devuelto. Sin poder leer la clave
 * no se decide nada: se pide volver a escanear.
 */
async function receiveShalomReturn(
  shipment: DispatchShipment,
  returnGuide: string | null,
): Promise<DispatchActionResult> {
  const label = dispatchScanLabel(shipment);
  const admin = createAdminSupabase();
  const [guideRead, receivedRead] = await Promise.all([
    admin
      .from("shipments")
      .select("delivery_status,custody_state,returned_at,pickup_state,dispatched_at,out_for_delivery_at")
      .eq("id", shipment.id)
      .maybeSingle(),
    // Con su hora: una repetida dice cuándo se recibió (05-11-2026).
    admin
      .from("order_events")
      .select("id,occurred_at")
      .eq("shipment_id", shipment.id)
      .eq("kind", "return_received")
      .limit(50),
  ]);
  const readError = guideRead.error ?? receivedRead.error;
  if (readError) return { error: `${label}: no se pudo leer la guía (${readError.message}). Vuelve a escanearla.` };
  const guide = guideRead.data as ShalomReturnGuide | null;
  if (!guide) return { error: SCAN_NOT_FOUND };

  const keys = shipment.order_id
    ? await loadPickupKeyFacts(admin, shipment.order_id)
    : ({ ok: true, facts: { hasKey: false, keyGiven: false } } as const);
  if (!keys.ok) return { error: `${label}: ${keys.error}. Vuelve a escanearla.` };

  const decision = decideShalomReception(guide, keys.facts, Boolean(receivedRead.data?.length));
  if (!decision.ok) {
    return courierReceptionOutcome(decision) === "repetida"
      ? {
          notice: `${label}: ${decision.message}`,
          shipment,
          reception: receptionOf(
            "shalom",
            label,
            "repetida",
            earliestOccurredAt(receivedRead.data as { occurred_at?: string | null }[] | null, guide.returned_at),
          ),
        }
      : { error: `${label}: ${decision.message}` };
  }

  const { user } = await currentUser();
  const orgId = await orgForStore(shipment.store_id);
  if (!orgId) return { error: "No pudimos identificar la organización de la salida." };
  const now = new Date().toISOString();

  // Los filtros repiten lo que se decidió: si la guía cambió entre la lectura y
  // la escritura, no se toca y se pide volver a escanear.
  let write = admin.from("shipments").update(shalomReceptionPatch(decision, user.id, now)).eq("id", shipment.id);
  if (decision.correct) write = write.eq("delivery_status", "entregado");
  if (decision.seal) write = write.is("returned_at", null);
  const { data: written, error } = await write.select("id");
  if (error) return { error: error.message };
  if (!written?.length) {
    // Otra lectura (otro teléfono, un reintento) la recibió primero: con su
    // recepción a la vista es una repetida, no un error.
    const { data: again } = await admin
      .from("order_events")
      .select("id,occurred_at")
      .eq("shipment_id", shipment.id)
      .eq("kind", "return_received")
      .limit(50);
    if (again?.length) {
      return {
        notice: `${label}: Esta caja ya se había recibido en almacén.`,
        shipment,
        reception: receptionOf("shalom", label, "repetida", earliestOccurredAt(again as { occurred_at?: string | null }[])),
      };
    }
    return { error: `${label}: la guía cambió mientras escaneabas. Vuelve a escanearla.` };
  }

  const reference = returnGuide ? ` Guía de retorno de Shalom: ${returnGuide}.` : "";
  await auditDispatch({
    orgId,
    shipment,
    actor: user.id,
    kind: "return_received",
    orderNote: decision.correct
      ? `Devolución de Shalom recibida en almacén. Shalom la había dado por «recogida», pero la clienta nunca tuvo la clave: era el retorno. La guía queda anulada.${reference}`
      : `Devolución de Shalom recibida en almacén: la caja se escaneó al llegar.${reference}`,
    payload: {
      via: "escaneo",
      correccion_recogido: decision.correct,
      antes: { delivery_status: guide.delivery_status, pickup_state: guide.pickup_state, custody_state: guide.custody_state },
      guia_retorno: returnGuide,
    },
  });
  if (shipment.order_id) await recomputeOrderMasterSafe(admin, [shipment.order_id]);
  revalidatePath(RETURNS_PATH);
  revalidatePath("/dashboard/pedidos");
  return {
    notice:
      `${label} recibida en almacén.` +
      (decision.correct ? " Shalom la había dado por recogida: queda corregida como retorno." : "") +
      (returnGuide ? ` Guía de retorno ${returnGuide} anotada.` : ""),
    shipment,
    reception: receptionOf("shalom", label, "nueva"),
  };
}

const createManifestSchema = z.object({
  courier: z.string().trim().min(1).max(80),
  routeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // La interfaz ya no lo pide: una ruta se identifica por quién se la lleva y
  // qué día. Se conserva opcional para no romper enlaces o llamadas antiguas.
  routeLabel: z.string().trim().max(120).optional(),
  riderId: z.string().uuid().optional(),
  driverName: z.string().trim().max(120).optional(),
});

export async function createDispatchManifest(input: z.input<typeof createManifestSchema>): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("dispatch.manage")) return { error: "No tienes permiso para crear rutas." };
  const parsed = createManifestSchema.safeParse(input);
  if (!parsed.success) return { error: "Completa el courier y la fecha de la ruta." };
  if (courierKey(parsed.data.courier) === "propio") return { error: "Las rutas de Grupo GF se crean al tomar y asignar pedidos desde Grupo GF Courier." };
  // La entrega de Swayp Lima la abre Almacén › «Swayp por salir» (MOM §9.1, fase 3).
  if (courierKey(parsed.data.courier) === "fenix") return { error: SWAYP_MANIFEST_FROM_ALMACEN };
  const { sb, user } = await currentUser();
  const { data: store } = await sb.from("stores").select("org_id").limit(1).maybeSingle();
  if (!store?.org_id) return { error: "No tienes una organización disponible." };
  const admin = createAdminSupabase();

  // El motorizado se elige de la lista de fichas (0064/0095). Guardamos su id y
  // COPIAMOS su nombre en driver_name: si luego se renombra o desactiva la ficha,
  // las rutas ya creadas conservan a quién recibió los paquetes (MOM §6.3, §27).
  let riderId: string | null = null;
  let driverName: string | null = parsed.data.driverName || null;
  if (parsed.data.riderId) {
    const { data: rider } = await admin
      .from("riders")
      .select("id, full_name, org_id")
      .eq("id", parsed.data.riderId)
      .maybeSingle();
    if (!rider || rider.org_id !== store.org_id) return { error: "Motorizado no válido." };
    riderId = rider.id;
    driverName = rider.full_name;
  }

  // El tipo lo decide el courier, no quien crea la ruta: Aliclik y las agencias
  // no tienen motorizado que coteje, así que su ruta se cierra con el nombre de
  // quien recoge en vez de con un segundo escaneo (MOM §5).
  const kind = routeKindForCourier(parsed.data.courier);

  // La ruta se llama como quien se la lleva: el motorizado, o el courier cuando
  // no hay persona. `route_label` sigue siendo obligatorio en la base, pero ya
  // no es un dato que nadie tenga que escribir.
  const routeLabel = parsed.data.routeLabel || driverName || courierLabelFor(parsed.data.courier);

  // Un motorizado tiene UNA ruta al día, y un courier también. La base lo impide
  // con dos índices (0097); aquí se comprueba antes solo para poder decir CUÁL
  // es la ruta que ya existe, en vez de un choque de clave duplicada.
  const clash = admin
    .from("dispatch_manifests")
    .select("id,driver_name")
    .eq("org_id", store.org_id)
    .eq("route_date", parsed.data.routeDate)
    .neq("state", "cancelled");
  const { data: existing } = riderId
    ? await clash.eq("rider_id", riderId).maybeSingle()
    : await clash.is("rider_id", null).ilike("courier", parsed.data.courier).maybeSingle();
  if (existing) {
    const who = riderId ? driverName : courierLabelFor(parsed.data.courier);
    return {
      error: `${who} ya tiene una ruta ese día. Agrega los paquetes ahí en vez de crear otra.`,
      manifestId: existing.id as string,
    };
  }

  const { data, error } = await admin.from("dispatch_manifests").insert({
    org_id: store.org_id,
    courier: parsed.data.courier,
    kind,
    route_date: parsed.data.routeDate,
    route_label: routeLabel,
    rider_id: riderId,
    driver_name: driverName,
    created_by: user.id,
  }).select("id").single();
  if (error) {
    return {
      error:
        error.code === "23505"
          ? "Ya existe una ruta para ese motorizado (o ese courier) en esa fecha."
          : error.message,
    };
  }
  await auditDispatch({
    orgId: store.org_id,
    manifestId: data.id,
    actor: user.id,
    kind: "manifest_created",
    payload: parsed.data,
  });
  revalidatePath(DISPATCH_PATH);
  return { notice: "Ruta creada. Ahora agrega y coteja sus paquetes.", manifestId: data.id };
}

export async function addShipmentToManifest(manifestId: string, code: string): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("dispatch.manage")) return { error: "No tienes permiso para organizar rutas." };
  const [manifest, scan] = await Promise.all([visibleManifest(manifestId), findScanCandidates(code)]);
  if (!manifest) return { error: "Ruta no encontrada o sin acceso." };
  if (courierKey(manifest.courier) === "propio") return { error: "Agrega los pedidos desde Grupo GF Courier para conservar la solicitud y la tarifa." };
  if (courierKey(manifest.courier) === "fenix") return { error: SWAYP_MANIFEST_FROM_ALMACEN };
  if (scan.hold) return { error: scan.hold };
  const pick = pickDispatchScanTarget(scan.candidates);
  if (pick.kind === "ninguna") return { error: SCAN_NOT_FOUND };
  if (pick.kind === "ambigua") return { error: ambiguousScanError(pick.options) };
  const shipment = pick.shipment;
  const cancelledAdd = await cancelledScanNotice(createAdminSupabase(), shipment.order_id);
  if (cancelledAdd) return { error: cancelledAdd };
  if (["in_custody", "cancelled"].includes(manifest.state)) return { error: "Esa ruta ya está cerrada." };
  if (shipment.custody_state !== "empresa") return { error: "El paquete ya no está en custodia de la empresa." };
  // La ruta se ARMA antes de que almacén termine: primero se decide qué va con
  // quién y después se coteja lo que físicamente entró en la caja. El escaneo de
  // almacén dejó de ser un candado y es un indicador («5 de 8 armados»); lo que
  // ningún paquete puede saltarse es el cotejo de oficina.
  const fit = operationFitsCourier(manifest.courier, await operationForOrder(shipment.order_id));
  if (!fit.ok) return { error: fit.reason };
  // Una salida «por definir» adopta el courier de la ruta: el almacén arma y
  // rotula antes de saber con quién sale, y la decisión ocurre justo aquí, al
  // meter la caja en la agrupación de un courier concreto (MOM §4).
  const adoptsCourier = isCourierTbd(shipment.courier);
  if (!adoptsCourier && courierKey(shipment.courier) !== courierKey(manifest.courier)) {
    return { error: `La salida pertenece a ${shipment.courier}, no a ${manifest.courier}.` };
  }
  if ((await orgForStore(shipment.store_id)) !== manifest.org_id) return { error: "La salida pertenece a otra organización." };

  const { user } = await currentUser();
  const admin = createAdminSupabase();
  const { data: existing } = await admin
    .from("dispatch_manifest_items")
    .select("id,manifest_id,removed_at")
    .eq("shipment_id", shipment.id)
    .is("removed_at", null)
    .maybeSingle();
  if (existing?.manifest_id === manifestId) return { notice: "Ese paquete ya está en esta ruta.", shipment };
  if (existing) return { error: "Ese paquete ya está activo en otra ruta." };

  const { data: prior } = await admin
    .from("dispatch_manifest_items")
    .select("id")
    .eq("manifest_id", manifestId)
    .eq("shipment_id", shipment.id)
    .maybeSingle();
  const mutation = prior
    ? admin.from("dispatch_manifest_items").update({
        removed_at: null, removed_by: null, removal_reason: null,
        office_checked_at: null, office_checked_by: null,
        pickup_checked_at: null, pickup_checked_by: null,
        added_at: new Date().toISOString(), added_by: user.id,
      }).eq("id", prior.id)
    : admin.from("dispatch_manifest_items").insert({
        manifest_id: manifestId,
        shipment_id: shipment.id,
        store_id: shipment.store_id,
        added_by: user.id,
      });
  const { error } = await mutation;
  if (error) return { error: error.code === "23505" ? "Ese paquete ya está activo en otra ruta." : error.message };

  // Fijar el courier es lo último: si algo falló antes, la salida sigue «por
  // definir» y se puede reintentar en la ruta correcta.
  let adopted: string | null = null;
  if (adoptsCourier) {
    const { error: adoptError } = await admin
      .from("shipments")
      .update({ courier: manifest.courier })
      .eq("id", shipment.id);
    if (adoptError) return { error: `No se pudo fijar el courier de la salida: ${adoptError.message}` };
    adopted = manifest.courier;
    shipment.courier = manifest.courier;
    if (shipment.order_id) await recomputeOrderMasterSafe(admin, [shipment.order_id]);
  }

  await recalculateManifest(manifestId, user.id);
  await auditDispatch({
    orgId: manifest.org_id, manifestId, shipment, actor: user.id, kind: "package_added",
    orderNote: adopted
      ? `Paquete agregado a la ruta ${manifest.route_label}; courier fijado en ${adopted}.`
      : `Paquete agregado a la ruta ${manifest.route_label}.`,
  });
  revalidatePath(DISPATCH_PATH);
  revalidatePath("/dashboard/pedidos");
  return {
    notice: adopted
      ? `${shipment.output_code ?? shipment.guide_code} agregado a la ruta. Courier fijado: ${adopted}.`
      : `${shipment.output_code ?? shipment.guide_code} agregado a la ruta.`,
    shipment,
  };
}

/**
 * Arma la ruta sin escanear: el paso que faltaba.
 *
 * Antes la ruta se CONSTRUÍA escaneando en el cotejo de oficina, así que no
 * existía forma de decidir en la computadora qué va con quién y después
 * verificar. Peor: un escaneo distraído metía un paquete ajeno a la ruta y lo
 * daba por cotejado en el mismo gesto.
 *
 * Ahora son dos momentos. Aquí se decide; el cotejo solo confirma lo decidido.
 */
export async function addShipmentsToManifest(
  manifestId: string,
  shipmentIds: string[],
): Promise<DispatchActionResult & { added: number; failed: { id: string; error: string }[] }> {
  const perms = await getMasterPermissions();
  if (!perms.can("dispatch.manage")) {
    return { error: "No tienes permiso para organizar rutas.", added: 0, failed: [] };
  }
  const unique = Array.from(new Set(shipmentIds.filter(Boolean)));
  if (!unique.length) return { error: "No hay paquetes seleccionados.", added: 0, failed: [] };
  if (unique.length > MAX_ROUTE_BATCH) {
    return {
      error: `Demasiados paquetes de una vez (máximo ${MAX_ROUTE_BATCH}).`,
      added: 0,
      failed: [],
    };
  }

  const admin = createAdminSupabase();
  const { data: rows } = await admin
    .from("shipments")
    .select("id,qr_token,output_code,guide_code")
    .in("id", unique);
  const codeById = new Map(
    ((rows ?? []) as { id: string; qr_token: string | null; output_code: string | null; guide_code: string }[]).map(
      (row) => [row.id, row.qr_token || row.output_code || row.guide_code],
    ),
  );

  // Se reutiliza la acción de a uno para que TODAS las reglas —courier, custodia,
  // operación, organización, ruta duplicada— vivan en un solo sitio.
  let added = 0;
  const failed: { id: string; error: string }[] = [];
  for (const id of unique) {
    const code = codeById.get(id);
    if (!code) {
      failed.push({ id, error: "Paquete no encontrado." });
      continue;
    }
    const result = await addShipmentToManifest(manifestId, code);
    if (result.error) failed.push({ id, error: result.error });
    else added += 1;
  }

  const notice = added
    ? `${added} paquete${added === 1 ? "" : "s"} agregado${added === 1 ? "" : "s"} a la ruta.${
        failed.length ? ` ${failed.length} no se pudo agregar.` : ""
      }`
    : undefined;
  return { notice, error: added ? undefined : failed[0]?.error, added, failed };
}

/**
 * Cierra una entrega al courier anotando quién recogió.
 *
 * Es el equivalente del segundo cotejo para las rutas sin motorizado: como nadie
 * del otro lado escanea, la única prueba de la entrega es el nombre de quien se
 * llevó las cajas. El servidor vuelve a comprobar el 100 % del cotejo de oficina
 * dentro de la misma transacción que mueve la custodia.
 */
export async function handOverToCourier(
  manifestId: string,
  receivedBy: string,
  details?: { driverCount?: number },
): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("dispatch.manage")) return { error: "No tienes permiso para cerrar rutas." };
  const name = receivedBy.trim();
  if (name.length < 3) return { error: "Escribe el nombre de quien recoge." };
  const driverCount = details?.driverCount;
  if (driverCount !== undefined && (!Number.isInteger(driverCount) || driverCount < 0 || driverCount > 999)) {
    return { error: "El conteo de cajas no es válido." };
  }
  const manifest = await visibleManifest(manifestId);
  if (!manifest) return { error: "Ruta no encontrada o sin acceso." };
  if (needsRiderCheck(manifest.kind)) {
    return { error: "Esta ruta la cierra el cotejo del motorizado." };
  }
  if (["in_custody", "cancelled"].includes(manifest.state)) return { error: "Esa ruta ya está cerrada." };

  const { user } = await currentUser();
  const admin = createAdminSupabase();
  const commercialBlock = await legacySaleManifestBlock(admin, manifestId);
  if (commercialBlock) return { error: commercialBlock };
  const { error: nameError } = await admin
    .from("dispatch_manifests")
    .update({ received_by: name })
    .eq("id", manifestId);
  if (nameError) return { error: nameError.message };

  const { data: orderIds, error } = await admin.rpc("finalize_dispatch_manifest", {
    p_manifest_id: manifestId,
    p_actor: user.id,
  });
  if (error) return { error: error.message };
  await recomputeOrderMasterSafe(admin, (orderIds ?? []) as string[]);
  await auditDispatch({
    orgId: manifest.org_id,
    manifestId,
    actor: user.id,
    kind: "handed_to_courier",
    payload: driverCount !== undefined ? { received_by: name, driver_count: driverCount } : { received_by: name },
  });
  revalidatePath(DISPATCH_PATH);
  revalidatePath("/dashboard/pedidos");
  return { notice: `Entrega cerrada: ${name} recogió los paquetes.` };
}

export async function scanManifestItem(
  manifestId: string,
  code: string,
  stage: DispatchScanStage,
): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  const needed = stage === "office" ? "dispatch.manage" : "dispatch.pickup";
  if (!perms.can(needed)) return { error: "No tienes permiso para realizar este cotejo." };
  // Una autenticación por lectura, compartida solo dentro de esta operación.
  // Las búsquedas conservan el cliente del usuario y sus políticas RLS.
  const auth = await currentUser();
  const { user } = auth;
  const [manifest, scan] = await Promise.all([visibleManifest(manifestId, auth), findScanCandidates(code, auth)]);
  if (!manifest) return { error: "Ruta no encontrada o sin acceso." };
  const candidates = scan.candidates;
  if (!candidates.length) return { error: SCAN_NOT_FOUND };
  // Antes que «no pertenece a esta ruta»: si el pedido está anulado, eso es lo
  // que decide, esté o no en la ruta (#AUR177767, 05-10-2026).
  const cancelledCheck = await cancelledScanNotice(createAdminSupabase(), candidates[0]!.order_id);
  if (cancelledCheck) return { error: cancelledCheck };
  if (scan.hold) return { error: scan.hold };
  if (manifest.state === "cancelled") return { error: "Esa ruta ya está cerrada." };
  // Sin verificación previa del motorizado (modos confirmar y ninguno, 0185),
  // un cotejo sobre una caja ya en custodia es un registro opcional, no un error.
  const optionalCheck = manifest.state === "in_custody" && courierKey(manifest.courier) === "propio"
    && (await riderPickupMode(createAdminSupabase(), manifest.org_id)) !== "exigir";
  if (manifest.state === "in_custody" && !optionalCheck) return { error: "Esa ruta ya está cerrada." };
  if (stage === "pickup" && !needsRiderCheck(manifest.kind)) {
    return { error: "Esta ruta no tiene motorizado que coteje: se cierra anotando quién recoge." };
  }
  const admin = createAdminSupabase();
  // Cotejar es confirmar lo que entra a ESTA ruta: si el escaneo trae el número
  // de pedido, la salida que corresponde es la que ya está en el manifiesto.
  const { data: rows } = await admin
    .from("dispatch_manifest_items")
    .select("*")
    .eq("manifest_id", manifestId)
    .in("shipment_id", candidates.map((candidate) => candidate.id))
    .is("removed_at", null);
  const inRoute = new Set((rows ?? []).map((row) => row.shipment_id as string));
  const pick = pickDispatchScanTarget(candidates, (candidate) => inRoute.has(candidate.id));
  if (pick.kind === "ambigua") return { error: ambiguousScanError(pick.options) };
  if (pick.kind === "ninguna") return { error: SCAN_NOT_FOUND };
  const shipment = pick.shipment;
  const item = (rows ?? []).find((row) => row.shipment_id === shipment.id);
  if (!item) {
    // Decir en qué caja está: «no pertenece a esta ruta» parecía que no
    // dejaba asignarlo (KP136825, 07-10-2026, `lib/scan-other-box.ts`).
    const { data: other } = await admin
      .from("dispatch_manifest_items")
      .select("dispatch_manifests!inner(courier,route_date,driver_name,received_by,state)")
      .eq("shipment_id", shipment.id)
      .is("removed_at", null)
      .neq("manifest_id", manifestId)
      .neq("dispatch_manifests.state", "cancelled")
      .limit(1)
      .maybeSingle();
    const raw = (other as { dispatch_manifests: unknown } | null)?.dispatch_manifests;
    const box = (Array.isArray(raw) ? raw[0] : raw) as
      | { courier: string; route_date: string; driver_name: string | null; received_by: string | null }
      | undefined;
    const here = { who: boxWho(manifest, courierLabelFor(manifest.courier)), routeDate: manifest.route_date };
    const elsewhere = box ? { who: boxWho(box, courierLabelFor(box.courier)), routeDate: box.route_date } : null;
    // El rótulo viejo de Tanders sobre la caja que volvió (#AUR177756): si su
    // salida nueva está en esta caja, se nombra; no coteja por ella (§29.4).
    const oldLabel = box ? null : await oldLabelError(shipment, "caja", manifestId);
    return { error: oldLabel ?? notInThisBoxMessage(here, elsewhere) };
  }

  if (stage === "pickup") {
    const { data: all } = await admin
      .from("dispatch_manifest_items")
      .select("office_checked_at,removed_at")
      .eq("manifest_id", manifestId);
    const active = (all ?? []).filter((row) => !row.removed_at);
    if (!active.length || active.some((row) => !row.office_checked_at)) {
      return { error: "Primero completa el 100 % del cotejo de oficina." };
    }
  }

  const checkedAtColumn = stage === "office" ? "office_checked_at" : "pickup_checked_at";
  const checkedByColumn = stage === "office" ? "office_checked_by" : "pickup_checked_by";
  if (item[checkedAtColumn]) return { notice: "Ese paquete ya estaba cotejado.", shipment };
  const { error } = await admin
    .from("dispatch_manifest_items")
    .update({ [checkedAtColumn]: new Date().toISOString(), [checkedByColumn]: user.id })
    .eq("id", item.id);
  if (error) return { error: error.message };

  // Cotejar en oficina es ver la caja entrar: si almacén no alcanzó a
  // escanearla, ese escaneo ya no va a llegar nunca. Sin esto el paquete se
  // despachaba arrastrando un «por armar» que nadie iba a corregir.
  if (stage === "office" && shipment.preparation_state !== "listo_despacho") {
    await admin
      .from("shipments")
      .update({ preparation_state: "listo_despacho", ready_at: new Date().toISOString(), ready_by: user.id })
      .eq("id", shipment.id)
      .eq("custody_state", "empresa");
  }

  const state = optionalCheck ? ("in_custody" as DispatchManifestState) : await recalculateManifest(manifestId, user.id);
  await auditDispatch({
    orgId: manifest.org_id,
    manifestId,
    shipment,
    actor: user.id,
    kind: stage === "office" ? "office_checked" : "pickup_checked",
    orderNote: stage === "office" ? "Paquete cotejado por el equipo de despacho." : "Paquete cotejado por el motorizado.",
  });

  let notice = stage === "office" ? "Paquete cotejado por oficina." : "Paquete recibido por el motorizado.";
  if (optionalCheck) notice += " (registro opcional: la caja ya estaba en poder del motorizado)";
  if (stage === "pickup" && state === "pickup_check") {
    const { data: remaining } = await admin
      .from("dispatch_manifest_items")
      .select("pickup_checked_at,removed_at")
      .eq("manifest_id", manifestId);
    const active = (remaining ?? []).filter((row) => !row.removed_at);
    if (active.length && active.every((row) => !!row.pickup_checked_at)) {
      const commercialBlock = await legacySaleManifestBlock(admin, manifestId);
      if (commercialBlock) return { error: commercialBlock };
      const { data: orderIds, error: finalizeError } = await admin.rpc("finalize_dispatch_manifest", {
        p_manifest_id: manifestId,
        p_actor: user.id,
      });
      if (finalizeError) return { error: finalizeError.message };
      await recomputeOrderMasterSafe(admin, (orderIds ?? []) as string[]);
      notice = `Ruta completada: el courier recibió ${active.length} paquete${active.length === 1 ? "" : "s"}.`;
    }
  }
  revalidatePath(DISPATCH_PATH);
  revalidatePath("/dashboard/pedidos");
  return { notice, shipment };
}

export async function removeManifestItem(
  manifestId: string,
  shipmentId: string,
  reason: string,
): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("dispatch.manage")) return { error: "No tienes permiso para modificar rutas." };
  const cleanReason = reason.trim();
  if (cleanReason.length < 3) return { error: "Escribe el motivo del retiro." };
  const manifest = await visibleManifest(manifestId);
  if (!manifest) return { error: "Ruta no encontrada o sin acceso." };
  if (manifest.state === "cancelled") return { error: "Esa ruta ya está cerrada." };
  const admin = createAdminSupabase();
  // Caja en custodia: solo en modo «confirmar» (0185) y solo lo que el
  // motorizado no confirmó. El RPC retira, borra la parada pendiente, devuelve
  // la custodia a la empresa y deja el rastro; aquí no se toca nada más.
  const inCustody = manifest.state === "in_custody";
  if (inCustody && (courierKey(manifest.courier) !== "propio" || (await riderPickupMode(admin, manifest.org_id)) !== "confirmar")) {
    return { error: "Esa ruta ya está cerrada." };
  }
  const { data: shipment } = await admin
    .from("shipments")
    .select(DISPATCH_SHIPMENT_COLUMNS)
    .eq("id", shipmentId)
    .maybeSingle();
  if (!shipment) return { error: "Paquete no encontrado." };
  const { user } = await currentUser();
  if (inCustody) {
    const { data: orderId, error } = await admin.rpc("gf_supervisor_withdraw", { p_manifest_id: manifestId, p_shipment_id: shipmentId, p_reason: cleanReason, p_actor: user.id, p_moved_to_rider: null });
    if (error) return { error: error.message };
    if (orderId) await recomputeOrderMasterSafe(admin, [orderId as string]);
    revalidatePath(DISPATCH_PATH);
    for (const path of ["/dashboard/courier", "/dashboard/courier/rutas", "/reparto"]) revalidatePath(path);
    return { notice: "Paquete retirado de la caja sin confirmar: vuelve a «por asignar»." };
  }
  const { error } = await admin
    .from("dispatch_manifest_items")
    .update({ removed_at: new Date().toISOString(), removed_by: user.id, removal_reason: cleanReason })
    .eq("manifest_id", manifestId)
    .eq("shipment_id", shipmentId)
    .is("removed_at", null);
  if (error) return { error: error.message };
  // Fuera de la caja, la solicitud de Grupo GF vuelve a «por asignar», como en
  // los retiros en custodia (0185) y los no recogidos (0182). Sin esto quedaba
  // «scheduled» sin caja: #KP136039, #KP136010, #KP135989, #KP137239 y
  // #KP137430 (23 y 28-09-2026, reparados en 0200).
  const { data: reverted } = await admin
    .from("logistics_requests")
    .update({ status: "accepted", observation: cleanReason.slice(0, 300) })
    .eq("shipment_id", shipmentId)
    .eq("status", "scheduled")
    .select("id");
  if (reverted?.length) {
    await admin.from("logistics_request_events").insert((reverted as { id: string }[]).map((request) => ({
      request_id: request.id,
      kind: "route_removed",
      status: "accepted",
      actor: user.id,
      note: `Retirado de la caja: ${cleanReason}`,
      payload: { manifestId },
    })));
  }
  await recalculateManifest(manifestId, user.id);
  await auditDispatch({
    orgId: manifest.org_id,
    manifestId,
    shipment: shipment as unknown as DispatchShipment,
    actor: user.id,
    kind: "package_removed",
    payload: { reason: cleanReason },
    orderNote: `Paquete retirado de la ruta: ${cleanReason}`,
  });
  // 0196: retirar la diferencia que no irá puede dejar la caja completa —todo
  // lo que queda cotejado por oficina y recibido por el motorizado—. Sin esto
  // nadie pasaba la custodia y la ruta del motorizado no aparecía.
  const completed = await finalizeBoxIfComplete(admin, manifestId, user.id);
  revalidatePath(DISPATCH_PATH);
  return {
    notice: completed
      ? "Paquete retirado. Con eso la caja quedó completa y pasó al motorizado."
      : "Paquete retirado expresamente de la ruta.",
  };
}

/**
 * Pasa la custodia de una caja de Grupo GF si ya está completa (0196). No hace
 * nada con cualquier otra caja. Un fallo aquí no deshace el retiro, que ya
 * quedó hecho: se avisa en el registro y la caja se cierra con el siguiente
 * escaneo del motorizado.
 */
async function finalizeBoxIfComplete(
  admin: ReturnType<typeof createAdminSupabase>,
  manifestId: string,
  actor: string,
): Promise<boolean> {
  const commercialBlock = await legacySaleManifestBlock(admin, manifestId);
  if (commercialBlock) {
    console.error("[despacho] caja sin finalizar", commercialBlock);
    return false;
  }
  const { data, error } = await admin.rpc("gf_finalize_if_complete", { p_manifest_id: manifestId, p_actor: actor });
  if (error) {
    console.error("[despacho] no se pudo cerrar la caja completa", error.message);
    return false;
  }
  const orderIds = (data ?? []) as string[];
  if (!orderIds.length) return false;
  await recomputeOrderMasterSafe(admin, orderIds);
  return true;
}

export async function cancelDispatchManifest(manifestId: string, reason: string): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("dispatch.manage")) return { error: "No tienes permiso para cancelar rutas." };
  const cleanReason = reason.trim();
  if (cleanReason.length < 3) return { error: "Escribe el motivo de cancelación." };
  const manifest = await visibleManifest(manifestId);
  if (!manifest) return { error: "Ruta no encontrada o sin acceso." };
  if (manifest.state === "in_custody") return { error: "La ruta ya transfirió custodia y no puede cancelarse." };
  const { user } = await currentUser();
  const admin = createAdminSupabase();
  const now = new Date().toISOString();
  await admin.from("dispatch_manifest_items").update({
    removed_at: now, removed_by: user.id, removal_reason: `Ruta cancelada: ${cleanReason}`,
  }).eq("manifest_id", manifestId).is("removed_at", null);
  const { error } = await admin.from("dispatch_manifests").update({
    state: "cancelled", cancelled_at: now, cancelled_by: user.id, cancellation_reason: cleanReason,
  }).eq("id", manifestId);
  if (error) return { error: error.message };
  await auditDispatch({ orgId: manifest.org_id, manifestId, actor: user.id, kind: "manifest_cancelled", payload: { reason: cleanReason } });
  revalidatePath(DISPATCH_PATH);
  return { notice: "Ruta cancelada; sus paquetes quedaron libres para otra ruta." };
}

// ---------------------------------------------------------------------------
// Entrega a Swayp · Lima (fase 3, owner 04-11-2026; MOM §9.1)
//
// Swayp recoge las cajas de Lima hacia las 07:00 del día de despacho (E1). La
// entrega es una ruta `entrega_courier` por día (un solo cotejo, caja por caja
// delante del chofer, y se cierra con su nombre y su conteo: E2). Manda lo
// cargado en Swayp (E3): nada de aquí cambia el estado que reporta Swayp; el
// cierre solo pone la custodia que Swayp ya dio, con la persona y la hora
// reales. Lo que no sale lleva motivo y explicación (E4). Las reglas puras
// están en lib/swayp-handover.ts.
// ---------------------------------------------------------------------------

const SWAYP_LOT_COLUMNS =
  "id,store_id,order_id,courier,output_code,guide_code,swayp_state,custody_state,custody_transferred_by," +
  "next_followup_at,preparation_state,delivery_status,status_category";

interface SwaypLotShipment extends SwaypHandoverShipment {
  id: string;
  store_id: string;
  order_id: string | null;
  preparation_state: string | null;
  delivery_status: string | null;
  status_category: string | null;
}

type SwaypHandoverResult = DispatchActionResult & { manifestId?: string };

interface SwaypHandoverContext {
  user: { id: string };
  orgId: string;
  today: string;
}

/** Permiso, organización y día: la entrega es siempre la de HOY en Lima, y solo si hoy Swayp despacha. */
async function swaypHandoverContext(): Promise<SwaypHandoverContext | { error: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("dispatch.manage")) return { error: "No tienes permiso para entregar cajas a Swayp." };
  const today = limaClock(new Date()).day;
  if (!isSwaypDispatchDay(today)) return { error: SWAYP_HANDOVER_NOT_DISPATCH_DAY };
  const { sb, user } = await currentUser();
  const { data: store } = await sb.from("stores").select("org_id").limit(1).maybeSingle();
  if (!store?.org_id) return { error: "No tienes una organización disponible." };
  return { user, orgId: store.org_id as string, today };
}

/** La entrega abierta de hoy, con las mismas comprobaciones en cada acción. */
async function openSwaypManifest(
  ctx: SwaypHandoverContext,
  manifestId: string,
): Promise<DispatchManifest | { error: string }> {
  const manifest = await visibleManifest(manifestId);
  if (!manifest || manifest.org_id !== ctx.orgId || courierKey(manifest.courier) !== "fenix") return { error: SWAYP_HANDOVER_NOT_FOUND };
  if (manifest.route_date !== ctx.today) return { error: "Esa entrega no es la de hoy." };
  if (manifest.state === "in_custody") return { error: SWAYP_HANDOVER_CLOSED };
  if (manifest.state === "cancelled") return { error: SWAYP_HANDOVER_NO_VINO_DONE };
  return manifest;
}

/**
 * El lote de Lima del día: las guías Swayp vivas con ese día de despacho, de
 * todas las tiendas de la organización (misma regla que «Swayp por salir»:
 * operación `lima`, sin motivo de salida, y que Swayp no haya cerrado).
 */
async function swaypHandoverLot(orgId: string, day: string): Promise<SwaypLotShipment[]> {
  const admin = createAdminSupabase();
  const { data: stores } = await admin.from("stores").select("id").eq("org_id", orgId);
  const storeIds = ((stores ?? []) as { id: string }[]).map((store) => store.id);
  if (!storeIds.length) return [];
  const { data: rows } = await admin
    .from("shipments")
    .select(SWAYP_LOT_COLUMNS)
    .in("store_id", storeIds)
    .eq("courier", "fenix")
    .gte("next_followup_at", `${day}T00:00:00.000Z`)
    .lt("next_followup_at", `${nextDay(day)}T00:00:00.000Z`);
  const shipments = (rows ?? []) as unknown as SwaypLotShipment[];
  const orderIds = [...new Set(shipments.map((s) => s.order_id).filter((id): id is string => Boolean(id)))];
  if (!orderIds.length) return [];
  const [{ data: masters }, { data: cancelled }] = await Promise.all([
    admin.from("order_master").select("order_id,macro_operation,general_status").in("order_id", orderIds),
    admin.from("orders").select("id,cancelled_at").in("id", orderIds).not("cancelled_at", "is", null),
  ]);
  const cancelledAt = new Map(((cancelled ?? []) as { id: string; cancelled_at: string | null }[]).map((o) => [o.id, o.cancelled_at]));
  const master = new Map(
    ((masters ?? []) as { order_id: string; macro_operation: string | null; general_status: string | null }[]).map((m) => [m.order_id, m]),
  );
  return shipments.filter((s) => {
    const order = s.order_id ? master.get(s.order_id) : undefined;
    if (order?.macro_operation !== "lima") return false;
    if (swaypExitReason(s, { general_status: order.general_status, cancelled_at: s.order_id ? cancelledAt.get(s.order_id) ?? null : null })) return false;
    return swaypHandoverVerdict(s, { day, operation: "lima", courierLabel: "Swayp", dayLabelOf: swaypDayLabel }).ok;
  });
}

interface SwaypItemRow {
  id: string;
  shipment_id: string;
  store_id: string;
  office_checked_at: string | null;
  removed_at: string | null;
}

async function swaypItemRows(manifestId: string): Promise<SwaypItemRow[]> {
  const { data } = await createAdminSupabase()
    .from("dispatch_manifest_items")
    .select("id,shipment_id,store_id,office_checked_at,removed_at")
    .eq("manifest_id", manifestId);
  return (data ?? []) as SwaypItemRow[];
}

/**
 * Agrega a la entrega las guías del lote que todavía no tienen fila. Una que
 * se marcó «No sale» conserva su fila (y su motivo): no se vuelve a meter sola.
 * Devuelve los códigos agregados.
 */
async function reconcileSwaypHandover(manifestId: string, orgId: string, day: string, actor: string): Promise<string[]> {
  const admin = createAdminSupabase();
  const [lot, rows] = await Promise.all([swaypHandoverLot(orgId, day), swaypItemRows(manifestId)]);
  const known = new Set(rows.map((row) => row.shipment_id));
  const missing = lot.filter((s) => !known.has(s.id));
  if (!missing.length) return [];
  // Una salida activa en otra ruta no se mueve sola: se dice al escanearla.
  const { data: elsewhere } = await admin
    .from("dispatch_manifest_items")
    .select("shipment_id")
    .in("shipment_id", missing.map((s) => s.id))
    .is("removed_at", null)
    .neq("manifest_id", manifestId);
  const busy = new Set(((elsewhere ?? []) as { shipment_id: string }[]).map((row) => row.shipment_id));
  const candidates = missing.filter((s) => !busy.has(s.id));
  // De a una: si otra pestaña agregó alguna al mismo tiempo (índice único de
  // salida activa), esa se salta y las demás entran igual.
  const added: SwaypLotShipment[] = [];
  for (const s of candidates) {
    const { error } = await admin
      .from("dispatch_manifest_items")
      .insert({ manifest_id: manifestId, shipment_id: s.id, store_id: s.store_id, added_by: actor });
    if (!error) added.push(s);
    else if (error.code !== "23505") throw new Error(error.message);
  }
  if (!added.length) return [];
  await admin.from("dispatch_events").insert({
    org_id: orgId,
    manifest_id: manifestId,
    actor,
    kind: "package_added",
    payload: { swayp_handover: true, shipments: added.map((s) => s.output_code ?? s.guide_code) },
  });
  return added.map((s) => s.output_code ?? s.guide_code ?? s.id);
}

/**
 * Una entrega de un día anterior que nadie cerró (ni marcó «Swayp no vino")
 * dejaría sus filas activas y trabaría las de hoy: se cancela sola, con su
 * motivo, y sus cajas quedan libres (revisión del 04-11-2026).
 */
async function releaseStaleSwaypHandovers(orgId: string, today: string, actor: string): Promise<void> {
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("dispatch_manifests")
    .select("id,route_date")
    .eq("org_id", orgId)
    .is("rider_id", null)
    .ilike("courier", "fenix")
    .lt("route_date", today)
    .not("state", "in", "(in_custody,cancelled)");
  for (const stale of (data ?? []) as { id: string; route_date: string }[]) {
    const reason = SWAYP_HANDOVER_STALE_REASON(swaypDayLabel(stale.route_date));
    const now = new Date().toISOString();
    await admin
      .from("dispatch_manifest_items")
      .update({ removed_at: now, removed_by: actor, removal_reason: `Ruta cancelada: ${reason}` })
      .eq("manifest_id", stale.id)
      .is("removed_at", null);
    await admin
      .from("dispatch_manifests")
      .update({ state: "cancelled", cancelled_at: now, cancelled_by: actor, cancellation_reason: reason })
      .eq("id", stale.id);
    await auditDispatch({ orgId, manifestId: stale.id, actor, kind: "manifest_cancelled", payload: { reason, swayp_handover: true, auto: true } });
  }
}

/**
 * Abre (o retoma) la entrega a Swayp de hoy y la concilia con el lote. Es
 * idempotente: se puede llamar cada vez que se abre el panel.
 */
export async function openSwaypHandover(): Promise<SwaypHandoverResult> {
  const ctx = await swaypHandoverContext();
  if ("error" in ctx) return ctx;
  await releaseStaleSwaypHandovers(ctx.orgId, ctx.today, ctx.user.id);
  const admin = createAdminSupabase();
  const { data: existing } = await admin
    .from("dispatch_manifests")
    .select("id,state,cancellation_reason")
    .eq("org_id", ctx.orgId)
    .eq("route_date", ctx.today)
    .is("rider_id", null)
    .ilike("courier", "fenix")
    .order("created_at", { ascending: false });
  const manifests = (existing ?? []) as { id: string; state: string; cancellation_reason: string | null }[];
  let current = manifests.find((m) => m.state !== "cancelled") ?? null;
  if (current?.state === "in_custody") return { error: SWAYP_HANDOVER_CLOSED, manifestId: current.id };
  if (!current && manifests.some((m) => m.cancellation_reason === SWAYP_NO_VINO_REASON)) return { error: SWAYP_HANDOVER_NO_VINO_DONE };

  if (!current) {
    const lot = await swaypHandoverLot(ctx.orgId, ctx.today);
    if (!lot.length) return { error: SWAYP_HANDOVER_EMPTY };
    const { data, error } = await admin
      .from("dispatch_manifests")
      .insert({
        org_id: ctx.orgId,
        courier: "fenix",
        kind: "entrega_courier",
        route_date: ctx.today,
        route_label: SWAYP_HANDOVER_ROUTE_LABEL,
        rider_id: null,
        driver_name: null,
        created_by: ctx.user.id,
      })
      .select("id,state")
      .single();
    if (error) {
      // Dos personas abrieron a la vez: la otra ya la creó (una ruta por courier y día, 0097).
      if (error.code !== "23505") return { error: error.message };
      const { data: again } = await admin
        .from("dispatch_manifests")
        .select("id,state")
        .eq("org_id", ctx.orgId)
        .eq("route_date", ctx.today)
        .is("rider_id", null)
        .ilike("courier", "fenix")
        .neq("state", "cancelled")
        .maybeSingle();
      if (!again) return { error: error.message };
      current = { id: again.id as string, state: again.state as string, cancellation_reason: null };
    } else {
      current = { id: data.id as string, state: data.state as string, cancellation_reason: null };
      await auditDispatch({
        orgId: ctx.orgId,
        manifestId: current.id,
        actor: ctx.user.id,
        kind: "manifest_created",
        payload: { courier: "fenix", routeDate: ctx.today, swayp_handover: true },
      });
    }
  }

  try {
    await reconcileSwaypHandover(current.id, ctx.orgId, ctx.today, ctx.user.id);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No pudimos armar la lista de la entrega.", manifestId: current.id };
  }
  await recalculateManifest(current.id, ctx.user.id);
  revalidatePath(WAREHOUSE_PATH);
  return { manifestId: current.id };
}

/** Marca escaneada una fila de la entrega y, si la caja no estaba armada, la arma (la custodia la puso Swayp o sigue en la empresa). */
async function checkSwaypItem(
  ctx: SwaypHandoverContext,
  manifest: DispatchManifest,
  itemId: string,
  shipment: DispatchShipment,
): Promise<string | null> {
  const admin = createAdminSupabase();
  const now = new Date().toISOString();
  const { error } = await admin
    .from("dispatch_manifest_items")
    .update({ office_checked_at: now, office_checked_by: ctx.user.id })
    .eq("id", itemId);
  if (error) return error.message;
  if (shipment.preparation_state !== "listo_despacho") {
    await admin
      .from("shipments")
      .update({ preparation_state: "listo_despacho", ready_at: now, ready_by: ctx.user.id })
      .eq("id", shipment.id)
      .eq("courier", "fenix")
      .in("custody_state", ["empresa", "courier"]);
  }
  await recalculateManifest(manifest.id, ctx.user.id);
  await auditDispatch({
    orgId: manifest.org_id,
    manifestId: manifest.id,
    shipment,
    actor: ctx.user.id,
    kind: "office_checked",
    payload: { swayp_handover: true },
    orderNote: SWAYP_HANDOVER_SCAN_NOTE,
  });
  if (shipment.order_id && shipment.preparation_state !== "listo_despacho") await recomputeOrderMasterSafe(admin, [shipment.order_id]);
  return null;
}

/**
 * El escaneo de la entrega: QR, rótulo, guía Swayp o número de pedido. Una caja
 * del lote que entró después de abrir se agrega en el mismo escaneo; una que se
 * había marcado «No sale» vuelve a la entrega. Lo que no es del lote no entra, y
 * el texto dice por qué.
 */
export async function scanSwaypHandover(manifestId: string, code: string): Promise<SwaypHandoverResult> {
  const ctx = await swaypHandoverContext();
  if ("error" in ctx) return ctx;
  const manifest = await openSwaypManifest(ctx, manifestId);
  if ("error" in manifest) return manifest;
  const scan = await findScanCandidates(code);
  if (!scan.candidates.length) return { error: SCAN_NOT_FOUND };
  const admin = createAdminSupabase();
  const cancelledCheck = await cancelledScanNotice(admin, scan.candidates[0]!.order_id);
  if (cancelledCheck) return { error: cancelledCheck };
  if (scan.hold) return { error: scan.hold };
  const rows = await swaypItemRows(manifestId);
  const byShipment = new Map(rows.map((row) => [row.shipment_id, row]));
  const pick = pickDispatchScanTarget(scan.candidates, (candidate) => byShipment.has(candidate.id));
  if (pick.kind === "ambigua") return { error: ambiguousScanError(pick.options) };
  if (pick.kind === "ninguna") return { error: SCAN_NOT_FOUND };
  const shipment = pick.shipment;
  const label = dispatchScanLabel(shipment);
  const item = byShipment.get(shipment.id);

  if (item?.office_checked_at && !item.removed_at) return { notice: SWAYP_HANDOVER_ALREADY(label), shipment, manifestId };

  // Si sigue siendo del lote de hoy: Swayp pudo cerrarla después de abrir la
  // entrega, y entonces no se arma ni se entrega (revisión del 04-11-2026).
  const { data: extra } = await admin.from("shipments").select(SWAYP_LOT_COLUMNS).eq("id", shipment.id).maybeSingle();
  if (!extra) return { error: SCAN_NOT_FOUND };
  const verdict = swaypHandoverVerdict(extra as unknown as SwaypLotShipment, {
    day: ctx.today,
    operation: await operationForOrder(shipment.order_id),
    courierLabel: courierLabelFor(shipment.courier),
    dayLabelOf: swaypDayLabel,
  });
  if (verdict.ok && item && !item.removed_at) {
    const failed = await checkSwaypItem(ctx, manifest, item.id, shipment);
    if (failed) return { error: failed };
    revalidatePath(WAREHOUSE_PATH);
    return { notice: SWAYP_HANDOVER_SCANNED(label), shipment, manifestId };
  }
  if (!verdict.ok) {
    // El rótulo viejo de la otra salida del pedido: se nombra la de Swayp (§29.4).
    const oldLabel = courierKey(shipment.courier) !== "fenix" ? await oldLabelError(shipment, "caja", manifestId) : null;
    return { error: oldLabel ?? verdict.error };
  }
  if (item) {
    const { error } = await admin
      .from("dispatch_manifest_items")
      .update({ removed_at: null, removed_by: null, removal_reason: null, office_checked_at: null, office_checked_by: null })
      .eq("id", item.id);
    if (error) return { error: error.message };
    const failed = await checkSwaypItem(ctx, manifest, item.id, shipment);
    if (failed) return { error: failed };
    revalidatePath(WAREHOUSE_PATH);
    return { notice: SWAYP_HANDOVER_RESTORED(label), shipment, manifestId };
  }
  const { data: elsewhere } = await admin
    .from("dispatch_manifest_items")
    .select("id")
    .eq("shipment_id", shipment.id)
    .is("removed_at", null)
    .limit(1);
  if (elsewhere?.length) return { error: SWAYP_HANDOVER_OTRA_RUTA };
  const { data: inserted, error } = await admin
    .from("dispatch_manifest_items")
    .insert({ manifest_id: manifestId, shipment_id: shipment.id, store_id: shipment.store_id, added_by: ctx.user.id })
    .select("id")
    .single();
  if (error) return { error: error.code === "23505" ? SWAYP_HANDOVER_OTRA_RUTA : error.message };
  const failed = await checkSwaypItem(ctx, manifest, inserted.id as string, shipment);
  if (failed) return { error: failed };
  revalidatePath(WAREHOUSE_PATH);
  return { notice: SWAYP_HANDOVER_SCANNED(label), shipment, manifestId };
}

async function swaypItemShipment(shipmentId: string): Promise<DispatchShipment | null> {
  const { data } = await createAdminSupabase().from("shipments").select(DISPATCH_SHIPMENT_COLUMNS).eq("id", shipmentId).maybeSingle();
  return (data as unknown as DispatchShipment | null) ?? null;
}

/** «No sale»: la caja se queda en la oficina con su motivo y su explicación (E4). */
export async function markSwaypNoSale(
  manifestId: string,
  shipmentId: string,
  reasonCode: string,
  detail: string,
): Promise<SwaypHandoverResult> {
  const invalid = swaypNoSaleError(reasonCode, detail);
  if (invalid) return { error: invalid };
  const ctx = await swaypHandoverContext();
  if ("error" in ctx) return ctx;
  const manifest = await openSwaypManifest(ctx, manifestId);
  if ("error" in manifest) return manifest;
  const item = (await swaypItemRows(manifestId)).find((row) => row.shipment_id === shipmentId && !row.removed_at);
  if (!item) return { error: "Esa caja no está en la entrega de hoy." };
  const shipment = await swaypItemShipment(shipmentId);
  if (!shipment) return { error: "Paquete no encontrado." };
  const text = swaypNoSaleText(reasonCode as SwaypNoSaleCode, detail);
  const admin = createAdminSupabase();
  const { error } = await admin
    .from("dispatch_manifest_items")
    .update({
      removed_at: new Date().toISOString(),
      removed_by: ctx.user.id,
      removal_reason: text,
      office_checked_at: null,
      office_checked_by: null,
    })
    .eq("id", item.id);
  if (error) return { error: error.message };
  await recalculateManifest(manifestId, ctx.user.id);
  await auditDispatch({
    orgId: manifest.org_id,
    manifestId,
    shipment,
    actor: ctx.user.id,
    kind: "package_removed",
    payload: { reason: text, reason_code: reasonCode, detail: detail.trim() || null, swayp_handover: true },
    orderNote: swaypNoSaleNote(text),
  });
  revalidatePath(WAREHOUSE_PATH);
  return { notice: SWAYP_NO_SALE_DONE(dispatchScanLabel(shipment)), shipment, manifestId };
}

/** Deshace un «No sale» antes de cerrar: la caja vuelve a «por entregar» (si Swayp no la cerró entretanto). */
export async function undoSwaypNoSale(manifestId: string, shipmentId: string): Promise<SwaypHandoverResult> {
  const ctx = await swaypHandoverContext();
  if ("error" in ctx) return ctx;
  const manifest = await openSwaypManifest(ctx, manifestId);
  if ("error" in manifest) return manifest;
  const item = (await swaypItemRows(manifestId)).find((row) => row.shipment_id === shipmentId && row.removed_at);
  if (!item) return { error: "Esa caja no está marcada «No sale»." };
  const admin = createAdminSupabase();
  const { data: extra } = await admin.from("shipments").select(SWAYP_LOT_COLUMNS).eq("id", shipmentId).maybeSingle();
  const shipment = await swaypItemShipment(shipmentId);
  if (!extra || !shipment) return { error: "Paquete no encontrado." };
  const verdict = swaypHandoverVerdict(extra as unknown as SwaypLotShipment, {
    day: ctx.today,
    operation: await operationForOrder(shipment.order_id),
    courierLabel: courierLabelFor(shipment.courier),
    dayLabelOf: swaypDayLabel,
  });
  if (!verdict.ok) return { error: verdict.error };
  const { error } = await admin
    .from("dispatch_manifest_items")
    .update({ removed_at: null, removed_by: null, removal_reason: null })
    .eq("id", item.id);
  if (error) return { error: error.code === "23505" ? SWAYP_HANDOVER_OTRA_RUTA : error.message };
  await recalculateManifest(manifestId, ctx.user.id);
  await auditDispatch({
    orgId: manifest.org_id,
    manifestId,
    shipment,
    actor: ctx.user.id,
    kind: "package_added",
    payload: { swayp_handover: true, undo_no_sale: true },
    orderNote: "Vuelve a la entrega a Swayp: se deshizo el «No sale».",
  });
  revalidatePath(WAREHOUSE_PATH);
  return { notice: SWAYP_HANDOVER_UNDONE(dispatchScanLabel(shipment)), shipment, manifestId };
}

/**
 * Cierra la entrega con el nombre del chofer y su conteo (E2). Antes vuelve a
 * leer el lote (una guía que entró después de abrir no se queda fuera sin que
 * nadie la vea) y retira con motivo lo que Swayp cerró entretanto, para que el
 * cierre nunca pise una custodia `retorno`.
 */
export async function closeSwaypHandover(
  manifestId: string,
  driverName: string,
  driverCount: number,
): Promise<SwaypHandoverResult> {
  const ctx = await swaypHandoverContext();
  if ("error" in ctx) return ctx;
  await releaseStaleSwaypHandovers(ctx.orgId, ctx.today, ctx.user.id);
  const manifest = await openSwaypManifest(ctx, manifestId);
  if ("error" in manifest) return manifest;
  const admin = createAdminSupabase();
  const [lot, rows] = await Promise.all([swaypHandoverLot(ctx.orgId, ctx.today), swaypItemRows(manifestId)]);
  const known = new Set(rows.map((row) => row.shipment_id));
  const newInLot = lot.filter((s) => !known.has(s.id)).map((s) => s.output_code ?? s.guide_code ?? s.id);

  const active = rows.filter((row) => !row.removed_at);
  if (active.length) {
    const { data: current } = await admin.from("shipments").select(SWAYP_LOT_COLUMNS).in("id", active.map((row) => row.shipment_id));
    for (const s of (current ?? []) as unknown as SwaypLotShipment[]) {
      const closed = (s.swayp_state != null && SWAYP_HANDOVER_CLOSED_STATES.has(s.swayp_state))
        || s.custody_state === "retorno" || s.custody_state === "devuelto";
      if (!closed) continue;
      const row = active.find((r) => r.shipment_id === s.id)!;
      const text = SWAYP_NO_SALE_AUTO_CLOSED(swaypStateName(s.swayp_state));
      await admin
        .from("dispatch_manifest_items")
        .update({ removed_at: new Date().toISOString(), removed_by: ctx.user.id, removal_reason: text, office_checked_at: null, office_checked_by: null })
        .eq("id", row.id);
      const shipment = await swaypItemShipment(s.id);
      await auditDispatch({
        orgId: manifest.org_id,
        manifestId,
        shipment,
        actor: ctx.user.id,
        kind: "package_removed",
        payload: { reason: text, reason_code: "otro", swayp_handover: true, auto: true },
        orderNote: swaypNoSaleNote(text),
      });
      row.removed_at = "now";
    }
  }
  const stillActive = rows.filter((row) => !row.removed_at);
  const scanned = stillActive.filter((row) => row.office_checked_at).length;
  const invalid = swaypCloseError({ newInLot, active: stillActive.length, scanned, driverName, driverCount });
  if (invalid) {
    await recalculateManifest(manifestId, ctx.user.id);
    return { error: invalid };
  }
  await recalculateManifest(manifestId, ctx.user.id);
  const closed = await handOverToCourier(manifestId, driverName.trim(), { driverCount });
  if (closed.error) return closed;
  revalidatePath(WAREHOUSE_PATH);
  return { notice: closed.notice, manifestId };
}

/** «Swayp no vino»: la entrega del día se cancela con ese motivo y las cajas se quedan en la oficina. */
export async function markSwaypNoVino(manifestId: string): Promise<SwaypHandoverResult> {
  const ctx = await swaypHandoverContext();
  if ("error" in ctx) return ctx;
  const manifest = await openSwaypManifest(ctx, manifestId);
  if ("error" in manifest) return manifest;
  const result = await cancelDispatchManifest(manifestId, SWAYP_NO_VINO_REASON);
  if (result.error) return result;
  revalidatePath(WAREHOUSE_PATH);
  return { notice: SWAYP_NO_VINO_REASON + ": las cajas se quedan en la oficina.", manifestId };
}
