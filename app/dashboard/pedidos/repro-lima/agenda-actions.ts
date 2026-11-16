"use server";

// «Agendar» y «Mover a…» de Repro Lima (owner, 15-11-2026; MOM §9.5): poner
// el día de un pedido sin abrir la ficha. No hay una escritura nueva: cada
// pedido va por la acción que ya existe para su situación, con sus guardas y
// sus permisos, y el camino se decide aquí con los hechos de ahora (lo que
// mostró la lista es una intención):
// - con un acuerdo con la clienta, se cambia su día con el mismo courier
//   (`moveReproAgreement`: el candado del caso, «Qué hacer con la caja» y la
//   misma RPC que «Confirma fecha», `repro_lima.manage`). Con GF Courier,
//   eso anula la guía GF del día anterior si GF no la asignó y crea la del
//   nuevo (§29.17); si GF no responde, el aviso enlaza a la Mesa de ruta;
// - sin acuerdo y en Preparación · Por generar rótulo, «Programar envío»
//   (`scheduleOrderDispatch`, §6.2: `master.edit`, la ubicación y hasta 45
//   días). Con GF Courier por API, ese día la guía se crea sola (§29.17);
// - lo demás (un no entregado sin acuerdo, una guía viva, un rótulo de Grupo
//   GF) no se agenda desde la lista: se dice por qué.
// No inventa estados ni salidas, y no toca el programa de Grupo GF fuera del
// camino del acuerdo.

import { createAdminSupabase } from "@/lib/db";
import { scheduleOrderDispatch } from "@/app/dashboard/pedidos/actions";
import { moveReproAgreement } from "@/app/dashboard/pedidos/repro-lima/actions";
import { requireReproLima, REPRO_OUTSIDE_STORE } from "@/lib/repro-lima-access";
import { loadReproFacts } from "@/lib/repro-lima-program";
import type { ReproChannel } from "@/lib/repro-lima";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AgendarResult {
  error?: string;
  notice?: string;
  /** Por dónde fue: el acuerdo con la clienta o «Programar envío». */
  path?: "acuerdo" | "envio";
  /** La ficha del pedido en la Mesa de ruta: GF Courier no anuló o no creó la guía del día nuevo. */
  href?: string;
}

/** Por qué un pedido no se agenda desde la lista (la misma regla que `agendarPath`). */
function blockedWhy(stage: string | null, substage: string | null): string {
  if (stage === "en_curso" && substage === "por_reprogramar_lima") return "Primero acuerda el día y el courier con la clienta en «Atender».";
  if (stage === "en_curso") return "Ya tiene guía: el día lo lleva el courier.";
  return "Ya tiene rótulo o guía: acuerda el día con la clienta en «Atender».";
}

export async function agendarReproLima(input: {
  orderId: string;
  day: string;
  /** Con un acuerdo: si se habló por llamada o por WhatsApp. */
  channel?: ReproChannel | null;
  /** «Programar envío»: nota opcional del historial. */
  note?: string | null;
  /** Un `crypto.randomUUID()` por pedido (el acuerdo registra una llamada). */
  operationId: string;
}): Promise<AgendarResult> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  if (!UUID.test(input.orderId ?? "")) return { error: "No encontramos el pedido." };
  const day = input.day?.trim() ?? "";
  if (!DAY_RE.test(day)) return { error: "Elige una fecha válida." };
  const admin = createAdminSupabase();
  try {
    const f = (await loadReproFacts(admin, [input.orderId])).get(input.orderId) ?? null;
    if (!f?.storeId || !f.order) return { error: "No encontramos el pedido." };
    if (!scope.storeIds.has(f.storeId)) return { error: REPRO_OUTSIDE_STORE };
    if (f.cancelled) return { error: "La venta está anulada en la tienda: no se agenda." };
    const open = f.open && f.open.episode_key === f.episode.key ? f.open : null;
    if (open?.agreed_on && open.agreement_call_id) {
      const result = await moveReproAgreement({ orderId: input.orderId, day, channel: input.channel ?? "llamada", operationId: input.operationId });
      return {
        ...(result.error ? { error: result.error } : {}),
        ...(result.notice ? { notice: result.notice } : {}),
        ...(result.href ? { href: result.href } : {}),
        path: "acuerdo",
      };
    }
    // La subetapa es la del Master: sin rótulo ni guía. «Programar envío» la vuelve a comprobar.
    if (f.order.macro_stage === "preparacion" && f.order.macro_substage === "por_generar_rotulo") {
      const result = await scheduleOrderDispatch(input.orderId, { date: day, note: input.note ?? null });
      return { ...(result.error ? { error: result.error } : {}), ...(result.notice ? { notice: result.notice } : {}), path: "envio" };
    }
    return { error: blockedWhy(f.order.macro_stage, f.order.macro_substage) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
