import "server-only";

// «Pago solo online (lista automática)» — el cálculo diario, el envío a cada
// tienda y lo que lee el panel (MOM §41.11, docs/kapta/pago-solo-online.md).
// La regla y las decisiones puras están en lib/pago-online.ts; el freno de un
// celular, en lib/pago-online-lookup.ts.
//
// LA PASADA DIARIA (`runPagoOnlineDaily`, el cron de las 05:00 de Lima).
//   * Apagado: nada.
//   * Simulación: calcula la lista y guarda SOLO las cuentas (cuántos
//     celulares, cuántos correos, cuántos pedidos de Por confirmar frenaría y
//     cómo quedaría el freno de cambio brusco). Sin celulares, sin envío, sin
//     freno.
//   * Activo: calcula y guarda los celulares de la corrida; si pasa el freno
//     de cambio brusco contra la corrida vigente, pasa a ser la vigente (la que
//     lee el freno de Kapta) y se manda, entera, a cada tienda WooCommerce
//     activa de la organización, por separado, con las claves de la API REST
//     que Kapta ya guarda (Basic auth). Después de un envío bueno, un GET de
//     verificación guarda los totales y la fecha que dice la tienda.
//
// LO QUE SE MANDA ES LA «LISTA NEGRA» ENTERA (owner, 09-11-2026): los
// celulares de la corrida vigente MÁS las altas vivas a mano
// (`prepay_list_entries`, MOM §41), sin repetidos (`listaNegraSendPhones`).
// Las excepciones de Kapta sacan a alguien solo de la automática: un alta a
// mano va igual. El freno de cambio brusco de cada tienda cuenta esa unión
// (es lo que la tienda recibe); el de la corrida, la automática sola (es lo
// que frena en Kapta). Es el ÚNICO camino por el que una alta a mano llega a
// las tiendas: la consulta `/prepago` del §41.7 queda retirada.
//
// REINTENTOS: 1, 5 y 15 minutos después de cada intento que falla por 5xx,
// tiempo agotado, red o 429; nunca con 401/403. 404 es «la tienda todavía no
// tiene el endpoint» (cod-core 0.10.45): se registra y no se reintenta. 413
// avisa. Dos días seguidos fallidos en una tienda avisan por Telegram. Las
// alertas nunca llevan celulares ni correos.
//
// Nada de aquí escribe un celular en un log, una respuesta o un error.

import type { SupabaseClient } from "@supabase/supabase-js";
import { WooError, wooRequest } from "@/lib/woocommerce";
import { loadWooStoreCreds } from "@/lib/woocommerce-intake";
import { telegramTarget } from "@/lib/aliclik-scheduled-server";
import { escapeHtml, sendTelegramToAll } from "@/lib/telegram";
import { isMissingPagoOnline } from "@/lib/pago-online-lookup";
import { livePrepayPhones } from "@/lib/prepay-list-server";
import { listaNegraRegla, listaNegraSendPhones } from "@/lib/lista-negra";
import {
  COD_CORE_API_PREFIX,
  PAGO_ONLINE_DEFAULT_REQUIREMENT,
  PAGO_ONLINE_COD_CORE_VERSION,
  PAGO_ONLINE_ENDPOINT_PATH,
  PAGO_ONLINE_KEEP_DAYS,
  PAGO_ONLINE_MAX_EMAILS,
  PAGO_ONLINE_MAX_PHONES,
  classifyCodCoreAttempt,
  isPagoOnlineMode,
  isPagoOnlineRequirement,
  limaDateOf,
  nextRetryAt,
  pagoOnlineAlertText,
  pagoOnlineGuard,
  pagoOnlineEmptyPayload,
  pagoOnlinePayload,
  pagoOnlinePhoneKey,
  pagoOnlineRegla,
  parseCodCoreTotals,
  sendStatusOf,
  shouldAlertTwoDays,
  type CodCoreTotals,
  type PagoOnlineMode,
  type PagoOnlinePayload,
  type PagoOnlineRequirement,
  type PagoOnlineSendStatus,
} from "@/lib/pago-online";

type Admin = SupabaseClient;

/** El POST lleva la lista entera: 30 s. El GET solo cuentas: 15 s. */
const POST_TIMEOUT_MS = 30_000;
const GET_TIMEOUT_MS = 15_000;

// ── La posición ─────────────────────────────────────────────────────────────

export interface PagoOnlineSettingsRow {
  org_id: string;
  mode: PagoOnlineMode;
  requirement: PagoOnlineRequirement;
  current_run_id: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** La fila de la organización; sin fila es «apagado» y «adelanto». `missing`: falta la 0326. */
export async function loadPagoOnlineSettings(
  admin: Admin,
  orgId: string,
): Promise<{ settings: PagoOnlineSettingsRow; missing: boolean; error: string | null }> {
  const empty: PagoOnlineSettingsRow = {
    org_id: orgId,
    mode: "apagado",
    requirement: PAGO_ONLINE_DEFAULT_REQUIREMENT,
    current_run_id: null,
    updated_by: null,
    updated_at: null,
  };
  const { data, error } = await admin.from("pago_online_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (error) return { settings: empty, missing: isMissingPagoOnline(error), error: isMissingPagoOnline(error) ? null : error.message };
  const row = data as Partial<PagoOnlineSettingsRow> | null;
  if (!row) return { settings: empty, missing: false, error: null };
  return {
    settings: {
      ...empty,
      ...row,
      mode: isPagoOnlineMode(row.mode) ? row.mode : "apagado",
      requirement: isPagoOnlineRequirement(row.requirement) ? row.requirement : PAGO_ONLINE_DEFAULT_REQUIREMENT,
    },
    missing: false,
    error: null,
  };
}

// ── Las tiendas ─────────────────────────────────────────────────────────────

export interface PagoOnlineStore {
  id: string;
  name: string;
}

/** Las tiendas WooCommerce activas de la organización: a cada una se le manda la lista. */
export async function pagoOnlineStores(admin: Admin, orgId: string): Promise<PagoOnlineStore[]> {
  const { data, error } = await admin.from("stores").select("id,name,status,platform").eq("org_id", orgId).order("name");
  if (error) throw new Error(`leer las tiendas: ${error.message}`);
  return ((data ?? []) as { id: string; name: string | null; status: string | null; platform: string | null }[])
    .filter((s) => (s.status ?? "active") === "active" && s.platform === "woocommerce")
    .map((s) => ({ id: s.id, name: s.name ?? "Tienda" }));
}

// ── Hablar con COD Core ─────────────────────────────────────────────────────

export interface CodCoreCallResult {
  status: number | null;
  /** El `kind` de `WooError` si falló; null si salió bien. */
  kind: string | null;
  totals: CodCoreTotals | null;
  /** El mensaje del error, sin claves ni la URL (`wooRequest` los quita). */
  error: string | null;
}

/** Una llamada a `/wp-json/cod-core/v1/pago-solo-online` con las claves de la API de la tienda. Nunca lanza. */
export async function codCoreCall(
  admin: Admin,
  storeId: string,
  req: { method: "GET" } | { method: "POST"; body: PagoOnlinePayload },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<CodCoreCallResult | { missingCreds: true; error: string }> {
  const { creds, error } = await loadWooStoreCreds(admin, storeId);
  if (error) return { status: null, kind: "config", totals: null, error: `No se pudo leer la tienda: ${error}` };
  if (!creds?.siteUrl || !creds.consumerKey || !creds.consumerSecret) {
    return { missingCreds: true, error: "La tienda no tiene la dirección o las claves de la API REST de WooCommerce guardadas (Ajustes → WooCommerce)." };
  }
  try {
    const res = await wooRequest<unknown>(
      {
        siteUrl: creds.siteUrl,
        consumerKey: creds.consumerKey,
        consumerSecret: creds.consumerSecret,
        apiPrefix: COD_CORE_API_PREFIX,
        timeoutMs: req.method === "POST" ? POST_TIMEOUT_MS : GET_TIMEOUT_MS,
        fetchImpl: opts.fetchImpl,
      },
      req.method === "POST" ? { method: "POST", path: PAGO_ONLINE_ENDPOINT_PATH, body: req.body } : { method: "GET", path: PAGO_ONLINE_ENDPOINT_PATH },
    );
    return { status: res.status, kind: null, totals: parseCodCoreTotals(res.data), error: null };
  } catch (e) {
    if (e instanceof WooError) {
      // 404 aquí no es «la API de WooCommerce no existe» (el texto genérico de
      // wooRequest habla de wc/v3): es la tienda sin cod-core 0.10.45.
      const error =
        e.status === 404
          ? `La tienda todavía no tiene cod-core ${PAGO_ONLINE_COD_CORE_VERSION} (${COD_CORE_API_PREFIX}${PAGO_ONLINE_ENDPOINT_PATH} responde 404). Cuando la suban, vuelve a probar.`
          : e.message.slice(0, 480);
      return { status: e.status, kind: e.kind, totals: null, error };
    }
    return { status: null, kind: "red", totals: null, error: "No se pudo conectar con la tienda." };
  }
}

// ── Un intento de envío ─────────────────────────────────────────────────────

export interface SendAttemptResult {
  storeId: string;
  sendId: string | null;
  status: PagoOnlineSendStatus | "ocupado";
  httpStatus: number | null;
  error: string | null;
  totals: CodCoreTotals | null;
  verify: CodCoreTotals | null;
  nextAttemptAt: string | null;
}

/**
 * Manda la lista a UNA tienda y registra el intento. El candado es la fila: se
 * inserta primero (`enviando`) y el índice único (corrida, tienda, intento)
 * impide que dos pasadas lo manden dos veces (`ocupado`).
 */
async function sendAttempt(
  admin: Admin,
  input: {
    orgId: string;
    store: PagoOnlineStore;
    runId: string | null;
    kind: "diaria" | "manual" | "prueba";
    attempt: number;
    payload: PagoOnlinePayload;
    baseline: number | null;
    actor: string | null;
    allowRetry: boolean;
    now?: () => Date;
    fetchImpl?: typeof fetch;
  },
): Promise<SendAttemptResult> {
  const clock = input.now ?? (() => new Date());
  const base: SendAttemptResult = {
    storeId: input.store.id,
    sendId: null,
    status: "ocupado",
    httpStatus: null,
    error: null,
    totals: null,
    verify: null,
    nextAttemptAt: null,
  };
  const { data: claimed, error: claimError } = await admin
    .from("pago_online_sends")
    .insert({
      org_id: input.orgId,
      store_id: input.store.id,
      run_id: input.runId,
      kind: input.kind,
      attempt: input.attempt,
      status: "enviando",
      phones_sent: input.payload.celulares.length,
      emails_sent: input.payload.correos.length,
      baseline_phones: input.baseline,
      actor: input.actor,
      started_at: clock().toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (claimError) {
    if (claimError.code === "23505") return base;
    return { ...base, status: "fallido", error: `No se pudo registrar el envío: ${claimError.message}` };
  }
  const sendId = (claimed as { id: string } | null)?.id ?? null;

  const res = await codCoreCall(admin, input.store.id, { method: "POST", body: input.payload }, { fetchImpl: input.fetchImpl });
  const finished = clock();
  if ("missingCreds" in res) {
    await admin.from("pago_online_sends").update({ status: "sin_claves", error: res.error, finished_at: finished.toISOString() }).eq("id", sendId);
    return { ...base, sendId, status: "sin_claves", error: res.error };
  }
  const outcome = classifyCodCoreAttempt({ status: res.status, kind: res.kind });
  const next = input.allowRetry ? nextRetryAt(input.attempt, outcome, finished) : null;
  const status = sendStatusOf(outcome, !!next);

  let verify: CodCoreTotals | null = null;
  let verifyError: string | null = null;
  if (status === "enviado") {
    const v = await codCoreCall(admin, input.store.id, { method: "GET" }, { fetchImpl: input.fetchImpl });
    if ("missingCreds" in v) verifyError = v.error;
    else if (v.error) verifyError = v.error;
    else verify = v.totals;
  }

  const { error: saveError } = await admin
    .from("pago_online_sends")
    .update({
      status,
      http_status: res.status,
      error: res.error,
      response: res.totals,
      verify,
      verify_error: verifyError,
      next_attempt_at: next ? next.toISOString() : null,
      finished_at: clock().toISOString(),
    })
    .eq("id", sendId);
  const saveNote = saveError ? ` · no se pudo guardar el resultado: ${saveError.message}` : "";

  if (status === "demasiado_grande") {
    await alertStore(admin, input.store, pagoOnlineAlertText({ kind: "demasiado_grande", storeName: input.store.name, phones: input.payload.celulares.length }), sendId, "demasiado_grande");
  }
  if (input.kind === "diaria" && (status === "fallido" || status === "credenciales" || status === "sin_claves")) {
    await maybeAlertTwoDays(admin, input.store, finished, res.error, sendId);
  }
  return {
    ...base,
    sendId,
    status,
    httpStatus: res.status,
    error: res.error ? `${res.error}${saveNote}` : saveNote || null,
    totals: res.totals,
    verify,
    nextAttemptAt: next ? next.toISOString() : null,
  };
}

/** Telegram al grupo de alertas de la tienda. Nunca lleva celulares. Nunca lanza. */
async function alertStore(admin: Admin, store: PagoOnlineStore, text: string, sendId: string | null, kind: "dos_dias" | "freno_cambio" | "demasiado_grande"): Promise<boolean> {
  try {
    const target = await telegramTarget(admin, store.id);
    if (!target) return false;
    const res = await sendTelegramToAll(target.token, target.chats, escapeHtml(text));
    if (res.sent > 0 && sendId) await admin.from("pago_online_sends").update({ alerted: kind }).eq("id", sendId);
    return res.sent > 0;
  } catch {
    return false;
  }
}

/** «Falló dos días seguidos»: una sola alerta por tienda y día. */
async function maybeAlertTwoDays(admin: Admin, store: PagoOnlineStore, now: Date, lastError: string | null, sendId: string | null): Promise<void> {
  const since = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("pago_online_sends")
    .select("id,status,started_at,alerted")
    .eq("store_id", store.id)
    .eq("kind", "diaria")
    .gte("started_at", since)
    .order("started_at", { ascending: false });
  if (error) return;
  const rows = (data ?? []) as { id: string; status: PagoOnlineSendStatus; started_at: string; alerted: string | null }[];
  const today = limaDateOf(now);
  if (rows.some((r) => r.alerted === "dos_dias" && limaDateOf(new Date(r.started_at)) === today)) return;
  // El último estado de cada día (el más nuevo de ese día).
  const finals = new Map<string, PagoOnlineSendStatus>();
  for (const r of rows) {
    const day = limaDateOf(new Date(r.started_at));
    if (!finals.has(day)) finals.set(day, r.status);
  }
  const days = [...finals].map(([runDate, status]) => ({ runDate, status }));
  if (!shouldAlertTwoDays(days, today)) return;
  await alertStore(admin, store, pagoOnlineAlertText({ kind: "dos_dias", storeName: store.name, detail: lastError }), sendId, "dos_dias");
}

// ── La lista de una corrida ─────────────────────────────────────────────────

/**
 * Lo que se manda: los celulares y correos guardados de una corrida, por
 * páginas, MÁS los celulares de las altas vivas a mano de la organización
 * (sin repetidos; ellas no traen correo). Lanza si la base falla.
 */
async function runPayload(admin: Admin, orgId: string, runId: string, regla: string): Promise<PagoOnlinePayload> {
  const phones: string[] = [];
  const emails: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("pago_online_phones")
      .select("phone,emails")
      .eq("run_id", runId)
      .order("phone")
      .range(from, from + 999);
    if (error) throw new Error(`leer la lista: ${error.message}`);
    const rows = (data ?? []) as { phone: string; emails: string[] | null }[];
    for (const r of rows) {
      phones.push(r.phone);
      for (const e of r.emails ?? []) emails.push(e);
    }
    if (rows.length < 1000) break;
  }
  const union = listaNegraSendPhones(phones, await livePrepayPhones(admin, orgId));
  return pagoOnlinePayload(union.phones.slice(0, PAGO_ONLINE_MAX_PHONES), emails.slice(0, PAGO_ONLINE_MAX_EMAILS), listaNegraRegla(regla, union.manualOnly));
}

/** El último envío bueno (diario o manual, nunca una prueba) de la tienda: el piso del freno de cambio brusco. */
async function storeBaseline(admin: Admin, storeId: string): Promise<number | null> {
  const { data, error } = await admin
    .from("pago_online_sends")
    .select("phones_sent")
    .eq("store_id", storeId)
    .eq("status", "enviado")
    .in("kind", ["diaria", "manual"])
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`leer el último envío: ${error.message}`);
  const row = ((data ?? []) as { phones_sent: number }[])[0];
  return row ? row.phones_sent : null;
}

// ── La corrida ──────────────────────────────────────────────────────────────

export interface PagoOnlineBuildCounts {
  phones: number;
  emails: number;
  two_or_more: number;
  anuladores: number;
  excepted: number;
  por_confirmar_listed: number;
  por_confirmar_braked: number;
}

export interface PagoOnlineOrgReport {
  orgId: string;
  mode: PagoOnlineMode;
  runId: string | null;
  skipped?: "ya_calculada" | "apagado";
  counts: PagoOnlineBuildCounts | null;
  guard: string | null;
  guardReason: string | null;
  sends: SendAttemptResult[];
  error: string | null;
}

function parseCounts(raw: unknown): PagoOnlineBuildCounts {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  return {
    phones: n(r.phones),
    emails: n(r.emails),
    two_or_more: n(r.two_or_more),
    anuladores: n(r.anuladores),
    excepted: n(r.excepted),
    por_confirmar_listed: n(r.por_confirmar_listed),
    por_confirmar_braked: n(r.por_confirmar_braked),
  };
}

/**
 * Una corrida para una organización: calcula, aplica el freno de cambio
 * brusco y, en Activo, manda a cada tienda. `trigger: "cron"` lleva el
 * candado del día (una sola por organización, día y posición); «Correr ahora»
 * no. Nunca lanza.
 */
export async function runPagoOnlineForOrg(
  admin: Admin,
  input: { orgId: string; trigger: "cron" | "manual"; actor?: string | null; now?: Date; fetchImpl?: typeof fetch },
): Promise<PagoOnlineOrgReport> {
  const now = input.now ?? new Date();
  const runDate = limaDateOf(now);
  const report: PagoOnlineOrgReport = { orgId: input.orgId, mode: "apagado", runId: null, counts: null, guard: null, guardReason: null, sends: [], error: null };
  const { settings, missing, error: settingsError } = await loadPagoOnlineSettings(admin, input.orgId);
  if (missing) return { ...report, error: "Falta la migración 0326 en la base de datos." };
  if (settingsError) return { ...report, error: `leer la posición: ${settingsError}` };
  const mode = settings.mode;
  report.mode = mode;
  if (mode === "apagado") return { ...report, skipped: "apagado" };

  // El candado del día.
  const { data: runRow, error: runError } = await admin
    .from("pago_online_runs")
    .insert({
      org_id: input.orgId,
      run_date: runDate,
      mode,
      trigger: input.trigger,
      daily_key: input.trigger === "cron" ? `${runDate}:${mode}` : null,
      requirement: settings.requirement,
      started_at: now.toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (runError) {
    if (runError.code === "23505") return { ...report, skipped: "ya_calculada" };
    return { ...report, error: `registrar la corrida: ${runError.message}` };
  }
  const runId = (runRow as { id: string }).id;
  report.runId = runId;

  const fail = async (message: string): Promise<PagoOnlineOrgReport> => {
    // Sin el candado: el cron del minuto siguiente vuelve a intentar el cálculo.
    await admin
      .from("pago_online_runs")
      .update({ status: "error", error: message.slice(0, 480), daily_key: null, finished_at: new Date().toISOString() })
      .eq("id", runId);
    return { ...report, error: message };
  };

  let stores: PagoOnlineStore[];
  try {
    stores = await pagoOnlineStores(admin, input.orgId);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  const { data: built, error: buildError } = await admin.rpc("pago_online_build", {
    p_org: input.orgId,
    p_run: mode === "activo" ? runId : null,
    p_requirement: settings.requirement,
  });
  if (buildError) return fail(`calcular la lista: ${buildError.message}`);
  const counts = parseCounts(built);
  report.counts = counts;

  // El freno de cambio brusco contra la corrida vigente (la que usa el freno).
  let baseline: number | null = null;
  if (settings.current_run_id) {
    const { data: cur } = await admin.from("pago_online_runs").select("phones").eq("id", settings.current_run_id).maybeSingle();
    baseline = (cur as { phones?: number } | null)?.phones ?? null;
  }
  const guard = pagoOnlineGuard(counts.phones, baseline);
  report.guard = guard.kind;
  report.guardReason = guard.ok ? null : guard.reason;
  const regla = pagoOnlineRegla(
    stores.map((s) => s.name),
    now,
  );

  const { error: saveError } = await admin
    .from("pago_online_runs")
    .update({
      status: "listo",
      phones: counts.phones,
      emails: counts.emails,
      two_or_more: counts.two_or_more,
      anuladores: counts.anuladores,
      excepted: counts.excepted,
      por_confirmar_listed: counts.por_confirmar_listed,
      por_confirmar_braked: counts.por_confirmar_braked,
      baseline_phones: baseline,
      guard: guard.kind,
      guard_reason: guard.ok ? null : guard.reason,
      regla,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (saveError) return fail(`guardar la corrida: ${saveError.message}`);

  if (mode !== "activo") return report;

  if (!guard.ok) {
    for (const store of stores) {
      const { data: row } = await admin
        .from("pago_online_sends")
        .insert({
          org_id: input.orgId,
          store_id: store.id,
          run_id: runId,
          kind: input.trigger === "cron" ? "diaria" : "manual",
          attempt: 1,
          status: "freno_cambio",
          phones_sent: 0,
          baseline_phones: baseline,
          guard_reason: guard.reason,
          finished_at: new Date().toISOString(),
        })
        .select("id")
        .maybeSingle();
      const sendId = (row as { id: string } | null)?.id ?? null;
      await alertStore(admin, store, pagoOnlineAlertText({ kind: "freno_cambio", storeName: store.name, detail: guard.reason }), sendId, "freno_cambio");
      report.sends.push({ storeId: store.id, sendId, status: "freno_cambio", httpStatus: null, error: guard.reason, totals: null, verify: null, nextAttemptAt: null });
    }
    return report;
  }

  // Pasa: es la vigente desde ya, para el freno de Kapta.
  const { error: currentError } = await admin
    .from("pago_online_settings")
    .update({ current_run_id: runId })
    .eq("org_id", input.orgId)
    .eq("mode", "activo");
  if (currentError) return { ...report, error: `marcar la lista vigente: ${currentError.message}` };

  report.sends = await sendRunToStores(admin, {
    orgId: input.orgId,
    runId,
    regla,
    stores,
    kind: input.trigger === "cron" ? "diaria" : "manual",
    actor: input.actor ?? null,
    skipStoreGuard: false,
    now: input.now ? () => input.now! : undefined,
    fetchImpl: input.fetchImpl,
  });
  await pruneOldPhones(admin, input.orgId, now);
  return report;
}

/** Manda la lista de una corrida a cada tienda, cada una con su freno de cambio brusco. */
async function sendRunToStores(
  admin: Admin,
  input: {
    orgId: string;
    runId: string;
    regla: string;
    stores: PagoOnlineStore[];
    kind: "diaria" | "manual";
    actor: string | null;
    skipStoreGuard: boolean;
    now?: () => Date;
    fetchImpl?: typeof fetch;
  },
): Promise<SendAttemptResult[]> {
  const out: SendAttemptResult[] = [];
  let payload: PagoOnlinePayload;
  try {
    payload = await runPayload(admin, input.orgId, input.runId, input.regla);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return input.stores.map((s) => ({ storeId: s.id, sendId: null, status: "fallido", httpStatus: null, error: message, totals: null, verify: null, nextAttemptAt: null }));
  }
  for (const store of input.stores) {
    let baseline: number | null = null;
    try {
      baseline = await storeBaseline(admin, store.id);
    } catch (e) {
      out.push({ storeId: store.id, sendId: null, status: "fallido", httpStatus: null, error: e instanceof Error ? e.message : String(e), totals: null, verify: null, nextAttemptAt: null });
      continue;
    }
    const guard = pagoOnlineGuard(payload.celulares.length, baseline);
    if (!guard.ok && !input.skipStoreGuard) {
      const { data: row } = await admin
        .from("pago_online_sends")
        .insert({
          org_id: input.orgId,
          store_id: store.id,
          run_id: input.runId,
          kind: input.kind,
          attempt: 1,
          status: "freno_cambio",
          phones_sent: 0,
          baseline_phones: baseline,
          guard_reason: guard.reason,
          actor: input.actor,
          finished_at: new Date().toISOString(),
        })
        .select("id")
        .maybeSingle();
      const sendId = (row as { id: string } | null)?.id ?? null;
      await alertStore(admin, store, pagoOnlineAlertText({ kind: "freno_cambio", storeName: store.name, detail: guard.reason }), sendId, "freno_cambio");
      out.push({ storeId: store.id, sendId, status: "freno_cambio", httpStatus: null, error: guard.reason, totals: null, verify: null, nextAttemptAt: null });
      continue;
    }
    out.push(
      await sendAttempt(admin, {
        orgId: input.orgId,
        store,
        runId: input.runId,
        kind: input.kind,
        attempt: await nextAttemptNumber(admin, input.runId, store.id),
        payload,
        baseline,
        actor: input.actor,
        // Solo el envío diario se reintenta: el cron de los reintentos corre en
        // la hora de las 05:00 de Lima, y un envío a mano se repite a mano.
        allowRetry: input.kind === "diaria",
        now: input.now,
        fetchImpl: input.fetchImpl,
      }),
    );
  }
  return out;
}

/** El número del próximo intento de una corrida en una tienda (después de un «Aceptar», por ejemplo). */
async function nextAttemptNumber(admin: Admin, runId: string, storeId: string): Promise<number> {
  const { data } = await admin
    .from("pago_online_sends")
    .select("attempt")
    .eq("run_id", runId)
    .eq("store_id", storeId)
    .order("attempt", { ascending: false })
    .limit(1);
  const last = ((data ?? []) as { attempt: number }[])[0]?.attempt ?? 0;
  return Math.min(4, last + 1);
}

/** Borra los celulares de las corridas viejas que ya no son la vigente. Sus cuentas quedan. */
async function pruneOldPhones(admin: Admin, orgId: string, now: Date): Promise<void> {
  const { settings } = await loadPagoOnlineSettings(admin, orgId);
  const cutoff = new Date(now.getTime() - PAGO_ONLINE_KEEP_DAYS * 86_400_000).toISOString();
  const { data } = await admin.from("pago_online_runs").select("id").eq("org_id", orgId).eq("mode", "activo").lt("started_at", cutoff).limit(200);
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id).filter((id) => id !== settings.current_run_id);
  if (ids.length) await admin.from("pago_online_phones").delete().in("run_id", ids);
}

// ── Los reintentos ──────────────────────────────────────────────────────────

/** Los envíos diarios que tocan reintentar ahora. Cada uno se toma con un candado (`next_attempt_at` a null). */
export async function processPagoOnlineRetries(admin: Admin, opts: { now?: Date; fetchImpl?: typeof fetch } = {}): Promise<SendAttemptResult[]> {
  const now = opts.now ?? new Date();
  const { data, error } = await admin
    .from("pago_online_sends")
    .select("id,org_id,store_id,run_id,attempt,baseline_phones")
    .eq("status", "reintento")
    .lte("next_attempt_at", now.toISOString())
    .order("next_attempt_at")
    .limit(20);
  if (error) {
    if (isMissingPagoOnline(error)) return [];
    throw new Error(`leer los reintentos: ${error.message}`);
  }
  const out: SendAttemptResult[] = [];
  for (const row of (data ?? []) as { id: string; org_id: string; store_id: string; run_id: string | null; attempt: number; baseline_phones: number | null }[]) {
    const { data: took } = await admin
      .from("pago_online_sends")
      .update({ next_attempt_at: null })
      .eq("id", row.id)
      .not("next_attempt_at", "is", null)
      .select("id");
    if (!((took ?? []) as unknown[]).length || !row.run_id) continue;
    const { settings } = await loadPagoOnlineSettings(admin, row.org_id);
    if (settings.mode !== "activo" || settings.current_run_id !== row.run_id) {
      // Se apagó, o ya hay otra lista vigente: este reintento no se manda.
      await admin.from("pago_online_sends").update({ status: "fallido", error: "No se reintentó: la automatización ya no está en Activo o hay una lista más nueva." }).eq("id", row.id);
      continue;
    }
    const [{ data: run }, { data: store }] = await Promise.all([
      admin.from("pago_online_runs").select("regla").eq("id", row.run_id).maybeSingle(),
      admin.from("stores").select("id,name").eq("id", row.store_id).maybeSingle(),
    ]);
    let payload: PagoOnlinePayload;
    try {
      payload = await runPayload(admin, row.org_id, row.run_id, (run as { regla?: string | null } | null)?.regla ?? "");
    } catch (e) {
      await admin.from("pago_online_sends").update({ status: "fallido", error: (e instanceof Error ? e.message : String(e)).slice(0, 480) }).eq("id", row.id);
      continue;
    }
    // El intento anterior queda como historia: «falló y se reintentó».
    out.push(
      await sendAttempt(admin, {
        orgId: row.org_id,
        store: { id: row.store_id, name: (store as { name?: string | null } | null)?.name ?? "Tienda" },
        runId: row.run_id,
        kind: "diaria",
        attempt: row.attempt + 1,
        payload,
        baseline: row.baseline_phones,
        actor: null,
        allowRetry: true,
        now: opts.now ? () => opts.now! : undefined,
        fetchImpl: opts.fetchImpl,
      }),
    );
  }
  return out;
}

/** El cron: la corrida de cada organización que no está apagada, y los reintentos que tocan. Nunca lanza. */
export async function runPagoOnlineDaily(admin: Admin, opts: { now?: Date } = {}): Promise<{ orgs: PagoOnlineOrgReport[]; retries: SendAttemptResult[]; error: string | null }> {
  const now = opts.now ?? new Date();
  const { data, error } = await admin.from("pago_online_settings").select("org_id,mode").neq("mode", "apagado");
  if (error) {
    if (isMissingPagoOnline(error)) return { orgs: [], retries: [], error: null };
    return { orgs: [], retries: [], error: `leer la posición: ${error.message}` };
  }
  const orgs: PagoOnlineOrgReport[] = [];
  for (const row of (data ?? []) as { org_id: string }[]) {
    orgs.push(await runPagoOnlineForOrg(admin, { orgId: row.org_id, trigger: "cron", now }));
  }
  let retries: SendAttemptResult[] = [];
  let retryError: string | null = null;
  try {
    retries = await processPagoOnlineRetries(admin, { now });
  } catch (e) {
    retryError = e instanceof Error ? e.message : String(e);
  }
  const firstError = orgs.find((o) => o.error)?.error ?? retryError;
  return { orgs, retries, error: firstError };
}

// ── Lo que hace el owner desde el panel ─────────────────────────────────────

/**
 * «Aceptar la lista de hoy»: una corrida en Activo que el freno de cambio
 * brusco paró pasa a ser la vigente y se manda a cada tienda, sin el freno de
 * cada tienda. Solo la corrida más nueva de la organización.
 */
export async function acceptPagoOnlineRun(
  admin: Admin,
  input: { orgId: string; runId: string; actor: string | null },
): Promise<{ ok: true; sends: SendAttemptResult[] } | { ok: false; error: string }> {
  const { settings, missing, error } = await loadPagoOnlineSettings(admin, input.orgId);
  if (missing) return { ok: false, error: "Falta la migración 0326 en la base de datos." };
  if (error) return { ok: false, error: "No se pudo leer la posición. Intenta de nuevo." };
  if (settings.mode !== "activo") return { ok: false, error: "Solo se acepta una lista con la automatización en Activo." };
  const { data: latest, error: readError } = await admin
    .from("pago_online_runs")
    .select("id,guard,mode,status,regla")
    .eq("org_id", input.orgId)
    .eq("mode", "activo")
    .order("started_at", { ascending: false })
    .limit(1);
  if (readError) return { ok: false, error: "No se pudo leer la corrida. Intenta de nuevo." };
  const run = ((latest ?? []) as { id: string; guard: string | null; status: string; regla: string | null }[])[0];
  if (!run || run.id !== input.runId) return { ok: false, error: "Esa ya no es la lista más nueva: recarga la página." };
  if (run.status !== "listo" || run.guard !== "bloqueado") return { ok: false, error: "Esa lista no está frenada." };
  const nowIso = new Date().toISOString();
  const { error: upError } = await admin
    .from("pago_online_runs")
    .update({ guard: "aceptado", accepted_by: input.actor, accepted_at: nowIso })
    .eq("id", run.id)
    .eq("guard", "bloqueado");
  if (upError) return { ok: false, error: "No se pudo aceptar. Intenta de nuevo." };
  const { error: curError } = await admin.from("pago_online_settings").update({ current_run_id: run.id }).eq("org_id", input.orgId);
  if (curError) return { ok: false, error: "No se pudo marcar la lista como vigente. Intenta de nuevo." };
  let stores: PagoOnlineStore[];
  try {
    stores = await pagoOnlineStores(admin, input.orgId);
  } catch {
    return { ok: false, error: "No se pudieron leer las tiendas." };
  }
  const sends = await sendRunToStores(admin, {
    orgId: input.orgId,
    runId: run.id,
    regla: run.regla ?? "",
    stores,
    kind: "manual",
    actor: input.actor,
    skipStoreGuard: true,
  });
  return { ok: true, sends };
}

/**
 * «Enviar prueba» (§6 del pedido): manda a UNA tienda una lista con un solo
 * celular del equipo y `regla: "prueba"`, y la verifica con el GET. No es una
 * corrida, no se reintenta y no cuenta para el freno de cambio brusco. OJO: la
 * tienda reemplaza su lista automática por ese celular hasta el próximo envío
 * real. El celular no se guarda en ningún registro (solo la cuenta: 1).
 */
export async function sendPagoOnlineTest(
  admin: Admin,
  input: { orgId: string; storeId: string; phone: string; actor: string | null },
): Promise<SendAttemptResult | { error: string }> {
  const phone = pagoOnlinePhoneKey(input.phone);
  if (!phone) return { error: "Escribe un celular de 9 dígitos." };
  let stores: PagoOnlineStore[];
  try {
    stores = await pagoOnlineStores(admin, input.orgId);
  } catch {
    return { error: "No se pudieron leer las tiendas." };
  }
  const store = stores.find((s) => s.id === input.storeId);
  if (!store) return { error: "Esa tienda no es una tienda WooCommerce activa de la organización." };
  return sendAttempt(admin, {
    orgId: input.orgId,
    store,
    runId: null,
    kind: "prueba",
    attempt: 1,
    payload: pagoOnlinePayload([phone], [], "prueba"),
    baseline: null,
    actor: input.actor,
    allowRetry: false,
  });
}

/**
 * «Vaciar la lista de la tienda»: manda `{"celulares": [], "correos": []}` a
 * UNA tienda (§4.2) y lo registra (`kind = manual`, 0 celulares). La tienda
 * deja de frenar el contra entrega de todos los de la lista automática hasta
 * el próximo envío; el envío diario la vuelve a llenar salvo en Apagado. Como
 * es el último envío bueno, el freno de cambio brusco del siguiente lo toma
 * como «primera» y no lo frena. En cualquier posición; no se reintenta.
 */
export async function emptyPagoOnlineStore(
  admin: Admin,
  input: { orgId: string; storeId: string; actor: string | null },
): Promise<SendAttemptResult | { error: string }> {
  let stores: PagoOnlineStore[];
  try {
    stores = await pagoOnlineStores(admin, input.orgId);
  } catch {
    return { error: "No se pudieron leer las tiendas." };
  }
  const store = stores.find((s) => s.id === input.storeId);
  if (!store) return { error: "Esa tienda no es una tienda WooCommerce activa de la organización." };
  return sendAttempt(admin, {
    orgId: input.orgId,
    store,
    runId: null,
    kind: "manual",
    attempt: 1,
    payload: pagoOnlineEmptyPayload(),
    baseline: null,
    actor: input.actor,
    allowRetry: false,
  });
}

// ── Excepciones de Kapta ────────────────────────────────────────────────────

export type PagoOnlineExceptionResult = { ok: true; id: string } | { ok: false; error: string };

/** Exceptuar un celular: no entra a la lista ni la frena, desde ya en Kapta y desde el próximo envío en la tienda. */
export async function addPagoOnlineException(
  admin: Admin,
  input: { orgId: string; phone: string; reason: string; actor: string | null; orderId?: string | null; orderName?: string | null },
): Promise<PagoOnlineExceptionResult> {
  const phone = pagoOnlinePhoneKey(input.phone);
  if (!phone) return { ok: false, error: "El pedido no tiene un celular de 9 dígitos." };
  const { data, error } = await admin
    .from("pago_online_exceptions")
    .insert({
      org_id: input.orgId,
      phone,
      reason: input.reason.trim(),
      order_id: input.orderId ?? null,
      order_name: input.orderName ?? null,
      added_by: input.actor,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return { ok: false, error: "Este cliente ya está exceptuado." };
    if (isMissingPagoOnline(error)) return { ok: false, error: "Falta la migración 0326 en la base de datos." };
    return { ok: false, error: "No se pudo guardar la excepción. Intenta de nuevo." };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/** Quitar una excepción, con motivo. La fila queda como historia. */
export async function removePagoOnlineException(
  admin: Admin,
  input: { orgId: string; id: string; reason: string; actor: string | null },
): Promise<PagoOnlineExceptionResult> {
  const { data, error } = await admin
    .from("pago_online_exceptions")
    .update({ removed_at: new Date().toISOString(), removed_by: input.actor, removed_reason: input.reason.trim() })
    .eq("id", input.id)
    .eq("org_id", input.orgId)
    .is("removed_at", null)
    .select("id");
  if (error) return { ok: false, error: "No se pudo quitar la excepción. Intenta de nuevo." };
  if (!((data ?? []) as unknown[]).length) return { ok: false, error: "Esa excepción ya no estaba." };
  return { ok: true, id: input.id };
}
