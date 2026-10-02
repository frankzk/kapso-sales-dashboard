// Prueba de pedidos automáticos de recompra (MOM, 02-10-2026).
//
// QUÉ HACE. Convierte en pedido, sin llamada previa, los carritos que una
// persona autorizó uno por uno en `auto_order_trials` (migración 0214). Es una
// prueba con grupo cerrado: mide cuántos de estos pedidos se entregan antes de
// decidir si la regla se automatiza para todos.
//
// QUÉ NO HACE. No elige carritos: solo procesa filas insertadas a mano. No
// toca precios ni productos: completa el MISMO borrador que armó el cliente en
// el formulario COD, así que se cobra exactamente lo que el cliente vio. Y no
// acredita la venta a ninguna asesora: nadie la cerró por teléfono.
//
// POR QUÉ SE VUELVE A VALIDAR TODO justo antes de completar: entre que se
// eligió el carrito y que corre el cron pueden pasar horas, y en ese rato una
// asesora pudo llamar y marcarlo perdido, el cliente pudo comprar por otra vía o
// armar otro carrito. Generar encima de cualquiera de esas cosas es un pedido
// que nadie quería.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addTags,
  completeDraftOrder,
  fetchOrderById,
  getDraftOrderForEdit,
  updateDraftShippingAddress,
  type OrderAddressInput,
} from "@/lib/shopify";
import { extractNumericId } from "@/lib/shopify-urls";
import { peruMobileDigits } from "@/lib/phone";
import { recomputeOrderMasterSafe } from "@/lib/order-master";

/** Etiqueta común a todas las pruebas; la del grupo (`cohort`) va además. */
export const AUTO_TRIAL_TAG = "auto_recompra";
/** Cuántas filas procesa una corrida del cron (cada una son ~5 llamadas a Shopify). */
export const AUTO_TRIAL_BATCH = 10;
/** Un carrito más viejo que esto ya no se genera: la intención del cliente se enfría. */
export const AUTO_TRIAL_MAX_CART_AGE_DAYS = 12;

export type TrialGroup = "A" | "B" | "C";

export interface AutoOrderTrialRow {
  id: string;
  store_id: string;
  lead_id: string | null;
  draft_order_gid: string;
  draft_name: string | null;
  cohort: string;
  grupo: TrialGroup;
  address1: string | null;
  referencia: string | null;
  district: string | null;
  province: string | null;
}

export interface TrialLead {
  id: string;
  phone: string | null;
  status: string | null;
  category: string | null;
  draft_order_gid: string | null;
}

export interface TrialDraft {
  draft_order_gid: string;
  name: string | null;
  status: string | null;
  created_at: string | null;
  total_amount: number | null;
  currency: string | null;
  customer_phone: string | null;
  customer_name: string | null;
  address1: string | null;
  referencia: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
}

const OPEN_DRAFT = new Set(["open", "invoice_sent"]);

/** ¿Es una dirección a la que se puede despachar? "-", "." o "x" no lo son:
 *  el formulario COD los acepta y así llegaron 20 de los 68 carritos de
 *  recompra revisados el 02-10-2026. */
export function isUsableAddress(address1: string | null | undefined): boolean {
  return String(address1 ?? "").replace(/[^\p{L}\p{N}]/gu, "").length >= 6;
}

function isUsableDistrict(district: string | null | undefined): boolean {
  return String(district ?? "").replace(/[^\p{L}]/gu, "").length >= 3;
}

/** ¿La fila trae dirección propia? Basta un campo: el resto se completa con el carrito. */
export function hasAddressOverride(row: AutoOrderTrialRow): boolean {
  return [row.address1, row.referencia, row.district, row.province].some(
    (v) => (v ?? "").trim() !== "",
  );
}

/** La dirección que debe llevar el pedido cuando la fila trae una propia. PURA. */
export function trialAddress(row: AutoOrderTrialRow, draft: TrialDraft): OrderAddressInput | null {
  if (!hasAddressOverride(row)) return null;
  const pick = (own: string | null, fallback: string | null) => (own ?? "").trim() || fallback;
  return {
    name: draft.customer_name,
    phone: draft.customer_phone,
    address1: pick(row.address1, draft.address1),
    address2: pick(row.referencia, draft.referencia),
    city: pick(row.district, draft.district),
    province: pick(row.province, draft.region ?? draft.province),
    country: "Peru",
  };
}

/**
 * Por qué esta fila NO se convierte en pedido ahora. `null` = adelante. PURA.
 *
 * Es la regla entera de la prueba; el procesador solo junta los datos. Los
 * motivos van en minúsculas y con guion bajo porque se guardan en `reason` y
 * se cuentan después.
 */
export function trialSkipReason(input: {
  row: AutoOrderTrialRow;
  lead: TrialLead | null;
  draft: TrialDraft | null;
  /** Un pedido no anulado del mismo teléfono, posterior al carrito. */
  laterOrder: boolean;
  nowMs: number;
}): string | null {
  const { row, lead, draft } = input;
  if (!lead) return "lead_no_existe";
  // Solo un lead que nadie gestionó todavía. Si una asesora ya lo llamó y lo
  // marcó (perdido, ganado, volver a llamar…), manda su decisión.
  if (lead.category !== "open" && lead.category !== "hot") return `lead_${lead.status ?? "gestionado"}`;
  if (lead.status !== "nuevo") return `lead_${lead.status ?? "gestionado"}`;
  if (lead.draft_order_gid !== row.draft_order_gid) return "carrito_reemplazado";
  if (!draft) return "carrito_no_encontrado";
  if (!OPEN_DRAFT.has(String(draft.status ?? "").toLowerCase())) return "carrito_cerrado";
  // Un total en cero es un pedido que Shopify da por PAGADO al completarlo.
  if (!(Number(draft.total_amount) > 0)) return "total_cero";
  const cartMs = Date.parse(draft.created_at ?? "");
  if (!Number.isFinite(cartMs)) return "carrito_sin_fecha";
  if (input.nowMs - cartMs > AUTO_TRIAL_MAX_CART_AGE_DAYS * 86_400_000) return "carrito_vencido";
  if (input.laterOrder) return "ya_tiene_pedido_posterior";
  const address = trialAddress(row, draft);
  const address1 = address ? address.address1 : draft.address1;
  const district = address ? address.city : draft.district;
  if (!isUsableAddress(address1) || !isUsableDistrict(district)) return "sin_direccion";
  return null;
}

/** ¿Este pedido (de `orders`) es del mismo cliente y posterior al carrito? PURA. */
export function isLaterOrderOf(
  phone: string | null | undefined,
  cartCreatedAt: string | null | undefined,
  order: { customer_phone: string | null; created_at: string | null; cancelled_at?: string | null },
): boolean {
  const mine = peruMobileDigits(phone);
  if (mine.length < 6 || order.cancelled_at) return false;
  if (peruMobileDigits(order.customer_phone) !== mine) return false;
  const cart = Date.parse(cartCreatedAt ?? "");
  const at = Date.parse(order.created_at ?? "");
  return Number.isFinite(cart) && Number.isFinite(at) && at > cart;
}

/** Todo lo que el procesador necesita de afuera. Inyectable para las pruebas. */
export interface AutoTrialDeps {
  listPending(limit: number): Promise<AutoOrderTrialRow[]>;
  /** pendiente → procesando, solo si nadie la tomó antes. */
  claim(id: string): Promise<boolean>;
  loadLead(leadId: string): Promise<TrialLead | null>;
  loadDraft(gid: string): Promise<TrialDraft | null>;
  hasLaterOrder(phone: string, cartCreatedAt: string): Promise<boolean>;
  liveDraftStatus(gid: string): Promise<string | null>;
  completeDraft(gid: string): Promise<{ orderGid: string | null; orderName: string | null }>;
  /** Pone la dirección en el borrador antes de completarlo. */
  setDraftAddress(draftGid: string, address: OrderAddressInput): Promise<void>;
  tagOrder(orderGid: string, tags: string[]): Promise<void>;
  /** Registra el pedido en Kapta y gana el lead. Devuelve el created_at del pedido. */
  recordOrder(input: {
    row: AutoOrderTrialRow;
    lead: TrialLead;
    draft: TrialDraft;
    orderGid: string;
    orderName: string | null;
  }): Promise<string | null>;
  finish(id: string, patch: Record<string, unknown>): Promise<void>;
  now(): number;
}

export interface AutoTrialReport {
  generated: number;
  skipped: number;
  failed: number;
  /** created_at de los pedidos generados, para recalcular los rollups de esos días. */
  orderDates: string[];
}

/**
 * Procesa las filas pendientes de una tienda. Nunca lanza por una fila: cada
 * una termina `generado`, `omitido` (con motivo) o `error` (con el mensaje).
 *
 * Todo lo que el pedido necesita para despacharse —la dirección incluida— se
 * deja en el borrador ANTES de completarlo. Una vez completado, el pedido
 * EXISTE en Shopify y nada lo deshace: la etiqueta y el registro local son de
 * mejor esfuerzo, y lo que falle queda escrito en `reason` de una fila
 * `generado` para corregirlo a mano.
 */
export async function processAutoOrderTrials(
  deps: AutoTrialDeps,
  limit = AUTO_TRIAL_BATCH,
): Promise<AutoTrialReport> {
  const report: AutoTrialReport = { generated: 0, skipped: 0, failed: 0, orderDates: [] };
  const rows = await deps.listPending(limit);
  for (const row of rows) {
    if (!(await deps.claim(row.id))) continue;
    const stamp = () => new Date(deps.now()).toISOString();
    const skip = async (reason: string) => {
      report.skipped += 1;
      await deps.finish(row.id, { status: "omitido", reason, processed_at: stamp() });
    };
    try {
      const lead = row.lead_id ? await deps.loadLead(row.lead_id) : null;
      const draft = await deps.loadDraft(row.draft_order_gid);
      const phone = draft?.customer_phone ?? lead?.phone ?? null;
      const laterOrder =
        !!phone && !!draft?.created_at ? await deps.hasLaterOrder(phone, draft.created_at) : false;
      const reason = trialSkipReason({ row, lead, draft, laterOrder, nowMs: deps.now() });
      if (reason || !lead || !draft) {
        await skip(reason ?? "sin_datos");
        continue;
      }
      // Lo que dice NUESTRA copia del carrito puede tener horas de atraso.
      const live = await deps.liveDraftStatus(row.draft_order_gid);
      if (!OPEN_DRAFT.has(String(live ?? "").toLowerCase())) {
        await skip("carrito_cerrado_en_shopify");
        continue;
      }

      // La dirección va en el BORRADOR, antes de completarlo. Corregirla en el
      // pedido ya creado pide `write_orders`, que la tienda no dio: así salieron
      // seis pedidos del grupo B con la «-» del formulario (02-10-2026). Si el
      // borrador no acepta la dirección, el pedido no se genera.
      const address = trialAddress(row, draft);
      if (address) {
        try {
          await deps.setDraftAddress(row.draft_order_gid, address);
        } catch (e: any) {
          await skip(`direccion_no_aplicada: ${String(e?.message ?? e).slice(0, 300)}`);
          continue;
        }
      }

      let completed: { orderGid: string | null; orderName: string | null };
      try {
        completed = await deps.completeDraft(row.draft_order_gid);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/already.*complet|complet.*already|has already|is complete/i.test(msg)) {
          await skip("carrito_ya_completado");
          continue;
        }
        throw e;
      }
      if (!completed.orderGid) throw new Error("Shopify completó el carrito pero no devolvió el pedido");

      const avisos: string[] = [];
      try {
        await deps.tagOrder(completed.orderGid, [AUTO_TRIAL_TAG, row.cohort]);
      } catch (e: any) {
        // Etiquetar el pedido también pide `write_orders`. No hace falta para
        // medir —la tabla guarda el pedido—, así que se anota corto y se sigue.
        const msg = String(e?.message ?? e);
        avisos.push(
          /access denied|write_orders/i.test(msg)
            ? "etiqueta no aplicada: falta permiso write_orders"
            : `etiqueta no aplicada: ${msg.slice(0, 200)}`,
        );
      }
      try {
        const at = await deps.recordOrder({
          row,
          lead,
          draft,
          orderGid: completed.orderGid,
          orderName: completed.orderName,
        });
        if (at) report.orderDates.push(at);
      } catch (e: any) {
        avisos.push(`registro local incompleto: ${e?.message ?? e}`);
      }

      report.generated += 1;
      await deps.finish(row.id, {
        status: "generado",
        order_gid: completed.orderGid,
        shopify_order_id: extractNumericId(completed.orderGid),
        order_name: completed.orderName,
        reason: avisos.length ? avisos.join(" · ") : null,
        processed_at: stamp(),
      });
    } catch (e: any) {
      report.failed += 1;
      await deps.finish(row.id, {
        status: "error",
        reason: String(e?.message ?? e).slice(0, 500),
        processed_at: stamp(),
      });
    }
  }
  return report;
}

function money(currency: string | null, amount: number | null): string {
  return `${currency ?? "PEN"} ${Number(amount ?? 0).toFixed(2)}`;
}

/** Las dependencias reales: Supabase con service role + Shopify de la tienda. */
export function autoTrialDeps(
  admin: SupabaseClient,
  storeId: string,
  shopify: { domain: string; token: string },
): AutoTrialDeps {
  return {
    async listPending(limit) {
      const { data, error } = await admin
        .from("auto_order_trials")
        .select("id, store_id, lead_id, draft_order_gid, draft_name, cohort, grupo, address1, referencia, district, province")
        .eq("store_id", storeId)
        .eq("status", "pendiente")
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`auto_order_trials: ${error.message}`);
      return (data ?? []) as AutoOrderTrialRow[];
    },
    async claim(id) {
      const { data } = await admin
        .from("auto_order_trials")
        .update({ status: "procesando", claimed_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "pendiente")
        .select("id");
      return ((data ?? []) as unknown[]).length === 1;
    },
    async loadLead(leadId) {
      const { data } = await admin
        .from("leads")
        .select("id, phone, status, category, draft_order_gid")
        .eq("id", leadId)
        .eq("store_id", storeId)
        .maybeSingle();
      return (data as TrialLead | null) ?? null;
    },
    async loadDraft(gid) {
      const { data } = await admin
        .from("draft_orders")
        .select(
          "draft_order_gid, name, status, created_at, total_amount, currency, customer_phone, customer_name, address1, referencia, district, province, region",
        )
        .eq("store_id", storeId)
        .eq("shopify_draft_order_id", extractNumericId(gid))
        .maybeSingle();
      return (data as TrialDraft | null) ?? null;
    },
    async hasLaterOrder(phone, cartCreatedAt) {
      // `orders.customer_phone` guarda el formato con el que llegó; se comparan
      // dígitos en TS, como getPedidosRecientesPorTelefono. El rango (desde el
      // carrito, ≤12 días) mantiene acotada la lectura.
      const { data } = await admin
        .from("orders")
        .select("customer_phone, created_at, cancelled_at")
        .eq("store_id", storeId)
        .gt("created_at", cartCreatedAt)
        .limit(5000);
      return ((data ?? []) as { customer_phone: string | null; created_at: string | null; cancelled_at: string | null }[]).some(
        (o) => isLaterOrderOf(phone, cartCreatedAt, o),
      );
    },
    async liveDraftStatus(gid) {
      const live = await getDraftOrderForEdit({ ...shopify, gid });
      return live?.status ?? null;
    },
    async completeDraft(gid) {
      const done = await completeDraftOrder({ ...shopify, draftGid: gid, paymentPending: true });
      return { orderGid: done.orderGid, orderName: done.orderName };
    },
    async setDraftAddress(draftGid, address) {
      await updateDraftShippingAddress({ ...shopify, draftGid, address });
    },
    async tagOrder(orderGid, tags) {
      await addTags({ ...shopify, gid: orderGid, tags });
    },
    async recordOrder({ row, lead, draft, orderGid, orderName }) {
      const nowIso = new Date().toISOString();
      const order = await fetchOrderById({ ...shopify, storeId, orderGid });
      let orderId: string | null = null;
      if (order?.shopify_order_id) {
        // Mismas etiquetas locales que un carrito recuperado sin asesora
        // (linkCompletedDraftToLead): `kapso` para que cuente en los rollups,
        // `cod_recuperado` para distinguirlo de los pedidos del bot.
        order.tags = [...new Set([...order.tags, "kapso", "cod_recuperado", AUTO_TRIAL_TAG, row.cohort])];
        const { error } = await admin.from("orders").upsert([order], { onConflict: "store_id,shopify_order_id" });
        if (error) throw new Error(`orders: ${error.message}`);
        const { data } = await admin
          .from("orders")
          .select("id")
          .eq("store_id", storeId)
          .eq("shopify_order_id", order.shopify_order_id)
          .maybeSingle();
        orderId = (data as { id: string } | null)?.id ?? null;
        if (orderId) await recomputeOrderMasterSafe(admin, [orderId]);
      }
      const name = orderName ?? order?.name ?? "pedido";
      await Promise.all([
        admin
          .from("leads")
          .update({
            has_order: true,
            order_id: orderId,
            status: "pedido_generado",
            category: "won",
            needs_attention: false,
            next_followup_at: null,
            last_interaction_at: nowIso,
            draft_order_status: "completed",
          })
          .eq("id", lead.id),
        admin
          .from("draft_orders")
          .update({ status: "completed", completed_at: nowIso, order_gid: orderGid })
          .eq("store_id", storeId)
          .eq("draft_order_gid", row.draft_order_gid),
        admin.from("lead_calls").insert({
          lead_id: lead.id,
          store_id: storeId,
          vendedora: null,
          kind: "system",
          new_status: "pedido_generado",
          note:
            `🧪 Prueba ${row.cohort} (grupo ${row.grupo}): ${name} generado sin llamada desde el carrito ` +
            `${draft.name ?? row.draft_name ?? ""} · ${money(draft.currency, draft.total_amount)} · contraentrega` +
            (hasAddressOverride(row) ? " · dirección de su entrega anterior" : ""),
        }),
      ]);
      return order?.created_at ?? nowIso;
    },
    async finish(id, patch) {
      await admin.from("auto_order_trials").update(patch).eq("id", id);
    },
    now: () => Date.now(),
  };
}
