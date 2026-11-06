// Del pedido del Master al cuerpo que espera `POST /v1/orders`. Puro y testeado:
// es la capa donde se decide qué se despacha, a qué agencia y con qué clave, y
// equivocarse acá cuesta un paquete perdido o una clave que no abre nada.

import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";
import type {
  DeclaracionJurada,
  ShalomDocumentType,
  ShalomOrderPayload,
  ShalomPayer,
  ShalomProduct,
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

/**
 * Tipo de paquete que debe aparecer seleccionado al abrir una guía.
 *
 * Algunas tiendas todavía conservan SOBRE como preferencia histórica. La
 * operación actual usa Caja Paquete XXS como punto de partida para todas las
 * guías; el selector sigue editable para las excepciones reales.
 */
export function preferredShalomProductId(
  products: readonly ShalomProduct[],
  fallback: number | null | undefined,
): number | null {
  const xxs = products.find(
    (product) => product.title.trim().toLocaleLowerCase("es-PE") === "caja paquete xxs",
  );
  return xxs?.id ?? fallback ?? null;
}

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
 * Años del calendario: 1900–2099. Shalom los rechaza «por seguridad», y no
 * estaba en su documentación — se supo por un 400 en producción con la clave
 * `1965`, que nos había tocado al azar.
 *
 * EL RANGO ES UNA INFERENCIA, no un dato: lo único comprobado es que 1965 se
 * rechaza. 1900–2099 es la lectura razonable de «parece un año» y cuesta 200 de
 * los 10.000 códigos posibles —un 2 %—, así que pasarse de ancho aquí no quita
 * nada. Si algún día rechazan uno fuera de este rango, se amplía.
 */
function looksLikeCalendarYear(code: string): boolean {
  const n = Number(code);
  return n >= 1900 && n <= 2099;
}

/**
 * ¿Es una clave que Shalom va a aceptar al CREAR una guía? Se comprueba lo que
 * sabemos que rechaza — ni más ni menos. Rechazar de más bloquearía una clave
 * válida que el operador escribió a propósito.
 */
export function isValidPickupCode(code: string | null | undefined): boolean {
  const v = (code ?? "").trim();
  if (!/^\d{4}$/.test(v)) return false;
  return !isRepeated(v) && !isAscending(v) && !looksLikeCalendarYear(v);
}

/** Por qué no sirve esta clave, para decírselo al operador en una línea. */
export function pickupCodeError(code: string | null | undefined): string | null {
  const formato = pickupCodeFormatError(code);
  if (formato) return formato;
  if (looksLikeCalendarYear((code ?? "").trim())) {
    return "Shalom no acepta claves que parezcan un año (1900–2099).";
  }
  return null;
}

/**
 * Lo mismo, pero para una clave que Shalom YA emitió: registro manual de una
 * guía hecha en mostrador.
 *
 * Aquí no se aplica la regla del año a propósito. Esa regla dice qué acepta
 * Shalom al crear; una clave que ya existe en su sistema no se puede rechazar
 * por nuestra inferencia de su regla — sería impedir que se registre un envío
 * real por una suposición nuestra.
 */
export function pickupCodeFormatError(code: string | null | undefined): string | null {
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
 * Lo que `buildShalomOrderPayload` exige, en una lista: TODOS los errores
 * juntos, no el primero, en el orden de los campos del modal (agencia,
 * documento, nombre, apellido, teléfono, paquete, bultos y la clave al final).
 *
 * Es la MISMA función para el servidor y para el modal (`shalomSubmitMissing`):
 * así lo que el botón dice que falta es exactamente lo que el servidor
 * rechazaría, y no pueden irse separando con el tiempo (#KP202968).
 *
 * `pickupCode` ausente (`undefined`) = no se revisa: el modal no conoce la
 * clave cuando el rol no puede verla, y el servidor la genera válida.
 */
export function shalomPayloadErrors(
  input: Omit<ShalomDraftInput, "pickupCode"> & { pickupCode?: string | null },
): string[] {
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

  const docErr = documentError(input.documentType, input.document);
  if (docErr) errors.push(docErr);

  const isCompany = input.documentType === "RUC";
  if (!(input.name ?? "").trim()) {
    errors.push(isCompany ? "Falta la razón social del destinatario." : "Falta el nombre del destinatario.");
  }
  // Shalom solo exige los apellidos cuando la persona todavía no existe en la
  // cuenta, pero eso no se sabe desde acá — y mandarlos de más no molesta.
  if (!isCompany && !(input.lastName ?? "").trim()) {
    errors.push("Falta el primer apellido del destinatario (Shalom lo exige para DNI y CE).");
  }

  const rawPhone = (input.phone ?? "").trim();
  if (!rawPhone) {
    errors.push("Falta el teléfono del destinatario.");
  } else if (!shalomPhone(rawPhone)) {
    errors.push(`El teléfono no es un celular peruano de 9 dígitos (${rawPhone}).`);
  }

  if (!positiveInt(input.productId)) {
    errors.push("Falta elegir el tipo de paquete.");
  }

  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) errors.push("La cantidad de bultos no es válida.");

  if (input.pickupCode !== undefined) {
    const pickupErr = pickupCodeError(input.pickupCode);
    if (pickupErr) errors.push(pickupErr);
  }

  return errors;
}

/**
 * Arma el cuerpo del POST. Devuelve TODOS los errores juntos, no el primero: el
 * operador arregla la guía de una vez en vez de descubrir un campo por intento
 * — y cada intento fallido acá es un intento menos contra el rate limit.
 */
export function buildShalomOrderPayload(input: ShalomDraftInput): ShalomDraftResult {
  const errors = shalomPayloadErrors(input);
  if (errors.length > 0) return { ok: false, errors };

  const document = normalizeDocument(input.documentType, input.document);
  const isCompany = input.documentType === "RUC";
  const name = (input.name ?? "").trim();
  const lastName = (input.lastName ?? "").trim();
  const surName = (input.surName ?? "").trim();
  const phone = shalomPhone(input.phone);
  const quantity = input.quantity ?? 1;

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

/**
 * De las salidas vivas del pedido, ¿cuál impide vincular esta guía externa?
 *
 * La vía de contingencia hereda la regla de la vía API —un pedido no puede
 * quedar con dos salidas vivas—, pero con un matiz que la vía API no tiene: el
 * formulario se puede reenviar para completar identificadores que faltaban, y
 * ese reenvío es idempotente por diseño. Si no se excluyera a sí misma, la
 * segunda pasada chocaría con la salida que ella misma creó.
 */
export function blockingActiveGuide<T extends { guide_code: string | null }>(
  active: readonly T[],
  guideCode: string,
): T | null {
  const own = guideCode.trim().toUpperCase();
  return active.find((g) => (g.guide_code ?? "").trim().toUpperCase() !== own) ?? null;
}

/**
 * Qué documento se manda al guardar el borrador de Shalom automáticamente.
 *
 * El paso «DNI y agencia» del panel de pagos se guarda solo, y eso obliga a
 * decidir qué pasa con un documento a medio teclear. El servidor valida el
 * documento con `documentError` y RECHAZA LA ESCRITURA ENTERA si no pasa, así
 * que mandar un DNI incompleto impediría guardar la AGENCIA, que no tiene nada
 * que ver con él.
 *
 * Las tres respuestas, y por qué:
 *
 *   - VACÍO → `null`. Vaciar el campo es una decisión, igual que quitar la
 *     agencia: si se conservara lo anterior, borrarlo sería imposible.
 *   - VÁLIDO → lo escrito. El caso normal.
 *   - INVÁLIDO → lo último guardado. No se pisa un dato bueno con uno a medias,
 *     y el campo lo guardará solo en cuanto termine de escribirse.
 */
export function shalomDraftDocumentToSave(
  typed: string,
  typedIsValid: boolean,
  saved: string | null,
): string | null {
  const value = typed.trim();
  if (!value) return null;
  return typedIsValid ? value : saved;
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
  // Cargar una imagen no confirma que el dinero haya llegado. El rótulo se
  // habilita cuando el adelanto mínimo ya fue validado; una diferencia cargada
  // también implica que ese primer adelanto pasó la validación.
  if (["adelanto_validado", "diferencia_cargada", "pago_completo"].includes(paymentState ?? "")) {
    return [];
  }
  return [
    `El adelanto mínimo todavía no está validado. El envío por Shalom requiere ${ADELANTO_MINIMO_LABEL} validados antes de generar la guía, o una excepción con motivo.`,
  ];
}

/**
 * ¿Se puede pedir vía aérea para esta ruta?
 *
 * `aereo` en la agencia dice que ELLA tiene servicio aéreo, no que lo tenga
 * desde donde despachamos: Shalom publica en `origenes_aereos` la lista de
 * agencias de origen con vuelo hasta ella, y esa lista es la que manda. Ofrecer
 * la casilla sin mirarla sería invitar a marcar algo que la API va a rechazar —
 * o peor, a que el paquete salga por una vía que no existe.
 *
 * `unknown` no es un error: la búsqueda de agencias no siempre devuelve esas
 * listas. En ese caso se deja elegir y no se afirma nada, porque impedirlo por
 * falta de dato sería bloquear un envío legítimo con una excusa.
 *
 * Por lo mismo, «Shalom dice que no vuela» y «no tenemos el dato» NO son lo
 * mismo y no se resuelven igual. Cuando la agencia llega sin el campo —porque
 * la reconstruimos de lo guardado en vez de traerla del directorio— ocultar la
 * casilla convierte una laguna nuestra en un «no se puede», y quien despacha a
 * Iquitos se queda sin la única vía que existe. Falta el dato ⇒ `unknown`.
 */
export type AirRoute =
  | { offered: false }
  | { offered: true; fromOrigin: "yes" | "no" | "unknown" };

export function shalomAirRoute(
  agency: { aereo?: boolean | null; origenes_aereos?: number[] | null } | null | undefined,
  originTerminalId: number | null | undefined,
): AirRoute {
  if (!agency) return { offered: false };
  // `undefined` es la ausencia del campo; `false`/`null` es Shalom respondiendo
  // que esa agencia no vuela. Solo lo segundo esconde la casilla.
  if (agency.aereo === undefined) return { offered: true, fromOrigin: "unknown" };
  if (!agency.aereo) return { offered: false };
  const origins = agency.origenes_aereos;
  if (!Array.isArray(origins) || !origins.length) return { offered: true, fromOrigin: "unknown" };
  if (!positiveInt(originTerminalId)) return { offered: true, fromOrigin: "unknown" };
  return {
    offered: true,
    fromOrigin: origins.includes(originTerminalId as number) ? "yes" : "no",
  };
}

/**
 * ¿La casilla «vía aérea» empieza marcada? (decisión del owner, 03-11-2026)
 *
 * Todo va por aire si se puede. Antes la casilla nacía vacía a propósito,
 * porque el aéreo encarece el envío y se quería que lo decidiera quien
 * despacha; el owner decidió lo contrario: por defecto aéreo, y quien despacha
 * la desmarca para una excepción.
 *
 * «Si se puede» es lo que dice `shalomAirRoute`:
 *   - La agencia no vuela → no hay casilla, va por tierra.
 *   - Vuela, pero no desde nuestra agencia de origen (`no`) → la casilla está
 *     bloqueada y marcarla sería pedir una ruta que no existe: tierra.
 *   - Vuela desde nuestro origen (`yes`) → marcada.
 *   - No consta (`unknown`) → marcada. «Todo» incluye lo que no se pudo
 *     confirmar; si Shalom rechaza la ruta al crear, el error lo dice y se
 *     desmarca. Dejarla vacía ahí convertiría una laguna del directorio en un
 *     envío por tierra que nadie eligió.
 */
export function defaultAirChoice(route: AirRoute): boolean {
  return route.offered && route.fromOrigin !== "no";
}

/**
 * ¿Shalom rechazó la guía porque no hay vuelo en esa ruta? (04-11-2026)
 *
 * Con la vía aérea marcada por defecto, la ruta que el directorio no aclara
 * (`unknown`) sale marcada, y si Shalom no vuela ahí la creación vuelve con
 *   400 «envío aéreo no disponible: No se permite servicio aéreo entre el
 *   origen y destino seleccionado».
 * Pasó con #KP202237 (Pangoa, Junín) desde Breña. Ese 400 NO crea preguía: es
 * Shalom contestando por fin lo que el directorio no dijo, y el modal lo toma
 * como un «no» firme para esa agencia (`fromOrigin: "no"`).
 */
export function isShalomAirRouteRejection(message: string | null | undefined): boolean {
  const m = message ?? "";
  return /a[ée]reo no disponible/i.test(m) || /no se permite servicio a[ée]reo/i.test(m);
}

/** La ruta que manda: la del directorio, salvo que Shalom ya dijera que no vuela. */
export function effectiveAirRoute(route: AirRoute, rejectedByShalom: boolean): AirRoute {
  return rejectedByShalom && route.offered ? { offered: true, fromOrigin: "no" } : route;
}

// ---------------------------------------------------------------------------
// Sesión, avisos y «por qué no se puede pulsar» (06-11-2026, #KP202968)
// ---------------------------------------------------------------------------

/**
 * ¿El token de sesión sigue vivo? Con margen, para no mandarlo justo al vencer.
 *
 * Vive aquí —y `client.ts` lo re-exporta— porque el modal también lo necesita:
 * la sesión dura 2 h y el modal puede quedarse abierto más que eso. `client.ts`
 * es solo de servidor; este archivo es puro y se puede importar en el cliente.
 */
export function sessionIsFresh(expiresAt: string | null | undefined, skewMs = 120_000): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms - skewMs > Date.now();
}

/**
 * Milisegundos hasta que `sessionIsFresh` pase a `false` (0 si ya pasó).
 *
 * Se calcula EN EL SERVIDOR, con su reloj, y viaja al modal como una duración
 * (`sessionMsLeft`). El modal no compara `shalom_session_expires_at` con su
 * propio `Date.now()`: con el reloj del equipo adelantado, la sesión se daba
 * por vencida antes de tiempo —o nunca por viva— y «Conectar con Shalom»
 * devolvía la misma hora de la caché sin arreglar nada.
 */
export function msUntilSessionStale(
  expiresAt: string | null | undefined,
  skewMs = 120_000,
  now: number = Date.now(),
): number {
  if (!expiresAt) return 0;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, ms - skewMs - now);
}

/**
 * Cuándo vence la sesión en el reloj DEL NAVEGADOR: la duración que dio el
 * servidor, contada desde que llegó. Un reloj desfasado no la mueve, porque
 * solo se mide cuánto tiempo pasa en él, no qué hora marca. Null = sin sesión.
 */
export function sessionStaleAt(msLeft: number | null | undefined, receivedAt: number): number | null {
  if (typeof msLeft !== "number" || !Number.isFinite(msLeft) || msLeft <= 0) return null;
  return receivedAt + msLeft;
}

/** El máximo que acepta `setTimeout`: con más, dispara al instante. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Cuánto esperar antes de volver a mirar si venció (0 = ya venció). Acotado a
 * `MAX_TIMER_MS`: si el plazo es más largo, el modal espera eso y vuelve a
 * preguntar.
 */
export function sessionTimerDelay(staleAt: number, now: number): number {
  return Math.min(MAX_TIMER_MS, Math.max(0, staleAt - now));
}

/** Comprobante cargado que nadie validó todavía: lo frena el freno blando. */
const COMPROBANTE_SIN_VALIDAR = new Set(["adelanto_cargado", "pago_total_cargado", "posible_duplicado"]);

/**
 * Los avisos ámbar del modal: lo que hay que mirar o hacer, nunca una
 * confirmación (DESIGN.md: ámbar es para motivos de bloqueo y cosas por hacer).
 *
 * Con un bloqueo duro (`blocked`: guía activa, pedido cerrado, falta
 * configuración, lista de pago adelantado) no sale ninguno: el aviso rojo es lo
 * único que importa y cualquier otra cosa al lado se lee como «sí se puede».
 *
 * En #KP202968 tres avisos seguidos —uno de ellos falso, otro que decía «se
 * puede crear igual» en el color de los bloqueos— se leyeron como «no me deja
 * registrar».
 */
export function shalomDraftWarnings(input: {
  paymentState: string | null;
  prefilledDocument: string | null;
  prefilledTerminalName: string | null;
  /** Hay `blockers`: la guía no se puede crear por API. */
  blocked: boolean;
}): string[] {
  if (input.blocked) return [];
  const warnings: string[] = [];

  // Shalom identifica al destinatario por documento y Shopify no pide DNI. Solo
  // se avisa si NADIE lo dejó apuntado: con el DNI ya en «DNI y agencia Shalom»
  // el aviso decía «el pedido no lo trae» encima de un campo ya lleno.
  if (!input.prefilledDocument) {
    warnings.push(
      "Shalom exige el documento del destinatario y el pedido no lo trae: pídeselo al cliente antes de crear la guía.",
    );
  }

  // El pago, solo cuando hay algo que HACER. Sin pago lo dice el freno blando;
  // con el adelanto validado no hay nada que avisar (si la nota pide cobrar
  // por adelantado, lo responde `shalomNotePaymentLine`, en verde). Con un
  // comprobante cargado sin validar el freno blando también está, en rojo, y
  // este aviso dice las dos salidas: decir «la guía se puede crear igual» al
  // lado del recuadro rojo era otra nota que contradecía al botón.
  if (COMPROBANTE_SIN_VALIDAR.has(input.paymentState ?? "")) {
    warnings.push(
      "Hay un comprobante cargado sin validar: valídalo en Cobro o escribe el motivo en el recuadro rojo para crearla igual. La clave de recojo espera al pago completo.",
    );
  }

  if (input.prefilledDocument) {
    warnings.push(
      // Ya no solo desde el registro del pago: en un pedido pagado por web se
      // apuntan en «DNI y agencia Shalom» de la tarjeta de Cobro.
      `El documento y la agencia venían apuntados en «DNI y agencia Shalom» (${input.prefilledDocument}${input.prefilledTerminalName ? ` · ${input.prefilledTerminalName}` : ""}). Verifícalos antes de crear.`,
    );
  }
  return warnings;
}

function solesLabel(amount: number): string {
  return `S/ ${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

/**
 * Línea en verde (`ok`) bajo «Nota del pedido» cuando el cobro ya cumple lo
 * que pide Shalom. Es la ÚNICA confirmación del pago en el modal.
 *
 * La nota se muestra tal cual y no se oculta: puede traer el DNI, la agencia o
 * cualquier otra cosa. Pero COD Core escribe «Sin contra entrega en su
 * distrito: pedir el pago por adelantado antes de despachar.» y, con el
 * adelanto ya validado, esa frase se leyó como un pendiente (#KP202968).
 *
 * Null —no se afirma nada— si falta el adelanto (freno blando) o si hay un
 * bloqueo duro (`blocked`): con la lista de pago adelantado o una guía activa,
 * «eso ya se cumplió» sería una promesa que el servidor no cumple.
 */
export function shalomNotePaymentLine(
  paymentState: string | null,
  validatedAmount: number | null | undefined,
  blocked: boolean,
): string | null {
  if (blocked) return null;
  if (shalomSoftBlockers(paymentState).length > 0) return null;
  const amount =
    typeof validatedAmount === "number" && Number.isFinite(validatedAmount) && validatedAmount > 0
      ? ` (${solesLabel(validatedAmount)})`
      : "";
  if (paymentState === "pago_completo") {
    return `El pago completo ya está validado${amount}: si la nota pide cobrar por adelantado, eso ya se cumplió.`;
  }
  return `El adelanto ya está validado${amount}: si la nota pide cobrar por adelantado, eso ya se cumplió. La clave de recojo se entrega cuando el pago completo esté validado.`;
}

export interface ShalomSubmitState {
  /** El borrador del servidor ya cargó. */
  loaded: boolean;
  blockers: readonly string[];
  softBlockers: readonly string[];
  overrideReason: string;
  /** Hay token vigente (según la duración que dio el servidor). */
  sessionReady: boolean;
  /** Hubo token en este modal y ya venció (o Shalom lo rechazó). */
  sessionExpired: boolean;
  originTerminalId: number | null;
  /** La agencia elegida, o null. */
  destinyTerminalId: number | null;
  productId: number | null;
  /** Los bultos tal como se van a mandar. */
  quantity: number;
  documentType: ShalomDocumentType;
  document: string;
  name: string;
  lastName: string;
  phone: string;
  /** Error de la clave de recojo, solo si el rol la ve y la escribió. */
  pickupCodeError: string | null;
  pending: boolean;
  created: boolean;
}

/** La razón única cuando hay un bloqueo duro: los detalles ya están en rojo arriba. */
export const SUBMIT_BLOCKED_REASON = "No se puede crear por API: mira el aviso rojo de arriba.";

/**
 * Por qué «Crear guía» no se puede pulsar todavía, una razón por condición.
 *
 * ES la condición del botón: el modal habilita «Crear guía» si y solo si esto
 * devuelve `[]`. Antes el botón tenía su propia lista de doce condiciones y
 * ninguna se decía en pantalla: en #KP202968 la operadora veía el botón gris
 * debajo de tres avisos ámbar y concluyó que el adelanto «no la dejaba».
 *
 * - Con un bloqueo duro, una sola razón que remite al aviso rojo: conectar o
 *   llenar el formulario no sirve de nada, y repetir el párrafo rojo en la
 *   lista es ruido en un teléfono.
 * - Si no, en el orden de la pantalla, de arriba abajo: el motivo del freno
 *   blando (el recuadro rojo de arriba), la sesión y lo que exige el servidor
 *   (`shalomPayloadErrors`, la misma función que usa `buildShalomOrderPayload`),
 *   y la clave de recojo al final.
 */
export function shalomSubmitMissing(s: ShalomSubmitState): string[] {
  if (!s.loaded) return ["Cargando el pedido…"];
  if (s.created) return ["La guía ya se creó."];
  if (s.pending) return ["Creando la guía…"];
  if (s.blockers.length > 0) return [SUBMIT_BLOCKED_REASON];

  const missing: string[] = [];

  if (s.softBlockers.length > 0 && s.overrideReason.trim().length < MIN_OVERRIDE_REASON) {
    missing.push(
      `Falta el motivo para crearla sin el adelanto validado (al menos ${MIN_OVERRIDE_REASON} caracteres, en el recuadro rojo de arriba).`,
    );
  }

  if (!s.sessionReady) {
    missing.push(
      s.sessionExpired
        ? "La sesión de Shalom venció: vuelve a conectar (pulsa «Conectar con Shalom»)."
        : "Falta conectar con Shalom (pulsa «Conectar con Shalom»).",
    );
  }

  missing.push(
    ...shalomPayloadErrors({
      originTerminalId: s.originTerminalId,
      destinyTerminalId: s.destinyTerminalId,
      productId: s.productId,
      quantity: s.quantity,
      documentType: s.documentType,
      document: s.document,
      name: s.name,
      lastName: s.lastName,
      phone: s.phone,
    }),
  );

  if (s.pickupCodeError) missing.push(`La clave de recojo no es válida: ${s.pickupCodeError}`);
  return missing;
}
