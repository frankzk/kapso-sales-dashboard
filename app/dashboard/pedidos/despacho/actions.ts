"use server";

import { cancelledScanNotice } from "@/lib/scan-cancelled";
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
import { decideReception } from "@/lib/returns-reception";
import { gfReturnDecision } from "@/lib/gf-returns-scan";
import { boxWho, notInThisBoxMessage, oldLabelHint } from "@/lib/scan-other-box";
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
}

async function currentUser() {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  return { sb, user };
}

function outputCodeCandidate(value: string): string | null {
  const match = value.toUpperCase().match(/^(.+-S\d{2})(?:-.+)?$/);
  return match?.[1] ?? null;
}

/** Sólo letras, números y guiones: lo que un Code 39 puede llevar como pedido. */
const ORDER_NAME_SCAN = /^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/;

/**
 * Devuelve TODAS las salidas que un escaneo puede estar designando. El QR, el
 * código de salida y la guía identifican una caja concreta; el código de barras
 * del rótulo lleva el número de pedido (MOM §4), que puede tener varias salidas.
 * Quien llama decide con `pickDispatchScanTarget` cuál corresponde a su tarea.
 */
async function findScanCandidates(rawCode: string, auth?: Awaited<ReturnType<typeof currentUser>>): Promise<DispatchShipment[]> {
  const code = normalizeDispatchScan(rawCode);
  if (!code) return [];
  const { sb } = auth ?? await currentUser();
  const attempts: Array<{ column: string; value: string }> = [];
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(code)) {
    attempts.push({ column: "qr_token", value: code });
  }
  const outputCode = outputCodeCandidate(code);
  if (outputCode) attempts.push({ column: "output_code", value: outputCode });
  attempts.push({ column: "guide_code", value: code });

  for (const attempt of attempts) {
    const query = sb.from("shipments").select(DISPATCH_SHIPMENT_COLUMNS).limit(2);
    const { data } = attempt.column === "qr_token"
      ? await query.eq(attempt.column, attempt.value)
      : await query.ilike(attempt.column, attempt.value.replace(/[%_]/g, "\\$&"));
    if (data?.length === 1) return [data[0] as unknown as DispatchShipment];
  }

  // El rótulo imprime `#KP126875`; el lector entrega `KP126875`. Aceptamos ambas.
  if (ORDER_NAME_SCAN.test(code)) {
    const { data } = await sb
      .from("shipments")
      .select(DISPATCH_SHIPMENT_COLUMNS)
      .or(`order_name.ilike.${code},order_name.ilike.#${code}`)
      .limit(10);
    if (data?.length) return data as unknown as DispatchShipment[];
  }
  return [];
}

const SCAN_NOT_FOUND = "No encontramos una salida con ese QR, guía o número de pedido.";

function ambiguousScanError(options: DispatchShipment[]): string {
  const codes = options.map(dispatchScanLabel).join(", ");
  return `Ese pedido tiene ${options.length} salidas (${codes}). Escanea el QR o el código de la salida.`;
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

export async function lookupDispatchShipment(code: string): Promise<DispatchActionResult> {
  const pick = pickDispatchScanTarget(await findScanCandidates(code));
  if (pick.kind === "ambigua") return { error: ambiguousScanError(pick.options) };
  return pick.kind === "unica" ? { shipment: pick.shipment } : { error: SCAN_NOT_FOUND };
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
  const { data } = await admin
    .from("shipments")
    .select("id,courier,output_code,output_number,created_at,custody_state,delivery_status,reported_status,swayp_state,dispatched_at,returned_at")
    .eq("order_id", shipment.order_id);
  const outputs = (data ?? []) as unknown as OutputForDecision[];
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
  return oldLabelHint(shipment.id, outputs, where, inThisBox);
}

export async function markShipmentReady(code: string): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("warehouse.prepare")) return { error: "No tienes permiso para preparar paquetes." };
  // Quien arma busca lo que le falta armar: entre las salidas del pedido, esa es
  // la preferencia que desempata cuando el escaneo trae el número de pedido.
  const pick = pickDispatchScanTarget(
    await findScanCandidates(code),
    (candidate) => candidate.custody_state === "empresa" && candidate.preparation_state !== "listo_despacho",
  );
  if (pick.kind === "ninguna") return { error: SCAN_NOT_FOUND };
  if (pick.kind === "ambigua") return { error: ambiguousScanError(pick.options) };
  const shipment = pick.shipment;
  // Un pedido anulado no se arma: lo primero que hay que decir (lib/scan-cancelled.ts).
  const cancelledReady = await cancelledScanNotice(createAdminSupabase(), shipment.order_id);
  if (cancelledReady) return { error: cancelledReady };
  if (shipment.custody_state !== "empresa") {
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
  const pick = pickDispatchScanTarget(
    await findScanCandidates(code),
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
    admin
      .from("order_events")
      .select("id")
      .eq("shipment_id", shipment.id)
      .eq("kind", "return_received")
      .limit(1),
  ]);
  if (!guide) return { error: SCAN_NOT_FOUND };
  const decision = decideReception(
    guide as { delivery_status: string; custody_state: string | null; returned_at: string | null },
    Boolean(received?.length),
  );
  if (!decision.ok) {
    // «Ya recibida» no es un error de quien escanea: es la caja que pasó dos
    // veces por el lector. Se avisa sin alarma.
    return decision.reason === "ya_recibida"
      ? { notice: `${dispatchScanLabel(shipment)}: ${decision.message}`, shipment }
      : { error: `${dispatchScanLabel(shipment)}: ${decision.message}` };
  }

  const { user } = await currentUser();
  const orgId = await orgForStore(shipment.store_id);
  if (!orgId) return { error: "No pudimos identificar la organización de la salida." };
  const now = new Date().toISOString();

  if (decision.seal) {
    const { error } = await admin
      .from("shipments")
      .update({
        custody_state: "devuelto",
        returned_at: now,
        pickup_state: "devuelto",
        returned_source: "manual",
        returned_by: user.id,
      })
      .eq("id", shipment.id)
      .is("returned_at", null);
    if (error) return { error: error.message };
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
  return { notice: `${dispatchScanLabel(shipment)} recibida en almacén.`, shipment };
}

/**
 * Un paquete de Grupo GF (o sin courier aún) escaneado en Devoluciones (MOM
 * §29.13, `lib/gf-returns-scan.ts`). Un «No entregado» se recibe en oficina
 * como en Despacho del día y el pedido queda por asignar para reprogramarlo;
 * lo que nunca salió solo se explica. Un pedido anulado en Shopify se recibe
 * igual —la caja tiene que salir de la del motorizado— y se dice que no vuelve
 * a salir.
 */
async function receiveGrupoGfReturn(shipment: DispatchShipment): Promise<DispatchActionResult> {
  const label = dispatchScanLabel(shipment);
  const admin = createAdminSupabase();
  const [{ data: items }, { data: received }, cancelled] = await Promise.all([
    admin
      .from("dispatch_manifest_items")
      .select("id,manifest_id,dispatch_manifests!inner(courier,route_date,driver_name)")
      .eq("shipment_id", shipment.id)
      .is("removed_at", null)
      .eq("dispatch_manifests.courier", "propio")
      .limit(1),
    admin
      .from("order_events")
      .select("id")
      .eq("shipment_id", shipment.id)
      .in("kind", ["returned_to_office", "reclaimed_in_office"])
      .limit(1),
    cancelledScanNotice(admin, shipment.order_id),
  ]);
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
  });
  if (decision.kind === "error") return { error: decision.message };
  if (decision.kind === "aviso") return cancelled ? { error: cancelled } : { notice: decision.message, shipment };

  const { user } = await currentUser();
  const { data: orderId, error } = await admin.rpc("gf_return_to_office", { p_item_id: item!.id, p_actor: user.id });
  if (error) return { error: `${label}: ${error.message}` };
  if (orderId) await recomputeOrderMasterSafe(admin, [orderId as string]);
  revalidatePath(RETURNS_PATH);
  revalidatePath("/dashboard/courier");
  revalidatePath("/dashboard/pedidos");
  return cancelled
    ? { error: `${label} recibido en oficina. ${cancelled}`, shipment }
    : { notice: `${label} recibido en oficina: vuelve a «por asignar» en Grupo GF para reprogramarlo.`, shipment };
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
    admin
      .from("order_events")
      .select("id")
      .eq("shipment_id", shipment.id)
      .eq("kind", "return_received")
      .limit(1),
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
    return decision.reason === "ya_recibida"
      ? { notice: `${label}: ${decision.message}`, shipment }
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
  if (!written?.length) return { error: `${label}: la guía cambió mientras escaneabas. Vuelve a escanearla.` };

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
  const [manifest, candidates] = await Promise.all([visibleManifest(manifestId), findScanCandidates(code)]);
  if (!manifest) return { error: "Ruta no encontrada o sin acceso." };
  if (courierKey(manifest.courier) === "propio") return { error: "Agrega los pedidos desde Grupo GF Courier para conservar la solicitud y la tarifa." };
  const pick = pickDispatchScanTarget(candidates);
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
): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("dispatch.manage")) return { error: "No tienes permiso para cerrar rutas." };
  const name = receivedBy.trim();
  if (name.length < 3) return { error: "Escribe el nombre de quien recoge." };
  const manifest = await visibleManifest(manifestId);
  if (!manifest) return { error: "Ruta no encontrada o sin acceso." };
  if (needsRiderCheck(manifest.kind)) {
    return { error: "Esta ruta la cierra el cotejo del motorizado." };
  }
  if (["in_custody", "cancelled"].includes(manifest.state)) return { error: "Esa ruta ya está cerrada." };

  const { user } = await currentUser();
  const admin = createAdminSupabase();
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
    payload: { received_by: name },
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
  const [manifest, candidates] = await Promise.all([visibleManifest(manifestId, auth), findScanCandidates(code, auth)]);
  if (!manifest) return { error: "Ruta no encontrada o sin acceso." };
  if (!candidates.length) return { error: SCAN_NOT_FOUND };
  // Antes que «no pertenece a esta ruta»: si el pedido está anulado, eso es lo
  // que decide, esté o no en la ruta (#AUR177767, 05-10-2026).
  const cancelledCheck = await cancelledScanNotice(createAdminSupabase(), candidates[0]!.order_id);
  if (cancelledCheck) return { error: cancelledCheck };
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
