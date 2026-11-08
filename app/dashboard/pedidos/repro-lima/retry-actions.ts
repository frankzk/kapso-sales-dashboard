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
import { approveLimaRetry, RETRY_TRANSPORT_LABEL } from "@/lib/lima-retry-approve";
import { retryApproveNoLocation } from "@/lib/lima-retry-auto";
import { locateRetryOrder, retryGeocodeKeyForStore } from "@/lib/lima-retry-location";
import { loadReproFacts, retryChainOf } from "@/lib/repro-lima-access";
import { CHAIN_EVENT_KINDS } from "@/lib/lima-retry-chain";
import { limaTodayKey } from "@/lib/shipments";
import type { OrderMasterRow } from "@/lib/types";

const PATHS = ["/dashboard/pedidos/repro-lima", "/dashboard/pedidos"];

export interface RetryActionState {
  error?: string;
  notice?: string;
  /** El pedido salió de la bandeja (guía creada, o pasó a Repro Lima). */
  done?: boolean;
}

const TRANSPORT_LABEL = RETRY_TRANSPORT_LABEL;

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
  return { row, admin, facts, chain: retryChainOf(facts, open, limaTodayKey()) } as const;
}

/**
 * «Aprobar»: crea ahora la guía de Aliclik del reintento. Si ya pasó el corte
 * de Aliclik (2:00 p. m.), Aliclik la recoge al día siguiente: la fecha la
 * decide Aliclik, como en la ficha.
 *
 * La cotización, el transporte y la creación son los de la pasada automática
 * (`approveLimaRetry`, lib/lima-retry-approve.ts); aquí quedan el permiso, la
 * RLS y los mensajes de la bandeja.
 *
 * Sin coordenada en el pedido (owner, 08-11-2026: «mismo candado»): la de su
 * dirección en Google, solo el edificio, si el interruptor de
 * Automatizaciones está encendido y la medición de Lima cumple B, como la
 * pasada (`locateRetryOrder`). Si no, dice por qué y no cotiza.
 */
export async function approveAliclikRetry(orderId: string): Promise<RetryActionState> {
  const who = await gate(true);
  if ("error" in who) return { error: who.error };
  const read = await readChain(orderId);
  if ("error" in read) return { error: read.error };
  const { row, admin, facts, chain } = read;
  if (!chain || facts.retryChain.state !== "siguiente") {
    return { error: "Este pedido ya no está en la cadena (se entregó, se acordó otra cosa en Repro Lima o venció). Recarga la lista.", done: true };
  }
  // Otro día que el intento que falló; no espera la devolución (owner, 03-11-2026).
  if (!chain.ready) {
    return { error: "El intento falló hoy: el reintento sale otro día. Apruébalo desde mañana." };
  }

  const where = await locateRetryOrder(admin, row, await retryGeocodeKeyForStore(admin, row.store_id));
  if ("miss" in where.located) return { error: retryApproveNoLocation(where.located.miss) };
  const coordinate = where.located.coordinate;
  const result = await approveLimaRetry({
    admin, row, chain, raw: facts.retryChain, actor: { userId: who.userId }, ...(coordinate ? { coordinate } : {}),
  });
  const { transport } = result;
  switch (result.outcome) {
    case "sin_transporte":
      // Decisión del owner (03-11-2026): el núcleo ya dejó el hecho; el pedido pasa a Repro Lima.
      for (const path of PATHS) revalidatePath(path);
      return { error: `Aliclik no ofrece ${transport} para esta dirección. El pedido pasa a Repro Lima.`, done: true };
    case "no_seleccionable":
      return { error: result.reason ?? `${transport} no se puede agendar ahora. Vuelve a aprobar más tarde.` };
    case "creada":
      for (const path of PATHS) revalidatePath(path);
      return { notice: `Guía con ${transport} creada${result.guide ? `: ${result.guide}` : ""}.${result.coordinateNote ? ` ${result.coordinateNote}` : ""}`, done: true };
    case "simulada":
      // Sin `dry` no ocurre; si ocurriera, nada se creó.
      return { error: "No se creó la guía. Vuelve a aprobar." };
    default:
      if (result.stage !== "creacion") return { error: result.error };
      return { error: `${result.error}${result.locked ? "" : " Si hace falta un motivo o una excepción, créala desde la ficha del pedido."}` };
  }
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
  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind: CHAIN_EVENT_KINDS.dismissed,
    occurred_at: new Date().toISOString(),
    actor: who.userId,
    source: "manual",
    reason: why,
    payload: { attempt: chain.attempt, of: chain.of, transport: TRANSPORT_LABEL[chain.next], why: "manual" },
  });
  for (const path of PATHS) revalidatePath(path);
  return { notice: "Pasó a Repro Lima: la tienda lo atiende como siempre.", done: true };
}
