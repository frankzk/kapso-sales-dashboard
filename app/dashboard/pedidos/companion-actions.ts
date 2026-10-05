"use server";

// Pedido acompañante (MOM §32): vincular un pedido a la caja —salida y guía—
// de otro, y deshacerlo.
//
// Las reglas son de `lib/order-companion.ts`; aquí se juntan los hechos, se
// pregunta y se escriben DOS eventos en un solo insert —uno en cada pedido—,
// así que o quedan los dos o ninguno. Después se recalculan los dos: el
// acompañante pasa a seguir a la caja, y el candado de un «Cambiar estado»
// anterior cede en ambos (§6.1).

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import {
  COMPANION_LINKED,
  COMPANION_REASON_MIN,
  COMPANION_UNLINKED,
  companionCollectTotal,
  companionLinkProblem,
  isLiveOwnOutput,
  normalizeOrderNameInput,
  type CompanionLinkCheck,
  type CompanionPayload,
  type CompanionShipmentFacts,
} from "@/lib/order-companion";
import { loadCompanionRides, type CompanionRide } from "@/lib/order-companion-access";

const MASTER_PATH = "/dashboard/pedidos";

const SHIPMENT_COLUMNS =
  "id,order_id,courier,guide_code,delivery_status,dispatched_at,out_for_delivery_at,custody_transferred_at,returned_at,output_code,created_at";

export interface CompanionActionState {
  error?: string;
  notice?: string;
}

interface MasterFacts {
  order_id: string;
  order_name: string | null;
  store_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  order_total: number | null;
  macro_stage: string | null;
}

interface ShipmentFacts extends CompanionShipmentFacts {
  output_code: string | null;
  created_at: string | null;
}

/** Una salida del principal que se ofrece como caja, con lo que impediría usarla. */
export interface CompanionHostOption {
  shipmentId: string;
  courier: string;
  guideCode: string | null;
  outputCode: string | null;
  deliveryStatus: string;
  /** Por qué NO se puede usar esta caja, o null si se puede. */
  problem: string | null;
}

export interface CompanionHostPreview {
  hostOrderId: string;
  hostOrderName: string | null;
  hostCustomerName: string | null;
  hostTotal: number | null;
  /** Lo que tendrá que cobrar la guía con este pedido dentro. */
  collectTotal: number;
  options: CompanionHostOption[];
}

const MASTER_COLUMNS = "order_id,order_name,store_id,customer_name,customer_phone,order_total,macro_stage";

/** El usuario, el permiso y un pedido que ve (RLS): o el motivo para no seguir. */
async function authorize(orderId: string): Promise<
  | { error: string }
  | { userId: string; sb: Awaited<ReturnType<typeof createServerSupabase>>; row: MasterFacts }
> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) return { error: "Tu rol no permite modificar pedidos." };
  const { data, error } = await sb.from("order_master").select(MASTER_COLUMNS).eq("order_id", orderId).maybeSingle();
  if (error) return { error: `No se pudo leer el pedido (${error.message}).` };
  if (!data) return { error: "Sin acceso a este pedido." };
  return { userId: user.id, sb, row: normalizeFacts(data as unknown as MasterFacts) };
}

function normalizeFacts(row: MasterFacts): MasterFacts {
  const total = row.order_total == null ? null : Number(row.order_total);
  return { ...row, order_total: total != null && Number.isFinite(total) ? total : null };
}

async function readMaster(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  orderId: string,
): Promise<MasterFacts | null> {
  const { data } = await sb.from("order_master").select(MASTER_COLUMNS).eq("order_id", orderId).maybeSingle();
  return data ? normalizeFacts(data as unknown as MasterFacts) : null;
}

/** Los hechos del pedido acompañante que pide la regla, leídos con servicio. */
async function companionSide(
  admin: ReturnType<typeof createAdminSupabase>,
  row: MasterFacts,
  rides: readonly CompanionRide[],
): Promise<CompanionLinkCheck["companion"] | { error: string }> {
  const [orderRes, shipmentsRes] = await Promise.all([
    admin.from("orders").select("cancelled_at").eq("id", row.order_id).maybeSingle(),
    admin.from("shipments").select("delivery_status,returned_at").eq("order_id", row.order_id),
  ]);
  if (orderRes.error || shipmentsRes.error) {
    return {
      error: `No se pudieron leer las salidas del pedido (${(orderRes.error ?? shipmentsRes.error)!.message}). Vuelve a intentarlo.`,
    };
  }
  const own = (shipmentsRes.data ?? []) as { delivery_status: string; returned_at: string | null }[];
  return {
    orderId: row.order_id,
    orderName: row.order_name,
    phone: row.customer_phone,
    cancelledAt: (orderRes.data as { cancelled_at: string | null } | null)?.cancelled_at ?? null,
    macroStage: row.macro_stage,
    liveOwnOutputs: own.filter(isLiveOwnOutput).length,
    hostsCompanions: rides.some((ride) => ride.link.hostOrderId === row.order_id),
    activeLink: rides.find((ride) => ride.link.companionOrderId === row.order_id)?.link ?? null,
  };
}

/**
 * Busca el pedido principal por su nombre y enseña sus cajas, cada una con lo
 * que impediría usarla. No escribe nada: es lo que la ficha muestra antes de
 * pedir el motivo y el clic.
 */
export async function previewCompanionHost(
  orderId: string,
  hostName: string,
): Promise<{ preview: CompanionHostPreview } | { error: string }> {
  const auth = await authorize(orderId);
  if ("error" in auth) return auth;
  const name = normalizeOrderNameInput(hostName);
  if (!name) return { error: "Escribe el número del pedido principal, por ejemplo #AUR177622." };

  const { data: hosts, error: hostError } = await auth.sb
    .from("order_master")
    .select(MASTER_COLUMNS)
    .eq("order_name", name)
    .limit(2);
  if (hostError) return { error: `No se pudo buscar el pedido (${hostError.message}).` };
  const found = ((hosts ?? []) as unknown as MasterFacts[]).map(normalizeFacts);
  if (!found.length) return { error: `No encontramos ${name} entre los pedidos de tus tiendas.` };
  if (found.length > 1) return { error: `Hay más de un pedido llamado ${name}; avisa a sistemas.` };
  const host = found[0]!;

  const admin = createAdminSupabase();
  const [rides, shipmentsRes] = await Promise.all([
    loadCompanionRides(admin, [orderId, host.order_id]).catch((cause: unknown) => cause as Error),
    admin.from("shipments").select(SHIPMENT_COLUMNS).eq("order_id", host.order_id).order("created_at"),
  ]);
  if (rides instanceof Error) return { error: rides.message };
  if (shipmentsRes.error) return { error: `No se pudieron leer las salidas de ${name} (${shipmentsRes.error.message}).` };
  const companion = await companionSide(admin, auth.row, rides);
  if ("error" in companion) return companion;

  const shipments = (shipmentsRes.data ?? []) as unknown as ShipmentFacts[];
  const hostSide: CompanionLinkCheck["host"] = {
    orderId: host.order_id,
    orderName: host.order_name,
    phone: host.customer_phone,
    isCompanion: rides.some((ride) => ride.link.companionOrderId === host.order_id),
  };
  const options = shipments.map((shipment) => ({
    shipmentId: shipment.id,
    courier: shipment.courier,
    guideCode: shipment.guide_code,
    outputCode: shipment.output_code,
    deliveryStatus: shipment.delivery_status,
    problem: companionLinkProblem({ companion, host: hostSide, shipment, reason: null }),
  }));
  if (!options.length) {
    return { error: `${name} no tiene ninguna salida todavía: crea primero su guía (la combinada, en el portal de Aliclik).` };
  }
  // Lo que ya viaja en esas cajas también suma: la guía cobra a todos.
  const riding = rides.filter((ride) => ride.link.hostOrderId === host.order_id && ride.shipment);
  const ridingTotals = riding.length
    ? await admin
        .from("order_master")
        .select("order_id,order_total")
        .in("order_id", riding.map((ride) => ride.link.companionOrderId))
    : { data: [] as { order_id: string; order_total: number | null }[] };
  const others = ((ridingTotals.data ?? []) as { order_id: string; order_total: number | null }[])
    .filter((row) => row.order_id !== orderId)
    .map((row) => row.order_total);
  return {
    preview: {
      hostOrderId: host.order_id,
      hostOrderName: host.order_name,
      hostCustomerName: host.customer_name,
      hostTotal: host.order_total,
      collectTotal: companionCollectTotal(host.order_total, [...others, auth.row.order_total]),
      options,
    },
  };
}

/** Vincula este pedido a la caja (salida) de otro. */
export async function linkCompanionOrder(
  orderId: string,
  input: { hostShipmentId: string; reason: string },
): Promise<CompanionActionState> {
  const auth = await authorize(orderId);
  if ("error" in auth) return auth;
  const reason = input.reason?.trim() ?? "";
  const admin = createAdminSupabase();

  const { data: shipmentRow, error: shipmentError } = await admin
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .eq("id", input.hostShipmentId)
    .maybeSingle();
  if (shipmentError) return { error: `No se pudo leer la salida (${shipmentError.message}).` };
  const shipment = shipmentRow as unknown as ShipmentFacts | null;
  if (!shipment?.order_id) return { error: "Esa salida no existe o no tiene pedido." };
  // El principal tiene que estar entre las tiendas de quien vincula: se lee con
  // su sesión, no con la de servicio.
  const host = await readMaster(auth.sb, shipment.order_id);
  if (!host) return { error: "Sin acceso al pedido principal." };

  let rides: CompanionRide[];
  try {
    rides = await loadCompanionRides(admin, [orderId, host.order_id]);
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : "No se pudieron leer los vínculos." };
  }
  const companion = await companionSide(admin, auth.row, rides);
  if ("error" in companion) return companion;
  const problem = companionLinkProblem({
    companion,
    host: {
      orderId: host.order_id,
      orderName: host.order_name,
      phone: host.customer_phone,
      isCompanion: rides.some((ride) => ride.link.companionOrderId === host.order_id),
    },
    shipment,
    reason,
  });
  if (problem) return { error: problem };

  const occurredAt = new Date().toISOString();
  const base: Omit<CompanionPayload, "role"> = {
    link_id: randomUUID(),
    companion_order_id: auth.row.order_id,
    companion_order_name: auth.row.order_name,
    host_order_id: host.order_id,
    host_order_name: host.order_name,
    host_shipment_id: shipment.id,
    host_guide_code: shipment.guide_code,
  };
  const courier = shipment.courier;
  const guide = shipment.guide_code ?? "";
  const { error } = await admin.from("order_events").insert([
    {
      store_id: auth.row.store_id,
      order_id: auth.row.order_id,
      kind: COMPANION_LINKED,
      occurred_at: occurredAt,
      actor: auth.userId,
      source: "manual",
      courier,
      guide_code: shipment.guide_code,
      shipment_id: shipment.id,
      reason,
      note: `Viaja en la caja de ${host.order_name ?? "otro pedido"} · ${courier} ${guide}`.trim(),
      payload: { ...base, role: "companion" },
    },
    {
      store_id: host.store_id,
      order_id: host.order_id,
      kind: COMPANION_LINKED,
      occurred_at: occurredAt,
      actor: auth.userId,
      source: "manual",
      courier,
      guide_code: shipment.guide_code,
      shipment_id: shipment.id,
      reason,
      note: `Lleva también ${auth.row.order_name ?? "otro pedido"} en su caja · ${courier} ${guide}`.trim(),
      payload: { ...base, role: "host" },
    },
  ]);
  if (error) return { error: `No se pudo registrar el vínculo (${error.message}).` };

  await recomputeOrderMasterSafe(admin, [auth.row.order_id, host.order_id]);
  revalidatePath(MASTER_PATH);
  const total = companionCollectTotal(host.order_total, [auth.row.order_total]);
  return {
    notice:
      `${auth.row.order_name ?? "El pedido"} viaja en la caja de ${host.order_name ?? "su principal"}` +
      (guide ? ` (guía ${guide})` : "") +
      `. La guía debe cobrar en la puerta al menos S/ ${total.toFixed(2)}.`,
  };
}

/**
 * Deshace el vínculo. Se puede pedir desde cualquiera de los dos pedidos: el
 * del acompañante y el del principal reciben el mismo hecho.
 */
export async function unlinkCompanionOrder(
  companionOrderId: string,
  input: { reason: string },
): Promise<CompanionActionState> {
  const auth = await authorize(companionOrderId);
  if ("error" in auth) return auth;
  const reason = input.reason?.trim() ?? "";
  if (reason.length < COMPANION_REASON_MIN) {
    return { error: `Escribe por qué ya no viaja en esa caja (${COMPANION_REASON_MIN} caracteres como mínimo).` };
  }
  const admin = createAdminSupabase();
  let rides: CompanionRide[];
  try {
    rides = await loadCompanionRides(admin, [companionOrderId]);
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : "No se pudieron leer los vínculos." };
  }
  const ride = rides.find((candidate) => candidate.link.companionOrderId === companionOrderId);
  if (!ride) return { error: "Este pedido no viaja en la caja de ningún otro." };
  const host = await readMaster(auth.sb, ride.link.hostOrderId);
  if (!host) return { error: "Sin acceso al pedido principal: pide a quien lo ve que lo desvincule." };

  const occurredAt = new Date().toISOString();
  const base: Omit<CompanionPayload, "role"> = {
    link_id: ride.link.linkId ?? randomUUID(),
    companion_order_id: auth.row.order_id,
    companion_order_name: auth.row.order_name,
    host_order_id: host.order_id,
    host_order_name: host.order_name,
    host_shipment_id: ride.link.hostShipmentId,
    host_guide_code: ride.link.hostGuideCode,
  };
  const { error } = await admin.from("order_events").insert([
    {
      store_id: auth.row.store_id,
      order_id: auth.row.order_id,
      kind: COMPANION_UNLINKED,
      occurred_at: occurredAt,
      actor: auth.userId,
      source: "manual",
      courier: ride.rawShipment?.courier ?? null,
      guide_code: ride.link.hostGuideCode,
      shipment_id: ride.link.hostShipmentId,
      reason,
      note: `Ya no viaja en la caja de ${host.order_name ?? "su principal"}`,
      payload: { ...base, role: "companion" },
    },
    {
      store_id: host.store_id,
      order_id: host.order_id,
      kind: COMPANION_UNLINKED,
      occurred_at: occurredAt,
      actor: auth.userId,
      source: "manual",
      courier: ride.rawShipment?.courier ?? null,
      guide_code: ride.link.hostGuideCode,
      shipment_id: ride.link.hostShipmentId,
      reason,
      note: `${auth.row.order_name ?? "El acompañante"} ya no viaja en su caja`,
      payload: { ...base, role: "host" },
    },
  ]);
  if (error) return { error: `No se pudo registrar la desvinculación (${error.message}).` };

  await recomputeOrderMasterSafe(admin, [auth.row.order_id, host.order_id]);
  revalidatePath(MASTER_PATH);
  return {
    notice: `${auth.row.order_name ?? "El pedido"} ya no viaja en la caja de ${host.order_name ?? "su principal"}. Vuelve a su propia situación.`,
  };
}
