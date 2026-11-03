"use server";

// La bandeja «Reintentos Aliclik» de Repro Lima (MOM §9.5, entrega 2,
// 03-11-2026): «Aprobar» crea la guía de Aliclik del reintento con el
// transporte que toca, y «A Repro Lima» saca el pedido de la cadena con un
// motivo. Las abren las asesoras y Despacho (`repro_lima.retries`); crear la
// guía pide además `aliclik.create_guide`, como el panel de la ficha.
//
// La cadena se vuelve a calcular aquí, con los hechos de ahora: lo que mostró
// la pantalla es una intención, no un hecho (el paquete pudo no haber vuelto,
// o alguien pudo acordar otra cosa entre la carga y el clic). La guía sale por
// el mismo camino que el botón de la ficha (`createAliclikGuideFor`), con todas
// sus compuertas: el monto, el pin, el historial, la salida adicional en Lima.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { aliclikContextFor, createAliclikGuideFor, previewAliclikGuideFor } from "@/lib/aliclik-guide";
import { isAlidriver, isAutoecom } from "@/lib/aliclik-lima";
import { loadReproFacts, retryChainOf } from "@/lib/repro-lima-access";
import { CHAIN_EVENT_KINDS } from "@/lib/lima-retry-chain";
import type { OrderMasterRow } from "@/lib/types";

const PATHS = ["/dashboard/pedidos/repro-lima", "/dashboard/pedidos"];

export interface RetryActionState {
  error?: string;
  notice?: string;
  /** El pedido salió de la bandeja (guía creada, o pasó a Repro Lima). */
  done?: boolean;
}

const TRANSPORT_LABEL = { autoecom: "AUTOECOM", alidriver: "ALIDRIVER" } as const;

/** Quién pide, con sesión; sin el permiso, el motivo. */
async function gate(createGuide: boolean): Promise<{ userId: string } | { error: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("repro_lima.retries") && !perms.can("repro_lima.manage")) {
    return { error: "Tu rol no permite los reintentos de Aliclik en Lima." };
  }
  if (createGuide && !perms.can("aliclik.create_guide")) {
    return { error: "Tu rol no permite crear guías de Aliclik." };
  }
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  return { userId: user.id };
}

/** El pedido por RLS (un pedido de otra tienda no aparece) y su cadena de ahora. */
async function readChain(orderId: string) {
  const sb = await createServerSupabase();
  const { data } = await sb.from("order_master").select("*").eq("order_id", orderId).maybeSingle();
  if (!data) return { error: "Sin acceso a este pedido." } as const;
  const row = data as unknown as OrderMasterRow;
  const admin = createAdminSupabase();
  const facts = (await loadReproFacts(admin, [orderId])).get(orderId);
  if (!facts) return { error: "No se pudo leer el pedido." } as const;
  const open = facts.open && facts.open.episode_key === facts.episode.key ? facts.open : null;
  return { row, admin, facts, chain: retryChainOf(facts, open) } as const;
}

async function recordChainEvent(
  admin: ReturnType<typeof createAdminSupabase>,
  row: OrderMasterRow,
  actor: string,
  kind: string,
  reason: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind,
    occurred_at: new Date().toISOString(),
    actor,
    source: "manual",
    reason,
    payload,
  });
}

/**
 * «Aprobar»: crea ahora la guía de Aliclik del reintento. Si ya pasó el corte
 * de Aliclik (2:00 p. m.), Aliclik la recoge al día siguiente: la fecha la
 * decide Aliclik, como en la ficha.
 */
export async function approveAliclikRetry(orderId: string): Promise<RetryActionState> {
  const who = await gate(true);
  if ("error" in who) return { error: who.error };
  const read = await readChain(orderId);
  if ("error" in read) return { error: read.error };
  const { row, admin, chain } = read;
  if (!chain) {
    return { error: "Este pedido ya no está en la cadena (se entregó, se acordó otra cosa en Repro Lima o venció). Recarga la lista.", done: true };
  }
  if (!chain.inOffice) {
    return { error: "El paquete todavía no volvió a la oficina: recíbelo en «Devoluciones» y vuelve a aprobar." };
  }
  const transport = TRANSPORT_LABEL[chain.next];

  const { ctx, error: ctxError } = await aliclikContextFor(row, who.userId, { blockAgencia: true });
  if (!ctx) return { error: ctxError ?? "No se pudo preparar la conexión con Aliclik." };
  const preview = await previewAliclikGuideFor(ctx, { modality: "cod" });
  if (!preview.ok) return { error: preview.error ?? "No se pudo cotizar el envío." };

  const wanted = (name: string | null | undefined) => (chain.next === "autoecom" ? isAutoecom(name) : isAlidriver(name));
  const courier = preview.couriers?.find((c) => wanted(c.transportName)) ?? null;
  if (!courier) {
    // Decisión del owner (03-11-2026): sin ese transporte para la dirección,
    // el pedido pasa a Repro Lima.
    await recordChainEvent(admin, row, who.userId, CHAIN_EVENT_KINDS.dismissed,
      `Aliclik no ofrece ${transport} para esta dirección: pasa a Repro Lima.`,
      { attempt: chain.attempt, of: chain.of, transport, why: "sin_transporte" });
    for (const path of PATHS) revalidatePath(path);
    return { error: `Aliclik no ofrece ${transport} para esta dirección. El pedido pasa a Repro Lima.`, done: true };
  }
  if (!courier.selectable) {
    return { error: courier.reason ?? `${transport} no se puede agendar ahora. Vuelve a aprobar más tarde.` };
  }

  const result = await createAliclikGuideFor(ctx, {
    transportId: courier.transportId,
    expectedCollectTotal: preview.collectTotal ?? null,
    motivoSalidaAdicional: `Reintento Aliclik ${chain.attempt} de ${chain.of} aprobado en Repro Lima. ${chain.failedText}.`,
    note: null,
  });
  if (result.error) {
    return { error: `${result.error}${result.locked ? "" : " Si hace falta un motivo o una excepción, créala desde la ficha del pedido."}` };
  }
  await recordChainEvent(admin, row, who.userId, CHAIN_EVENT_KINDS.approved,
    `Reintento Aliclik ${chain.attempt} de ${chain.of} aprobado: guía con ${transport}${result.orderNumber ? ` (${result.orderNumber})` : ""}.`,
    { attempt: chain.attempt, of: chain.of, transport, guide: result.orderNumber ?? null, failed: chain.failedText });
  for (const path of PATHS) revalidatePath(path);
  return { notice: `Guía con ${transport} creada${result.orderNumber ? `: ${result.orderNumber}` : ""}.`, done: true };
}

/** «A Repro Lima»: lo saca de la cadena, con motivo. La tienda lo atiende como siempre. */
export async function dismissAliclikRetry(orderId: string, reason: string): Promise<RetryActionState> {
  const why = reason.trim();
  if (why.length < 3) return { error: "Escribe por qué pasa a Repro Lima." };
  if (why.length > 500) return { error: "El motivo es demasiado largo (máx. 500)." };
  const who = await gate(false);
  if ("error" in who) return { error: who.error };
  const read = await readChain(orderId);
  if ("error" in read) return { error: read.error };
  const { row, admin, chain } = read;
  if (!chain) return { notice: "Este pedido ya no estaba en la cadena.", done: true };
  await recordChainEvent(admin, row, who.userId, CHAIN_EVENT_KINDS.dismissed, why,
    { attempt: chain.attempt, of: chain.of, transport: TRANSPORT_LABEL[chain.next], why: "manual" });
  for (const path of PATHS) revalidatePath(path);
  return { notice: "Pasó a Repro Lima: la tienda lo atiende como siempre.", done: true };
}
