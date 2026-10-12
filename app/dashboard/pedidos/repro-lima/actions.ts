"use server";

// «Repro Lima» (fase 1, entrega 1a; MOM §9.5): tomar el caso, registrar la
// llamada y programar el acuerdo. Cada acción pide `dispatch.manage` y la
// tienda del pedido (`requireReproLima`), y escribe con el cliente de servicio
// después de comprobarlo (D12). Las dos RPC (`lima_repro_claim`,
// `lima_repro_record`) llevan el candado y el episodio; el resto son
// escrituras condicionales, como el candado de Envíos.
//
// Lo que NO hace: crear salidas (otro courier va por la Mesa de ruta, D7),
// anular la venta («Ya no lo quiere» solo quita la fecha) ni tocar el Master.

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
import { loadGroupGfCourierRouteCheck } from "@/lib/grupo-gf-courier-route-access";
import { limaClock } from "@/lib/grupo-gf-courier";
import { validarMotivoDescarte } from "@/lib/recovery-discard";
import { orderDrawerHref } from "@/lib/order-drawer-href";
import { limaDay, programDayLabel } from "@/lib/dispatch-day";
import { priorOutputsWith, reproBoxAction } from "@/lib/repro-box-action";
import {
  agreementDateProblem,
  isAgreementBoxAction,
  isReproChannel,
  isReproCourier,
  isReproOutcome,
  materializationPlan,
  nextCallProblem,
  normalizeReproChanges,
  programOrigin,
  reproCallTimeLabel,
  reproCourierDisabledReason,
  reproCourierName,
  reproEventNote,
  reproProgramReason,
  REPRO_CLAIM_TTL_MINUTES,
  REPRO_COURIER_LABEL,
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
 * `reopen` (segundo clic, E29).
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
    if (!f.inStage || f.cancelled) {
      if (f.open) await closeStaleReproCases(admin, [f.open.id], "fuera_de_etapa");
      revalidatePath(REPRO_LIMA_PATH);
      return { error: OUT_OF_STAGE };
    }
    if (
      !f.open && !opts.reopen &&
      f.latestClosed?.close_reason === "desarmar_cerrar" && f.latestClosed.episode_key === f.episode.key
    ) {
      return { error: "Este pedido se cerró con «Desarmar y cerrar». «Volver a atender» lo reabre.", needsReopen: true };
    }
    const { data, error } = await admin.rpc("lima_repro_claim", {
      p_order: orderId,
      p_store: f.storeId,
      p_actor: scope.userId,
      p_episode: f.episode.key,
      p_episode_at: f.episode.at,
      p_ttl_minutes: REPRO_CLAIM_TTL_MINUTES,
    });
    if (error) return { error: error.message };
    const claim = data as { case_id: string; claimed: boolean; until: string | null; holder?: string | null };
    revalidatePath(REPRO_LIMA_PATH);
    if (!claim.claimed) {
      const name = claim.holder ? await resolveAgentName(claim.holder, admin) : null;
      return { error: `${name ?? "Otra persona"} está atendiendo este pedido.`, caseId: claim.case_id, holder: { name, until: claim.until } };
    }
    return { caseId: claim.case_id, until: claim.until };
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

/** «Soltar» o cerrar la hoja: suelta SOLO el candado propio. */
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
  revalidatePath(REPRO_LIMA_PATH);
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
}

export interface RegisterReproCallResult extends ReproActionResult {
  callId?: string;
  /** El mismo envío ya estaba guardado (doble clic o reintento de red). */
  duplicate?: boolean;
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
  const admin = createAdminSupabase();
  try {
    const c = await caseInScope(admin, scope, input.caseId);
    if ("error" in c) return c;
    const f = await factsOf(admin, c.order_id);
    if (!f?.order) return { error: "No encontramos el pedido." };
    const now = new Date();
    const clock = limaClock(now);
    const note = input.note?.trim().slice(0, NOTE_MAX) || null;

    // Un reintento del mismo envío no se vuelve a validar: la RPC devuelve
    // el duplicado (o lo rechaza si el contenido es otro, E3).
    const { data: prior } = await admin.from("lima_repro_calls").select("id").eq("operation_id", input.operationId).maybeSingle();

    let nextCallAt: string | null = null;
    let agreedOn: string | null = null;
    let courier: ReproCourier | null = null;
    let changes: ReproChanges = normalizeReproChanges(null);
    let boxAction: BoxAction | null = null;
    if (input.outcome === "llamar_despues" || input.outcome === "no_contesta") nextCallAt = input.nextCallAt?.trim() || null;
    if (input.outcome === "confirma") {
      agreedOn = input.agreedOn?.trim() || null;
      courier = isReproCourier(input.courier) ? input.courier : null;
      changes = normalizeReproChanges(input.changes);
      boxAction = isAgreementBoxAction(input.expectedBoxAction) ? input.expectedBoxAction : null;
    }
    if (input.outcome === "no_quiere") boxAction = "desarmar_cerrar";

    if (!prior) {
      if (c.closed_at) return { error: "El caso ya está cerrado." };
      const problem = reproCaseProblem(f, c);
      if (problem) {
        if (problem.reason !== "cambio") {
          await closeStaleReproCases(admin, [c.id], problem.reason);
          revalidatePath(REPRO_LIMA_PATH);
        }
        return { error: problem.message };
      }
      if (c.claimed_by !== scope.userId || !c.claimed_until || Date.parse(c.claimed_until) <= now.getTime()) {
        return { error: CASE_GONE };
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
        });
        if ("problem" in decided) return { error: decided.problem };
        if (decided.action !== input.expectedBoxAction) {
          return { error: "La caja cambió mientras decidías: revisa «Qué hacer con la caja» y vuelve a guardar." };
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
      }

      if (input.outcome === "no_quiere") {
        const reason = validarMotivoDescarte(note);
        if ("error" in reason) return { error: reason.error };
        if (!sameOrderName(input.confirmOrderName, f.order.order_name)) {
          return { error: `Confirma el pedido ${f.order.order_name ?? "del caso"} para desarmar y cerrar.` };
        }
      }
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
      p_episode: f.episode.key,
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
    if (error) return { error: error.message };
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
    revalidatePath(REPRO_LIMA_PATH);
    if (next.programChanged) revalidatePath(COURIER_PATH);
    return {
      notice: next.notice,
      ...(next.href ? { href: next.href } : {}),
      ...(next.error ? { error: next.error } : {}),
      callId: recorded.call_id,
      duplicate: Boolean(recorded.duplicate),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
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

/**
 * Lo que sigue a cada resultado (E23):
 * - confirma, plan `ahora` → se programa (se reescribe el programa);
 * - confirma, `al_recibir` → se quita el programa si es de otro día;
 * - confirma, otro plan → se quita todo programa de Grupo GF;
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
}): Promise<{ notice: string; error?: string; href?: string; programChanged: boolean }> {
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
      notice: `Caso cerrado: Almacén la desarma cuando esté en oficina (cuaderno «DESARMAR»). No anula la venta: solo Shopify la anula.${cleared ? CLEARED_NOTE : ""}`,
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
    return {
      notice: "Acuerdo guardado.",
      error: `Acuerdo guardado, pero no se pudo programar: ${why} Usa «Programar ahora».`,
      programChanged: false,
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
      return {
        notice: `Acuerdo guardado: crea la salida de ${courierName} desde la Mesa de ruta del pedido.${tail}`,
        href: orderDrawerHref(f.orderId, "operar", { pathname: REPRO_LIMA_PATH }),
        programChanged: cleared,
      };
    case "falta_salida":
      return {
        notice: `Acuerdo guardado. Falta la salida nueva: Kapta todavía no la crea con la caja en oficina. Anótalo en la ficha y avisa a Despacho GF.${tail}`,
        programChanged: cleared,
      };
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
 * clic). Toma el candado antes (E21) y lo suelta después si no era suyo.
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

    // El candado, antes de escribir (E21).
    const hadClaim = c0.claimed_by === scope.userId && Boolean(c0.claimed_until) && Date.parse(c0.claimed_until!) > now.getTime();
    const { data: claimData, error: claimError } = await admin.rpc("lima_repro_claim", {
      p_order: c0.order_id,
      p_store: c0.store_id,
      p_actor: scope.userId,
      p_episode: f.episode.key,
      p_episode_at: f.episode.at,
      p_ttl_minutes: REPRO_CLAIM_TTL_MINUTES,
    });
    if (claimError) return { error: claimError.message };
    const claim = claimData as { case_id: string; claimed: boolean; holder?: string | null };
    if (!claim.claimed) {
      const name = claim.holder ? await resolveAgentName(claim.holder, admin) : null;
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
          .eq("id", claim.case_id)
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
    const data = await loadReproLima(createAdminSupabase(), scope, new Date(), { orderIds: [orderId] });
    return { row: data.rows[0] ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
