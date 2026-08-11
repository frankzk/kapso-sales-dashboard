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

/** `created_via` de las salidas que nacen en el Master sin API de courier. */
export const MANUAL_ROUTE_CREATED_VIA = "mom_manual_route";

/**
 * ¿Se puede anular esta salida de ruta manual desde el Master?
 *
 * Existe porque el sistema sabía decir "anúlala antes de crear otra" sin tener
 * dónde anularla: el botón de «Salidas y guías» solo se pintaba para Shalom, y
 * ningún camino movía a `anulado` una salida de `mom_manual_route`. Una salida
 * creada por error —o con el courier equivocado— dejaba al pedido sin poder
 * emitir ninguna otra guía, y el pedido tampoco podía finalizarse, porque el
 * cierre exige que no queden salidas activas. Callejón sin salida por ambos
 * lados.
 *
 * ANULAR NO ES BORRAR. La fila se queda con su historial y su consecutivo: el
 * rótulo pudo haberse impreso y estar pegado a una caja, y ese número tiene que
 * seguir resolviendo —diciendo "anulada"— en vez de dar 404. El consecutivo
 * tampoco se reutiliza (§4).
 *
 * Solo alcanza a las salidas que Kapta creó como ruta manual. Aliclik, Shalom y
 * Tanders tienen su propia anulación, que además avisa al courier por API:
 * marcarlas acá dejaría la guía viva del otro lado y muerta en el panel.
 */
export function manualOutputIsCancelable(output: {
  courier: string;
  created_via?: string | null;
  delivery_status: string;
  custody_state?: string | null;
  custody_transferred_at?: string | null;
}): boolean {
  if (output.created_via !== MANUAL_ROUTE_CREATED_VIA) return false;
  // `pendiente` es el único estado que sigue siendo "esto todavía no pasó". Con
  // la salida en ruta, entregada o devuelta hay hechos físicos detrás y el
  // camino correcto es el retorno, no el borrón.
  if (output.delivery_status !== "pendiente") return false;
  // Mientras la caja siga en casa, anular corrige un registro. Una vez
  // transferida al motorizado hay un paquete en la calle: eso se cierra
  // recibiendo su retorno.
  if ((output.custody_state ?? "empresa") !== "empresa") return false;
  return !output.custody_transferred_at;
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
