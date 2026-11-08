import "server-only";

// La posición de «Pedir sola la dirección o la ubicación» para el panel
// Automatizaciones (0318, MOM §6.1 y §40). Una lectura chica de la fila de la
// confirmación por Chatby; sin la 0318 la columna no viene y es Apagado.

import type { SupabaseClient } from "@supabase/supabase-js";
import { approxModeFrom } from "@/lib/geocode-approx";
import type { ChatbyAskMode } from "@/lib/chatby-auto-ask";

export interface ChatbyAskModeView {
  /** Falso si la 0318 aún no está: el control se bloquea y todo es Apagado. */
  available: boolean;
  /** La organización tiene su fila de la confirmación por Chatby. */
  rowExists: boolean;
  mode: ChatbyAskMode;
  error: string | null;
}

function isMissing(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return ["42P01", "42703", "PGRST205", "PGRST204"].includes(error.code ?? "") || /does not exist|could not find/i.test(error.message ?? "");
}

/** Una columna de tres posiciones de `chatby_auto_settings`; sin su migración, la columna no viene y es Apagado. */
async function loadChatbyModeColumn(admin: SupabaseClient, orgId: string, column: string, name: string): Promise<ChatbyAskModeView> {
  const empty: ChatbyAskModeView = { available: false, rowExists: false, mode: "apagado", error: null };
  // `*`: sin la migración, la columna no viene y es Apagado.
  const { data, error } = await admin.from("chatby_auto_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (error) {
    if (isMissing(error)) return empty;
    return { ...empty, error: `No se pudo leer «${name}»: no se puede cambiar ahora.` };
  }
  const row = data as Record<string, unknown> | null;
  if (row && !(column in row)) return empty;
  return { available: true, rowExists: !!row, mode: approxModeFrom(row?.[column]), error: null };
}

export async function loadChatbyAskModeView(admin: SupabaseClient, orgId: string): Promise<ChatbyAskModeView> {
  return loadChatbyModeColumn(admin, orgId, "ask_mode", "Pedir sola la dirección o la ubicación");
}

/** «Guía automática para clientas con entregas» (0317, lib/history-guide-auto.ts). */
export async function loadChatbyHistoryModeView(admin: SupabaseClient, orgId: string): Promise<ChatbyAskModeView> {
  return loadChatbyModeColumn(admin, orgId, "history_guide_mode", "Guía automática para clientas con entregas");
}
