// Vision check for Yape payment vouchers (Claude Messages API).
//
// The "Yape/Shalom por verificar" alert must fire on a REAL voucher, not on any
// screenshot a customer sends. Text/caption signals (lib/kapso.ts) catch the
// explicit cases; a silent voucher IMAGE needs its CONTENT read. This module
// asks Claude to look at one image and report whether it is a genuine Yape
// payment confirmation, checking the indicators the operator specified:
//   - el logo / la interfaz oficial de Yape
//   - el monto (S/ …)
//   - la fecha y hora
//   - el destinatario (se espera "Grupo GF SAC")
//   - el estado ("Pago realizado" / "Transferencia exitosa" / "Yapeaste")
//   - el número de operación
//
// Raw fetch (no SDK dependency — mirrors lib/kapso.ts / lib/telegram.ts /
// lib/meta-marketing.ts) and NEVER throws: any failure returns a non-voucher
// verdict so the alert stays conservative. Timeout-bounded via AbortController.

import { env } from "@/lib/env";

const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 20_000;
const SUPPORTED_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Which voucher indicators the model reported seeing (audit / tuning). A type
 *  alias (not an interface) so it carries an implicit index signature and stays
 *  assignable to `Record<string, unknown>` for the jsonb column / audit path. */
export type YapeVoucherIndicators = {
  logo?: boolean; // Yape logo / official payment interface
  monto?: boolean; // amount (S/ …)
  fecha_hora?: boolean; // date & time
  destinatario?: boolean; // recipient — expected "Grupo GF SAC"
  estado?: boolean; // "Pago realizado" / "Transferencia exitosa" / "Yapeaste"
  operacion?: boolean; // operation / transaction number
};

export interface YapeVisionResult {
  isVoucher: boolean;
  indicators: YapeVoucherIndicators;
  model: string;
  // Whether we actually got a verdict from the model. FALSE on any failure (no
  // key, non-2xx, timeout, network, unparseable) — the caller MUST NOT record a
  // `!ok` result as a decided "not a voucher": that would cache a transient
  // outage as a permanent negative and silently drop a real voucher.
  ok: boolean;
}

export interface AnalyzeYapeOpts {
  apiKey: string;
  model: string;
  apiBase?: string; // defaults to https://api.anthropic.com
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT =
  "Eres un verificador de comprobantes de pago Yape (billetera móvil peruana). " +
  "Recibes UNA imagen y decides si es un comprobante REAL de un pago Yape ya " +
  "realizado. Un comprobante auténtico muestra la interfaz/logo oficial de Yape " +
  "(fondo morado característico, ✓ de confirmación) con un pago concretado. " +
  "NO son comprobantes: capturas de una conversación de chat, fotos de un " +
  "producto, la pantalla para INGRESAR un monto antes de pagar, catálogos, o " +
  "cualquier imagen sin la interfaz de pago de Yape. Ante la duda, NO es " +
  "comprobante. Responde ÚNICAMENTE con un objeto JSON, sin texto adicional.";

// The recipient the operator expects on a valid advance ("adelanto"). Passed to
// the model as a strong positive signal, not a hard requirement (a different
// store may cobrar to another Yape account).
const EXPECTED_RECIPIENT = "Grupo GF SAC";

function buildUserPrompt(): string {
  return (
    "Analiza la imagen y devuelve JSON con esta forma exacta:\n" +
    "{\n" +
    '  "is_voucher": boolean,   // true SOLO si es un comprobante Yape de pago realizado\n' +
    '  "indicators": {\n' +
    '    "logo": boolean,          // se ve el logo/interfaz oficial de Yape\n' +
    '    "monto": boolean,         // aparece un monto (S/ …)\n' +
    '    "fecha_hora": boolean,    // aparece fecha y/u hora del pago\n' +
    `    "destinatario": boolean,  // aparece el destinatario (se espera "${EXPECTED_RECIPIENT}")\n` +
    '    "estado": boolean,        // dice "Pago realizado", "Transferencia exitosa" o "Yapeaste"\n' +
    '    "operacion": boolean      // aparece el número de operación/transacción\n' +
    "  }\n" +
    "}\n" +
    "Marca cada indicador según lo que REALMENTE veas en la imagen. Una simple " +
    "captura de chat o una foto de producto debe dar is_voucher=false y logo=false."
  );
}

/** Coerce an inbound content-type to a media_type the API accepts (default jpeg). */
export function normalizeMediaType(contentType: string | null | undefined): string {
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (SUPPORTED_MEDIA.has(ct)) return ct;
  if (ct === "image/jpg") return "image/jpeg";
  return "image/jpeg";
}

/** Pull the first text block out of a Messages API response (defensive). */
function extractText(json: unknown): string {
  const content = (json as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** Parse the model's JSON verdict, tolerating markdown fences / surrounding prose. */
function parseVerdict(text: string): { is_voucher: boolean; indicators: YapeVoucherIndicators } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const rawInd = (o.indicators && typeof o.indicators === "object" ? o.indicators : {}) as Record<string, unknown>;
  const pick = (k: string): boolean | undefined =>
    typeof rawInd[k] === "boolean" ? (rawInd[k] as boolean) : undefined;
  return {
    is_voucher: o.is_voucher === true,
    indicators: {
      logo: pick("logo"),
      monto: pick("monto"),
      fecha_hora: pick("fecha_hora"),
      destinatario: pick("destinatario"),
      estado: pick("estado"),
      operacion: pick("operacion"),
    },
  };
}

/**
 * Decide, from the model's verdict, whether the image is a Yape voucher.
 * Precision over recall (the whole point is to stop false positives on random
 * screenshots), so we require BOTH:
 *   - the Yape interface/logo (`logo === true`) — a chat/product screenshot
 *     never shows the payment UI; and
 *   - at least one concrete payment fact (monto / estado / nº de operación) —
 *     guards against a terse or hallucinated `{"is_voucher": true}` with no
 *     corroborating indicator.
 * A voucher cropped above the logo is intentionally missed (rare; the customer
 * can resend). Pure + exported so the threshold is testable and tunable here.
 */
export function isVoucherVerdict(v: { is_voucher: boolean; indicators: YapeVoucherIndicators }): boolean {
  if (!v.is_voucher) return false;
  if (v.indicators.logo !== true) return false; // Yape interface required
  return v.indicators.monto === true || v.indicators.estado === true || v.indicators.operacion === true;
}

/**
 * Analyze one image and report whether it is a genuine Yape payment voucher.
 * Never throws — on any error (bad key, timeout, unparseable response) it
 * returns a conservative non-voucher verdict so the alert never fires on noise.
 */
export async function analyzeYapeVoucher(
  imageBase64: string,
  contentType: string | null | undefined,
  opts: AnalyzeYapeOpts,
): Promise<YapeVisionResult> {
  const model = opts.model;
  // `ok:false` — a failure/unavailable result the caller must NOT cache as a
  // decided negative (see YapeVisionResult.ok).
  const safe: YapeVisionResult = { isVoucher: false, indicators: {}, model, ok: false };
  if (!opts.apiKey || !imageBase64) return safe;

  const doFetch = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? "https://api.anthropic.com").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: normalizeMediaType(contentType),
                  data: imageBase64,
                },
              },
              { type: "text", text: buildUserPrompt() },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return safe;
    const json = await res.json();
    const verdict = parseVerdict(extractText(json));
    if (!verdict) return safe;
    // A real, parsed verdict → ok:true (it may still be "not a voucher").
    return { isVoucher: isVoucherVerdict(verdict), indicators: verdict.indicators, model, ok: true };
  } catch {
    return safe;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience wrapper reading key + model from env. Returns a non-voucher
 * verdict when no ANTHROPIC_API_KEY is configured (vision disabled). Never throws.
 */
export async function analyzeYapeVoucherFromEnv(
  imageBase64: string,
  contentType: string | null | undefined,
): Promise<YapeVisionResult> {
  const apiKey = env.anthropicApiKey();
  const model = env.yapeVisionModel();
  if (!apiKey) return { isVoucher: false, indicators: {}, model, ok: false };
  return analyzeYapeVoucher(imageBase64, contentType, { apiKey, model, apiBase: env.anthropicApiBase() });
}

// ---------------------------------------------------------------------------
// Extracción de los datos del comprobante
// ---------------------------------------------------------------------------
//
// `analyzeYapeVoucher` responde "¿es un comprobante?". Esto responde "¿qué dice?".
//
// Existe por un motivo muy concreto: el nº de operación es el único
// identificador que permite garantizar que un mismo Yape no se use en dos
// pedidos — y es lo que sobrevive a que el cliente mande la captura RECORTADA.
// Pedirle al operador que lo teclee a mano en cada carga es lento y se equivoca;
// leerlo de la imagen y dejar que solo lo confirme es mucho más fiable.
//
// Igual que la función anterior: raw fetch, nunca lanza, y ante la duda devuelve
// el campo vacío en vez de inventarlo — un nº de operación mal leído sería peor
// que ninguno, porque bloquearía un pago legítimo o dejaría pasar un duplicado.

export interface YapeVoucherFields {
  /** Nº de operación tal como aparece, solo dígitos y letras. */
  operationNumber: string | null;
  amount: number | null;
  /** Fecha y hora del movimiento en ISO, cuando ambas se pueden leer. */
  paidAt: string | null;
  payerName: string | null;
  /** A quién se pagó — sirve para detectar un Yape a otra cuenta. */
  recipientName: string | null;
  ok: boolean;
  model: string;
}

const EXTRACT_SYSTEM_PROMPT =
  "Eres un lector de comprobantes de pago Yape (billetera móvil peruana). " +
  "Recibes UNA imagen de un comprobante y transcribes SOLO lo que se ve. " +
  "Nunca inventes ni completes un dato parcial: si un campo está cortado, " +
  "borroso o no aparece, devuélvelo como null. Un número de operación mal " +
  "transcrito es peor que ninguno. Responde ÚNICAMENTE con un objeto JSON.";

function buildExtractPrompt(): string {
  return (
    "Transcribe el comprobante y devuelve JSON con esta forma exacta:\n" +
    "{\n" +
    '  "operation_number": string|null,  // nº de operación / código de seguridad\n' +
    '  "amount": number|null,            // monto en soles, solo el número\n' +
    '  "date": string|null,              // fecha, tal como se ve (p. ej. "10 jul 2026")\n' +
    '  "time": string|null,              // hora, tal como se ve (p. ej. "02:35 pm")\n' +
    '  "payer_name": string|null,        // quien paga\n' +
    '  "recipient_name": string|null     // quien recibe\n' +
    "}\n" +
    "Si la imagen está recortada y algún dato no se ve completo, ese campo es null."
  );
}

const MONTHS: Record<string, string> = {
  ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
  jul: "07", ago: "08", set: "09", sep: "09", oct: "10", nov: "11", dic: "12",
};

/**
 * Combina la fecha y la hora que se leyeron por separado en un instante ISO.
 * Devuelve null en cuanto algo no encaja: la fecha y hora del movimiento son
 * parte de la detección de duplicados, así que una aproximada es peor que nada.
 */
export function parseVoucherInstant(date: string | null, time: string | null): string | null {
  if (!date) return null;
  const clean = date
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  let y: number | null = null;
  let m: string | null = null;
  let d: string | null = null;

  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(clean);
  const textual = /^(\d{1,2})\s+([a-z]{3,})\.?\s+(\d{4})/.exec(clean);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean);
  if (iso) {
    y = Number(iso[1]);
    m = iso[2]!;
    d = iso[3]!;
  } else if (numeric) {
    d = numeric[1]!.padStart(2, "0");
    m = numeric[2]!.padStart(2, "0");
    y = numeric[3]!.length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
  } else if (textual) {
    d = textual[1]!.padStart(2, "0");
    m = MONTHS[textual[2]!.slice(0, 3)] ?? null;
    y = Number(textual[3]);
  }
  if (!y || !m || !d) return null;

  let hh = "00";
  let mm = "00";
  if (time) {
    const t = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i.exec(time.trim());
    if (t) {
      let hour = Number(t[1]);
      const suffix = (t[3] ?? "").toLowerCase().replace(/\./g, "");
      if (suffix === "pm" && hour < 12) hour += 12;
      if (suffix === "am" && hour === 12) hour = 0;
      if (hour > 23) return null;
      hh = String(hour).padStart(2, "0");
      mm = t[2]!;
    }
  }
  // Perú es UTC-5 sin horario de verano; la hora del comprobante es local.
  const stamp = Date.parse(`${y}-${m}-${d}T${hh}:${mm}:00-05:00`);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

function parseFields(text: string): Omit<YapeVoucherFields, "ok" | "model"> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t && t.toLowerCase() !== "null" ? t : null;
  };
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const s = str(v);
    if (!s) return null;
    const n = Number(s.replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const rawOperation = str(o.operation_number);
  return {
    operationNumber: rawOperation ? rawOperation.toUpperCase().replace(/[^A-Z0-9]/g, "") || null : null,
    amount: num(o.amount),
    paidAt: parseVoucherInstant(str(o.date), str(o.time)),
    payerName: str(o.payer_name),
    recipientName: str(o.recipient_name),
  };
}

/**
 * Lee los datos de un comprobante Yape. Nunca lanza: ante cualquier fallo
 * devuelve todos los campos vacíos con `ok: false`, y quien llama debe pedir los
 * datos a mano en vez de dar el pago por bueno.
 */
export async function extractYapeVoucher(
  imageBase64: string,
  contentType: string | null | undefined,
  opts: AnalyzeYapeOpts,
): Promise<YapeVoucherFields> {
  const model = opts.model;
  const empty: YapeVoucherFields = {
    operationNumber: null,
    amount: null,
    paidAt: null,
    payerName: null,
    recipientName: null,
    ok: false,
    model,
  };
  if (!opts.apiKey || !imageBase64) return empty;

  const doFetch = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? "https://api.anthropic.com").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        system: EXTRACT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: normalizeMediaType(contentType),
                  data: imageBase64,
                },
              },
              { type: "text", text: buildExtractPrompt() },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return empty;
    const fields = parseFields(extractText(await res.json()));
    if (!fields) return empty;
    return { ...fields, ok: true, model };
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

/** Envoltorio que lee la clave y el modelo del entorno. Nunca lanza. */
export async function extractYapeVoucherFromEnv(
  imageBase64: string,
  contentType: string | null | undefined,
): Promise<YapeVoucherFields> {
  const apiKey = env.anthropicApiKey();
  const model = env.yapeVisionModel();
  if (!apiKey) {
    return {
      operationNumber: null,
      amount: null,
      paidAt: null,
      payerName: null,
      recipientName: null,
      ok: false,
      model,
    };
  }
  return extractYapeVoucher(imageBase64, contentType, {
    apiKey,
    model,
    apiBase: env.anthropicApiBase(),
  });
}
