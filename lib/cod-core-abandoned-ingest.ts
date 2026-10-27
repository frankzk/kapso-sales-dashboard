// La entrada de los formularios abandonados de COD Core (MOM §38.12, «Los
// formularios abandonados de WooCommerce», 27-10-2026). El contrato y su
// traducción viven en lib/cod-core-abandoned.ts; aquí, la firma, la base y el
// lead.
//
// Las respuestas son las que COD Core muestra en su columna «Webhook»:
//   · 200: recibido (también el repetido y el viejo que ya no cambia nada);
//   · 401: la firma no cuadra, o la tienda no tiene el secreto de los webhooks;
//   · 404: la tienda no existe (dirección mal pegada);
//   · 422: el formulario no se puede usar (sin id, sin celular, evento
//     desconocido): reenviarlo igual no lo arregla;
//   · 503: la base no contestó o falta la clave del sitio: reenviarlo sí.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCodCoreForm } from "@/lib/cod-core-abandoned";
import { upsertDraftOrders } from "@/lib/ingest";
import {
  closeCartLeadsWithOrders,
  eventOverridesDisposition,
  lastDispositionAtByPhone,
  linkDraftOrdersToLeads,
} from "@/lib/leads-ingest";
import { DRAFT_OPEN_WINDOW_DAYS } from "@/lib/shopify";
import type { DraftOrderRow } from "@/lib/types";
import { verifyWooSignature } from "@/lib/woocommerce";
import { loadWooStoreCreds } from "@/lib/woocommerce-intake";

export type CodCoreResult =
  | { status: "ok"; event: "abandonado" | "recuperado"; formId: string; message?: string }
  | { status: "unauthorized"; message: string }
  | { status: "unknown_store" }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };

export function codCoreHttpStatus(result: CodCoreResult): number {
  switch (result.status) {
    case "ok":
      return 200;
    case "unauthorized":
      return 401;
    case "unknown_store":
      return 404;
    case "invalid":
      return 422;
    default:
      return 503;
  }
}

/** ¿El formulario es más viejo que la ventana de la cola? Sin fecha, no. Pura. */
export function isPastLeadWindow(createdAt: string | null | undefined, nowMs: number): boolean {
  const at = Date.parse(createdAt ?? "");
  return Number.isFinite(at) && at < nowMs - DRAFT_OPEN_WINDOW_DAYS * 86_400_000;
}

export async function processCodCoreAbandoned(
  admin: SupabaseClient,
  params: { storeId: string; rawBody: string; signature: string | null },
): Promise<CodCoreResult> {
  const { creds, error } = await loadWooStoreCreds(admin, params.storeId);
  if (error) return { status: "error", message: "No se pudo leer la tienda." };
  if (!creds) return { status: "unknown_store" };
  if (!creds.webhookSecret) {
    return { status: "unauthorized", message: "La tienda no tiene guardado el secreto de los webhooks (Ajustes → WooCommerce)." };
  }
  if (!verifyWooSignature(params.rawBody, params.signature, creds.webhookSecret)) {
    return { status: "unauthorized", message: "La firma no cuadra con el secreto de los webhooks de la tienda." };
  }
  if (!creds.siteKey) return { status: "error", message: "La tienda no tiene la clave del sitio (Ajustes → WooCommerce)." };

  let body: unknown;
  try {
    body = JSON.parse(params.rawBody);
  } catch {
    return { status: "invalid", message: "El cuerpo no es JSON." };
  }
  const parsed = parseCodCoreForm(body, { id: creds.id, siteKey: creds.siteKey });
  if (!parsed.ok) return { status: "invalid", message: parsed.reason };
  const { row, event, formId } = parsed;

  // Un «abandonado» que llega después del «recuperado» (un reenvío, otro orden
  // de entrega) no lo vuelve a abrir.
  const { data: prev, error: prevErr } = await admin
    .from("draft_orders")
    .select("status")
    .eq("store_id", creds.id)
    .eq("shopify_draft_order_id", row.shopify_draft_order_id)
    .maybeSingle();
  if (prevErr) return { status: "error", message: "No se pudo leer el formulario guardado." };
  if (event === "abandonado" && (prev as { status: string | null } | null)?.status === "completed") {
    return { status: "ok", event, formId, message: "ya estaba recuperado" };
  }

  try {
    await upsertDraftOrders(admin, [row]);
  } catch {
    return { status: "error", message: "No se pudo guardar el formulario." };
  }

  // Como los borradores de Shopify, a la cola solo entra lo de los últimos
  // DRAFT_OPEN_WINDOW_DAYS días; lo anterior (el primer envío de lo que ya
  // estaba en la pantalla de COD Core) queda como historia en «Carritos
  // anteriores». Sin esto entraba a la cola y el archivador de 7 días lo
  // pasaba a Perdido sin que nadie lo llamara.
  if (event === "abandonado" && isPastLeadWindow(row.created_at, Date.now())) {
    return { status: "ok", event, formId, message: "guardado como historia: tiene más de 2 días" };
  }

  try {
    if (event === "abandonado") {
      await linkDraftOrdersToLeads(admin, creds.id, [row]);
    } else {
      await closeRecoveredForm(admin, creds.id, row, parsed.orderId);
    }
  } catch (e) {
    // El formulario ya quedó guardado: la pasada de cada 5 minutos vuelve a
    // enlazar los abiertos (`relinkCodCoreForms`). Un recuperado sin cerrar lo
    // cierra el barrido de carritos con pedido.
    console.error(`[cod-core] ${JSON.stringify({ storeId: creds.id, formId, event, paso: "lead", error: e instanceof Error ? e.message : String(e) })}`);
  }
  return { status: "ok", event, formId };
}

/**
 * COD Core dice que ese celular compró. El lead del formulario sale de la cola
 * con el pedido que nombra (`pedido_id`) si Kapta ya lo tiene; si no lo nombra
 * o todavía no llegó, con el barrido de siempre (un pedido del mismo celular
 * con un producto del carrito). Una gestión de la asesora posterior al pedido
 * manda, como en `closeCartLeadsWithOrders`.
 */
async function closeRecoveredForm(
  admin: SupabaseClient,
  storeId: string,
  row: DraftOrderRow,
  orderId: string | null,
): Promise<void> {
  const phone = row.customer_phone as string;
  await admin
    .from("leads")
    .update({ draft_order_status: "completed" })
    .eq("store_id", storeId)
    .eq("draft_order_gid", row.draft_order_gid);

  if (orderId) {
    const { data: order } = await admin
      .from("orders")
      .select("id, name, created_at, cancelled_at")
      .eq("store_id", storeId)
      .eq("shopify_order_id", orderId)
      .maybeSingle();
    const o = order as { id: string; name: string | null; created_at: string | null; cancelled_at: string | null } | null;
    if (o && !o.cancelled_at) {
      const disp = await lastDispositionAtByPhone(admin, storeId, [phone]);
      if (eventOverridesDisposition(o.created_at, disp.get(phone))) {
        const { data: updated } = await admin
          .from("leads")
          .update({
            status: "ya_tiene_pedido",
            category: "won",
            needs_attention: false,
            has_order: true,
            order_id: o.id,
            next_followup_at: null,
          })
          .eq("store_id", storeId)
          .eq("phone", phone)
          .eq("draft_order_gid", row.draft_order_gid)
          .in("category", ["open", "hot"])
          .select("id");
        for (const lead of (updated as { id: string }[] | null) ?? []) {
          await admin.from("lead_calls").insert({
            lead_id: lead.id,
            store_id: storeId,
            vendedora: null,
            kind: "system",
            new_status: "ya_tiene_pedido",
            note: `COD Core lo pasó a Recuperados: la clienta hizo el pedido${o.name ? ` ${o.name}` : ""}. Sale de la cola.`,
          });
        }
      }
    }
  }
  await closeCartLeadsWithOrders(admin, storeId, { phones: [phone] });
}

const RELINK_COLUMNS =
  "store_id, shopify_draft_order_id, draft_order_gid, name, status, created_at, updated_at, completed_at, invoice_url, total_amount, currency, customer_phone, customer_name, district, province, region, address1, referencia, tags, note, line_items, order_gid";

/**
 * La red de seguridad de la pasada (cada 5 minutos): vuelve a enlazar los
 * formularios abiertos de los últimos días, como el sync de borradores de
 * Shopify. Cubre uno que llegó dentro del periodo de gracia y un enlace que
 * falló después de guardarlo. Sin formularios es una sola lectura. Devuelve
 * cuántos revisó.
 */
export async function relinkCodCoreForms(admin: SupabaseClient, storeId: string): Promise<number> {
  const floor = new Date(Date.now() - DRAFT_OPEN_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("draft_orders")
    .select(RELINK_COLUMNS)
    .eq("store_id", storeId)
    .eq("platform", "woocommerce")
    .eq("status", "open")
    .gte("created_at", floor)
    .limit(500);
  if (error) throw new Error(`formularios de COD Core: ${error.message}`);
  const rows = ((data as unknown as DraftOrderRow[] | null) ?? []).map((r) => ({
    ...r,
    tags: r.tags ?? [],
    line_items: r.line_items ?? [],
  }));
  if (!rows.length) return 0;
  await linkDraftOrdersToLeads(admin, storeId, rows);
  return rows.length;
}
