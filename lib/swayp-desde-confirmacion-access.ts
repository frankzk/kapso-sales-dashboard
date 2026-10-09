// El registro de «Swayp desde Por confirmar» (MOM §11.11): cada pedido enviado
// con el botón, qué hizo Swayp y qué pasó después. Lectura con la sesión del
// usuario (RLS): cada quien ve los casos de sus tiendas.

import { createServerSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import { resolveEmails } from "@/lib/productivity";
import { SWAYP_STATES } from "@/lib/swayp-states";
import {
  SWAYP_DESDE_CONFIRMACION_KIND,
  swaypDesdeConfirmacionOutcome,
  swaypNoEntregoMotivo,
  swaypDesdeConfirmacionFailed,
  type SwaypDesdeConfirmacionOutcome,
  type SwaypNoEntregoMotivo,
} from "@/lib/swayp-desde-confirmacion";

export interface SwaypDesdeConfirmacionRow {
  orderId: string;
  orderName: string | null;
  storeId: string;
  customerName: string | null;
  destination: string | null;
  orderTotal: number | null;
  sentAt: string;
  sentBy: string | null;
  guideCode: string | null;
  swaypState: number | null;
  swaypStateLabel: string | null;
  novelty: string | null;
  outcome: SwaypDesdeConfirmacionOutcome;
  /** Solo si Swayp no entregó. */
  motivo: SwaypNoEntregoMotivo | null;
  /** La salida que tomó el pedido después, si la hubo. */
  nextOutput: { courier: string; guideCode: string | null; deliveryStatus: string } | null;
  macroStage: string | null;
  macroSubstage: string | null;
}

interface GuideRow {
  id: string;
  order_id: string;
  courier: string;
  guide_code: string | null;
  delivery_status: string;
  swayp_state: number | null;
  reported_status: string | null;
  dispatched_at: string | null;
  closed_at: string | null;
  returned_at: string | null;
  updated_at: string | null;
  created_at: string;
}

/** Los últimos `limit` casos, del más reciente al más viejo. */
export async function getSwaypDesdeConfirmacionLog(limit = 300): Promise<SwaypDesdeConfirmacionRow[]> {
  const sb = await createServerSupabase();
  const { data: events, error } = await sb
    .from("order_events")
    .select("order_id,store_id,shipment_id,occurred_at,actor,guide_code")
    .eq("kind", SWAYP_DESDE_CONFIRMACION_KIND)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`No se pudo leer el registro: ${error.message}`);
  const cases = (events ?? []) as {
    order_id: string;
    store_id: string;
    shipment_id: string | null;
    occurred_at: string;
    actor: string | null;
    guide_code: string | null;
  }[];
  if (!cases.length) return [];

  const orderIds = [...new Set(cases.map((c) => c.order_id))];
  const guidesByOrder = new Map<string, GuideRow[]>();
  const masterByOrder = new Map<string, Record<string, unknown>>();
  const cancelledByOrder = new Map<string, string | null>();
  for (const part of chunk(orderIds, 200)) {
    const [guides, master, orders] = await Promise.all([
      sb
        .from("shipments")
        .select("id,order_id,courier,guide_code,delivery_status,swayp_state,reported_status,dispatched_at,closed_at,returned_at,updated_at,created_at")
        .in("order_id", part),
      sb
        .from("order_master")
        .select("order_id,order_name,customer_name,district,province,region,order_total,macro_stage,macro_substage")
        .in("order_id", part),
      sb.from("orders").select("id,cancelled_at").in("id", part),
    ]);
    const failed = [guides, master, orders].find((r) => r.error)?.error;
    if (failed) throw new Error(`No se pudo leer el registro: ${failed.message}`);
    for (const g of (guides.data ?? []) as GuideRow[]) {
      const list = guidesByOrder.get(g.order_id) ?? [];
      list.push(g);
      guidesByOrder.set(g.order_id, list);
    }
    for (const m of (master.data ?? []) as Record<string, unknown>[]) masterByOrder.set(String(m.order_id), m);
    for (const o of (orders.data ?? []) as { id: string; cancelled_at: string | null }[]) {
      cancelledByOrder.set(o.id, o.cancelled_at);
    }
  }
  const emails = await resolveEmails([...new Set(cases.map((c) => c.actor).filter((a): a is string => !!a))]);

  const rows: SwaypDesdeConfirmacionRow[] = [];
  for (const c of cases) {
    const guides = guidesByOrder.get(c.order_id) ?? [];
    const guide = guides.find((g) => g.id === c.shipment_id);
    if (!guide) continue;
    const later = guides
      .filter((g) => g.id !== guide.id && g.created_at > guide.created_at && g.delivery_status !== "anulado")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const outcome = swaypDesdeConfirmacionOutcome({
      guide,
      laterOutputs: later,
      cancelledAt: cancelledByOrder.get(c.order_id) ?? null,
    });
    const m = masterByOrder.get(c.order_id) ?? {};
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    rows.push({
      orderId: c.order_id,
      orderName: text(m.order_name),
      storeId: c.store_id,
      customerName: text(m.customer_name),
      destination: [text(m.district), text(m.province) ?? text(m.region)].filter(Boolean).join(" · ") || null,
      orderTotal: m.order_total == null ? null : Number(m.order_total),
      sentAt: c.occurred_at,
      sentBy: c.actor ? (emails.get(c.actor) ?? null) : null,
      guideCode: guide.guide_code ?? c.guide_code,
      swaypState: guide.swayp_state,
      swaypStateLabel: guide.swayp_state != null ? (SWAYP_STATES[guide.swayp_state] ?? null) : null,
      novelty: guide.reported_status?.startsWith("Swayp · ") ? guide.reported_status.slice("Swayp · ".length) : null,
      outcome,
      motivo: swaypDesdeConfirmacionFailed(guide) && guide.delivery_status !== "entregado" ? swaypNoEntregoMotivo(guide) : null,
      nextOutput: later[0]
        ? { courier: later[0].courier, guideCode: later[0].guide_code, deliveryStatus: later[0].delivery_status }
        : null,
      macroStage: text(m.macro_stage),
      macroSubstage: text(m.macro_substage),
    });
  }
  return rows;
}
