"use client";

import type * as Actions from "@/app/dashboard/leads/actions";
import { createBrowserSupabase } from "@/lib/supabase-browser";

// Type-only reference: this module never invokes a Next Server Action.

/** Lo más que una lectura espera a que la pestaña renueve la sesión; después sigue igual. */
export const SESSION_FRESHNESS_TIMEOUT_MS = 3_000;

let freshness: Promise<void> | null = null;

/**
 * Renueva la sesión UNA vez antes de las lecturas (owner, 18-11-2026). A las
 * 08:50 la pestaña de Leads pidió ~10 cosas a la vez con la sesión vencida y
 * cada una la renovó en el servidor: 10 renovaciones simultáneas, algunas
 * descartadas (`AuthRefreshDiscardedError`) y una lectura sin usuario. Ahora
 * las lecturas que salen juntas esperan una sola renovación en el navegador
 * (`getSession` renueva si venció, con su candado) y llegan con la cookie
 * fresca. Nunca bloquea: un fallo o más de 3 s y la lectura sale igual.
 * Fuera del navegador devuelve null y la lectura sale en el mismo instante.
 */
export function ensureFreshSession(): Promise<void> | null {
  if (typeof window === "undefined") return null;
  if (!freshness) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = Promise.resolve()
      .then(() => createBrowserSupabase().auth.getSession())
      .then(() => undefined, () => undefined);
    const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, SESSION_FRESHNESS_TIMEOUT_MS); });
    freshness = Promise.race([refresh, cap]).finally(() => {
      clearTimeout(timer);
      freshness = null;
    });
  }
  return freshness;
}
type Reads = Pick<typeof Actions, "loadLeadStoreDistribution" | "loadLeadCustomerHistory" | "loadLeadDetail" | "loadNextLeadCart" | "loadLeadDeliveryCoverage" | "loadLeadVoicePanel" | "loadLeadsInsightsPanel" | "pollLeadsQueue" | "searchLeads" | "loadLeadsForAudience" | "listLeadTemplates" | "listQuickReplies" | "loadLeadConversation" | "loadOrderDraft" | "pollLeadState" | "searchStoreProducts" | "listStoreVendedoras" | "listYapeAlerts" | "listCallbackReturns">;

export async function readLeadData<K extends keyof Reads>(
  operation: K,
  args: Parameters<Reads[K]>,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<Reads[K]>>> {
  const fresh = ensureFreshSession();
  if (fresh) {
    await fresh;
    // Cancelada mientras esperaba la sesión (una búsqueda vieja): no sale.
    signal?.throwIfAborted();
  }
  const response = await fetch("/api/leads/read", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, args }),
    signal,
  });
  if (!response.ok) {
    throw new Error(response.status === 401
      ? "Tu sesión venció. Vuelve a iniciar sesión."
      : "No se pudo cargar la información. Intenta nuevamente.");
  }
  return response.json();
}

export const loadLeadCustomerHistory = (...args: Parameters<Reads["loadLeadCustomerHistory"]>) => readLeadData("loadLeadCustomerHistory", args);
export const loadLeadDetail = (...args: Parameters<Reads["loadLeadDetail"]>) => readLeadData("loadLeadDetail", args);
export const loadNextLeadCart = (...args: Parameters<Reads["loadNextLeadCart"]>) => readLeadData("loadNextLeadCart", args);
export const loadLeadDeliveryCoverage = (...args: Parameters<Reads["loadLeadDeliveryCoverage"]>) => readLeadData("loadLeadDeliveryCoverage", args);
export const loadLeadVoicePanel = (...args: Parameters<Reads["loadLeadVoicePanel"]>) => readLeadData("loadLeadVoicePanel", args);
export const loadLeadsInsightsPanel = (...args: Parameters<Reads["loadLeadsInsightsPanel"]>) => readLeadData("loadLeadsInsightsPanel", args);
export const pollLeadsQueue = (...args: Parameters<Reads["pollLeadsQueue"]>) => readLeadData("pollLeadsQueue", args);
export const loadLeadsForAudience = (...args: Parameters<Reads["loadLeadsForAudience"]>) => readLeadData("loadLeadsForAudience", args);
export const listLeadTemplates = (...args: Parameters<Reads["listLeadTemplates"]>) => readLeadData("listLeadTemplates", args);
export const listQuickReplies = (...args: Parameters<Reads["listQuickReplies"]>) => readLeadData("listQuickReplies", args);
export const loadLeadConversation = (
  leadId: string, conversationId?: string, includeOlder = true, signal?: AbortSignal,
  refreshActiveOnly = false,
) => readLeadData("loadLeadConversation", [leadId, conversationId, includeOlder, refreshActiveOnly], signal);
export const loadOrderDraft = (...args: Parameters<Reads["loadOrderDraft"]>) => readLeadData("loadOrderDraft", args);
export const pollLeadState = (...args: Parameters<Reads["pollLeadState"]>) => readLeadData("pollLeadState", args);
export const searchStoreProducts = (...args: Parameters<Reads["searchStoreProducts"]>) => readLeadData("searchStoreProducts", args);
export const listStoreVendedoras = (...args: Parameters<Reads["listStoreVendedoras"]>) => readLeadData("listStoreVendedoras", args);
export const listYapeAlerts = (...args: Parameters<Reads["listYapeAlerts"]>) => readLeadData("listYapeAlerts", args);

export const listCallbackReturns = (...args: Parameters<Reads["listCallbackReturns"]>) => readLeadData("listCallbackReturns", args);

export const searchLeads = (...[scope, query, signal]: [...Parameters<Reads["searchLeads"]>, AbortSignal?]) =>
  readLeadData("searchLeads", [scope, query], signal);


export const loadLeadStoreDistribution = (...args: Parameters<Reads["loadLeadStoreDistribution"]>) => readLeadData("loadLeadStoreDistribution", args);
