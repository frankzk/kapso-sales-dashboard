// Agente de voz — tipos y etiquetas del panel del drawer (MOM §11.8).
//
// Módulo sin dependencias a propósito: lo importa un componente de cliente, y
// `lib/voice-recovery.ts` arrastra `node:crypto` (vía Zadarma) al navegador.

export interface VoiceCallSummary {
  id: string;
  mode: "real" | "test";
  status: string;
  outcome: string | null;
  queued_at: string;
  resumen: string | null;
  no_llamar: boolean;
  /** El agente propuso descartar y la tienda no lo delega: lo hace una persona. */
  propone_descartar: boolean;
  error: string | null;
}

export interface VoiceAgentPanelData {
  /** La tienda tiene la cola encendida (`voice_recovery_enabled`). */
  enabled: boolean;
  /** Número del agente y extensión con caller ID peruano configurados. */
  configured: boolean;
  eligible: boolean;
  /** Por qué no entra, si no entra. */
  reason: string | null;
  calls: VoiceCallSummary[];
}

export const VOICE_OUTCOME_LABEL: Record<string, string> = {
  confirma: "Acepta el reenvío",
  programar: "Volver a llamar",
  no_contesta: "No contestó",
  cancela: "No quiere el pedido",
  sin_resultado: "Sin resultado",
};
