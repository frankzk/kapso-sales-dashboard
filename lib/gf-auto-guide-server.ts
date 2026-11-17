import "server-only";

// La pasada de la «Guía GF automática» (MOM §29.17, owner 15-11-2026). La regla
// —qué pedido entra, a qué hora, qué se avisa— está en lib/gf-auto-guide.ts; la
// creación, en lib/gf-courier-guide.ts (`createGfGuideFor`), la misma que usa la
// tarjeta GF Courier de la Mesa de ruta. Mismo esqueleto que la guía Aliclik
// del día programado (lib/aliclik-scheduled-server.ts): un hecho y UNA alerta
// por pedido que falla, y un intento por pedido y día.
//
// SIMULACIÓN. Como los reintentos de Lima (lib/lima-retry-auto-server.ts), deja
// un renglón por pedido y día en `gf_auto_guide_log` con lo que Activo habría
// hecho, y nada más: ni POST a GF, ni hechos en el historial, ni Telegram. Para
// decirlo hace las mismas lecturas que `createGfGuideFor` hasta antes del POST
// (salidas GF, líneas, pagos validados y `buildGfOrderInput`) y compara los SKU
// con el catálogo de la tienda en GF (GET /v1/products, solo lectura). La
// cobertura del distrito solo la responde GF al crear: la simulación no la sabe.
//
// LO QUE NO ES UN FALLO Y NO AVISA. Que el pedido ya tenga guía de cualquier
// courier y el Master no lo haya recalculado (se recalcula), que otra creación
// del mismo pedido esté en marcha (una persona en la Mesa de ruta, o un timeout
// cuya intención resuelve `gf-reconcile`), que sea acompañante (§32), ni que
// tenga un acuerdo de Repro Lima con la clienta: el acuerdo decide el día y el
// courier (owner, 15-11-2026; §9.5).

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { limaTodayKey } from "@/lib/shipments";
import { limaTimeHHMM } from "@/lib/aliclik-geo";
import { sendTelegramToAll } from "@/lib/telegram";
import { telegramTarget } from "@/lib/aliclik-scheduled-server";
import { activeAliclikBlocker } from "@/lib/aliclik-guide";
import { createGfGuideFor, loadGfStore, type GfGuideResult } from "@/lib/gf-courier-guide";
import { buildGfOrderInput } from "@/lib/gf-courier-order";
import { isWebPrepaid } from "@/lib/order-paid";
import { GF_COURIER } from "@/lib/gf-courier-track";
import { loadGfProducts } from "@/lib/gf-courier-catalog-server";
import type { GfCatalogProduct } from "@/lib/gf-courier-catalog";
import { loadCompanionRides } from "@/lib/order-companion-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import { CUSTOMER_PAYMENT_KINDS } from "@/lib/pending-voucher";
import { wooTerritorio } from "@/lib/woo-territorio";
import { formatLimaDateTime } from "@/lib/automations-catalog";
import {
  GF_AUTO_FAILED,
  GF_AUTO_GUIDE_REASON,
  GF_AUTO_FAILED_NOTE,
  GF_AUTO_POLICY,
  gfAutoActivoBlocker,
  gfAutoFailureTelegram,
  gfAutoModeFrom,
  gfAutoOutcomeLabel,
  gfAutoReproAgreement,
  gfAutoReproDetail,
  gfAutoSimulationDetail,
  gfAutoSkip,
  gfAutoTriedOn,
  gfCatalogProblem,
  isGfAutoOutcome,
  type GfAutoMode,
  type GfAutoOutcome,
  type GfAutoReproCase,
} from "@/lib/gf-auto-guide";
import type { OrderMasterRow } from "@/lib/types";

/** El tiempo de una pasada. Lo que no entra se intenta en la siguiente hora. */
const TIME_BUDGET_MS = 240_000;

export const GF_AUTO_SETTINGS = "gf_auto_guide_settings";
export const GF_AUTO_LOG = "gf_auto_guide_log";

/** Lo que se dice de un pedido con otra creación de su guía GF en marcha. */
const IN_FLIGHT_DETAIL =
  "Hay otra creación de la guía GF de este pedido en marcha (o GF no respondió a tiempo): no se pide otra; se mira en la pasada siguiente.";

/**
 * Lo que pasó con un pedido en una pasada: lo del registro del panel
 * (`GfAutoOutcome`) y lo que solo va en la respuesta del cron.
 *   * `ya_intentado`  — falló hoy: es de una persona hasta mañana.
 *   * `acompanante`   — viaja en la caja de otro pedido (§32).
 *   * `ya_tiene_guia` — tiene una guía viva de cualquier courier y el Master
 *                       aún no lo había recalculado.
 *   * `acuerdo_repro_lima` — tiene un acuerdo de Repro Lima con la clienta
 *                       (`gfAutoReproAgreement`): el acuerdo decide el día y el
 *                       courier, no la pasada (owner, 15-11-2026; §9.5).
 *   * `error`         — algo inesperado al revisarlo: no se creó ni se avisó;
 *                       queda en el error de la pasada y se mira en la siguiente.
 */
export type GfAutoItemOutcome = GfAutoOutcome | "ya_intentado" | "acompanante" | "acuerdo_repro_lima" | "ya_tiene_guia" | "error";

export interface GfAutoItem {
  orderId: string;
  orderName: string | null;
  storeId: string;
  /** La posición guardada de la organización (con `dry`, aunque esté apagada). */
  mode: GfAutoMode;
  outcome: GfAutoItemOutcome;
  detail?: string | null;
  guide?: string | null;
  telegram?: boolean;
}

export interface GfAutoReport {
  today: string;
  limaHour: number;
  /** Siempre null desde el 16-11-2026: la pasada corre todo el día (se conserva por quien lee el informe). */
  skipped: "fuera_de_horario" | null;
  candidates: number;
  created: number;
  failed: number;
  simulated: number;
  /** Se agotó el tiempo antes de terminar. Lo que quedó va en la pasada siguiente. */
  stopped: "tiempo" | null;
  items: GfAutoItem[];
  error: string | null;
}

export interface GfReadyStore {
  id: string;
  orgId: string;
  name: string;
  token: string;
}

/**
 * Las tiendas activas con GF Courier por API habilitado y su token: las dos
 * llaves de la tienda (§29.17). La del servidor (`GF_COURIER_WRITE_ENABLED`) la
 * mira quien llama: la simulación corre sin ella.
 */
export async function loadGfReadyStores(
  admin: SupabaseClient,
  opts: { orgId?: string } = {},
): Promise<{ stores: GfReadyStore[]; error: string | null }> {
  let query = admin.from("stores").select("id,org_id,name").eq("status", "active").eq("gf_courier_enabled", true);
  if (opts.orgId) query = query.eq("org_id", opts.orgId);
  const { data, error } = await query;
  if (error) return { stores: [], error: error.message };
  const stores: GfReadyStore[] = [];
  for (const s of (data ?? []) as { id: string; org_id: string | null; name: string | null }[]) {
    if (!s.org_id) continue;
    // El token se descifra como lo hace la creación: uno que no se descifra no cuenta.
    const gf = await loadGfStore(admin, s.id);
    if (gf?.enabled && gf.token) stores.push({ id: s.id, orgId: s.org_id, name: s.name ?? "Tienda", token: gf.token });
  }
  return { stores, error: null };
}

/**
 * Las tiendas (de las pedidas) cuya guía GF automática está en Activo: GF
 * Courier por API habilitado y la organización en «activo». Para que Repro
 * Lima no alarme por la guía de mañana que la pasada creará sola (owner,
 * 15-11-2026). Sin descifrar el token: es solo para decidir el tono. Ante un
 * error, ninguna (se alarma como antes).
 */
export async function loadGfAutoActiveStores(admin: SupabaseClient, storeIds: readonly string[]): Promise<string[]> {
  if (!storeIds.length) return [];
  const { data: stores, error } = await admin.from("stores").select("id,org_id").in("id", [...storeIds]).eq("status", "active").eq("gf_courier_enabled", true);
  if (error || !stores?.length) return [];
  const orgIds = [...new Set((stores as { org_id: string | null }[]).map((s) => s.org_id).filter((id): id is string => Boolean(id)))];
  if (!orgIds.length) return [];
  const { data: settings, error: settingsError } = await admin.from(GF_AUTO_SETTINGS).select("org_id,mode").in("org_id", orgIds);
  if (settingsError) return [];
  const active = new Set((settings ?? []).filter((r: { mode: string }) => gfAutoModeFrom(r.mode) === "activo").map((r: { org_id: string }) => r.org_id));
  return (stores as { id: string; org_id: string | null }[]).filter((s) => s.org_id && active.has(s.org_id)).map((s) => s.id);
}

/** La tabla aún no existe (0345 sin aplicar): PostgREST o Postgres. */
function isMissingRelation(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return ["42P01", "42703", "PGRST205", "PGRST204"].includes(error.code ?? "") || /does not exist|could not find/i.test(error.message ?? "");
}

/** Ubicación corta para la alerta: distrito y provincia, sin repetir. */
function placeOf(row: OrderMasterRow): string | null {
  const parts = [row.district, row.province].filter((p): p is string => Boolean(p?.trim()));
  return [...new Set(parts)].join(", ") || null;
}

/**
 * Un intento fallido en Activo: avisa por Telegram de ESE pedido y deja el
 * hecho en su historial. El hecho va después del aviso a propósito, como en la
 * guía Aliclik del día programado: si no se pudiera escribir, la pasada
 * siguiente lo vuelve a intentar y avisa otra vez — un aviso repetido se lee;
 * uno perdido no.
 */
async function recordFailure(
  admin: SupabaseClient,
  row: OrderMasterRow,
  today: string,
  error: string,
  extra: { allowed?: unknown[] } = {},
): Promise<boolean> {
  let telegram = false;
  try {
    const target = await telegramTarget(admin, row.store_id);
    if (target) {
      const res = await sendTelegramToAll(
        target.token,
        target.chats,
        gfAutoFailureTelegram({
          storeName: target.storeName,
          orderName: row.order_name,
          customerName: row.customer_name,
          place: placeOf(row),
          date: today,
          scheduledOn: row.dispatch_scheduled_on ?? null,
          error,
          url: `${env.siteUrl()}/dashboard/pedidos?abrir=${encodeURIComponent(row.order_id)}`,
        }),
      );
      telegram = res.sent > 0;
    }
  } catch {
    /* el hecho queda igual en el historial */
  }
  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind: GF_AUTO_FAILED,
    occurred_at: new Date().toISOString(),
    actor: null,
    source: "system",
    courier: GF_COURIER,
    reason: error.slice(0, 2000),
    note: GF_AUTO_FAILED_NOTE,
    payload: {
      date: today,
      policy: GF_AUTO_POLICY,
      telegram,
      scheduled_on: row.dispatch_scheduled_on ?? null,
      // DISTRICT_NOT_COVERED trae la lista de distritos válidos de GF.
      ...(extra.allowed?.length ? { allowed: extra.allowed.slice(0, 80) } : {}),
    },
  });
  return telegram;
}

/** ¿Hay una intención de crear su guía GF todavía pendiente? (una persona creándola, o un timeout). */
async function pendingGfIntent(admin: SupabaseClient, orderId: string): Promise<{ pending: boolean; error?: string }> {
  const { data, error } = await admin.from("gf_order_requests").select("id").eq("order_id", orderId).eq("status", "pending").limit(1);
  if (error) return { pending: false, error: `No se pudieron leer las creaciones GF del pedido: ${error.message}` };
  return { pending: (data ?? []).length > 0 };
}

type CatalogRead = { products: GfCatalogProduct[] } | { error: string };

/**
 * Lo que `createGfGuideFor` comprobaría antes del POST, sin escribir nada: las
 * MISMAS lecturas y el mismo `buildGfOrderInput` (si cambian allí, cambian aquí;
 * test/gf-auto-guide.test.ts lo vigila). Más el catálogo de la tienda en GF, que
 * la creación no mira y GF sí: SKU_NOT_FOUND y OUT_OF_STOCK.
 */
async function previewGfGuide(
  admin: SupabaseClient,
  row: OrderMasterRow,
  catalog: () => Promise<CatalogRead>,
): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const orderId = row.order_id;
  const shipments = await admin.from("shipments").select("id,delivery_status,returned_at").eq("order_id", orderId).eq("courier", GF_COURIER);
  if (shipments.error) return { ok: false, error: shipments.error.message };
  if ((shipments.data ?? []).some((s) => ["pendiente", "en_ruta"].includes(s.delivery_status) && !s.returned_at))
    return { ok: false, error: "El pedido ya tiene una guía de GF Courier viva." };

  const order = await admin.from("orders").select("name,line_items,raw,financial_status,payment_gateway,total_refunded").eq("id", orderId).maybeSingle();
  if (order.error || !order.data) return { ok: false, error: "No se pudo leer el pedido." };
  const payments = await admin.from("order_payments").select("amount").eq("order_id", orderId).in("kind", [...CUSTOMER_PAYMENT_KINDS]).eq("validation_status", "validado");
  if (payments.error) return { ok: false, error: `No se pudieron leer los pagos del pedido: ${payments.error.message}` };
  const advance = (payments.data ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const sequence = (shipments.data ?? []).length + 1;
  const externalId = `${row.order_name ?? order.data.name}${sequence > 1 ? `-S${sequence}` : ""}`.slice(0, 100);
  const lines = ((order.data.line_items ?? []) as { sku?: string | null; title?: string | null; quantity?: unknown; price?: unknown }[]).map((l) => ({
    sku: l.sku ?? null, title: l.title ?? null, quantity: Number(l.quantity), price: Number(l.price),
  }));
  const built = buildGfOrderInput({
    externalId, customerName: row.customer_name, customerPhone: row.customer_phone, district: row.district,
    ubigeo: wooTerritorio(order.data.raw)?.code ?? null, address: row.address ?? null, reference: row.reference ?? null,
    latitude: row.latitude ?? null, longitude: row.longitude ?? null, orderTotal: Number(row.order_total), advancePaid: advance,
    webPrepaid: isWebPrepaid({ financialStatus: order.data.financial_status, totalRefunded: Number(order.data.total_refunded ?? 0), paymentGateway: order.data.payment_gateway }),
    lines,
  });
  if (!built.ok) return { ok: false, error: built.reason };

  const read = await catalog();
  if ("products" in read) {
    const problem = gfCatalogProblem(built.input.items.map((item) => item.sku), read.products);
    if (problem) return { ok: false, error: problem };
  }
  return {
    ok: true,
    detail: gfAutoSimulationDetail({
      amountToCollect: built.input.payment.amount_to_collect,
      units: lines.reduce((s, l) => s + (Number.isFinite(l.quantity) ? l.quantity : 0), 0),
      district: row.district,
      catalogNote: "error" in read ? `No se pudo leer el catálogo de GF para revisar los SKU (${read.error}).` : null,
    }),
  };
}

/**
 * Una pasada. Sin `dry`, solo de 9:00 a 11:59 de Lima: cada organización en
 * Simulación deja en el registro lo que haría, y cada una en Activo crea (con
 * `GF_COURIER_WRITE_ENABLED`). Con `dry` (el `?dry=1` del cron), «qué haría hoy»
 * para todas las organizaciones con GF Courier, estén como estén, a cualquier
 * hora y sin escribir nada: ni registro, ni hechos, ni Telegram.
 */
export async function runGfAutoGuides(
  admin: SupabaseClient,
  opts: { dry?: boolean; now?: Date; orgId?: string } = {},
): Promise<GfAutoReport> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const dry = !!opts.dry;
  const today = limaTodayKey(now);
  const limaHour = Number(limaTimeHHMM(now).slice(0, 2));
  const report: GfAutoReport = {
    today, limaHour, skipped: null, candidates: 0, created: 0, failed: 0, simulated: 0, stopped: null, items: [], error: null,
  };
  const errors: string[] = [];
  const done = () => {
    report.error = errors.length ? errors.join(" · ") : null;
    return report;
  };


  const ready = await loadGfReadyStores(admin, { orgId: opts.orgId });
  if (ready.error) {
    errors.push(`No se pudieron leer las tiendas con GF Courier: ${ready.error}`);
    return done();
  }
  if (!ready.stores.length) return done();

  // La posición de cada organización: sin fila, Apagado.
  const orgIds = [...new Set(ready.stores.map((s) => s.orgId))];
  const { data: settingsRows, error: settingsError } = await admin.from(GF_AUTO_SETTINGS).select("org_id,mode").in("org_id", orgIds);
  if (settingsError) {
    errors.push(
      isMissingRelation(settingsError)
        ? "Falta la migración 0345 en la base de datos: la guía GF automática no corre."
        : `No se pudo leer la posición de la guía GF automática: ${settingsError.message}`,
    );
    return done();
  }
  const modeByOrg = new Map<string, GfAutoMode>(orgIds.map((id) => [id, "apagado"]));
  for (const r of (settingsRows ?? []) as { org_id: string; mode: string }[]) modeByOrg.set(r.org_id, gfAutoModeFrom(r.mode));

  const writeOk = env.gfCourierWriteEnabled();
  if (!dry && !writeOk && orgIds.some((id) => modeByOrg.get(id) === "activo")) {
    errors.push("GF_COURIER_WRITE_ENABLED está apagado: en Activo no se crea nada (la Simulación sí corre).");
  }
  // Las que hacen algo en esta pasada: con `dry`, todas; si no, Simulación, y
  // Activo solo con la llave del servidor.
  const acting = new Set(
    orgIds.filter((id) => {
      const mode = modeByOrg.get(id);
      return dry || mode === "simulacion" || (mode === "activo" && writeOk);
    }),
  );
  const storeById = new Map(ready.stores.filter((s) => acting.has(s.orgId)).map((s) => [s.id, s]));
  if (!storeById.size) return done();

  // Los pedidos de la pasada: Preparación · Por generar rótulo, sin fecha o
  // programados para hoy o un día que viene. Lima y la fecha los decide
  // `gfAutoSkip` (la misma regla que las pruebas).
  let rows: OrderMasterRow[];
  try {
    rows = (
      await courierRowsByIds([...storeById.keys()], async (chunk) => ({
        data: await allCourierRows<OrderMasterRow>(
          (from, to) =>
            admin
              .from("order_master")
              .select("*")
              .in("store_id", chunk)
              .eq("macro_stage", "preparacion")
              .eq("macro_substage", "por_generar_rotulo")
              .or(`dispatch_scheduled_on.is.null,dispatch_scheduled_on.gte.${today}`)
              .order("order_id")
              .range(from, to) as unknown as PromiseLike<{ data: OrderMasterRow[] | null; error: { message: string } | null }>,
        ),
        error: null,
      }))
    ).data;
  } catch (e) {
    errors.push(`No se pudieron leer los pedidos por generar rótulo: ${e instanceof Error ? e.message : String(e)}`);
    return done();
  }
  // El más antiguo primero: es el que más tiempo lleva esperando su guía.
  const candidates = rows
    .filter((row) => gfAutoSkip(row, today) === null)
    .sort((a, b) => (a.order_created_at ?? "").localeCompare(b.order_created_at ?? "") || a.order_id.localeCompare(b.order_id));
  report.candidates = candidates.length;
  if (!candidates.length) return done();

  // Lo que ya se intentó hoy, los acompañantes (§32) y los casos abiertos de
  // Repro Lima (§9.5). Sin poder leerlos no se crea nada: repetir sería volver a
  // avisar de lo mismo, crearle guía a un acompañante sería un segundo paquete
  // para la misma clienta, y saltarse un acuerdo sería mandarlo otro día o con
  // otro courier que el que la clienta acordó.
  const ids = candidates.map((row) => row.order_id);
  const triedByOrder = new Map<string, { kind: string; payload: unknown }[]>();
  const companions = new Set<string>();
  let reproCases: GfAutoReproCase[] = [];
  try {
    const [tried, rides, cases] = await Promise.all([
      courierRowsByIds(ids, (chunk) =>
        admin.from("order_events").select("order_id,kind,payload").eq("kind", GF_AUTO_FAILED).in("order_id", chunk) as unknown as PromiseLike<{
          data: { order_id: string; kind: string; payload: unknown }[] | null;
          error: { message: string } | null;
        }>,
      ),
      loadCompanionRides(admin, ids),
      courierRowsByIds(ids, (chunk) =>
        admin.from("lima_repro_cases").select("order_id,episode_key,agreed_on,agreed_courier,closed_at").in("order_id", chunk).is("closed_at", null) as unknown as PromiseLike<{
          data: GfAutoReproCase[] | null;
          error: { message: string } | null;
        }>,
      ),
    ]);
    for (const event of tried.data) triedByOrder.set(event.order_id, [...(triedByOrder.get(event.order_id) ?? []), event]);
    // Vinculado como acompañante, preste o no su caja: darle salida propia
    // exige desvincularlo antes (§32.1, reglas 8 y 9).
    const idSet = new Set(ids);
    for (const ride of rides) if (idSet.has(ride.link.companionOrderId)) companions.add(ride.link.companionOrderId);
    reproCases = cases.data;
  } catch (e) {
    errors.push(`No se pudo verificar qué pedidos ya se intentaron hoy o viajan en la caja de otro (ni sus acuerdos de Repro Lima): ${e instanceof Error ? e.message : String(e)}`);
    return done();
  }

  // El catálogo de cada tienda en GF, una vez por pasada y solo si se simula.
  const catalogs = new Map<string, Promise<CatalogRead>>();
  const catalogOf = (store: GfReadyStore) => () => {
    let read = catalogs.get(store.id);
    if (!read) {
      read = loadGfProducts(store.token)
        .then((r): CatalogRead => (r.ok ? { products: r.products } : { error: r.message }))
        .catch((e): CatalogRead => ({ error: e instanceof Error ? e.message : String(e) }));
      catalogs.set(store.id, read);
    }
    return read;
  };

  for (const row of candidates) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      report.stopped = "tiempo";
      break;
    }
    const store = storeById.get(row.store_id)!;
    const mode = modeByOrg.get(store.orgId) ?? "apagado";
    const simulate = dry || mode !== "activo";
    const logMode = simulate ? "simulacion" : "activo";
    const item: GfAutoItem = { orderId: row.order_id, orderName: row.order_name, storeId: row.store_id, mode, outcome: "en_curso" };
    report.items.push(item);
    const label = row.order_name ?? row.order_id;

    // El renglón del panel: uno por pedido, día y modo; la última pasada del día manda.
    const log = async () => {
      if (dry || !isGfAutoOutcome(item.outcome)) return;
      const { error } = await admin.from(GF_AUTO_LOG).upsert(
        {
          org_id: store.orgId, store_id: row.store_id, order_id: row.order_id, order_name: row.order_name, lima_day: today,
          mode: logMode, outcome: item.outcome, guide_code: item.guide ?? null, detail: item.detail ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "order_id,lima_day,mode" },
      );
      if (error) errors.push(`No se pudo guardar el registro de ${label}: ${error.message}`);
    };
    // En Simulación, «fallo» es lo que diría Activo: sin aviso ni hecho.
    const fail = async (error: string, extra: { allowed?: unknown[] } = {}) => {
      item.outcome = "fallo";
      item.detail = error;
      if (!simulate) {
        report.failed += 1;
        item.telegram = await recordFailure(admin, row, today, error, extra);
      }
      await log();
    };

    if (gfAutoTriedOn(triedByOrder.get(row.order_id) ?? [], today)) {
      item.outcome = "ya_intentado";
      continue;
    }
    if (companions.has(row.order_id)) {
      item.outcome = "acompanante";
      item.detail = "Viaja en la caja de otro pedido: para darle guía propia hay que desvincularlo antes.";
      continue;
    }
    // Un acuerdo de Repro Lima con la clienta decide el día y el courier (§9.5):
    // la guía GF del día acordado la crea Repro Lima; la de otro courier, una
    // persona desde la Mesa de ruta. No es un fallo y no avisa.
    const agreement = gfAutoReproAgreement(row.order_id, reproCases);
    if (agreement) {
      item.outcome = "acuerdo_repro_lima";
      item.detail = gfAutoReproDetail(agreement);
      continue;
    }

    try {
      // Una guía viva de CUALQUIER courier (una persona creó la de Aliclik
      // antes de la pasada): no es un fallo. Se recalcula para que salga de la lista.
      const live = await activeAliclikBlocker(admin, row.order_id);
      if (live.guide) {
        item.outcome = "ya_tiene_guia";
        item.detail = live.guide.guide_code ?? null;
        if (!dry) await recomputeOrderMasterSafe(admin, [row.order_id]);
        continue;
      }
      if (live.error) {
        await fail(live.error);
        continue;
      }
      const intent = await pendingGfIntent(admin, row.order_id);
      if (intent.error) {
        await fail(intent.error);
        continue;
      }
      if (intent.pending) {
        item.outcome = "en_curso";
        item.detail = IN_FLIGHT_DETAIL;
        await log();
        continue;
      }

      // --- Simulación: lo que Activo haría, sin crear nada afuera. -----------
      if (simulate) {
        const preview = await previewGfGuide(admin, row, catalogOf(store));
        if (!preview.ok) {
          await fail(preview.error);
          continue;
        }
        item.outcome = "simulada";
        item.detail = preview.detail;
        report.simulated += 1;
        await log();
        continue;
      }

      // --- Activo: el mismo camino que la tarjeta de la Mesa de ruta. --------
      let result: GfGuideResult;
      try {
        result = await createGfGuideFor(row.order_id, { userId: null, reason: GF_AUTO_GUIDE_REASON }, admin);
      } catch (e) {
        result = { ok: false, error: `Error inesperado al crear: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (result.ok) {
        item.outcome = "creada";
        item.guide = result.trackingId;
        item.detail = `Envío S/ ${result.shippingCost}${result.adopted ? " · GF ya la tenía: quedó vinculada" : ""}.`;
        report.created += 1;
        await log();
        continue;
      }
      if (result.pending) {
        // Un timeout no es un fallo (§29.17): la intención queda pendiente y se
        // resuelve con la misma clave de idempotencia.
        item.outcome = "en_curso";
        item.detail = result.error;
        await log();
        continue;
      }
      // ¿Ganó otra creación? Una persona pudo crear la guía (de GF o de otro
      // courier) mientras esta pasada corría: eso no es un fallo de la pasada.
      const after = await activeAliclikBlocker(admin, row.order_id);
      if (after.guide) {
        item.outcome = "ya_tiene_guia";
        item.detail = after.guide.guide_code ?? null;
        await recomputeOrderMasterSafe(admin, [row.order_id]);
        continue;
      }
      const busy = await pendingGfIntent(admin, row.order_id);
      if (busy.pending) {
        item.outcome = "en_curso";
        item.detail = IN_FLIGHT_DETAIL;
        await log();
        continue;
      }
      await fail(result.error, { allowed: result.allowed });
    } catch (e) {
      // Lo inesperado no se convierte en aviso: queda en el error de la pasada.
      const message = e instanceof Error ? e.message : String(e);
      item.outcome = "error";
      item.detail = message;
      errors.push(`${label}: ${message}`);
    }
  }

  return done();
}

// ── El panel ────────────────────────────────────────────────────────────────

/** Un renglón de «Hoy y ayer» de la guía GF automática. */
export interface GfAutoLogView {
  id: number;
  day: "hoy" | "ayer";
  orderId: string;
  orderName: string;
  storeId: string;
  /** Lo pone el panel, que ya leyó las tiendas. */
  storeName: string | null;
  mode: "simulacion" | "activo";
  outcome: GfAutoOutcome | null;
  outcomeLabel: string;
  guideCode: string | null;
  detail: string | null;
  at: string;
}

export interface GfAutoGuideView {
  /** Falso si la 0345 aún no está: el control se bloquea y todo es Apagado. */
  available: boolean;
  mode: GfAutoMode;
  /** `GF_COURIER_WRITE_ENABLED` está encendido en el servidor. */
  writeEnabled: boolean;
  /** Las tiendas activas con GF Courier por API habilitado y su token. */
  stores: string[];
  /** Por qué Activo no crearía nada ahora (`gfAutoActivoBlocker`), o null. */
  blocker: string | null;
  log: GfAutoLogView[];
  error: string | null;
}

const LOG_LIMIT = 200;

/** La posición, si Activo correría, y lo que hicieron las pasadas de hoy y ayer. */
export async function loadGfAutoGuideView(admin: SupabaseClient, orgId: string, today: string, yesterday: string): Promise<GfAutoGuideView> {
  const writeEnabled = env.gfCourierWriteEnabled();
  const [settingsRes, ready, logRes] = await Promise.all([
    admin.from(GF_AUTO_SETTINGS).select("mode").eq("org_id", orgId).maybeSingle(),
    loadGfReadyStores(admin, { orgId }),
    admin
      .from(GF_AUTO_LOG)
      .select("id,store_id,order_id,order_name,lima_day,mode,outcome,guide_code,detail,updated_at")
      .eq("org_id", orgId)
      .in("lima_day", [today, yesterday])
      .order("updated_at", { ascending: false })
      .limit(LOG_LIMIT),
  ]);
  const stores = ready.stores.map((s) => s.name);
  const blocker = ready.error ? null : gfAutoActivoBlocker({ writeEnabled, readyStores: ready.stores.length });
  const base: GfAutoGuideView = { available: false, mode: "apagado", writeEnabled, stores, blocker, log: [], error: null };
  if (isMissingRelation(settingsRes.error) || isMissingRelation(logRes.error)) return base;
  if (settingsRes.error) return { ...base, error: "No se pudo leer la posición de la guía GF automática: no se puede cambiar ahora." };
  const errors: string[] = [];
  if (ready.error) errors.push("No se pudieron leer las tiendas con GF Courier.");
  if (logRes.error) errors.push("No se pudo leer lo que hizo la guía GF automática hoy y ayer.");
  const rows = (logRes.data ?? []) as {
    id: number;
    store_id: string;
    order_id: string;
    order_name: string | null;
    lima_day: string;
    mode: "simulacion" | "activo";
    outcome: string;
    guide_code: string | null;
    detail: string | null;
    updated_at: string;
  }[];
  return {
    ...base,
    available: true,
    mode: gfAutoModeFrom((settingsRes.data as { mode?: string } | null)?.mode),
    log: rows.map((r) => {
      const outcome = isGfAutoOutcome(r.outcome) ? r.outcome : null;
      return {
        id: r.id,
        day: r.lima_day === today ? "hoy" : "ayer",
        orderId: r.order_id,
        orderName: r.order_name ?? "Pedido",
        storeId: r.store_id,
        storeName: null,
        mode: r.mode,
        outcome,
        outcomeLabel: outcome ? gfAutoOutcomeLabel(outcome, r.mode) : r.outcome,
        guideCode: r.guide_code,
        detail: r.detail,
        at: formatLimaDateTime(r.updated_at),
      };
    }),
    error: errors.length ? errors.join(" ") : null,
  };
}
