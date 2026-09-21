"use server";

// Las acciones de la cola de cobranza: lo que la pantalla necesita para
// enseñarle a cada uno SUS alertas y dejarle tomarlas, pasarlas o cerrarlas.
//
// El escalamiento se reconcilia AQUÍ, al listar, y no en un cron. Dos razones:
// quien abre la pantalla ve el estado de verdad y no uno de hace media hora, y
// el escalamiento ocurre aunque no haya ningún cron mirando. Cuesta una
// consulta por pasada y se ahorra una pieza que puede caerse en silencio.

import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { resolveAgentNames } from "@/lib/agent-names";
import {
  reconcileCollectionOffers,
  resolveCollectionAlert,
  sweepResolvedAlerts,
  sweepUnattributedAlerts,
} from "@/lib/collection-alerts-access";
import { waitingMinutes } from "@/lib/collection-escalation";

export interface CollectionAlertView {
  id: string;
  storeId: string;
  storeName: string;
  kind: "registrado" | "sin_atribuir";
  orderId: string | null;
  orderName: string | null;
  phone: string | null;
  amount: number | null;
  detail: string | null;
  waitingMinutes: number;
  /** Por cuántas manos pasó antes de llegar aquí. */
  escalations: number;
}

/**
 * Las alertas que me tocan a MÍ ahora mismo, en las tiendas a las que tengo
 * acceso. Primero hace avanzar la escalera; después mira qué quedó en mi mano.
 */
export async function listMyCollectionAlerts(): Promise<CollectionAlertView[]> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  // Las tiendas que este usuario puede ver salen por RLS; la reconciliación va
  // con service-role porque tiene que mover alertas ofrecidas a OTROS.
  const { data: storeRows } = await sb.from("stores").select("id,name");
  const stores = ((storeRows as { id: string; name: string }[] | null) ?? []);
  if (!stores.length) return [];

  const admin = createAdminSupabase();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  for (const s of stores) {
    // Primero se retira lo que ya está hecho y después se hace avanzar la
    // escalera: al revés, una alerta resuelta podría escalar a otra persona
    // justo antes de retirarse, y ésa recibiría un aviso de trabajo hecho.
    await sweepResolvedAlerts(admin, s.id, nowIso);
    await sweepUnattributedAlerts(admin, s.id, nowIso);
    await reconcileCollectionOffers(admin, s.id, nowMs);
  }

  const { data } = await admin
    .from("collection_alerts")
    .select("id,store_id,kind,order_id,phone,amount,detail,created_at,passed")
    .in(
      "store_id",
      stores.map((s) => s.id),
    )
    .eq("status", "abierta")
    .eq("offered_to", user.id)
    .order("created_at", { ascending: true })
    .limit(50);
  const rows = ((data ?? []) as {
    id: string;
    store_id: string;
    kind: "registrado" | "sin_atribuir";
    order_id: string | null;
    phone: string | null;
    amount: number | null;
    detail: string | null;
    created_at: string;
    passed: string[] | null;
  }[]);
  if (!rows.length) return [];

  const orderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))] as string[];
  const { data: pedidos } = orderIds.length
    ? await admin.from("orders").select("id,name").in("id", orderIds)
    : { data: [] };
  const nombre = new Map(
    ((pedidos ?? []) as { id: string; name: string | null }[]).map((o) => [o.id, o.name]),
  );
  const tienda = new Map(stores.map((s) => [s.id, s.name]));

  return rows.map((r) => ({
    id: r.id,
    storeId: r.store_id,
    storeName: tienda.get(r.store_id) ?? "Tienda",
    kind: r.kind,
    orderId: r.order_id,
    orderName: r.order_id ? (nombre.get(r.order_id) ?? null) : null,
    phone: r.phone,
    amount: r.amount == null ? null : Number(r.amount),
    detail: r.detail,
    waitingMinutes: waitingMinutes(r.created_at, nowMs),
    escalations: (r.passed ?? []).length,
  }));
}

async function authorize(alertId: string): Promise<{ userId: string; storeId: string } | null> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  // La lectura va por RLS: si no puede ver la alerta, no puede tocarla.
  const { data } = await sb.from("collection_alerts").select("id,store_id").eq("id", alertId).maybeSingle();
  const row = data as { store_id: string } | null;
  if (!row) return null;
  return { userId: user.id, storeId: row.store_id };
}

/**
 * Descartar: lo único que una persona tiene que cerrar a mano.
 *
 * Las demás se cierran solas con el hecho que las resuelve —el pago validado,
 * el comprobante subido— porque pedir un clic de confirmación de algo que el
 * sistema ya sabe es el clic que se deja de dar a la semana. Esto es para lo
 * que NUNCA se va a resolver solo: una foto de producto que la visión confundió
 * con un Yape, o un comprobante de otra tienda.
 */
export async function discardCollectionAlert(
  alertId: string,
  motivo: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authorize(alertId);
  if (!ctx) return { ok: false, error: "Sin acceso a esta alerta." };
  const ok = await resolveCollectionAlert(
    createAdminSupabase(),
    alertId,
    ctx.userId,
    motivo.trim() || "descartada a mano",
    "descartada",
  );
  return ok ? { ok: true } : { ok: false, error: "Ya estaba cerrada." };
}

/** Los usuarios de la tienda que pueden entrar en la escalera. */
export async function listEscalationCandidates(
  storeId: string,
): Promise<{ id: string; name: string }[]> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];
  const admin = createAdminSupabase();
  const { data: store } = await admin.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (!orgId) return [];
  const { data: mem } = await admin.from("memberships").select("user_id").eq("org_id", orgId);
  const ids = [...new Set(((mem as { user_id: string }[] | null) ?? []).map((m) => m.user_id))];
  if (!ids.length) return [];
  const names = await resolveAgentNames(ids, admin);
  return ids
    .map((id) => ({ id, name: names[id] ?? id.slice(0, 8) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
