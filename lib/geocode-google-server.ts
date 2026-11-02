import "server-only";

// El PILOTO de la coordenada por dirección (docs/kapta/geocodificacion-propuesta.md):
// mide el geocodificador de Google contra los pedidos cuyo pin ya puso una
// persona, sin tocar ningún pedido.
//
//   · Muestra: pedidos de WooCommerce (`orders.raw ? 'woo'`) de los últimos 7
//     días, con `order_master.latitude`/`longitude` (el pin de la asesora al
//     crear la guía) y cobertura Lima o Provincia COD. Como mucho 400: el tope
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
//
// TIEMPO. Corre dentro de una acción de servidor de Ajustes. La página admite
// 300 s, pero el piloto se queda en ~45 s: 5 consultas a la vez, 6 s como mucho
// cada una, y a los 38 s no empieza ninguna más. Lo que quedó sin consultar se
// cuenta como «sin_tiempo» y el reporte dice que se cortó. Para que un corte no
// deje fuera a una cobertura entera, la cola alterna Lima y Provincia COD.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inPeru } from "@/lib/chatby-conversation";
import {
  GEOCODE_DAILY_QUOTA,
  GEOCODE_PILOT_COVERAGES,
  QUOTA_STATUS,
  GOOGLE_GEOCODE_ENDPOINT,
  aggregateGeocodePilot,
  geocodeQueryString,
  geocodeRequestParams,
  geocodeSafeguard,
  haversineMeters,
  parseGeocodeResponse,
  type GeocodeCoverage,
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
 * La muestra: los pedidos más recientes primero, hasta `cap`, y la cola
 * alternando coberturas. Solo pins que caen en el Perú: otro es un error de
 * tipeo y no sirve de referencia.
 */
export async function loadGeocodePilotSample(admin: SupabaseClient, storeId: string, now: Date): Promise<PilotOrder[]> {
  const since = new Date(now.getTime() - GEOCODE_PILOT.days * 86_400_000).toISOString();
  const picked: PilotOrder[] = [];
  for (let page = 0; page < GEOCODE_PILOT.maxPages && picked.length < GEOCODE_PILOT.cap; page++) {
    const from = page * GEOCODE_PILOT.pageSize;
    const { data, error } = await admin
      .from("order_master")
      .select("order_id,coverage,address,district,province,region,latitude,longitude")
      .eq("store_id", storeId)
      .in("coverage", [...GEOCODE_PILOT_COVERAGES])
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
    for (const r of rows) {
      if (picked.length >= GEOCODE_PILOT.cap) break;
      if (!woo.has(r.order_id) || !isPilotCoverage(r.coverage)) continue;
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

/**
 * El piloto de una tienda. Lee el Master y `orders`, consulta Google y devuelve
 * la cuenta. No escribe en la base.
 */
export async function runGeocodePilot(
  admin: SupabaseClient,
  storeId: string,
  opts: { key: string; now?: Date; fetchImpl?: typeof fetch; clock?: () => number },
): Promise<GeocodePilotRun> {
  const clock = opts.clock ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const started = clock();

  const queue = await loadGeocodePilotSample(admin, storeId, now);
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

  const elapsedMs = Math.max(0, clock() - started);
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
