// Lo que el agente de IA (Grok) puede HACER en Kapta (MOM §42.9, parte 3;
// 08-11-2026; 0323): dejar notas en el pedido, escribirle por WhatsApp a la
// clienta y crear la guía de Aliclik. Decisiones del owner:
//
//   · Notas: solas desde el primer día. Riesgo bajo: una nota equivocada se
//     corrige con otra.
//   · WhatsApp (solo dentro de las 24 h de WhatsApp) y guías: un interruptor por
//     organización Apagado / Simulación / Activo, como las demás automatizaciones
//     (§40). Nace en Simulación: una semana revisando lo que habría hecho, y
//     después Activo con topes. Mientras tanto, lo que el owner le pide en el
//     chat y aprueba ahí se hace de verdad.
//   · Frenos de Kapta, haga lo que haga el agente: los permisos de quien aprobó
//     la conexión, las mismas compuertas que el botón de la guía, una vez y no
//     más (una guía por pedido; un WhatsApp por pedido cada 4 h, nunca el mismo
//     texto dos veces), topes por día de Lima (20 WhatsApp, 10 guías), todo en
//     la Actividad marcado como del agente, y la conexión se revoca en un clic.
//
// DOS PASOS para WhatsApp y guías: el agente pide la VISTA PREVIA (no hace
// nada; deja un código de un solo uso de 10 minutos) y después CONFIRMA con ese
// código. Al confirmar se vuelve a comprobar todo. El agente declara si la
// acción es del «chat» (el owner la pidió y la aprobó ahí) o de una «rutina»
// (por su cuenta). Kapta no puede verificar esa declaración: la vista previa,
// los topes y el registro son los frenos que no dependen de ella.
//
// Este archivo es PURO y sin `node:crypto` (la pantalla lo importa para sus
// nombres); el hash y los códigos viven en lib/agent-action-codes.ts.

export type AgentActionKind = "nota" | "whatsapp" | "guia_aliclik";
export type AgentMode = "apagado" | "simulacion" | "activo";
export type AgentOrigin = "chat" | "rutina";
export type AgentActionStatus = "prevista" | "en_curso" | "simulada" | "hecha" | "rechazada" | "error" | "incierta";

export const AGENT_MODE_LABEL: Record<AgentMode, string> = {
  apagado: "Apagado",
  simulacion: "Simulación",
  activo: "Activo",
};

export const AGENT_ACTION_LABEL: Record<AgentActionKind, string> = {
  nota: "Nota en el pedido",
  whatsapp: "WhatsApp a la clienta",
  guia_aliclik: "Guía de Aliclik",
};

export const AGENT_STATUS_LABEL: Record<AgentActionStatus, string> = {
  prevista: "Vista previa",
  en_curso: "En curso",
  simulada: "Simulada (no se hizo)",
  hecha: "Hecha",
  rechazada: "Rechazada",
  error: "Error",
  incierta: "Incierta",
};

export interface AgentActionSettings {
  whatsappMode: AgentMode;
  guideMode: AgentMode;
  whatsappDailyCap: number;
  guideDailyCap: number;
}

/** Sin fila en `agent_action_settings`: Simulación con los topes de fábrica. */
export const DEFAULT_AGENT_SETTINGS: AgentActionSettings = {
  whatsappMode: "simulacion",
  guideMode: "simulacion",
  whatsappDailyCap: 20,
  guideDailyCap: 10,
};

export const AGENT_CODE_TTL_MS = 10 * 60_000;
/** Cuántas acciones del agente muestra la pantalla por organización. */
export const AGENT_ACTIONS_SHOWN = 60;
/** WhatsApp deja mandar texto libre hasta 24 h después del último mensaje de la clienta. */
export const WHATSAPP_WINDOW_MS = 24 * 3600_000;
/** Un WhatsApp del agente por pedido cada 4 horas. */
export const WHATSAPP_ORDER_GAP_MS = 4 * 3600_000;
export const AGENT_NOTE_MIN = 3;
export const AGENT_NOTE_MAX = 1000;
export const AGENT_WHATSAPP_MAX = 1000;
/** El tipo de comentario con que la nota del agente sale en la Actividad. */
export const AGENT_COMMENT_TYPE = "Agente de IA";
/** El `source` de lo que el agente deja en `order_events`. */
export const AGENT_EVENT_SOURCE = "agente_ia";
/** El hecho del WhatsApp que mandó el agente. */
export const AGENT_WHATSAPP_EVENT = "agent_whatsapp";

export function isAgentMode(v: unknown): v is AgentMode {
  return v === "apagado" || v === "simulacion" || v === "activo";
}

/**
 * Qué pasa al confirmar, según la posición del interruptor y el origen
 * declarado: Apagado no hace nada; Simulación hace solo lo que el owner aprobó
 * en el chat y registra el resto como «habría hecho»; Activo lo hace. PURA.
 */
export function agentExecution(mode: AgentMode, origin: AgentOrigin): "rechazar" | "simular" | "ejecutar" {
  if (mode === "apagado") return "rechazar";
  if (mode === "simulacion" && origin === "rutina") return "simular";
  return "ejecutar";
}

/** El texto en una forma comparable: sin tildes, minúsculas, sin espacios de sobra ni puntuación al final. PURA. */
export function comparableBody(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!¡?¿,;:]+$/g, "")
    .trim();
}

/** Una línea por párrafo, sin espacios de sobra ni más de una línea en blanco. PURA. */
export function cleanAgentText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** La ventana de 24 h de WhatsApp: abierta si la clienta escribió hace menos de 24 h. PURA. */
export function whatsappWindow(lastInboundMs: number | null, nowMs: number): { open: boolean; until: string | null } {
  if (lastInboundMs == null || !Number.isFinite(lastInboundMs)) return { open: false, until: null };
  const until = lastInboundMs + WHATSAPP_WINDOW_MS;
  return { open: until > nowMs, until: new Date(until).toISOString() };
}

/** El comienzo del día de Lima (UTC−5, sin horario de verano) de `now`, en ISO. PURA. */
export function limaDayStartIso(now: Date): string {
  const lima = new Date(now.getTime() - 5 * 3600_000);
  return new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate(), 5, 0, 0)).toISOString();
}

export interface PriorAgentAction {
  action: AgentActionKind;
  status: AgentActionStatus;
  body_key: string | null;
  resolved_at: string | null;
  /** Para lo que está en curso, que todavía no tiene `resolved_at`. */
  created_at?: string | null;
}

/**
 * Lo que cuenta como hecho para los frenos: lo que salió, lo que pudo salir
 * (incierto) y lo que está saliendo ahora (en curso). Lo simulado NO cuenta:
 * no salió, y no debe frenar lo que el owner aprueba en el chat.
 */
export const AGENT_COUNTED_STATUSES: readonly AgentActionStatus[] = ["en_curso", "hecha", "incierta"];

function counted(p: PriorAgentAction): boolean {
  return AGENT_COUNTED_STATUSES.includes(p.status);
}

/** ¿Se puede mandar otro WhatsApp a este pedido? PURA. */
export function whatsappOrderBlock(prior: readonly PriorAgentAction[], key: string, nowMs: number): string | null {
  const sent = prior.filter((p) => p.action === "whatsapp" && counted(p));
  if (sent.some((p) => p.body_key === key)) return "Ese mismo texto ya se le mandó a la clienta de este pedido: no se repite.";
  // En curso todavía no tiene `resolved_at`: cuenta desde que nació (sin fecha,
  // como «ahora»). Así una que quedó colgada no frena el pedido para siempre.
  const when = (p: PriorAgentAction) => {
    const at = p.resolved_at ?? (p.status === "en_curso" ? p.created_at ?? null : null);
    const ms = at ? Date.parse(at) : p.status === "en_curso" ? nowMs : 0;
    return Number.isFinite(ms) ? ms : 0;
  };
  const last = Math.max(...sent.map(when), 0);
  if (last && nowMs - last < WHATSAPP_ORDER_GAP_MS) {
    const next = new Date(last + WHATSAPP_ORDER_GAP_MS).toISOString();
    return `El agente ya le escribió a esta clienta hace menos de 4 horas. El próximo, desde ${next}; antes, que le escriba una persona.`;
  }
  return null;
}

/** ¿Ya hay una guía del agente para este pedido? (Las compuertas de Aliclik miran además las de todos.) PURA. */
export function guideOrderBlock(prior: readonly PriorAgentAction[]): string | null {
  return prior.some((p) => p.action === "guia_aliclik" && counted(p))
    ? "El agente ya creó (o está creando) la guía de este pedido: una guía por pedido."
    : null;
}

/** ¿Queda tope hoy? PURA. */
export function dailyCapBlock(doneToday: number, cap: number, label: string): string | null {
  return doneToday >= cap ? `Se llegó al tope de ${cap} ${label} del agente por hoy (día de Lima). Mañana sigue, o que lo haga una persona.` : null;
}

/** El celular con solo sus 3 últimos dígitos: «•••••321». PURA. */
export function maskPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 6 ? `${"•".repeat(Math.min(digits.length - 3, 9))}${digits.slice(-3)}` : null;
}

export const AGENT_ACTIONS_MIGRATION_MISSING =
  "Falta aplicar la migración 0323 (acciones del agente de IA) en la base. Hasta entonces el agente solo puede leer.";

/** «No existe» de Postgres (42P01) y de PostgREST (PGRST205), solo para las tablas de la 0323. PURA. */
export function isAgentActionsMigrationMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  if (e.code !== "42P01" && e.code !== "PGRST205") return false;
  return [e.message, e.details, e.hint].some((t) => typeof t === "string" && /\bagent_action(?:s|_settings)\b/.test(t));
}

/** La fila de `agent_action_settings`, o los valores de fábrica si falta o trae algo raro. PURA. */
export function parseAgentSettings(row: Record<string, unknown> | null | undefined): AgentActionSettings {
  if (!row) return { ...DEFAULT_AGENT_SETTINGS };
  const cap = (v: unknown, max: number, fallback: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : fallback;
  return {
    whatsappMode: isAgentMode(row.whatsapp_mode) ? row.whatsapp_mode : DEFAULT_AGENT_SETTINGS.whatsappMode,
    guideMode: isAgentMode(row.guide_mode) ? row.guide_mode : DEFAULT_AGENT_SETTINGS.guideMode,
    whatsappDailyCap: cap(row.whatsapp_daily_cap, AGENT_WHATSAPP_CAP_MAX, DEFAULT_AGENT_SETTINGS.whatsappDailyCap),
    guideDailyCap: cap(row.guide_daily_cap, AGENT_GUIDE_CAP_MAX, DEFAULT_AGENT_SETTINGS.guideDailyCap),
  };
}

/** Los techos de los topes (los mismos `check` de la 0323). */
export const AGENT_WHATSAPP_CAP_MAX = 200;
export const AGENT_GUIDE_CAP_MAX = 100;

/** El origen de la guía que crea el agente (`AliclikGuideOrigin.kind`). */
export const AGENT_GUIDE_ORIGIN_KIND = "agente_ia";

/** El motivo que queda en el hecho `guide_registered` de la guía del agente. PURA. */
export function agentGuideReason(label: string, origin: AgentOrigin): string {
  const who = label.trim() || "Agente de IA";
  return origin === "chat"
    ? `Creada por el agente de IA «${who}»: se la pidieron y la aprobaron en el chat.`
    : `Creada por el agente de IA «${who}» por su cuenta (rutina).`;
}

/** Lo que pasará al confirmar, dicho para el agente. PURA. */
export function agentExecutionNote(mode: AgentMode, origin: AgentOrigin): string {
  const what = agentExecution(mode, origin);
  if (what === "rechazar") return "El interruptor está Apagado: al confirmar no se hace nada.";
  if (what === "simular") return "Simulación: al confirmar se registra lo que habría hecho, sin hacerlo. El dueño lo revisa en Kapta.";
  return mode === "simulacion"
    ? "Simulación, pero con origen «chat»: al confirmar se hace DE VERDAD. Confirma solo si quien te lo pidió aprobó esta vista previa."
    : "Activo: al confirmar se hace de verdad.";
}
