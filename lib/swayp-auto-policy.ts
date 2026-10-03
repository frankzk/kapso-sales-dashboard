import { normalizePhone } from "@/lib/phone";
import { deriveFenixCoverageCity, fenixWarehouseKey } from "@/lib/shipments";
import { reprogramDestination, shopifyShippingAddress, type ShipmentDestination } from "@/lib/shopify-address";
import { resolveUbigeo } from "@/lib/ubigeo";
import { normalizeSku } from "@/lib/swayp-productos";
import type { OrderLineItem } from "@/lib/types";

export interface AutoSettings { org_id: string; enabled: boolean; daily_cap: number; max_order_days: number; history_days: number; pilot_enabled?: boolean; pilot_daily_cap?: number }
export type AutoCohort = "prior_delivery" | "recent_no_history";

/** MOM 11.9.1, ampliado el 03-10-2026: hasta 14 días y de 0 a 2 intentos Aliclik.
 *  La reserva de la base (`swayp_emission_claim`, 0220) repite estos límites. */
export const PILOT_MAX_ORDER_DAYS = 14;
export const PILOT_MAX_AMOUNT = 500;
export const PILOT_MAX_ALICLIK_ATTEMPTS = 2;

/** Un intento informado de 0 a 2. Sin dato no se asume ninguno. */
export function pilotAttemptsOk(attempts: number | null | undefined): boolean {
  return Number.isInteger(attempts) && attempts! >= 0 && attempts! <= PILOT_MAX_ALICLIK_ATTEMPTS;
}
interface Guide { id: string; courier: string; delivery_status: string; reported_status: string | null; fenix_shipment_id: string | null }
export interface AutoSnapshot {
  order: { id: string; store_id: string; name: string | null; created_at: string; customer_phone: string | null;
    cancelled_at: string | null; total_amount: number | null; total_refunded: number | null; currency: string | null;
    financial_status: string | null; line_items: OrderLineItem[] | null; shopify_note: string | null; raw: unknown };
  payments?: { validation_status: string }[];
  source: Guide & ShipmentDestination & { aliclik_attempts?: number | null; latitude?: number | null; longitude?: number | null; store_id: string; order_id: string; guide_code: string; returned_at: string | null;
    closed_at: string | null; claimed_by: string | null; next_followup_at: string | null; non_delivery_reason: string | null; recovery_state: string | null };
  guides: Guide[];
  notes: { kind: string; reason: string | null; note: string | null; new_status: string | null }[];
  calls: { note: string | null; new_status: string | null }[];
  voice: { status: string; outcome: string | null; payload: unknown }[];
  history: { id: string; created_at: string; cancelled_at: string | null; line_items: OrderLineItem[] | null;
    delivered_at: string | null; address: string | null; district: string | null; province: string | null; region: string | null }[];
}
export function normalized(value: string | null | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
export function explicitRejection(text: string): boolean {
  const t = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /no\s+(?:lo\s+|la\s+|el\s+|le\s+)?(?:desea|quiere|recibira|recibire|acepta|acepto|pidio|pedi|compro|compre|confirmo)|se\s+niega|rechaz|refused|desiste|no\s+va\s+a\s+recibir|no\s+ha\s+(?:comprado|pedido)|cancel(?:ar|a|o)\s+(?:el\s+|su\s+|mi\s+)?pedido|no\s+enviar|no\s+despachar/.test(t);
}
/** Same product across variants or stores: SKU, product id, or normalized title. */
export function productsOverlap(a: OrderLineItem[], b: OrderLineItem[]): boolean {
  return a.some(x => b.some(y =>
    (!!x.sku && normalizeSku(x.sku) === normalizeSku(y.sku)) ||
    (!!x.product_id && x.product_id === y.product_id) ||
    (!!normalized(x.title) && normalized(x.title) === normalized(y.title))));
}
export function nextAutoDelivery(now: Date, city: string): string {
  const day = new Date(now.getTime() - 5 * 3600000);
  day.setUTCHours(12, 0, 0, 0);
  do { day.setUTCDate(day.getUTCDate() + 1); }
  while (day.getUTCDay() === 0 || (city === "arequipa" && day.getUTCDay() === 6));
  return day.toISOString().slice(0, 10);
}
export const AUTO_REASONS: Record<string, string> = {
  eligible: "Cumple los criterios", source_active: "Aliclik aún no registró un cierre sin entrega",
  invalid_order: "Pedido anulado, reembolsado o con cobro por revisar", old_order: "Fuera del plazo de vigencia",
  phone: "Teléfono inválido o distinto al destino", address: "Destino incompleto o sin cobertura exacta",
  live_guide: "Otra salida activa, entregada o intento Swayp previo", human_management: "Tiene gestión o programación vigente",
  rejection: "Existe rechazo o descarte", no_history: "Sin entrega previa reciente en el mismo domicilio",
  same_product: "Producto ya entregado o no identificable", duplicate: "Posible pedido de reemplazo",
  no_mapping: "Falta vínculo de algún producto con Swayp", no_stock: "Sin stock completo en Swayp",
  api_disabled: "Bodega sin emisión por API", created: "Guía Swayp creada", review: "Emisión pendiente de revisión",
  emission_blocked: "Emisión detenida por tope, reserva o cambio de datos",
  pilot_limits: "Piloto: requiere hasta 14 días, de 0 a 2 intentos informados y máximo S/500",
  pilot_location: "Piloto: ubicación o referencia sin corroborar",
  pilot_cap: "Piloto: cupo diario de intentos alcanzado",
  payment_review: "Tiene un pago registrado: revisar saldo antes de reenviar",
};

export function evaluateAutoDispatch(s: AutoSnapshot, c: AutoSettings, now: Date) {
  const no = (reason: string) => ({ eligible: false as const, reason });
  const o = s.order, g = s.source;
  const age = (now.getTime() - Date.parse(o.created_at)) / 86400000;
  if (!Number.isFinite(age) || age < 0 || age > c.max_order_days) return no("old_order");
  if (o.cancelled_at || (o.total_refunded ?? 0) > 0 || !(Number(o.total_amount) > 0) || o.currency !== "PEN"
    || o.financial_status !== "pending" || !o.name) return no("invalid_order");
  if (g.courier !== "aliclik" || g.delivery_status !== "anulado" || g.fenix_shipment_id
    || !["CANCEL", "NOT_RESPOND"].includes((g.reported_status ?? "").split(" · ")[0]!)
    || !(g.closed_at || g.returned_at || (g.reported_status ?? "").split(" · ").includes("RETURNED"))) return no("source_active");
  if (s.guides.some(x => x.id !== g.id && (x.courier === "fenix" || x.fenix_shipment_id
    || !["anulado", "devuelto"].includes(x.delivery_status)))) return no("live_guide");
  if (g.claimed_by || (g.next_followup_at && Date.parse(g.next_followup_at) > now.getTime())
    || s.voice.some(v => ["queued", "dialing", "in_progress"].includes(v.status))) return no("human_management");
  if (g.recovery_state === "discarded" || s.notes.some(n => /discard|reject|cancel/.test(n.kind))
    || s.voice.some(v => v.outcome === "cancela" || JSON.stringify(v.payload).includes('"no_llamar":true'))
    || explicitRejection([o.shopify_note, g.non_delivery_reason, ...s.notes.map(n => [n.reason,n.note,n.new_status].join(" ")),
      ...s.calls.map(x => [x.note,x.new_status].join(" ")), ...s.voice.map(v => JSON.stringify(v.payload))].join("\n"))) return no("rejection");
  const address = reprogramDestination(g, shopifyShippingAddress(o.raw));
  const phone = normalizePhone(o.customer_phone);
  if (!phone || !/^519\d{8}$/.test(phone) || (address?.phone && normalizePhone(address.phone) !== phone)) return no("phone");
  const city = deriveFenixCoverageCity(address?.city, address?.province);
  if (!address?.address1 || address.address1.trim().length < 8 || !address.city || !address.province || !address.name
    || fenixWarehouseKey(city) === "lima" || !resolveUbigeo(city,address.city)?.exact) return no("address");
  const items = o.line_items ?? [];
  if (!items.length || items.some(x => !x.sku || !x.title || !Number.isInteger(x.quantity) || x.quantity <= 0)) return no("same_product");
  const delivered = s.history.filter(h => h.delivered_at && Date.parse(h.delivered_at) < Date.parse(o.created_at)
    && Date.parse(h.delivered_at) >= now.getTime() - c.history_days * 86400000);
  const prior = delivered.find(h => normalized(h.address) === normalized(address.address1)
    && normalized(h.district) === normalized(address.city)
    && normalized(h.province || h.region) === normalized(address.province));
  const cohort: AutoCohort = prior ? "prior_delivery" : "recent_no_history";
  if (!prior && !c.pilot_enabled) return no("no_history");
  if (!prior) {
    if (age > PILOT_MAX_ORDER_DAYS || !pilotAttemptsOk(g.aliclik_attempts) || Number(o.total_amount) > PILOT_MAX_AMOUNT) return no("pilot_limits");
    // Presence alone is not corroboration: the server also resolves these
    // coordinates through Aliclik and requires the exact destination ubigeo.
    if (!address.address2?.trim() || !Number.isFinite(g.latitude) || !Number.isFinite(g.longitude)
      || !g.latitude || !g.longitude || Math.abs(g.latitude)>90 || Math.abs(g.longitude)>180) return no("pilot_location");
    // This pilot is COD in full; advances need a separate balance-aware path.
    if (!s.payments || s.payments.some(p=>p.validation_status!=="rechazado")) return no("payment_review");
  }
  if (delivered.some(h => !h.line_items?.length || productsOverlap(items,h.line_items))) return no("same_product");
  if (s.history.some(h => !h.cancelled_at && (!h.delivered_at || Date.parse(h.created_at) >= Date.parse(o.created_at))
    && (!h.line_items?.length || productsOverlap(items,h.line_items)))) return no("duplicate");
  return { eligible: true as const, reason: "eligible", city, address, phone, items, cohort, priorOrderId: prior?.id ?? null,
    dispatchDate: nextAutoDelivery(now,city) };
}
