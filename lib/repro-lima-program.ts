// «Repro Lima» en el servidor: los hechos de cada pedido y el programa de
// Grupo GF del acuerdo (fase 1, entrega 1a; MOM §9.5, §29.6, §29.13).
//
// Aquí vive lo que tiene IO y no depende de quién mira: la acción de la
// pantalla (app/dashboard/pedidos/repro-lima/actions.ts), la lista
// (lib/repro-lima-access.ts) y los ganchos de «Recibir en oficina»
// (app/dashboard/courier/actions.ts y app/dashboard/pedidos/despacho/actions.ts)
// leen los mismos hechos y programan por el mismo camino.
//
// Sin imports de sesión ni `server-only`: los ganchos corren dentro del escaneo
// de Despacho del día y sus pruebas cargan este módulo con la base simulada.
//
// Reglas que cuida este módulo:
// - El programa lo escribe `writeGfDispatchProgram`, el mismo escritor que
//   «Programar» (D4). Antes de escribir se comprueba que el pedido sigue en
//   «Por reprogramar Lima», sin anular y en el mismo episodio (E21); si no, el
//   caso se cierra y no se programa.
// - La marca del acuerdo es una escritura condicional sobre
//   `agreement_call_id` (CAS): cada acuerdo se programa una vez. Si escribir
//   falla, la marca se deshace. Si el acuerdo cambió mientras se escribía, se
//   quita SU programa (E22), salvo que el acuerdo nuevo, del mismo día, ya
//   cuente con él.
// - Un programa del mismo día solo se deja sin tocar si ya es de Repro Lima
//   (E26): el del motorizado o el de Grupo GF se reescribe con su motivo.
// - Los ganchos nunca lanzan, no revalidan ni recalculan el Master y no llaman
//   RPC (E30): la recepción ya está hecha y es lo que importa.

import type { createAdminSupabase } from "@/lib/db";
import { courierRowsByIds } from "@/lib/courier-flow";
import { loadActiveBoxes, type CourierRouteAssignment } from "@/lib/gf-active-boxes";
import {
  clearGfDispatchPrograms,
  loadGfRequest,
  writeGfDispatchProgram,
  type GfProgramRow,
  type GfRequestRow,
} from "@/lib/gf-dispatch-program";
import { limaClock, sameDayCutoffMinute } from "@/lib/grupo-gf-courier";
import { isRetryAdmission, ownReplaceDecision, ownRetryOutput, type OwnReplaceDecision } from "@/lib/gf-retry";
import { replacedOutputIds } from "@/lib/gf-replaced-output";
import { guideFailedAfterDispatch } from "@/lib/reproprovincia";
import { limaDay, programDayLabel } from "@/lib/dispatch-day";
import { sameCourier } from "@/lib/shipment-output";
import { otherLiveCourierOf } from "@/lib/repro-box-action";
import {
  boxLocation,
  compareEpisodeStops,
  isOwnBox,
  programOrigin,
  reproEpisode,
  reproProgramReason,
  type BoxLocation,
  type ReproCloseReason,
} from "@/lib/repro-lima";

type Admin = ReturnType<typeof createAdminSupabase>;

/** La pantalla de Repro Lima: se revalida tras cada acción y cada recepción. */
export const REPRO_LIMA_PATH = "/dashboard/pedidos/repro-lima";

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

/** El caso tal como lo guarda 0249. */
export interface ReproCaseRow {
  id: string;
  store_id: string;
  order_id: string;
  episode_key: string;
  episode_at: string | null;
  opened_at: string;
  opened_by: string | null;
  claimed_by: string | null;
  claimed_until: string | null;
  call_count: number;
  no_answer_count: number;
  last_call_at: string | null;
  last_outcome: string | null;
  next_call_at: string | null;
  agreement_call_id: string | null;
  agreed_on: string | null;
  agreed_courier: string | null;
  changes: Record<string, unknown> | null;
  box_action: string | null;
  box_location: string | null;
  decided_by: string | null;
  decided_at: string | null;
  materialized_at: string | null;
  materialized_on: string | null;
  closed_at: string | null;
  closed_by: string | null;
  close_reason: string | null;
  close_note: string | null;
}

export const REPRO_CASE_COLUMNS =
  "id,store_id,order_id,episode_key,episode_at,opened_at,opened_by,claimed_by,claimed_until," +
  "call_count,no_answer_count,last_call_at,last_outcome,next_call_at," +
  "agreement_call_id,agreed_on,agreed_courier,changes,box_action,box_location,decided_by,decided_at," +
  "materialized_at,materialized_on,closed_at,closed_by,close_reason,close_note";

/** El pedido en el Master (`order_master`). */
export interface ReproOrderRow {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  district: string | null;
  region: string | null;
  province: string | null;
  order_total: number | string | null;
  macro_since: string | null;
  macro_stage: string | null;
  macro_substage: string | null;
  operational_status: string | null;
}

export const REPRO_ORDER_COLUMNS =
  "order_id,store_id,order_name,customer_name,customer_phone,district,region,province,order_total," +
  "macro_since,macro_stage,macro_substage,operational_status";

/** Una salida del pedido, con lo que deciden el episodio y la caja. */
export interface ReproShipmentRow {
  id: string;
  order_id: string | null;
  store_id: string | null;
  courier: string;
  created_via: string | null;
  delivery_status: string;
  custody_state: string | null;
  custody_transferred_at: string | null;
  output_number: number | null;
  output_code: string | null;
  guide_code: string | null;
  status_category: string | null;
  reported_status: string | null;
  swayp_state: number | null;
  returned_at: string | null;
  dispatched_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
}

const SHIPMENT_COLUMNS =
  "id,order_id,store_id,courier,created_via,delivery_status,custody_state,custody_transferred_at," +
  "output_number,output_code,guide_code,status_category,reported_status,swayp_state,returned_at," +
  "dispatched_at,updated_at,closed_at";

/** Una parada «No entregado», con su ruta y su motorizado. */
export interface ReproStopRow {
  id: string;
  order_id: string;
  shipment_id: string | null;
  route_id: string | null;
  status: string;
  outcome_reason: string | null;
  note: string | null;
  photo_path: string | null;
  reported_at: string | null;
  requested_date: string | null;
  dispatch_manifest_id: string | null;
  /** Cuándo nació la parada: desempata el episodio en el mismo día (`compareEpisodeStops`). */
  created_at: string | null;
  routeDate: string | null;
  riderName: string | null;
}

const STOP_COLUMNS =
  "id,order_id,shipment_id,route_id,status,outcome_reason,note,photo_path,reported_at,requested_date,dispatch_manifest_id,created_at";

/** El proveedor Grupo GF de la organización: el corte sale de aquí (D6). */
export interface ReproProviderRow {
  id: string;
  org_id: string;
  status: string | null;
  same_day_cutoff: string | null;
}

/** Los kinds del historial que hacen falta: recepción, reemplazo y programa quitado. */
const FACT_EVENT_KINDS = [
  "returned_to_office",
  "return_received",
  "output_replaced",
  "dispatch_program_cleared",
  "dispatch_program_overridden",
];

/** Todo lo que Repro Lima sabe de un pedido, leído junto. */
export interface ReproFacts {
  orderId: string;
  storeId: string | null;
  orgId: string | null;
  /** La fila del Master; null si no se encontró. */
  order: ReproOrderRow | null;
  /** «En curso · Por reprogramar Lima». */
  inStage: boolean;
  /** Anulado (`orders.cancelled_at`). */
  cancelled: boolean;
  outputs: ReproShipmentRow[];
  /** Paradas «No entregado», la más reciente primero (`compareEpisodeStops`). */
  failedStops: ReproStopRow[];
  /** La parada del episodio (la más reciente), o null. */
  lastStop: ReproStopRow | null;
  /** La salida de otro courier que no entregó (la de consecutivo más alto), o null. */
  failedOutput: ReproShipmentRow | null;
  episode: { key: string; at: string | null };
  /** La salida propia que se reusa (`ownRetryOutput`), su caja y si ya estuvo en otra solicitud. */
  ownLive: ReproShipmentRow | null;
  ownBox: CourierRouteAssignment | null;
  ownInOtherRequest: boolean;
  /**
   * Cuándo se recibió en oficina la caja del episodio: la última recepción
   * desde que salió el intento que falló (`episodeDepartedAt`); null si no.
   */
  receivedAt: string | null;
  box: BoxLocation;
  /** Reintento de otro courier (`isRetryAdmission`): Grupo GF crea la salida al tomarlo. */
  retryAdmission: boolean;
  /** Otra guía viva de otro courier (`otra_salida_viva`), o null. */
  otherLiveCourier: string | null;
  /** El pedido ya salió con Grupo GF alguna vez. */
  hadPropio: boolean;
  /** «Sacar con salida nueva» con la caja propia todavía con el motorizado (E18). */
  ownReplace: { decision: OwnReplaceDecision; outputCode: string | null } | null;
  program: GfProgramRow | null;
  /** El último `dispatch_program_cleared` o `dispatch_program_overridden` (E9). */
  programRemovedAt: string | null;
  provider: ReproProviderRow | null;
  /** La solicitud vigente de Grupo GF, o null. */
  request: GfRequestRow | null;
  /** Todos los casos del pedido, el más reciente primero. */
  cases: ReproCaseRow[];
  /** El caso abierto, sea del episodio que sea (la lista decide si sirve). */
  open: ReproCaseRow | null;
  /** El último caso cerrado. */
  latestClosed: ReproCaseRow | null;
  /**
   * El caso abierto reabre un «Desarmar y cerrar» del mismo episodio (E29):
   * si la caja ya estaba en oficina antes de reabrir, no consta que siga
   * armada.
   */
  reopened: boolean;
}

function newest<T>(rows: readonly T[], at: (row: T) => string | null | undefined): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!best || (at(row) ?? "") > (at(best) ?? "")) best = row;
  }
  return best;
}

/**
 * Desde cuándo cuenta una recepción para el episodio (ms), o null: la salida
 * del intento que falló. De la parada, el inicio del día de su ruta en Lima
 * (su `reported_at` se reescribe en cada corrección); de la guía de otro
 * courier, su `dispatched_at`. Si hay las dos, la más reciente.
 */
function episodeDepartedAt(
  stop: Pick<ReproStopRow, "routeDate"> | null,
  output: Pick<ReproShipmentRow, "dispatched_at"> | null,
): number | null {
  const stamps = [
    stop?.routeDate && /^\d{4}-\d{2}-\d{2}$/.test(stop.routeDate.slice(0, 10)) ? Date.parse(`${stop.routeDate.slice(0, 10)}T00:00:00-05:00`) : NaN,
    output?.dispatched_at ? Date.parse(output.dispatched_at) : NaN,
  ].filter((t) => Number.isFinite(t));
  return stamps.length ? Math.max(...stamps) : null;
}

/** ¿Se recibió en oficina desde ese momento? Sin fecha de recepción, no consta. */
function receivedSince(receivedAt: string | null, since: string): boolean {
  const at = Date.parse(receivedAt ?? "");
  return Number.isFinite(at) && at >= Date.parse(since);
}

export interface ReproFactsOptions {
  /** Filas del Master ya leídas: la lista las trae de su consulta por tienda. */
  orders?: readonly ReproOrderRow[];
  /** Tienda → organización, ya leído. */
  storeOrg?: ReadonlyMap<string, string>;
  /** Organización → proveedor Grupo GF, ya leído. */
  providers?: ReadonlyMap<string, ReproProviderRow>;
}

/**
 * Los hechos de varios pedidos, en lecturas por lotes (de 100 en 100). Lanza si
 * una lectura falla: quien llama decide (la acción dice el error, el gancho lo
 * calla).
 */
export async function loadReproFacts(
  admin: Admin,
  orderIds: readonly string[],
  opts: ReproFactsOptions = {},
): Promise<Map<string, ReproFacts>> {
  const ids = [...new Set(orderIds.filter(Boolean))];
  const out = new Map<string, ReproFacts>();
  if (!ids.length) return out;
  const idSet = new Set(ids);
  // Las columnas van en constantes: el tipo de la fila se dice aquí.
  const byIds = async <T>(read: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> =>
    (await courierRowsByIds(ids, read as (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>)).data;

  const [orderRows, orderBase, shipments, stops, programs, events, cases, requests] = await Promise.all([
    opts.orders
      ? Promise.resolve(opts.orders.filter((row) => idSet.has(row.order_id)))
      : byIds<ReproOrderRow>((chunk) => admin.from("order_master").select(REPRO_ORDER_COLUMNS).in("order_id", chunk)),
    byIds<{ id: string; store_id: string | null; cancelled_at: string | null }>((chunk) =>
      admin.from("orders").select("id,store_id,cancelled_at").in("id", chunk)),
    byIds<ReproShipmentRow>((chunk) => admin.from("shipments").select(SHIPMENT_COLUMNS).in("order_id", chunk)),
    byIds<Omit<ReproStopRow, "routeDate" | "riderName">>((chunk) =>
      admin.from("delivery_stops").select(STOP_COLUMNS).in("order_id", chunk).eq("status", "no_entregado")),
    byIds<GfProgramRow>((chunk) =>
      admin.from("gf_dispatch_programs").select("order_id,store_id,scheduled_for,reason,set_at").in("order_id", chunk)),
    byIds<{ order_id: string; shipment_id: string | null; kind: string; occurred_at: string }>((chunk) =>
      admin.from("order_events").select("order_id,shipment_id,kind,occurred_at").in("order_id", chunk).in("kind", FACT_EVENT_KINDS)),
    byIds<ReproCaseRow>((chunk) => admin.from("lima_repro_cases").select(REPRO_CASE_COLUMNS).in("order_id", chunk)),
    byIds<GfRequestRow & { order_id: string; provider_id: string; status: string; created_at: string | null }>((chunk) =>
      admin.from("logistics_requests")
        .select("id,order_id,provider_id,shipment_id,scheduled_for,status,created_at")
        .in("order_id", chunk)
        .neq("status", "cancelled")),
  ]);

  // Tienda → organización → proveedor.
  const storeIds = [...new Set([
    ...orderRows.map((row) => row.store_id),
    ...orderBase.map((row) => row.store_id),
  ].filter((id): id is string => Boolean(id)))];
  const storeOrg = new Map(opts.storeOrg ?? []);
  const missingStores = storeIds.filter((id) => !storeOrg.has(id));
  if (missingStores.length) {
    const { data } = await courierRowsByIds(missingStores, (chunk) => admin.from("stores").select("id,org_id").in("id", chunk));
    for (const row of data as Array<{ id: string; org_id: string }>) storeOrg.set(row.id, row.org_id);
  }
  const providers = new Map(opts.providers ?? []);
  const missingOrgs = [...new Set(storeIds.map((id) => storeOrg.get(id)).filter((id): id is string => Boolean(id)))]
    .filter((org) => !providers.has(org));
  if (missingOrgs.length) {
    const { data } = await courierRowsByIds(missingOrgs, (chunk) => admin
      .from("logistics_providers")
      .select("id,org_id,status,same_day_cutoff")
      .eq("code", "grupo-gf-courier")
      .in("org_id", chunk));
    for (const row of data as ReproProviderRow[]) providers.set(row.org_id, row);
  }

  // La ruta y el motorizado de cada parada.
  const routeIds = [...new Set(stops.map((stop) => stop.route_id).filter((id): id is string => Boolean(id)))];
  const { data: routes } = await courierRowsByIds(routeIds, (chunk) =>
    admin.from("delivery_routes").select("id,route_date,rider_id").in("id", chunk));
  const routeById = new Map((routes as Array<{ id: string; route_date: string; rider_id: string | null }>).map((route) => [route.id, route]));
  const riderIds = [...new Set([...routeById.values()].map((route) => route.rider_id).filter((id): id is string => Boolean(id)))];
  const { data: riders } = await courierRowsByIds(riderIds, (chunk) => admin.from("riders").select("id,full_name").in("id", chunk));
  const riderName = new Map((riders as Array<{ id: string; full_name: string }>).map((rider) => [rider.id, rider.full_name]));

  const group = <T extends { order_id: string | null }>(rows: readonly T[]): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      if (!row.order_id) continue;
      map.set(row.order_id, [...(map.get(row.order_id) ?? []), row]);
    }
    return map;
  };
  const orderById = new Map(orderRows.map((row) => [row.order_id, row]));
  const baseById = new Map(orderBase.map((row) => [row.id, row]));
  const shipmentsByOrder = group(shipments);
  const stopsByOrder = group(stops);
  const eventsByOrder = group(events);
  const casesByOrder = group(cases);
  const requestsByOrder = group(requests);
  const programByOrder = new Map(programs.map((row) => [row.order_id, row]));

  // La salida propia que se reusa y su caja, para todos de una vez.
  const ownByOrder = new Map<string, ReproShipmentRow>();
  for (const id of ids) {
    const order = orderById.get(id);
    if (!order) continue;
    const replaced = replacedOutputIds(eventsByOrder.get(id) ?? []);
    const own = ownRetryOutput(order, shipmentsByOrder.get(id) ?? [], replaced);
    if (own) ownByOrder.set(id, own);
  }
  const ownIds = [...ownByOrder.values()].map((output) => output.id);
  const [ownBoxes, { data: ownRequests }] = await Promise.all([
    loadActiveBoxes(admin, ownIds),
    courierRowsByIds(ownIds, (chunk) => admin.from("logistics_requests").select("shipment_id").in("shipment_id", chunk)),
  ]);
  const ownInRequest = new Set((ownRequests as Array<{ shipment_id: string }>).map((row) => row.shipment_id));

  for (const orderId of ids) {
    const order = orderById.get(orderId) ?? null;
    const base = baseById.get(orderId) ?? null;
    const storeId = order?.store_id ?? base?.store_id ?? null;
    const orgId = storeId ? storeOrg.get(storeId) ?? null : null;
    const provider = orgId ? providers.get(orgId) ?? null : null;
    const outputs = shipmentsByOrder.get(orderId) ?? [];
    const orderEvents = eventsByOrder.get(orderId) ?? [];
    const replaced = replacedOutputIds(orderEvents);
    const failedStops = (stopsByOrder.get(orderId) ?? [])
      .map((stop) => {
        const route = stop.route_id ? routeById.get(stop.route_id) : undefined;
        return {
          ...stop,
          routeDate: route?.route_date ?? null,
          riderName: route?.rider_id ? riderName.get(route.rider_id) ?? null : null,
        };
      })
      // El mismo orden que el episodio: el día de la ruta y el nacimiento de la
      // parada antes que `reported_at`, que cada corrección del reporte reescribe.
      .sort(compareEpisodeStops);
    const episode = reproEpisode({ orderId, outputs, failedStops });
    let failedOutput: ReproShipmentRow | null = null;
    for (const output of outputs) {
      if (!guideFailedAfterDispatch(output)) continue;
      if (!failedOutput || (output.output_number ?? 0) >= (failedOutput.output_number ?? 0)) failedOutput = output;
    }
    // La solicitud vigente de Grupo GF, antes que la caja: la salida propia en
    // ESA solicitud no está «en otra solicitud». Al recibirla en oficina,
    // `gf_return_to_office` devuelve la solicitud a `accepted` con la misma
    // salida; solo otra solicitud (también cancelada, 0138) la bloquea.
    const request = provider
      ? newest((requestsByOrder.get(orderId) ?? []).filter((row) => row.provider_id === provider.id), (row) => row.created_at)
      : null;
    const ownLive = ownByOrder.get(orderId) ?? null;
    const ownBox = ownLive ? ownBoxes.get(ownLive.id) ?? null : null;
    const ownInOtherRequest = ownLive ? ownInRequest.has(ownLive.id) && request?.shipment_id !== ownLive.id : false;
    // La recepción de la caja del episodio (decisión 10): no antes de que
    // saliera. La de un episodio anterior era de otra vuelta de la caja.
    const episodeSince = episodeDepartedAt(failedStops[0] ?? null, failedOutput);
    const receivedAt = newest(
      orderEvents.filter((event) =>
        (event.kind === "returned_to_office" || event.kind === "return_received") &&
        (episodeSince == null || Date.parse(event.occurred_at) >= episodeSince)),
      (event) => event.occurred_at,
    )?.occurred_at ?? null;
    const programRemovedAt = newest(
      orderEvents.filter((event) => event.kind === "dispatch_program_cleared" || event.kind === "dispatch_program_overridden"),
      (event) => event.occurred_at,
    )?.occurred_at ?? null;
    const lastFailed = failedOutput && !sameCourier(failedOutput.courier, "propio")
      ? {
          courier: failedOutput.courier,
          returned: Boolean(failedOutput.returned_at) || failedOutput.custody_state === "devuelto",
          returnedAt: failedOutput.returned_at,
        }
      : null;
    const orderCases = [...(casesByOrder.get(orderId) ?? [])]
      .sort((a, b) => (b.opened_at ?? "").localeCompare(a.opened_at ?? ""));
    const open = orderCases.find((row) => !row.closed_at) ?? null;
    const latestClosed = newest(orderCases.filter((row) => row.closed_at), (row) => row.closed_at);
    const reopened = Boolean(open && orderCases.some((row) =>
      row.closed_at &&
      row.close_reason === "desarmar_cerrar" &&
      row.episode_key === open.episode_key &&
      Date.parse(row.closed_at) <= Date.parse(open.opened_at)));
    let box = boxLocation({
      ownLive,
      box: ownBox,
      inOtherRequest: ownInOtherRequest,
      lastFailed,
      receivedAt,
    });
    // E29: reabierto después de «Desarmar y cerrar» con la caja que ya estaba
    // en oficina antes de reabrir (o sin fecha de recepción): Almacén pudo
    // haberla desarmado. Una recibida después de reabrir no tuvo el aviso de
    // desarmarla (con el caso abierto, la recepción no lo da): sigue en
    // oficina. Con el motorizado o volviendo, no cambia.
    if (reopened && open && box.kind === "en_oficina" && !receivedSince(box.since, open.opened_at)) {
      box = { kind: "desconocida", ...(isOwnBox(box) ? { own: true } : {}) };
    }
    out.set(orderId, {
      orderId,
      storeId,
      orgId,
      order,
      inStage: order?.macro_stage === "en_curso" && order?.macro_substage === "por_reprogramar_lima",
      cancelled: Boolean(base?.cancelled_at),
      outputs,
      failedStops,
      lastStop: failedStops[0] ?? null,
      failedOutput,
      episode,
      ownLive,
      ownBox,
      ownInOtherRequest,
      receivedAt,
      box,
      retryAdmission: isRetryAdmission(order?.macro_stage, order?.macro_substage, order?.operational_status),
      otherLiveCourier: otherLiveCourierOf(outputs, replaced),
      hadPropio: outputs.some((output) => sameCourier(output.courier, "propio")),
      ownReplace: ownLive && ownBox && order
        ? {
            decision: ownReplaceDecision(order, outputs, ownLive, ownBox, request?.shipment_id ?? null, replaced),
            outputCode: ownLive.output_code ?? null,
          }
        : null,
      program: programByOrder.get(orderId) ?? null,
      programRemovedAt,
      provider,
      request: request ? { id: request.id, scheduled_for: request.scheduled_for, shipment_id: request.shipment_id } : null,
      cases: orderCases,
      open,
      latestClosed,
      reopened,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Casos que ya no sirven
// ---------------------------------------------------------------------------

/**
 * ¿El caso sigue sirviendo con los hechos de ahora? (E1, E21)
 * - `fuera_de_etapa`: el pedido dejó «Por reprogramar Lima» o se anuló.
 * - `nuevo_intento`: hubo un fallo posterior (otro episodio, más reciente).
 * - `cambio`: el episodio es otro pero no más reciente: se leyó con datos
 *   viejos. No se cierra nada; se pide volver a intentarlo.
 */
export function reproCaseProblem(
  facts: Pick<ReproFacts, "inStage" | "cancelled" | "episode">,
  c: Pick<ReproCaseRow, "episode_key" | "episode_at">,
): { reason: Exclude<ReproCloseReason, "desarmar_cerrar"> | "cambio"; message: string } | null {
  if (!facts.inStage || facts.cancelled) {
    return { reason: "fuera_de_etapa", message: "Este pedido ya no está en «Por reprogramar Lima»." };
  }
  if (facts.episode.key !== c.episode_key) {
    const freshAt = Date.parse(facts.episode.at ?? "");
    const caseAt = Date.parse(c.episode_at ?? "");
    const newer = Number.isFinite(freshAt) && (!Number.isFinite(caseAt) || freshAt > caseAt);
    return newer
      ? { reason: "nuevo_intento", message: "El pedido tuvo otro intento de entrega: vuelve a abrirlo." }
      : { reason: "cambio", message: "El pedido cambió mientras lo abrías: vuelve a intentarlo." };
  }
  return null;
}

/**
 * Cierra casos que ya no sirven, sin evento (solo «Desarmar y cerrar» deja
 * evento). Condicionado a que sigan abiertos: un cierre repetido no pisa nada.
 */
export async function closeStaleReproCases(
  admin: Admin,
  caseIds: readonly string[],
  reason: Exclude<ReproCloseReason, "desarmar_cerrar">,
  now: string = new Date().toISOString(),
): Promise<void> {
  const ids = [...new Set(caseIds.filter(Boolean))];
  if (!ids.length) return;
  await courierRowsByIds(ids, (chunk) => admin
    .from("lima_repro_cases")
    .update({ closed_at: now, close_reason: reason, claimed_by: null, claimed_until: null })
    .in("id", chunk)
    .is("closed_at", null)
    .select("id"));
}

// ---------------------------------------------------------------------------
// Programar el acuerdo
// ---------------------------------------------------------------------------

/**
 * El nombre corto de quien decidió, para el motivo del programa: la parte
 * local del correo, la misma regla que lib/agent-names.ts. No se importa de
 * ahí porque ese módulo es `server-only` y los ganchos corren en el escaneo,
 * cuyas pruebas cargan este archivo. Nunca lanza.
 */
async function deciderName(admin: Admin, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    const email = data?.user?.email ?? null;
    return email ? email.split("@")[0]! : null;
  } catch {
    return null;
  }
}

export type MaterializeResult =
  /** Programado para su día. `wrote`: false si ya estaba programado así por Repro Lima. */
  | { status: "programado"; day: string; wrote: boolean; warning?: string | null }
  /** Otro lo programó antes, o el acuerdo ya es otro: no se escribió nada. */
  | { status: "omitido" }
  /** El caso ya no servía y se cerró: no se programa. */
  | { status: "cerrado"; reason: Exclude<ReproCloseReason, "desarmar_cerrar">; message: string }
  | { status: "error"; message: string };

/**
 * Programa en Grupo GF el acuerdo vigente del caso, una sola vez:
 * 1. comprueba el pedido (etapa, anulación, episodio) con hechos frescos;
 * 2. marca el acuerdo (CAS sobre `agreement_call_id` sin marca previa);
 * 3. lee el proveedor y la solicitud vigente;
 * 4. no programa lo que sigue en la caja de un motorizado (salvo «Caja nueva
 *    desde stock»: sale otra caja);
 * 5. escribe con `writeGfDispatchProgram`, salvo que el programa ya sea de
 *    Repro Lima para ese día (E26);
 * 6. relee el caso: si el acuerdo cambió mientras tanto, quita SU programa (E22),
 *    salvo que el acuerdo nuevo ya esté marcado para el mismo día: ese cuenta
 *    con este programa (lo vio en su paso 5 y no escribió).
 * Si algo falla después de marcar, la marca se deshace: la fila vuelve a
 * ofrecer «Programar ahora». No lanza por la escritura; sí si falla la lectura
 * de los hechos (quien llama la envuelve).
 */
export async function materializeAgreement(
  admin: Admin,
  input: {
    caseRow: ReproCaseRow;
    actor: string;
    /** Hechos frescos del pedido; si faltan, se leen. */
    facts?: ReproFacts | null;
    /** El motivo del programa; por defecto «Repro Lima: confirmado con el cliente (…)». */
    reason?: string | null;
    now?: Date;
  },
): Promise<MaterializeResult> {
  const c = input.caseRow;
  if (!c.agreement_call_id || !c.agreed_on || c.closed_at) return { status: "omitido" };
  const day = c.agreed_on.slice(0, 10);
  const callId = c.agreement_call_id;
  const facts = input.facts ?? (await loadReproFacts(admin, [c.order_id])).get(c.order_id) ?? null;
  if (!facts) return { status: "error", message: "No encontramos el pedido." };

  // 1. ¿Sigue sirviendo? (E21)
  const problem = reproCaseProblem(facts, c);
  if (problem) {
    if (problem.reason === "cambio") return { status: "error", message: problem.message };
    await closeStaleReproCases(admin, [c.id], problem.reason);
    return { status: "cerrado", reason: problem.reason, message: problem.message };
  }

  // 2. La marca: un acuerdo se programa una vez.
  const markAt = (input.now ?? new Date()).toISOString();
  const { data: marked, error: markError } = await admin
    .from("lima_repro_cases")
    .update({ materialized_at: markAt, materialized_on: day })
    .eq("id", c.id)
    .eq("agreement_call_id", callId)
    .is("materialized_at", null)
    .is("closed_at", null)
    .select("id");
  if (markError) return { status: "error", message: markError.message };
  if (!(marked as unknown[] | null)?.length) return { status: "omitido" };
  const undo = async (message: string): Promise<MaterializeResult> => {
    await admin
      .from("lima_repro_cases")
      .update({ materialized_at: null, materialized_on: null })
      .eq("id", c.id)
      .eq("agreement_call_id", callId)
      .eq("materialized_at", markAt);
    return { status: "error", message };
  };

  try {
    // 3. Proveedor y solicitud vigente.
    const provider = facts.provider;
    if (!provider) return await undo("Grupo GF Courier no está activado.");
    const request = await loadGfRequest(admin, provider.id, c.order_id);

    // 4. Lo que sigue en la caja de un motorizado no se programa (§29.6).
    if (c.box_action !== "caja_nueva_stock") {
      const inBoxIds = [...new Set([request?.shipment_id, facts.ownLive?.id].filter((id): id is string => Boolean(id)))];
      if (inBoxIds.length) {
        const { data: boxed } = await admin
          .from("dispatch_manifest_items")
          .select("shipment_id")
          .in("shipment_id", inBoxIds)
          .is("removed_at", null);
        if ((boxed as unknown[] | null)?.length) return await undo("La caja sigue con el motorizado: se programa al recibirla.");
      }
    }

    // 5. El programa vigente, releído: si ya es de Repro Lima para ese día, no se toca.
    const { data: current } = await admin
      .from("gf_dispatch_programs")
      .select("order_id,store_id,scheduled_for,reason,set_at")
      .eq("order_id", c.order_id)
      .maybeSingle();
    const program = (current as GfProgramRow | null) ?? null;
    if (program && program.scheduled_for.slice(0, 10) === day && programOrigin(program.reason) === "repro_lima") {
      return { status: "programado", day, wrote: false };
    }
    const reason = input.reason?.trim() || reproProgramReason(await deciderName(admin, c.decided_by), limaDay(c.decided_at) ?? limaClock().day);
    const setAt = new Date().toISOString();
    const written = await writeGfDispatchProgram(admin, {
      orderId: c.order_id,
      storeId: c.store_id,
      day,
      reason,
      actor: input.actor,
      request,
      from: program?.scheduled_for ?? null,
      now: setAt,
    });
    if (!written.written) return await undo(written.error ?? "No se pudo programar en Grupo GF.");

    // 6. ¿El acuerdo cambió mientras se escribía? (E22)
    const { data: after } = await admin
      .from("lima_repro_cases")
      .select("id,agreement_call_id,closed_at,materialized_at,materialized_on")
      .eq("id", c.id)
      .maybeSingle();
    const reread = after as {
      agreement_call_id: string | null;
      closed_at: string | null;
      materialized_at: string | null;
      materialized_on: string | null;
    } | null;
    if (!reread || reread.closed_at || reread.agreement_call_id !== callId) {
      // El acuerdo nuevo ya se marcó (su marca, no la nuestra: «Confirma» la
      // borra) para el mismo día: en el paso 5 vio este programa y no escribió
      // el suyo. Cuenta con él: no se quita.
      const newMark = reread?.materialized_at && Date.parse(reread.materialized_at) !== Date.parse(markAt);
      if (reread && !reread.closed_at && newMark && reread.materialized_on?.slice(0, 10) === day) {
        return { status: "programado", day, wrote: true, warning: written.error };
      }
      await clearGfDispatchPrograms(
        admin,
        [{ order_id: c.order_id, store_id: c.store_id, scheduled_for: day, reason, set_at: setAt }],
        input.actor,
        "Repro Lima: el acuerdo cambió mientras se programaba.",
      );
      return { status: "error", message: "El acuerdo cambió mientras se programaba: vuelve a abrir el caso." };
    }
    return { status: "programado", day, wrote: true, warning: written.error };
  } catch (error) {
    return await undo(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// «Recibir en oficina» (§29.13)
// ---------------------------------------------------------------------------

/** Las acciones de caja que esperan la caja que vuelve (las demás no la esperan). */
const WAITING_BOX_ACTIONS = new Set(["mantener", "reimprimir_misma_salida"]);

export interface ReproReceptionResult {
  /** Acuerdos programados para su día al recibir la caja. */
  programmed: Array<{ orderId: string; orderName: string | null; day: string }>;
  /** Acuerdos cuyo día ya pasó: no se programan. */
  pasadas: number;
  /** Acuerdos para hoy que llegaron después del corte (E25): no se programan. */
  tarde: number;
  /** Pedidos cuyo último caso del episodio es «Desarmar y cerrar» (E27). */
  noLoQuiere: Array<{ orderId: string; orderName: string | null }>;
}

export function emptyReproReception(): ReproReceptionResult {
  return { programmed: [], pasadas: 0, tarde: 0, noLoQuiere: [] };
}

/**
 * El gancho de «Recibir en oficina»: para cada pedido que volvió a «por
 * asignar», programa el acuerdo de Repro Lima que esperaba la caja (Grupo GF,
 * «Mantener» o «Reimprimir», sin programar, del mismo episodio) y avisa si el
 * cliente ya no lo quiere.
 *
 * - `via: "recepcion"` (lista, QR, Devoluciones): un acuerdo para hoy después
 *   del corte no se programa: ya no alcanza (E25).
 * - `via: "escaneo"` (`scanAssignToRider`): sí, porque ahí Grupo GF lo está
 *   asignando; un día distinto del de la caja lo dice el paso del programa.
 *
 * Nunca lanza, no revalida, no recalcula el Master y no llama RPC (E30). Sin
 * casos, una sola lectura.
 */
export async function materializeWaitingAgreementsSafe(
  admin: Admin,
  orderIds: readonly string[],
  actor: string,
  ctx: { via: "recepcion" | "escaneo"; now?: Date } = { via: "recepcion" },
): Promise<ReproReceptionResult> {
  const result = emptyReproReception();
  try {
    const ids = [...new Set((orderIds ?? []).filter(Boolean))];
    if (!ids.length) return result;
    const { data } = await courierRowsByIds(ids, (chunk) =>
      admin.from("lima_repro_cases").select(REPRO_CASE_COLUMNS).in("order_id", chunk) as unknown as PromiseLike<{ data: ReproCaseRow[] | null; error: { message: string } | null }>);
    const cases = (data ?? []).filter((row) => row && row.order_id);
    if (!cases.length) return result;

    const byOrder = new Map<string, ReproCaseRow[]>();
    for (const row of cases) byOrder.set(row.order_id, [...(byOrder.get(row.order_id) ?? []), row]);
    const waiting: ReproCaseRow[] = [];
    const closedNoQuiere = new Map<string, ReproCaseRow>();
    for (const [orderId, rows] of byOrder) {
      const open = rows.find((row) => !row.closed_at) ?? null;
      if (open) {
        if (
          open.agreement_call_id && open.agreed_on && !open.materialized_at &&
          sameCourier(open.agreed_courier, "propio") && WAITING_BOX_ACTIONS.has(open.box_action ?? "")
        ) waiting.push(open);
        continue;
      }
      const latest = newest(rows, (row) => row.closed_at ?? row.opened_at);
      if (latest?.close_reason === "desarmar_cerrar") closedNoQuiere.set(orderId, latest);
    }
    if (!waiting.length && !closedNoQuiere.size) return result;

    const facts = await loadReproFacts(admin, [...new Set([...waiting.map((row) => row.order_id), ...closedNoQuiere.keys()])]);
    const clock = limaClock(ctx.now ?? new Date());

    for (const c of waiting) {
      try {
        const f = facts.get(c.order_id);
        if (!f) continue;
        const problem = reproCaseProblem(f, c);
        if (problem) {
          if (problem.reason !== "cambio") await closeStaleReproCases(admin, [c.id], problem.reason);
          continue;
        }
        const day = c.agreed_on!.slice(0, 10);
        if (day < clock.day) {
          result.pasadas += 1;
          continue;
        }
        if (ctx.via === "recepcion" && day === clock.day && clock.minute > sameDayCutoffMinute(f.provider?.same_day_cutoff)) {
          result.tarde += 1;
          continue;
        }
        const done = await materializeAgreement(admin, { caseRow: c, actor, facts: f, now: ctx.now });
        if (done.status === "programado") {
          result.programmed.push({ orderId: c.order_id, orderName: f.order?.order_name ?? null, day: done.day });
        } else if (done.status === "error") {
          console.error("repro-lima: no se pudo programar al recibir", c.order_id, done.message);
        }
      } catch (error) {
        console.error("repro-lima: no se pudo programar al recibir", c.order_id, error instanceof Error ? error.message : error);
      }
    }

    for (const [orderId, latest] of closedNoQuiere) {
      const f = facts.get(orderId);
      if (f && latest.episode_key === f.episode.key) {
        result.noLoQuiere.push({ orderId, orderName: f.order?.order_name ?? null });
      }
    }
  } catch (error) {
    console.error("repro-lima: gancho de recepción", error instanceof Error ? error.message : error);
  }
  return result;
}

/** El aviso de E27, tal como lo cita el MOM (§29.13). */
export const REPRO_NO_LO_QUIERE_NOTICE = "Repro Lima: el cliente ya no lo quiere. Desármala (cuaderno «DESARMAR»); no va al estante.";

/**
 * Las frases que la recepción suma a su aviso.
 * - `single`: se recibió UNA caja (QR, Devoluciones, escaneo): se dice su día.
 * - `omitProgrammed`: el escaneo de asignación no lo repite; lo dice el paso
 *   del programa («Programado para el jue 15/10 («Repro Lima: …»)…»).
 */
export function reproReceptionNotice(
  result: ReproReceptionResult,
  opts: { single?: boolean; omitProgrammed?: boolean } = {},
): string[] {
  const parts: string[] = [];
  const n = result.programmed.length;
  if (n && !opts.omitProgrammed) {
    if (opts.single) {
      parts.push(`Repro Lima: programado para el ${programDayLabel(result.programmed[0]!.day)}, el día acordado con el cliente (va al anaquel de ese día).`);
    } else {
      parts.push(n === 1
        ? "1 con acuerdo de Repro Lima: quedó programado para su día (va al anaquel de ese día)."
        : `${n} con acuerdo de Repro Lima: quedaron programados para su día (van al anaquel de ese día).`);
    }
  }
  if (result.pasadas) {
    parts.push(opts.single
      ? "Repro Lima: la fecha acordada con el cliente ya pasó: vuelve a confirmarla en Repro Lima."
      : `${result.pasadas} con fecha acordada que ya pasó: vuelve a confirmarla en Repro Lima.`);
  }
  if (result.tarde) {
    parts.push(opts.single
      ? "Repro Lima: el acuerdo era para hoy y ya pasó el corte: ya no alcanza hoy, confírmalo de nuevo en Repro Lima."
      : `${result.tarde} con acuerdo para hoy llegaron después del corte: ya no alcanza hoy, confírmalos de nuevo en Repro Lima.`);
  }
  if (result.noLoQuiere.length) {
    if (opts.single || (result.noLoQuiere.length === 1 && !result.noLoQuiere[0]!.orderName)) {
      parts.push(REPRO_NO_LO_QUIERE_NOTICE);
    } else {
      const names = result.noLoQuiere.map((row) => row.orderName ?? "un pedido").join(", ");
      parts.push(result.noLoQuiere.length === 1
        ? `Repro Lima: el cliente de ${names} ya no lo quiere. Desármala (cuaderno «DESARMAR»); no va al estante.`
        : `Repro Lima: los clientes de ${names} ya no los quieren. Desármalas (cuaderno «DESARMAR»); no van al estante.`);
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Chapas de la cola de Despacho del día (E28)
// ---------------------------------------------------------------------------

/** La chapa de un pedido cuyo cliente ya no lo quiere. */
export const REPRO_NO_LO_QUIERE_CHIP = "Repro Lima: no lo quiere · desarmar";

/** «Repro Lima: caja nueva desde stock, sale jue 15/10». */
export function reproCajaNuevaChip(day: string): string {
  return `Repro Lima: caja nueva desde stock, sale ${programDayLabel(day.slice(0, 10))}`;
}

/**
 * Lo que la cola de Despacho del día necesita saber de Repro Lima, en una
 * lectura por los pedidos que se le pasan:
 * - `noLoQuiere`: el último caso es «Desarmar y cerrar» del episodio vigente
 *   (E28) y no hay otro abierto. Solo un fallo nuevo abre otro episodio:
 *   recibir la caja en oficina o corregir el reporte de la parada después del
 *   cierre no lo esconden. El episodio se lee con los hechos del pedido
 *   (`loadReproFacts`), solo para esos pedidos; si esa lectura falla, se cae a
 *   `departures` (no volvió a salir después del cierre).
 * - `cajaNueva`: el último caso acordó «Caja nueva desde stock» con Grupo GF:
 *   el día que sale y si el caso sigue abierto. Con otro courier no: su salida
 *   se crea en la Mesa de ruta, y la chapa en la fila donde se ofrece «Sacar
 *   con salida nueva» le diría a Grupo GF que la saque él (§9.3, fila 2). Uno
 *   cerrado al salir de la etapa solo vale para la caja reemplazada que vuelve
 *   («En devolución»): el pedido ya salió de «Por reprogramar Lima» con la
 *   salida nueva.
 * Nunca lanza: sin lectura no hay chapas.
 */
export async function loadReproQueueFlags(
  admin: Admin,
  orderIds: readonly string[],
  departures: ReadonlyMap<string, string> = new Map(),
): Promise<{ noLoQuiere: Set<string>; cajaNueva: Map<string, { day: string; open: boolean }> }> {
  const noLoQuiere = new Set<string>();
  const cajaNueva = new Map<string, { day: string; open: boolean }>();
  try {
    const ids = [...new Set(orderIds.filter(Boolean))];
    if (!ids.length) return { noLoQuiere, cajaNueva };
    type FlagCase = Pick<ReproCaseRow, "order_id" | "episode_key" | "opened_at" | "closed_at" | "close_reason" | "agreed_on" | "agreed_courier" | "box_action">;
    const { data } = await courierRowsByIds(ids, (chunk) => admin
      .from("lima_repro_cases")
      .select("order_id,episode_key,opened_at,closed_at,close_reason,agreed_on,agreed_courier,box_action")
      .in("order_id", chunk));
    const byOrder = new Map<string, FlagCase[]>();
    for (const row of (data ?? []) as FlagCase[]) {
      if (!row?.order_id) continue;
      byOrder.set(row.order_id, [...(byOrder.get(row.order_id) ?? []), row]);
    }
    const closed = new Map<string, FlagCase>();
    for (const [orderId, rows] of byOrder) {
      const latest = newest(rows, (row) => row.opened_at);
      if (!latest) continue;
      if (latest.box_action === "caja_nueva_stock" && latest.agreed_on && (!latest.closed_at || latest.close_reason === "fuera_de_etapa")) {
        // Solo con Grupo GF: con otro courier, la salida sale de la Mesa de ruta.
        if (sameCourier(latest.agreed_courier, "propio")) cajaNueva.set(orderId, { day: latest.agreed_on.slice(0, 10), open: !latest.closed_at });
        continue;
      }
      if (latest.closed_at && latest.close_reason === "desarmar_cerrar") closed.set(orderId, latest);
    }
    if (closed.size) {
      let facts: Map<string, ReproFacts> | null = null;
      try {
        facts = await loadReproFacts(admin, [...closed.keys()]);
      } catch (error) {
        console.error("repro-lima: episodio de la cola", error instanceof Error ? error.message : error);
      }
      for (const [orderId, latest] of closed) {
        const f = facts?.get(orderId);
        if (f) {
          if (f.episode.key === latest.episode_key) noLoQuiere.add(orderId);
          continue;
        }
        const departed = departures.get(orderId);
        if (!departed || Date.parse(departed) <= Date.parse(latest.closed_at!)) noLoQuiere.add(orderId);
      }
    }
  } catch (error) {
    console.error("repro-lima: chapas de la cola", error instanceof Error ? error.message : error);
  }
  return { noLoQuiere, cajaNueva };
}
