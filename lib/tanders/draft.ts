// Del pedido del Master al cuerpo que espera Tanders. Puro y testeado: es la
// capa donde se decide qué se despacha y por cuánto, y equivocarse acá cuesta un
// paquete o un cobro mal hecho.

import type { TandersOrderPayload, TandersPackageType } from "./types";

/**
 * Caja y peso por defecto. La operación despacha siempre XXS con 100 g
 * declarados (decisión del equipo, no un límite de Tanders): el catálogo no
 * tiene pesos por producto, así que cualquier cálculo sería inventado. El tipo
 * queda parametrizado para cuando esos pesos existan.
 */
export const DEFAULT_PACKAGE_TYPE: TandersPackageType = "XXS";
export const DEFAULT_WEIGHT_GRAMS = 100;

export interface TandersOrigin {
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface TandersDraftInput {
  origin: TandersOrigin;
  /** Dirección de destino tal como se confirmó en el mapa. */
  destination: string | null;
  destinationLat: number | null;
  destinationLng: number | null;
  recipientName: string | null;
  /** Teléfono en el formato del sistema (normalizado, con 51 adelante). */
  recipientPhone: string | null;
  collectionAmount: number | null;
  note?: string | null;
  packageType?: TandersPackageType;
  weightGrams?: number;
}

export type TandersDraftResult =
  | { ok: true; payload: TandersOrderPayload }
  | { ok: false; errors: string[] };

/**
 * Teléfono como lo quiere Tanders: 9 dígitos locales, sin el 51.
 *
 * El sistema guarda "51981535978" (lib/phone.ts, para casar con Kapso) pero el
 * formulario de Tanders recibe "981535978". Mandar el número con prefijo haría
 * que el repartidor marque un número que no existe.
 */
export function tandersPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D+/g, "");
  d = d.replace(/^00+/, "");
  if (d.startsWith("51") && d.length === 11) d = d.slice(2);
  return /^9\d{8}$/.test(d) ? d : null;
}

/**
 * Cuánto cobrar al destinatario. Un pedido ya cobrado por Yape va en 0: si se
 * manda el total, el repartidor le cobra al cliente algo que ya pagó.
 */
export function defaultCollectionAmount(input: {
  paymentState: string | null | undefined;
  orderTotal: number | null | undefined;
}): number {
  if (input.paymentState === "pago_completo") return 0;
  const total = input.orderTotal ?? 0;
  return total > 0 ? Math.round(total * 100) / 100 : 0;
}

/** Dirección de destino sugerida cuando el equipo todavía no confirmó una. */
export function suggestedDestination(row: {
  address: string | null;
  district: string | null;
  region: string | null;
}): string {
  return [row.address, row.district, row.region, "Perú"]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

/** Coordenada válida y dentro del planeta (un 0/0 casi siempre es un campo vacío). */
function validCoord(v: number | null | undefined, max: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v !== 0 && Math.abs(v) <= max;
}

/**
 * Arma el cuerpo del POST. Devuelve TODOS los errores juntos, no el primero: el
 * operador arregla la guía de una vez en vez de descubrir un campo por intento.
 */
export function buildTandersPayload(input: TandersDraftInput): TandersDraftResult {
  const errors: string[] = [];

  const origin = (input.origin.address ?? "").trim();
  if (!origin) errors.push("Falta la dirección de origen de la tienda (Ajustes → Tanders).");
  if (!validCoord(input.origin.lat, 90) || !validCoord(input.origin.lng, 180)) {
    errors.push("Faltan las coordenadas del almacén de origen (Ajustes → Tanders).");
  }

  const destination = (input.destination ?? "").trim();
  if (!destination) errors.push("Falta la dirección de destino.");
  if (!validCoord(input.destinationLat, 90) || !validCoord(input.destinationLng, 180)) {
    errors.push("Falta el punto en el mapa del destino: Tanders no acepta solo la dirección.");
  }

  const recipientFullName = (input.recipientName ?? "").trim();
  if (!recipientFullName) errors.push("Falta el nombre del destinatario.");

  const recipientPhone = tandersPhone(input.recipientPhone);
  if (!recipientPhone) {
    errors.push(
      `El teléfono no es un celular peruano de 9 dígitos${input.recipientPhone ? ` (${input.recipientPhone})` : ""}.`,
    );
  }

  const amount = input.collectionAmount ?? 0;
  if (!Number.isFinite(amount) || amount < 0) errors.push("El monto a cobrar no es válido.");

  const weightGrams = input.weightGrams ?? DEFAULT_WEIGHT_GRAMS;
  if (!Number.isFinite(weightGrams) || weightGrams <= 0) errors.push("El peso no es válido.");

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    payload: {
      packageType: input.packageType ?? DEFAULT_PACKAGE_TYPE,
      weightGrams,
      origin,
      // Origen como string y destino como número: así lo manda su propio
      // frontend. Ver el comentario en types.ts.
      originLat: String(input.origin.lat),
      originLng: String(input.origin.lng),
      destination,
      destinationLat: input.destinationLat as number,
      destinationLng: input.destinationLng as number,
      recipientFullName,
      recipientPhone: recipientPhone as string,
      note: (input.note ?? "").trim(),
      collectionAmount: Math.round(amount * 100) / 100,
    },
  };
}
