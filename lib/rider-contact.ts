// Los enlaces que el motorizado toca en la calle: ir con Google Maps (o Waze),
// escribir por WhatsApp y llamar. Puro, sin navegador: la pantalla solo los
// pinta (MOM §29.12, pantalla del motorizado, 30-09-2026).
//
// WhatsApp se presenta como LA TIENDA del pedido (decisión de Frankz,
// 30-09-2026): es la marca que el cliente reconoce, no Grupo GF. Hay dos
// mensajes, los dos momentos en que el motorizado escribe: «Voy en camino» y
// «Ya llegué». Llevan el monto a pagar para que el cliente tenga el efectivo
// listo, que es lo que más demora una entrega contra entrega.

export interface ContactOrder {
  customer_name?: string | null;
  customer_phone?: string | null;
  address?: string | null;
  reference?: string | null;
  district?: string | null;
  province?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * El número para `wa.me`: solo dígitos y con el código de país. Un celular
 * peruano escrito sin código (9 dígitos que empiezan por 9) recibe el 51. Un
 * fijo o un número incompleto no tiene WhatsApp: null.
 */
export function whatsappNumber(phone: string | null | undefined): string | null {
  let digits = (phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!digits) return null;
  if (digits.length === 9 && digits.startsWith("9")) return `51${digits}`;
  if (digits.startsWith("51")) return digits.length === 11 && digits[2] === "9" ? digits : null;
  // Otro país, escrito con su código: 10 a 15 dígitos (E.164).
  if (digits.length >= 10 && digits.length <= 15 && !digits.startsWith("0")) return digits;
  return null;
}

/** `tel:` con el número internacional si lo es; si no, los dígitos tal cual (un fijo). */
export function telHref(phone: string | null | undefined): string | null {
  const international = whatsappNumber(phone);
  if (international) return `tel:+${international}`;
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 6 ? `tel:${digits}` : null;
}

/** `https://wa.me/51…?text=…`; null si el número no sirve para WhatsApp. */
export function whatsappHref(phone: string | null | undefined, text?: string | null): string | null {
  const number = whatsappNumber(phone);
  if (!number) return null;
  return text?.trim() ? `https://wa.me/${number}?text=${encodeURIComponent(text.trim())}` : `https://wa.me/${number}`;
}

/** «ABRAHAM ureña t.» → «Abraham». */
export function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first) return null;
  return first.charAt(0).toLocaleUpperCase("es-PE") + first.slice(1).toLocaleLowerCase("es-PE");
}

/** «S/ 1,298.00», como el resto de Kapta (es-PE, dos decimales). */
export function soles(amount: number): string {
  return `S/ ${amount.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type RiderMessageKind = "en_camino" | "llegue";

export interface RiderMessageContext {
  customerName: string | null | undefined;
  riderName: string | null | undefined;
  storeName: string | null | undefined;
  orderName: string | null | undefined;
  /** Lo que falta cobrar: null si no se sabe (no se menciona), 0 si ya está pagado. */
  amountDue: number | null | undefined;
}

export const RIDER_MESSAGE_LABEL: Record<RiderMessageKind, string> = {
  en_camino: "Voy en camino",
  llegue: "Ya llegué",
};

/** El mensaje que el motorizado manda por WhatsApp, presentándose como la tienda. */
export function riderWhatsappMessage(kind: RiderMessageKind, ctx: RiderMessageContext): string {
  const customer = firstName(ctx.customerName);
  const rider = firstName(ctx.riderName);
  const store = ctx.storeName?.trim() || null;
  const order = ctx.orderName?.trim() ? `tu pedido ${ctx.orderName.trim()}` : "tu pedido";
  const who = store
    ? rider ? `soy ${rider}, el motorizado de ${store}` : `soy el motorizado de ${store}`
    : rider ? `soy ${rider}, tu motorizado` : "soy tu motorizado";
  const hello = customer ? `Hola ${customer}, ${who}.` : `Hola, ${who}.`;
  const what = kind === "en_camino" ? `Voy en camino con ${order}.` : `Ya llegué con ${order}, estoy afuera.`;
  const due = ctx.amountDue == null || !Number.isFinite(ctx.amountDue)
    ? ""
    // Espacio duro dentro del monto: «S/» y la cifra no se separan al partir la línea.
    : ctx.amountDue > 0 ? ` El monto a pagar es ${soles(ctx.amountDue).replace(" ", "\u00a0")}.` : " Tu pedido ya está pagado.";
  return `${hello} ${what}${due}`;
}

function hasCoordinates(o: ContactOrder | null | undefined): o is ContactOrder & { latitude: number; longitude: number } {
  return o?.latitude != null && o?.longitude != null && Number.isFinite(o.latitude) && Number.isFinite(o.longitude);
}

/** La dirección escrita, para buscarla o copiarla: calle, distrito, provincia y país. */
export function addressQuery(o: ContactOrder | null | undefined): string | null {
  const parts = [o?.address, o?.district, o?.province].map((p) => p?.trim()).filter(Boolean);
  return parts.length ? [...parts, "Perú"].join(", ") : null;
}

/**
 * Google Maps en modo navegación hacia la parada: por coordenadas si las hay,
 * si no por la dirección escrita. Sin `travelmode`, para que Maps use el modo
 * que el motorizado ya eligió (moto, si su Maps lo ofrece).
 */
export function navigationHref(o: ContactOrder | null | undefined): string | null {
  const destination = hasCoordinates(o) ? `${o.latitude},${o.longitude}` : addressQuery(o);
  if (!destination) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&dir_action=navigate`;
}

/** Lo mismo en Waze, que en Lima usa buena parte de los motorizados. */
export function wazeHref(o: ContactOrder | null | undefined): string | null {
  if (hasCoordinates(o)) return `https://waze.com/ul?ll=${o.latitude},${o.longitude}&navigate=yes`;
  const query = addressQuery(o);
  return query ? `https://waze.com/ul?q=${encodeURIComponent(query)}&navigate=yes` : null;
}

/** Lo que se copia al portapapeles: la dirección y, en otra línea, la referencia. */
export function addressToCopy(o: ContactOrder | null | undefined): string | null {
  const line = [o?.address, o?.district].map((p) => p?.trim()).filter(Boolean).join(", ");
  if (!line) return null;
  return o?.reference?.trim() ? `${line}\nRef: ${o.reference.trim()}` : line;
}
