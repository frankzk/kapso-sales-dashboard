"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { isCourierTbd } from "@/lib/shipment-output";
import {
  courierKey,
  deriveDispatchManifestState,
  needsRiderCheck,
  normalizeDispatchScan,
  type DispatchManifestState,
  type DispatchRouteKind,
  type DispatchScanStage,
} from "@/lib/dispatch";
import { operationFitsCourier, routeKindForCourier } from "@/lib/dispatch-routing";
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

async function findVisibleShipment(rawCode: string): Promise<DispatchShipment | null> {
  const code = normalizeDispatchScan(rawCode);
  if (!code) return null;
  const { sb } = await currentUser();
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
    if (data?.length === 1) return data[0] as unknown as DispatchShipment;
  }
  return null;
}

async function visibleManifest(manifestId: string): Promise<DispatchManifest | null> {
  const { sb } = await currentUser();
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

export async function loadDispatchWorkspace(): Promise<DispatchWorkspaceData> {
  return getDispatchWorkspaceData();
}

export async function lookupDispatchShipment(code: string): Promise<DispatchActionResult> {
  const shipment = await findVisibleShipment(code);
  return shipment ? { shipment } : { error: "No encontramos una salida con ese QR o guía." };
}

export async function markShipmentReady(code: string): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("warehouse.prepare")) return { error: "No tienes permiso para preparar paquetes." };
  const shipment = await findVisibleShipment(code);
  if (!shipment) return { error: "No encontramos una salida con ese QR o guía." };
  if (shipment.custody_state !== "empresa") return { error: "Ese paquete ya no figura en custodia de la empresa." };
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
  revalidatePath(DISPATCH_PATH);
  revalidatePath("/dashboard/pedidos");
  return { notice: `${shipment.output_code ?? shipment.guide_code} quedó listo para despacho.`, shipment };
}

const createManifestSchema = z.object({
  courier: z.string().trim().min(1).max(80),
  routeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Opcional: lo que identifica una ruta es quién se lleva la caja y qué día,
  // así que sin nombre se usa el del motorizado. Solo hace falta escribirlo
  // cuando no hay a quién nombrar.
  routeLabel: z.string().trim().max(120).optional(),
  riderId: z.string().uuid().optional(),
  driverName: z.string().trim().max(120).optional(),
});

export async function createDispatchManifest(input: z.input<typeof createManifestSchema>): Promise<DispatchActionResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("dispatch.manage")) return { error: "No tienes permiso para crear rutas." };
  const parsed = createManifestSchema.safeParse(input);
  if (!parsed.success) return { error: "Completa el courier y la fecha de la ruta." };
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

  // Sin nombre escrito, la ruta se llama como quien se la lleva. Si tampoco hay
  // persona no queda nada que la identifique, y ahí sí hace falta escribirlo.
  const routeLabel = parsed.data.routeLabel || driverName;
  if (!routeLabel) {
    return { error: "Elige un motorizado o escribe un nombre para la ruta." };
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
  if (error) return { error: error.code === "23505" ? "Ya existe una ruta con ese nombre, courier y fecha." : error.message };
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
  const [manifest, shipment] = await Promise.all([visibleManifest(manifestId), findVisibleShipment(code)]);
  if (!manifest) return { error: "Ruta no encontrada o sin acceso." };
  if (!shipment) return { error: "No encontramos una salida con ese QR o guía." };
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
  const [manifest, shipment] = await Promise.all([visibleManifest(manifestId), findVisibleShipment(code)]);
  if (!manifest) return { error: "Ruta no encontrada o sin acceso." };
  if (!shipment) return { error: "No encontramos una salida con ese QR o guía." };
  if (["in_custody", "cancelled"].includes(manifest.state)) return { error: "Esa ruta ya está cerrada." };
  if (stage === "pickup" && !needsRiderCheck(manifest.kind)) {
    return { error: "Esta ruta no tiene motorizado que coteje: se cierra anotando quién recoge." };
  }
  const admin = createAdminSupabase();
  const { data: item } = await admin
    .from("dispatch_manifest_items")
    .select("*")
    .eq("manifest_id", manifestId)
    .eq("shipment_id", shipment.id)
    .is("removed_at", null)
    .maybeSingle();
  if (!item) return { error: "Ese paquete no pertenece a esta ruta." };

  const { user } = await currentUser();
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

  const state = await recalculateManifest(manifestId, user.id);
  await auditDispatch({
    orgId: manifest.org_id,
    manifestId,
    shipment,
    actor: user.id,
    kind: stage === "office" ? "office_checked" : "pickup_checked",
    orderNote: stage === "office" ? "Paquete cotejado por el equipo de despacho." : "Paquete cotejado por el motorizado.",
  });

  let notice = stage === "office" ? "Paquete cotejado por oficina." : "Paquete recibido por el motorizado.";
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
  if (["in_custody", "cancelled"].includes(manifest.state)) return { error: "Esa ruta ya está cerrada." };
  const admin = createAdminSupabase();
  const { data: shipment } = await admin
    .from("shipments")
    .select(DISPATCH_SHIPMENT_COLUMNS)
    .eq("id", shipmentId)
    .maybeSingle();
  if (!shipment) return { error: "Paquete no encontrado." };
  const { user } = await currentUser();
  const { error } = await admin
    .from("dispatch_manifest_items")
    .update({ removed_at: new Date().toISOString(), removed_by: user.id, removal_reason: cleanReason })
    .eq("manifest_id", manifestId)
    .eq("shipment_id", shipmentId)
    .is("removed_at", null);
  if (error) return { error: error.message };
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
  revalidatePath(DISPATCH_PATH);
  return { notice: "Paquete retirado expresamente de la ruta." };
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
