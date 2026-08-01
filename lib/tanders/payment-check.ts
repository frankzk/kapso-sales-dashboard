// Validación de la constancia de PAGO de una entrega Tanders.
//
// Tanders sube dos evidencias por entrega: la foto del paquete entregado y el
// comprobante del pago. Solo la segunda importa acá — la primera no es un
// comprobante y pasarla por el lector daría basura.
//
// Qué se comprueba: que sea un comprobante REAL —Yape o transferencia BCP, los
// dos medios con los que el repartidor remite—, a Grupo GF SAC, por el monto que
// la guía dice que había que cobrar. Un pago a otra cuenta es dinero que no
// llegó; un monto distinto es un cobro mal hecho; un medio no acordado no se
// puede conciliar después. Los tres exigen que alguien mire, y hasta entonces la
// guía NO pasa a entregada.
//
// Puro y testeado: acá se decide si un cobro se da por bueno.

/** Estado de la comprobación. El pedido solo se da por cobrado en `validado`. */
export type PaymentCheckState =
  | "pendiente" // todavía no hay constancia, o no se pudo leer
  | "validado" // comprobante a Grupo GF SAC por el monto correcto
  | "rechazado" // se leyó y NO cuadra: exige revisión de un administrador
  | "revisado"; // un administrador lo miró y lo dio por bueno a mano

/** Por qué se rechazó. Se guardan todos: el revisor ve el cuadro completo. */
export type PaymentCheckReason =
  | "no_es_comprobante"
  | "medio_no_aceptado"
  | "destinatario_distinto"
  | "monto_distinto"
  | "sin_destinatario"
  | "sin_monto";

export const REASON_LABEL: Record<PaymentCheckReason, string> = {
  no_es_comprobante: "La imagen no es un comprobante de pago",
  medio_no_aceptado: "El medio de pago no es Yape ni transferencia BCP",
  destinatario_distinto: "El pago NO va a Grupo GF SAC",
  monto_distinto: "El monto no coincide con el de la guía",
  sin_destinatario: "No se pudo leer a quién se pagó",
  sin_monto: "No se pudo leer el monto",
};

/** A quién tiene que ir el dinero. Igual que en lib/vision.ts. */
export const EXPECTED_RECIPIENT = "Grupo GF SAC";

/**
 * Tolerancia del monto, en soles. Un céntimo de diferencia es redondeo del
 * comprobante, no un cobro mal hecho; a partir de ahí ya no se puede explicar
 * sola y la mira un humano.
 */
export const AMOUNT_TOLERANCE = 0.5;

export interface PaymentCheckInput {
  /** Lo que el lector de comprobantes sacó de la imagen. */
  voucher: {
    /** false = el modelo no pudo decidir (sin clave, timeout, ilegible). */
    ok: boolean;
    isVoucher: boolean;
    /** El repartidor remite por Yape o por transferencia BCP: valen los dos. */
    method: "yape" | "bcp" | "otro";
    recipientName: string | null;
    amount: number | null;
    operationNumber: string | null;
  };
  /** Lo que la guía dice que había que cobrar. */
  expectedAmount: number | null;
}

export interface PaymentCheckVerdict {
  state: PaymentCheckState;
  reasons: PaymentCheckReason[];
  /** Texto para la alerta y para el Master. */
  summary: string;
}

/**
 * Normaliza un nombre para compararlo: sin acentos, sin puntuación, en
 * minúsculas. "GRUPO G.F. S.A.C." y "Grupo GF SAC" son el mismo destinatario y
 * rechazar por la puntuación sería ruido puro.
 */
export function normalizeRecipient(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** ¿El destinatario leído es Grupo GF SAC? */
export function isExpectedRecipient(raw: string | null | undefined): boolean {
  const got = normalizeRecipient(raw);
  if (!got) return false;
  const want = normalizeRecipient(EXPECTED_RECIPIENT);
  // Yape recorta nombres largos ("Grupo GF S..."), así que basta con que uno
  // contenga al otro: exigir igualdad exacta rechazaría comprobantes buenos.
  return got.includes(want) || want.includes(got);
}

/**
 * Decide. Nunca devuelve `validado` sin haber leído de verdad el comprobante:
 * ante la duda queda `pendiente`, que bloquea igual pero no acusa a nadie.
 *
 * La diferencia importa. `rechazado` dice "esto está mal y hay que mirarlo";
 * `pendiente` dice "todavía no lo sé". Marcar un fallo del lector como rechazo
 * mandaría al equipo a investigar un fraude que no existe.
 */
export function checkTandersPayment(input: PaymentCheckInput): PaymentCheckVerdict {
  const { voucher, expectedAmount } = input;

  if (!voucher.ok) {
    return {
      state: "pendiente",
      reasons: [],
      summary: "No se pudo leer la constancia todavía.",
    };
  }

  const reasons: PaymentCheckReason[] = [];

  if (!voucher.isVoucher) {
    // Sin comprobante no hay nada más que comprobar: el resto de los campos
    // vendrían de una imagen que no es un comprobante.
    return {
      state: "rechazado",
      reasons: ["no_es_comprobante"],
      summary: REASON_LABEL.no_es_comprobante + ".",
    };
  }

  // Los dos medios que la operación acepta. Cualquier otro exige que alguien
  // mire: un pago por una vía no acordada no se puede conciliar después.
  if (voucher.method === "otro") reasons.push("medio_no_aceptado");

  if (!voucher.recipientName) reasons.push("sin_destinatario");
  else if (!isExpectedRecipient(voucher.recipientName)) reasons.push("destinatario_distinto");

  if (voucher.amount == null) reasons.push("sin_monto");
  else if (expectedAmount != null && Math.abs(voucher.amount - expectedAmount) > AMOUNT_TOLERANCE) {
    reasons.push("monto_distinto");
  }

  if (!reasons.length) {
    return {
      state: "validado",
      reasons: [],
      summary: `${voucher.method === "bcp" ? "Transferencia BCP" : "Yape"} a ${EXPECTED_RECIPIENT}${
        voucher.amount != null ? ` por S/ ${voucher.amount.toFixed(2)}` : ""
      }.`,
    };
  }

  const detail: string[] = [];
  if (reasons.includes("destinatario_distinto")) {
    detail.push(`destinatario leído: "${voucher.recipientName}"`);
  }
  if (reasons.includes("monto_distinto")) {
    detail.push(`monto leído S/ ${voucher.amount?.toFixed(2)} vs S/ ${expectedAmount?.toFixed(2)} de la guía`);
  }

  return {
    state: "rechazado",
    reasons,
    summary:
      reasons.map((r) => REASON_LABEL[r]).join(". ") + (detail.length ? ` — ${detail.join("; ")}.` : "."),
  };
}
