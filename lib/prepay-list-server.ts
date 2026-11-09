// «Lista de pago adelantado» — lecturas, altas, bajas y la regla automática
// (MOM §41, owner 05-11-2026). La regla en sí —qué la dispara, cuándo se
// respeta una baja, qué se exige— está en lib/prepay-list.ts (pura); aquí solo
// se lee y se escribe.
//
// TRES MANERAS DE RESPONDER «¿ESTÁ EN LA LISTA?».
//   * `prepayLookup`: listado, no listado o «no se pudo leer». Las compuertas
//     de guías la usan: «no se pudo leer» no autoriza una guía (falla cerrado),
//     igual que el historial de rechazos del §8.2.
//   * `isPrepayRequired`: un sí/no. Un celular que no se puede normalizar es
//     «no». La consulta de WordPress y la entrada de pedidos la usan.
//   * Sin la migración 0309 la lista está vacía: nada se bloquea hasta que
//     exista (`isMissingPrepayTable`), para que desplegar el código antes de la
//     migración no frene todas las guías.
//
// Sin `import "server-only"` a propósito: lo importan módulos que también
// corren en las pruebas (la entrada del bot, Swayp), y todo recibe el cliente
// de la base como argumento; nada de aquí lee un secreto.

import type { SupabaseClient } from "@supabase/supabase-js";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import {
  PREPAY_LOOKBACK_DAYS,
  prepayKnownOrderIdsOf,
  prepayListedKey,
  PREPAY_SIMULATION_SAMPLES,
  parsePrepayEvidence,
  prepayAutoDecision,
  prepayBlockMessage,
  prepayPhoneKey,
  prepayReasonProblem,
  prepayRequirementMet,
  prepayTriggersOfOrder,
  type PrepayEntryFact,
  type PrepayEvidence,
  type PrepayMode,
  type PrepayOrderFact,
  type PrepayPoint,
  type PrepayShipmentFact,
  type PrepaySimulationSummary,
  type PrepayStopFact,
  type PrepayTrigger,
  isPrepayMode,
} from "@/lib/prepay-list";
import type { OrderPaymentFacts } from "@/lib/order-paid";
import { pagoOnlineLookup } from "@/lib/pago-online-lookup";
import { pagoOnlineBrakeDecision, type PagoOnlineRequirement } from "@/lib/pago-online";

type DbError = { code?: string; message?: string } | null | undefined;
type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** La tabla aún no existe (0309 sin aplicar): PostgREST o Postgres. */
export function isMissingPrepayTable(error: DbError): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(error.message ?? "");
}

/** Una fila de `prepay_list_entries`. */
export interface PrepayEntryRow {
  id: string;
  org_id: string;
  phone: string;
  source: "auto" | "manual";
  reason: string;
  evidence: unknown;
  added_by: string | null;
  added_at: string;
  removed_at: string | null;
  removed_by: string | null;
  removed_reason: string | null;
  /** Los pedidos que ya disparaban el alta cuando se quitó (0309, §41.3). */
  removed_known_order_ids?: unknown;
}

export const PREPAY_ENTRY_COLUMNS = "id,org_id,phone,source,reason,evidence,added_by,added_at,removed_at,removed_by,removed_reason,removed_known_order_ids";

export type PrepayLookup =
  | { state: "listed"; entry: PrepayEntryRow }
  | { state: "not_listed" }
  | { state: "unread"; error: string };

/** La organización de una tienda. Null si no existe; lanza si la base falla. */
export async function orgOfStore(admin: SupabaseClient, storeId: string): Promise<string | null> {
  const { data, error } = await admin.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as { org_id?: string | null } | null)?.org_id ?? null) || null;
}

/** ¿El celular tiene un alta viva en la organización? */
export async function prepayLookup(admin: SupabaseClient, orgId: string, rawPhone: string | null | undefined): Promise<PrepayLookup> {
  const phone = prepayPhoneKey(rawPhone);
  if (!phone || !orgId) return { state: "not_listed" };
  const { data, error } = await admin
    .from("prepay_list_entries")
    .select(PREPAY_ENTRY_COLUMNS)
    .eq("org_id", orgId)
    .eq("phone", phone)
    .is("removed_at", null)
    .limit(1);
  if (error) {
    if (isMissingPrepayTable(error)) return { state: "not_listed" };
    return { state: "unread", error: error.message ?? "error de la base" };
  }
  const entry = ((data ?? []) as PrepayEntryRow[])[0];
  return entry ? { state: "listed", entry } : { state: "not_listed" };
}

/**
 * ¿Este celular paga por adelantado en esta organización? Sí solo con un alta
 * viva. Un celular que no se puede normalizar, o una lectura que falla, es «no»:
 * quien lo usa (WordPress, la entrada de pedidos) falla abierto y Kapta lo
 * vuelve a frenar al confirmar y al crear la guía.
 */
export async function isPrepayRequired(admin: SupabaseClient, orgId: string, rawPhone: string | null | undefined): Promise<boolean> {
  try {
    return (await prepayLookup(admin, orgId, rawPhone)).state === "listed";
  } catch {
    return false;
  }
}

/**
 * Las altas vivas entre estos celulares, como llaves `prepayListedKey(org,
 * celular)`: la lista es POR ORGANIZACIÓN, así que quien ve dos organizaciones
 * no puede marcar el pedido de una con el alta de la otra. Para marcar filas
 * en lote (`withPrepayListed`).
 */
export async function listedPhonesAmong(admin: SupabaseClient, orgIds: readonly string[], rawPhones: readonly (string | null | undefined)[]): Promise<Set<string>> {
  const phones = [...new Set(rawPhones.map(prepayPhoneKey).filter((p): p is string => !!p))];
  const out = new Set<string>();
  const orgs = [...new Set(orgIds.filter(Boolean))];
  if (!phones.length || !orgs.length) return out;
  for (let i = 0; i < phones.length; i += 200) {
    const { data, error } = await admin
      .from("prepay_list_entries")
      .select("org_id,phone")
      .in("org_id", orgs)
      .in("phone", phones.slice(i, i + 200))
      .is("removed_at", null);
    if (error) {
      if (isMissingPrepayTable(error)) return out;
      throw new Error(error.message);
    }
    for (const row of (data ?? []) as { org_id: string; phone: string }[]) out.add(prepayListedKey(row.org_id, row.phone));
  }
  return out;
}

// ── La compuerta de un pedido ───────────────────────────────────────────────

/** Lo que la compuerta lee del pedido (una fila de `order_master`). */
export interface PrepayOrderRow {
  order_id: string;
  store_id: string;
  customer_phone: string | null;
  financial_status?: string | null;
  total_refunded?: number | null;
  payment_state?: string | null;
  payment_gateway?: string | null;
}

const ORDER_COLUMNS = "order_id,store_id,customer_phone,financial_status,total_refunded,payment_state,payment_gateway";

export type PrepayOrderCheck =
  /**
   * Sigue. `fullyPaid`: el pedido ya está pagado completo (`orderFullyPaid`),
   * así que su guía sale con cobro cero —la última puerta de Swayp lo usa para
   * no mandar a cobrar el total a quien ya pagó—. Sin pedido leído, false.
   */
  | { state: "ok"; listed: boolean; fullyPaid: boolean }
  | { state: "blocked"; source: "lista"; message: string; entry: PrepayEntryRow }
  /**
   * La lista automática «Pago solo online» (0326, MOM §41.11): el mismo freno,
   * con lo que el owner decidió cobrar (adelanto o pago completo).
   */
  | { state: "blocked"; source: "pago_online"; message: string; entry: null; failed: number | null; requirement: PagoOnlineRequirement }
  | { state: "unread"; message: string };

export function paymentFactsOf(row: Pick<PrepayOrderRow, "financial_status" | "total_refunded" | "payment_state" | "payment_gateway">): OrderPaymentFacts {
  return {
    financialStatus: row.financial_status ?? null,
    totalRefunded: row.total_refunded ?? null,
    paymentState: row.payment_state ?? null,
    paymentGateway: (row.payment_gateway as OrderPaymentFacts["paymentGateway"]) ?? null,
  };
}

/**
 * LA COMPUERTA DE LA LISTA PARA UN PEDIDO: si su celular está en la lista y no
 * está pagado completo, `blocked` con el mensaje del punto (confirmar, guía…).
 * Pagado completo pasa (sale con cobro cero). `unread`: no se pudo saber; quien
 * crea una guía lo trata como «no» (falla cerrado). Nunca lanza.
 */
export async function prepayOrderCheck(
  admin: SupabaseClient,
  order: string | PrepayOrderRow,
  point: PrepayPoint,
): Promise<PrepayOrderCheck> {
  const unread = (detail: string): PrepayOrderCheck => ({
    state: "unread",
    message: `No se pudo comprobar la lista de pago adelantado (${detail}). Vuelve a intentarlo.`,
  });
  try {
    let row: PrepayOrderRow | null = typeof order === "string" ? null : order;
    if (!row) {
      const { data, error } = await admin.from("order_master").select(ORDER_COLUMNS).eq("order_id", order as string).maybeSingle();
      if (error) return unread(error.message);
      row = (data as PrepayOrderRow | null) ?? null;
      if (!row) return { state: "ok", listed: false, fullyPaid: false };
    }
    const facts = paymentFactsOf(row);
    const fullyPaid = prepayRequirementMet(facts);
    const orgId = await orgOfStore(admin, row.store_id);
    if (!orgId) return { state: "ok", listed: false, fullyPaid };
    // La lista de pago adelantado primero: pide el total, más que la automática.
    if (prepayPhoneKey(row.customer_phone)) {
      const lookup = await prepayLookup(admin, orgId, row.customer_phone);
      if (lookup.state === "unread") return unread(lookup.error);
      if (lookup.state === "listed") {
        if (fullyPaid) return { state: "ok", listed: true, fullyPaid };
        return { state: "blocked", source: "lista", message: prepayBlockMessage(point), entry: lookup.entry };
      }
    }
    // «Pago solo online (lista automática)»: solo en Activo, con la lista
    // vigente y sin la excepción de Kapta (`pago_online_lookup`, 0326).
    const auto = await pagoOnlineLookup(admin, orgId, row.customer_phone);
    if (auto.state === "unread") return unread(auto.error);
    if (auto.state === "not_listed") return { state: "ok", listed: false, fullyPaid };
    const brake = pagoOnlineBrakeDecision({
      listed: true,
      who: auto.who,
      requirement: auto.requirement,
      facts,
      point: point === "confirmar" ? "confirmar" : "guia",
    });
    if (brake.state === "ok") return { state: "ok", listed: true, fullyPaid };
    return { state: "blocked", source: "pago_online", message: brake.message, entry: null, failed: auto.failed, requirement: auto.requirement };
  } catch (e) {
    return unread(e instanceof Error ? e.message : String(e));
  }
}

/**
 * La versión corta para crear una guía: el mensaje que la frena, o null. Lo
 * que no se pudo leer también frena (una guía no se crea a ciegas).
 */
export async function prepayGuideBlock(admin: SupabaseClient, order: string | PrepayOrderRow): Promise<string | null> {
  const check = await prepayOrderCheck(admin, order, "guia");
  return check.state === "ok" ? null : check.message;
}

// ── Lista, altas y bajas a mano ─────────────────────────────────────────────

/** Las altas de las organizaciones, vivas y quitadas, lo más reciente primero. */
export async function listPrepayEntries(
  admin: SupabaseClient,
  orgIds: readonly string[],
  opts: { phone?: string | null } = {},
): Promise<PrepayEntryRow[]> {
  if (!orgIds.length) return [];
  const rows = await allCourierRows<PrepayEntryRow>((from, to) => {
    let q = admin.from("prepay_list_entries").select(PREPAY_ENTRY_COLUMNS).in("org_id", [...orgIds]);
    if (opts.phone) q = q.eq("phone", opts.phone);
    return q.order("added_at", { ascending: false }).order("id").range(from, to) as unknown as Page<PrepayEntryRow>;
  });
  return rows;
}

export type PrepayWriteResult = { ok: true; entry: PrepayEntryRow } | { ok: false; error: string };

/** Agregar a mano. Si el celular ya está en la lista, lo dice y no crea otra. */
export async function addPrepayEntry(
  admin: SupabaseClient,
  input: { orgId: string; phone: string; reason: string; actor: string | null; orderName?: string | null; now?: Date },
): Promise<PrepayWriteResult> {
  const phone = prepayPhoneKey(input.phone);
  if (!phone) return { ok: false, error: "Escribe un celular peruano de 9 dígitos que empiece por 9." };
  const problem = prepayReasonProblem(input.reason);
  if (problem) return { ok: false, error: problem };
  const existing = await prepayLookup(admin, input.orgId, phone);
  if (existing.state === "unread") return { ok: false, error: "No se pudo leer la lista. Intenta de nuevo." };
  if (existing.state === "listed") return { ok: false, error: "Ese celular ya está en la lista." };
  const evidence: PrepayEvidence = { kind: "manual", order_name: input.orderName ?? null };
  const { data, error } = await admin
    .from("prepay_list_entries")
    .insert({
      org_id: input.orgId,
      phone,
      source: "manual",
      reason: input.reason.trim(),
      evidence,
      added_by: input.actor,
      added_at: (input.now ?? new Date()).toISOString(),
    })
    .select(PREPAY_ENTRY_COLUMNS)
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return { ok: false, error: "Ese celular ya está en la lista." };
    if (isMissingPrepayTable(error)) return { ok: false, error: "Falta la migración 0309 en la base de datos." };
    return { ok: false, error: "No se pudo agregar. Intenta de nuevo." };
  }
  return { ok: true, entry: data as PrepayEntryRow };
}

/**
 * Quitar a mano un alta viva, con motivo. La fila queda como historia.
 *
 * LO QUE YA SE SABÍA SE GUARDA CON LA BAJA (§41.3): los pedidos que hoy
 * disparan el alta de ese celular, leídos con la misma regla y la misma ventana
 * que la pasada automática, van a `removed_known_order_ids`. Así la regla solo
 * lo vuelve a agregar por un pedido que no estaba, y no porque un reporte nuevo
 * del mismo rechazo viejo le movió la fecha. Si esa lectura falla, NO se quita:
 * una baja sin lo sabido no se podría respetar bien, y quitar se puede repetir.
 */
export async function removePrepayEntry(
  admin: SupabaseClient,
  input: { orgId: string; entryId: string; reason: string; actor: string | null; now?: Date },
): Promise<PrepayWriteResult> {
  const problem = prepayReasonProblem(input.reason);
  if (problem) return { ok: false, error: problem };
  const now = input.now ?? new Date();
  const { data: live, error: liveError } = await admin
    .from("prepay_list_entries")
    .select("id,phone")
    .eq("id", input.entryId)
    .eq("org_id", input.orgId)
    .is("removed_at", null)
    .maybeSingle();
  if (liveError) {
    if (isMissingPrepayTable(liveError)) return { ok: false, error: "Falta la migración 0309 en la base de datos." };
    return { ok: false, error: "No se pudo quitar. Intenta de nuevo." };
  }
  const phone = (live as { phone?: string } | null)?.phone;
  if (!phone) return { ok: false, error: "Ese cliente ya no estaba en la lista." };
  let known: string[];
  try {
    known = prepayKnownOrderIdsOf((await prepayTriggersByPhone(admin, input.orgId, now)).byPhone.get(phone) ?? []);
  } catch {
    return { ok: false, error: "No se pudieron leer los pedidos de este cliente para guardar la baja. Intenta de nuevo." };
  }
  const { data, error } = await admin
    .from("prepay_list_entries")
    .update({ removed_at: now.toISOString(), removed_by: input.actor, removed_reason: input.reason.trim(), removed_known_order_ids: known })
    .eq("id", input.entryId)
    .eq("org_id", input.orgId)
    .is("removed_at", null)
    .select(PREPAY_ENTRY_COLUMNS);
  if (error) {
    if (isMissingPrepayTable(error)) return { ok: false, error: "Falta la migración 0309 en la base de datos." };
    return { ok: false, error: "No se pudo quitar. Intenta de nuevo." };
  }
  const entry = ((data ?? []) as PrepayEntryRow[])[0];
  if (!entry) return { ok: false, error: "Ese cliente ya no estaba en la lista." };
  return { ok: true, entry: { ...entry, phone: entry.phone ?? phone } };
}

// ── La posición de la regla ─────────────────────────────────────────────────

export interface PrepaySettingsRow {
  org_id: string;
  auto_mode: PrepayMode;
  last_simulation: unknown;
  last_run: unknown;
  updated_by: string | null;
  updated_at: string | null;
}

/** La fila de la organización; sin fila es «apagado». `missing`: falta la 0309. */
export async function loadPrepaySettings(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ settings: PrepaySettingsRow; missing: boolean; error: string | null }> {
  const empty: PrepaySettingsRow = { org_id: orgId, auto_mode: "apagado", last_simulation: null, last_run: null, updated_by: null, updated_at: null };
  const { data, error } = await admin.from("prepay_list_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (error) return { settings: empty, missing: isMissingPrepayTable(error), error: isMissingPrepayTable(error) ? null : error.message };
  const row = data as Partial<PrepaySettingsRow> | null;
  if (!row) return { settings: empty, missing: false, error: null };
  return {
    settings: { ...empty, ...row, auto_mode: isPrepayMode(row.auto_mode) ? row.auto_mode : "apagado" },
    missing: false,
    error: null,
  };
}

// ── La regla automática ─────────────────────────────────────────────────────

export interface PrepayRunOrgReport {
  orgId: string;
  mode: PrepayMode;
  summary: PrepaySimulationSummary | null;
  error: string | null;
}

export interface PrepayRunReport {
  orgs: PrepayRunOrgReport[];
  error: string | null;
}

/** Las filas de la ventana que pueden disparar un alta, de las tiendas de una organización. */
async function loadTriggerFacts(
  admin: SupabaseClient,
  storeIds: string[],
  sinceIso: string,
): Promise<{ orders: Map<string, PrepayOrderFact>; shipments: PrepayShipmentFact[]; stops: PrepayStopFact[] }> {
  const byStores = <T,>(read: (chunk: string[]) => (from: number, to: number) => Page<T>) =>
    courierRowsByIds(storeIds, async (chunk) => ({ data: await allCourierRows<T>(read(chunk)), error: null })).then((r) => r.data);

  // Por páginas, nunca una sola de 1000 filas (`allCourierRows`).
  const MASTER_COLUMNS =
    "order_id,store_id,order_name,customer_phone,order_created_at,agency_branch,pickup_state,general_status,dispatched_at,returned_at";
  const SHIPMENT_COLUMNS = "id,order_id,courier,reported_status,pickup_state,closed_at,returned_at,created_at";
  const [refusedShipments, swaypShipments, pickupShipments, stops, pickupOrders, agencyOrders] = await Promise.all([
    // Rechazo en la puerta en la etiqueta del courier. Los filtros son amplios
    // (filtros simples, sin `or` con paréntesis que PostgREST tenga que
    // interpretar); la decisión exacta es `guideDoorRejection`, en
    // lib/prepay-list.ts. El `REFUSED` de Aliclik:
    byStores<PrepayShipmentFact & { id: string }>((chunk) => (from, to) =>
      admin
        .from("shipments")
        .select(SHIPMENT_COLUMNS)
        .in("store_id", chunk)
        .gte("created_at", sinceIso)
        .ilike("reported_status", "REFUSED%")
        .order("id")
        .range(from, to) as unknown as Page<PrepayShipmentFact & { id: string }>,
    ),
    // …y las novedades de Swayp/Fénix (la 15 y la 16 son rechazo).
    byStores<PrepayShipmentFact & { id: string }>((chunk) => (from, to) =>
      admin
        .from("shipments")
        .select(SHIPMENT_COLUMNS)
        .in("store_id", chunk)
        .in("courier", ["swayp", "fenix"])
        .gte("created_at", sinceIso)
        .like("reported_status", "Swayp · %")
        .order("id")
        .range(from, to) as unknown as Page<PrepayShipmentFact & { id: string }>,
    ),
    // No recogido: el estado de recojo de la guía de agencia.
    byStores<PrepayShipmentFact & { id: string }>((chunk) => (from, to) =>
      admin
        .from("shipments")
        .select(SHIPMENT_COLUMNS)
        .in("store_id", chunk)
        .gte("created_at", sinceIso)
        .in("pickup_state", ["retorno_iniciado", "devuelto_al_origen", "devuelto"])
        .order("id")
        .range(from, to) as unknown as Page<PrepayShipmentFact & { id: string }>,
    ),
    // El «rechazado» del motorizado propio (Grupo GF).
    byStores<PrepayStopFact & { id: string }>((chunk) => (from, to) =>
      admin
        .from("delivery_stops")
        .select("id,order_id,status,outcome_reason,reported_at")
        .in("store_id", chunk)
        .eq("outcome_reason", "rechazado")
        .gte("reported_at", sinceIso)
        .order("id")
        .range(from, to) as unknown as Page<PrepayStopFact & { id: string }>,
    ),
    // El pedido de agencia que no se recogió, visto desde el Master: su estado
    // de recojo…
    byStores<PrepayOrderFact>((chunk) => (from, to) =>
      admin
        .from("order_master")
        .select(MASTER_COLUMNS)
        .in("store_id", chunk)
        .gte("order_created_at", sinceIso)
        .in("pickup_state", ["retorno_iniciado", "devuelto_al_origen", "devuelto"])
        .order("order_id")
        .range(from, to) as unknown as Page<PrepayOrderFact>,
    ),
    // …o que salió a la agencia y terminó devuelto o anulado.
    byStores<PrepayOrderFact>((chunk) => (from, to) =>
      admin
        .from("order_master")
        .select(MASTER_COLUMNS)
        .in("store_id", chunk)
        .gte("order_created_at", sinceIso)
        .not("agency_branch", "is", null)
        .not("dispatched_at", "is", null)
        .in("general_status", ["devuelto", "anulado"])
        .order("order_id")
        .range(from, to) as unknown as Page<PrepayOrderFact>,
    ),
  ]);

  const shipments = [...refusedShipments, ...swaypShipments, ...pickupShipments];
  const orders = new Map<string, PrepayOrderFact>([...pickupOrders, ...agencyOrders].map((o) => [o.order_id, o]));
  const missing = [
    ...new Set([...shipments.map((s) => s.order_id), ...stops.map((s) => s.order_id)].filter((id): id is string => !!id && !orders.has(id))),
  ];
  const more = (
    await courierRowsByIds(missing, (chunk) =>
      admin
        .from("order_master")
        .select(MASTER_COLUMNS)
        .in("order_id", chunk) as unknown as Page<PrepayOrderFact>,
    )
  ).data;
  const stores = new Set(storeIds);
  const since = Date.parse(sinceIso);
  for (const o of more) {
    if (!stores.has(o.store_id)) continue;
    if (o.order_created_at && Date.parse(o.order_created_at) < since) continue;
    orders.set(o.order_id, o);
  }
  return { orders, shipments, stops };
}

/** Todas las altas (vivas y quitadas) de la organización, por celular. */
async function entriesByPhone(admin: SupabaseClient, orgId: string): Promise<Map<string, PrepayEntryFact[]>> {
  const rows = await allCourierRows<PrepayEntryRow>((from, to) =>
    admin
      .from("prepay_list_entries")
      .select("id,phone,source,added_at,removed_at,evidence,removed_known_order_ids")
      .eq("org_id", orgId)
      .order("id")
      .range(from, to) as unknown as Page<PrepayEntryRow>,
  );
  const out = new Map<string, PrepayEntryFact[]>();
  for (const r of rows) out.set(r.phone, [...(out.get(r.phone) ?? []), r]);
  return out;
}

/**
 * Los hechos de la ventana de una organización, por celular canónico: la misma
 * lectura y la misma regla para la pasada automática y para lo que se guarda
 * al quitar a alguien (`removePrepayEntry`). Lanza si la base falla.
 */
async function prepayTriggersByPhone(
  admin: SupabaseClient,
  orgId: string,
  now: Date,
): Promise<{ byPhone: Map<string, PrepayTrigger[]>; withoutPhone: number }> {
  const { data: storeRows, error: storesError } = await admin.from("stores").select("id").eq("org_id", orgId);
  if (storesError) throw new Error(`leer las tiendas: ${storesError.message}`);
  const storeIds = ((storeRows ?? []) as { id: string }[]).map((s) => s.id);
  const sinceIso = new Date(now.getTime() - PREPAY_LOOKBACK_DAYS * 86_400_000).toISOString();
  const byPhone = new Map<string, PrepayTrigger[]>();
  if (!storeIds.length) return { byPhone, withoutPhone: 0 };

  const facts = await loadTriggerFacts(admin, storeIds, sinceIso);
  const shipmentsByOrder = new Map<string, PrepayShipmentFact[]>();
  for (const s of facts.shipments) if (s.order_id) shipmentsByOrder.set(s.order_id, [...(shipmentsByOrder.get(s.order_id) ?? []), s]);
  const stopsByOrder = new Map<string, PrepayStopFact[]>();
  for (const s of facts.stops) if (s.order_id) stopsByOrder.set(s.order_id, [...(stopsByOrder.get(s.order_id) ?? []), s]);

  let withoutPhone = 0;
  for (const order of facts.orders.values()) {
    const triggers = prepayTriggersOfOrder({ order, shipments: shipmentsByOrder.get(order.order_id), stops: stopsByOrder.get(order.order_id) });
    if (!triggers.length) continue;
    const phone = prepayPhoneKey(order.customer_phone);
    if (!phone) {
      withoutPhone++;
      continue;
    }
    byPhone.set(phone, [...(byPhone.get(phone) ?? []), ...triggers]);
  }
  return { byPhone, withoutPhone };
}

/** Lo que la regla haría con una organización: candidatos y decisiones. Sin escribir. */
export async function computePrepayCandidates(
  admin: SupabaseClient,
  orgId: string,
  now: Date,
): Promise<{ adds: { phone: string; reason: string; evidence: PrepayEvidence; triggers: PrepayTrigger[] }[]; summary: Omit<PrepaySimulationSummary, "at" | "mode"> }> {
  const { byPhone, withoutPhone } = await prepayTriggersByPhone(admin, orgId, now);
  const empty = { phonesWithFacts: 0, wouldAdd: 0, alreadyListed: 0, respectedRemovals: 0, withoutPhone: 0, byKind: { rechazo_en_puerta: 0, no_recogio_en_agencia: 0 }, samples: [] as string[] };

  const entries = await entriesByPhone(admin, orgId);
  const adds: { phone: string; reason: string; evidence: PrepayEvidence; triggers: PrepayTrigger[] }[] = [];
  const summary = { ...empty, byKind: { rechazo_en_puerta: 0, no_recogio_en_agencia: 0 }, samples: [] as string[], phonesWithFacts: byPhone.size, withoutPhone };
  for (const [phone, triggers] of byPhone) {
    const decision = prepayAutoDecision({ triggers, entries: entries.get(phone) ?? [] });
    if (!decision.add) {
      if (decision.why === "ya_en_lista") summary.alreadyListed++;
      else if (decision.why === "quitado_sin_hecho_nuevo") summary.respectedRemovals++;
      continue;
    }
    adds.push({ phone, reason: decision.reason, evidence: decision.evidence, triggers: decision.triggers });
    summary.wouldAdd++;
    if (decision.evidence.kind === "auto") {
      if (decision.evidence.counts.rechazo_en_puerta) summary.byKind.rechazo_en_puerta++;
      if (decision.evidence.counts.no_recogio_en_agencia) summary.byKind.no_recogio_en_agencia++;
      for (const o of decision.evidence.orders) {
        if (summary.samples.length >= PREPAY_SIMULATION_SAMPLES) break;
        if (o.order_name && !summary.samples.includes(o.order_name)) summary.samples.push(o.order_name);
      }
    }
  }
  return { adds, summary };
}

/** Escribe las altas nuevas por lotes. Idempotente: un celular que ya tiene alta viva se salta. */
async function insertAutoEntries(
  admin: SupabaseClient,
  orgId: string,
  adds: { phone: string; reason: string; evidence: PrepayEvidence }[],
  nowIso: string,
): Promise<{ inserted: number; error: string | null }> {
  let inserted = 0;
  let lastError: string | null = null;
  const rowOf = (a: { phone: string; reason: string; evidence: PrepayEvidence }) => ({
    org_id: orgId,
    phone: a.phone,
    source: "auto",
    reason: a.reason,
    evidence: a.evidence,
    added_by: null,
    added_at: nowIso,
  });
  for (let i = 0; i < adds.length; i += 100) {
    const batch = adds.slice(i, i + 100);
    const { error } = await admin.from("prepay_list_entries").insert(batch.map(rowOf));
    if (!error) {
      inserted += batch.length;
      continue;
    }
    // Una carrera (otra pasada, un alta a mano entre la lectura y el lote):
    // el índice único rechaza el lote entero. Se reintenta uno por uno y se
    // saltan los que ya estaban.
    for (const a of batch) {
      const { error: one } = await admin.from("prepay_list_entries").insert(rowOf(a));
      if (!one) inserted++;
      else if (one.code !== "23505") lastError = one.message ?? "error de la base";
    }
  }
  return { inserted, error: lastError };
}

/**
 * LA PASADA DE LA REGLA AUTOMÁTICA. Por organización, según su posición (o la
 * que se pida, para «Simular ahora»):
 *   * `apagado`: nada.
 *   * `simulacion`: calcula quién entraría y guarda el resumen en
 *     `prepay_list_settings.last_simulation` (cuentas y nombres de pedido,
 *     nunca celulares). No escribe altas.
 *   * `activo`: escribe las altas nuevas (por lotes) y guarda el resumen en
 *     `last_run`. Correrla dos veces no duplica nada.
 */
export async function runPrepayAutoRule(
  admin: SupabaseClient,
  opts: { orgId?: string; mode?: PrepayMode; now?: Date } = {},
): Promise<PrepayRunReport> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const report: PrepayRunReport = { orgs: [], error: null };

  let targets: { orgId: string; mode: PrepayMode }[];
  if (opts.orgId) {
    const { settings, missing, error } = await loadPrepaySettings(admin, opts.orgId);
    if (missing) return { orgs: [], error: "La lista de pago adelantado aún no está instalada en la base de datos (0309)." };
    if (error) return { orgs: [], error: `leer la posición de la regla: ${error}` };
    targets = [{ orgId: opts.orgId, mode: opts.mode ?? settings.auto_mode }];
  } else {
    const { data, error } = await admin.from("prepay_list_settings").select("org_id,auto_mode").neq("auto_mode", "apagado");
    if (error) {
      if (isMissingPrepayTable(error)) return { orgs: [], error: null };
      return { orgs: [], error: `leer la posición de la regla: ${error.message}` };
    }
    targets = ((data ?? []) as { org_id: string; auto_mode: string }[])
      .filter((r) => isPrepayMode(r.auto_mode))
      .map((r) => ({ orgId: r.org_id, mode: r.auto_mode as PrepayMode }));
  }

  for (const { orgId, mode } of targets) {
    if (mode === "apagado") {
      report.orgs.push({ orgId, mode, summary: null, error: null });
      continue;
    }
    try {
      const { adds, summary: counts } = await computePrepayCandidates(admin, orgId, now);
      const summary: PrepaySimulationSummary = { at: nowIso, mode, ...counts };
      if (mode === "activo") {
        const written = await insertAutoEntries(admin, orgId, adds, nowIso);
        summary.inserted = written.inserted;
        summary.error = written.error;
      }
      // Guardar el resumen también puede fallar, y entonces el panel seguiría
      // mostrando el anterior como si fuera de hoy: se reporta como error (el
      // cron contesta 502 y «Simular ahora» lo dice).
      const { error: saveError } = await admin
        .from("prepay_list_settings")
        .upsert(mode === "activo" ? { org_id: orgId, last_run: summary } : { org_id: orgId, last_simulation: summary }, { onConflict: "org_id" });
      const saveMessage = saveError ? `no se pudo guardar el resumen: ${saveError.message ?? "error de la base"}` : null;
      const orgError = [summary.error, saveMessage].filter(Boolean).join(" · ") || null;
      report.orgs.push({ orgId, mode, summary, error: orgError });
      if (saveMessage) report.error = saveMessage;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      report.orgs.push({ orgId, mode, summary: null, error: message });
      report.error = message;
    }
  }
  return report;
}

/** Para la ficha: lo que se muestra de un alta (motivo, origen y la evidencia sin celulares). */
export function prepayEntryView(entry: PrepayEntryRow): {
  id: string;
  source: "auto" | "manual";
  reason: string;
  addedAt: string;
  evidence: PrepayEvidence;
} {
  return { id: entry.id, source: entry.source, reason: entry.reason, addedAt: entry.added_at, evidence: parsePrepayEvidence(entry.evidence) };
}

