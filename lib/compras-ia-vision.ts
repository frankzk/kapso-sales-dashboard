// «Leer con IA» (MOM §45.10): la llamada a Claude que lee una factura
// comercial, una proforma o un packing list de una importación y devuelve una
// PROPUESTA de productos y cargos. Mismo patrón que lib/vision.ts y
// lib/settlement-vision.ts: `fetch` directo a la API con `ANTHROPIC_VERSION`,
// clave y modelo de `resolveVisionCreds` (lib/env), tope de tiempo con
// AbortController y tres reglas:
//
//   1. NUNCA LANZA. Ante cualquier fallo (sin clave, timeout, HTTP, respuesta
//      ilegible) devuelve `ok:false` con un motivo en castellano.
//   2. NO INVENTA. Se le pide null para lo que no se ve; el SKU solo si está
//      escrito.
//   3. NO GUARDA. Lo que devuelve lo revisa una persona en la pantalla de la
//      propuesta (components/compras/ai-proposal.tsx); se agrega al pulsar
//      «Agregar seleccionados» y nada antes.
//
// La salida se pide con una herramienta (`registrar_documento`) y su esquema;
// si el modelo contesta en texto, se lee el JSON del texto. La normalización
// es pura y está probada aparte (`parseAiProposal`, lib/compras-ia.ts).

import { parseAiProposal, type AiProposal } from "@/lib/compras-ia";

const ANTHROPIC_VERSION = "2023-06-01";
// Como la hoja de liquidación (lib/settlement-vision.ts): margen dentro de los
// 120 s de la función (`maxDuration` de la página del detalle).
export const PURCHASE_AI_TIMEOUT_MS = 105_000;
const MAX_TOKENS = 16_000;
const IMAGE_MEDIA = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const TOOL_NAME = "registrar_documento";

export type PurchaseAiFailure = "missing_credentials" | "unsupported" | "api_error" | "timeout" | "invalid_response" | "refusal" | "truncated";

export type PurchaseAiResult =
  | { ok: true; proposal: AiProposal; model: string }
  | { ok: false; failure: PurchaseAiFailure; error: string; model: string };

export interface PurchaseAiOpts {
  apiKey: string;
  model: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const PURCHASE_AI_SYSTEM =
  "Eres un asistente que lee documentos de importaciones para una empresa de Perú: " +
  "facturas comerciales, proformas (proforma invoice) y packing lists de proveedores " +
  "del extranjero, normalmente de China.\n\n" +
  "Tu única tarea es TRANSCRIBIR lo que el documento dice, sin inventar:\n" +
  "- Una línea por producto, con las UNIDADES totales. Si viene por cajas o cartones, " +
  "unidades = cajas × unidades por caja.\n" +
  "- El precio por unidad en la moneda del documento; si solo está el total de la " +
  "línea, devuelve el total y deja el precio por unidad en null.\n" +
  "- Lo que no es un producto va en cargos: flete, envío, courier y seguro del " +
  "transporte son «envio»; aranceles, impuestos y agente de aduana son «importacion»; " +
  "comisión bancaria, embalaje, inspección y cualquier otro cargo son «adicional».\n" +
  "- No pongas como línea ni como cargo los subtotales, totales, descuentos ni anticipos.\n" +
  "- Escribe el nombre del producto en español, breve y fiel; no agregues datos que no estén.\n" +
  "- El SKU (código, modelo o item no.) solo si está escrito; si no, null.\n" +
  "- Si un dato no aparece o no se lee con claridad, usa null. Un packing list " +
  "normalmente no trae precios: déjalos en null.\n" +
  "- Si el documento no es una factura, proforma ni packing list, devuelve las listas vacías.";

const nullable = (type: "string" | "number") => ({ type: [type, "null"] });

export const PURCHASE_AI_TOOL = {
  name: TOOL_NAME,
  description: "Registra las líneas de productos y los cargos leídos del documento de la importación.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      currency: { ...nullable("string"), description: "Moneda del documento en ISO 4217 (USD, CNY, EUR…), o null si no lo dice." },
      lines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", description: "Nombre del producto, en español." },
            sku: { ...nullable("string"), description: "Código, modelo o SKU tal como está escrito, o null." },
            quantity: { ...nullable("number"), description: "Unidades totales (cajas × unidades por caja)." },
            unit_price: { ...nullable("number"), description: "Precio por unidad en la moneda del documento." },
            line_total: { ...nullable("number"), description: "Total de la línea en la moneda del documento." },
            unit_weight_kg: { ...nullable("number"), description: "Peso por unidad en kg, si se ve." },
            line_weight_kg: { ...nullable("number"), description: "Peso total de la línea en kg, si solo se ve ese." },
          },
          required: ["name", "sku", "quantity", "unit_price", "line_total", "unit_weight_kg", "line_weight_kg"],
        },
      },
      charges: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["envio", "importacion", "adicional"] },
            label: { type: "string", description: "Nombre del cargo en español (Flete, Seguro, Comisión bancaria…)." },
            amount: { ...nullable("number"), description: "Monto en la moneda del documento." },
          },
          required: ["kind", "label", "amount"],
        },
      },
    },
    required: ["currency", "lines", "charges"],
  },
} as const;

/** El bloque del archivo: `document` para el PDF, `image` para la foto. Null si no se puede mandar. */
export function fileBlock(base64: string, mime: string): Record<string, unknown> | null {
  if (mime === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
  }
  if (IMAGE_MEDIA.has(mime)) return { type: "image", source: { type: "base64", media_type: mime, data: base64 } };
  return null;
}

/** La entrada de la herramienta o, si contestó en texto, el texto. */
export function extractAiOutput(json: unknown): unknown {
  const content = (json as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const b = block as { type?: string; name?: string; input?: unknown };
    if (b?.type === "tool_use" && b.name === TOOL_NAME && b.input && typeof b.input === "object") return b.input;
  }
  const texts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
  }
  return texts.length ? texts.join("\n") : null;
}

/** El error de la API en castellano, sin reenviar cuerpos arbitrarios. */
export function apiErrorMessage(status: number): string {
  if (status === 401 || status === 403) return "La clave de IA no es válida o no tiene acceso. Revísala en Ajustes.";
  if (status === 413) return "El archivo es demasiado grande para la IA.";
  if (status === 429 || status === 529 || status >= 500) return "La IA está ocupada en este momento. Vuelve a intentarlo en unos minutos.";
  if (status === 400) return "La IA no pudo abrir el archivo (¿PDF protegido, dañado o de más de 100 páginas?).";
  return `La IA respondió con un error (HTTP ${status}).`;
}

/**
 * Lee el documento. Nunca lanza: ante cualquier fallo devuelve `ok:false` con
 * el motivo, que la pantalla muestra tal cual.
 */
export async function readPurchaseDocument(base64: string, mime: string, opts: PurchaseAiOpts): Promise<PurchaseAiResult> {
  const model = opts.model;
  const fail = (failure: PurchaseAiFailure, error: string): PurchaseAiResult => ({ ok: false, failure, error, model });
  if (!opts.apiKey) return fail("missing_credentials", "No hay una clave de IA configurada.");
  const block = base64 ? fileBlock(base64, mime) : null;
  if (!block) return fail("unsupported", "La IA solo lee PDF, JPG, PNG o WEBP.");

  const doFetch = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? "https://api.anthropic.com").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? PURCHASE_AI_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        system: PURCHASE_AI_SYSTEM,
        tools: [PURCHASE_AI_TOOL],
        // `auto` y la instrucción de usarla: algunos modelos no aceptan forzar la herramienta.
        tool_choice: { type: "auto" },
        messages: [
          {
            role: "user",
            content: [block, { type: "text", text: `Lee el documento y llama a la herramienta ${TOOL_NAME} con lo que dice.` }],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return fail("api_error", apiErrorMessage(res.status));
    const json = (await res.json()) as { stop_reason?: string };
    if (json?.stop_reason === "refusal") return fail("refusal", "La IA no quiso leer este documento. Cárgalo a mano.");
    const proposal = parseAiProposal(extractAiOutput(json));
    if (!proposal) {
      return json?.stop_reason === "max_tokens"
        ? fail("truncated", "La lectura quedó cortada: el documento tiene demasiadas líneas. Divídelo y léelo por partes.")
        : fail("invalid_response", "La IA no devolvió una lectura válida. Vuelve a intentarlo o cárgalo a mano.");
    }
    return { ok: true, proposal, model };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return timedOut
      ? fail("timeout", `La lectura pasó de ${Math.round(timeoutMs / 1000)} segundos. Vuelve a intentarlo o divide el documento.`)
      : fail("api_error", "No se pudo conectar con la IA. Vuelve a intentarlo.");
  } finally {
    clearTimeout(timer);
  }
}
