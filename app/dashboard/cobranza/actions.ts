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
import { alertVisibleTo, waitingMinutes } from "@/lib/collection-escalation";

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
  /** ¿Es MI turno, o me llegó porque escaló y sigo viéndola? */
  mine: boolean;
  /** Quién la tiene de turno ahora. Para saber a quién preguntar. */
  ownerName: string | null;
}

/**
 * Las alertas que me salen a MÍ, en las tiendas a las que tengo acceso.
 * Primero hace avanzar la escalera; después mira cuáles me alcanzan.
 *
 * ME ALCANZAN LAS MÍAS Y LAS QUE TUVE ANTES. La escalera suma: si a Gerardo se
 * le escaló a Yohalis, Gerardo la sigue viendo —con el aviso de a quién le toca
 * ahora— hasta que se resuelva. Quitársela daría por hecho que ya no va a
 * atenderla, y le ocultaría el final de un trabajo que empezó él.
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

  // Se traen las abiertas de sus tiendas y el filtro lo hace `alertVisibleTo`,
  // que es donde vive la regla. Un `where offered_to = yo` en la consulta dejaba
  // esa definición escrita en SQL, fuera del alcance de cualquier prueba, y es
  // la regla que decide si alguien se entera o no de un cobro pendiente.
  const { data } = await admin
    .from("collection_alerts")
    .select("id,store_id,kind,order_id,phone,amount,detail,created_at,passed,offered_to")
    .in(
      "store_id",
      stores.map((s) => s.id),
    )
    .eq("status", "abierta")
    .order("created_at", { ascending: true })
    .limit(200);
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
    offered_to: string | null;
  }[]).filter((r) =>
    alertVisibleTo(
      { offeredTo: r.offered_to, offeredAt: null, passed: r.passed ?? [], claimedBy: null },
      user.id,
    ),
  );
  if (!rows.length) return [];

  const orderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))] as string[];
  const { data: pedidos } = orderIds.length
    ? await admin.from("orders").select("id,name").in("id", orderIds)
    : { data: [] };
  const nombre = new Map(
    ((pedidos ?? []) as { id: string; name: string | null }[]).map((o) => [o.id, o.name]),
  );
  const tienda = new Map(stores.map((s) => [s.id, s.name]));
  // Quién la tiene de turno, por su nombre: a Gerardo le sirve saber que ahora
  // la mira Yohalis, y a Frank le sirve saber a quién preguntar antes de entrar.
  const duenos = [...new Set(rows.map((r) => r.offered_to).filter(Boolean))] as string[];
  const nombreDe = duenos.length ? await resolveAgentNames(duenos, admin) : {};

  // Las MÍAS primero y, dentro de cada grupo, la que más lleva esperando. Con
  // tres personas viendo la misma cola, lo que no puede pasar es que el trabajo
  // de uno quede debajo del que solo está mirando.
  const vista = rows.map((r) => ({
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
    mine: r.offered_to === user.id,
    ownerName: r.offered_to ? (nombreDe[r.offered_to] ?? null) : null,
  }));
  return vista.sort((a, b) =>
    a.mine === b.mine ? b.waitingMinutes - a.waitingMinutes : a.mine ? -1 : 1,
  );
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
