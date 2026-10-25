// Del pedido del Master al cuerpo que espera Tanders. Puro y testeado: es la
// capa donde se decide qué se despacha y por cuánto, y equivocarse acá cuesta un
// paquete o un cobro mal hecho.

import type { TandersOrderPayload, TandersPackageType } from "./types";
import { isLimaMetropolitanaOrCallao, isNonMetroLimaLocation } from "@/lib/order-coverage";
import { expectedCollectAmount } from "@/lib/order-paid";
import type { PaymentGateway } from "@/lib/payment-gateway";
import type { LabelLineItem } from "@/lib/labels/line-items";
import { primaryYape, type PaymentMethod } from "@/lib/payment-methods";

/**
 * Caja y peso por defecto. La operación despacha siempre XXS con 100 g
 * declarados (decisión del equipo, no un límite de Tanders): el catálogo no
 * tiene pesos por producto, así que cualquier cálculo sería inventado. El tipo
 * queda parametrizado para cuando esos pesos existan.
 */
export const DEFAULT_PACKAGE_TYPE: TandersPackageType = "XXS";
export const DEFAULT_WEIGHT_GRAMS = 100;

/** Tanders es una ruta exclusiva de Lima. Cuando la cobertura materializada
 * existe se usa como fuente de verdad; el cálculo geográfico queda como
 * respaldo para filas históricas todavía no recalculadas. */
export function tandersCoverageEligible(input: {
  coverage?: string | null;
  storeId: string;
  orgId?: string | null;
  region: string | null;
  province: string | null;
  district: string | null;
}): boolean {
  // Antes de mirar `coverage`: las nueve provincias del departamento de Lima no
  // son Tanders, y el campo materializado puede decir "lima" desde antes de que
  // se corrigiera la clasificación. Fiarse de él ofrecería reparto de Lima para
  // Barranca o Huaura.
  if (isNonMetroLimaLocation(input)) return false;
  if (input.coverage) return input.coverage === "lima";
  return isLimaMetropolitanaOrCallao(input);
}

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
 * Cuánto cobrar al destinatario. Un pedido ya cobrado va en 0: si se manda el
 * total, el repartidor le cobra al cliente algo que ya pagó.
 *
 * «Ya cobrado» son DOS vías —comprobantes Yape y pago en el checkout— y la
 * decisión vive entera en `expectedCollectAmount`. Antes esto solo miraba el
 * estado de los comprobantes, así que un pedido pagado con tarjeta (que no tiene
 * ninguna fila en `order_payments`) salía con el total a cobrar.
 */
export function defaultCollectionAmount(input: {
  paymentState: string | null | undefined;
  orderTotal: number | null | undefined;
  financialStatus?: string | null;
  totalRefunded?: number | null;
  /** Solo la pasarela confirmada del checkout cuenta como pago web (0153). */
  paymentGateway?: PaymentGateway | null;
}): number {
  return expectedCollectAmount(
    {
      paymentState: input.paymentState,
      financialStatus: input.financialStatus,
      totalRefunded: input.totalRefunded,
      paymentGateway: input.paymentGateway,
    },
    input.orderTotal,
  );
}

/** Dirección de destino sugerida cuando el equipo todavía no confirmó una. */
// `address` es opcional a propósito: el LISTADO del Master no la trae (solo el
// detalle), así que el tipo de fila la declara opcional. El cuerpo ya tolera
// ausente igual que vacía, y así el llamador no tiene que fingir un null.
export function suggestedDestination(row: {
  address?: string | null;
  district?: string | null;
  region?: string | null;
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

/**
 * Nota que va en la guía: la referencia de la dirección primero y, a
 * continuación, la nota que el equipo escribió en el pedido de Shopify.
 *
 * Son dos campos distintos y ninguno reemplaza al otro. La referencia viene del
 * formulario COD ("entre tal y tal avenida"); la nota del pedido es donde el
 * equipo apunta a mano lo que averiguó al llamar —el enlace de Google Maps del
 * cliente, un horario, una advertencia—. Mandar solo la primera deja al
 * repartidor sin la mitad de lo que se sabe del destino.
 *
 * Si una repite a la otra se manda una sola vez: en las guías la nota se lee de
 * un vistazo y el texto duplicado hace perder el dato que importa.
 *
 * Debajo, el pedido y lo que lleva, y aparte los datos de cobro (25-10-2026):
 *
 *   Entre av el parral y Av carabayllo
 *   #KP143912
 *   X3 Magnesio 12 en 1 Complex – … – SuperHuman™
 *
 *   Datos de cobro:
 *   • Yape: 930555309
 *   • BCP Cta: 1912434540012
 *
 * Es el formato que el equipo tecleaba a mano en cada guía; ahora llega
 * precargado y el operador solo lo corrige si hace falta.
 */
export function composeTandersNote(input: {
  reference: string | null | undefined;
  shopifyNote: string | null | undefined;
  /** «#KP143912». Lo que el almacén y Tanders buscan para cruzar la caja. */
  orderName?: string | null;
  items?: readonly LabelLineItem[];
  /** Cuentas de la tienda. Solo se pasan si la guía cobra: pagado no las lleva. */
  paymentMethods?: readonly PaymentMethod[] | null;
}): string {
  const head = composeReferenceNote(input.reference, isKapsoAutoNote(input.shopifyNote) ? null : input.shopifyNote);
  const order = [input.orderName?.trim() ?? "", ...(input.items ?? []).map(tandersItemLine)].filter(Boolean);
  const payment = tandersPaymentBlock(input.paymentMethods ?? []);
  // El bloque de cobro va separado por una línea en blanco, como en los rótulos
  // que el equipo escribía a mano: se lee aparte de lo que va en la caja.
  return [[head, ...order].filter(Boolean).join("\n"), payment].filter(Boolean).join("\n\n");
}

/**
 * La nota que escribe Kapso al crear el pedido por WhatsApp («Pedido
 * WhatsApp/Kapso · Contraentrega…», «Pedido creado desde WhatsApp/Kapso.») es
 * un resumen automático: productos, contacto, dirección y referencia, todo lo
 * que la guía ya lleva en sus propios campos. En la guía solo duplicaba, y el
 * equipo la borraba a mano cada vez (#KP143995, 25-10-2026).
 */
export function isKapsoAutoNote(note: string | null | undefined): boolean {
  return /^\s*Pedido (creado desde )?WhatsApp\/Kapso\b/i.test(note ?? "");
}

/** «X3 Magnesio 12 en 1 Complex…», con la variante si el producto la tiene. */
function tandersItemLine(item: LabelLineItem): string {
  return `X${item.quantity} ${item.name}${item.variant ? ` (${item.variant})` : ""}`;
}

/**
 * «Datos de cobro»: el Yape principal y la primera cuenta bancaria activa de
 * Ajustes → Cuentas de cobro, en dígitos corridos para que el cliente los
 * teclee tal cual. Salen de la configuración de la tienda, no del código: si
 * cambia la cuenta, cambia la guía sin desplegar.
 */
export function tandersPaymentBlock(methods: readonly PaymentMethod[]): string {
  const digits = (s: string) => s.replace(/\D+/g, "");
  const yape = primaryYape(methods);
  const bank = methods
    .filter((m) => m.active && m.kind === "banco")
    .slice()
    .sort((a, b) => a.sort - b.sort)[0];
  const lines = [
    yape ? `• Yape: ${digits(yape.account)}` : "",
    bank ? `• ${bank.label} Cta: ${digits(bank.account)}` : "",
  ].filter(Boolean);
  return lines.length ? ["Datos de cobro:", ...lines].join("\n") : "";
}

function composeReferenceNote(reference: string | null | undefined, shopifyNote: string | null | undefined): string {
  const parts = [reference, shopifyNote]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    const key = p.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Una que contenga literalmente a la otra tampoco se repite.
  const kept = unique.filter(
    (p, i) => !unique.some((other, j) => j !== i && other.length > p.length && other.includes(p)),
  );

  return kept.join("\n");
}
