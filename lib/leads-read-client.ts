"use client";

import type * as Actions from "@/app/dashboard/leads/actions";

// Type-only reference: this module never invokes a Next Server Action.
type Reads = Pick<typeof Actions, "loadLeadCustomerHistory" | "loadLeadDetail" | "loadLeadsInsightsPanel" | "pollLeadsQueue" | "searchLeads" | "loadLeadsForAudience" | "listLeadTemplates" | "listQuickReplies" | "loadLeadConversation" | "loadOrderDraft" | "pollLeadState" | "searchStoreProducts" | "listStoreVendedoras" | "listYapeAlerts">;

export async function readLeadData<K extends keyof Reads>(
  operation: K,
  args: Parameters<Reads[K]>,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<Reads[K]>>> {
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

export const searchLeads = (...[scope, query, signal]: [...Parameters<Reads["searchLeads"]>, AbortSignal?]) =>
  readLeadData("searchLeads", [scope, query], signal);

