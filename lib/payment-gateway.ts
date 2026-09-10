// Por dónde entró el dinero de un pedido pagado en Shopify. UNA clasificación.
//
// EL CASO. #KP132708 nació pagado: EasySell mandó al checkout con el descuento
// PREPAID y Shopify cobró ahí. Pero alguien subió la captura del pedido como
// comprobante de S/ 447, y la regla que teníamos —«pagado en Shopify y sin
// comprobantes» = pagado por web— se apagó en cuanto hubo un comprobante. El
// pedido se quedó en confirmación pidiendo un adelanto que ya estaba cobrado.
//
// LA REGLA QUE PIDIÓ LA OPERACIÓN (10-09-2026). Solo la pasarela del checkout
// —«Checkout Flow | Tarjeta, Transf., Cuotas débito»— nace pagada y se salta la
// verificación de constancias. «Manual» (alguien marcó el pedido como pagado a
// mano en Shopify) y «Cash on Delivery (COD)» siguen el conducto regular: si se
// quiere dar por pagado, se sube la constancia.
//
// DE DÓNDE SALE. Shopify lo expone en `paymentGatewayNames` (GraphQL) y en
// `payment_gateway_names` (webhook REST). Hasta hoy la sincronización no lo
// pedía, así que el 99 % de los pedidos no lo tienen: para ésos la respuesta es
// «no se sabe» y manda la regla de antes. No se adivina.
//
// QUÉ ES «CHECKOUT». Cualquier pasarela que no sea de las que NO cobran: la
// lista de las que sí cobran cambia con cada app (Mercado Pago, Culqi, Shopify
// Payments…) y mantenerla es cómo se deja de reconocer la siguiente. Las que no
// cobran son dos y no cambian.

export type PaymentGateway = "checkout" | "manual" | "cod";

/** Nombres que Shopify pone cuando NADIE cobró en el checkout. */
const SIN_COBRO = new Set(["manual", "cash on delivery (cod)", "bogus"]);

/** Los nombres tal como vienen, o null si el payload no los trae. */
export function gatewayNamesOf(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const names = r.paymentGatewayNames ?? r.payment_gateway_names;
  if (!Array.isArray(names)) return null;
  return names.filter((n): n is string => typeof n === "string");
}

/**
 * `checkout` si alguna pasarela cobró; `manual` si alguien lo marcó a mano;
 * `cod` si solo hay contraentrega; null si no se sabe (sin dato, o lista vacía:
 * una lista vacía no dice quién cobró, y adivinar es cobrar dos veces).
 */
export function classifyPaymentGateway(names: readonly string[] | null | undefined): PaymentGateway | null {
  if (!names || !names.length) return null;
  const lower = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (!lower.length) return null;
  if (lower.some((n) => !SIN_COBRO.has(n))) return "checkout";
  if (lower.includes("manual")) return "manual";
  return "cod";
}

/** Azúcar para los dos mapeadores de Shopify. */
export function paymentGatewayOf(raw: unknown): PaymentGateway | null {
  return classifyPaymentGateway(gatewayNamesOf(raw));
}

/** Texto para el panel. */
export const PAYMENT_GATEWAY_LABEL: Record<PaymentGateway, string> = {
  checkout: "Pagado en el checkout · tarjeta o transferencia",
  manual: "Marcado como pagado a mano en Shopify",
  cod: "Contraentrega",
};
