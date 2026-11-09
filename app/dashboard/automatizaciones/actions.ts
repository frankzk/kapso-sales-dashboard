"use server";

// Acciones del panel «Automatizaciones» (MOM §40). Cada una vuelve a
// comprobarlo todo en el servidor, sin fiarse de lo que mande la página:
//
//   1. Lo que se pide existe: una variante y una posición válidas, un tope en
//      su rango, o una entrada del catálogo que es un interruptor de ese tipo
//      y está en la lista blanca (`lib/automations-catalog.ts`). Ninguna otra
//      tabla ni columna se escribe desde aquí.
//   2. `automations.manage` en la organización: la de la tienda se lee con el
//      cliente de servicio, no se acepta del cliente.
//   3. Solo en producción, como los interruptores que ya había
//      (`envios/automatico`, `swayp-desde-confirmar`): en un preview no están
//      las credenciales de Aliclik ni de Swayp, y «Simular ahora» llama a
//      Aliclik.
//
// Cada cambio deja una fila en `automation_switch_events` (quién, qué, de qué
// a qué). Los casos esperados devuelven `{ error }`; ninguna lanza.

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import {
  RETRY_DAILY_CAP_MAX,
  RETRY_DAILY_CAP_MIN,
  RETRY_MODE_LABEL,
  RETRY_OUTCOME_LABEL,
  RETRY_OUTCOMES,
  isRetryMode,
  isRetryVariant,
  retryVariantLabel,
  type RetryOutcome,
} from "@/lib/lima-retry-auto";
import { runLimaRetryAuto } from "@/lib/lima-retry-auto-server";
import { env } from "@/lib/env";
import { GEOCODE_KEY_MISSING, geocodeLimaGate, type GeocodeLimaRunSummary } from "@/lib/geocode-google";
import { latestGeocodeLimaRun, runGeocodeLimaMeasure } from "@/lib/geocode-google-server";
import { loadPrepaySettings, runPrepayAutoRule } from "@/lib/prepay-list-server";
import { PREPAY_LIST_PATH, PREPAY_MODE_LABEL, isPrepayMode, type PrepaySimulationSummary } from "@/lib/prepay-list";
import { APPROX_MODE_LABEL, isApproxMode } from "@/lib/geocode-approx";
import {
  acceptPagoOnlineRun,
  emptyPagoOnlineStore,
  loadPagoOnlineSettings,
  removePagoOnlineException,
  runPagoOnlineForOrg,
  sendPagoOnlineTest,
  type SendAttemptResult,
} from "@/lib/pago-online-server";
import {
  PAGO_ONLINE_LABEL,
  PAGO_ONLINE_MODE_LABEL,
  PAGO_ONLINE_REQUIREMENT_LABEL,
  PAGO_ONLINE_SEND_STATUS_LABEL,
  isPagoOnlineMode,
  isPagoOnlineRequirement,
  pagoOnlinePhoneKey,
  pagoOnlineReasonProblem,
} from "@/lib/pago-online";
import {
  CHATBY_APPROX_KEY,
  CHATBY_ASK_KEY,
  CHATBY_HISTORY_KEY,
  PREPAY_MODE_EVENT,
  PAGO_ONLINE_ACCEPT_EVENT,
  PAGO_ONLINE_EMPTY_EVENT,
  PAGO_ONLINE_EXCEPTION_EVENT,
  PAGO_ONLINE_MODE_EVENT,
  PAGO_ONLINE_REQUIREMENT_EVENT,
  PAGO_ONLINE_RUN_EVENT,
  PAGO_ONLINE_TEST_EVENT,
  RETRY_CAP_EVENT,
  RETRY_CHATBY_ASK_EVENT,
  RETRY_GEOCODE_EVENT,
  detailPaths,
  isUuid,
  orgSwitchPatch,
  parseRetryDailyCap,
  retryVariantEventKey,
  switchRefusal,
  switchValue,
  switchableEntry,
} from "@/lib/automations-catalog";

export interface AutomationActionResult {
  error?: string;
  notice?: string;
}

const PANEL_PATH = "/dashboard/automatizaciones";
// La bandeja donde se aprueban a mano los reintentos que siguen apagados.
const RETRY_TRAY_PATH = "/dashboard/pedidos/repro-lima";

type Gate = { error: string } | { admin: ReturnType<typeof createAdminSupabase>; actor: string | null };

async function gate(orgId: string): Promise<Gate> {
  if (!isUuid(orgId)) return { error: "Organización inválida." };
  if (!(await hasOrgPermission(orgId, "automations.manage"))) {
    return { error: "Tu acceso no permite encender ni apagar automatizaciones." };
  }
  if (process.env.VERCEL_ENV !== "production") return { error: "Disponible solo en producción." };
  const user = await getCurrentUser();
  return { admin: createAdminSupabase(), actor: user?.id ?? null };
}

/**
 * La fila del historial. Si no se pudo escribir, el cambio ya está hecho: se
 * dice en el aviso en vez de deshacerlo, para que nadie crea que no se guardó.
 */
async function recordSwitch(
  admin: ReturnType<typeof createAdminSupabase>,
  row: { org_id: string; store_id: string | null; automation: string; previous: string | null; next: string; actor: string | null },
): Promise<string | null> {
  const { error } = await admin.from("automation_switch_events").insert(row);
  return error ? "Guardado, pero no quedó en «Últimos cambios»." : null;
}

/** Apagado / Simulación / Activo de una variante de los reintentos de Lima. */
export async function setRetryVariantMode(orgId: string, variant: string, mode: string): Promise<AutomationActionResult> {
  if (!isRetryVariant(variant)) return { error: "Ese reintento no existe." };
  if (!isRetryMode(mode)) return { error: "Esa posición no existe." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const { data: current, error: readError } = await g.admin
    .from("lima_retry_auto_variants")
    .select("mode")
    .eq("org_id", orgId)
    .eq("variant", variant)
    .maybeSingle();
  if (readError) return { error: "No se pudo leer la posición actual. Intenta de nuevo." };
  // Sin fila es «apagado»: así nace todo (0306).
  const previous = (current as { mode?: string } | null)?.mode ?? "apagado";
  if (previous === mode) return { notice: "Ya estaba así." };
  const { error } = await g.admin
    .from("lima_retry_auto_variants")
    .upsert({ org_id: orgId, variant, mode, updated_by: g.actor, updated_at: new Date().toISOString() }, { onConflict: "org_id,variant" });
  if (error) return { error: "No se pudo guardar. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, {
    org_id: orgId,
    store_id: null,
    automation: retryVariantEventKey(variant),
    previous,
    next: mode,
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  revalidatePath(RETRY_TRAY_PATH);
  return { notice: warn ?? `${retryVariantLabel(variant)}: ${RETRY_MODE_LABEL[mode]}.` };
}

/** El tope de guías automáticas por día de Lima, para toda la organización. */
export async function setRetryDailyCap(orgId: string, cap: number | string): Promise<AutomationActionResult> {
  const value = parseRetryDailyCap(cap);
  if (value == null) return { error: `El tope va de ${RETRY_DAILY_CAP_MIN} a ${RETRY_DAILY_CAP_MAX} guías al día, en número entero.` };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const { data: current, error: readError } = await g.admin
    .from("lima_retry_auto_settings")
    .select("daily_cap")
    .eq("org_id", orgId)
    .maybeSingle();
  if (readError) return { error: "No se pudo leer el tope actual. Intenta de nuevo." };
  const previous = (current as { daily_cap?: number } | null)?.daily_cap ?? null;
  if (previous === value) return { notice: "Ya estaba así." };
  const { error } = await g.admin
    .from("lima_retry_auto_settings")
    .upsert({ org_id: orgId, daily_cap: value, updated_by: g.actor, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (error) return { error: "No se pudo guardar el tope. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, {
    org_id: orgId,
    store_id: null,
    automation: RETRY_CAP_EVENT,
    previous: previous == null ? null : String(previous),
    next: String(value),
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  return { notice: warn ?? `Tope guardado: ${value} ${value === 1 ? "guía" : "guías"} al día.` };
}

/**
 * «Usar la ubicación por dirección (Google) si el pedido no tiene», de los
 * reintentos de Lima (0308, owner 05-11-2026). Encender exige la clave y que la
 * ÚLTIMA medición de Lima cumpla B con el edificio (`geocodeLimaGate`); apagar
 * se puede siempre.
 */
export async function setRetryGeocode(orgId: string, on: boolean): Promise<AutomationActionResult> {
  if (typeof on !== "boolean") return { error: "Esa posición no existe." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const { data: current, error: readError } = await g.admin
    .from("lima_retry_auto_settings")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  if (readError) return { error: "No se pudo leer el estado actual. Intenta de nuevo." };
  const row = current as { geocode_enabled?: boolean } | null;
  if (row && !("geocode_enabled" in row)) return { error: "Falta la migración 0308 en la base de datos." };
  const previous = row?.geocode_enabled === true;
  if (previous === on) return { notice: "Ya estaba así." };
  if (on) {
    if (!env.googleGeocodingApiKey()) return { error: `${GEOCODE_KEY_MISSING}: no se puede encender.` };
    let latest: Awaited<ReturnType<typeof latestGeocodeLimaRun>>;
    try {
      latest = await latestGeocodeLimaRun(g.admin, orgId);
    } catch {
      return { error: "No se pudo leer la última medición de Lima. Intenta de nuevo." };
    }
    const verdict = geocodeLimaGate(latest?.summary ?? null);
    if (!verdict.ok) return { error: `No se puede encender: ${verdict.reason}` };
  }
  const { error } = await g.admin
    .from("lima_retry_auto_settings")
    .upsert({ org_id: orgId, geocode_enabled: on, updated_by: g.actor, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (error) return { error: "No se pudo guardar. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, {
    org_id: orgId,
    store_id: null,
    automation: RETRY_GEOCODE_EVENT,
    previous: switchValue(previous),
    next: switchValue(on),
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  return { notice: warn ?? `Ubicación por dirección (Google) en los reintentos: ${on ? "encendida" : "apagada"}.` };
}

/**
 * «Pedir la ubicación por WhatsApp» de los reintentos de Lima (0324, owner
 * 08-11-2026): Apagado / Simulación / Activo, por organización. Fuera de
 * Apagado hace falta `CHATBY_API_KEY` (también Simulación lee la conversación).
 * Cada cambio queda en «Últimos cambios».
 */
export async function setRetryChatbyAsk(orgId: string, mode: string): Promise<AutomationActionResult> {
  if (!isApproxMode(mode)) return { error: "Esa posición no existe." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  // `*`: sin la 0324 la columna no viene y se dice, en vez de fallar al escribir.
  const { data: current, error: readError } = await g.admin.from("lima_retry_auto_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (readError) return { error: "No se pudo leer la posición actual. Intenta de nuevo." };
  const row = current as { chatby_ask_mode?: string } | null;
  if (row && !("chatby_ask_mode" in row)) return { error: "Falta la migración 0324 en la base de datos." };
  const previous = isApproxMode(row?.chatby_ask_mode) ? row!.chatby_ask_mode : "apagado";
  if (previous === mode) return { notice: "Ya estaba así." };
  if (mode !== "apagado" && !env.chatbyApiKey()) {
    return { error: "Falta la clave de Chatby en Kapta (CHATBY_API_KEY): no se puede leer la conversación de la clienta." };
  }
  const { error } = await g.admin
    .from("lima_retry_auto_settings")
    .upsert({ org_id: orgId, chatby_ask_mode: mode, updated_by: g.actor, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (error) {
    if (/chatby_ask_mode/.test(error.message ?? "")) return { error: "Falta la migración 0324 en la base de datos." };
    return { error: "No se pudo guardar. Intenta de nuevo." };
  }
  const warn = await recordSwitch(g.admin, {
    org_id: orgId,
    store_id: null,
    automation: RETRY_CHATBY_ASK_EVENT,
    previous,
    next: mode,
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  return { notice: warn ?? `Pedir la ubicación por WhatsApp en los reintentos: ${APPROX_MODE_LABEL[mode]}.` };
}

export interface LimaGeocodeMeasureResult extends AutomationActionResult {
  summary?: GeocodeLimaRunSummary;
}

/**
 * «Medir la ubicación por dirección en Lima»: la medición de Lima entre las
 * tiendas activas de la organización, hasta 150 consultas a Google. Guarda
 * solo la cuenta (`geocode_pilot_runs`) y la devuelve.
 */
export async function measureLimaGeocodeNow(orgId: string): Promise<LimaGeocodeMeasureResult> {
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const key = env.googleGeocodingApiKey();
  if (!key) return { error: `${GEOCODE_KEY_MISSING}: no se puede medir.` };
  const { data: stores, error: storesError } = await g.admin.from("stores").select("id").eq("org_id", orgId).eq("status", "active");
  if (storesError) return { error: "No se pudieron leer las tiendas. Intenta de nuevo." };
  const storeIds = ((stores ?? []) as { id: string }[]).map((s) => s.id);
  if (!storeIds.length) return { error: "La organización no tiene tiendas activas." };
  try {
    const run = await runGeocodeLimaMeasure(g.admin, { orgId, storeIds, key, actor: g.actor });
    if (!run.ok) return { error: run.error };
    revalidatePath(PANEL_PATH);
    return {
      summary: run.summary,
      notice: run.saveError ? "Medido, pero no se pudo guardar: el interruptor no lo verá." : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `La medición no terminó: ${message}` };
  }
}

/** Un interruptor de la organización (Swayp automático, piloto, Swayp desde Por confirmar, Chatby). */
export async function setOrgAutomation(orgId: string, key: string, on: boolean): Promise<AutomationActionResult> {
  const entry = switchableEntry(key, "org_table");
  if (!entry || typeof on !== "boolean") return { error: "Esa automatización no se puede cambiar desde aquí." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const { table, column, requires } = entry.control;
  const columns = requires ? `${column},${requires}` : column;
  const { data: row, error: readError } = await g.admin.from(table).select(columns).eq("org_id", orgId).maybeSingle();
  if (readError) return { error: "No se pudo leer el estado actual. Intenta de nuevo." };
  const current = row as Record<string, unknown> | null;
  // Una fila que no existe no se crea desde aquí: sus topes y ventanas son de
  // cada automatización y nadie los ha decidido para esta organización.
  const refusal = switchRefusal(entry, { on, rowExists: !!current, requiresOn: requires ? current?.[requires] === true : true });
  if (refusal) return { error: refusal };
  const previous = current![column] === true;
  if (previous === on) return { notice: "Ya estaba así." };
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await g.admin
    .from(table)
    .update(orgSwitchPatch(table, column, on, g.actor, nowIso))
    .eq("org_id", orgId)
    .select("org_id");
  if (error || !updated?.length) return { error: "No se pudo guardar. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, {
    org_id: orgId,
    store_id: null,
    automation: entry.key,
    previous: switchValue(previous),
    next: switchValue(on),
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  for (const path of detailPaths(entry)) revalidatePath(path);
  return { notice: warn ?? `${entry.name}: ${on ? "encendido" : "apagado"}.` };
}

/** Un interruptor de una tienda (agentes de voz, plantillas de WhatsApp). */
export async function setStoreAutomation(storeId: string, key: string, on: boolean): Promise<AutomationActionResult> {
  const entry = switchableEntry(key, "store_column");
  if (!entry || typeof on !== "boolean") return { error: "Esa automatización no se puede cambiar desde aquí." };
  if (!isUuid(storeId)) return { error: "Tienda inválida." };
  const { column, requires } = entry.control;
  // La organización sale de la tienda en la base, nunca del cliente.
  const reader = createAdminSupabase();
  const { data: store, error: readError } = await reader
    .from("stores")
    .select(["org_id", "name", column, ...(requires ? [requires] : [])].join(","))
    .eq("id", storeId)
    .maybeSingle();
  if (readError) return { error: "No se pudo leer la tienda. Intenta de nuevo." };
  const current = store as unknown as (Record<string, unknown> & { org_id: string; name: string | null }) | null;
  if (!current) return { error: "Esa tienda no existe." };
  const g = await gate(current.org_id);
  if ("error" in g) return { error: g.error };
  const refusal = switchRefusal(entry, { on, rowExists: true, requiresOn: requires ? current[requires] === true : true });
  if (refusal) return { error: refusal };
  const previous = current[column] === true;
  if (previous === on) return { notice: "Ya estaba así." };
  // `stores` no tiene `updated_by`/`updated_at`: quién lo cambió queda en el historial del panel.
  const { data: updated, error } = await g.admin.from("stores").update({ [column]: on }).eq("id", storeId).select("id");
  if (error || !updated?.length) return { error: "No se pudo guardar. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, {
    org_id: current.org_id,
    store_id: storeId,
    automation: entry.key,
    previous: switchValue(previous),
    next: switchValue(on),
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  for (const path of detailPaths(entry, storeId)) revalidatePath(path);
  return { notice: warn ?? `${entry.name} en ${current.name ?? "la tienda"}: ${on ? "encendido" : "apagado"}.` };
}

/** Lo que diría «Simular ahora»: qué guía habría creado cada pedido listo, sin crear nada. */
export interface RetrySimulationItem {
  orderId: string;
  orderName: string;
  variantLabel: string;
  /** La posición guardada de esa variante: la simulación las revisa todas, aunque estén apagadas. */
  modeLabel: string;
  outcome: RetryOutcome | null;
  outcomeLabel: string;
  transport: string | null;
  detail: string | null;
}

export interface RetrySimulationResult extends AutomationActionResult {
  simulation?: {
    today: string;
    limaHour: number;
    dailyCap: number;
    capLeft: number;
    stopped: boolean;
    skipped: string | null;
    items: RetrySimulationItem[];
  };
}

export async function simulateRetriesNow(orgId: string): Promise<RetrySimulationResult> {
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  try {
    const report = await runLimaRetryAuto(g.admin, { orgId, preview: true });
    if (report.error) return { error: `La simulación no terminó: ${report.error}` };
    const org = report.orgs.find((o) => o.orgId === orgId);
    const skipped = report.skipped ? String(report.skipped) : null;
    return {
      notice: org?.items.length ? undefined : "Ningún pedido está listo para reintentar ahora.",
      simulation: {
        today: report.today,
        limaHour: report.limaHour,
        dailyCap: org?.dailyCap ?? 0,
        capLeft: org?.capLeft ?? 0,
        stopped: !!report.stopped,
        skipped,
        items: (org?.items ?? []).map((item) => {
          const outcome = (RETRY_OUTCOMES as readonly string[]).includes(item.outcome) ? (item.outcome as RetryOutcome) : null;
          return {
            orderId: item.orderId,
            orderName: item.orderName ?? "Pedido",
            variantLabel: isRetryVariant(item.variant) ? retryVariantLabel(item.variant) : String(item.variant),
            modeLabel: isRetryMode(item.mode) ? RETRY_MODE_LABEL[item.mode] : String(item.mode),
            outcome,
            outcomeLabel: outcome ? RETRY_OUTCOME_LABEL[outcome] : String(item.outcome),
            transport: item.transport ?? null,
            detail: item.detail ?? null,
          };
        }),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `La simulación no terminó: ${message}` };
  }
}

// ── La «Lista de pago adelantado» (0309, MOM §41) ───────────────────────────

/**
 * Apagado / Simulación / Activo de la regla automática de la lista a mano
 * («rechazó en la puerta / no recogió en la agencia», MOM §41.2). RETIRADA por
 * el owner el 09-11-2026: la lista automática ya cubre a esos clientes (sus
 * pedidos terminan `devuelto`). Ya no tiene controles en pantalla, y aquí solo
 * se deja apagarla; el código de la regla queda dormido.
 */
export async function setPrepayAutoMode(orgId: string, mode: string): Promise<AutomationActionResult> {
  if (!isPrepayMode(mode)) return { error: "Esa posición no existe." };
  if (mode !== "apagado") {
    return { error: "La regla automática de la lista a mano está retirada (owner, 09-11-2026): la Lista negra automática ya cubre a esos clientes." };
  }
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const current = await loadPrepaySettings(g.admin, orgId);
  if (current.missing) return { error: "Falta la migración 0309 en la base de datos." };
  if (current.error) return { error: "No se pudo leer la posición actual. Intenta de nuevo." };
  const previous = current.settings.auto_mode;
  if (previous === mode) return { notice: "Ya estaba así." };
  const { error } = await g.admin
    .from("prepay_list_settings")
    .upsert({ org_id: orgId, auto_mode: mode, updated_by: g.actor, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (error) return { error: "No se pudo guardar. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, {
    org_id: orgId,
    store_id: null,
    automation: PREPAY_MODE_EVENT,
    previous,
    next: mode,
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  revalidatePath(PREPAY_LIST_PATH);
  return { notice: warn ?? `Lista negra: regla a mano en ${PREPAY_MODE_LABEL[mode]}.` };
}

export interface PrepaySimulationResult extends AutomationActionResult {
  summary?: PrepaySimulationSummary;
}

/** «Simular ahora» de la regla retirada (sin botón desde el 09-11-2026): quién entraría hoy, sin agregar a nadie. */
export async function simulatePrepayNow(orgId: string): Promise<PrepaySimulationResult> {
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  try {
    const report = await runPrepayAutoRule(g.admin, { orgId, mode: "simulacion" });
    if (report.error) return { error: `La simulación no terminó: ${report.error}` };
    const summary = report.orgs.find((o) => o.orgId === orgId)?.summary ?? undefined;
    revalidatePath(PANEL_PATH);
    return { summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `La simulación no terminó: ${message}` };
  }
}

// ── «Pago solo online (lista automática)» (0326, MOM §41.11) ───────────────

const MISSING_0326 = "Falta la migración 0326 en la base de datos.";

/** «Kenku Peru: Enviada (la tienda dice 512) · Aurela: La tienda todavía no tiene el endpoint (404)». */
function sendsNotice(sends: readonly SendAttemptResult[], names: Map<string, string>): string {
  if (!sends.length) return "No hay tiendas WooCommerce activas a las que mandar la lista.";
  return sends
    .map((r) => {
      const name = names.get(r.storeId) ?? "Tienda";
      if (r.status === "ocupado") return `${name}: otra pasada la está mandando`;
      const label = PAGO_ONLINE_SEND_STATUS_LABEL[r.status] ?? r.status;
      const verified = r.status === "enviado" && r.verify?.celulares != null ? ` (la tienda dice ${r.verify.celulares.toLocaleString("es-PE")})` : "";
      return `${name}: ${label}${verified}`;
    })
    .join(" · ");
}

async function storeNames(admin: ReturnType<typeof createAdminSupabase>, orgId: string): Promise<Map<string, string>> {
  const { data } = await admin.from("stores").select("id,name").eq("org_id", orgId);
  return new Map(((data ?? []) as { id: string; name: string | null }[]).map((s) => [s.id, s.name ?? "Tienda"]));
}

/**
 * Apagado / Simulación / Activo. Simulación calcula la lista cada día a las
 * 05:00 de Lima y solo guarda cuentas; Activo además la manda a cada tienda y
 * frena los pedidos de Kapta. Activo pide confirmación en la página.
 */
export async function setPagoOnlineMode(orgId: string, mode: string): Promise<AutomationActionResult> {
  if (!isPagoOnlineMode(mode)) return { error: "Esa posición no existe." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const current = await loadPagoOnlineSettings(g.admin, orgId);
  if (current.missing) return { error: MISSING_0326 };
  if (current.error) return { error: "No se pudo leer la posición actual. Intenta de nuevo." };
  const previous = current.settings.mode;
  if (previous === mode) return { notice: "Ya estaba así." };
  const { error } = await g.admin
    .from("pago_online_settings")
    .upsert({ org_id: orgId, mode, updated_by: g.actor, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (error) return { error: "No se pudo guardar. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, { org_id: orgId, store_id: null, automation: PAGO_ONLINE_MODE_EVENT, previous, next: mode, actor: g.actor });
  revalidatePath(PANEL_PATH);
  const tail =
    mode === "activo"
      ? " La próxima lista sale a las 05:00 de Lima, o ahora con «Calcular ahora»."
      : mode === "apagado"
        ? " Kapta deja de frenar por esta lista; las tiendas siguen con la última que recibieron."
        : "";
  return { notice: warn ?? `${PAGO_ONLINE_LABEL}: ${PAGO_ONLINE_MODE_LABEL[mode]}.${tail}` };
}

/** Lo que se le cobra al cliente de la lista en los pedidos de Kapta: «Adelanto (regla §8)» o «Pago completo». */
export async function setPagoOnlineRequirement(orgId: string, requirement: string): Promise<AutomationActionResult> {
  if (!isPagoOnlineRequirement(requirement)) return { error: "Esa opción no existe." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const current = await loadPagoOnlineSettings(g.admin, orgId);
  if (current.missing) return { error: MISSING_0326 };
  if (current.error) return { error: "No se pudo leer el ajuste actual. Intenta de nuevo." };
  const previous = current.settings.requirement;
  if (previous === requirement) return { notice: "Ya estaba así." };
  const { error } = await g.admin
    .from("pago_online_settings")
    .upsert({ org_id: orgId, requirement, updated_by: g.actor, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (error) return { error: "No se pudo guardar. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, {
    org_id: orgId,
    store_id: null,
    automation: PAGO_ONLINE_REQUIREMENT_EVENT,
    previous,
    next: requirement,
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  return { notice: warn ?? `Lista negra: se cobra ${PAGO_ONLINE_REQUIREMENT_LABEL[requirement]}.` };
}

/**
 * «Calcular ahora»: la corrida de hoy en la posición actual. En Simulación
 * solo cuenta; en Activo, si pasa el freno de cambio brusco, la manda a cada
 * tienda (un intento: los reintentos son del envío diario).
 */
export async function runPagoOnlineNow(orgId: string): Promise<AutomationActionResult> {
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const report = await runPagoOnlineForOrg(g.admin, { orgId, trigger: "manual", actor: g.actor });
  if (report.error) return { error: `No terminó: ${report.error}` };
  if (report.skipped === "apagado") return { error: "Está apagada: ponla en Simulación o en Activo antes de calcular." };
  await recordSwitch(g.admin, { org_id: orgId, store_id: null, automation: PAGO_ONLINE_RUN_EVENT, previous: null, next: report.mode, actor: g.actor });
  revalidatePath(PANEL_PATH);
  const phones = (report.counts?.phones ?? 0).toLocaleString("es-PE");
  if (report.mode === "simulacion") return { notice: `Simulación: la lista tendría ${phones} celulares. No se mandó nada ni se frena nada.` };
  if (report.guard === "bloqueado") {
    return { error: `No se mandó: ${report.guardReason ?? "cambio brusco"} Revísalo y, si está bien, «Aceptar la lista de hoy».` };
  }
  return { notice: `Lista de ${phones} celulares. ${sendsNotice(report.sends, await storeNames(g.admin, orgId))}` };
}

/** «Aceptar la lista de hoy»: la que frenó el cambio brusco pasa a ser la vigente y se manda. */
export async function acceptPagoOnlineList(orgId: string, runId: string): Promise<AutomationActionResult> {
  if (!isUuid(runId)) return { error: "Esa lista no existe." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const res = await acceptPagoOnlineRun(g.admin, { orgId, runId, actor: g.actor });
  if (!res.ok) return { error: res.error };
  await recordSwitch(g.admin, { org_id: orgId, store_id: null, automation: PAGO_ONLINE_ACCEPT_EVENT, previous: "bloqueado", next: "aceptado", actor: g.actor });
  revalidatePath(PANEL_PATH);
  return { notice: `Aceptada. ${sendsNotice(res.sends, await storeNames(g.admin, orgId))}` };
}

/**
 * «Enviar prueba» (§6 del pedido de las tiendas): una lista de UN celular del
 * equipo a una tienda, con `regla: "prueba"`, y el GET de verificación. La
 * tienda reemplaza su lista automática por ese celular hasta el próximo envío
 * real: la página lo dice antes de mandarla. El celular no se guarda.
 */
export async function sendPagoOnlineTestList(orgId: string, storeId: string, phone: string): Promise<AutomationActionResult> {
  if (!isUuid(storeId)) return { error: "Esa tienda no existe." };
  if (!pagoOnlinePhoneKey(phone)) return { error: "Escribe un celular de 9 dígitos." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const res = await sendPagoOnlineTest(g.admin, { orgId, storeId, phone, actor: g.actor });
  if ("error" in res && !("status" in res)) return { error: res.error ?? "No se pudo mandar la prueba." };
  const sent = res as SendAttemptResult;
  await recordSwitch(g.admin, { org_id: orgId, store_id: storeId, automation: PAGO_ONLINE_TEST_EVENT, previous: null, next: sent.status, actor: g.actor });
  revalidatePath(PANEL_PATH);
  const names = await storeNames(g.admin, orgId);
  if (sent.status !== "enviado") return { error: `${sendsNotice([sent], names)}${sent.error ? `: ${sent.error}` : ""}` };
  const v = sent.verify;
  return {
    notice: `${names.get(storeId) ?? "Tienda"}: prueba enviada. La tienda guardó ${sent.totals?.celulares ?? "?"} y el GET dice ${v?.celulares ?? "?"}${v?.actualizado ? ` (${v.actualizado})` : ""}. Sigue con el formulario de la tienda (§6 del pedido) y después manda la lista real con «Calcular ahora».`,
  };
}

/**
 * «Vaciar la lista de la tienda»: `{"celulares": [], "correos": []}` a UNA
 * tienda, solo el dueño (`automations.manage`), en cualquier posición. La
 * página pide confirmación: la tienda deja de frenar el contra entrega de
 * todos los de la lista automática hasta el próximo envío, y el envío diario
 * la vuelve a llenar salvo en Apagado.
 */
export async function emptyPagoOnlineStoreList(orgId: string, storeId: string): Promise<AutomationActionResult> {
  if (!isUuid(storeId)) return { error: "Esa tienda no existe." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const res = await emptyPagoOnlineStore(g.admin, { orgId, storeId, actor: g.actor });
  if ("error" in res && !("status" in res)) return { error: res.error ?? "No se pudo vaciar la lista." };
  const sent = res as SendAttemptResult;
  await recordSwitch(g.admin, { org_id: orgId, store_id: storeId, automation: PAGO_ONLINE_EMPTY_EVENT, previous: null, next: sent.status, actor: g.actor });
  revalidatePath(PANEL_PATH);
  const names = await storeNames(g.admin, orgId);
  if (sent.status !== "enviado") return { error: `${sendsNotice([sent], names)}${sent.error ? `: ${sent.error}` : ""}` };
  return {
    notice: `${names.get(storeId) ?? "Tienda"}: lista vaciada (la tienda dice ${sent.verify?.celulares ?? sent.totals?.celulares ?? "?"}). Hasta el próximo envío, la tienda no frena el contra entrega de nadie de la lista automática.`,
  };
}

/** Quitar una excepción de Kapta, con motivo: el cliente vuelve a frenar con la lista vigente si cumple la regla. */
export async function removePagoOnlineExceptionAction(orgId: string, id: string, reason: string): Promise<AutomationActionResult> {
  if (!isUuid(id)) return { error: "Esa excepción no existe." };
  const problem = pagoOnlineReasonProblem(reason);
  if (problem) return { error: problem };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const res = await removePagoOnlineException(g.admin, { orgId, id, reason, actor: g.actor });
  if (!res.ok) return { error: res.error };
  await recordSwitch(g.admin, { org_id: orgId, store_id: null, automation: PAGO_ONLINE_EXCEPTION_EVENT, previous: "exceptuado", next: "quitada", actor: g.actor });
  revalidatePath(PANEL_PATH);
  return { notice: "Excepción quitada: si sigue cumpliendo la regla, vuelve a frenar con la lista vigente y entra en el próximo envío." };
}

// ── «Aceptar ubicación aproximada en la calle correcta» (0316, MOM §6.1 y §40) ──

/**
 * Apagado / Simulación / Activo de la ubicación aproximada en la guía
 * automática de Chatby. Solo escribe `chatby_auto_settings.approx_mode` de una
 * fila que ya existe (sus topes y ventanas son de la confirmación por Chatby y
 * no se crean aquí). Activo pide la confirmación en la página.
 */
export async function setChatbyApproxMode(orgId: string, mode: string): Promise<AutomationActionResult> {
  if (!isApproxMode(mode)) return { error: "Esa posición no existe." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  // `*`: sin la 0316 la columna no viene y se dice, en vez de fallar al escribir.
  const { data: current, error: readError } = await g.admin.from("chatby_auto_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (readError) return { error: "No se pudo leer la posición actual. Intenta de nuevo." };
  const row = current as { approx_mode?: string } | null;
  if (!row) return { error: "La confirmación por Chatby no está configurada en tu organización." };
  if (!("approx_mode" in row)) return { error: "Falta la migración 0316 en la base de datos." };
  const previous = isApproxMode(row.approx_mode) ? row.approx_mode : "apagado";
  if (previous === mode) return { notice: "Ya estaba así." };
  const { data: updated, error } = await g.admin
    .from("chatby_auto_settings")
    .update({ approx_mode: mode, updated_by: g.actor, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .select("org_id");
  if (error || !updated?.length) return { error: "No se pudo guardar. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, {
    org_id: orgId,
    store_id: null,
    automation: CHATBY_APPROX_KEY,
    previous,
    next: mode,
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  return { notice: warn ?? `Ubicación aproximada en la calle correcta: ${APPROX_MODE_LABEL[mode]}.` };
}

// ── «Pedir sola la dirección o la ubicación» (0318, MOM §6.1 y §40) ──

/**
 * Apagado / Simulación / Activo de los mensajes automáticos que piden la
 * dirección completa o la ubicación cuando la guía de Chatby no sale. Solo
 * escribe `chatby_auto_settings.ask_mode` de una fila que ya existe. Activo
 * pide la confirmación en la página (manda WhatsApp a clientas).
 */
export async function setChatbyAskMode(orgId: string, mode: string): Promise<AutomationActionResult> {
  if (!isApproxMode(mode)) return { error: "Esa posición no existe." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  // `*`: sin la 0318 la columna no viene y se dice, en vez de fallar al escribir.
  const { data: current, error: readError } = await g.admin.from("chatby_auto_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (readError) return { error: "No se pudo leer la posición actual. Intenta de nuevo." };
  const row = current as { ask_mode?: string } | null;
  if (!row) return { error: "La confirmación por Chatby no está configurada en tu organización." };
  if (!("ask_mode" in row)) return { error: "Falta la migración 0318 en la base de datos." };
  const previous = isApproxMode(row.ask_mode) ? row.ask_mode : "apagado";
  if (previous === mode) return { notice: "Ya estaba así." };
  const { data: updated, error } = await g.admin
    .from("chatby_auto_settings")
    .update({ ask_mode: mode, updated_by: g.actor, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .select("org_id");
  if (error || !updated?.length) return { error: "No se pudo guardar. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, {
    org_id: orgId,
    store_id: null,
    automation: CHATBY_ASK_KEY,
    previous,
    next: mode,
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  return { notice: warn ?? `Pedir sola la dirección o la ubicación: ${APPROX_MODE_LABEL[mode]}.` };
}

// ── «Guía automática para clientas con entregas» (0317, MOM §6.1 y §40) ──

/**
 * Apagado / Simulación / Activo de la guía de Chatby con el GPS de una entrega
 * anterior de la clienta (lib/history-guide-auto.ts). Solo escribe
 * `chatby_auto_settings.history_guide_mode` de una fila que ya existe. Activo
 * pide la confirmación en la página (crea guías y confirma pedidos).
 */
export async function setChatbyHistoryMode(orgId: string, mode: string): Promise<AutomationActionResult> {
  if (!isApproxMode(mode)) return { error: "Esa posición no existe." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  // `*`: sin la 0317 la columna no viene y se dice, en vez de fallar al escribir.
  const { data: current, error: readError } = await g.admin.from("chatby_auto_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (readError) return { error: "No se pudo leer la posición actual. Intenta de nuevo." };
  const row = current as { history_guide_mode?: string } | null;
  if (!row) return { error: "La confirmación por Chatby no está configurada en tu organización." };
  if (!("history_guide_mode" in row)) return { error: "Falta la migración 0317 en la base de datos." };
  const previous = isApproxMode(row.history_guide_mode) ? row.history_guide_mode : "apagado";
  if (previous === mode) return { notice: "Ya estaba así." };
  const { data: updated, error } = await g.admin
    .from("chatby_auto_settings")
    .update({ history_guide_mode: mode, updated_by: g.actor, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .select("org_id");
  if (error || !updated?.length) return { error: "No se pudo guardar. Intenta de nuevo." };
  const warn = await recordSwitch(g.admin, {
    org_id: orgId,
    store_id: null,
    automation: CHATBY_HISTORY_KEY,
    previous,
    next: mode,
    actor: g.actor,
  });
  revalidatePath(PANEL_PATH);
  return { notice: warn ?? `Guía automática para clientas con entregas: ${APPROX_MODE_LABEL[mode]}.` };
}
