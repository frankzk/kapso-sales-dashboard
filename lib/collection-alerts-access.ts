// La cola de cobranza: levantar alertas, moverlas por la escalera y cerrarlas.
//
// Las decisiones de a-quién-le-toca viven en `lib/collection-escalation.ts`,
// que es puro. Aquí solo está lo que toca la base.

import type { SupabaseClient } from "@supabase/supabase-js";
import { nextOffer, type AlertRouting, type EscalationStep } from "@/lib/collection-escalation";

export type CollectionAlertKind = "registrado" | "sin_atribuir";

export interface RaiseAlertInput {
  storeId: string;
  kind: CollectionAlertKind;
  orderId?: string | null;
  paymentId?: string | null;
  phone?: string | null;
  inboundMessageId?: string | null;
  amount?: number | null;
  detail?: string | null;
}

/** La escalera de la tienda, en orden. Vacía si nadie la configuró. */
export async function loadEscalation(
  admin: SupabaseClient,
  storeId: string,
): Promise<EscalationStep[]> {
  const { data } = await admin
    .from("store_collection_escalation")
    .select("user_id,minutes,sort")
    .eq("store_id", storeId)
    .order("sort", { ascending: true });
  return ((data ?? []) as { user_id: string; minutes: number }[]).map((r) => ({
    userId: r.user_id,
    minutes: r.minutes,
  }));
}

/**
 * Levanta una alerta y se la ofrece al primero de la escalera. Idempotente por
 * mensaje entrante: Kapso reentrega webhooks, y dos alertas del mismo
 * comprobante son dos personas mirando lo mismo.
 *
 * Nunca lanza: esto cuelga del webhook, y que falle la alerta no puede tumbar
 * el registro del comprobante, que es lo importante.
 */
export async function raiseCollectionAlert(
  admin: SupabaseClient,
  input: RaiseAlertInput,
  nowIso: string = new Date().toISOString(),
): Promise<string | null> {
  try {
    const ladder = await loadEscalation(admin, input.storeId);
    // Sin escalera se crea igual, sin dueño: la alerta existe y se ve en la
    // cola de la tienda. Perderla porque nadie configuró Ajustes sería el peor
    // de los dos errores.
    const primero = ladder[0]?.userId ?? null;
    const { data, error } = await admin
      .from("collection_alerts")
      .insert({
        store_id: input.storeId,
        kind: input.kind,
        order_id: input.orderId ?? null,
        payment_id: input.paymentId ?? null,
        phone: input.phone ?? null,
        inbound_message_id: input.inboundMessageId ?? null,
        amount: input.amount ?? null,
        detail: input.detail ?? null,
        offered_to: primero,
        offered_at: primero ? nowIso : null,
      })
      .select("id")
      .single();
    if (error) return null; // 23505 = reentrega del mismo webhook; nada que hacer
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Hace avanzar la escalera de las alertas abiertas de una tienda. Se llama
 * antes de pintar la cola: así el escalamiento ocurre aunque no haya ningún
 * cron mirando, y el que abre la pantalla ve el estado de verdad.
 */
export async function reconcileCollectionOffers(
  admin: SupabaseClient,
  storeId: string,
  nowMs: number = Date.now(),
): Promise<number> {
  const ladder = await loadEscalation(admin, storeId);
  if (!ladder.length) return 0;
  const { data } = await admin
    .from("collection_alerts")
    .select("id,offered_to,offered_at,passed,claimed_by")
    .eq("store_id", storeId)
    .eq("status", "abierta")
    .limit(200);
  const rows = (data ?? []) as {
    id: string;
    offered_to: string | null;
    offered_at: string | null;
    passed: string[] | null;
    claimed_by: string | null;
  }[];

  let movidas = 0;
  const nowIso = new Date(nowMs).toISOString();
  for (const r of rows) {
    const routing: AlertRouting = {
      offeredTo: r.offered_to,
      offeredAt: r.offered_at,
      passed: r.passed ?? [],
      claimedBy: r.claimed_by,
    };
    const decision = nextOffer(routing, ladder, nowMs);
    if (!decision) continue;
    // La guarda por `offered_at` hace el cambio atómico: si dos pantallas
    // reconcilian a la vez, la segunda ya no encuentra la fila como estaba.
    const q = admin
      .from("collection_alerts")
      .update({ offered_to: decision.offeredTo, offered_at: nowIso, passed: decision.passed, updated_at: nowIso })
      .eq("id", r.id);
    const { error } = await (r.offered_at ? q.eq("offered_at", r.offered_at) : q.is("offered_at", null));
    if (!error) movidas += 1;
  }
  return movidas;
}

/**
 * Cierra las alertas cuyo trabajo YA está hecho, mirando el hecho en vez de
 * esperar a que alguien lo empuje.
 *
 * POR QUÉ HACE FALTA, SI YA SE CIERRAN AL VALIDAR. Porque ese cierre es un
 * empujón al final de `validatePayment`, y un empujón se puede perder: si algo
 * entre medias falla, el pago queda validado —eso ya está escrito— y la alerta
 * se queda abierta PARA SIEMPRE. Pasó el 20-09-2026 con #KP134730: pago
 * validado a las 22:42 y su alerta seguía en la cola cinco horas después,
 * pidiendo un trabajo hecho. Eso es exactamente lo que la cola no puede hacer:
 * el día que enseña trabajo hecho, se deja de mirar.
 *
 * Así que «se cierran con el hecho» se comprueba AL LEER, que es cuando
 * importa, y el empujón al validar pasa a ser una optimización en vez de la
 * única vía. Barato: la cola abierta de una tienda son unas pocas filas.
 */
export async function sweepResolvedAlerts(
  admin: SupabaseClient,
  storeId: string,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const { data } = await admin
    .from("collection_alerts")
    .select("id,payment_id")
    .eq("store_id", storeId)
    .eq("status", "abierta")
    .eq("kind", "registrado")
    .not("payment_id", "is", null)
    .limit(200);
  const rows = (data ?? []) as { id: string; payment_id: string }[];
  if (!rows.length) return 0;

  const { data: pagos } = await admin
    .from("order_payments")
    .select("id,validation_status")
    .in(
      "id",
      rows.map((r) => r.payment_id),
    );
  const estado = new Map(
    ((pagos ?? []) as { id: string; validation_status: string }[]).map((p) => [
      p.id,
      p.validation_status,
    ]),
  );
  // Pendiente de revisión o de completar datos = sigue esperando a una persona.
  // Cualquier otra cosa —validado, rechazado, observado— es una decisión ya
  // tomada, y la alerta no tiene nada más que pedir.
  const resueltas = rows.filter((r) => {
    const s = estado.get(r.payment_id);
    return Boolean(s) && s !== "pendiente_revision" && s !== "info_incompleta";
  });
  if (!resueltas.length) return 0;

  const { error } = await admin
    .from("collection_alerts")
    .update({
      status: "atendida",
      resolution: "el pago ya tiene decisión en Kapta",
      resolved_at: nowIso,
      updated_at: nowIso,
    })
    .in(
      "id",
      resueltas.map((r) => r.id),
    )
    .eq("status", "abierta");
  return error ? 0 : resueltas.length;
}

/**
 * Retira las alertas «no se pudo registrar» de un celular que YA NO DEBE NADA.
 *
 * Una `sin_atribuir` pide una cosa: que alguien averigüe de qué pedido es ese
 * dinero y lo registre. Cuando los pedidos de ese celular están todos cubiertos
 * —porque alguien lo subió a mano, o porque el comprobante bueno entró por otra
 * vía— ya no queda nada que averiguar, y el aviso pasa a ser ruido que además
 * escala de persona en persona. Le pasó a Esmeralda (#KP134470): pedido pagado,
 * validado y con la clave enviada, y su alerta seguía dando vueltas.
 *
 * CONSERVADORA A PROPÓSITO: si de ese celular no consta NINGÚN pedido, la
 * alerta se queda. Ése es el caso en que de verdad no se sabe quién pagó, que
 * es justo para lo que la alerta existe.
 */
export async function sweepUnattributedAlerts(
  admin: SupabaseClient,
  storeId: string,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const { data } = await admin
    .from("collection_alerts")
    .select("id,phone")
    .eq("store_id", storeId)
    .eq("status", "abierta")
    .eq("kind", "sin_atribuir")
    .not("phone", "is", null)
    .limit(100);
  const rows = (data ?? []) as { id: string; phone: string }[];
  if (!rows.length) return 0;

  let cerradas = 0;
  for (const phone of new Set(rows.map((r) => r.phone))) {
    const { data: pedidos } = await admin
      .from("orders")
      .select("id,total_amount")
      .eq("store_id", storeId)
      .eq("customer_phone", phone)
      .order("created_at", { ascending: false })
      .limit(10);
    const ordenes = (pedidos ?? []) as { id: string; total_amount: number | null }[];
    if (!ordenes.length) continue; // de verdad no se sabe de quién es: se queda

    const { data: pagos } = await admin
      .from("order_payments")
      .select("order_id,amount,validation_status")
      .in(
        "order_id",
        ordenes.map((o) => o.id),
      );
    const cubierto = new Map<string, number>();
    for (const p of (pagos ?? []) as {
      order_id: string;
      amount: number | null;
      validation_status: string;
    }[]) {
      // Cuenta lo CARGADO y no solo lo validado: la alerta pide que el
      // comprobante entre, no que se valide. Validarlo es otro trabajo, con su
      // propia alerta.
      if (p.validation_status === "rechazado") continue;
      cubierto.set(p.order_id, (cubierto.get(p.order_id) ?? 0) + (Number(p.amount) || 0));
    }
    const algunoDebe = ordenes.some((o) => {
      const total = o.total_amount == null ? null : Number(o.total_amount);
      if (total == null || !(total > 0)) return false;
      return Math.round((total - (cubierto.get(o.id) ?? 0)) * 100) > 0;
    });
    if (algunoDebe) continue;

    const ids = rows.filter((r) => r.phone === phone).map((r) => r.id);
    const { error } = await admin
      .from("collection_alerts")
      .update({
        status: "atendida",
        resolution: "ese celular ya no tiene saldo pendiente",
        resolved_at: nowIso,
        updated_at: nowIso,
      })
      .in("id", ids)
      .eq("status", "abierta");
    if (!error) cerradas += ids.length;
  }
  return cerradas;
}

/** Cerrarla: validada, subida a mano, o descartada con su motivo. */
export async function resolveCollectionAlert(
  admin: SupabaseClient,
  alertId: string,
  userId: string,
  resolution: string,
  status: "atendida" | "descartada" = "atendida",
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  const { error } = await admin
    .from("collection_alerts")
    .update({ status, resolution, resolved_by: userId, resolved_at: nowIso, updated_at: nowIso })
    .eq("id", alertId)
    .eq("status", "abierta");
  return !error;
}

/**
 * Cierra solas las alertas que un HECHO ya resolvió.
 *
 * POR QUÉ NO HAY UN BOTÓN «ya está». La alerta `registrado` existe porque hay
 * un pago esperando validación: cuando alguien lo valida, el sistema ya sabe
 * que se atendió. Pedirle además un clic de confirmación es hacerle repetir a
 * mano algo que tenemos delante — y es el clic que se deja de dar a la semana,
 * y entonces la cola se llena de alertas cerradas que figuran abiertas.
 *
 * `sin_atribuir` se cierra por el celular: cuando aparece un pago en algún
 * pedido de esa clienta, es que alguien lo subió a mano, que era justo lo que
 * la alerta pedía.
 *
 * Nunca lanza: cerrar una alerta no puede tumbar la validación de un pago.
 */
export async function closeAlertsResolvedBy(
  admin: SupabaseClient,
  input: { storeId: string; orderId?: string | null; paymentId?: string | null; phone?: string | null },
  resolution: string,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  const patch = { status: "atendida", resolution, resolved_at: nowIso, updated_at: nowIso };
  try {
    if (input.paymentId) {
      await admin
        .from("collection_alerts")
        .update(patch)
        .eq("status", "abierta")
        .eq("payment_id", input.paymentId);
    }
    if (input.orderId) {
      await admin
        .from("collection_alerts")
        .update(patch)
        .eq("status", "abierta")
        .eq("order_id", input.orderId);
    }
    // El pago apareció: lo que la alerta «no sé de qué pedido es» pedía ya está.
    if (input.phone) {
      await admin
        .from("collection_alerts")
        .update(patch)
        .eq("status", "abierta")
        .eq("kind", "sin_atribuir")
        .eq("store_id", input.storeId)
        .eq("phone", input.phone);
    }
  } catch {
    /* mejor esfuerzo: la alerta vieja molesta, perder la validación duele */
  }
}
