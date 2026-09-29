// Validación de la constancia de PAGO de una entrega Tanders.
//
// Tanders sube dos evidencias por entrega: la foto del paquete entregado y el
// comprobante del pago. Solo la segunda importa acá — la primera no es un
// comprobante y pasarla por el lector daría basura.
//
// Qué se comprueba: que sea un comprobante REAL —Yape, Plin o transferencia
// BCP, los medios con los que el repartidor remite—, a Grupo GF SAC, por el
// monto que la guía dice que había que cobrar. Un pago a otra cuenta es dinero
// que no llegó; un monto distinto es un cobro mal hecho; un medio no acordado no
// se puede conciliar después. Los tres exigen que alguien mire, y hasta entonces
// la guía NO pasa a entregada.
//
// Puro y testeado: acá se decide si un cobro se da por bueno.

import { splitRecipientPhoneSuffix } from "@/lib/yape-recipient";

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
  | "sin_monto"
  | "operacion_duplicada";

export const REASON_LABEL: Record<PaymentCheckReason, string> = {
  no_es_comprobante: "La imagen no es un comprobante de pago",
  medio_no_aceptado: "El medio de pago no es Yape, Plin ni transferencia BCP, ni va a un Yape",
  destinatario_distinto: "El pago NO va a Grupo GF SAC",
  monto_distinto: "El monto no coincide con el de la guía",
  sin_destinatario: "No se pudo leer a quién se pagó",
  sin_monto: "No se pudo leer el monto",
  operacion_duplicada: "Este comprobante YA se usó en otra guía",
};

/** A quién tiene que ir el dinero. Igual que en lib/vision.ts. */
export const EXPECTED_RECIPIENT = "Grupo GF SAC";

/** Final de su celular (930 555 309), igual que en store_collection_accounts. */
export const EXPECTED_RECIPIENT_PHONE_LAST_DIGITS = "309";

/** Cómo se nombra cada medio en el resumen que lee la operadora. */
export const METHOD_LABEL: Record<PaymentCheckInput["voucher"]["method"], string> = {
  yape: "Yape",
  plin: "Plin",
  bcp: "Transferencia BCP",
  otro: "Medio no reconocido",
};

/**
 * Tolerancia del monto, en soles. Un céntimo de diferencia es redondeo del
 * comprobante, no un cobro mal hecho; a partir de ahí ya no se puede explicar
 * sola y la mira un humano.
 */
export const AMOUNT_TOLERANCE = 0.5;

/**
 * El nº de operación normalizado. VIVE EN lib/yape-dedup.ts, no acá.
 *
 * Se reexporta para no tener dos normalizaciones del mismo dato: ese módulo ya
 * lo usa como llave del índice único GLOBAL de `order_payments`, y dos reglas
 * distintas para la misma llave es como se cuela un duplicado. La versión
 * compartida trae además una guarda que a esta le faltaba —un número de menos
 * de seis caracteres leído por OCR no se acepta, porque Yape muestra al lado un
 * código de seguridad de tres dígitos y el monto—, y se le añadió la de acá: una
 * lectura truncada («202609...495099») devuelve null en vez de un número
 * inventado.
 */
export { normalizeOperationNumber } from "@/lib/yape-dedup";

export interface PaymentCheckInput {
  /**
   * Otras guías donde este mismo nº de operación ya quedó registrado. Vacío es
   * lo normal; con algo dentro, el mismo pago se está acreditando dos veces.
   */
  duplicateOf?: string[] | null;
  /** Lo que el lector de comprobantes sacó de la imagen. */
  voucher: {
    /** false = el modelo no pudo decidir (sin clave, timeout, ilegible). */
    ok: boolean;
    isVoucher: boolean;
    /** El repartidor remite por Yape, Plin o transferencia BCP: valen los tres. */
    method: "yape" | "plin" | "bcp" | "otro";
    /**
     * La constancia dice que el dinero fue a un Yape («Cuenta/billetera: Yape»).
     * Vale venga de la app que venga: cae en la misma cuenta Yape.
     */
    toYape?: boolean;
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
  // La app del BBVA pega el final del celular al nombre: «Grupo gf s •5309».
  // Sin separarlo, «5309» rompía la comparación y el cobro salía «NO va a
  // Grupo GF SAC» (#KP137040). Separado, es la otra señal: tiene que terminar
  // en el celular de la cuenta, o es otra cuenta aunque el nombre encaje.
  const { name, phoneDigits } = splitRecipientPhoneSuffix(raw);
  if (phoneDigits && !phoneDigits.endsWith(EXPECTED_RECIPIENT_PHONE_LAST_DIGITS)) return false;
  const got = normalizeRecipient(name);
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
  const duplicateOf = input.duplicateOf ?? [];

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

  // Los medios que la operación acepta. Cualquier otro exige que alguien mire:
  // un pago por una vía no acordada no se puede conciliar después.
  //
  // PLIN CUENTA. Plin y Yape se pagan entre sí y caen en la misma cuenta —la
  // constancia de un Plin al número de Grupo GF SAC dice literalmente «Enviado
  // a: … - Yape»—, y el motorizado remite con la billetera que tenga. El
  // 10-09-2026, 7 de 9 rechazos fueron cobros buenos rechazados por el logo.
  //
  // Y CUALQUIER APP QUE PAGUE A UN YAPE. Prex, BBVA, el BCP… todas pagan a un
  // Yape, y ese dinero cae en la misma cuenta que un Yape directo: se concilia
  // igual. #KP136441 era un Prex con «Cuenta/billetera: Yape» rechazado por el
  // medio, y en producción había 43 así —30 validados a mano—. Lo que no se
  // sabe adónde fue sigue exigiendo que alguien mire.
  if (voucher.method === "otro" && !voucher.toYape) reasons.push("medio_no_aceptado");

  if (!voucher.recipientName) reasons.push("sin_destinatario");
  else if (!isExpectedRecipient(voucher.recipientName)) reasons.push("destinatario_distinto");

  if (voucher.amount == null) reasons.push("sin_monto");
  else if (expectedAmount != null && Math.abs(voucher.amount - expectedAmount) > AMOUNT_TOLERANCE) {
    reasons.push("monto_distinto");
  }

  // EL MISMO PAGO NO COBRA DOS PEDIDOS. Un comprobante perfecto —buen medio,
  // buena cuenta, buen monto— que ya se presentó en otra guía no es un cobro:
  // es el mismo dinero contado dos veces. Bloquea aunque todo lo demás cuadre,
  // y es el único motivo que además dispara aviso: los otros son un cobro mal
  // hecho, este es alguien presentando el mismo papel dos veces.
  if (duplicateOf.length) reasons.push("operacion_duplicada");

  if (!reasons.length) {
    return {
      state: "validado",
      reasons: [],
      summary: `${
        voucher.method === "otro" ? "Pago a su Yape desde otra app" : METHOD_LABEL[voucher.method]
      } a ${EXPECTED_RECIPIENT}${
        voucher.amount != null ? ` por S/ ${voucher.amount.toFixed(2)}` : ""
      }.`,
    };
  }

  const detail: string[] = [];
  if (reasons.includes("operacion_duplicada")) {
    // El nº y la otra guía, en el propio veredicto: es lo primero que necesita
    // quien lo revise, y sin ellos «duplicada» es una acusación sin respaldo.
    detail.push(
      `operación ${voucher.operationNumber ?? "?"} ya registrada en ${duplicateOf.join(", ")}`,
    );
  }
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
