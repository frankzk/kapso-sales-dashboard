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
