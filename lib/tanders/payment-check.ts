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
  medio_no_aceptado: "El medio de pago no es Yape, Plin ni transferencia BCP",
  destinatario_distinto: "El pago NO va a Grupo GF SAC",
  monto_distinto: "El monto no coincide con el de la guía",
  sin_destinatario: "No se pudo leer a quién se pagó",
  sin_monto: "No se pudo leer el monto",
  operacion_duplicada: "Este comprobante YA se usó en otra guía",
};

/** A quién tiene que ir el dinero. Igual que en lib/vision.ts. */
export const EXPECTED_RECIPIENT = "Grupo GF SAC";

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
 * El nº de operación, listo para comparar: solo letras y dígitos, en
 * mayúsculas.
 *
 * SE GUARDA ASÍ, no solo se compara así. Es la clave con la que se detecta un
 * comprobante reusado, y dos transcripciones del mismo pago («86 480 816» y
 * «864-808-16») tienen que colisionar o la detección no sirve.
 *
 * NUNCA como número: Yape los emite con ceros a la izquierda («06420756») y
 * convertirlos a entero los perdería, haciendo colisionar operaciones
 * distintas y —peor— dejando pasar la de verdad repetida.
 *
 * Su LÍMITE: quita separadores, no etiquetas. Si el lector devolviera «N°
 * 86480816» quedaría «N86480816» y no chocaría con «86480816». No se arregla
 * acá a propósito —recortar letras del principio rompería un código BCP
 * alfanumérico legítimo— sino en el origen: el prompt le pide explícitamente
 * el código a secas. Ver lib/tanders/payment-vision.ts.
 */
export function normalizeOperationNumber(raw: string | null | undefined): string | null {
  const texto = raw ?? "";
  // UNA LECTURA TRUNCADA NO ES UNA CLAVE. En las constancias reales aparecieron
  // «202609...495099» y «2026...675»: el modelo elidió el medio en vez de
  // devolver null. Quitarle los puntos daría «202609495099», un número que no
  // existe — y compararlo podría tanto acusar en falso como tapar el duplicado
  // de verdad. Vale más no tener dato que tener uno inventado.
  if (/…|\.{2,}/.test(texto)) return null;
  const clean = texto.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean || null;
}

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
  if (voucher.method === "otro") reasons.push("medio_no_aceptado");

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
      summary: `${METHOD_LABEL[voucher.method]} a ${EXPECTED_RECIPIENT}${
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
