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
import {
  RETRY_CAP_EVENT,
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
