// Lector de la constancia de pago de una entrega Tanders.
//
// POR QUÉ NO SIRVE EL DE lib/vision.ts. Aquel pregunta "¿es un comprobante
// YAPE?", porque nació para los adelantos del cliente, que siempre lo son. Acá
// el repartidor remite de dos formas —Yape o transferencia BCP— y la segunda
// haría que aquel respondiera "no es un comprobante", rechazando un pago
// perfectamente bueno.
//
// Devuelve lo que se ve, sin juzgar: quién recibe, cuánto y por qué medio. La
// decisión de si eso vale como cobro vive en payment-check.ts, aparte y testeada.
//
// Mismo contrato que el resto de módulos que hablan con Claude: raw fetch, nunca
// lanza, y ante cualquier fallo devuelve `ok: false` para que el llamante NO lo
// confunda con un veredicto negativo — un timeout no es un pago mal hecho.

import { normalizeMediaType, resolveVisionCreds, type StoreVisionCreds } from "@/lib/vision";

const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 20_000;

/** Cómo remitió el repartidor. `otro` incluye lo que no se reconoce. */
export type PaymentMethod = "yape" | "bcp" | "otro";

export interface TandersPaymentReading {
  /** ¿La imagen es un comprobante de pago (de cualquiera de los dos medios)? */
  isPaymentProof: boolean;
  method: PaymentMethod;
  recipientName: string | null;
  amount: number | null;
  operationNumber: string | null;
  /** false = no hubo veredicto (sin clave, timeout, red, respuesta ilegible). */
  ok: boolean;
  model: string;
}

const FAILED: Omit<TandersPaymentReading, "model"> = {
  isPaymentProof: false,
  method: "otro",
  recipientName: null,
  amount: null,
  operationNumber: null,
  ok: false,
};

const SYSTEM_PROMPT =
  "Eres un lector de constancias de pago peruanas. Recibes UNA imagen y " +
  "transcribes SOLO lo que se ve. Puede ser un comprobante de Yape (billetera " +
  "móvil) o el voucher de una transferencia bancaria (BCP u otro banco): los " +
  "dos son válidos. Nunca inventes ni completes un dato parcial: si un campo " +
  "está cortado, borroso o no aparece, devuélvelo como null. Un dato mal " +
  "transcrito es peor que ninguno. Responde ÚNICAMENTE con un objeto JSON.";

const PROMPT =
  "Devuelve JSON con esta forma exacta:\n" +
  "{\n" +
  '  "is_payment_proof": boolean,     // ¿es un comprobante de pago real?\n' +
  '  "method": "yape"|"bcp"|"otro",   // medio que se ve en la imagen\n' +
  '  "recipient_name": string|null,   // a QUIÉN se pagó, tal como aparece\n' +
  '  "amount": number|null,           // monto en soles, solo el número\n' +
  '  "operation_number": string|null  // nº de operación / constancia\n' +
  "}\n" +
  "El destinatario es el dato más importante: cópialo literal, aunque venga " +
  "recortado. No lo confundas con quien envía el dinero.";

function parseAmount(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseMethod(v: unknown): PaymentMethod {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("yape")) return "yape";
  if (s.includes("bcp") || s.includes("transfer")) return "bcp";
  return "otro";
}

function text(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

/** Lee la constancia. Nunca lanza. */
export async function readTandersPayment(
  imageBase64: string,
  contentType: string | null | undefined,
  store: StoreVisionCreds = {},
): Promise<TandersPaymentReading> {
  const { apiKey, model, apiBase } = resolveVisionCreds(store);
  if (!apiKey) return { ...FAILED, model };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
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
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return { ...FAILED, model };

    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const raw = body.content?.find((c) => c.type === "text")?.text ?? "";
    // El modelo a veces envuelve el JSON en ```json … ```.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { ...FAILED, model };

    const json = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      isPaymentProof: json.is_payment_proof === true,
      method: parseMethod(json.method),
      recipientName: text(json.recipient_name),
      amount: parseAmount(json.amount),
      operationNumber: text(json.operation_number),
      ok: true,
      model,
    };
  } catch {
    return { ...FAILED, model };
  } finally {
    clearTimeout(timer);
  }
}
