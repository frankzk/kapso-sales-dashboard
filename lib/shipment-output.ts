// Identidad humana de una salida física del MOM.
// El QR usa un token opaco de base de datos; este código es la etiqueta legible
// que permite al equipo hablar de "la salida 2" sin confundirla con el pedido.

export const MAX_OUTPUTS_PER_ORDER = 5;

/**
 * Courier de una salida que todavía no se decidió (MOM §4).
 *
 * La identidad de una salida es `pedido + consecutivo` (`KP123-S02`) y el QR es
 * un token opaco: el courier es un **metadato visible**, no parte de la
 * identidad. Por eso el almacén puede armar y rotular el paquete antes de saber
 * con quién sale, y el courier se fija cuando la caja entra a la ruta de un
 * courier concreto — que es cuando la decisión ocurre de verdad.
 */
export const COURIER_TBD = "por_definir";

export function isCourierTbd(courier: string | null | undefined): boolean {
  return (courier ?? "").trim().toLowerCase() === COURIER_TBD;
}

/** `#KP123` → `KP123`; conserva letras/números/guiones y elimina ruido. */
export function normalizeOrderCode(orderName: string | null | undefined): string {
  return (orderName ?? "")
    .trim()
    .replace(/^#+/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "")
    .replace(/_+/g, "-");
}

/** Código estable de salida, sin courier: `KP123-S02`. */
export function buildOutputCode(
  orderName: string | null | undefined,
  outputNumber: number | null | undefined,
): string {
  const order = normalizeOrderCode(orderName);
  const number = Math.trunc(outputNumber ?? 0);
  if (!order || number < 1) return "";
  return `${order}-S${String(number).padStart(2, "0")}`;
}

/**
 * Etiqueta operativa: `KP123-S02-SWAYP`. No es el payload del QR.
 *
 * Una salida sin courier decidido se queda en `KP123-S02`: añadir un sufijo
 * "POR-DEFINIR" ensuciaría el código con algo que además va a cambiar.
 */
export function outputDisplayCode(
  outputCode: string | null | undefined,
  courier: string | null | undefined,
): string {
  const base = (outputCode ?? "").trim().toUpperCase();
  if (!base) return "";
  if (isCourierTbd(courier)) return base;
  const courierCode = (courier ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return courierCode ? `${base}-${courierCode}` : base;
}

/** La regla es por pedido y operación, no solo por nombre del courier. */
export function canRepeatCourier(input: {
  courier: string;
  operation: "lima" | "provincia_cod" | "agencia" | "desconocida";
  priorOutputsWithCourier: number;
  totalOutputs: number;
}): { allowed: boolean; reason: "ok" | "max_outputs" | "courier_already_used" } {
  if (input.totalOutputs >= MAX_OUTPUTS_PER_ORDER) {
    return { allowed: false, reason: "max_outputs" };
  }
  if (input.priorOutputsWithCourier <= 0) return { allowed: true, reason: "ok" };

  const courier = input.courier.trim().toLowerCase();
  if (courier === "axel" || courier === "axel courier" || courier === "propio" || courier === "motorizado propio") {
    return { allowed: true, reason: "ok" };
  }
  // Swayp se puede repetir en Reproprovincia, pero solo una vez en Lima.
  if ((courier === "swayp" || courier === "fenix") && input.operation === "provincia_cod") {
    return { allowed: true, reason: "ok" };
  }
  const oneUse = new Set(["swayp", "fenix", "urpi", "tanders"]);
  if (oneUse.has(courier)) return { allowed: false, reason: "courier_already_used" };

  // Aliclik y cualquier courier nuevo permanecen habilitados hasta que exista
  // una política acordada; Fase 1 no debe inventar un bloqueo comercial.
  return { allowed: true, reason: "ok" };
}
