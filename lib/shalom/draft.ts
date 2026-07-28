// Del pedido del Master al cuerpo que espera `POST /v1/orders`. Puro y testeado:
// es la capa donde se decide qué se despacha, a qué agencia y con qué clave, y
// equivocarse acá cuesta un paquete perdido o una clave que no abre nada.

import type {
  DeclaracionJurada,
  ShalomDocumentType,
  ShalomOrderPayload,
  ShalomPayer,
  ShalomReceiver,
} from "./types";

/**
 * Contenido declarado por defecto. La operación despacha ropa y accesorios; el
 * operador puede cambiarlo en el modal. No hay un default "seguro" acá: Shalom
 * lo imprime en la guía y una declaración falsa es problema del remitente.
 */
export const DEFAULT_DECLARACION: DeclaracionJurada = "ropa";

/**
 * Quién paga el flete. `sender` = la tienda paga al despachar. Es el default
 * porque en este sistema el cliente ya pagó el envío por Yape junto con el
 * producto (flujo de adelanto + diferencia): poner `receiver` le cobraría el
 * flete otra vez en la agencia.
 */
export const DEFAULT_PAYER: ShalomPayer = "sender";

// ---------------------------------------------------------------------------
// Clave de recojo
// ---------------------------------------------------------------------------

/** 4 dígitos iguales: 1111, 2222… Shalom los rechaza. */
function isRepeated(code: string): boolean {
  return /^(\d)\1{3}$/.test(code);
}

/** Escalera ascendente: 1234, 2345… 6789. Shalom los rechaza. */
function isAscending(code: string): boolean {
  for (let i = 1; i < code.length; i++) {
    if (code.charCodeAt(i) !== code.charCodeAt(i - 1) + 1) return false;
  }
  return true;
}

/** Escalera descendente: 4321. La documentación no la prohíbe, pero tampoco la
 *  promete: no se generan, aunque sí se aceptan si alguien la escribe. */
function isDescending(code: string): boolean {
  for (let i = 1; i < code.length; i++) {
    if (code.charCodeAt(i) !== code.charCodeAt(i - 1) - 1) return false;
  }
  return true;
}

/**
 * ¿Es una clave que Shalom va a aceptar? Se comprueba exactamente lo que la
 * documentación prohíbe — ni más ni menos. Rechazar de más bloquearía una clave
 * válida que el operador escribió a propósito.
 */
export function isValidPickupCode(code: string | null | undefined): boolean {
  const v = (code ?? "").trim();
  if (!/^\d{4}$/.test(v)) return false;
  return !isRepeated(v) && !isAscending(v);
}

/** Por qué no sirve esta clave, para decírselo al operador en una línea. */
export function pickupCodeError(code: string | null | undefined): string | null {
  const v = (code ?? "").trim();
  if (!/^\d{4}$/.test(v)) return "La clave de recojo son exactamente 4 dígitos.";
  if (isRepeated(v)) return "Shalom no acepta claves con los 4 dígitos iguales (1111, 2222…).";
  if (isAscending(v)) return "Shalom no acepta claves consecutivas (1234, 2345…).";
  return null;
}

/**
 * Clave nueva al azar, evitando también las descendentes: la documentación solo
 * prohíbe las ascendentes, pero una escalera es una escalera y no cuesta nada
 * saltársela. `rng` se inyecta para poder testear la generación.
 */
export function generatePickupCode(rng: () => number = Math.random): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const code = String(Math.floor(rng() * 10_000)).padStart(4, "0");
    if (isValidPickupCode(code) && !isDescending(code)) return code;
  }
  // Inalcanzable en la práctica (más del 99 % de los 10.000 códigos son
  // válidos), pero un fallo aquí no puede devolver una clave inválida.
  return "2415";
}

// ---------------------------------------------------------------------------
// Destinatario
// ---------------------------------------------------------------------------

/**
 * Teléfono como lo quiere Shalom: 9 dígitos locales, numérico y sin el 51.
 *
 * El sistema guarda "51981535978" (lib/phone.ts, para casar con Kapso) pero el
 * campo `phone` del destinatario es un `int` de 9 dígitos. Mandar el número con
 * prefijo haría que la agencia llame a un número que no existe.
 */
export function shalomPhone(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D+/g, "");
  d = d.replace(/^00+/, "");
  if (d.startsWith("51") && d.length === 11) d = d.slice(2);
  return /^9\d{8}$/.test(d) ? Number(d) : null;
}

/** Documento limpio, o null si no cumple el formato de su tipo. */
export function normalizeDocument(
  type: ShalomDocumentType,
  raw: string | null | undefined,
): string | null {
  const v = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!v) return null;
  if (type === "DNI") return /^\d{8}$/.test(v) ? v : null;
  if (type === "RUC") return /^\d{11}$/.test(v) ? v : null;
  // CE: alfanumérico de 4 o más.
  return /^[A-Z0-9]{4,}$/.test(v) ? v : null;
}

export function documentError(
  type: ShalomDocumentType,
  raw: string | null | undefined,
): string | null {
  if (!(raw ?? "").trim()) return "Falta el documento del destinatario.";
  if (normalizeDocument(type, raw)) return null;
  if (type === "DNI") return "El DNI son 8 dígitos.";
  if (type === "RUC") return "El RUC son 11 dígitos.";
  return "El carné de extranjería es alfanumérico de 4 caracteres o más.";
}

export interface SplitName {
  name: string;
  last_name: string;
  sur_name: string;
}

/**
 * Parte el nombre completo en nombre + dos apellidos, como los pide Shalom para
 * DNI/CE. Shopify entrega un solo campo ("MARIA GOMEZ TORRES") y la convención
 * peruana pone los dos apellidos AL FINAL, así que se toman los dos últimos
 * tokens y lo demás es el nombre.
 *
 * Es una heurística y falla con apellidos compuestos ("DE LA CRUZ"): por eso
 * los tres campos quedan editables en el modal, con esto solo como sugerencia.
 */
export function splitReceiverName(full: string | null | undefined): SplitName {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  const at = (i: number): string => parts[i] ?? "";
  if (parts.length === 0) return { name: "", last_name: "", sur_name: "" };
  if (parts.length === 1) return { name: at(0), last_name: "", sur_name: "" };
  if (parts.length === 2) return { name: at(0), last_name: at(1), sur_name: "" };
  return {
    name: parts.slice(0, -2).join(" "),
    last_name: at(parts.length - 2),
    sur_name: at(parts.length - 1),
  };
}

// ---------------------------------------------------------------------------
// Agencia de destino
// ---------------------------------------------------------------------------

/**
 * Texto con el que arrancar la búsqueda de agencia de destino. Se prefiere la
 * agencia que ya venía en el pedido (la que pidió el cliente, si un reporte o
 * el asesor la registró) y si no, la ubicación — de lo más específico a lo más
 * general, porque `/v1/agencies/search?q=` es texto libre.
 */
export function suggestedAgencyQuery(row: {
  agency_branch?: string | null;
  district?: string | null;
  province?: string | null;
  region?: string | null;
}): string {
  return (
    [row.agency_branch, row.district, row.province, row.region]
      .map((p) => (p ?? "").trim())
      .find(Boolean) ?? ""
  );
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface ShalomDraftInput {
  originTerminalId: number | null;
  destinyTerminalId: number | null;
  productId: number | null;
  quantity?: number;
  payer?: ShalomPayer;
  declaracionJurada?: DeclaracionJurada;
  documentType: ShalomDocumentType;
  document: string | null;
  /** Nombre, o razón social completa cuando el documento es RUC. */
  name: string | null;
  lastName?: string | null;
  surName?: string | null;
  /** Teléfono en el formato del sistema (normalizado, con 51 adelante). */
  phone: string | null;
  personId?: number | null;
  pickupCode: string | null;
  aereo?: boolean;
  /** Solo para el producto "Otra Medida". */
  dimensions?: { weight_kg: number; height_m: number; length_m: number; width_m: number } | null;
}

export type ShalomDraftResult =
  | { ok: true; payload: ShalomOrderPayload }
  | { ok: false; errors: string[] };

function positiveInt(v: number | null | undefined): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Arma el cuerpo del POST. Devuelve TODOS los errores juntos, no el primero: el
 * operador arregla la guía de una vez en vez de descubrir un campo por intento
 * — y cada intento fallido acá es un intento menos contra el rate limit.
 */
export function buildShalomOrderPayload(input: ShalomDraftInput): ShalomDraftResult {
  const errors: string[] = [];

  if (!positiveInt(input.originTerminalId)) {
    errors.push("Falta la agencia de origen (Ajustes → Tienda → Shalom).");
  }
  if (!positiveInt(input.destinyTerminalId)) {
    errors.push("Falta elegir la agencia de destino.");
  }
  if (input.originTerminalId && input.originTerminalId === input.destinyTerminalId) {
    errors.push("El origen y el destino son la misma agencia.");
  }
  if (!positiveInt(input.productId)) {
    errors.push("Falta elegir el tipo de paquete.");
  }

  const document = normalizeDocument(input.documentType, input.document);
  const docErr = documentError(input.documentType, input.document);
  if (docErr) errors.push(docErr);

  const isCompany = input.documentType === "RUC";
  const name = (input.name ?? "").trim();
  if (!name) {
    errors.push(isCompany ? "Falta la razón social del destinatario." : "Falta el nombre del destinatario.");
  }
  // Shalom solo exige los apellidos cuando la persona todavía no existe en la
  // cuenta, pero eso no se sabe desde acá — y mandarlos de más no molesta.
  const lastName = (input.lastName ?? "").trim();
  const surName = (input.surName ?? "").trim();
  if (!isCompany && !lastName) {
    errors.push("Falta el primer apellido del destinatario (Shalom lo exige para DNI y CE).");
  }

  const phone = shalomPhone(input.phone);
  if (!phone) {
    errors.push(
      `El teléfono no es un celular peruano de 9 dígitos${input.phone ? ` (${input.phone})` : ""}.`,
    );
  }

  const pickupErr = pickupCodeError(input.pickupCode);
  if (pickupErr) errors.push(pickupErr);

  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) errors.push("La cantidad de bultos no es válida.");

  if (errors.length > 0) return { ok: false, errors };

  const receiver: ShalomReceiver = {
    document_type: input.documentType,
    document: document as string,
    name,
    phone: phone as number,
  };
  // Los apellidos NO aplican a RUC: mandarlos ahí es contradecir el contrato.
  if (!isCompany) {
    receiver.last_name = lastName;
    if (surName) receiver.sur_name = surName;
  }
  if (positiveInt(input.personId)) receiver.id = input.personId as number;

  const payload: ShalomOrderPayload = {
    origin_terminal_id: input.originTerminalId as number,
    destiny_terminal_id: input.destinyTerminalId as number,
    product_id: input.productId as number,
    quantity,
    payer: input.payer ?? DEFAULT_PAYER,
    declaracion_jurada: input.declaracionJurada ?? DEFAULT_DECLARACION,
    receiver,
    pickup_code: (input.pickupCode as string).trim(),
  };
  if (input.aereo) payload.aereo = true;
  if (input.dimensions) payload.dimensions = input.dimensions;

  return { ok: true, payload };
}

/**
 * ¿Este producto necesita que el operador escriba las medidas? Shalom solo lo
 * pide para "Otra Medida"; para el resto usa las del catálogo.
 */
export function needsCustomDimensions(productTitle: string | null | undefined): boolean {
  return /otra\s*medida/i.test(productTitle ?? "");
}
/**
 * Estados en los que Shalom todavía deja borrar la orden: mientras el paquete no
 * haya llegado físicamente a la agencia.
 *
 * Se comprueba con NUESTRO estado antes de llamar, para no gastar una llamada ni
 * ofrecer un botón que va a fallar. Pero la palabra final es de Shalom: si su
 * reporte va con retraso, el paquete puede estar recibido sin que acá se sepa —
 * por eso el error de la API se muestra tal cual en vez de traducirlo a algo
 * tranquilizador.
 */
const CANCELABLE_PICKUP_STATES = new Set(["pendiente_de_envio"]);

export function shalomGuideIsCancelable(guide: {
  courier: string;
  delivery_status: string;
  pickup_state?: string | null;
  shalom_order_id?: number | null;
}): boolean {
  if (guide.courier !== "shalom") return false;
  // Sin `shalom_order_id` no hay nada que borrar por API: la guía llegó por el
  // reporte Excel y su vida la gobierna el panel de Shalom.
  if (!guide.shalom_order_id) return false;
  if (guide.delivery_status !== "pendiente") return false;
  return guide.pickup_state == null || CANCELABLE_PICKUP_STATES.has(guide.pickup_state);
}

/** Mínimo de un motivo de excepción. Corto de más es "ok" o ".", que no explica nada. */
export const MIN_OVERRIDE_REASON = 10;

/**
 * Frenos BLANDOS: deshabilitan el botón pero se pueden saltar dejando un motivo
 * escrito. No son `blockers` —esos son imposibles, como que el pedido ya tenga
 * guía— sino reglas de la operación que casi siempre valen y a veces no.
 *
 * El envío por Shalom se cobra con adelanto, así que sin comprobante cargado no
 * debería salir el paquete. Pero un bloqueo duro deja parado el caso legítimo
 * raro —el cliente que pagó completo de una, el adelanto que entró por otro
 * canal— y eso se nota el mismo día. El motivo escrito corta el descuido sin
 * cortar la excepción, y de paso mide cuántas veces pasa de verdad: si en un mes
 * no lo usa nadie, esto sube a bloqueo duro con datos en la mano.
 */
export function shalomSoftBlockers(paymentState: string | null): string[] {
  if (paymentState !== "sin_pago") return [];
  return [
    "No hay ningún comprobante de adelanto cargado. El envío por Shalom se cobra con adelanto: registra el Yape en «Pagos Yape y clave de recojo», o crea la guía igual explicando por qué.",
  ];
}
