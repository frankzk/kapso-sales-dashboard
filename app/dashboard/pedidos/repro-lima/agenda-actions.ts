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
//   días), con el courier elegido (owner, 16-11-2026; 0348). Con GF Courier,
//   la guía GF queda creada para ese día al programar; con Aliclik o Swayp,
//   el courier queda guardado y la guía GF automática no lo toma; sin
//   courier, como antes (con GF Courier por API, la guía automática de ese día);
// - un no entregado «Por acordar» (sin acuerdo) con un courier elegido: un
//   acuerdo sin llamada (`programReproWithoutCall`, canal `sin_contacto`);
// - lo demás (una guía viva, un rótulo de Grupo GF, un no entregado sin
//   courier) no se agenda desde la lista: se dice por qué.
// No inventa estados ni salidas, y no toca el programa de Grupo GF fuera del
// camino del acuerdo.

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/db";
import { scheduleOrderDispatch } from "@/app/dashboard/pedidos/actions";
import { moveReproAgreement, programReproWithoutCall } from "@/app/dashboard/pedidos/repro-lima/actions";
import { createGfGuideFor } from "@/lib/gf-courier-guide";
import { DISPATCH_COURIER_LABEL, isDispatchCourier } from "@/lib/dispatch-date";
import { programDayLabel } from "@/lib/dispatch-day";
import { orderDrawerHref } from "@/lib/order-drawer-href";
import { orderHasCoordinate, reproCourierStoreProblem, reproNeedsCoordinate } from "@/lib/repro-lima";
import { limaClock } from "@/lib/grupo-gf-courier";
import { programCourierProblem } from "@/lib/repro-lima-blocks";
import { requireReproLima, REPRO_OUTSIDE_STORE } from "@/lib/repro-lima-access";
import { loadReproFacts, REPRO_LIMA_PATH } from "@/lib/repro-lima-program";
import type { ReproChannel } from "@/lib/repro-lima";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AgendarResult {
  error?: string;
  notice?: string;
  /** Por dónde fue: el acuerdo con la clienta, «Programar envío» o un acuerdo nuevo sin llamada. */
  path?: "acuerdo" | "envio" | "acuerdo_nuevo";
  /** La ficha del pedido en la Mesa de ruta: GF Courier no anuló o no creó la guía del día nuevo. */
  href?: string;
}

/**
 * «Programar envío» con GF Courier: la guía GF queda creada para ese día al
 * programar (owner, 16-11-2026: «en el caso de GF Courier ya se crea incluso
 * hasta la guía para la fecha que se programe»). Es la misma creación que la
 * del acuerdo (`createGfGuideFor` con `scheduledFor`). El día ya quedó
 * guardado: si GF no la crea, se dice y se enlaza a la Mesa de ruta; la guía
 * GF automática de ese día la vuelve a intentar.
 */
async function gfGuideForDispatch(admin: ReturnType<typeof createAdminSupabase>, orderId: string, day: string, userId: string): Promise<AgendarResult> {
  const saved = `Envío programado para el ${programDayLabel(day)} con ${DISPATCH_COURIER_LABEL.gf_courier}.`;
  const href = orderDrawerHref(orderId, "operar", { pathname: REPRO_LIMA_PATH });
  try {
    const created = await createGfGuideFor(orderId, { userId, reason: `Repro Lima: envío programado para el ${programDayLabel(day)} con GF Courier.`, scheduledFor: day }, admin);
    if (created.ok) return { notice: `${saved} Guía ${created.trackingId} ${created.adopted ? "vinculada" : "creada"} para ese día.` };
    return {
      notice: saved,
      error: created.pending
        ? `GF Courier no respondió a tiempo: la guía del ${programDayLabel(day)} quedó creándose (Kapta la vincula sola).`
        : `GF Courier no creó la guía: ${created.error.replace(/\.?$/, ".")} La guía automática de ese día lo vuelve a intentar, o créala desde la Mesa de ruta.`,
      href,
    };
  } catch (error) {
    return { notice: saved, error: `GF Courier no creó la guía: ${error instanceof Error ? error.message : String(error)}`, href };
  }
}

/** Por qué un pedido no se agenda desde la lista (la misma regla que `agendarPath`). */
function blockedWhy(stage: string | null, substage: string | null): string {
  if (stage === "en_curso" && substage === "por_reprogramar_lima") return "Elige con qué courier sale, o acuerda el día con la clienta en «Atender».";
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
  /**
   * Con qué courier sale (`DispatchCourier`): en «Programar envío» es opcional;
   * un no entregado sin acuerdo lo necesita. Un acuerdo conserva el suyo.
   */
  courier?: string | null;
  /** Un `crypto.randomUUID()` por pedido (el acuerdo registra una llamada). */
  operationId: string;
}): Promise<AgendarResult> {
  const result = await agendar(input);
  // Una lectura por acción (25-11-2026): lo guardado vuelve con la pantalla en
  // esta misma respuesta y el tablero ya no la pide otra vez. Las acciones de
  // dentro ya revalidan cuando cambian algo; esto lo deja dicho para todas.
  if (result.notice) revalidatePath(REPRO_LIMA_PATH);
  return result;
}

async function agendar(input: Parameters<typeof agendarReproLima>[0]): Promise<AgendarResult> {
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
    const courier = input.courier ? (isDispatchCourier(input.courier) ? input.courier : undefined) : null;
    if (courier === undefined) return { error: "Ese courier no se puede programar." };
    // La subetapa es la del Master: sin rótulo ni guía. «Programar envío» la vuelve a comprobar.
    if (f.order.macro_stage === "preparacion" && f.order.macro_substage === "por_generar_rotulo") {
      // La misma regla que el acuerdo: GF Courier solo con su API, Grupo GF nunca con ella.
      const storeProblem = courier ? reproCourierStoreProblem(courier, Boolean(f.gfCourierApi)) : null;
      if (storeProblem) return { error: storeProblem, path: "envio" };
      // Lo que su guía necesita, dicho al programar y no la mañana del día (0349):
      // Swayp arma su ruta la víspera y Aliclik no crea la guía sin la ubicación.
      const courierProblem = courier ? programCourierProblem(courier, day, limaClock(new Date()).day, !reproNeedsCoordinate("aliclik", orderHasCoordinate(f.order))) : null;
      if (courierProblem) return { error: courierProblem, path: "envio" };
      const result = await scheduleOrderDispatch(input.orderId, { date: day, note: input.note ?? null, courier });
      if (result.error || courier !== "gf_courier") {
        return { ...(result.error ? { error: result.error } : {}), ...(result.notice ? { notice: result.notice } : {}), path: "envio" };
      }
      return { ...(await gfGuideForDispatch(admin, input.orderId, day, scope.userId)), path: "envio" };
    }
    if (f.inStage && courier) {
      const result = await programReproWithoutCall({ orderId: input.orderId, day, courier, operationId: input.operationId });
      return {
        ...(result.error ? { error: result.error } : {}),
        ...(result.notice ? { notice: result.notice } : {}),
        ...(result.href ? { href: result.href } : {}),
        path: "acuerdo_nuevo",
      };
    }
    return { error: blockedWhy(f.order.macro_stage, f.order.macro_substage) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
