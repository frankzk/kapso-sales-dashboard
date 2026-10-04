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

import {
  normalizeMediaType,
  parseVoucherInstant,
  resolveVisionCreds,
  type StoreVisionCreds,
} from "@/lib/vision";

const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Cómo remitió el repartidor. `otro` incluye lo que no se reconoce.
 *
 * Plin entró el 10-09-2026: la constancia de #KP131846 era un Plin al número
 * Yape de Grupo GF SAC («Enviado a: Grupo Gf S · 930 555 309 - Yape»), o sea el
 * mismo dinero en la misma cuenta. Plin y Yape se pagan entre sí, y el
 * motorizado usa la billetera que tenga; rechazarlo por el logo era rechazar un
 * cobro bueno. 7 de los 9 rechazos de ese día fueron por esto.
 */
export type PaymentMethod = "yape" | "plin" | "bcp" | "otro";

export interface TandersPaymentReading {
  /** ¿La imagen es un comprobante de pago (de cualquiera de los dos medios)? */
  isPaymentProof: boolean;
  method: PaymentMethod;
  /**
   * La constancia dice que el dinero fue a un YAPE, venga de la app que venga:
   * «Cuenta/billetera: Yape» (Prex), «Entidad de destino: Yape» (BBVA), «- Yape»
   * (Plin). Es independiente de `method`, que dice qué app EMITIÓ la constancia.
   */
  toYape: boolean;
  recipientName: string | null;
  amount: number | null;
  operationNumber: string | null;
  /**
   * Fecha y hora del pago en ISO, SOLO si la constancia muestra las dos. Es lo
   * que permite cruzar el cobro con el estado de cuenta de Yape al minuto
   * (MOM §9.4). Sin hora no se inventa la medianoche: queda null y el cobro lo
   * firma una persona.
   */
  paidAt: string | null;
  /** false = no hubo veredicto (sin clave, timeout, red, respuesta ilegible). */
  ok: boolean;
  model: string;
}

const FAILED: Omit<TandersPaymentReading, "model"> = {
  isPaymentProof: false,
  method: "otro",
  toYape: false,
  recipientName: null,
  amount: null,
  operationNumber: null,
  paidAt: null,
  ok: false,
};

const SYSTEM_PROMPT =
  "Eres un lector de constancias de pago peruanas. Recibes UNA imagen y " +
  "transcribes SOLO lo que se ve. Puede ser un comprobante de Yape o de Plin " +
  "(billeteras móviles) o el voucher de una transferencia bancaria (BCP u otro " +
  "banco): los tres son válidos. Nunca inventes ni completes un dato parcial: " +
  "si un campo está cortado, borroso o no aparece, devuélvelo como null. Un " +
  "dato mal transcrito es peor que ninguno. Responde ÚNICAMENTE con un objeto JSON.";

const PROMPT =
  "Devuelve JSON con esta forma exacta:\n" +
  "{\n" +
  '  "is_payment_proof": boolean,          // ¿es un comprobante de pago real?\n' +
  '  "method": "yape"|"plin"|"bcp"|"otro", // medio que se ve en la imagen\n' +
  '  "destination": string|null,           // adónde fue el dinero, TAL COMO lo dice la constancia\n' +
  '  "recipient_name": string|null,        // a QUIÉN se pagó, tal como aparece\n' +
  '  "amount": number|null,                // monto en soles, solo el número\n' +
  '  "operation_number": string|null,      // SOLO el código, sin "N°" ni etiquetas\n' +
  '  "date": string|null,                  // fecha del pago, tal como se ve (p. ej. "30 set. 2026")\n' +
  '  "time": string|null                   // hora del pago, tal como se ve, con "a. m."/"p. m." si aparece\n' +
  "}\n" +
  "El medio se reconoce por el logo y el diseño de la app: Yape es morado, " +
  "Plin es celeste. Un Plin puede decir que el destino es un número «Yape»: " +
  "eso sigue siendo un comprobante de Plin, que es lo que hay que devolver.\n" +
  "LA APP DEL BCP NO SIEMPRE MUESTRA SU LOGO. Su constancia es blanca, con " +
  "azul y naranja, dice «¡Transferencia exitosa!» y lista «Enviado a», «Desde» " +
  "y «Número de operación». Eso es \"bcp\", también cuando desde esa app se " +
  "envió a un Yape. No la devuelvas como \"otro\" por no ver el logo.\n" +
  "MUCHAS APPS PAGAN A UN YAPE: Prex, BBVA, Interbank y otras. Su constancia " +
  "lo dice —«Cuenta/billetera: Yape», «Entidad de destino: Yape», «- Yape»—. " +
  "Copia eso en \"destination\" tal cual; si la constancia no dice adónde fue " +
  "el dinero, destination es null. En \"method\" va la app que EMITIÓ la " +
  "constancia, no el destino.\n" +
  "El destinatario es el dato más importante: cópialo literal, aunque venga " +
  "recortado. No lo confundas con quien envía el dinero. El número de cuenta " +
  "enmascarado que algunas apps ponen debajo («**** 0012») no es parte del " +
  "nombre: no lo copies.\n" +
  "El nº de operación se compara entre guías para detectar un comprobante " +
  "reusado, así que devuelve el código y nada más: sin «N°», sin «Código de " +
  "operación:», sin espacios ni guiones de separación.\n" +
  "La fecha y la hora son las DEL PAGO que imprime la constancia, no la del " +
  "reloj del teléfono en la barra de arriba. Copia la hora con su «a. m.» o " +
  "«p. m.» si lo trae: sin eso, las 02:15 de la tarde parecen de la madrugada.";

function parseAmount(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseMethod(v: unknown): PaymentMethod {
  const s = String(v ?? "").toLowerCase();
  // Plin va PRIMERO: una constancia de Plin nombra el destino como número
  // «Yape», así que "plin (a yape)" tiene que salir plin, no yape. Al revés no
  // pasa —un Yape no menciona Plin—, y para el veredicto valen los dos igual;
  // esto es para que el reporte diga la verdad de lo que se vio.
  if (s.includes("plin")) return "plin";
  if (s.includes("yape")) return "yape";
  if (s.includes("bcp") || s.includes("transfer")) return "bcp";
  return "otro";
}

function text(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

/**
 * El instante del pago, solo con fecha Y hora. `parseVoucherInstant` deja la
 * medianoche cuando falta la hora, que para un adelanto basta; aquí el dato se
 * usa para cruzar al minuto con el estado de cuenta, y una medianoche
 * inventada es una hora falsa.
 */
export function paidAtFrom(
  date: string | null,
  time: string | null,
  now: number = Date.now(),
): string | null {
  if (!date || !time) return null;
  // El Plin de Scotiabank no imprime el año («03 oct.»). Se lee hoy una
  // constancia de hace días: es el año en curso, salvo que eso la pusiera en el
  // futuro (una de diciembre leída en enero).
  if (!/\d{4}/.test(date)) {
    const year = new Date(now - 5 * 3_600_000).getUTCFullYear();
    const guess = parseVoucherInstant(`${date.replace(/[.\s]+$/, "")} ${year}`, time);
    if (!guess) return null;
    return Date.parse(guess) > now + 86_400_000
      ? parseVoucherInstant(`${date.replace(/[.\s]+$/, "")} ${year - 1}`, time)
      : guess;
  }
  return parseVoucherInstant(date, time);
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
      toYape: /yape/i.test(text(json.destination) ?? ""),
      recipientName: text(json.recipient_name),
      amount: parseAmount(json.amount),
      operationNumber: text(json.operation_number),
      paidAt: paidAtFrom(text(json.date), text(json.time)),
      ok: true,
      model,
    };
  } catch {
    return { ...FAILED, model };
  } finally {
    clearTimeout(timer);
  }
}
