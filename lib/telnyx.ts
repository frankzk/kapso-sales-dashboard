// Cliente mínimo de Telnyx (Call Control) para el «Agente Telnyx» (MOM §11.8).
//
// Compite con el Agente Daaph (Zadarma) con el MISMO agente de xAI detrás; lo
// único que cambia es la línea. El flujo:
//
//   1. Kapta escribe la fila de `voice_calls` (`dialing`) y pide a Telnyx que
//      marque a la clienta, con detección de contestadora.
//   2. Cuando la clienta contesta (`call.answered`), Kapta abre el segundo
//      tramo hacia el SIP de xAI con `link_to` + `bridge_on_answer`: los dos
//      quedan unidos en cuanto xAI atiende. No se usa SIP REFER, que Telnyx
//      cobra a 0,10 USD por llamada.
//   3. La detección de contestadora corre en modo sombra: su resultado se
//      anota en la llamada pero no cuelga (un falso «buzón» cortó a una
//      persona en la primera prueba, 03-10-2026).
//
// Cada aviso llega firmado con Ed25519 (`telnyx-signature-ed25519` sobre
// `<timestamp>|<cuerpo>`); se verifica con la clave pública de la cuenta.

import { createPublicKey, verify } from "node:crypto";
import { zadarmaLocalPeru } from "@/lib/zadarma";

export const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/** Ventana para aceptar un aviso firmado: más vieja que esto es una repetición. */
export const TELNYX_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Un teléfono peruano en E.164 (`+51…`), o null si no es peruano. */
export function telnyxPeruE164(raw: string | null | undefined): string | null {
  const local = zadarmaLocalPeru(raw);
  return local ? `+51${local}` : null;
}

export type TelnyxLeg = "cliente" | "agente";

export interface TelnyxClientState {
  /** id de `voice_calls`. */
  vc: string;
  leg: TelnyxLeg;
}

export function encodeClientState(state: TelnyxClientState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

export function decodeClientState(raw: unknown): TelnyxClientState | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Partial<TelnyxClientState>;
    if (typeof parsed.vc !== "string" || (parsed.leg !== "cliente" && parsed.leg !== "agente")) return null;
    return { vc: parsed.vc, leg: parsed.leg };
  } catch {
    return null;
  }
}

/** Prefijo DER de una clave pública Ed25519 cruda (32 bytes) en SPKI. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verifica la firma de un aviso de Telnyx. `publicKey` es la clave pública de
 * la cuenta tal como la muestra el portal (base64 de los 32 bytes).
 */
export function verifyTelnyxSignature(input: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  publicKey: string;
  now?: Date;
}): boolean {
  const { rawBody, signature, timestamp, publicKey } = input;
  if (!signature || !timestamp || !publicKey) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - ts) > TELNYX_WEBHOOK_TOLERANCE_SECONDS) return false;
  try {
    const raw = Buffer.from(publicKey.trim(), "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(`${timestamp}|${rawBody}`, "utf8"), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export interface TelnyxConfig {
  apiKey: string;
  connectionId: string;
  /** Número de Telnyx que ve la clienta y con el que se entra a xAI (E.164). */
  fromNumber: string;
  /** Puerta SIP del agente en xAI para este número. */
  xaiSipUri: string;
  /** Puerta SIP del agente de ElevenLabs para este número; vacía si no está configurada. */
  elevenLabsSipUri: string;
}

/** Qué agente atiende la llamada: Grok (xAI) o ElevenLabs. Es `voice_calls.provider`. */
export type VoiceEngine = "grok" | "elevenlabs";

/** La puerta SIP del motor, o null si ese motor no está configurado. */
export function agentSipUriFor(cfg: Pick<TelnyxConfig, "xaiSipUri" | "elevenLabsSipUri">, engine: VoiceEngine): string | null {
  const uri = engine === "elevenlabs" ? cfg.elevenLabsSipUri : cfg.xaiSipUri;
  return uri.trim() || null;
}

export interface TelnyxDialResult {
  ok: boolean;
  callControlId?: string;
  error?: string;
  response?: Record<string, unknown>;
}

async function telnyxPost(
  cfg: Pick<TelnyxConfig, "apiKey">,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetchImpl(`${TELNYX_API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, status: 0, json: { error: `Telnyx no respondió: ${(err as Error).message}` } };
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { ok: res.ok, status: res.status, json };
}

function dialError(status: number, json: Record<string, unknown>): string {
  const errors = (json.errors as { title?: string; detail?: string }[] | undefined) ?? [];
  const first = errors[0];
  const detail = first ? [first.title, first.detail].filter(Boolean).join(": ") : String(json.error ?? "");
  return `Telnyx rechazó la llamada (${status})${detail ? `: ${detail}` : ""}`;
}

/** El cuerpo del tramo a la clienta. Separado para probarlo sin red. */
export function clienteDialBody(cfg: TelnyxConfig, voiceCallId: string, to: string): Record<string, unknown> {
  return {
    connection_id: cfg.connectionId,
    to,
    from: cfg.fromNumber,
    timeout_secs: 30,
    answering_machine_detection: "detect",
    client_state: encodeClientState({ vc: voiceCallId, leg: "cliente" }),
    command_id: `${voiceCallId}-cliente`,
  };
}

/** El cuerpo del tramo a xAI, unido al de la clienta en cuanto xAI atiende. */
export function agenteDialBody(
  cfg: TelnyxConfig,
  voiceCallId: string,
  clienteCallControlId: string,
  agentSipUri: string = cfg.xaiSipUri,
): Record<string, unknown> {
  return {
    connection_id: cfg.connectionId,
    to: agentSipUri,
    from: cfg.fromNumber,
    timeout_secs: 20,
    link_to: clienteCallControlId,
    bridge_intent: true,
    bridge_on_answer: true,
    client_state: encodeClientState({ vc: voiceCallId, leg: "agente" }),
    command_id: `${voiceCallId}-agente`,
  };
}

export async function dialTelnyx(
  cfg: TelnyxConfig,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<TelnyxDialResult> {
  const r = await telnyxPost(cfg, "/calls", body, fetchImpl);
  if (!r.ok) return { ok: false, error: dialError(r.status, r.json), response: r.json };
  const data = (r.json.data ?? {}) as { call_control_id?: string };
  if (!data.call_control_id) return { ok: false, error: "Telnyx no devolvió el id de la llamada.", response: r.json };
  return { ok: true, callControlId: data.call_control_id, response: r.json };
}

/** Cuelga un tramo. Un tramo que ya terminó responde error: no importa. */
export async function hangupTelnyx(
  cfg: Pick<TelnyxConfig, "apiKey">,
  callControlId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await telnyxPost(cfg, `/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {}, fetchImpl);
}

// ── Avisos ─────────────────────────────────────────────────────────────────

export interface TelnyxEvent {
  type: string;
  occurredAt: string | null;
  callControlId: string | null;
  state: TelnyxClientState | null;
  hangupCause: string | null;
  hangupSource: string | null;
  sipHangupCause: string | null;
  amdResult: string | null;
  recordingUrl: string | null;
  /** Solo en `call.cost`: lo que Telnyx cobró por este tramo. */
  cost: TelnyxCost | null;
}

/** Lo que Telnyx cobró por un tramo (`call.cost`). Montos en la moneda de la cuenta. */
export interface TelnyxCost {
  total: number | null;
  currency: string | null;
  billedSecs: number | null;
  /** `success` o `error`: con `error` Telnyx no pudo calcularlo. */
  status: string | null;
  parts: { parte: string; costo: number | null; tarifa: number | null; segundos: number | null }[];
}

function parseCost(p: Record<string, unknown>): TelnyxCost {
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const rawParts = Array.isArray(p.cost_parts) ? (p.cost_parts as Record<string, unknown>[]) : [];
  const parts = rawParts.map((c) => ({
    parte: typeof c.call_part === "string" ? c.call_part : "",
    costo: num(c.cost),
    tarifa: num(c.rate),
    segundos: num(c.billed_duration_secs),
  }));
  const currency = rawParts.map((c) => c.currency).find((c): c is string => typeof c === "string" && !!c) ?? null;
  return {
    total: num(p.total_cost),
    currency,
    billedSecs: num(p.billed_duration_secs),
    status: typeof p.status === "string" ? p.status : null,
    parts,
  };
}

/** Lo que se guarda en `telephony_response.costo`: cada tramo y la suma. */
export interface TelnyxCostRecord {
  cliente?: TelnyxCost;
  agente?: TelnyxCost;
  /** Suma de los tramos con monto; null si ninguno lo tiene. */
  total: number | null;
  moneda: string | null;
}

/** Suma el costo de un tramo al registro de la llamada. Repetir un aviso no duplica. */
export function applyTelnyxCost(prev: TelnyxCostRecord | null | undefined, leg: TelnyxLeg, cost: TelnyxCost): TelnyxCostRecord {
  const next: TelnyxCostRecord = { ...(prev ?? { total: null, moneda: null }), [leg]: cost };
  const legs = [next.cliente, next.agente].filter((c): c is TelnyxCost => !!c && c.total != null);
  next.total = legs.length ? Math.round(legs.reduce((sum, c) => sum + (c.total ?? 0), 0) * 1e6) / 1e6 : null;
  next.moneda = legs.find((c) => c.currency)?.currency ?? next.moneda ?? null;
  return next;
}

export function parseTelnyxEvent(body: unknown): TelnyxEvent | null {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data.event_type !== "string") return null;
  const p = (data.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const urls = (p.recording_urls ?? {}) as Record<string, unknown>;
  return {
    type: data.event_type,
    occurredAt: str(data.occurred_at),
    callControlId: str(p.call_control_id),
    state: decodeClientState(p.client_state),
    hangupCause: str(p.hangup_cause),
    hangupSource: str(p.hangup_source),
    sipHangupCause: str(p.sip_hangup_cause) ?? (typeof p.sip_hangup_cause === "number" ? String(p.sip_hangup_cause) : null),
    amdResult: str(p.result),
    recordingUrl: str(urls.mp3) ?? str(urls.wav),
    cost: data.event_type === "call.cost" ? parseCost(p) : null,
  };
}

/** Lo que dice la clienta en el historial cuando el tramo nunca llegó al agente. */
export function noAnswerResumen(ev: Pick<TelnyxEvent, "hangupCause" | "sipHangupCause">): string {
  const cause = ev.hangupCause ?? "";
  if (cause === "timeout" || cause === "no_answer") return "No contestó: timbró sin respuesta.";
  if (cause === "user_busy" || ev.sipHangupCause === "486") return "No contestó: ocupado.";
  if (cause === "call_rejected" || ev.sipHangupCause === "603") return "No contestó: rechazó la llamada.";
  if (cause === "unallocated_number" || ev.sipHangupCause === "404") return "No contestó: el número no existe.";
  return `No contestó: la llamada no llegó al agente (${cause || "sin causa"}).`;
}
