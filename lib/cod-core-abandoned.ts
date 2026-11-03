// Los formularios abandonados de COD Core → Leads (MOM §38.12, «Los formularios
// abandonados de WooCommerce», 27-10-2026, pedido del owner).
//
// COD Core guarda en su pantalla «Formularios abandonados» a quien escribió su
// celular en el formulario contra entrega y no terminó el pedido en 30 minutos,
// y lo pasa a «Recuperados» cuando ese celular compra. Es lo mismo que era un
// borrador de Releasit en Shopify: un carrito abandonado. Por eso entra por el
// mismo camino: una fila de `draft_orders` con `platform = 'woocommerce'` y
// `linkDraftOrdersToLeads`, que crea o reabre el lead «Carrito» con las mismas
// reglas (el periodo de gracia, no pisar una gestión, reabrir un ganado con una
// recompra). Así sale en la cola, en «Carritos anteriores» y en la secuencia de
// WhatsApp de carritos sin tocar nada de eso.
//
// COD Core lo manda por POST a `/api/webhooks/woocommerce/<storeId>/abandonados`
// (el contrato: docs/kapta/cod-core-abandonados.md), firmado con el mismo
// secreto de los webhooks de WooCommerce de la tienda: HMAC-SHA256 del cuerpo
// crudo, en base64, en `X-Kapta-Signature`.
//
// Este archivo es puro (sin base, red ni Node): el contrato y su traducción.

import type { DraftOrderRow, OrderLineItem } from "@/lib/types";
import { normalizePhone } from "@/lib/phone";

/** La cabecera con la firma (base64 del HMAC-SHA256 del cuerpo crudo). */
export const COD_CORE_SIGNATURE_HEADER = "x-kapta-signature";

/** La etiqueta que lo marca como carrito de un formulario contra entrega (`isCodFormDraft`). */
export const COD_CORE_DRAFT_TAG = "cod_form";

/** La segunda etiqueta: de dónde vino. */
export const COD_CORE_SOURCE_TAG = "cod-core";

export type CodCoreEvent = "abandonado" | "recuperado";

/** La dirección a la que COD Core manda los formularios. */
export function codCoreAbandonedUrl(appUrl: string, storeId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/woocommerce/${storeId}/abandonados`;
}

/** El gid de un formulario: no es de Shopify, y nada lo confunde con uno. */
export function codCoreFormGid(siteKey: string, formId: string): string {
  return `cod-core://${siteKey}/formulario/${formId}`;
}

/** ¿Este carrito es un formulario de COD Core (y no un borrador de Shopify)? */
export function isCodCoreFormGid(gid: string | null | undefined): boolean {
  return typeof gid === "string" && gid.startsWith("cod-core://");
}

function text(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Un id entero positivo (de COD Core o de WooCommerce), como texto. */
function positiveId(v: unknown): string | null {
  const t = text(v);
  return t && /^[1-9]\d{0,17}$/.test(t) ? t : null;
}

/**
 * Una fecha de COD Core: ISO 8601 (con zona; sin zona se toma como hora de
 * Lima, que es la del sitio) o unix en segundos. Null si no se entiende.
 */
export function codCoreDate(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 1_000_000_000) {
    return new Date(Math.round(v) * 1000).toISOString();
  }
  const t = text(v);
  if (!t) return null;
  if (/^\d{10}$/.test(t)) return new Date(Number(t) * 1000).toISOString();
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t.replace(" ", "T")}-05:00`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function lineItems(productos: unknown): OrderLineItem[] {
  if (!Array.isArray(productos)) return [];
  const out: OrderLineItem[] = [];
  for (const p of productos) {
    if (!p || typeof p !== "object") continue;
    const it = p as Record<string, unknown>;
    const title = text(it.nombre);
    if (!title) continue;
    const quantity = Math.max(1, Math.round(num(it.cantidad) ?? 1));
    out.push({
      title,
      variant_title: text(it.variante),
      quantity,
      sku: text(it.sku),
      product_id: positiveId(it.producto_id),
      variant_id: positiveId(it.variacion_id),
      // Precio unitario, como `price` de un borrador de Shopify.
      price: num(it.precio),
    });
  }
  return out;
}

export type CodCoreParse =
  | { ok: true; event: CodCoreEvent; formId: string; row: DraftOrderRow; orderId: string | null }
  | { ok: false; reason: string };

/**
 * El cuerpo de COD Core → la fila de `draft_orders`. Pura.
 *
 * Sin id, sin celular o con un evento que no se conoce, no hay carrito que
 * trabajar: se dice por qué y no se escribe nada.
 */
export function parseCodCoreForm(body: unknown, store: { id: string; siteKey: string }): CodCoreParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "el cuerpo no es un formulario" };
  const b = body as Record<string, any>;
  const event = text(b.evento)?.toLowerCase();
  if (event !== "abandonado" && event !== "recuperado") return { ok: false, reason: `evento desconocido: ${event ?? "(sin evento)"}` };
  const formId = positiveId(b.id);
  if (!formId) return { ok: false, reason: "el formulario no trae un id válido" };
  const phone = normalizePhone(text(b.cliente?.celular));
  if (!phone) return { ok: false, reason: "el formulario no trae celular" };

  const items = lineItems(b.productos);
  const sum = items.reduce((s, li) => s + (li.price ?? 0) * li.quantity, 0);
  const total = num(b.total) ?? (sum > 0 ? Math.round(sum * 100) / 100 : null);
  const createdAt = codCoreDate(b.creado);
  const updatedAt = codCoreDate(b.actualizado) ?? createdAt;

  // El pedido que lo recuperó, con el id que tiene en Kapta (`wc-kp-11179`).
  let orderId: string | null = null;
  const wooId = positiveId(b.pedido_id);
  // Mismo formato que `wooOrderId` (lib/woocommerce.ts, que no se importa
  // aquí: este archivo lo lee también la ficha, en el navegador).
  if (event === "recuperado" && wooId) orderId = `wc-${store.siteKey}-${wooId}`;
  const departamento = text(b.lugar?.departamento);
  const enlace = text(b.enlace);

  const row: DraftOrderRow & { platform: "woocommerce" } = {
    store_id: store.id,
    shopify_draft_order_id: `cod-${store.siteKey}-${formId}`,
    draft_order_gid: codCoreFormGid(store.siteKey, formId),
    name: `#F${formId}`,
    status: event === "recuperado" ? "completed" : "open",
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: event === "recuperado" ? (updatedAt ?? new Date().toISOString()) : null,
    invoice_url: enlace && /^https:\/\//i.test(enlace) ? enlace : null,
    total_amount: total,
    currency: text(b.moneda)?.toUpperCase() ?? "PEN",
    customer_phone: phone,
    customer_name: text(b.cliente?.nombre),
    district: text(b.lugar?.distrito),
    // Como en un borrador de Shopify: `province` y `region` son el departamento
    // (el campo «Región» del pedido). La provincia queda en `raw`.
    province: departamento,
    region: departamento,
    address1: text(b.lugar?.direccion),
    referencia: text(b.lugar?.referencia),
    tags: [COD_CORE_DRAFT_TAG, COD_CORE_SOURCE_TAG],
    note: null,
    line_items: items,
    order_gid: orderId,
    raw: { source: "cod-core", body: b },
    platform: "woocommerce",
  };
  return { ok: true, event, formId, row, orderId };
}
