import "server-only";

// El PILOTO de la coordenada por dirección (docs/kapta/geocodificacion-propuesta.md):
// mide el geocodificador de Google contra los pedidos cuyo pin ya puso una
// persona, sin tocar ningún pedido.
//
//   · Muestra: pedidos de WooCommerce (`orders.raw ? 'woo'`) de los últimos 7
//     días, con `order_master.latitude`/`longitude` (el pin de la asesora al
//     crear la guía) y cobertura Lima o Provincia COD, sin los pins que son
//     el punto de Google del propio pedido (`googlePinnedOrderIds`, 05-11-2026:
//     los guardó una guía automática). Como mucho 400: el tope
//     diario que el owner pone a la cuota «v3 requests per day» en Google Cloud
//     (el encargo decía 450; con un cupo de 400 los últimos 50 nunca saldrían).
//   · Se consulta la Geocoding API clásica («v3», .../maps/api/geocode/json), no
//     la v4: el candado depende de `location_type` y `partial_match`, que son de
//     la respuesta v3. Si Google contesta OVER_QUERY_LIMIT (cupo agotado, por
//     ejemplo una segunda pasada el mismo día) no se consulta nada más: lo que
//     falta se cuenta como «sin_cupo» y el reporte lo dice.
//   · Cada dirección se geocodifica (lib/geocode-google.ts: la petición, el
//     candado) y el punto que pasa el candado se compara con el pin.
//   · NO ESCRIBE NADA y devuelve solo números agregados: ni direcciones, ni
//     nombres, ni celulares, ni números de pedido, ni en el resultado ni en el
//     registro. La clave tampoco sale de aquí: va en la URL de la consulta y
//     esa URL no se registra nunca.
//   · La medición de LIMA para los reintentos automáticos (`runGeocodeLimaMeasure`,
//     más abajo) usa la misma muestra y la misma cuenta, solo Lima y hasta 150
//     consultas, y guarda esa cuenta (solo números) en `geocode_pilot_runs`.
//
// TIEMPO. Corre dentro de una acción de servidor de Ajustes. La página admite
// 300 s, pero el piloto se queda en ~45 s: 5 consultas a la vez, 6 s como mucho
// cada una, y a los 38 s no empieza ninguna más. Lo que quedó sin consultar se
// cuenta como «sin_tiempo» y el reporte dice que se cortó. Para que un corte no
// deje fuera a una cobertura entera, la cola alterna Lima y Provincia COD.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inPeru } from "@/lib/chatby-conversation";
import { limaTodayKey } from "@/lib/shipments";
import {
  GEOCODE_DAILY_QUOTA,
  GEOCODE_LIMA_CAP,
  GEOCODE_PILOT_COVERAGES,
  QUOTA_STATUS,
  GOOGLE_GEOCODE_ENDPOINT,
  aggregateGeocodePilot,
  geocodeLimaRunSummary,
  geocodeQueryString,
  geocodeRequestParams,
  geocodeSafeguard,
  geocodeUsableForAutoGuide,
  haversineMeters,
  masterPinIsGoogle,
  parseGeocodeLimaRunSummary,
  parseGeocodeResponse,
  type GeocodeCoverage,
  type GeocodeLimaRunSummary,
  type GeocodeParsed,
  type GeocodePilotReason,
  type GeocodePilotReport,
  type GeocodePrecision,
  type GeocodePilotSample,
  type GeocodeRequestParams,
} from "@/lib/geocode-google";

export const GEOCODE_PILOT = {
  days: 7,
  /** = GEOCODE_DAILY_QUOTA: una pasada cabe entera en el cupo diario. */
  cap: GEOCODE_DAILY_QUOTA,
  concurrency: 5,
  /** Tope de cada consulta a Google. */
  requestTimeoutMs: 6_000,
  /** Pasado esto no se empieza ninguna consulta más (la que está en vuelo termina o vence). */
  budgetMs: 38_000,
  /** Filas del Master por página (PostgREST corta en 1.000). */
  pageSize: 500,
  /** Páginas como mucho: la muestra nunca recorre más de 5.000 filas. */
  maxPages: 10,
  /** Ids por consulta a `orders` (la URL de un `in` largo tiene límite). */
  idChunk: 100,
} as const;

/** Lo que se lee de cada pedido de la muestra. Se queda en memoria y no sale de aquí. */
interface PilotOrder {
  coverage: GeocodeCoverage;
  address: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
  pin: { lat: number; lng: number };
}

interface MasterRow {
  order_id: string;
  coverage: string | null;
  address: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  geo_source: string | null;
}

const isPilotCoverage = (c: string | null): c is GeocodeCoverage =>
  (GEOCODE_PILOT_COVERAGES as readonly string[]).includes(c ?? "");

/** Los ids de `ids` que son pedidos de WooCommerce (`orders.raw ? 'woo'`). */
async function wooOrderIds(admin: SupabaseClient, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += GEOCODE_PILOT.idChunk) {
    const chunk = ids.slice(i, i + GEOCODE_PILOT.idChunk);
    const { data, error } = await admin.from("orders").select("id").in("id", chunk).not("raw->woo", "is", null);
    if (error) throw new Error(`leer los pedidos: ${error.message}`);
    for (const r of (data ?? []) as { id: string }[]) out.add(r.id);
  }
  return out;
}

/**
 * Los pedidos cuyo pin del Master es el punto que dio Google (05-11-2026): la
 * caché `order_geocodes` tiene un punto bueno (`ok`) y el Master está a
 * `GEOCODE_SAME_PIN_METERS` o menos de él (`masterPinIsGoogle`). Pasa cuando
 * una guía automática se creó con la ubicación por dirección: la guía guarda
 * el punto y el Master lo toma como pin. No lo puso una persona. Lanza si no se
 * pudo leer la caché.
 */
export async function googlePinnedOrderIds(
  admin: SupabaseClient,
  rows: readonly {
    order_id: string;
    latitude?: number | string | null;
    longitude?: number | string | null;
    geo_source?: string | null;
  }[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const withPin = rows.filter((r) => r.latitude != null && r.longitude != null && r.geo_source !== "manual");
  const byId = new Map(withPin.map((r) => [r.order_id, r]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += GEOCODE_PILOT.idChunk) {
    const chunk = ids.slice(i, i + GEOCODE_PILOT.idChunk);
    const { data, error } = await admin
      .from("order_geocodes")
      .select("order_id,latitude,longitude")
      .in("order_id", chunk)
      .eq("ok", true);
    if (error) throw new Error(`leer la caché de Google: ${error.message}`);
    for (const g of (data ?? []) as { order_id: string; latitude: number | null; longitude: number | null }[]) {
      const master = byId.get(g.order_id);
      if (master && masterPinIsGoogle(master, g)) out.add(g.order_id);
    }
  }
  return out;
}

/**
 * La muestra: los pedidos más recientes primero, hasta `cap`, y la cola
 * alternando coberturas. Solo pins que caen en el Perú: otro es un error de
 * tipeo y no sirve de referencia.
 */
export async function loadGeocodePilotSample(admin: SupabaseClient, storeId: string, now: Date): Promise<PilotOrder[]> {
  return loadPilotSample(admin, { storeIds: [storeId], coverages: GEOCODE_PILOT_COVERAGES, cap: GEOCODE_PILOT.cap, now });
}

/**
 * La muestra de una o varias tiendas y una o varias coberturas, la misma regla
 * que el piloto: WooCommerce, últimos 7 días, con el pin de una persona, en el
 * Perú, los más recientes primero y hasta `cap`. Un pin que es el punto de
 * Google de ese pedido (`googlePinnedOrderIds`: lo guardó una guía automática
 * creada con la ubicación por dirección) no entra: compararía a Google consigo
 * mismo, a 0 m, y la medición se confirmaría sola (05-11-2026).
 */
async function loadPilotSample(
  admin: SupabaseClient,
  opts: { storeIds: string[]; coverages: readonly GeocodeCoverage[]; cap: number; now: Date },
): Promise<PilotOrder[]> {
  if (!opts.storeIds.length || opts.cap <= 0) return [];
  const since = new Date(opts.now.getTime() - GEOCODE_PILOT.days * 86_400_000).toISOString();
  const wanted = (c: string | null): c is GeocodeCoverage => isPilotCoverage(c) && opts.coverages.includes(c);
  const picked: PilotOrder[] = [];
  for (let page = 0; page < GEOCODE_PILOT.maxPages && picked.length < opts.cap; page++) {
    const from = page * GEOCODE_PILOT.pageSize;
    const { data, error } = await admin
      .from("order_master")
      .select("order_id,coverage,address,district,province,region,latitude,longitude,geo_source")
      .in("store_id", opts.storeIds)
      .in("coverage", [...opts.coverages])
      .gte("order_created_at", since)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .order("order_created_at", { ascending: false })
      .range(from, from + GEOCODE_PILOT.pageSize - 1);
    if (error) throw new Error(`leer el Master: ${error.message}`);
    const rows = (data ?? []) as MasterRow[];
    if (!rows.length) break;
    const woo = await wooOrderIds(
      admin,
      rows.map((r) => r.order_id),
    );
    const google = await googlePinnedOrderIds(
      admin,
      rows.filter((r) => woo.has(r.order_id) && wanted(r.coverage)),
    );
    for (const r of rows) {
      if (picked.length >= opts.cap) break;
      if (!woo.has(r.order_id) || !wanted(r.coverage) || google.has(r.order_id)) continue;
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);
      if (!inPeru(lat, lng)) continue;
      picked.push({
        coverage: r.coverage,
        address: r.address,
        district: r.district,
        province: r.province,
        region: r.region,
        pin: { lat, lng },
      });
    }
    if (rows.length < GEOCODE_PILOT.pageSize) break;
  }
  return interleaveByCoverage(picked);
}

/** Lima, Provincia, Lima, Provincia…: si la pasada se corta, se corta parejo. */
function interleaveByCoverage<T extends { coverage: GeocodeCoverage }>(rows: T[]): T[] {
  const lanes = GEOCODE_PILOT_COVERAGES.map((c) => rows.filter((r) => r.coverage === c));
  const out: T[] = [];
  for (let i = 0; out.length < rows.length; i++) {
    for (const lane of lanes) if (i < lane.length) out.push(lane[i]!);
  }
  return out;
}

/**
 * Una consulta a Google. La URL lleva la clave: no se registra ni se devuelve.
 * Un fallo de red o el tope de tiempo es un «error» más, no se reintenta.
 */
async function geocodeOnce(
  params: GeocodeRequestParams,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<GeocodeParsed> {
  const url = `${GOOGLE_GEOCODE_ENDPOINT}?${geocodeQueryString(params)}&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!res.ok) return { kind: "error", status: `HTTP_${res.status}`, fatal: res.status === 401 || res.status === 403 };
    return parseGeocodeResponse(await res.json());
  } catch {
    return { kind: "error", status: "NETWORK", fatal: false };
  }
}

/** Qué decirle al owner cuando Google rechaza la clave o la cuenta. */
function fatalMessage(status: string): string {
  if (status === "OVER_DAILY_LIMIT") {
    return "Google cortó las consultas (OVER_DAILY_LIMIT): la cuenta no tiene facturación activa o se llegó al tope de gasto. No se midió nada.";
  }
  return `Google rechazó la clave (${status}). Revisa en Google Cloud que la clave tenga activada Geocoding API, facturación y que no esté restringida a otra API o a sitios web. No se midió nada.`;
}

export type GeocodePilotRun = { ok: true; report: GeocodePilotReport } | { ok: false; error: string };

/** Lo que deja una pasada de consultas sobre una muestra: los resultados, sin direcciones. */
interface MeasuredQueue {
  samples: GeocodePilotSample[];
  apiCalls: number;
  truncated: boolean;
  quotaHit: boolean;
  /** Un estado de Google que rechaza la clave o la cuenta (no se midió nada). */
  fatal: string | null;
  elapsedMs: number;
}

/**
 * Consulta la cola con el candado y la distancia al pin: 5 a la vez, con el
 * presupuesto de tiempo y el corte por cupo del piloto. No escribe nada.
 */
async function measureQueue(
  queue: PilotOrder[],
  opts: { key: string; fetchImpl: typeof fetch; clock: () => number },
): Promise<MeasuredQueue> {
  const { clock, fetchImpl } = opts;
  const started = clock();
  const samples: GeocodePilotSample[] = new Array(queue.length);
  let next = 0;
  let apiCalls = 0;
  let truncated = false;
  let fatal: string | null = null;
  let quotaHit = false;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= queue.length) return;
      const o = queue[i]!;
      if (quotaHit) {
        samples[i] = { coverage: o.coverage, ok: false, reason: "sin_cupo" };
        continue;
      }
      if (fatal || clock() - started > GEOCODE_PILOT.budgetMs) {
        if (!fatal) truncated = true;
        samples[i] = { coverage: o.coverage, ok: false, reason: "sin_tiempo" };
        continue;
      }
      const params = geocodeRequestParams(o);
      if (!params) {
        samples[i] = { coverage: o.coverage, ok: false, reason: "sin_direccion" };
        continue;
      }
      apiCalls += 1;
      const parsed = await geocodeOnce(params, opts.key, fetchImpl, GEOCODE_PILOT.requestTimeoutMs);
      if (parsed.kind === "error" && parsed.status === QUOTA_STATUS) {
        quotaHit = true;
        samples[i] = { coverage: o.coverage, ok: false, reason: "sin_cupo" };
        continue;
      }
      if (parsed.kind === "error") {
        if (parsed.fatal && !fatal) fatal = parsed.status;
        samples[i] = { coverage: o.coverage, ok: false, reason: "error_api" };
        continue;
      }
      const verdict = geocodeSafeguard(parsed.kind === "ok" ? parsed.result : null, o);
      samples[i] = verdict.ok
        ? { coverage: o.coverage, ok: true, precision: verdict.precision, distanceM: haversineMeters(verdict, o.pin) }
        : { coverage: o.coverage, ok: false, reason: verdict.reason };
    }
  };
  await Promise.all(Array.from({ length: Math.min(GEOCODE_PILOT.concurrency, queue.length) }, worker));
  return { samples, apiCalls, truncated, quotaHit, fatal, elapsedMs: Math.max(0, clock() - started) };
}

/**
 * El piloto de una tienda. Lee el Master y `orders`, consulta Google y devuelve
 * la cuenta. No escribe en la base.
 */
export async function runGeocodePilot(
  admin: SupabaseClient,
  storeId: string,
  opts: { key: string; now?: Date; fetchImpl?: typeof fetch; clock?: () => number },
): Promise<GeocodePilotRun> {
  const now = opts.now ?? new Date();
  const queue = await loadGeocodePilotSample(admin, storeId, now);
  const { samples, apiCalls, truncated, quotaHit, fatal, elapsedMs } = await measureQueue(queue, {
    key: opts.key,
    fetchImpl: opts.fetchImpl ?? fetch,
    clock: opts.clock ?? Date.now,
  });
  if (fatal) {
    console.warn(`[geocode-pilot] ${JSON.stringify({ store: storeId, step: "rejected", status: fatal, apiCalls, elapsedMs })}`);
    return { ok: false, error: fatalMessage(fatal) };
  }

  const { byCoverage, total } = aggregateGeocodePilot(samples);
  const report: GeocodePilotReport = {
    ranAt: now.toISOString(),
    days: GEOCODE_PILOT.days,
    cap: GEOCODE_PILOT.cap,
    apiCalls,
    elapsedMs,
    truncated,
    quotaHit,
    byCoverage,
    total,
  };
  // Solo cuentas: ni direcciones ni pedidos.
  console.info(
    `[geocode-pilot] ${JSON.stringify({
      store: storeId,
      step: "measured",
      sampled: total.sampled,
      passed: total.passed,
      apiCalls,
      truncated,
      quotaHit,
      elapsedMs,
    })}`,
  );
  return { ok: true, report };
}

// ---------------------------------------------------------------------------
// La medición de LIMA para los reintentos automáticos (MOM §9.5, entrega 3;
// owner, 05-11-2026)
//
// Lo mismo que el piloto —la muestra, el candado, la distancia al pin y la
// cuenta— pero solo Lima, entre todas las tiendas activas de la organización,
// y como mucho `GEOCODE_LIMA_CAP` (150) consultas: el cupo diario de Google
// (400) lo comparte con la guía automática de Chatby, que tiene que seguir
// teniendo sitio ese día. A diferencia del piloto, la cuenta SE GUARDA en
// `geocode_pilot_runs` (0308), porque de ella depende que se pueda encender el
// interruptor de los reintentos (`geocodeLimaGate`). Solo cuentas: ni
// direcciones, ni nombres, ni celulares, ni números de pedido, ni en la base
// ni en el registro.

export type GeocodeLimaRun =
  | { ok: true; summary: GeocodeLimaRunSummary; saveError: string | null }
  | { ok: false; error: string };

export async function runGeocodeLimaMeasure(
  admin: SupabaseClient,
  opts: {
    orgId: string;
    storeIds: string[];
    key: string;
    actor: string | null;
    now?: Date;
    fetchImpl?: typeof fetch;
    clock?: () => number;
  },
): Promise<GeocodeLimaRun> {
  const now = opts.now ?? new Date();
  // El tope de 150 es POR DÍA de Lima, no por pulsación: lo que ya gastaron
  // las mediciones guardadas de hoy se descuenta (el cupo de 400 lo comparte
  // con Chatby y con los reintentos).
  let usedToday: number;
  try {
    usedToday = await limaMeasureCallsToday(admin, opts.orgId, now);
  } catch (e) {
    return { ok: false, error: `No se pudo leer lo que ya se midió hoy: ${e instanceof Error ? e.message : String(e)}` };
  }
  const cap = Math.max(0, GEOCODE_LIMA_CAP - usedToday);
  if (cap <= 0) return { ok: false, error: GEOCODE_LIMA_DAY_SPENT };
  const queue = await loadPilotSample(admin, { storeIds: opts.storeIds, coverages: ["lima"], cap, now });
  const measured = await measureQueue(queue, {
    key: opts.key,
    fetchImpl: opts.fetchImpl ?? fetch,
    clock: opts.clock ?? Date.now,
  });
  if (measured.fatal) {
    console.warn(`[geocode-lima] ${JSON.stringify({ step: "rejected", status: measured.fatal, apiCalls: measured.apiCalls })}`);
    return { ok: false, error: fatalMessage(measured.fatal) };
  }
  const lima = aggregateGeocodePilot(measured.samples).byCoverage.find((c) => c.coverage === "lima")!;
  const summary = geocodeLimaRunSummary(lima, {
    ranAt: now.toISOString(),
    days: GEOCODE_PILOT.days,
    cap,
    stores: opts.storeIds.length,
    apiCalls: measured.apiCalls,
    truncated: measured.truncated,
    quotaHit: measured.quotaHit,
  });
  const { error } = await admin.from("geocode_pilot_runs").insert({
    org_id: opts.orgId,
    store_id: null,
    coverage: "lima",
    created_by: opts.actor,
    created_at: now.toISOString(),
    summary,
  });
  console.info(
    `[geocode-lima] ${JSON.stringify({
      step: "measured",
      sampled: summary.sampled,
      passed: summary.passed,
      rooftop: summary.rooftop,
      apiCalls: summary.apiCalls,
      saved: !error,
    })}`,
  );
  return { ok: true, summary, saveError: error ? error.message : null };
}

/** Lo que dice el panel cuando las mediciones de hoy ya usaron las 150 consultas. */
export const GEOCODE_LIMA_DAY_SPENT = `Ya se usaron las ${GEOCODE_LIMA_CAP} consultas de hoy para medir Lima; vuelve mañana.`;

/**
 * Consultas a Google que ya gastaron hoy (día de Lima) las mediciones de Lima
 * guardadas de la organización. Lanza si no se pudo leer.
 */
export async function limaMeasureCallsToday(admin: SupabaseClient, orgId: string, now: Date): Promise<number> {
  const { data, error } = await admin
    .from("geocode_pilot_runs")
    .select("summary")
    .eq("org_id", orgId)
    .eq("coverage", "lima")
    .gte("created_at", `${limaTodayKey(now)}T00:00:00-05:00`);
  if (error) throw new Error(error.message);
  let used = 0;
  for (const r of (data ?? []) as { summary: unknown }[]) {
    const calls = (r.summary as { apiCalls?: unknown } | null)?.apiCalls;
    if (typeof calls === "number" && Number.isFinite(calls) && calls > 0) used += calls;
  }
  return used;
}

/** La última medición de Lima guardada de la organización, o null. Lanza si no se pudo leer. */
export async function latestGeocodeLimaRun(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ at: string; summary: GeocodeLimaRunSummary | null } | null> {
  const { data, error } = await admin
    .from("geocode_pilot_runs")
    .select("created_at,summary")
    .eq("org_id", orgId)
    .eq("coverage", "lima")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`leer la medición de Lima: ${error.message}`);
  const row = ((data ?? []) as { created_at: string; summary: unknown }[])[0];
  return row ? { at: row.created_at, summary: parseGeocodeLimaRunSummary(row.summary) } : null;
}

// ---------------------------------------------------------------------------
// Los confirmados por Chatby que esperan la ubicación (owner, 02-11-2026)
//
// Antes de decidir si la coordenada por dirección alcanza para ellos: cuántos
// pasan el candado y por qué no los demás. No tienen pin, así que no hay
// distancia que medir; se enseña pedido por pedido (número, etapa, resultado y
// el punto en el mapa, para que una persona lo mire). No escribe nada.

export interface GeocodeChatbyRow {
  orderName: string;
  stage: "por_confirmar" | "preparacion";
  coverage: string | null;
  ok: boolean;
  precision?: GeocodePrecision;
  reason?: GeocodePilotReason;
  /** Solo si pasó: el punto de Google, para verlo en el mapa. */
  point?: { lat: number; lng: number };
}

export type GeocodeChatbyRun = { ok: true; rows: GeocodeChatbyRow[]; apiCalls: number } | { ok: false; error: string };

/** Como mucho: es una prueba sobre unos pocos pedidos, no otra muestra. */
export const GEOCODE_CHATBY_CAP = 40;

export async function runGeocodeChatbyCheck(
  admin: SupabaseClient,
  storeId: string,
  opts: { key: string; fetchImpl?: typeof fetch },
): Promise<GeocodeChatbyRun> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { data: checks, error } = await admin
    .from("chatby_auto_checks")
    .select("order_id,outcome,reason,guide_state,guide_detail")
    .eq("store_id", storeId)
    .or("and(outcome.eq.confirmado,guide_state.eq.para_persona,guide_detail.eq.sin_ubicacion),and(outcome.eq.para_asesora,reason.eq.sin_ubicacion)")
    .limit(GEOCODE_CHATBY_CAP);
  if (error) throw new Error(`leer los confirmados por Chatby: ${error.message}`);
  const list = (checks ?? []) as { order_id: string; outcome: string }[];
  if (!list.length) return { ok: true, rows: [], apiCalls: 0 };
  const { data: masters, error: mErr } = await admin
    .from("order_master")
    .select("order_id,order_name,coverage,address,district,province,region")
    .in("order_id", list.map((c) => c.order_id));
  if (mErr) throw new Error(`leer el Master: ${mErr.message}`);
  const byId = new Map(
    ((masters ?? []) as (Omit<MasterRow, "latitude" | "longitude"> & { order_name: string | null })[]).map((m) => [m.order_id, m]),
  );

  const rows: GeocodeChatbyRow[] = [];
  let apiCalls = 0;
  for (const c of list) {
    const m = byId.get(c.order_id);
    if (!m) continue;
    const base = {
      orderName: m.order_name ?? "—",
      stage: c.outcome === "confirmado" ? ("preparacion" as const) : ("por_confirmar" as const),
      coverage: m.coverage,
    };
    const params = geocodeRequestParams(m);
    if (!params) {
      rows.push({ ...base, ok: false, reason: "sin_direccion" });
      continue;
    }
    apiCalls += 1;
    const parsed = await geocodeOnce(params, opts.key, fetchImpl, GEOCODE_PILOT.requestTimeoutMs);
    if (parsed.kind === "error") {
      if (parsed.status === QUOTA_STATUS) {
        rows.push({ ...base, ok: false, reason: "sin_cupo" });
        continue;
      }
      if (parsed.fatal) return { ok: false, error: fatalMessage(parsed.status) };
      rows.push({ ...base, ok: false, reason: "error_api" });
      continue;
    }
    const verdict = geocodeSafeguard(parsed.kind === "ok" ? parsed.result : null, m);
    rows.push(
      verdict.ok
        ? { ...base, ok: true, precision: verdict.precision, point: { lat: verdict.lat, lng: verdict.lng } }
        : { ...base, ok: false, reason: verdict.reason },
    );
  }
  console.info(`[geocode-chatby] ${JSON.stringify({ store: storeId, checked: rows.length, passed: rows.filter((r) => r.ok).length, apiCalls })}`);
  return { ok: true, rows, apiCalls };
}

// ---------------------------------------------------------------------------
// La coordenada por dirección para la guía automática (0301, owner 02-11-2026)
//
// Una consulta por pedido y dirección: la respuesta se guarda en
// `order_geocodes` con la huella de lo consultado, y la pasada que vuelve a
// mirar el pedido cada 30 minutos usa lo guardado. Los errores de la API y el
// cupo agotado no se guardan: se reintenta en la pasada siguiente.

export type OrderGeocode =
  | { kind: "ok"; lat: number; lng: number; precision: GeocodePrecision; cached: boolean }
  | { kind: "rejected"; reason: GeocodePilotReason; precision?: GeocodePrecision; cached: boolean }
  /** No se pudo preguntar (sin clave, sin calle, error o cupo): no se guarda. */
  | { kind: "unavailable"; reason: string };

function addressHash(params: GeocodeRequestParams): string {
  return createHash("sha256").update(geocodeQueryString(params)).digest("hex");
}

interface GeocodeRow {
  address_hash: string;
  ok: boolean;
  precision: string | null;
  latitude: number | null;
  longitude: number | null;
  reason: string | null;
}

/**
 * La coordenada de la dirección del pedido según Google, con el candado
 * aplicado. `rejected` también trae la precisión cuando el punto pasó el
 * candado pero no es `ROOFTOP` (lo decide quien llama: la guía automática solo
 * acepta el edificio, `geocodeUsableForAutoGuide`).
 */
export async function geocodeOrderAddress(
  admin: SupabaseClient,
  order: {
    order_id: string;
    store_id: string;
    address: string | null;
    district: string | null;
    province: string | null;
    region: string | null;
  },
  opts: { key: string; fetchImpl?: typeof fetch },
): Promise<OrderGeocode> {
  if (!opts.key) return { kind: "unavailable", reason: "sin_clave" };
  const params = geocodeRequestParams(order);
  if (!params) return { kind: "unavailable", reason: "sin_direccion" };
  const hash = addressHash(params);

  const { data: cached, error: cErr } = await admin
    .from("order_geocodes")
    .select("address_hash,ok,precision,latitude,longitude,reason")
    .eq("order_id", order.order_id)
    .maybeSingle();
  if (cErr) return { kind: "unavailable", reason: `cache: ${cErr.message}` };
  const row = cached as GeocodeRow | null;
  if (row && row.address_hash === hash) {
    if (row.ok && row.latitude != null && row.longitude != null) {
      return { kind: "ok", lat: row.latitude, lng: row.longitude, precision: row.precision as GeocodePrecision, cached: true };
    }
    return { kind: "rejected", reason: (row.reason ?? "sin_resultado") as GeocodePilotReason, cached: true };
  }

  const parsed = await geocodeOnce(params, opts.key, opts.fetchImpl ?? fetch, GEOCODE_PILOT.requestTimeoutMs);
  if (parsed.kind === "error") return { kind: "unavailable", reason: parsed.status === QUOTA_STATUS ? "sin_cupo" : parsed.status };
  const verdict = geocodeSafeguard(parsed.kind === "ok" ? parsed.result : null, order);
  const usable = geocodeUsableForAutoGuide(verdict);
  const point = verdict.ok ? verdict : null;
  const save = {
    order_id: order.order_id,
    store_id: order.store_id,
    address_hash: hash,
    ok: usable,
    precision: verdict.ok ? verdict.precision : null,
    latitude: usable && point ? point.lat : null,
    longitude: usable && point ? point.lng : null,
    reason: usable ? null : verdict.ok ? "no_es_edificio" : verdict.reason,
    checked_at: new Date().toISOString(),
  };
  await admin.from("order_geocodes").upsert(save, { onConflict: "order_id" });
  console.info(`[geocode-auto] ${JSON.stringify({ store: order.store_id, ok: usable, precision: save.precision, reason: save.reason })}`);
  if (usable && point) return { kind: "ok", lat: point.lat, lng: point.lng, precision: point.precision, cached: false };
  if (point) return { kind: "rejected", reason: "impreciso", precision: point.precision, cached: false };
  return { kind: "rejected", reason: verdict.ok ? "impreciso" : verdict.reason, cached: false };
}
