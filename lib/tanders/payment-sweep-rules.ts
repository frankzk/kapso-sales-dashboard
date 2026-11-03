// Reglas puras del barrido de cobros Tanders (lib/tanders/payment-sweep.ts).
//
// Viven aparte para poder probarlas sin base, sin Tanders y sin modelo. Son dos:
//
//  1. CUÁNDO UNA COMPROBACIÓN ES NUEVA. El barrido relee en cada pasada las
//     guías cuyo cobro no tiene ficha —un comprobante repetido no la tiene
//     nunca—, y escribía una fila en `tanders_payment_checks` cada vez aunque
//     dijera lo mismo: el 16-10-2026 había cuatro guías con 175-189 filas
//     idénticas cada una. Una fila nueva es un HECHO nuevo (otro veredicto u
//     otro comprobante); releer y llegar a lo mismo no lo es.
//
//  2. LA FICHA DE UN COBRO QUE YA SE VALIDÓ. Las guías que el lector dio por
//     cobradas antes de que existiera «Validar pagos» (10 al 12-09-2026) se
//     quedaron sin ficha, y el barrido ya no las relee porque están
//     `entregado`. Su lectura está guardada: con ella se prepara la ficha sin
//     volver a gastar una llamada al modelo.

import { extractPaymentEvidence } from "@/lib/tanders/client";
import type { PaymentCheckVerdict } from "@/lib/tanders/payment-check";
import type { PaymentMethod, TandersPaymentReading } from "@/lib/tanders/payment-vision";

// ---------------------------------------------------------------------------
// 1. ¿Es la misma comprobación?
// ---------------------------------------------------------------------------

/** Lo que distingue una comprobación de otra: el veredicto y el comprobante leído. */
export interface HuellaComprobacion {
  state: string;
  reasons: readonly string[] | null;
  image_url: string | null;
  operation_number: string | null;
  /** La base devuelve `numeric` como texto («129.00»). */
  amount: number | string | null;
}

function montoDe(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function motivosDe(r: readonly string[] | null | undefined): string {
  return [...new Set(r ?? [])].sort().join("|");
}

/**
 * ¿La comprobación nueva dice lo mismo que la última guardada de esa guía?
 *
 * Mismo veredicto (estado y motivos, en cualquier orden) sobre el mismo
 * comprobante (imagen, nº de operación y monto). Si algo de eso cambia es un
 * hecho nuevo y se escribe; si no, la fila que ya está lo cuenta y la hora de
 * la última mirada queda en el sello de la guía (`payment_checked_at`). Así no
 * se sobrescribe nada: la fila guardada sigue diciendo cuándo se llegó a ese
 * veredicto por primera vez.
 */
export function mismaComprobacion(
  previa: HuellaComprobacion | null | undefined,
  nueva: HuellaComprobacion,
): boolean {
  if (!previa) return false;
  return (
    previa.state === nueva.state &&
    motivosDe(previa.reasons) === motivosDe(nueva.reasons) &&
    (previa.image_url ?? null) === (nueva.image_url ?? null) &&
    (previa.operation_number ?? null) === (nueva.operation_number ?? null) &&
    montoDe(previa.amount) === montoDe(nueva.amount)
  );
}

// ---------------------------------------------------------------------------
// 2. La ficha desde la lectura guardada
// ---------------------------------------------------------------------------

/** La última fila de `tanders_payment_checks` de la guía. */
export interface ComprobacionGuardada extends HuellaComprobacion {
  expected_amount: number | string | null;
  recipient_name: string | null;
  model: string | null;
  checked_at: string | null;
  /** La respuesta de evidencias de Tanders tal cual se guardó. */
  raw: unknown;
}

export type FichaDesdeLectura =
  | {
      ok: true;
      imageUrl: string;
      reading: TandersPaymentReading;
      verdict: PaymentCheckVerdict;
      expectedAmount: number | null;
    }
  | { ok: false; motivo: string };

/**
 * El medio, según lo que Tanders dice del pago de ESA imagen.
 *
 * La lectura de septiembre no guardó qué app emitió la constancia, y el dato
 * solo va al registro de lo leído (`vision`) de la ficha: no decide nada. Lo
 * que Tanders reporta (`entity: "YAPE"`) es dato de apoyo, y como tal se usa;
 * lo que no se reconoce queda como «otro» en vez de adivinarlo.
 */
export function medioSegunTanders(raw: unknown, imageUrl: string): PaymentMethod {
  const pago = extractPaymentEvidence(raw).find((e) => e.imageUrl === imageUrl);
  const via = (pago?.method ?? "").trim().toUpperCase();
  if (via === "YAPE") return "yape";
  if (via === "PLIN") return "plin";
  if (via === "BCP") return "bcp";
  return "otro";
}

/** «10-09-2026», en hora de Lima. */
function fechaLima(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // AAAA-MM-DD
  return `${partes.slice(8, 10)}-${partes.slice(5, 7)}-${partes.slice(0, 4)}`;
}

/**
 * Prepara la ficha de «Validar pagos» de una guía que el lector YA validó, con
 * la lectura que quedó guardada entonces. Pura.
 *
 * Entra como cualquier cobro que el lector dio por bueno: `pendiente_revision`,
 * a la espera de que una persona lo confirme. Sin la hora del pago —esa
 * lectura no la transcribía—, así que el estado de cuenta de Yape no la puede
 * cruzar al minuto: la firma la pone alguien, como dice la regla.
 *
 * Solo sirve si lo guardado es un `validado` con su imagen: cualquier otra cosa
 * no es «una ficha que faltaba», es una guía que hay que mirar, y se devuelve
 * el motivo para el reporte en vez de inventar la lectura.
 */
export function fichaDesdeComprobacion(c: ComprobacionGuardada | null | undefined): FichaDesdeLectura {
  if (!c) {
    return {
      ok: false,
      motivo: "Guía con el cobro validado pero sin ninguna lectura guardada: no se puede preparar su ficha.",
    };
  }
  if (c.state !== "validado") {
    return {
      ok: false,
      motivo: "Guía con el cobro validado cuya última lectura guardada no es «validado»: hay que mirarla.",
    };
  }
  if (!c.image_url) {
    return {
      ok: false,
      motivo: "Guía con el cobro validado cuya lectura guardada no tiene la imagen de la constancia.",
    };
  }
  const fecha = fechaLima(c.checked_at);
  const reading: TandersPaymentReading = {
    isPaymentProof: true,
    method: medioSegunTanders(c.raw, c.image_url),
    toYape: false,
    recipientName: c.recipient_name,
    amount: montoDe(c.amount),
    operationNumber: c.operation_number,
    paidAt: null,
    ok: true,
    model: c.model ?? "lectura guardada",
  };
  return {
    ok: true,
    imageUrl: c.image_url,
    reading,
    verdict: {
      state: "validado",
      reasons: [],
      summary:
        `El lector lo validó${fecha ? ` el ${fecha}` : ""} y el cobro se quedó sin ficha; ` +
        "se crea ahora con esa misma lectura, sin volver a leerla.",
    },
    expectedAmount: montoDe(c.expected_amount),
  };
}
