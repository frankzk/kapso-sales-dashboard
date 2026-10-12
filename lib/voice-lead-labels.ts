// Agente de voz para leads — tipos y etiquetas del panel del drawer (MOM §33).
//
// Módulo sin dependencias a propósito: lo importa un componente de cliente, y
// `lib/voice-leads.ts` arrastra `lib/voice-recovery` (y con él `node:crypto`).

export const LEAD_VOICE_OUTCOME_LABEL: Record<string, string> = {
  atender_ahora: "Quiere comprar: pasa a una asesora",
  volver_a_llamar: "Pidió que lo llamen después",
  no_compra: "No compra",
  no_llamar: "Pidió no ser contactado",
  no_contesta: "No contestó",
  sin_resultado: "Sin resultado",
};

export const LEAD_VOICE_MOTIVO_LABEL: Record<string, string> = {
  precio: "precio",
  ya_compro: "ya compró en otro lado",
  solo_miraba: "solo miraba",
  solo_informacion: "solo quería información",
  fuera_de_cobertura: "fuera de cobertura",
  desconfianza: "desconfianza",
  otro: "otro motivo",
};

/** Por qué el agente no llama a este lead (MOM §33, «Quién entra a la cola»). */
export const LEAD_VOICE_EXCLUSION_LABEL: Record<string, string> = {
  agente_apagado: "El agente de leads está apagado en esta tienda.",
  sin_telefono: "No tiene un celular peruano.",
  no_contactar: "Pidió no ser contactado.",
  ya_compro: "Ya tiene pedido.",
  fuera_de_campana: "No viene de una campaña del piloto.",
  perdido: "Está en Perdidos.",
  poco_interes: "Escribió menos de dos mensajes.",
  callback_pendiente: "El agente lo vuelve a llamar a la hora que pidió.",
  estado: "Ya no está en «Sin llamar».",
  atendido_por_asesora: "Una asesora ya lo atendió.",
  reservado: "Una asesora lo tiene tomado.",
  muy_pronto: "Todavía es turno de las asesoras.",
  muy_antiguo: "Pasó la ventana del agente.",
  grupo_control: "Grupo de control: el agente no lo llama, para medir.",
  llamada_abierta: "El agente lo está llamando ahora.",
  intentos_agotados: "El agente ya hizo todos sus intentos.",
  reintento_pronto: "El agente lo intentó hace poco.",
};

export interface LeadVoiceCallSummary {
  id: string;
  mode: "real" | "test";
  status: string;
  outcome: string | null;
  queued_at: string;
  resumen: string | null;
  motivo: string | null;
  error: string | null;
}

export interface LeadVoicePanelData {
  /** La tienda tiene el agente de leads encendido (`voice_lead_enabled`). */
  enabled: boolean;
  /** La puerta SIP del agente de leads y su secreto están configurados en Vercel. */
  configured: boolean;
  eligible: boolean;
  /** Por qué no entra, si no entra. */
  reason: string | null;
  /** Brazo del sorteo, si el lead ya fue elegible alguna vez. */
  arm: "tratamiento" | "control" | null;
  /** Pidió no ser contactado (`leads.contact_opt_out_at`). */
  optOut: boolean;
  calls: LeadVoiceCallSummary[];
}

/** El estado de una llamada del agente, en palabras. */
export function leadVoiceCallState(status: string, outcome: string | null, error: string | null): string {
  if (status === "dialing" || status === "queued") return "Marcando…";
  if (status === "in_progress") return "En conversación";
  if (outcome) return LEAD_VOICE_OUTCOME_LABEL[outcome] ?? outcome;
  if (status === "failed") return error ? `Falló: ${error}` : "Falló";
  return "Terminó";
}
