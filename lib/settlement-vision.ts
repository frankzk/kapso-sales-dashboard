// Lectura de una liquidación fotografiada (cuaderno o formato impreso a mano).
//
// El motorizado manda una foto de su hoja: filas escritas a mano con la guía o
// el nº de pedido, el estado y la plata cobrada. Este módulo se la da a Claude y
// devuelve las filas en el mismo formato que el lector de Excel
// (lib/settlement-sheet.ts), para que la ingesta sea UNA sola y no dos.
//
// Tres reglas, heredadas de lib/vision.ts:
//
//   1. NUNCA LANZA. Ante cualquier fallo (sin clave, timeout, respuesta
//      ilegible) devuelve cero líneas con `ok:false`. Quien llama debe pedir la
//      carga a mano, no dar por buena una hoja vacía.
//
//   2. NO INVENTA. Se le pide explícitamente que deje en null lo que no se lee
//      con claridad — letra ilegible, número tachado, celda en blanco. Un monto
//      inventado en una liquidación es plata inventada; una celda vacía la
//      corrige una persona en dos segundos.
//
//   3. LO QUE DEVUELVE ES UNA PROPUESTA. La ingesta la vincula con los pedidos
//      reales y todo lo dudoso queda en `match_status = 'review'`. La foto nunca
//      escribe directo en el cuadre.

import { env } from "@/lib/env";
import { resolveVisionCreds, type StoreVisionCreds } from "@/lib/vision";
import type { ParsedSettlementLine, ParsedSettlementSheet } from "@/lib/settlement-sheet";

const ANTHROPIC_VERSION = "2023-06-01";
// Una captura de Axel puede traer dos bloques de 25 filas. Cuatro mil tokens
// truncaban el JSON y 60 segundos cortaban justo antes de terminar la lectura.
// Dejamos margen dentro de los 120 s de la función de Vercel.
const REQUEST_TIMEOUT_MS = 105_000;
const MAX_TOKENS = 8_192;
const SUPPORTED_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface SettlementVisionResult extends ParsedSettlementSheet {
  /** false ante cualquier fallo. Quien llama NO debe tratarlo como "hoja vacía". */
  ok: boolean;
  model: string;
  /** Diagnóstico seguro para logs/UI; nunca incluye credenciales ni la imagen. */
  failure?: "missing_credentials" | "api_error" | "timeout" | "invalid_response";
  detail?: string;
}

export interface SettlementVisionOpts {
  apiKey: string;
  model: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT =
  "Eres un asistente que transcribe hojas de liquidación de motorizados de " +
  "reparto en Perú. Recibes UNA foto de una hoja: puede ser un cuaderno escrito " +
  "a mano o una captura de una tabla de Excel con uno o varios bloques. Cada " +
  "fila es una entrega y puede contener tienda, cliente, distrito, efectivo, " +
  "forma de pago y comisión del courier.\n\n" +
  "Tu única tarea es TRANSCRIBIR lo que ves. No corrijas, no completes y no " +
  "deduzcas. Si un dato está tachado, borroso o ilegible, devuélvelo como null: " +
  "una celda vacía la corrige una persona, un dato inventado se convierte en " +
  "plata inventada. No sumes, no calcules totales por fila y no reordenes las " +
  "filas: van en el mismo orden en que aparecen en la hoja.";

function buildPrompt(): string {
  return (
    "Transcribe la hoja y devuelve SOLO un JSON con esta forma exacta:\n" +
    "{\n" +
    '  "rider_name": string|null,   // nombre del motorizado si aparece\n' +
    '  "date": string|null,         // fecha de la hoja en formato YYYY-MM-DD\n' +
    '  "lines": [\n' +
    "    {\n" +
    '      "guide": string|null,    // código de guía o seguimiento, tal cual\n' +
    '      "order": string|null,    // nº de pedido (p. ej. KP124158) si aparece\n' +
    '      "customer": string|null,  // nombre del cliente si aparece\n' +
    '      "district": string|null,  // distrito de entrega si aparece\n' +
    '      "store": string|null,     // tienda de la fila; en Axel está en CLIENTE\n' +
    '      "status": string|null,   // lo escrito: "entregado", "no entregó", "rechazado"…\n' +
    '      "payment_method": string|null, // F. PAGO tal cual: EFECTIVO, CAIDA, REPRO…\n' +
    '      "amount": number|null,   // EFECTIVO de esa fila; null si está vacío\n' +
    '      "fee": number|null       // GANANCIA/comisión del courier de esa fila\n' +
    "    }\n" +
    "  ]\n" +
    "}\n\n" +
    "Reglas:\n" +
    "- Una fila por entrega. Ignora encabezados y filas de TOTAL.\n" +
    "- Si hay varios bloques en la misma imagen, transcribe las filas de TODOS.\n" +
    "- En el reporte de Axel, CLIENTE es la tienda (AURELA/KENKU), NOMBRE es la " +
    "persona, EFECTIVO es amount, F. PAGO es payment_method y GANANCIA es fee.\n" +
    "- `amount` es solo el dinero de ESA fila, sin acumular.\n" +
    "- Si no distingues un dígito de un código, devuelve el código como null " +
    "en vez de adivinarlo: un vínculo equivocado es peor que uno ausente.\n" +
    "- Si la foto no es una hoja de liquidación, devuelve `lines` vacío."
  );
}

function normalizeMediaType(contentType: string | null | undefined): string {
  const ct = (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (SUPPORTED_MEDIA.has(ct)) return ct;
  if (ct === "image/jpg") return "image/jpeg";
  return "image/jpeg";
}

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

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.toLowerCase() !== "null" ? t : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = str(v);
  if (!s) return null;
  const cleaned = s.replace(/[^\d.,-]/g, "").replace(",", ".");
  // Sin un solo dígito no hay número. Sin esta guarda, `Number("")` es 0 y una
  // celda ilegible ("ilegible", "—", "??") se convertiría en un S/ 0.00 dicho
  // con toda confianza, que es justo lo que este módulo promete no hacer: 0 es
  // "declaró que no cobró" y null es "no se pudo leer". No son lo mismo.
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function deliveredPaymentMethod(v: unknown): string | null {
  const value = str(v);
  if (!value) return null;
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return [
    "efectivo",
    "pago pos",
    "pos",
    "transferencia",
    "transferencia bancaria",
    "yape",
    "plin",
    "deposito",
  ].includes(normalized)
    ? value
    : null;
}

/** Solo se acepta una fecha completa y bien formada; media fecha es ninguna. */
function day(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return Number.isFinite(Date.parse(`${s}T00:00:00.000Z`)) ? s : null;
}

/**
 * Convierte la respuesta del modelo en filas canónicas. Exportada aparte de la
 * llamada de red para poder probar la tolerancia del parseo sin tocar la API.
 */
export function parseSettlementVision(text: string): ParsedSettlementSheet | null {
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
  const rawLines = Array.isArray(o.lines) ? o.lines : [];

  const lines: ParsedSettlementLine[] = [];
  for (const item of rawLines) {
    if (!item || typeof item !== "object") continue;
    const l = item as Record<string, unknown>;
    const guide = str(l.guide);
    const order = str(l.order);
    const status = str(l.status);
    const amount = num(l.amount);
    const fee = num(l.fee);
    const customer = str(l.customer);
    const store = str(l.store);
    const paymentMethodRaw = str(l.payment_method);
    // Una fila que no dice absolutamente nada no aporta: no se guarda para que
    // no ensucie la cola de revisión con celdas en blanco de la foto.
    if (!guide && !order && !status && !customer && amount === null) continue;
    lines.push({
      guide_code: guide,
      // El nº de pedido se normaliza en la ingesta, junto con el de las hojas.
      order_name: order,
      declared_status: status,
      declared_amount: amount,
      // Un cuaderno manuscrito no declara la comisión del courier; el nombre y
      // el distrito sí aparecen, y son la pista de emparejamiento cuando la hoja
      // no trae guía.
      declared_fee: fee,
      customer_name: str(l.customer),
      district: str(l.district),
      store_hint: store,
      payment_method: deliveredPaymentMethod(paymentMethodRaw),
      // Se conserva lo que dijo el modelo para poder auditar la transcripción
      // contra la foto cuando alguien discuta un monto.
      raw: {
        guia: guide ?? "",
        pedido: order ?? "",
        nombre: str(l.customer) ?? "",
        distrito: str(l.district) ?? "",
        cliente: store ?? "",
        estado: status ?? "",
        f_pago: paymentMethodRaw ?? "",
        monto: amount === null ? "" : String(amount),
        ganancia: fee === null ? "" : String(fee),
        origen: "foto",
      },
    });
  }

  return { riderName: str(o.rider_name), settlementDate: day(o.date), lines };
}

/**
 * Lee una foto de liquidación. Nunca lanza: ante cualquier fallo devuelve cero
 * líneas con `ok:false`, que quien llama debe distinguir de "la hoja no tenía
 * filas" — si no, un timeout se convertiría en una liquidación vacía dada por
 * buena.
 */
export async function readSettlementPhoto(
  imageBase64: string,
  contentType: string | null | undefined,
  opts: SettlementVisionOpts,
): Promise<SettlementVisionResult> {
  const model = opts.model;
  const empty: SettlementVisionResult = {
    riderName: null,
    settlementDate: null,
    lines: [],
    ok: false,
    model,
  };
  if (!opts.apiKey || !imageBase64) {
    return { ...empty, failure: "missing_credentials", detail: "Falta la imagen o la clave de visión." };
  }

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
        max_tokens: MAX_TOKENS,
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
              { type: "text", text: buildPrompt() },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let detail = `Anthropic respondió HTTP ${res.status}.`;
      try {
        const error = (JSON.parse(body) as { error?: { type?: string; message?: string } }).error;
        if (error?.message) detail = `${error.type ?? "api_error"}: ${error.message}`;
      } catch {
        // El status basta; no reenviamos cuerpos arbitrarios a logs o UI.
      }
      return { ...empty, failure: "api_error", detail };
    }
    const json = await res.json();
    const parsed = parseSettlementVision(extractText(json));
    if (!parsed) {
      const stopReason = (json as { stop_reason?: string })?.stop_reason;
      return {
        ...empty,
        failure: "invalid_response",
        detail: stopReason === "max_tokens"
          ? "La transcripción quedó truncada por el límite de salida."
          : "El modelo no devolvió un JSON de liquidación válido.",
      };
    }
    return { ...parsed, ok: true, model };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      ...empty,
      failure: timedOut ? "timeout" : "api_error",
      detail: timedOut ? "La lectura excedió 105 segundos." : "La llamada de visión falló.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Envoltorio que usa la clave de la tienda y cae a la del entorno (0052). */
export async function readSettlementPhotoFromEnv(
  imageBase64: string,
  contentType: string | null | undefined,
  store: StoreVisionCreds = {},
): Promise<SettlementVisionResult> {
  const { apiKey, model, apiBase } = resolveVisionCreds(store);
  if (!apiKey) {
    return {
      riderName: null,
      settlementDate: null,
      lines: [],
      ok: false,
      model,
      failure: "missing_credentials",
      detail: "No hay una clave de visión configurada.",
    };
  }
  return readSettlementPhoto(imageBase64, contentType, { apiKey, model, apiBase });
}

/** Tamaño máximo de foto aceptado, para cortar antes de gastar una llamada. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** ¿El entorno tiene visión configurada? Permite que la UI oculte la carga por
 *  foto en vez de ofrecer un botón que siempre falla. */
export function visionEnabled(store: StoreVisionCreds = {}): boolean {
  return Boolean(store.anthropicApiKey || env.anthropicApiKey());
}
