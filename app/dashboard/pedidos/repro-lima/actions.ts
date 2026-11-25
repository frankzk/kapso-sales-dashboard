"use server";

// «Repro Lima» (fase 1, entrega 1a; MOM §9.5): tomar el caso, registrar la
// llamada y programar el acuerdo. Cada acción pide `repro_lima.manage` y la
// tienda del pedido (`requireReproLima`), y escribe con el cliente de servicio
// después de comprobarlo (D12). Las dos RPC (`lima_repro_claim`,
// `lima_repro_record`) llevan el candado y el episodio; el resto son
// escrituras condicionales, como el candado de Envíos.
//
// Lo que NO hace: crear salidas (otro courier va por la Mesa de ruta, D7),
// El cierre operativo sigue separado de la anulación comercial (§11.5).
// La excepción es GF Courier por API (owner, 15-11-2026; MOM §9.5): un acuerdo
// con GF Courier deja la guía GF creada para el día acordado (`createGfGuideFor`)
// y, si había una viva sin asignar, la anula antes (`cancelGfGuideFor`).

import { gfCancelRequestedText, gfDateBoxText } from "@/lib/gf-courier-status";
import { sameCourier } from "@/lib/shipment-output";
import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/db";
import { resolveAgentName, resolveAgentNames } from "@/lib/agent-names";
import {
  loadReproLima,
  requireReproLima,
  REPRO_OUTSIDE_STORE,
  type ReproRow,
  type ReproScope,
} from "@/lib/repro-lima-access";
import {
  closeStaleReproCases,
  loadReproFacts,
  materializeAgreement,
  reproCaseProblem,
  REPRO_CASE_COLUMNS,
  REPRO_LIMA_PATH,
  type MaterializeResult,
  type ReproCaseRow,
  type ReproFacts,
} from "@/lib/repro-lima-program";
import { clearGfDispatchPrograms, type GfProgramRow } from "@/lib/gf-dispatch-program";
import { cancelGfGuideFor, createGfGuideFor, type GfCancelResult, type GfGuideResult, changeGfGuideDateFor, type GfDateResult } from "@/lib/gf-courier-guide";
import { loadLimaCourierAutoActiveStores } from "@/lib/lima-courier-auto-server";
import { loadGroupGfCourierRouteCheck } from "@/lib/grupo-gf-courier-route-access";
import { limaClock } from "@/lib/grupo-gf-courier";
import { validarMotivoDescarte } from "@/lib/recovery-discard";
import { orderDrawerHref } from "@/lib/order-drawer-href";
import { limaDay, programDayLabel } from "@/lib/dispatch-day";
import { dispatchCoordinateInput } from "@/lib/dispatch-date";
import { saveOrderCoordinate } from "@/lib/order-coordinate-save";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { cancelWooOrder } from "@/app/dashboard/pedidos/woo-cancel-actions";
import { cancelLegacyShopifySale } from "@/app/dashboard/pedidos/legacy-sale-cancel-actions";
import { endWooSalePendingReturn } from "@/app/dashboard/pedidos/woo-sale-return-actions";
import { wooKaptaCancelOperationId } from "@/lib/woo-cancel-server";
import { legacySaleCancelOperationId } from "@/lib/legacy-sale-cancel-server";
import { priorOutputsWith, reproBoxAction } from "@/lib/repro-box-action";
import {
  agreementDateProblem,
  faltaSalidaWhy,
  gfAgreementGuidePlan,
  gfGuideAssignedMessage,
  isAgreementBoxAction,
  isReproChannel,
  isReproCourier,
  orderHasCoordinate,
  reproNeedsCoordinate,
  isReproOutcome,
  materializationPlan,
  nextCallProblem,
  normalizeReproChanges,
  programOrigin,
  reproCallTimeLabel,
  reproCourierDisabledReason,
  reproCourierName,
  reproCourierStoreProblem,
  reproEventNote,
  reproGfGuideReason,
  reproProgramReason,
  GRUPO_GF_NOT_IN_GF_STORE,
  REPRO_CLAIM_TTL_MINUTES,
  REPRO_COURIER_LABEL,
  REPRO_GF_CANCEL_NOTE,
  REPRO_GF_CANCEL_REASON,
  isLiveGfGuide,
  reproGfOtherCourierNote,
  reproGfOtherCourierReason,
  type BoxAction,
  type ReproChannel,
  type ReproChanges,
  type ReproCourier,
  type ReproOutcome,
} from "@/lib/repro-lima";

const COURIER_PATH = "/dashboard/courier";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 1000;

const CASE_GONE = "Ya no tienes este caso: vuelve a tomarlo.";
const OUT_OF_STAGE = "Este pedido ya no está en «Por reprogramar Lima».";
const NEEDS_REOPEN = "Este pedido se cerró con «Desarmar y cerrar». «Volver a atender» lo reabre.";
const BOX_CHANGED = "La caja cambió mientras decidías: revisa «Qué hacer con la caja» y vuelve a guardar.";

type Admin = ReturnType<typeof createAdminSupabase>;

export interface ReproActionResult {
  error?: string;
  notice?: string;
  /** La ficha del pedido sobre Repro Lima, en la Mesa de ruta (otro courier, D7). */
  href?: string;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** «#KP138029», «KP138029» o «kp138029»: el mismo pedido (segundo clic, §11.5). */
function sameOrderName(typed: string | null | undefined, real: string | null | undefined): boolean {
  const norm = (value: string | null | undefined) => (value ?? "").trim().replace(/^#/, "").toLowerCase();
  return Boolean(norm(real)) && norm(typed) === norm(real);
}

/** El caso, si es de una tienda a su alcance. */
async function caseInScope(admin: Admin, scope: ReproScope, caseId: string): Promise<ReproCaseRow | { error: string }> {
  if (!isUuid(caseId)) return { error: "No encontramos el caso." };
  const { data, error } = await admin.from("lima_repro_cases").select(REPRO_CASE_COLUMNS).eq("id", caseId).maybeSingle();
  if (error) return { error: error.message };
  const row = data as ReproCaseRow | null;
  if (!row) return { error: "No encontramos el caso." };
  if (!scope.storeIds.has(row.store_id)) return { error: REPRO_OUTSIDE_STORE };
  return row;
}

async function factsOf(admin: Admin, orderId: string): Promise<ReproFacts | null> {
  return (await loadReproFacts(admin, [orderId])).get(orderId) ?? null;
}

// ---------------------------------------------------------------------------
// El candado (D10): 10 minutos, latido cada 4, solo dentro de Repro Lima
// ---------------------------------------------------------------------------

export type ClaimReproResult =
  | { caseId: string; until: string | null }
  | {
      error: string;
      /** Cerrado con «Desarmar y cerrar» en este episodio: «Volver a atender» lo reabre (E29). */
      needsReopen?: boolean;
      /** Otra persona lo atiende: la hoja se abre para leer. */
      holder?: { name: string | null; until: string | null };
      caseId?: string;
    };

/**
 * «Atender»: abre el caso si no hay (D1) y lo toma por 10 minutos. Un caso
 * cerrado con «Desarmar y cerrar» del mismo episodio solo se reabre con
 * `reopen` (segundo clic, E29). La RPC lo vuelve a mirar dentro de su candado
 * (`needs_reopen`): un cierre que llega entre esta lectura y la RPC no se
 * reabre solo.
 */
export async function claimReproCase(orderId: string, opts: { reopen?: boolean } = {}): Promise<ClaimReproResult> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  if (!isUuid(orderId)) return { error: "No encontramos el pedido." };
  const admin = createAdminSupabase();
  try {
    const f = await factsOf(admin, orderId);
    if (!f?.storeId || !f.order) return { error: "No encontramos el pedido." };
    if (!scope.storeIds.has(f.storeId)) return { error: REPRO_OUTSIDE_STORE };
    if (!(f.inStage || f.attentionEligible) || f.cancelled) {
      if (f.open) await closeStaleReproCases(admin, [f.open.id], "fuera_de_etapa");
      revalidatePath(REPRO_LIMA_PATH);
      return { error: f.inStage ? OUT_OF_STAGE : "Este pedido ya no está pendiente de entrega en Lima." };
    }
    if (
      !f.open && !opts.reopen &&
      f.latestClosed?.close_reason === "desarmar_cerrar" && f.latestClosed.episode_key === f.episode.key
    ) {
      return { error: NEEDS_REOPEN, needsReopen: true };
    }
    const { data, error } = await admin.rpc("lima_repro_claim", {
      p_order: orderId,
      p_store: f.storeId,
      p_actor: scope.userId,
      p_episode: f.episode.key,
      p_episode_at: f.episode.at,
      p_ttl_minutes: REPRO_CLAIM_TTL_MINUTES,
      p_reopen: Boolean(opts.reopen),
    });
    if (error) return { error: error.message };
    const claim = data as { case_id?: string | null; claimed: boolean; until?: string | null; holder?: string | null; needs_reopen?: boolean };
    // Tomar el caso NO vuelve a pedir la pantalla (25-11-2026): la fila se
    // marca en el navegador (`holdReproLimaClaim`). Solo se relee cuando la
    // lista estaba vieja: otra persona lo cerró o lo tiene tomado.
    const listWasStale = Boolean(claim.needs_reopen) || !claim.claimed || !claim.case_id;
    if (listWasStale) revalidatePath(REPRO_LIMA_PATH);
    if (claim.needs_reopen) return { error: NEEDS_REOPEN, needsReopen: true };
    if (!claim.claimed || !claim.case_id) {
      const name = claim.holder ? await resolveAgentName(claim.holder, admin) : null;
      return { error: `${name ?? "Otra persona"} está atendiendo este pedido.`, ...(claim.case_id ? { caseId: claim.case_id } : {}), holder: { name, until: claim.until ?? null } };
    }
    return { caseId: claim.case_id, until: claim.until ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** El latido de la hoja: renueva SOLO un candado propio y vivo. No revalida la página. */
export async function renewReproCase(caseId: string): Promise<{ until: string } | { error: string }> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  const admin = createAdminSupabase();
  const c = await caseInScope(admin, scope, caseId);
  if ("error" in c) return c;
  const now = new Date();
  const until = new Date(now.getTime() + REPRO_CLAIM_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await admin
    .from("lima_repro_cases")
    .update({ claimed_until: until })
    .eq("id", caseId)
    .eq("claimed_by", scope.userId)
    .gt("claimed_until", now.toISOString())
    .is("closed_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: CASE_GONE };
  return { until };
}

/**
 * «Soltar» o cerrar la hoja: suelta SOLO el candado propio. No revalida la
 * página (25-11-2026): soltar no cambia nada que la lista tenga que releer, y
 * la fila deja de decir «Lo atiendes tú» en el navegador (`dropReproLimaClaim`).
 */
export async function releaseReproCase(caseId: string): Promise<ReproActionResult> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  const admin = createAdminSupabase();
  const c = await caseInScope(admin, scope, caseId);
  if ("error" in c) return c;
  await admin
    .from("lima_repro_cases")
    .update({ claimed_by: null, claimed_until: null })
    .eq("id", caseId)
    .eq("claimed_by", scope.userId);
  return { notice: "Liberado." };
}

// ---------------------------------------------------------------------------
// La llamada (§11.4): cuatro resultados, una RPC
// ---------------------------------------------------------------------------

export interface RegisterReproCallInput {
  caseId: string;
  /** Un `crypto.randomUUID()` por formulario: un doble clic no registra dos llamadas. */
  operationId: string;
  outcome: ReproOutcome;
  /** `llamada` o `whatsapp`. `sin_contacto` es solo de `closeReproCase`. */
  channel: ReproChannel;
  note?: string | null;
  /** ISO con desfase (`limaDateTimeIso`). Obligatoria en «Llamar después»; opcional en «No contesta». */
  nextCallAt?: string | null;
  agreedOn?: string | null;
  courier?: ReproCourier | null;
  changes?: Partial<ReproChanges> | null;
  /** La acción de caja que vio quien decide: si cambió, se pide revisarla. */
  expectedBoxAction?: BoxAction | null;
  /** «Ya no lo quiere»: el pedido escrito en el segundo clic (§11.5). */
  confirmOrderName?: string | null;
  /** Confirmación comercial explícita, con las mismas acciones y permisos de Operar. */
  cancelSale?: "woocommerce" | "woocommerce_return" | "shopify_history";
  /**
   * «Confirma fecha» con Aliclik en un pedido sin coordenada: el enlace de
   * Google Maps o el par (06-11-2026). Se guarda en el pedido.
   */
  coordinate?: string | null;
  /**
   * «Guardar y pasar al siguiente» (25-11-2026): la ficha pasa al siguiente en el
   * acto y pide la lista de fondo, así que la acción no la trae en su respuesta.
   * Solo se cumple cuando la ficha de verdad va a pasar (sin error, sin Mesa de
   * ruta, sin venta anulada y sin tocar el programa); si no, se revalida como siempre.
   */
  deferRefresh?: boolean;
}

export interface RegisterReproCallResult extends ReproActionResult {
  /** La acción no trajo la pantalla (`deferRefresh`): quien guarda la pide después. */
  refreshDeferred?: boolean;
  /** La venta terminó aunque no se haya podido registrar después la llamada. */
  saleCancelled?: boolean;
  callId?: string;
  /** El mismo envío ya estaba guardado (doble clic o reintento de red). */
  duplicate?: boolean;
  /** La caja o lo que cambió no coincide con lo que se ve: hay que recargar el caso. */
  boxChanged?: boolean;
  /** Quien guarda ya no tiene el caso: hay que volver a tomarlo. */
  claimLost?: boolean;
}

/** Registra una llamada y hace lo que sigue (programar o quitar la fecha). */
export async function registerReproCall(input: RegisterReproCallInput): Promise<RegisterReproCallResult> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  if (input.channel === "sin_contacto") return { error: "«Desarmar y cerrar sin llamada» va por su propio botón." };
  return recordCall(scope, input);
}

/**
 * «Desarmar y cerrar sin llamada» (plazo sugerido, decisión 10): lo mismo que
 * «Ya no lo quiere» por el canal `sin_contacto`, en la misma RPC (E2). No
 * anula la venta.
 */
export async function closeReproCase(input: {
  caseId: string;
  operationId: string;
  note: string;
  confirmOrderName: string;
}): Promise<RegisterReproCallResult> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  return recordCall(scope, {
    caseId: input.caseId,
    operationId: input.operationId,
    outcome: "no_quiere",
    channel: "sin_contacto",
    note: input.note,
    confirmOrderName: input.confirmOrderName,
  });
}

async function recordCall(scope: ReproScope, input: RegisterReproCallInput): Promise<RegisterReproCallResult> {
  if (!isUuid(input.caseId)) return { error: "No encontramos el caso." };
  if (!isUuid(input.operationId)) return { error: "Vuelve a abrir el caso: falta el identificador del envío." };
  if (!isReproOutcome(input.outcome)) return { error: "Elige el resultado de la llamada." };
  if (!isReproChannel(input.channel)) return { error: "Elige si fue llamada o WhatsApp." };
  if (input.cancelSale && (input.outcome !== "no_quiere" || input.channel === "sin_contacto" ||
    !["woocommerce", "woocommerce_return", "shopify_history"].includes(input.cancelSale))) {
    return { error: "La anulación de venta requiere «Ya no lo quiere» y su confirmación." };
  }
  const admin = createAdminSupabase();
  let saleNotice: string | null = null;
  const saleDone = (error: string): RegisterReproCallResult => ({ saleCancelled: true,
    notice: saleNotice ?? "La venta ya está anulada.", error: `La venta terminó, pero falta registrar la llamada y su cierre: ${error}` });
  try {
    const c = await caseInScope(admin, scope, input.caseId);
    if ("error" in c) return c;
    const f = await factsOf(admin, c.order_id);
    if (!f?.order) return { error: "No encontramos el pedido." };
    const now = new Date();
    const clock = limaClock(now);
    const note = input.note?.trim().slice(0, NOTE_MAX) || null;
    if (input.cancelSale) {
      const reason = validarMotivoDescarte(note);
      if ("error" in reason) return { error: reason.error };
      if ((note?.length ?? 0) > 500) return { error: "El motivo de anulación admite hasta 500 caracteres." };
      if (!sameOrderName(input.confirmOrderName, f.order.order_name)) return { error: "Confirma el nombre del pedido para anular la venta." };
    }

    // Un reintento del mismo envío no se vuelve a validar: la RPC devuelve
    // el duplicado (o lo rechaza si el contenido es otro, E3).
    const { data: prior, error: priorError } = await admin.from("lima_repro_calls").select("id").eq("operation_id", input.operationId).maybeSingle();
    if (input.cancelSale && priorError) return { error: "No se pudo comprobar el registro anterior. No se solicitó la anulación." };
    // Recuperación de una respuesta perdida: solo nuestro intento comercial,
    // del mismo actor y pedido, permite registrar la llamada tras anularlo.
    let recoveringSale = false;
    if (input.cancelSale) {
      const operation = input.cancelSale === "woocommerce"
        ? wooKaptaCancelOperationId(c.order_id, input.operationId)
        : legacySaleCancelOperationId(c.order_id, input.operationId);
      const { data: event, error } = await admin.from("order_events").select("id").eq("order_id", c.order_id)
        .eq("operation_id", operation).eq("actor", scope.userId)
        .in("kind", ["cancelled_woocommerce", "legacy_shopify_sale_cancelled", "woo_sale_ended_pending_return"]).maybeSingle();
      if (error) return { error: "No se pudo comprobar la anulación anterior. Actualiza antes de reintentar." };
      recoveringSale = Boolean(event);
      if (recoveringSale) saleNotice = "La venta ya terminó con esta confirmación.";
      // Un envío ya usado para un cierre sin anulación no autoriza convertirlo
      // luego en otra operación comercial, ni omitir el candado.
      if (prior && !recoveringSale) return { error: "Esta llamada ya se guardó sin anular la venta. Abre una atención nueva." };
    }

    let nextCallAt: string | null = null;
    let agreedOn: string | null = null;
    let courier: ReproCourier | null = null;
    let changes: ReproChanges = normalizeReproChanges(null);
    let boxAction: BoxAction | null = null;
    let coordinate: { lat: number; lng: number } | null = null;
    if (input.outcome === "llamar_despues" || input.outcome === "no_contesta") nextCallAt = input.nextCallAt?.trim() || null;
    if (input.outcome === "confirma") {
      agreedOn = input.agreedOn?.trim() || null;
      courier = isReproCourier(input.courier) ? input.courier : null;
      changes = normalizeReproChanges(input.changes);
      boxAction = isAgreementBoxAction(input.expectedBoxAction) ? input.expectedBoxAction : null;
    }
    if (input.outcome === "no_quiere") boxAction = "desarmar_cerrar";

    if (!prior) {
      if (c.closed_at) return recoveringSale ? saleDone("El caso ya está cerrado.") : { error: "El caso ya está cerrado." };
      const problem = recoveringSale ? null : reproCaseProblem(f, c);
      if (problem) {
        if (problem.reason !== "cambio") {
          await closeStaleReproCases(admin, [c.id], problem.reason);
          revalidatePath(REPRO_LIMA_PATH);
        }
        // «El pedido cambió mientras lo abrías»: la hoja relee los hechos y
        // conserva lo escrito (C3).
        return problem.reason === "cambio" ? { error: problem.message, boxChanged: true } : { error: problem.message };
      }
      if (c.claimed_by !== scope.userId || !c.claimed_until || Date.parse(c.claimed_until) <= now.getTime()) {
        if (recoveringSale) return saleDone(CASE_GONE);
        return { error: CASE_GONE, claimLost: true };
      }

      if (input.outcome === "llamar_despues") {
        const problemCall = nextCallProblem(nextCallAt, now);
        if (problemCall) return { error: problemCall };
      }
      if (input.outcome === "no_contesta" && nextCallAt) {
        const problemCall = nextCallProblem(nextCallAt, now);
        if (problemCall) return { error: problemCall };
      }

      if (input.outcome === "confirma") {
        if (!agreedOn || !DAY_RE.test(agreedOn)) return { error: "Elige el día que acordaste con el cliente." };
        if (!courier) return { error: "Elige con qué courier sale." };
        const disabled = reproCourierDisabledReason(courier);
        if (disabled) return { error: disabled };
        // La tienda decide: GF Courier solo con su API, y Grupo GF nunca con ella
        // («Tomar» ya rechaza esos pedidos, §29.17). La hoja ofrece lo mismo.
        const storeProblem = reproCourierStoreProblem(courier, Boolean(f.gfCourierApi));
        if (storeProblem) return { error: storeProblem };
        let cutoff = f.provider?.same_day_cutoff ?? null;
        if (courier === "propio") {
          // La misma comprobación que la Mesa de ruta: cobertura, contrato y tarifa.
          const check = await loadGroupGfCourierRouteCheck(admin, {
            store_id: f.order.store_id,
            region: f.order.region,
            province: f.order.province,
            district: f.order.district,
          }, agreedOn);
          if (!check.eligible) return { error: check.reason };
          cutoff = check.sameDayCutoff;
        }
        const decided = reproBoxAction({
          outcome: "confirma",
          courier,
          changes,
          box: f.box,
          ownLiveCourier: f.ownLive?.courier ?? null,
          lastFailedCourier: f.failedOutput?.courier ?? null,
          otherLiveCourier: f.otherLiveCourier,
          hadPropio: f.hadPropio,
          totalOutputs: f.outputs.length,
          priorWithCourier: priorOutputsWith(f.outputs, courier),
          ownReplace: f.ownReplace,
          reopened: f.reopened,
          retryAdmission: f.retryAdmission,
        });
        // La hoja no deja guardar con un problema de caja: si aquí aparece
        // uno, o la acción es otra, los hechos cambiaron mientras se decidía.
        if ("problem" in decided) return { error: decided.problem, boxChanged: true };
        if (decided.action !== input.expectedBoxAction) {
          return { error: BOX_CHANGED, boxChanged: true };
        }
        boxAction = decided.action;
        const dateProblem = agreementDateProblem({
          day: agreedOn,
          today: clock.day,
          nowMinute: clock.minute,
          cutoff,
          courier,
          boxAction,
        });
        if (dateProblem) return { error: dateProblem };
        // Aliclik no crea la guía sin coordenada: se pide aquí, como al
        // programar un Provincia COD en el Master (§6.2), y no se guarda nada
        // sin ella.
        if (reproNeedsCoordinate(courier, orderHasCoordinate(f.order))) {
          const parsed = dispatchCoordinateInput(input.coordinate);
          if (!parsed.ok) return { error: parsed.error };
          coordinate = parsed.coordinate;
        }
      }

      if (input.outcome === "no_quiere") {
        const reason = validarMotivoDescarte(note);
        if ("error" in reason) return { error: reason.error };
        if (!sameOrderName(input.confirmOrderName, f.order.order_name)) {
          return { error: `Confirma el pedido ${f.order.order_name ?? "del caso"} para desarmar y cerrar.` };
        }
      }
    }

    if (input.cancelSale) {
      // No se cierra Repro ni se registra éxito hasta que la acción comercial
      // existente confirme su resultado. Revalida RLS, permiso, dinero y cajas.
      const cancel = input.cancelSale === "woocommerce" ? cancelWooOrder
        : input.cancelSale === "woocommerce_return" ? endWooSalePendingReturn : cancelLegacyShopifySale;
      const cancelInput = { reasonCode: "cliente_desiste", reasonText: note ?? "", requestId: input.operationId, requireResolvedGuides: true };
      const result = await cancel(c.order_id, cancelInput);
      if (result.error) return recoveringSale ? saleDone(result.error) : { error: result.error };
      saleNotice = result.notice ?? "Venta anulada.";
    }

    if (coordinate) {
      const saveError = await saveOrderCoordinate(admin, { orderId: c.order_id, storeId: f.order.store_id, userId: scope.userId, ...coordinate });
      if (saveError) return { error: saveError };
      await admin.from("order_events").insert({
        store_id: f.order.store_id,
        order_id: c.order_id,
        kind: "comment",
        occurred_at: now.toISOString(),
        actor: scope.userId,
        source: "manual",
        comment_type: "ubicacion",
        note: `Ubicación guardada al acordar la salida con Aliclik en Repro Lima. coordenadas: ${coordinate.lat}, ${coordinate.lng}`,
        payload: {},
      });
      await recomputeOrderMasterSafe(admin, [c.order_id]);
    }

    const eventNote = reproEventNote({
      outcome: input.outcome,
      channel: input.channel,
      now,
      agreedOn,
      courier,
      boxAction,
      changes,
      nextCallAt,
      note,
      attempt: input.outcome === "no_contesta" ? (c.no_answer_count ?? 0) + 1 : null,
    });
    const { data, error } = await admin.rpc("lima_repro_record", {
      p_case: c.id,
      p_actor: scope.userId,
      p_operation: input.operationId,
      p_episode: recoveringSale ? c.episode_key : f.episode.key,
      p_outcome: input.outcome,
      p_channel: input.channel,
      p_next_call_at: nextCallAt,
      p_agreed_on: agreedOn,
      p_courier: courier,
      p_changes: input.outcome === "confirma" ? changes : {},
      p_box_action: boxAction,
      p_box_location: input.outcome === "confirma" || input.outcome === "no_quiere" ? f.box.kind : null,
      p_note: note,
      p_event_note: eventNote,
      p_ttl_minutes: REPRO_CLAIM_TTL_MINUTES,
    });
    // La RPC vuelve a mirar el candado: se pudo perder entre la lectura y aquí.
    if (error && saleNotice) return saleDone(error.message);
    if (error) return error.message === CASE_GONE ? { error: CASE_GONE, claimLost: true } : { error: error.message };
    const recorded = data as { call_id: string; duplicate: boolean };

    // Lo que sigue, con hechos releídos después de la RPC (E24), también en
    // un duplicado: la marca y el borrado condicionado lo hacen idempotente.
    const fresh = await factsOf(admin, c.order_id);
    const after = fresh?.cases.find((row) => row.id === c.id) ?? null;
    const next = await afterCall(admin, {
      scope,
      outcome: input.outcome,
      callId: recorded.call_id,
      caseRow: after,
      facts: fresh,
      now,
      nextCallAt,
      noAnswerCount: after?.no_answer_count ?? (c.no_answer_count ?? 0) + (input.outcome === "no_contesta" ? 1 : 0),
    });
    // LA PANTALLA NO VIENE CON EL GUARDADO CUANDO SE PASA AL SIGUIENTE (owner,
    // 25-11-2026; la usuaria principal: «aún se queda en el mismo pedido»).
    // Revalidar aquí hace que la respuesta traiga la pantalla entera (~2 s). Al
    // pasar al siguiente en ese instante, el navegador descartaba esa pantalla y
    // la pedía dos veces más: tres lecturas enteras a la vez, justo cuando la
    // ficha siguiente intentaba abrirse (medido en un navegador real con esta
    // misma secuencia). Con `deferRefresh` la acción solo guarda y la ficha pide
    // la lista una vez, de fondo. Solo cuando de verdad va a pasar al siguiente:
    // con error o Mesa de ruta la ficha se queda, y si cambió el programa
    // Courier también tiene que enterarse.
    const refreshDeferred = Boolean(input.deferRefresh) && !saleNotice && !next.error && !next.href && !next.programChanged;
    if (!refreshDeferred) {
      revalidatePath(REPRO_LIMA_PATH);
      if (next.programChanged) revalidatePath(COURIER_PATH);
    }
    return {
      notice: saleNotice ?? next.notice,
      ...(saleNotice ? { saleCancelled: true } : {}),
      ...(next.href ? { href: next.href } : {}),
      ...(next.error ? { error: next.error } : {}),
      callId: recorded.call_id,
      duplicate: Boolean(recorded.duplicate),
      ...(refreshDeferred ? { refreshDeferred: true } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return saleNotice ? saleDone(message) : { error: message };
  }
}

/** Quita programas de Grupo GF; dice si quitó alguno. Nunca lanza. */
async function clearPrograms(admin: Admin, programs: Array<GfProgramRow | null | undefined>, actor: string, suffix: string): Promise<boolean> {
  const list = programs.filter((program): program is GfProgramRow => Boolean(program));
  if (!list.length) return false;
  try {
    const { cleared } = await clearGfDispatchPrograms(admin, list, actor, suffix);
    return cleared.length > 0;
  } catch (error) {
    console.error("repro-lima: quitar la fecha", error instanceof Error ? error.message : error);
    return false;
  }
}

const SUFFIX_OTRO_ACUERDO = "Repro Lima: el acuerdo con el cliente es otro.";
const SUFFIX_NO_LO_QUIERE = "Repro Lima: el cliente ya no lo quiere.";
const SUFFIX_LLAMAR = "Repro Lima: se vuelve a llamar al cliente; el acuerdo anterior ya no vale.";
const CLEARED_NOTE = " Se quitó la fecha que tenía en Grupo GF.";

type AfterCallResult = { notice: string; error?: string; href?: string; programChanged: boolean };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Lo que respondió GF, cerrado con un solo punto. */
const sentence = (text: string) => `${text.trim().replace(/[.\s]+$/, "")}.`;

/**
 * GF Courier en el acuerdo (owner, 15-11-2026: «En el caso de GF Courier la
 * guía ya podría quedar generada para esa fecha»; MOM §9.5). La llamada ya está
 * guardada y nada de esto la deshace:
 * 1. Con una guía GF viva ya asignada a un motorizado (`en_ruta`), no se crea
 *    otra: se dice.
 * 2. Con una viva sin asignar (`pendiente`), Kapta la anula primero
 *    (`cancelGfGuideFor`, «Nuevo acuerdo en Repro Lima»). Si GF no la anula,
 *    no se crea la nueva.
 * 3. Después crea la guía para el día acordado (`createGfGuideFor` con
 *    `scheduledFor`), con el actor real y el motivo «Repro Lima: acuerdo con la
 *    clienta para el …».
 * Si GF no anula o no crea, el aviso dice lo que respondió y enlaza a la Mesa
 * de ruta del pedido, como «otro courier».
 */
async function gfGuideForAgreement(admin: Admin, input: {
  facts: ReproFacts;
  day: string;
  actor: string;
  /** Cuándo se registró el acuerdo: la guía GF creada después es la suya (un reintento no la reemplaza). */
  decidedAt: string | null;
  /** Lo que ya se dijo del programa de Grupo GF quitado. */
  tail: string;
  programChanged: boolean;
}): Promise<AfterCallResult> {
  const { facts: f, day, actor, tail, programChanged } = input;
  const saved = `Acuerdo guardado: sale el ${programDayLabel(day)} con GF Courier.${tail}`;
  const href = orderDrawerHref(f.orderId, "operar", { pathname: REPRO_LIMA_PATH });
  const guidePlan = gfAgreementGuidePlan(f.outputs, input.decidedAt);
  if (guidePlan.kind === "asignada") {
    return { notice: saved, error: gfGuideAssignedMessage(guidePlan.guideCode), href, programChanged };
  }
  // Ya es la de este acuerdo (el mismo envío otra vez): no se anula ni se repite.
  if (guidePlan.kind === "lista") {
    return { notice: `${saved} La guía ${guidePlan.guideCode ?? "de GF Courier"} ya está creada para ese día.`, programChanged };
  }
  // Una sola guía viva sin motorizado: GF le cambia el día con la misma guía y la caja armada (owner, 17-11-2026),
  // sin anularla ni volver a armar. Si GF no puede (ya asignada, reprogramación abierta), sigue el camino de siempre.
  if (guidePlan.kind === "reemplazar" && guidePlan.cancel.length === 1 && guidePlan.cancel[0]!.guideCode) {
    const code = guidePlan.cancel[0]!.guideCode;
    let moved: GfDateResult;
    try {
      moved = await changeGfGuideDateFor(f.orderId, code, { userId: actor, day, reason: reproGfGuideReason(day) }, admin);
    } catch (error) {
      moved = { ok: false, error: errorText(error) };
    }
    if (moved.ok) return { notice: `${saved} La guía ${code} ahora sale ese día${moved.box === "REARM" || moved.box === "NEW_LABEL" ? ": " : ", "}${gfDateBoxText(moved.box)}.`, programChanged };
    if (!moved.ok && moved.code === "ASSIGNED_TO_RIDER") return { notice: saved, error: gfGuideAssignedMessage(code), href, programChanged };
  }
  const cancelled: string[] = [];
  if (guidePlan.kind === "reemplazar") {
    for (const old of guidePlan.cancel) {
      if (!old.guideCode) {
        return { notice: saved, error: "La guía de GF Courier viva no tiene número: anúlala desde la Mesa de ruta del pedido y crea ahí la nueva.", href, programChanged };
      }
      let res: GfCancelResult;
      try {
        res = await cancelGfGuideFor(f.orderId, old.guideCode, { userId: actor, reason: REPRO_GF_CANCEL_REASON, note: REPRO_GF_CANCEL_NOTE }, admin);
      } catch (error) {
        res = { ok: false, error: errorText(error) };
      }
      if (!res.ok) {
        return {
          notice: saved,
          error: `GF Courier no anuló la guía ${old.guideCode}: ${sentence(res.error)} No se creó la guía nueva: revísalo en la Mesa de ruta del pedido.`,
          href,
          programChanged,
        };
      }
      if (res.requested) {
        return {
          notice: saved,
          error: `${gfCancelRequestedText(old.guideCode)} No se creó la guía nueva: créala en la Mesa de ruta cuando GF la anule.`,
          href,
          programChanged,
        };
      }
      cancelled.push(old.guideCode);
    }
  }
  // Solo después de anular la anterior: GF no deja dos guías vivas del mismo pedido.
  let created: GfGuideResult;
  try {
    created = await createGfGuideFor(f.orderId, { userId: actor, reason: reproGfGuideReason(day), scheduledFor: day }, admin);
  } catch (error) {
    created = { ok: false, error: errorText(error) };
  }
  const cancelledNote = cancelled.length ? ` La guía ${cancelled.join(", ")} quedó anulada.` : "";
  if (!created.ok) {
    return {
      notice: saved,
      error: created.pending
        ? `GF Courier no respondió a tiempo: la guía del ${programDayLabel(day)} quedó creándose (Kapta la vincula sola).${cancelledNote} Revísala en la Mesa de ruta del pedido.`
        : `GF Courier no creó la guía del ${programDayLabel(day)}: ${sentence(created.error)}${cancelledNote} Créala desde la Mesa de ruta del pedido.`,
      href,
      programChanged,
    };
  }
  return {
    notice: `Acuerdo guardado: sale el ${programDayLabel(day)} con GF Courier. Guía ${created.trackingId} ${created.adopted ? "vinculada" : "creada"} para ese día.${cancelledNote}${tail}`,
    programChanged,
  };
}

/**
 * Otro courier en el acuerdo con una guía GF viva (owner, 24-11-2026, #KP207918 y #KP200821: «cuando generamos la
 * reprogramación para dentro de unos días, no anula la guía de GF Courier ni tampoco lo pasó al flujo del día:
 * programados»). Quien guarda el acuerdo decide el courier: Kapta anula al guardar la guía GF que todavía no tiene
 * motorizado, como al crear la guía de Aliclik o Swayp a mano (`cancelLiveGfForOtherCourier`). Así GF no la saca en su
 * día y la guía del día programado no se frena («el automático no la anula»). Con motorizado no se anula: se dice.
 *
 * Sin guía viva, el pedido entra en «Por reprogramar Lima» y el caso de la atención se cerraría como «nuevo intento»
 * (`reproCaseProblem`) con el acuerdo recién guardado. No es otro intento: pasa al episodio de la etapa con su acuerdo
 * y queda en Programados. Nunca lanza; lo que falla va al aviso.
 */
async function releaseGfForAgreement(admin: Admin, input: {
  facts: ReproFacts;
  caseRow: ReproCaseRow;
  day: string;
  courierName: string;
  actor: string;
}): Promise<{ note: string; error?: string }> {
  const { facts: f, caseRow: c, day, courierName, actor } = input;
  const live = f.outputs.filter(isLiveGfGuide);
  if (!live.length) return { note: "" };
  const before = `antes del ${programDayLabel(day)}`;
  const assigned = live.find((output) => output.delivery_status === "en_ruta");
  if (assigned) {
    return {
      note: "",
      error: `GF Courier ya asignó la guía ${assigned.guide_code ?? "viva"} a un motorizado: Kapta no la anula. Pide a GF que la devuelva ${before}.`,
    };
  }
  const cancelled: string[] = [];
  for (const output of live) {
    if (!output.guide_code) {
      return { note: "", error: `La guía de GF Courier viva no tiene número: anúlala en la Mesa de ruta del pedido ${before}.` };
    }
    let res: GfCancelResult;
    try {
      res = await cancelGfGuideFor(f.orderId, output.guide_code, {
        userId: actor,
        reason: reproGfOtherCourierReason(courierName),
        note: reproGfOtherCourierNote(courierName, day),
      }, admin);
    } catch (error) {
      res = { ok: false, error: errorText(error) };
    }
    if (!res.ok) {
      return { note: "", error: `GF Courier no anuló la guía ${output.guide_code}: ${sentence(res.error)} Anúlala en la Mesa de ruta del pedido ${before}.` };
    }
    if (res.requested) return { note: "", error: gfCancelRequestedText(output.guide_code) };
    cancelled.push(output.guide_code);
  }
  await recomputeOrderMasterSafe(admin, [f.orderId]);
  // El caso sigue con su acuerdo en el episodio de la etapa (condicionado: si otro ya lo cambió o cerró, no se pisa).
  if (c.episode_key.startsWith("attention:")) {
    const fresh = await factsOf(admin, f.orderId).catch(() => null);
    if (fresh?.inStage && fresh.episode.key !== c.episode_key) {
      const { error } = await admin.from("lima_repro_cases")
        .update({ episode_key: fresh.episode.key, episode_at: fresh.episode.at ?? c.episode_at })
        .eq("id", c.id).is("closed_at", null).eq("episode_key", c.episode_key);
      if (error) console.error("repro-lima: el caso no pasó a la etapa", c.id, error.message);
    }
  }
  return { note: ` La guía ${cancelled.join(", ")} de GF Courier quedó anulada.` };
}

/**
 * Lo que sigue a cada resultado (E23):
 * - confirma, plan `ahora` → se programa (se reescribe el programa);
 * - confirma, `al_recibir` → se quita el programa si es de otro día;
 * - confirma, otro plan → se quita todo programa de Grupo GF;
 * - confirma con GF Courier → además, la guía GF del día acordado (`gfGuideForAgreement`);
 * - no quiere → se quita todo programa;
 * - llamar después → se quita el programa que puso un acuerdo de Repro Lima.
 * Sus fallos van al aviso y nunca deshacen la llamada.
 */
async function afterCall(admin: Admin, input: {
  scope: ReproScope;
  outcome: ReproOutcome;
  callId: string;
  caseRow: ReproCaseRow | null;
  facts: ReproFacts | null;
  now: Date;
  nextCallAt: string | null;
  noAnswerCount: number;
}): Promise<AfterCallResult> {
  const { facts: f, caseRow: c, scope } = input;
  const today = limaClock(input.now).day;
  const actor = scope.userId;

  if (input.outcome === "no_contesta") {
    const next = input.nextCallAt ? ` Próxima: ${reproCallTimeLabel(input.nextCallAt, input.now)}.` : "";
    return { notice: `No contesta (intento ${Math.max(1, input.noAnswerCount)}).${next}`, programChanged: false };
  }
  if (input.outcome === "llamar_despues") {
    const cleared = f?.program && programOrigin(f.program.reason) === "repro_lima"
      ? await clearPrograms(admin, [f.program], actor, SUFFIX_LLAMAR)
      : false;
    const when = input.nextCallAt ? reproCallTimeLabel(input.nextCallAt, input.now) : "más tarde";
    return { notice: `Llamada agendada: ${when}.${cleared ? CLEARED_NOTE : ""}`, programChanged: cleared };
  }
  if (input.outcome === "no_quiere") {
    const cleared = await clearPrograms(admin, [f?.program], actor, SUFFIX_NO_LO_QUIERE);
    return {
      notice: `Caso cerrado: Almacén la desarma cuando esté en oficina (cuaderno «DESARMAR»). No anula la venta: solo la tienda la anula.${cleared ? CLEARED_NOTE : ""}`,
      programChanged: cleared,
    };
  }

  // Confirma.
  if (!f || !c || c.closed_at || c.agreement_call_id !== input.callId || !c.agreed_on) {
    return { notice: "Acuerdo guardado.", programChanged: false };
  }
  const day = c.agreed_on.slice(0, 10);
  const courier = isReproCourier(c.agreed_courier) ? c.agreed_courier : null;
  const boxAction = isAgreementBoxAction(c.box_action) ? c.box_action : null;
  if (!courier || !boxAction) return { notice: "Acuerdo guardado.", programChanged: false };
  const courierName = REPRO_COURIER_LABEL[courier];
  const plan = materializationPlan({ courier, boxAction, box: f.box, retryAdmission: f.retryAdmission });

  if (plan === "ahora") {
    let result: MaterializeResult;
    try {
      const myName = await resolveAgentName(actor, admin);
      result = await materializeAgreement(admin, {
        caseRow: c,
        actor,
        facts: f,
        reason: reproProgramReason(myName, today),
        now: input.now,
      });
    } catch (error) {
      result = { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
    const programmed = result.status === "programado" ||
      (result.status === "omitido" && f.program?.scheduled_for.slice(0, 10) === day);
    if (programmed) {
      const newBox = boxAction === "caja_nueva_stock" && f.box.kind === "con_motorizado"
        ? " Falta «Sacar con salida nueva» en Despacho del día."
        : "";
      const forToday = day === today ? " Avisa a Almacén: la caja tiene que estar en el anaquel antes de las 12:30." : "";
      return {
        notice: `Acuerdo guardado: sale el ${programDayLabel(day)} con ${courierName}. Está en «Programados» de Despacho del día.${newBox}${forToday}`,
        programChanged: result.status === "programado" && result.wrote,
      };
    }
    const why = result.status === "error" || result.status === "cerrado" ? result.message : "otra persona cambió el caso.";
    // El programa de otro día ya contradice el acuerdo guardado (E23): se
    // quita aunque no se haya podido escribir el nuevo. El borrado es
    // condicionado a lo leído: no toca un programa que otro acabe de escribir.
    // Un caso cerrado (otro intento, fuera de la etapa) ya no manda: no se toca.
    const cleared = result.status !== "cerrado" && f.program && f.program.scheduled_for.slice(0, 10) !== day
      ? await clearPrograms(admin, [f.program], actor, SUFFIX_OTRO_ACUERDO)
      : false;
    const tail = cleared ? CLEARED_NOTE : "";
    return {
      notice: `Acuerdo guardado.${tail}`,
      error: `Acuerdo guardado, pero no se pudo programar: ${why}${tail} Usa «Programar ahora».`,
      programChanged: cleared,
    };
  }

  if (plan === "al_recibir") {
    const cleared = f.program && f.program.scheduled_for.slice(0, 10) !== day
      ? await clearPrograms(admin, [f.program], actor, SUFFIX_OTRO_ACUERDO)
      : false;
    const rider = f.box.kind === "con_motorizado" ? f.box.riderName : "el motorizado";
    return {
      notice: `Acuerdo guardado: se programa solo al recibir la caja de ${rider} en oficina.${cleared ? CLEARED_NOTE : ""}`,
      programChanged: cleared,
    };
  }

  // No se programa: se quita todo programa de Grupo GF (E23).
  const cleared = await clearPrograms(admin, [f.program], actor, SUFFIX_OTRO_ACUERDO);
  const tail = cleared ? CLEARED_NOTE : "";
  switch (plan.no) {
    case "otro_courier":
      // GF Courier por API: la guía queda creada para el día acordado (owner,
      // 15-11-2026). Va antes que «la salida ya existe»: la guía GF viva se
      // reemplaza por la del día acordado, no se conserva.
      if (courier === "gf_courier") {
        return await gfGuideForAgreement(admin, { facts: f, day, actor, decidedAt: c.decided_at, tail, programChanged: cleared });
      }
      // La guía GF viva sin motorizado se anula al guardar (owner, 24-11-2026, #KP207918).
      const gf = await releaseGfForAgreement(admin, { facts: f, caseRow: c, day, courierName, actor });
      const gfTail = `${gf.note}${tail}`;
      const gfError = gf.error ? { error: gf.error } : {};
      // Con la salida de ese courier ya viva no hay nada que crear (13-11-2026).
      if (f.box.kind === "con_courier" && sameCourier(f.box.courier, courier)) {
        return { notice: `Acuerdo guardado: la salida de ${courierName} ya existe.${gfTail}`, ...gfError, programChanged: cleared };
      }
      // Con «Guía Aliclik y Swayp del día programado» en Activo (0349), la guía la crea Kapta.
      if ((courier === "aliclik" || courier === "fenix") && f.storeId) {
        const auto = await loadLimaCourierAutoActiveStores(admin, [f.storeId]).catch(() => [] as string[]);
        if (auto.includes(f.storeId)) {
          return {
            notice: `Acuerdo guardado: sale el ${programDayLabel(day)} con ${courierName}${gf.error ? "" : " (en «Programados»)"}. Kapta crea su guía ${courier === "aliclik" ? "la noche anterior o la mañana de ese día" : "la víspera"}; si no puede, avisa por Telegram.${gfTail}`,
            ...gfError,
            programChanged: cleared,
          };
        }
      }
      return {
        notice: `Acuerdo guardado: crea la salida de ${courierName} desde la Mesa de ruta del pedido.${gfTail}`,
        ...gfError,
        href: orderDrawerHref(f.orderId, "operar", { pathname: REPRO_LIMA_PATH }),
        programChanged: cleared,
      };
    case "falta_salida": {
      // Caja nueva desde stock sin quien saque la salida (caja de otro courier
      // sin reintento, o la propia que no consta con bloqueo): no es «la caja
      // en oficina» (`faltaSalidaWhy`).
      const why = faltaSalidaWhy(boxAction);
      return {
        notice: `Acuerdo guardado. Falta la salida nueva: Kapta todavía no la crea ${why}. Anótalo en la ficha y avisa a Despacho GF.${tail}`,
        programChanged: cleared,
      };
    }
    case "falta_ubicar":
      return {
        notice: `Acuerdo guardado. No consta dónde está la caja: búscala en oficina antes de programar (§9.5).${tail}`,
        programChanged: cleared,
      };
    case "falta_recibir_devolucion": {
      const from = f.box.kind === "volviendo_courier" ? reproCourierName(f.box.courier) : "su courier";
      return {
        notice: `Acuerdo guardado: se programa cuando la caja de ${from} llegue a Devoluciones; entonces usa «Programar ahora».${tail}`,
        programChanged: cleared,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// «Programar ahora» y «Ya la encontré: programar» (E12, E21)
// ---------------------------------------------------------------------------

/**
 * Programa el acuerdo que no se programó al decidir: «Programar ahora» (estado
 * «falta programarlo», por ejemplo porque falló la escritura o la caja de otro
 * courier ya llegó) o, con `found`, «Ya la encontré: programar» cuando no
 * constaba dónde estaba la caja y alguien la encontró en la oficina (segundo
 * clic). Toma el candado de ESE caso antes (E21; nunca abre otro) y lo
 * suelta después si no era suyo.
 */
export async function programReproAgreement(input: { caseId: string; found?: boolean }): Promise<ReproActionResult> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  const admin = createAdminSupabase();
  try {
    const c0 = await caseInScope(admin, scope, input.caseId);
    if ("error" in c0) return c0;
    if (c0.closed_at) return { error: "El caso ya está cerrado." };
    if (!c0.agreed_on || !c0.agreement_call_id) return { error: "Este caso no tiene un acuerdo que programar." };
    const f = await factsOf(admin, c0.order_id);
    if (!f?.order) return { error: "No encontramos el pedido." };
    const problem = reproCaseProblem(f, c0);
    if (problem) {
      if (problem.reason !== "cambio") {
        await closeStaleReproCases(admin, [c0.id], problem.reason);
        revalidatePath(REPRO_LIMA_PATH);
      }
      return { error: problem.message };
    }
    const courier = isReproCourier(c0.agreed_courier) ? c0.agreed_courier : null;
    const boxAction = isAgreementBoxAction(c0.box_action) ? c0.box_action : null;
    if (courier !== "propio" || !boxAction) return { error: "Solo se programa en Grupo GF un acuerdo con Grupo GF." };
    // Un acuerdo viejo con Grupo GF en una tienda que ya despacha por GF Courier:
    // Grupo GF no lo toma (§29.17). Se acuerda otra vez con GF Courier.
    if (f.gfCourierApi) return { error: `${GRUPO_GF_NOT_IN_GF_STORE} Acuérdalo de nuevo en «Atender».` };
    const plan = materializationPlan({ courier, boxAction, box: f.box, retryAdmission: f.retryAdmission });
    const allowed = input.found
      ? typeof plan === "object" && plan.no === "falta_ubicar"
      : plan === "ahora";
    if (!allowed) {
      return {
        error: input.found
          ? "La caja ya consta en otro lugar: revisa la fila antes de programar."
          : "Este acuerdo todavía no se puede programar: revisa la fila.",
      };
    }

    // La fecha, como al decidir: el corte, Swayp y la noche anterior (§11.6).
    const now = new Date();
    const clock = limaClock(now);
    const day = c0.agreed_on.slice(0, 10);
    const check = await loadGroupGfCourierRouteCheck(admin, {
      store_id: f.order.store_id,
      region: f.order.region,
      province: f.order.province,
      district: f.order.district,
    }, day);
    if (!check.eligible) return { error: check.reason };
    const dateProblem = agreementDateProblem({ day, today: clock.day, nowMinute: clock.minute, cutoff: check.sameDayCutoff, courier, boxAction });
    if (dateProblem) return { error: `${dateProblem} Vuelve a confirmar la fecha con el cliente.` };

    // El candado, antes de escribir (E21), sobre ESTE caso y nada más: la RPC
    // `lima_repro_claim` abre otro si no hay abierto, y con este cerrado
    // mientras tanto («Ya no lo quiere») reabriría el episodio sin el segundo
    // clic (E29). Escritura condicional, como el candado de Envíos: libre,
    // vencido o ya propio, y el caso abierto.
    const hadClaim = c0.claimed_by === scope.userId && Boolean(c0.claimed_until) && Date.parse(c0.claimed_until!) > now.getTime();
    const { data: claimed, error: claimError } = await admin
      .from("lima_repro_cases")
      .update({ claimed_by: scope.userId, claimed_until: new Date(now.getTime() + REPRO_CLAIM_TTL_MINUTES * 60_000).toISOString() })
      .eq("id", c0.id)
      .is("closed_at", null)
      .or(`claimed_by.is.null,claimed_by.eq.${scope.userId},claimed_until.lte.${now.toISOString()}`)
      .select("id")
      .maybeSingle();
    if (claimError) return { error: claimError.message };
    if (!claimed) {
      const { data: held } = await admin.from("lima_repro_cases").select("closed_at,claimed_by").eq("id", c0.id).maybeSingle();
      const holder = held as { closed_at: string | null; claimed_by: string | null } | null;
      if (!holder || holder.closed_at) return { error: "El caso ya está cerrado." };
      const name = holder.claimed_by ? await resolveAgentName(holder.claimed_by, admin) : null;
      return { error: `${name ?? "Otra persona"} está atendiendo este pedido.` };
    }

    try {
      // Una marca sin programa ni «Quitar la fecha» posterior es una escritura
      // que falló a medias (E9): se borra para volver a marcar.
      let c = c0;
      if (c.materialized_at && !f.program && !(f.programRemovedAt && Date.parse(f.programRemovedAt) > Date.parse(c.materialized_at))) {
        await admin
          .from("lima_repro_cases")
          .update({ materialized_at: null, materialized_on: null })
          .eq("id", c.id)
          .eq("agreement_call_id", c.agreement_call_id!)
          .eq("materialized_at", c.materialized_at);
        c = { ...c, materialized_at: null, materialized_on: null };
      }
      // El motivo nombra a quien confirmó con el cliente y cuándo, no a quien programa.
      const decider = c.decided_by ? await resolveAgentName(c.decided_by, admin) : null;
      const result = await materializeAgreement(admin, {
        caseRow: c,
        actor: scope.userId,
        facts: f,
        reason: reproProgramReason(decider, limaDay(c.decided_at) ?? clock.day),
        now,
      });
      revalidatePath(REPRO_LIMA_PATH);
      if (result.status === "programado") {
        revalidatePath(COURIER_PATH);
        return { notice: `Programado: sale el ${programDayLabel(result.day)} con Grupo GF. Está en «Programados» de Despacho del día.` };
      }
      if (result.status === "omitido") return { error: "Otra persona ya lo programó o cambió el acuerdo: revisa la fila." };
      return { error: result.message };
    } finally {
      if (!hadClaim) {
        await admin
          .from("lima_repro_cases")
          .update({ claimed_by: null, claimed_until: null })
          .eq("id", c0.id)
          .eq("claimed_by", scope.userId);
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// «Agendar» desde la lista: otro día para un acuerdo que ya existe (15-11-2026)
// ---------------------------------------------------------------------------

const NO_AGREEMENT = "Este pedido no tiene un acuerdo con la clienta: acuerda el día y el courier en «Atender».";

/**
 * «Agendar» y «Mover a…» de la lista (owner, 15-11-2026; MOM §9.5) sobre un
 * pedido que ya tiene un acuerdo: otro día, con el mismo courier y lo mismo que
 * cambió. Es «Confirma fecha» de la pestaña por el mismo camino, sin abrir la
 * ficha: toma el candado del caso (`claimReproCase`), recalcula «Qué hacer con
 * la caja» con `reproBoxAction` y registra la llamada (`recordCall` →
 * `lima_repro_record`), que valida la fecha (corte, Swayp, noche anterior) y
 * después programa o quita la fecha de Grupo GF como al decidir. Quien agenda
 * dice si lo acordó por llamada o por WhatsApp: es un acuerdo con la clienta,
 * no un cambio de Kapta. Al terminar suelta el candado si no lo tenía. Sin
 * acuerdo no hay courier que conservar: eso se acuerda en «Atender».
 */
export async function moveReproAgreement(input: {
  orderId: string;
  day: string;
  channel: ReproChannel;
  /** Un `crypto.randomUUID()` por pedido: un doble clic no registra dos llamadas. */
  operationId: string;
}): Promise<RegisterReproCallResult> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  if (!isUuid(input.orderId)) return { error: "No encontramos el pedido." };
  if (input.channel !== "llamada" && input.channel !== "whatsapp") return { error: "Di si lo acordaste por llamada o por WhatsApp." };
  const day = input.day?.trim() ?? "";
  if (!DAY_RE.test(day)) return { error: "Elige el día que acordaste con el cliente." };
  const admin = createAdminSupabase();
  try {
    const f = await factsOf(admin, input.orderId);
    if (!f?.storeId || !f.order) return { error: "No encontramos el pedido." };
    if (!scope.storeIds.has(f.storeId)) return { error: REPRO_OUTSIDE_STORE };
    const open = f.open && f.open.episode_key === f.episode.key ? f.open : null;
    const courier = open && isReproCourier(open.agreed_courier) ? open.agreed_courier : null;
    if (!open || !open.agreed_on || !open.agreement_call_id || !courier) return { error: NO_AGREEMENT };
    const before = open.agreed_on.slice(0, 10);
    if (before === day) return { notice: `Ya estaba acordado para el ${programDayLabel(day)}.` };
    // La tienda pudo cambiar desde el acuerdo: el courier se vuelve a acordar en «Atender».
    const storeProblem = reproCourierStoreProblem(courier, Boolean(f.gfCourierApi));
    if (storeProblem) return { error: `${storeProblem} Acuérdalo de nuevo en «Atender».` };
    // GF Courier: mover es anular la guía del día anterior y crear la del nuevo
    // (`gfGuideForAgreement`, después de registrar la llamada). Si GF ya la
    // asignó a un motorizado no se anula: no se mueve, y se dice por qué.
    if (courier === "gf_courier") {
      const guidePlan = gfAgreementGuidePlan(f.outputs);
      if (guidePlan.kind === "asignada") return { error: `No se movió: ${gfGuideAssignedMessage(guidePlan.guideCode)}` };
    }
    const now = new Date();
    const hadClaim = open.claimed_by === scope.userId && Boolean(open.claimed_until) && Date.parse(open.claimed_until!) > now.getTime();
    const claim = await claimReproCase(input.orderId);
    if ("error" in claim) return { error: claim.error };
    try {
      const changes = normalizeReproChanges(open.changes);
      // La misma regla que la pestaña y que `recordCall`: si la caja cambió
      // desde que se acordó, la acción nueva es la que vale.
      const decided = reproBoxAction({
        outcome: "confirma",
        courier,
        changes,
        box: f.box,
        ownLiveCourier: f.ownLive?.courier ?? null,
        lastFailedCourier: f.failedOutput?.courier ?? null,
        otherLiveCourier: f.otherLiveCourier,
        hadPropio: f.hadPropio,
        totalOutputs: f.outputs.length,
        priorWithCourier: priorOutputsWith(f.outputs, courier),
        ownReplace: f.ownReplace,
        reopened: f.reopened,
        retryAdmission: f.retryAdmission,
      });
      if ("problem" in decided) return { error: `${decided.problem} Ábrelo con «Atender».` };
      return await recordCall(scope, {
        caseId: claim.caseId,
        operationId: input.operationId,
        outcome: "confirma",
        channel: input.channel,
        agreedOn: day,
        courier,
        changes,
        expectedBoxAction: decided.action,
        note: `Día cambiado desde la lista de Repro Lima (antes, ${programDayLabel(before)}).`,
      });
    } finally {
      if (!hadClaim) {
        await admin
          .from("lima_repro_cases")
          .update({ claimed_by: null, claimed_until: null })
          .eq("id", claim.caseId)
          .eq("claimed_by", scope.userId);
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// «Programar» en lote un no entregado sin acuerdo: acuerdo sin llamada (16-11-2026)
// ---------------------------------------------------------------------------

/** La nota del acuerdo que nace al programar en lote, sin hablar con la clienta. */
const REPRO_NO_CALL_NOTE = "Programado en lote desde Repro Lima, sin llamada.";

/**
 * «Programar» un no entregado «Por acordar» desde la lista, con el día y el
 * courier elegidos (owner, 16-11-2026: «con un botón ya lo dejamos programados
 * exactamente para un courier»; MOM §9.5). No hay llamada: el acuerdo se
 * registra con el canal `sin_contacto` (0348), que no cuenta como intento. Es
 * el mismo camino que «Confirma fecha» de la pestaña: toma el candado del caso
 * (`claimReproCase`), calcula «Qué hacer con la caja» con `reproBoxAction` sin
 * cambios del pedido y registra el acuerdo (`recordCall` →
 * `lima_repro_record`), que valida el courier de la tienda, la cobertura de
 * Grupo GF y la fecha, y después programa, crea la guía GF del día o dice qué
 * falta. Si el pedido ya tiene un acuerdo, se reprograma con el suyo
 * (`moveReproAgreement`); si la caja pide una decisión (un problema de caja) o
 * Aliclik pide la ubicación, se abre con «Atender». Al terminar suelta el
 * candado si no lo tenía.
 */
export async function programReproWithoutCall(input: {
  orderId: string;
  day: string;
  courier: string;
  /** Un `crypto.randomUUID()` por pedido: un doble clic no registra dos acuerdos. */
  operationId: string;
}): Promise<RegisterReproCallResult> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  if (!isUuid(input.orderId)) return { error: "No encontramos el pedido." };
  const day = input.day?.trim() ?? "";
  if (!DAY_RE.test(day)) return { error: "Elige el día en que sale." };
  if (!isReproCourier(input.courier)) return { error: "Elige con qué courier sale." };
  const courier = input.courier;
  const disabled = reproCourierDisabledReason(courier);
  if (disabled) return { error: disabled };
  const admin = createAdminSupabase();
  try {
    const f = await factsOf(admin, input.orderId);
    if (!f?.storeId || !f.order) return { error: "No encontramos el pedido." };
    if (!scope.storeIds.has(f.storeId)) return { error: REPRO_OUTSIDE_STORE };
    if (!f.inStage) return { error: OUT_OF_STAGE };
    const open = f.open && f.open.episode_key === f.episode.key ? f.open : null;
    if (open?.agreed_on && open.agreement_call_id) return { error: "Ya tiene un acuerdo con la clienta: se reprograma con su courier." };
    const storeProblem = reproCourierStoreProblem(courier, Boolean(f.gfCourierApi));
    if (storeProblem) return { error: storeProblem };
    if (reproNeedsCoordinate(courier, orderHasCoordinate(f.order))) {
      return { error: "Aliclik necesita la ubicación del pedido: acuérdalo en «Atender» y pega ahí el enlace de Google Maps." };
    }
    const now = new Date();
    const hadClaim = Boolean(open && open.claimed_by === scope.userId && open.claimed_until && Date.parse(open.claimed_until) > now.getTime());
    const claim = await claimReproCase(input.orderId);
    if ("error" in claim) return { error: claim.error };
    try {
      const changes = normalizeReproChanges(null);
      const decided = reproBoxAction({
        outcome: "confirma",
        courier,
        changes,
        box: f.box,
        ownLiveCourier: f.ownLive?.courier ?? null,
        lastFailedCourier: f.failedOutput?.courier ?? null,
        otherLiveCourier: f.otherLiveCourier,
        hadPropio: f.hadPropio,
        totalOutputs: f.outputs.length,
        priorWithCourier: priorOutputsWith(f.outputs, courier),
        ownReplace: f.ownReplace,
        reopened: f.reopened,
        retryAdmission: f.retryAdmission,
      });
      if ("problem" in decided) return { error: `${decided.problem} Ábrelo con «Atender».` };
      return await recordCall(scope, {
        caseId: claim.caseId,
        operationId: input.operationId,
        outcome: "confirma",
        channel: "sin_contacto",
        agreedOn: day,
        courier,
        changes,
        expectedBoxAction: decided.action,
        note: REPRO_NO_CALL_NOTE,
      });
    } finally {
      if (!hadClaim) {
        await admin
          .from("lima_repro_cases")
          .update({ claimed_by: null, claimed_until: null })
          .eq("id", claim.caseId)
          .eq("claimed_by", scope.userId);
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Lecturas de la hoja
// ---------------------------------------------------------------------------

export interface ReproCallView {
  id: string;
  at: string;
  byName: string | null;
  outcome: string;
  channel: string;
  nextCallAt: string | null;
  agreedOn: string | null;
  courier: string | null;
  courierName: string | null;
  boxAction: string | null;
  note: string | null;
}

/**
 * Las últimas 20 llamadas del pedido, de todos sus casos (también de un
 * episodio anterior), con quién llamó: «Antes de llamar».
 */
export async function loadReproCalls(orderId: string): Promise<{ calls: ReproCallView[] } | { error: string }> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  if (!isUuid(orderId)) return { error: "No encontramos el pedido." };
  const admin = createAdminSupabase();
  const { data: order } = await admin.from("orders").select("id,store_id").eq("id", orderId).maybeSingle();
  const storeId = (order as { store_id?: string } | null)?.store_id;
  if (!storeId) return { error: "No encontramos el pedido." };
  if (!scope.storeIds.has(storeId)) return { error: REPRO_OUTSIDE_STORE };
  const { data, error } = await admin
    .from("lima_repro_calls")
    .select("id,occurred_at,actor,outcome,channel,next_call_at,agreed_on,courier,box_action,note")
    .eq("order_id", orderId)
    .order("occurred_at", { ascending: false })
    .limit(20);
  if (error) return { error: error.message };
  const rows = (data ?? []) as Array<{
    id: string;
    occurred_at: string;
    actor: string | null;
    outcome: string;
    channel: string;
    next_call_at: string | null;
    agreed_on: string | null;
    courier: string | null;
    box_action: string | null;
    note: string | null;
  }>;
  const names = await resolveAgentNames(rows.map((row) => row.actor).filter((id): id is string => Boolean(id)), admin).catch(() => ({} as Record<string, string>));
  return {
    calls: rows.map((row) => ({
      id: row.id,
      at: row.occurred_at,
      byName: row.actor ? names[row.actor] ?? null : null,
      outcome: row.outcome,
      channel: row.channel,
      nextCallAt: row.next_call_at,
      agreedOn: row.agreed_on,
      courier: row.courier,
      courierName: row.courier ? reproCourierName(row.courier) : null,
      boxAction: row.box_action,
      note: row.note,
    })),
  };
}

/** La fila de un pedido, releída al abrir la hoja (la caja pudo cambiar). */
export async function loadReproRow(orderId: string): Promise<{ row: ReproRow | null } | { error: string }> {
  const scope = await requireReproLima();
  if ("error" in scope) return { error: scope.error };
  if (!isUuid(orderId)) return { error: "No encontramos el pedido." };
  try {
    const data = await loadReproLima(createAdminSupabase(), scope, new Date(), { orderIds: [orderId], attention: true });
    return { row: data.rows[0] ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
