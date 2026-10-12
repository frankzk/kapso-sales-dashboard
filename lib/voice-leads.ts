// Agente de voz para leads — reglas puras (MOM §33).
//
// Un agente de ElevenLabs SEPARADO del de Reproprovincia (§11.8) llama a los
// leads de anuncio que conversaron con el bot, no compraron y ninguna asesora
// tocó. Aquí vive todo lo que decide sin tocar la base, para poder probarlo:
//   - a quién llama (`leadVoiceEligible`) y en qué orden,
//   - quién va al grupo de control (`leadVoiceArm`, sorteo independiente),
//   - qué escucha el agente al conectar (`buildLeadFicha`, `leadVoiceInitiation`),
//   - qué escribe cada resultado sobre el lead (`translateLeadResult`, `leadPatchFor`).
//
// El agente NO crea pedidos. Lo más que hace es dejar el lead en «Atender
// ahora» con los datos que tomó, para que una asesora genere el pedido.

import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";
import { assignArm, type ExperimentArm } from "@/lib/lead-experiment";
import { categoryOf, isClaimActive, labelOf } from "@/lib/leads";
import { LEAD_VOICE_MOTIVO_LABEL, LEAD_VOICE_OUTCOME_LABEL } from "@/lib/voice-lead-labels";
import { primerNombre, tiendaHablada, voiceDates } from "@/lib/voice-recovery";
import { VOICE_SUNDAY_START_HOUR } from "@/lib/voice-recovery-queue";

// ── Constantes ──────────────────────────────────────────────────────────────

/** `voice_calls.purpose` de las llamadas de este agente. */
export const LEAD_VOICE_PURPOSE = "lead" as const;

/**
 * El sorteo del grupo de control, en `lead_experiments` (0144). Otra sal que
 * `frio_cobertura_v1`, así que el REPARTO es independiente; pero el agente sí
 * toca ese otro experimento, porque llama sobre todo a los leads que nadie
 * tocó, que son en su mayoría su control (MOM §33.3).
 */
export const LEAD_VOICE_EXPERIMENT = "agente_voz_leads_v1";

/**
 * El `agent_number` de todas las llamadas de este agente. Uno solo: hay un
 * agente y un número de ElevenLabs, así que hay a lo más UNA llamada de leads
 * abierta (índice único de 0190), y el inicio de conversación sabe cuál es.
 * No lleva dígitos a propósito: no puede coincidir con ningún carril de
 * Reproprovincia, que se comparan por dígitos.
 */
export const LEAD_VOICE_LANE = "leads";

/** `lead_calls.kind` de lo que escribe el agente. NO es `call`: `call` es una persona. */
export const LEAD_VOICE_KIND = "voice_agent";

/** `leads.handoff_reason` del «quiere comprar». No dice pago ni logística (`handoffStatus`). */
export const LEAD_VOICE_HANDOFF_REASON = "agente_voz";

/** Firma de las notas del agente en el historial del lead. */
export const LEAD_VOICE_NOTE_SIGNER = "Agente de voz";

/** Mensajes entrantes mínimos: el que escribió dos veces conversó; el que escribió una, no. */
export const LEAD_VOICE_MIN_INBOUND = 2;

/**
 * Días desde el sorteo para que un lead entre a la comparación del tablero:
 * el mismo corte de maduración que `read_lead_experiment` (0150).
 */
export const LEAD_VOICE_MATURATION_DAYS = 7;

/** Horas entre dos intentos del agente al mismo lead (los de «volver a llamar» no esperan). */
export const LEAD_VOICE_RETRY_GAP_HOURS = 3;

/** Los resultados que el agente registra. */
export const LEAD_VOICE_RESULTS = ["atender_ahora", "volver_a_llamar", "no_compra", "no_llamar", "no_contesta"] as const;
export type LeadVoiceResult = (typeof LEAD_VOICE_RESULTS)[number];

/** Los `voice_calls.outcome` del carril (0247): los del agente más el `sin_resultado` del barrido. */
export const LEAD_VOICE_OUTCOMES = [...LEAD_VOICE_RESULTS, "sin_resultado"] as const;
export type LeadVoiceOutcome = (typeof LEAD_VOICE_OUTCOMES)[number];

/** Por qué no compra. Es el dato que hoy falta: la conversación con el bot no lo dice. */
export const LEAD_VOICE_MOTIVOS = [
  "precio",
  "ya_compro",
  "solo_miraba",
  "solo_informacion",
  "fuera_de_cobertura",
  "desconfianza",
  "otro",
] as const;
export type LeadVoiceMotivo = (typeof LEAD_VOICE_MOTIVOS)[number];

/**
 * El estado del lead para cada motivo, del catálogo que ya usan las asesoras
 * (`LEAD_STATUSES`). No hay estado para «precio» ni «desconfianza»: van a
 * «Cancelado por cliente» y el motivo queda en la nota y en la llamada.
 */
export const LEAD_VOICE_MOTIVO_STATUS: Record<LeadVoiceMotivo, string> = {
  precio: "cancelado_cliente",
  ya_compro: "ya_compro_otro_lado",
  solo_miraba: "solo_miraba",
  solo_informacion: "solo_informacion",
  fuera_de_cobertura: "fuera_de_ciudad",
  desconfianza: "cancelado_cliente",
  otro: "cancelado_cliente",
};

// ── Ajustes por tienda ──────────────────────────────────────────────────────

export interface LeadVoiceSettings {
  enabled: boolean;
  auto: boolean;
  dailyCap: number;
  maxAttempts: number;
  waitMinutes: number;
  maxAgeHours: number;
  holdoutPct: number;
  hourStart: number;
  hourEnd: number;
  campaignIds: string[];
  product: string;
  offer: string;
}

export const VOICE_LEAD_STORE_COLUMNS =
  "id, name, timezone, voice_lead_enabled, voice_lead_auto, voice_lead_daily_cap, voice_lead_max_attempts, " +
  "voice_lead_wait_minutes, voice_lead_max_age_hours, voice_lead_holdout_pct, voice_lead_hour_start, " +
  "voice_lead_hour_end, voice_lead_campaign_ids, voice_lead_product, voice_lead_offer";

export interface VoiceLeadStoreRow {
  id: string;
  name: string | null;
  timezone?: string | null;
  voice_lead_enabled?: boolean | null;
  voice_lead_auto?: boolean | null;
  voice_lead_daily_cap?: number | null;
  voice_lead_max_attempts?: number | null;
  voice_lead_wait_minutes?: number | null;
  voice_lead_max_age_hours?: number | null;
  voice_lead_holdout_pct?: number | null;
  voice_lead_hour_start?: number | null;
  voice_lead_hour_end?: number | null;
  voice_lead_campaign_ids?: string[] | null;
  voice_lead_product?: string | null;
  voice_lead_offer?: string | null;
}

const int = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback);

/** Los ajustes de la fila de la tienda, con los defectos de 0247 si una columna falta. */
export function leadVoiceSettingsFrom(row: VoiceLeadStoreRow | null | undefined): LeadVoiceSettings {
  return {
    enabled: row?.voice_lead_enabled === true,
    auto: row?.voice_lead_auto === true,
    dailyCap: int(row?.voice_lead_daily_cap, 40),
    maxAttempts: int(row?.voice_lead_max_attempts, 2),
    waitMinutes: int(row?.voice_lead_wait_minutes, 120),
    maxAgeHours: int(row?.voice_lead_max_age_hours, 48),
    holdoutPct: int(row?.voice_lead_holdout_pct, 50),
    hourStart: int(row?.voice_lead_hour_start, 9),
    hourEnd: int(row?.voice_lead_hour_end, 20),
    campaignIds: (row?.voice_lead_campaign_ids ?? []).map((c) => String(c).trim()).filter(Boolean),
    product: String(row?.voice_lead_product ?? "").trim(),
    offer: String(row?.voice_lead_offer ?? "").trim(),
  };
}

// ── Teléfono ────────────────────────────────────────────────────────────────

/**
 * El celular peruano del lead en formato `51XXXXXXXXX`, o null. Solo celulares
 * (empiezan en 9): un fijo no es de quien escribió por WhatsApp.
 */
export function leadVoicePhone(phone: string | null | undefined): string | null {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (/^519\d{8}$/.test(d)) return d;
  if (/^9\d{8}$/.test(d)) return `51${d}`;
  return null;
}

// ── El sorteo ───────────────────────────────────────────────────────────────

/**
 * Brazo del lead. `tratamiento` = el agente lo llama; `control` = nunca. PURA y
 * determinista: el mismo lead cae siempre del mismo lado. El brazo se GUARDA la
 * primera vez que el lead es elegible, así que cambiar el porcentaje después
 * solo afecta a los que entren desde entonces.
 */
export function leadVoiceArm(leadId: string, holdoutPct: number): ExperimentArm {
  const pct = Math.min(100, Math.max(0, Number.isFinite(holdoutPct) ? holdoutPct : 50));
  return assignArm(leadId, LEAD_VOICE_EXPERIMENT, (100 - pct) / 100);
}

// ── A quién llama ───────────────────────────────────────────────────────────

export interface LeadVoiceLead {
  id: string;
  store_id: string;
  phone: string | null;
  name: string | null;
  status: string;
  category: string;
  has_order: boolean | null;
  order_id: string | null;
  source: string | null;
  ad_id: string | null;
  inbound_count: number | null;
  first_seen_at: string | null;
  last_inbound_at: string | null;
  claimed_at: string | null;
  next_followup_at: string | null;
  contact_opt_out_at: string | null;
  /** Último handoff del bot (o del agente) a «Atender ahora». */
  handoff_at: string | null;
}

/** Una llamada anterior del agente a este lead (`voice_calls`, purpose lead, modo real). */
export interface LeadVoiceAttempt {
  queued_at: string;
  status: string;
  outcome: string | null;
}

export interface LeadVoiceEligibilityInput {
  lead: LeadVoiceLead;
  now: Date;
  settings: LeadVoiceSettings;
  /** `meta_ads.campaign_id` del anuncio del lead, o null si no se resolvió. */
  campaignId: string | null;
  /** Una asesora lo tocó (llamada, mensaje o venta firmados) desde que llegó. */
  humanTouched: boolean;
  /** El teléfono pidió no ser llamado en esta tienda (cualquier agente, §11.8 y §33). */
  doNotCall: boolean;
  attempts: readonly LeadVoiceAttempt[];
  /** El brazo ya guardado, o null si el lead nunca fue elegible. */
  arm: ExperimentArm | null;
}

export const LEAD_VOICE_EXCLUSIONS = [
  "agente_apagado",
  "sin_telefono",
  "no_contactar",
  "ya_compro",
  "fuera_de_campana",
  "perdido",
  "poco_interes",
  "callback_pendiente",
  "estado",
  "atendido_por_asesora",
  "handoff_pendiente",
  "reservado",
  "muy_pronto",
  "muy_antiguo",
  "grupo_control",
  "llamada_abierta",
  "intentos_agotados",
  "reintento_pronto",
] as const;
export type LeadVoiceExclusion = (typeof LEAD_VOICE_EXCLUSIONS)[number];

export type LeadVoiceCallKind = "primera" | "volver_a_llamar";

export type LeadVoiceEligibility =
  | { ok: true; kind: LeadVoiceCallKind; arm: ExperimentArm; assignNow: boolean }
  | { ok: false; reason: LeadVoiceExclusion; arm: ExperimentArm | null; assignNow: boolean };

const OPEN_CALL = new Set(["queued", "dialing", "in_progress"]);
const HOUR = 3_600_000;

/**
 * ¿Gasta intento? Todo lo que llegó a marcar, sí: también la llamada que la
 * persona contestó y se cortó porque el puente al agente falló (`failed` +
 * `sin_resultado`); si no contara, el agente la volvería a llamar cada tres
 * horas sin tope. Solo no gasta la fila que Telnyx rechazó antes de marcar,
 * que `placeLeadCall` deja `cancelled`: a esa persona no le sonó nada.
 */
export function attemptCounts(a: LeadVoiceAttempt): boolean {
  return a.status !== "cancelled";
}

function lastAttempt(attempts: readonly LeadVoiceAttempt[]): LeadVoiceAttempt | null {
  let last: LeadVoiceAttempt | null = null;
  for (const a of attempts) if (!last || a.queued_at > last.queued_at) last = a;
  return last;
}

/**
 * ¿Lo llama el agente ahora? PURA. Las condiciones van en orden y la primera
 * que falla es la razón (MOM §33, «Quién entra a la cola del agente»).
 *
 * Las de la 1 a la 12 deciden si el lead es ELEGIBLE; recién ahí se sortea (y
 * se guarda) su brazo, con las mismas reglas para los dos lados. Las de la 13
 * en adelante son del agente: el control nunca se llama, y el tratamiento
 * respeta intentos y descanso.
 *
 * Una llamada «volver a llamar» es la que el propio agente agendó: el lead
 * quedó en `volver_a_llamar` por SU última llamada y la hora ya llegó.
 */
export function leadVoiceEligible(input: LeadVoiceEligibilityInput): LeadVoiceEligibility {
  const { lead, now, settings } = input;
  const no = (reason: LeadVoiceExclusion, arm: ExperimentArm | null = input.arm, assignNow = false): LeadVoiceEligibility => ({
    ok: false,
    reason,
    arm,
    assignNow,
  });
  const t = now.getTime();

  if (!settings.enabled) return no("agente_apagado");
  if (!leadVoicePhone(lead.phone)) return no("sin_telefono");
  if (lead.contact_opt_out_at || input.doNotCall) return no("no_contactar");
  if (lead.category === "won" || lead.has_order === true || lead.order_id) return no("ya_compro");
  if (lead.source !== "meta_ad" || !input.campaignId || !settings.campaignIds.includes(input.campaignId)) {
    return no("fuera_de_campana");
  }
  if (lead.category === "lost") return no("perdido");
  if ((lead.inbound_count ?? 0) < LEAD_VOICE_MIN_INBOUND) return no("poco_interes");

  const last = lastAttempt(input.attempts);
  // El «volver a llamar» lo decide la última llamada que DE VERDAD salió: si
  // Telnyx rechazó la del callback (`cancelled`), la persona sigue esperando
  // esa llamada y el agente la reintenta.
  const lastReal = lastAttempt(input.attempts.filter(attemptCounts));
  const agendadoPorAgente = lead.status === "volver_a_llamar" && lastReal?.outcome === "volver_a_llamar";
  const followupMs = lead.next_followup_at ? Date.parse(lead.next_followup_at) : NaN;
  if (agendadoPorAgente && Number.isFinite(followupMs) && followupMs > t) return no("callback_pendiente");
  const kind: LeadVoiceCallKind | null =
    lead.status === "nuevo" ? "primera" : agendadoPorAgente && Number.isFinite(followupMs) ? "volver_a_llamar" : null;
  if (!kind) return no("estado");

  if (input.humanTouched) return no("atendido_por_asesora");
  // Volvió a escribir después de la llamada del agente y el bot lo pasó a
  // «Atender ahora»: le contesta una asesora. Si el agente llamara, su
  // resultado lo sacaría de «Atender ahora» con el mensaje sin responder.
  const handoffMs = lead.handoff_at ? Date.parse(lead.handoff_at) : NaN;
  if (kind === "volver_a_llamar" && lastReal && Number.isFinite(handoffMs) && handoffMs > Date.parse(lastReal.queued_at)) {
    return no("handoff_pendiente");
  }
  if (isClaimActive(lead.claimed_at, now)) return no("reservado");

  if (kind === "primera") {
    const lastInbound = Date.parse(lead.last_inbound_at ?? lead.first_seen_at ?? "");
    if (!Number.isFinite(lastInbound)) return no("muy_antiguo");
    // Las asesoras van primero: el agente espera a que pase su ventana.
    if (t - lastInbound < settings.waitMinutes * 60_000) return no("muy_pronto");
    if (t - lastInbound > settings.maxAgeHours * HOUR) return no("muy_antiguo");
  } else if (t - followupMs > settings.maxAgeHours * HOUR) {
    return no("muy_antiguo");
  }

  // Elegible: el brazo se sortea ahora (o se lee el guardado).
  const arm = input.arm ?? leadVoiceArm(lead.id, settings.holdoutPct);
  const assignNow = input.arm === null;
  if (arm === "control") return no("grupo_control", arm, assignNow);

  if (input.attempts.some((a) => OPEN_CALL.has(a.status))) return no("llamada_abierta", arm, assignNow);
  if (input.attempts.filter(attemptCounts).length >= settings.maxAttempts) return no("intentos_agotados", arm, assignNow);
  if (kind === "primera" && last && t - Date.parse(last.queued_at) < LEAD_VOICE_RETRY_GAP_HOURS * HOUR) {
    return no("reintento_pronto", arm, assignNow);
  }
  return { ok: true, kind, arm, assignNow };
}

export interface LeadVoiceCandidate {
  lead: LeadVoiceLead;
  kind: LeadVoiceCallKind;
}

/**
 * El orden de la cola: primero los «volver a llamar» vencidos (la persona pidió
 * esa hora), del más antiguo al más nuevo; después las primeras llamadas, del
 * que escribió más recientemente al más antiguo (el interés se enfría rápido).
 */
export function sortLeadVoiceQueue<T extends LeadVoiceCandidate>(cands: readonly T[]): T[] {
  return [...cands].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "volver_a_llamar" ? -1 : 1;
    if (a.kind === "volver_a_llamar") {
      return String(a.lead.next_followup_at ?? "").localeCompare(String(b.lead.next_followup_at ?? ""));
    }
    const ai = a.lead.last_inbound_at ?? a.lead.first_seen_at ?? "";
    const bi = b.lead.last_inbound_at ?? b.lead.first_seen_at ?? "";
    return bi.localeCompare(ai);
  });
}

// ── Lo que el agente escucha al conectar ────────────────────────────────────

export interface ChatMessage {
  dir: "inbound" | "outbound";
  text: string;
  mediaKind?: string | null;
}

const MEDIA_LABEL: Record<string, string> = {
  image: "[imagen]",
  audio: "[audio]",
  video: "[video]",
  document: "[documento]",
  sticker: "[sticker]",
};

/**
 * La conversación de WhatsApp en texto corto para el agente: «Cliente: …» y
 * «Tienda: …», los mensajes más recientes que quepan en `maxChars`. Sin
 * enlaces ni archivos (el agente no los puede abrir y cuestan tokens).
 */
export function chatParaAgente(
  msgs: readonly ChatMessage[],
  opts: { maxMsgs?: number; maxChars?: number } = {},
): string {
  const maxMsgs = opts.maxMsgs ?? 14;
  const maxChars = opts.maxChars ?? 900;
  const lines: string[] = [];
  for (const m of msgs) {
    let text = String(m.text ?? "")
      .replace(/https?:\/\/\S+/gi, "[enlace]")
      // El guion encierra el chat entre «<<<» y «>>>»: la persona no puede cerrarlo.
      .replace(/<<<|>>>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text && m.mediaKind) text = MEDIA_LABEL[m.mediaKind] ?? "[archivo]";
    if (!text) continue;
    if (text.length > 240) text = `${text.slice(0, 237)}…`;
    lines.push(`${m.dir === "inbound" ? "Cliente" : "Tienda"}: ${text}`);
  }
  const out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < maxMsgs; i--) {
    const line = lines[i] as string;
    if (size + line.length + 1 > maxChars) break;
    out.unshift(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

/** «Buenos días» hasta las 12, «buenas tardes» hasta las 19, después «buenas noches» (Lima). */
export function saludoLima(now: Date): string {
  const h = new Date(now.getTime() - 5 * HOUR).getUTCHours();
  if (h < 12) return "buenos días";
  if (h < 19) return "buenas tardes";
  return "buenas noches";
}

/**
 * Palabras con que la gente encabeza su perfil y que NO son su nombre. Antes
 * solo se filtraban los símbolos, así que «Mamá de Luis» daba «Mamá» y el
 * agente abría con «¿Hablo con Mamá?» (y «Sra. Carmen», con «¿Hablo con Sra?»).
 * Se comparan sin tildes y en minúscula.
 */
const NO_ES_NOMBRE = new Set([
  "mama", "mami", "papa", "papi", "tia", "tio", "abuela", "abuelo", "hija", "hijo",
  "senora", "senor", "senorita", "sra", "sr", "srta", "don", "dona",
  "dr", "dra", "doctor", "doctora", "lic", "ing", "prof", "profe",
  "amor", "bebe", "mi", "la", "el", "los", "las", "de", "del",
]);

/**
 * El primer nombre si parece un nombre. El de WhatsApp es el del perfil:
 * «🌸», «Mamá de Luis», «.» o un apodo. Solo letras, dos o más, y que no sea
 * un parentesco ni un trato (`NO_ES_NOMBRE`); si no, nada —el agente pregunta
 * con quién habla—.
 */
export function nombreHablado(name: string | null | undefined): string {
  const first = primerNombre(String(name ?? "").replace(/[^\p{L}\s'-]/gu, " "));
  if (!/^\p{L}[\p{L}'-]+$/u.test(first)) return "";
  const llano = first.toLocaleLowerCase("es").normalize("NFD").replace(/\p{M}/gu, "");
  return NO_ES_NOMBRE.has(llano) ? "" : first;
}

/** El primer mensaje del lead, sin enlaces, para que el agente sepa qué preguntó. */
export function consultaHablada(text: string | null | undefined): string {
  const t = String(text ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/<<<|>>>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 200 ? `${t.slice(0, 197)}…` : t;
}

/**
 * El horario en que el agente puede volver a llamar, para que no prometa una
 * hora en que no llama: «de 9:00 a 20:00; los domingos desde las 11:00».
 */
export function horarioHablado(start: number, end: number): string {
  return `de ${start}:00 a ${end}:00; los domingos desde las ${Math.max(start, VOICE_SUNDAY_START_HOUR)}:00`;
}

/** Las variables que el agente de leads recibe al conectar. Van TODAS, como texto. */
export const LEAD_VOICE_VARS = [
  "voice_call_id",
  "encontrada",
  "modo",
  "tienda",
  "nombre",
  "producto",
  "oferta",
  "consulta",
  "chat",
  "distrito_chat",
  "hoy",
  "hoy_texto",
  "saludo",
  "intento",
  "ultimo_intento",
  "horario",
  "es_volver_a_llamar",
] as const;
export type LeadVoiceVar = (typeof LEAD_VOICE_VARS)[number];

/** La ficha que se guarda al marcar (`voice_calls.lead_context.ficha`). */
export type LeadFicha = Record<Exclude<LeadVoiceVar, "voice_call_id" | "encontrada">, string>;

export interface LeadFichaInput {
  lead: Pick<LeadVoiceLead, "name"> & {
    first_inbound_text?: string | null;
    district?: string | null;
    ad_headline?: string | null;
  };
  storeName: string | null;
  settings: Pick<LeadVoiceSettings, "product" | "offer" | "hourStart" | "hourEnd" | "maxAttempts">;
  chat: string;
  now: Date;
  /** Número de este intento, desde 1. */
  attempt: number;
  kind: LeadVoiceCallKind;
  mode: "real" | "test";
}

export function buildLeadFicha(input: LeadFichaInput): LeadFicha {
  const producto =
    input.settings.product || consultaHablada(input.lead.ad_headline) || "el producto que vio en el anuncio";
  return {
    modo: input.mode,
    tienda: tiendaHablada(input.storeName),
    nombre: nombreHablado(input.lead.name),
    producto,
    oferta: input.settings.offer.slice(0, 800),
    consulta: consultaHablada(input.lead.first_inbound_text),
    chat: input.chat,
    distrito_chat: String(input.lead.district ?? "").trim().slice(0, 80),
    // `hoy` en AAAA-MM-DD: la tool pide la fecha de «volver a llamar» así, y
    // el agente la calcula desde aquí; `hoy_texto` es para decirla.
    hoy: voiceDates(input.now).hoy,
    hoy_texto: voiceDates(input.now).hoy_texto,
    saludo: saludoLima(input.now),
    intento: String(Math.max(1, input.attempt)),
    // En el último intento el agente no promete otra llamada suya: si piden
    // otra hora, queda para una asesora (el guion, docs/voz-leads-agente.md).
    ultimo_intento: input.attempt >= input.settings.maxAttempts ? "si" : "no",
    horario: horarioHablado(input.settings.hourStart, input.settings.hourEnd),
    es_volver_a_llamar: input.kind === "volver_a_llamar" ? "si" : "no",
  };
}

/**
 * ¿La conversación entra por el tramo que abrió Kapta? Se comparan los últimos
 * nueve dígitos del caller ID que manda ElevenLabs con el número de salida del
 * agente de leads. Sin caller ID en el aviso no se puede saber y se acepta
 * (lo que hacía antes); con uno distinto, no.
 */
export function callerIdDeKapta(callerId: unknown, fromNumber: string): boolean {
  const caller = String(callerId ?? "").replace(/\D/g, "");
  if (!caller) return true;
  const from = fromNumber.replace(/\D/g, "");
  if (from.length < 9) return true;
  return caller.slice(-9) === from.slice(-9);
}

export interface LeadVoiceInitiation {
  type: "conversation_initiation_client_data";
  dynamic_variables: Record<LeadVoiceVar, string>;
  conversation_config_override: { agent: { first_message: string } };
}

/**
 * Lo que Kapta devuelve al webhook de inicio del agente de leads: TODAS las
 * variables (ElevenLabs no arranca si falta una que el prompt usa) y un primer
 * mensaje. Sin llamada, `encontrada = "no"` y el agente se despide.
 */
export function leadVoiceInitiation(callId: string | null, ficha: LeadFicha | null): LeadVoiceInitiation {
  const vars = Object.fromEntries(LEAD_VOICE_VARS.map((k) => [k, ""])) as Record<LeadVoiceVar, string>;
  vars.encontrada = "no";
  if (callId && ficha) {
    for (const k of LEAD_VOICE_VARS) {
      if (k === "voice_call_id" || k === "encontrada") continue;
      vars[k] = String(ficha[k] ?? "");
    }
    vars.voice_call_id = callId;
    vars.encontrada = "si";
  }
  const saludo = vars.saludo ? `Hola, ${vars.saludo}.` : "Hola, buenas.";
  const first_message = vars.encontrada !== "si" ? "Hola, buenas." : vars.nombre ? `${saludo} ¿Hablo con ${vars.nombre}?` : `${saludo} ¿Con quién tengo el gusto?`;
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: vars,
    conversation_config_override: { agent: { first_message } },
  };
}

// ── Cobertura que el agente explica ─────────────────────────────────────────

export type CoverageKind = "lima" | "provincia_cod" | "agencia" | "por_revisar";

export interface CoberturaParaAgente {
  cobertura: CoverageKind;
  pago: "contraentrega" | "adelanto" | "por_confirmar";
  adelanto: string;
  mensaje: string;
}

/**
 * Qué le dice el agente a la persona según la cobertura canónica
 * (`order_coverage_for`, la misma del Master). El adelanto sale de
 * `lib/adelanto-minimo` (§12): el agente nunca pide ni recibe el pago, solo
 * avisa que una asesora le escribe para eso.
 */
export function coberturaParaAgente(kind: string | null | undefined): CoberturaParaAgente {
  switch (kind) {
    case "lima":
      return {
        cobertura: "lima",
        pago: "contraentrega",
        adelanto: "",
        mensaje: "Llega a su domicilio en Lima y paga al recibir, sin adelanto.",
      };
    case "provincia_cod":
      return {
        cobertura: "provincia_cod",
        pago: "contraentrega",
        adelanto: "",
        mensaje: "Llega a su dirección y paga al recibir, sin adelanto.",
      };
    case "agencia":
      return {
        cobertura: "agencia",
        pago: "adelanto",
        adelanto: ADELANTO_MINIMO_LABEL,
        mensaje:
          `Se envía por agencia Shalom. Se separa con un adelanto de ${ADELANTO_MINIMO_LABEL} y el saldo se paga ` +
          "antes de recoger. Una asesora le escribe por WhatsApp para el adelanto.",
      };
    default:
      return {
        cobertura: "por_revisar",
        pago: "por_confirmar",
        adelanto: "",
        mensaje: "Hay que confirmar la cobertura: pregunte la provincia y el departamento; una asesora lo confirma.",
      };
  }
}

// ── registrar_resultado_lead: qué escribe cada resultado ────────────────────

export interface LeadResultInput {
  resultado?: string | null;
  motivo?: string | null;
  distrito?: string | null;
  provincia?: string | null;
  departamento?: string | null;
  direccion?: string | null;
  referencia?: string | null;
  nombre?: string | null;
  promo?: string | null;
  cantidad?: string | number | null;
  fecha?: string | null;
  hora?: string | null;
  resumen?: string | null;
}

export interface LeadCaptura {
  nombre: string;
  distrito: string;
  provincia: string;
  departamento: string;
  direccion: string;
  referencia: string;
  promo: string;
  cantidad: number | null;
}

export type LeadResultAction =
  | { kind: "invalid"; error: string }
  | {
      kind: "apply";
      outcome: LeadVoiceResult;
      /** Estado del lead que se escribe; null = el lead no se toca (no contestó). */
      status: string | null;
      needsAttention: boolean;
      handoffContext: string | null;
      /** `default` = la hora automática de §6 (`defaultFollowupAt`), si no hay una futura. */
      followup: { at: string } | "default" | "clear" | "keep";
      optOut: boolean;
      motivo: LeadVoiceMotivo | null;
      captura: LeadCaptura | null;
      resumen: string;
      note: string;
    };

const clean = (s: unknown, max = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * La hora a la que pidió que lo llamen, en Lima: `fecha` YYYY-MM-DD y `hora`
 * HH:MM (por defecto las 10:00). Solo si es futura; si no, null (se usa la
 * hora automática).
 */
export function followupFrom(fecha: string | null | undefined, hora: string | null | undefined, now: Date): string | null {
  const f = clean(fecha, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(clean(hora, 5));
  const hh = m ? Number(m[1]) : 10;
  const mm = m && m[2] ? Number(m[2]) : 0;
  if (hh > 23 || mm > 59) return null;
  const at = new Date(`${f}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-05:00`);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) return null;
  // Una fecha que no existe no es una fecha: `Date` pasaba «2026-11-31» al 1 de
  // diciembre sin avisar y el agente habría vuelto a llamar un día que nadie
  // pidió. Si el día de Lima no es el que vino, se usa la hora automática.
  if (new Date(at.getTime() - 5 * HOUR).toISOString().slice(0, 10) !== f) return null;
  return at.toISOString();
}

function capturaFrom(input: LeadResultInput): LeadCaptura {
  // El PRIMER número que dijo, no todos sus dígitos pegados: así «2 o 3» eran
  // 23 unidades, «5x3» (la promo dicha como cantidad) 53 y un 2.5, 25.
  const cantidad = Number(/\d+/.exec(String(input.cantidad ?? ""))?.[0] ?? Number.NaN);
  return {
    nombre: clean(input.nombre, 80),
    distrito: clean(input.distrito, 80),
    provincia: clean(input.provincia, 80),
    departamento: clean(input.departamento, 80),
    direccion: clean(input.direccion, 200),
    referencia: clean(input.referencia, 200),
    promo: clean(input.promo, 120),
    cantidad: Number.isInteger(cantidad) && cantidad > 0 && cantidad < 100 ? cantidad : null,
  };
}

/** El resumen que la asesora lee en «Atender ahora» (`leads.handoff_context`). */
export function handoffContextFor(c: LeadCaptura, resumen: string): string {
  const lugar = [c.distrito, c.provincia, c.departamento].filter(Boolean).join(", ");
  const parts = [
    "Agente de voz: quiere comprar.",
    // «unidad(es)» y no «u.»: la abreviatura más el punto de la frase dejaba «3 u..».
    c.promo || c.cantidad
      ? `Pide: ${[c.promo, c.cantidad ? `${c.cantidad} ${c.cantidad === 1 ? "unidad" : "unidades"}` : ""].filter(Boolean).join(", ")}.`
      : "",
    c.nombre ? `Nombre: ${c.nombre}.` : "",
    lugar ? `Lugar: ${lugar}.` : "",
    c.direccion ? `Dirección: ${c.direccion}.` : "",
    c.referencia ? `Referencia: ${c.referencia}.` : "",
    resumen,
  ];
  return parts.filter(Boolean).join(" ").slice(0, 1000);
}

/**
 * ¿El resumen dice que la persona pidió no ser llamada? Más estricto que
 * `pideNoLlamar` de §11.8 porque aquí el «sí» es caro: apaga también los
 * WhatsApp automáticos del lead. Pide la palabra entera («no la llamaron» no
 * es un pedido) y descarta lo que es una hora («no llamar antes de las 10»).
 */
export function pideNoContactar(text: string): boolean {
  return /\bno\s+(quiere\s+que\s+)?(me|la|lo|le|nos)?\s*(vuelvan\s+a\s+|sigan\s+)?llam(en|ar|ando)\b(?!\s+(antes|despu[eé]s|hasta|hoy|mañana|ahora|ahorita|todav[ií]a|temprano|tarde|en\s+la|en\s+este|en\s+(el\s+|su\s+)?horario|en\s+su\s+trabajo|por\s+la|por\s+ahora|a\s+las|a\s+esta|al\s+trabajo|esta\s+semana|de\s+\d))/i.test(
    text,
  );
}

/**
 * Traduce lo que manda el agente a lo que se escribe (MOM §33, tabla de
 * resultados). PURA.
 *
 * | resultado        | estado del lead                     | además                               |
 * | atender_ahora    | `casi_cierra` + «Atender ahora»      | handoff `agente_voz` con los datos   |
 * | volver_a_llamar  | `volver_a_llamar` con la hora pedida | el agente vuelve a llamar a esa hora |
 * | no_compra        | perdido según el motivo              | el motivo queda en la nota           |
 * | no_llamar        | `cancelado_cliente`                  | no contactar: llamadas y WhatsApp    |
 * | no_contesta      | no cambia                            | solo la nota                         |
 *
 * Un resumen que dice «no me llamen» marca no contactar aunque el resultado
 * sea otro, como hace el agente de pedidos (§11.8), con `pideNoContactar`.
 */
export function translateLeadResult(input: LeadResultInput, now: Date = new Date()): LeadResultAction {
  const r = clean(input.resultado, 40).toLowerCase() as LeadVoiceResult;
  if (!LEAD_VOICE_RESULTS.includes(r)) {
    return { kind: "invalid", error: `resultado debe ser uno de: ${LEAD_VOICE_RESULTS.join(", ")}` };
  }
  const resumen = clean(input.resumen, 1000);
  const motivoRaw = clean(input.motivo, 40).toLowerCase() as LeadVoiceMotivo;
  const motivo: LeadVoiceMotivo | null = r === "no_compra" ? (LEAD_VOICE_MOTIVOS.includes(motivoRaw) ? motivoRaw : "otro") : null;
  // Del resumen solo se infiere con un «no»: con «volver a llamar» o «quiere
  // comprar», un «que no la llamen ahora» es una hora, no un pedido.
  const optOut = r === "no_llamar" || (r === "no_compra" && pideNoContactar(`${resumen} ${clean(input.motivo)}`));
  const label = motivo
    ? `${LEAD_VOICE_OUTCOME_LABEL[r]} (${LEAD_VOICE_MOTIVO_LABEL[motivo]})`
    : LEAD_VOICE_OUTCOME_LABEL[r];
  const note = [LEAD_VOICE_NOTE_SIGNER, label, resumen].filter(Boolean).join(" · ").slice(0, 1200);
  const base = { kind: "apply" as const, outcome: r, optOut, motivo, resumen, note };

  switch (r) {
    case "atender_ahora": {
      const captura = capturaFrom(input);
      return {
        ...base,
        status: "casi_cierra",
        needsAttention: true,
        handoffContext: handoffContextFor(captura, resumen),
        followup: "default",
        captura,
      };
    }
    case "volver_a_llamar": {
      const at = followupFrom(input.fecha, input.hora, now);
      return {
        ...base,
        status: "volver_a_llamar",
        needsAttention: false,
        handoffContext: null,
        followup: at ? { at } : "default",
        captura: null,
      };
    }
    case "no_compra":
      return {
        ...base,
        status: LEAD_VOICE_MOTIVO_STATUS[motivo ?? "otro"],
        needsAttention: false,
        handoffContext: null,
        followup: "clear",
        captura: null,
      };
    case "no_llamar":
      return { ...base, status: "cancelado_cliente", needsAttention: false, handoffContext: null, followup: "clear", captura: null };
    case "no_contesta":
      return { ...base, status: null, needsAttention: false, handoffContext: null, followup: "keep", captura: null };
  }
}

/**
 * El `update` de `leads` para un resultado aplicado, o null si el lead no se
 * toca. PURA. `defaultFollowup` es `defaultFollowupAt(now, tz)` (§6); se usa
 * solo si el lead no tiene ya un seguimiento futuro.
 */
export function leadPatchFor(
  action: Extract<LeadResultAction, { kind: "apply" }>,
  ctx: { nowIso: string; defaultFollowup: string; currentFollowup: string | null },
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (action.optOut) patch.contact_opt_out_at = ctx.nowIso;
  if (!action.status) return action.optOut ? patch : null;
  patch.status = action.status;
  patch.category = categoryOf(action.status);
  patch.needs_attention = action.needsAttention;
  patch.last_interaction_at = ctx.nowIso;
  if (action.handoffContext) {
    patch.handoff_reason = LEAD_VOICE_HANDOFF_REASON;
    patch.handoff_context = action.handoffContext;
    patch.handoff_at = ctx.nowIso;
  }
  const futuro = ctx.currentFollowup && ctx.currentFollowup > ctx.nowIso ? ctx.currentFollowup : null;
  if (action.followup === "clear") patch.next_followup_at = null;
  else if (action.followup === "default") patch.next_followup_at = futuro ?? ctx.defaultFollowup;
  else if (action.followup !== "keep") patch.next_followup_at = action.followup.at;
  return patch;
}

/** La nota del historial cuando nadie contestó: el lead no cambia, pero la asesora ve el intento. */
export function noAnswerNote(resumen: string, attempt: number, maxAttempts: number): string {
  return [LEAD_VOICE_NOTE_SIGNER, `No contestó (intento ${attempt} de ${maxAttempts})`, clean(resumen, 300)]
    .filter(Boolean)
    .join(" · ");
}

/** Para el historial del lead: «🤖 Agente de voz · Casi cierra (dio datos)». */
export function leadVoiceTimelineTitle(newStatus: string | null): string {
  return newStatus ? `🤖 Agente de voz · ${labelOf(newStatus)}` : "🤖 Agente de voz";
}

// ── Lo que se guarda al marcar ──────────────────────────────────────────────

/**
 * `voice_calls.lead_context`: lo que el agente recibió y en qué estado estaba
 * el lead al marcar. El registro lo usa para no pisar a una asesora: si el
 * estado ya no es `estado_al_marcar`, alguien lo movió durante la llamada.
 */
export interface LeadContext {
  ficha: LeadFicha;
  estado_al_marcar: string;
  tipo: LeadVoiceCallKind;
  /** Número de este intento, desde 1, y el tope de la tienda al marcar. */
  intento: number;
  max_intentos: number;
  campaign_id: string | null;
  /** Se pudo leer la conversación de WhatsApp para el agente. */
  chat_ok: boolean;
}
