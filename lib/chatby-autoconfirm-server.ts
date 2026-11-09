import "server-only";

// La pasada de la confirmación automática por Chatby y de su guía Aliclik
// (MOM §6.1, «Confirmó por Chatby», 01-11-2026). Las reglas están en
// lib/chatby-autoconfirm.ts (pura); aquí solo se cargan filas, se lee Chatby
// con la misma función que la ficha (lib/chatby-api.ts, dos GET, solo lectura)
// y se escribe por los caminos que ya existen:
//
//   - confirmar: `register_confirmation_attempt_v2`, el mismo registro atómico
//     de la mesa de confirmación (el botón usa la v1, que es la misma función
//     sin `source`; la v2 la usa también el agente de voz), con actor nulo,
//     canal «Mensaje escrito», resultado «Confirmó el pedido» y `source =
//     'chatby'`;
//   - la guía: `createAliclikGuideFor` (lib/aliclik-guide.ts), la misma del
//     botón «Crear guía» y de la guía del día programado (§6.2), con todas sus
//     rejas: ALICLIK_WRITE_ENABLED, prepago, rechazos en la puerta, duplicado,
//     riesgo del historial, salida viva, pin respaldado, stock y cobertura del
//     almacén, monto recalculado y el candado.
//
// Sin la tabla de la 0297 no hace nada: no hay fila que la encienda.

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { prepayOrderCheck, type PrepayOrderRow } from "@/lib/prepay-list-server";
import { fetchChatbyConversation, forgetChatbyConversation, sendChatbyReply } from "@/lib/chatby-api";
import { geocodeOrderAddress, markApproxUsed } from "@/lib/geocode-google-server";
import { APPROX_COORDINATE_NOTE, approxDecision, type ApproxMode } from "@/lib/geocode-approx";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { limaTodayKey } from "@/lib/shipments";
import { loadAliclikHealthState } from "@/lib/aliclik-health-access";
import {
  activeAliclikBlocker,
  aliclikContextFor,
  aliclikReadScopeFor,
  createAliclikGuideFor,
  previewAliclikGuideFor,
  type AliclikReadScope,
} from "@/lib/aliclik-guide";
import { ALICLIK_AUTO_FAILED, autoTransport, waitForAliclik } from "@/lib/aliclik-scheduled";
import {
  CHATBY_AUTO_POLICY,
  CHATBY_CONFIRMATION_HELD,
  CHATBY_GUIDE_ORIGIN,
  CHATBY_HOLD_REASONS,
  CHATBY_SOURCE,
  chatbyAutoSettingsFrom,
  chatbyConfirmButtonAt,
  chatbyCheckDue,
  chatbyConfirmationNote,
  chatbyGuideBlock,
  chatbyGuideHold,
  chatbyGuidePin,
  chatbyGuideReason,
  chatbyHoldNote,
  chatbyLocationWatch,
  chatbyOperationId,
  chatbyOrderSkip,
  chatbyReadOrder,
  evaluateChatbyConfirmation,
  guideCapLeft,
  limaDayStartIso,
  type ChatbyAutoSettings,
  type ChatbyCandidate,
  type ChatbyCheckOutcome,
  type ChatbyCheckState,
  type ChatbyHoldReason,
} from "@/lib/chatby-autoconfirm";
import { CHATBY_REPLY_PAUSE_MINUTES, type ChatbyConversation, type ChatbyMessage } from "@/lib/chatby-conversation";
import { chatbyAskedAt, chatbyHeldAt, chatbyHeldInWindow, chatbyHeldWatchDue, chatbyNewCustomerMessage } from "@/lib/chatby-location-ask";
import { chatbyAskKindFor, chatbyCorrectedWatch, chatbyReaskWatch, type ChatbyReaskVerdict } from "@/lib/chatby-reask";
import {
  CHATBY_AUTO_ASK_SKIP_LABEL,
  chatbyAddressCorrectedAt,
  chatbyAutoAskCarry,
  chatbyAutoAskDecision,
  chatbyAutoAskEvidence,
  chatbyAutoAskKindFor,
  chatbyAutoAskLabel,
  chatbyAutoAskMarkedSkip,
  chatbyAutoAskMessage,
  chatbyAutoAskPurpose,
  chatbyAutoAskReason,
  chatbyAutoAskSkipEvidence,
  type ChatbyAskMode,
  type ChatbyAutoAskKind,
  type ChatbyMessageEvent,
} from "@/lib/chatby-auto-ask";
import { saveChatbyAddressCorrection } from "@/lib/order-address-correction";
import { countDoorRejections, type DoorRejectionShipment } from "@/lib/door-rejection";
import {
  HISTORY_GUIDE_EVENT,
  HISTORY_GUIDE_POLICY,
  HISTORY_GUIDE_SKIP_LABEL,
  evaluateHistoryGuide,
  historyGuideCandidate,
  historyGuideConfirmation,
  historyGuideConfirmationSuffix,
  historyGuideCoordinateNote,
  historyGuideEvidence,
  historyGuideFactNote,
  historyGuideFactReason,
  historyGuideReason,
  type HistoryGuideHoldReason,
  type HistoryGuideMode,
  type HistoryGuideVerdict,
  type HistoryPrior,
} from "@/lib/history-guide-auto";
import type { OrderMasterRow } from "@/lib/types";
import type { GuideGpsOrigin } from "@/lib/guide-gps";

/** El tiempo de una pasada (maxDuration 300 s). Lo que no entra va en la siguiente. */
const TIME_BUDGET_MS = 230_000;
/** Dos errores seguidos de Chatby paran las lecturas: el siguiente fallaría igual. */
const MAX_CHATBY_ERRORS_IN_A_ROW = 2;

/** «La tabla no existe» (Postgres 42P01, PostgREST PGRST205): la 0297 no está aplicada. */
export function isMissingTable(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /chatby_auto_\w+.*(does not exist|could not find)/i.test(error.message ?? "");
}

export interface ChatbyAutoItem {
  orderId: string;
  orderName: string | null;
  step: "confirmar" | "guia" | "ubicacion";
  outcome: string;
  detail?: string;
}

export interface ChatbyAutoReport {
  org: string;
  read: number;
  confirmed: number;
  held: number;
  guidesCreated: number;
  guidesFailed: number;
  guideCapLeft: number | null;
  /** «Ubicación aproximada en la calle correcta» (0316): las que en Simulación habrían seguido y las que en Activo se usaron. */
  approxSimulated: number;
  approxUsed: number;
  /** «Pedir sola la dirección o la ubicación» (0318): los que salieron, los simulados y las direcciones guardadas. */
  asksSent: number;
  asksSimulated: number;
  addressesCorrected: number;
  /**
   * «Guía automática para clientas con entregas» (0317): las que en Simulación
   * habrían salido con el GPS de una entrega anterior y las que en Activo
   * salieron así.
   */
  historySimulated: number;
  historyUsed: number;
  stopped: "tiempo" | "chatby" | null;
  items: ChatbyAutoItem[];
  error: string | null;
}

type MasterRow = OrderMasterRow;

interface OrderRow {
  id: string;
  name: string | null;
  created_at: string;
  cancelled_at: string | null;
  total_amount: number | null;
  total_refunded: number | null;
  currency: string | null;
  shopify_note: string | null;
}

/** Las organizaciones encendidas. Sin la tabla, ninguna: la pasada no hace nada. */
export async function loadChatbyAutoSettings(
  admin: SupabaseClient,
): Promise<{ settings: ChatbyAutoSettings[]; missing: boolean; error: string | null }> {
  const { data, error } = await admin.from("chatby_auto_settings").select("*").eq("enabled", true);
  if (error) {
    if (isMissingTable(error)) return { settings: [], missing: true, error: null };
    return { settings: [], missing: false, error: `No se pudieron leer los ajustes de Chatby: ${error.message}` };
  }
  const settings = ((data ?? []) as Record<string, unknown>[])
    .map(chatbyAutoSettingsFrom)
    .filter((s): s is ChatbyAutoSettings => !!s && s.enabled);
  return { settings, missing: false, error: null };
}

async function upsertCheck(
  admin: SupabaseClient,
  row: { order_id: string; store_id: string; org_id: string },
  patch: {
    outcome: ChatbyCheckOutcome;
    reason?: string | null;
    message_id?: string | null;
    evidence?: Record<string, unknown>;
    reads: number;
    confirmed_at?: string | null;
    guide?: { state: GuideState; detail: string | null; code: string | null } | null;
  },
): Promise<string | null> {
  const { error } = await admin.from("chatby_auto_checks").upsert({
    ...row,
    outcome: patch.outcome,
    reason: patch.reason ?? null,
    message_id: patch.message_id ?? null,
    evidence: { policy: CHATBY_AUTO_POLICY, ...(patch.evidence ?? {}) },
    reads: patch.reads,
    checked_at: new Date().toISOString(),
    ...(patch.confirmed_at ? { confirmed_at: patch.confirmed_at } : {}),
    ...(patch.guide
      ? {
          guide_state: patch.guide.state,
          guide_detail: patch.guide.detail?.slice(0, 1000) ?? null,
          guide_code: patch.guide.code,
          guide_at: new Date().toISOString(),
        }
      : {}),
  });
  return error ? error.message : null;
}

/**
 * Una pasada de una organización. `dry` lee Chatby y dice qué haría, sin
 * escribir, sin confirmar y sin crear guías (cotiza, que es un GET).
 */
export async function runChatbyAutoconfirm(
  admin: SupabaseClient,
  settings: ChatbyAutoSettings,
  opts: { dry?: boolean; now?: Date; apiKey?: string } = {},
): Promise<ChatbyAutoReport> {
  const dry = !!opts.dry;
  const now = opts.now ?? new Date();
  const started = Date.now();
  const report: ChatbyAutoReport = {
    org: settings.org_id,
    read: 0,
    confirmed: 0,
    held: 0,
    guidesCreated: 0,
    guidesFailed: 0,
    guideCapLeft: null,
    approxSimulated: 0,
    approxUsed: 0,
    asksSent: 0,
    asksSimulated: 0,
    addressesCorrected: 0,
    historySimulated: 0,
    historyUsed: 0,
    stopped: null,
    items: [],
    error: null,
  };
  if (!settings.enabled) return report;
  const apiKey = (opts.apiKey ?? env.chatbyApiKey()).trim();

  try {
    const { data: stores, error: sErr } = await admin.from("stores").select("id,status").eq("org_id", settings.org_id);
    if (sErr) throw new Error(`leer las tiendas: ${sErr.message}`);
    const allStores = (stores ?? []) as { id: string; status: string | null }[];
    const storeIds = allStores.filter((s) => s.status === "active").map((s) => s.id);
    if (!storeIds.length) return report;

    // Confirmar y crear la guía son UN paso: el pedido solo sale de Por
    // confirmar con la guía creada (owner, 02-11-2026). Sin guía automática
    // posible, no se confirma nada.
    if (!apiKey) {
      report.items.push({ orderId: "", orderName: null, step: "confirmar", outcome: "sin_clave", detail: "Falta CHATBY_API_KEY." });
    } else if (!settings.guide_enabled || (!dry && !env.aliclikWriteEnabled())) {
      report.items.push({
        orderId: "",
        orderName: null,
        step: "confirmar",
        outcome: "apagado",
        detail: "La guía automática está apagada: sin guía no se confirma nada.",
      });
    } else {
      const ctx: PassCtx = {
        dry,
        now,
        started,
        apiKey,
        askMode: settings.ask_mode,
        historyMode: settings.history_guide_mode,
        // El historial de la clienta es de toda la organización (también de una
        // tienda que ya no está activa).
        orgStoreIds: allStores.map((s) => s.id),
      };
      const guide = await guideContext(admin, settings, ctx, report);
      await confirmPass(admin, settings, storeIds, ctx, guide, report);
      // Lo que esperaba la ubicación de la clienta: ¿ya la mandó?
      if (!report.stopped) await watchPass(admin, settings, ctx, guide, report);
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : "Error de la confirmación por Chatby";
  }
  return report;
}

async function confirmPass(
  admin: SupabaseClient,
  settings: ChatbyAutoSettings,
  storeIds: string[],
  ctx: PassCtx,
  guide: GuideCtx,
  report: ChatbyAutoReport,
): Promise<void> {
  const { now } = ctx;
  const since = new Date(now.getTime() - settings.window_hours * 3_600_000).toISOString();
  const { data: masters, error } = await admin
    .from("order_master")
    .select("*")
    .in("store_id", storeIds)
    .eq("macro_stage", "por_confirmar")
    .eq("coverage", "provincia_cod")
    .in("macro_substage", ["sin_llamar", "por_confirmar"])
    .gte("order_created_at", since)
    .limit(1000);
  if (error) throw new Error(`leer el Master: ${error.message}`);
  const rows = (masters ?? []) as unknown as MasterRow[];
  if (!rows.length) return;
  const ids = rows.map((r) => r.order_id);

  const [checksRes, ordersRes, contactsRes] = await Promise.all([
    admin.from("chatby_auto_checks").select("order_id,outcome,checked_at,reads").in("order_id", ids),
    admin
      .from("orders")
      .select("id,name,created_at,cancelled_at,total_amount,total_refunded,currency,shopify_note")
      .in("id", ids),
    admin.from("order_events").select("order_id,note").eq("kind", "confirmation_contact").in("order_id", ids),
  ]);
  if (checksRes.error) throw new Error(`leer las marcas de Chatby: ${checksRes.error.message}`);
  if (ordersRes.error) throw new Error(`leer los pedidos: ${ordersRes.error.message}`);
  if (contactsRes.error) throw new Error(`leer las gestiones: ${contactsRes.error.message}`);
  const checkBy = new Map(
    ((checksRes.data ?? []) as (ChatbyCheckState & { order_id: string; reads: number | null })[]).map((c) => [c.order_id, c]),
  );
  const orderBy = new Map(((ordersRes.data ?? []) as OrderRow[]).map((o) => [o.id, o]));
  const notesBy = new Map<string, (string | null)[]>();
  for (const e of (contactsRes.data ?? []) as { order_id: string; note: string | null }[]) {
    notesBy.set(e.order_id, [...(notesBy.get(e.order_id) ?? []), e.note]);
  }

  const due = rows
    .map((master) => {
      const order = orderBy.get(master.order_id);
      if (!order) return null;
      const candidate: ChatbyCandidate = {
        master: {
          macro_stage: master.macro_stage,
          macro_substage: master.macro_substage,
          shipping_mode: master.shipping_mode,
          coverage: master.coverage,
          region: master.region,
          province: master.province,
          district: master.district,
          address: master.address,
          reference: master.reference,
          payment_state: master.payment_state,
          customer_phone: master.customer_phone,
        },
        order,
        contactNotes: notesBy.get(master.order_id) ?? [],
      };
      if (chatbyOrderSkip(candidate, settings, now)) return null;
      const check = checkBy.get(master.order_id) ?? null;
      if (!chatbyCheckDue(check, now, settings)) return null;
      return { master, order, check, createdAt: order.created_at, checkedAt: check?.checked_at ?? null };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort(chatbyReadOrder)
    .slice(0, settings.max_orders_per_run);

  if (!due.length) return;


  let errorsInARow = 0;
  for (const { master, order, check } of due) {
    if (Date.now() - ctx.started > TIME_BUDGET_MS) {
      report.stopped = "tiempo";
      return;
    }
    const item: ChatbyAutoItem = { orderId: order.id, orderName: order.name, step: "confirmar", outcome: "sin_confirmacion" };
    report.items.push(item);
    const key = { order_id: order.id, store_id: master.store_id, org_id: settings.org_id };
    const reads = (Number(check?.reads) || 0) + 1;

    const conversation = await fetchChatbyConversation({ phone: master.customer_phone, apiKey: ctx.apiKey });
    report.read++;
    if (conversation.status === "error") {
      item.outcome = "error";
      item.detail = conversation.message;
      if (!ctx.dry) await upsertCheck(admin, key, { outcome: "error", reason: "chatby", reads });
      errorsInARow++;
      if (errorsInARow >= MAX_CHATBY_ERRORS_IN_A_ROW) {
        report.stopped = "chatby";
        return;
      }
      continue;
    }
    errorsInARow = 0;
    if (conversation.status !== "ok") {
      item.outcome = "sin_conversacion";
      if (!ctx.dry) await upsertCheck(admin, key, { outcome: "sin_conversacion", reason: conversation.status, reads });
      continue;
    }

    const evalInput = {
      messages: conversation.messages,
      orderName: order.name!,
      orderCreatedAt: order.created_at,
      totalAmount: order.total_amount,
      order: {
        address: master.address,
        reference: master.reference,
        district: master.district,
        province: master.province,
        region: master.region,
      },
    };
    const verdict = evaluateChatbyConfirmation(evalInput);

    if (!verdict.confirm && !verdict.final) {
      // El botón «Confirmar pedido» no confirma (falta su mensaje), pero se
      // anota para encontrarla con una llamada corta (MOM §6.1, 08-11-2026).
      const buttonAt = chatbyConfirmButtonAt(conversation.messages, order.name!, order.created_at);
      if (!ctx.dry) {
        await upsertCheck(admin, key, {
          outcome: "sin_confirmacion",
          reason: verdict.reason,
          reads,
          ...(buttonAt ? { evidence: { boton_confirmar_at: buttonAt } } : {}),
        });
      }
      continue;
    }

    // (0317) La clienta confirmó y lo único que falla es la dirección
    // incompleta: si ya recibió en esa casa, la guía va con el GPS de esa
    // entrega. Va ANTES de pedirle la dirección (0318).
    let confirmed: { messageId: string; at: string | null; amountCents: number } | null = verdict.confirm ? verdict : null;
    let history: HistoryGuideUse | null = null;
    const heldEvidence: Record<string, unknown> = { total_cents: Math.round(Number(order.total_amount) * 100) };
    if (!verdict.confirm && verdict.reason === "direccion_incompleta" && ctx.historyMode !== "apagado") {
      const conf = historyGuideConfirmation(evalInput);
      if (conf) {
        const h = await historyGuideCheck(admin, ctx, report, { master, holdReason: "direccion_incompleta", item });
        if (h.evidence) heldEvidence.history_guide = h.evidence;
        if (h.use) {
          confirmed = conf;
          history = h.use;
        }
      }
    }

    if (!confirmed && !verdict.confirm) {
      // Había un mensaje de confirmación y no cuadró: la asesora lo ve en la
      // línea de tiempo, con el motivo, y la pasada ya no lo vuelve a leer.
      item.outcome = "para_asesora";
      addDetail(item, verdict.reason);
      report.held++;
      if (ctx.dry) continue;
      const evidence = heldEvidence;
      if (verdict.amountCents != null) evidence.amount_cents = verdict.amountCents;
      await holdForAdvisor(admin, key, item, { reason: verdict.reason, messageId: verdict.messageId, evidence, reads });
      // (0318) La dirección incompleta: Kapta le pide sola la dirección completa.
      if (verdict.reason === "direccion_incompleta" && item.outcome !== "error") {
        const message = verdict.messageId ? conversation.messages.find((m) => m.id === verdict.messageId) : undefined;
        const ask = chatbyAskKindFor({ reason: verdict.reason, messageText: message?.text ?? null, orderAddress: master.address });
        await autoAsk(admin, ctx, report, {
          key,
          master,
          conversation,
          item,
          kind: chatbyAutoAskKindFor({ reason: "direccion_incompleta", ask }),
          evidence: { policy: CHATBY_AUTO_POLICY, ...evidence },
          holdReason: verdict.reason,
        });
      }
      continue;
    }
    if (!confirmed) continue;

    // Justo antes de escribir: ¿sigue en Por confirmar? Una asesora pudo
    // confirmarlo (o anularlo) mientras se leía Chatby.
    if (!ctx.dry) {
      const { data: fresh, error: fErr } = await admin
        .from("order_master")
        .select("macro_stage,macro_substage")
        .eq("order_id", order.id)
        .maybeSingle();
      const stillOpen =
        !fErr &&
        (fresh as { macro_stage?: string } | null)?.macro_stage === "por_confirmar" &&
        ["sin_llamar", "por_confirmar"].includes((fresh as { macro_substage?: string } | null)?.macro_substage ?? "");
      if (!stillOpen) {
        item.outcome = "fuera";
        continue;
      }
    }

    // LA GUÍA PRIMERO. Solo sale de Por confirmar con la guía creada.
    const evidence: Record<string, unknown> = { amount_cents: confirmed.amountCents };
    if (heldEvidence.history_guide) evidence.history_guide = heldEvidence.history_guide;
    let g = await tryChatbyGuide(guide, master, conversation.messages, history ? { history } : {});
    // (0317) Google no la ubica y no mandó su ubicación: si ya recibió en esa
    // casa, la guía va con el GPS de esa entrega, ANTES de pedirle la ubicación.
    if (!history && g.kind === "hold" && g.reason === "sin_ubicacion" && ctx.historyMode !== "apagado") {
      const h = await historyGuideCheck(admin, ctx, report, { master, holdReason: "sin_ubicacion", item });
      if (h.evidence) evidence.history_guide = h.evidence;
      if (h.use) {
        history = h.use;
        g = await tryChatbyGuide(guide, master, conversation.messages, { history });
      }
    }
    if (g.kind === "wait") {
      // Aliclik en rojo, el tope del día o una creación en curso: sigue en Por
      // confirmar sin escribir nada visible y se vuelve a leer más tarde.
      item.outcome = g.outcome;
      addDetail(item, g.detail ?? g.outcome);
      if (!ctx.dry) await upsertCheck(admin, key, { outcome: "sin_confirmacion", reason: g.outcome, message_id: confirmed.messageId, reads });
      continue;
    }
    if (g.kind === "hold") {
      item.outcome = "para_asesora";
      addDetail(item, g.detail ? `${g.reason}: ${g.detail}` : g.reason);
      report.held++;
      if (ctx.dry) continue;
      await holdForAdvisor(admin, key, item, {
        reason: g.reason,
        detail: g.detail,
        messageId: confirmed.messageId,
        evidence,
        reads,
        guide: { state: g.state, detail: g.detail ? `${g.reason}: ${g.detail}` : g.reason, code: g.code ?? null },
      });
      // (0318) Google no encuentra la dirección: Kapta le pide sola la ubicación.
      if (g.reason === "sin_ubicacion" && item.outcome !== "error") {
        await autoAsk(admin, ctx, report, {
          key,
          master,
          conversation,
          item,
          kind: "ubicacion",
          evidence: { policy: CHATBY_AUTO_POLICY, ...evidence },
          holdReason: g.reason,
        });
      }
      continue;
    }
    if (ctx.dry) {
      item.outcome = "confirmaria";
      addDetail(item, g.detail ?? "guía");
      continue;
    }

    await confirmWithGuide(admin, key, master, order.name!, confirmed, g, reads, item, report, history);
  }
}

/**
 * Confirma por el registro atómico de la mesa, con la guía ya creada (o la que
 * ya tenía). Si falla, la pasada siguiente encuentra la guía («ya tenía») y
 * solo vuelve a intentar la confirmación.
 */
async function confirmWithGuide(
  admin: SupabaseClient,
  key: { order_id: string; store_id: string; org_id: string },
  master: MasterRow,
  orderName: string,
  verdict: { messageId: string; at: string | null; amountCents: number; pin?: boolean; addressCorrected?: boolean },
  g: { state: GuideState; code: string | null; detail?: string | null },
  reads: number,
  item: ChatbyAutoItem,
  report: ChatbyAutoReport,
  /** (0317) La guía salió con el GPS de una entrega anterior de la clienta. */
  history?: HistoryGuideUse | null,
): Promise<void> {
  const occurredAt = new Date().toISOString();
  const { error: rpcErr } = await admin.rpc("register_confirmation_attempt_v2", {
    p_store_id: master.store_id,
    p_order_id: key.order_id,
    p_actor: null,
    p_operation_id: chatbyOperationId(key.order_id, verdict.messageId),
    p_result: "confirmado",
    p_channel: "mensaje",
    p_note:
      chatbyConfirmationNote({
        orderName,
        at: verdict.at,
        amountCents: verdict.amountCents,
        location: verdict.pin,
        addressCorrected: verdict.addressCorrected,
      }) + (history ? historyGuideConfirmationSuffix(history.verdict) : ""),
    p_next_contact_on: null,
    p_occurred_at: occurredAt,
    p_reminder_due_at: null,
    p_source: CHATBY_SOURCE,
    p_payload_extra: {
      chatby: {
        policy: CHATBY_AUTO_POLICY,
        message_id: verdict.messageId,
        message_at: verdict.at,
        amount_cents: verdict.amountCents,
        ...(history
          ? {
              history_guide: {
                policy: HISTORY_GUIDE_POLICY,
                hold_reason: history.holdReason,
                delivered: history.verdict.delivered,
                source_order_id: history.verdict.source.orderId,
                source_order_name: history.verdict.source.orderName,
              },
            }
          : {}),
      },
    },
  });
  const guideMark = { state: g.state, detail: g.detail ?? null, code: g.code };
  if (rpcErr) {
    item.outcome = "error";
    item.detail = rpcErr.message;
    await upsertCheck(admin, key, { outcome: "error", reason: "confirmar", message_id: verdict.messageId, reads, guide: guideMark });
    return;
  }
  await recomputeOrderMasterSafe(admin, [key.order_id]);
  item.outcome = "confirmado";
  item.detail = g.code ?? undefined;
  report.confirmed++;
  await upsertCheck(admin, key, {
    outcome: "confirmado",
    message_id: verdict.messageId,
    evidence: {
      amount_cents: verdict.amountCents,
      ...(history
        ? {
            history_guide: {
              policy: HISTORY_GUIDE_POLICY,
              mode: "activo",
              outcome: "usada",
              hold_reason: history.holdReason,
              source_order_id: history.verdict.source.orderId,
              source_order_name: history.verdict.source.orderName,
              delivered: history.verdict.delivered,
            },
          }
        : {}),
    },
    reads,
    confirmed_at: occurredAt,
    guide: guideMark,
  });
}

/**
 * Deja el pedido para la asesora: el hecho en la línea de tiempo con el motivo
 * y la marca final (no se vuelve a leer). Sin el hecho, la asesora no sabría
 * por qué: entonces se reintenta en la próxima pasada.
 */
async function holdForAdvisor(
  admin: SupabaseClient,
  key: { order_id: string; store_id: string; org_id: string },
  item: ChatbyAutoItem,
  h: {
    reason: ChatbyHoldReason;
    detail?: string | null;
    messageId: string | null;
    evidence: Record<string, unknown>;
    reads: number;
    guide?: { state: GuideState; detail: string | null; code: string | null };
  },
): Promise<void> {
  const { error: eErr } = await admin.from("order_events").insert({
    store_id: key.store_id,
    order_id: key.order_id,
    kind: CHATBY_CONFIRMATION_HELD,
    occurred_at: new Date().toISOString(),
    actor: null,
    source: CHATBY_SOURCE,
    reason: CHATBY_HOLD_REASONS[h.reason],
    note: chatbyHoldNote(h.reason, h.detail),
    payload: {
      policy: CHATBY_AUTO_POLICY,
      reason: h.reason,
      message_id: h.messageId,
      ...h.evidence,
      ...(h.guide ? { guide: { state: h.guide.state, code: h.guide.code, origin: CHATBY_GUIDE_ORIGIN } } : {}),
    },
  });
  if (eErr) {
    item.outcome = "error";
    item.detail = eErr.message;
    await upsertCheck(admin, key, { outcome: "error", reason: "hecho", reads: h.reads, guide: h.guide ?? null });
    return;
  }
  await upsertCheck(admin, key, {
    outcome: "para_asesora",
    reason: h.reason,
    message_id: h.messageId,
    evidence: h.evidence,
    reads: h.reads,
    guide: h.guide ?? null,
  });
}

type GuideState = "creada" | "fallo" | "para_persona" | "ya_tenia" | "fuera";

interface PassCtx {
  dry: boolean;
  now: Date;
  started: number;
  apiKey: string;
  /** «Pedir sola la dirección o la ubicación» (0318). */
  askMode: ChatbyAskMode;
  /** «Guía automática para clientas con entregas» (0317). */
  historyMode: HistoryGuideMode;
  /** Las tiendas de la organización, para leer el historial de la clienta. */
  orgStoreIds: string[];
}

interface GuideCtx {
  admin: SupabaseClient;
  dry: boolean;
  today: string;
  /** Guías automáticas que quedan hoy (tope de la organización). */
  left: number;
  scopes: Map<string, AliclikReadScope | string>;
  waiting: Map<string, boolean>;
  report: ChatbyAutoReport;
  /** La clave de Google si la coordenada por dirección está encendida (0301), o null. */
  geocodeKey: string | null;
  /** «Aceptar ubicación aproximada en la calle correcta» (0316). */
  approxMode: ApproxMode;
}

/** EL TOPE: las guías automáticas de hoy (día de Lima), de toda la organización. */
async function guideContext(
  admin: SupabaseClient,
  settings: ChatbyAutoSettings,
  ctx: PassCtx,
  report: ChatbyAutoReport,
): Promise<GuideCtx> {
  const { count, error } = await admin
    .from("chatby_auto_checks")
    .select("order_id", { count: "exact", head: true })
    .eq("org_id", settings.org_id)
    .eq("guide_state", "creada")
    .gte("guide_at", limaDayStartIso(ctx.now));
  if (error) throw new Error(`leer el tope de guías de hoy: ${error.message}`);
  const left = guideCapLeft(count ?? 0, settings.daily_cap);
  report.guideCapLeft = left;
  const geocodeKey = settings.geocode_enabled ? env.googleGeocodingApiKey() || null : null;
  return {
    admin,
    dry: ctx.dry,
    today: limaTodayKey(ctx.now),
    left,
    scopes: new Map(),
    waiting: new Map(),
    report,
    geocodeKey,
    approxMode: settings.approx_mode,
  };
}

/** De dónde salió la coordenada de la guía automática (queda en `guide_detail`). */
type GuideCoordinateSource = "pedido" | "whatsapp" | "google" | "google_aprox" | "historial";

function coordinateNote(source: GuideCoordinateSource): string | null {
  if (source === "google") return "coordenada: dirección en Google (edificio)";
  if (source === "google_aprox") return APPROX_COORDINATE_NOTE;
  if (source === "whatsapp") return "coordenada: ubicación de WhatsApp";
  return null;
}

/** El origen del GPS que queda en `payload.gps` (lib/guide-gps.ts). null: la coordenada del pedido. */
function chatbyGpsOrigin(
  source: GuideCoordinateSource,
  from: { orderId: string; orderName: string | null } | null,
): GuideGpsOrigin | null {
  if (source === "historial") return { source: "historial", fromOrderId: from?.orderId ?? null, fromOrderName: from?.orderName ?? null };
  if (source === "whatsapp") return { source: "whatsapp" };
  if (source === "google") return { source: "google" };
  if (source === "google_aprox") return { source: "aproximada" };
  return null;
}

type GuideTry =
  /** La guía existe (creada ahora o ya la tenía): se puede confirmar. */
  | { kind: "ok"; state: "creada" | "ya_tenia"; code: string | null; detail?: string | null }
  /** Todavía no: se vuelve a leer más tarde, sin escribir nada visible. */
  | { kind: "wait"; outcome: string; detail?: string | null }
  /** No se puede crear sola: para la asesora, en Por confirmar. */
  | { kind: "hold"; reason: ChatbyHoldReason; detail: string | null; state: GuideState; code?: string | null };

/**
 * La guía Aliclik del pedido que confirmó por Chatby, ANTES de confirmarlo.
 * Por el mismo camino que el botón y que la guía del día programado (§6.2,
 * §10.2): `createAliclikGuideFor` con todas sus rejas. La coordenada es la del
 * pedido o, si no trae (WooCommerce), la ubicación que mandó la clienta por
 * WhatsApp en esta compra (`chatbyGuidePin`). En `dry` solo cotiza.
 */
async function tryChatbyGuide(
  g: GuideCtx,
  row: MasterRow,
  messages: readonly ChatbyMessage[],
  opts: { forcePin?: boolean; history?: HistoryGuideUse } = {},
): Promise<GuideTry> {
  const { admin } = g;
  if (chatbyGuideBlock(row)) return { kind: "hold", reason: "programado", detail: null, state: "para_persona" };
  // La lista de pago adelantado (MOM §41): Chatby no confirma contra entrega a
  // un cliente de la lista. Lo deja a una persona, que cobra el total por
  // adelantado. Va antes de cotizar: también en la simulación.
  const prepay = await prepayOrderCheck(admin, row as unknown as PrepayOrderRow, "confirmar");
  // «Pago solo online (lista automática)», §41.11: tampoco crea la guía contra
  // entrega; la deja a la asesora con el motivo y no le escribe a la clienta.
  if (prepay.state === "blocked" && prepay.source === "pago_online") {
    return { kind: "hold", reason: "pago_online", detail: prepay.message, state: "para_persona" };
  }
  if (prepay.state !== "ok") return { kind: "hold", reason: "guia_no_creada", detail: prepay.message, state: "para_persona" };
  // Sin saber si va por Shalom no se crea nada: es la diferencia entre esperar
  // diez minutos y mandar un paquete por el courier equivocado (§6.2).
  const { data: draft, error: dErr } = await admin
    .from("shalom_order_drafts")
    .select("order_id")
    .eq("order_id", row.order_id)
    .limit(1);
  if (dErr) return { kind: "wait", outcome: "error", detail: `leer el borrador de Shalom: ${dErr.message}` };
  const hold = chatbyGuideHold({ hasShalomDraft: (draft ?? []).length > 0, paymentState: row.payment_state });
  if (hold === "shalom") return { kind: "hold", reason: "shalom", detail: null, state: "para_persona" };
  if (hold) return { kind: "hold", reason: "guia_no_creada", detail: "Tiene un pago registrado.", state: "para_persona" };

  const live = await activeAliclikBlocker(admin, row.order_id);
  if (live.guide) return { kind: "ok", state: "ya_tenia", code: live.guide.guide_code ?? null, detail: live.guide.courier ?? null };
  if (live.error) return failed(g, live.error);

  if (g.left <= 0) return { kind: "wait", outcome: "tope", detail: "Ya se crearon las guías automáticas de hoy." };

  // Con Aliclik en rojo se espera a la pasada siguiente, sin avisar (§10.2).
  if (!g.waiting.has(row.store_id)) {
    g.waiting.set(row.store_id, waitForAliclik(await loadAliclikHealthState(admin, row.store_id), 0));
  }
  if (g.waiting.get(row.store_id)) return { kind: "wait", outcome: "esperando_aliclik" };

  // La coordenada: la del pedido si la trae; si no, la ubicación que mandó la
  // clienta por WhatsApp en esta compra. Sin ninguna, se la pide una persona.
  let coordinate: string | null = null;
  let source: GuideCoordinateSource = "pedido";
  if (opts.history) {
    // (0317) La clienta ya recibió en esta misma dirección, sin fallidos: la
    // guía va con el GPS de la guía de esa entrega, por el mismo camino que la
    // ubicación de WhatsApp (nunca la coordenada del pedido ni Google) y con
    // las mismas puertas: el pin respaldado al cotizar y todas las rejas.
    coordinate = opts.history.verdict.coordinate;
    source = "historial";
  } else if (opts.forcePin) {
    // La dirección escrita estaba incompleta y la clienta mandó su ubicación
    // (owner, 08-11-2026): la guía va con ESA ubicación, nunca con la
    // coordenada del pedido ni con Google. Las mismas condiciones del pin
    // (`chatbyGuidePin`) y, al cotizar, el pin respaldado.
    const pin = chatbyGuidePin(messages, row.order_created_at);
    if (!pin) return { kind: "hold", reason: "sin_ubicacion", detail: null, state: "para_persona" };
    coordinate = pin.coordinate;
    source = "whatsapp";
  } else if (row.latitude == null || row.longitude == null) {
    const pin = chatbyGuidePin(messages, row.order_created_at);
    if (pin) {
      coordinate = pin.coordinate;
      source = "whatsapp";
    } else if (g.geocodeKey && !g.dry && row.coverage === "provincia_cod") {
      // Sin ubicación de WhatsApp: la dirección escrita en Google, solo si da
      // el EDIFICIO (decisiones A y B del owner, 02-11-2026; MOM §38). Una
      // consulta por pedido y dirección (0301). El candado del pin respaldado
      // de Aliclik se aplica igual al cotizar. Con «ubicación aproximada en la
      // calle correcta» (0316) también la cuadra de la misma calle, número y
      // provincia: en Simulación solo se guarda y queda para la asesora como
      // siempre; en Activo se usa.
      const approxMode = g.approxMode === "apagado" ? undefined : g.approxMode;
      const geo = await geocodeOrderAddress(
        admin,
        {
          order_id: row.order_id,
          store_id: row.store_id,
          address: row.address ?? null,
          district: row.district ?? null,
          province: row.province ?? null,
          region: row.region ?? null,
        },
        { key: g.geocodeKey, approxMode },
      );
      const decision = approxDecision(g.approxMode, geo);
      if (decision.use === "ninguna") {
        // Una vez por punto: la pasada que vuelve a mirar el chat cada 30 min usa lo guardado.
        if (decision.simulated && geo.kind === "rejected" && !geo.cached) {
          g.report.approxSimulated++;
          console.info(`[chatby-aprox] ${JSON.stringify({ order: row.order_id, mode: "simulacion", outcome: "habria_confirmado" })}`);
        }
        return { kind: "hold", reason: "sin_ubicacion", detail: null, state: "para_persona" };
      }
      coordinate = `${decision.lat}, ${decision.lng}`;
      source = decision.use === "aproximada" ? "google_aprox" : "google";
    } else {
      return { kind: "hold", reason: "sin_ubicacion", detail: null, state: "para_persona" };
    }
  }

  let scope = g.scopes.get(row.store_id);
  if (!scope) {
    const resolved = await aliclikReadScopeFor(admin, row.store_id);
    scope = resolved.scope ?? resolved.error ?? "No se pudo leer la organización de la tienda.";
    g.scopes.set(row.store_id, scope);
  }
  if (typeof scope === "string") return failed(g, scope);

  const { ctx: aliclik, error: ctxError } = await aliclikContextFor(row, null, { blockAgencia: true });
  if (!aliclik) return failed(g, ctxError ?? "No se pudo preparar la conexión con Aliclik.");

  const preview = await previewAliclikGuideFor(aliclik, { modality: "cod", coordinate }, scope);
  // El pedido contradice el pin (otro departamento y otra ciudad): no es un
  // fallo de Aliclik, es un destino que tiene que mirar una persona. La guía
  // automática nunca escribe la excepción.
  if (!preview.ok && preview.pinSinCorroborar) {
    return { kind: "hold", reason: "pin_sin_respaldo", detail: preview.pinSinCorroborar, state: "para_persona" };
  }
  if (!preview.ok && preview.needsCoordinate) return { kind: "hold", reason: "sin_ubicacion", detail: null, state: "para_persona" };
  if (!preview.ok) return failed(g, preview.error ?? "No se pudo cotizar el envío.");
  const transport = autoTransport(preview.couriers);
  if (!transport) return failed(g, "Ninguna transportadora de Aliclik se puede agendar ahora para este destino.");
  if (g.dry) {
    g.left--;
    return {
      kind: "ok",
      state: "creada",
      code: null,
      detail: `guía simulada: ${transport.transportName ?? "courier"} S/ ${transport.deliveryCost} · cobrar S/ ${(preview.collectTotal ?? 0).toFixed(2)}`,
    };
  }

  const result = await createAliclikGuideFor(
    aliclik,
    { transportId: transport.transportId, expectedCollectTotal: preview.collectTotal ?? null, note: null, coordinate },
    scope,
    opts.history
      ? {
          kind: CHATBY_GUIDE_ORIGIN,
          scheduledOn: g.today,
          reason: historyGuideReason(row.order_name, opts.history.verdict),
          gpsFrom: opts.history.verdict.source.orderName,
        }
      : { kind: CHATBY_GUIDE_ORIGIN, scheduledOn: g.today, reason: chatbyGuideReason(row.order_name) },
    // De dónde salió el GPS, para el hecho `guide_registered` (`payload.gps`).
    // La del pedido la rotula la creación según `geo_source`.
    chatbyGpsOrigin(source, opts.history?.verdict.source ?? null),
  );
  if (result.locked) {
    // Otra creación tiene el candado (una persona creándola ahora): no es un fallo.
    return { kind: "wait", outcome: "en_curso", detail: result.error ?? null };
  }
  if (result.timedOut) {
    // Aliclik pudo crearla: cuenta para el tope y NO se reintenta, que es lo
    // que crea duplicados. La asesora mira Aliclik antes de crear otra.
    g.left--;
    if (source === "google_aprox") await markApproxUsed(admin, row.order_id);
    return {
      kind: "hold",
      reason: "guia_no_creada",
      detail: `Aliclik no respondió a tiempo y pudo haberla creado: revisa Aliclik antes de crear otra. ${result.error ?? ""}`.trim(),
      state: "creada",
    };
  }
  if (result.error && result.orderNumber) {
    // Se creó en Aliclik y no se pudo guardar la fila: existe y cuenta para el tope.
    g.left--;
    if (source === "google_aprox") await markApproxUsed(admin, row.order_id);
    g.report.guidesCreated++;
    return {
      kind: "hold",
      reason: "guia_no_creada",
      detail: `Se creó en Aliclik (${result.orderNumber}) pero no se guardó en Kapta: vincúlala. ${result.error}`,
      state: "creada",
      code: result.orderNumber,
    };
  }
  if (result.error) return failed(g, result.error);
  g.left--;
  g.report.guidesCreated++;
  g.report.guideCapLeft = g.left;
  if (source === "google_aprox") {
    // La guía guarda este punto: la medición no debe compararlo consigo mismo.
    g.report.approxUsed++;
    await markApproxUsed(admin, row.order_id);
  }
  if (opts.history) {
    g.report.historyUsed++;
    await recordHistoryGuideFact(admin, row, result.orderNumber ?? null, opts.history);
    return { kind: "ok", state: "creada", code: result.orderNumber ?? null, detail: historyGuideCoordinateNote(opts.history.verdict) };
  }
  return { kind: "ok", state: "creada", code: result.orderNumber ?? null, detail: coordinateNote(source) };
}

function failed(g: GuideCtx, error: string): GuideTry {
  if (!g.dry) g.report.guidesFailed++;
  return { kind: "hold", reason: "guia_no_creada", detail: error, state: "fallo" };
}

// ---------------------------------------------------------------------------
// Mirar el chat hasta que llegue la ubicación (owner, 02-11-2026)
// ---------------------------------------------------------------------------

/** Los que esperan la ubicación por pasada, aparte de los de la confirmación. */
function watchLimit(settings: ChatbyAutoSettings): number {
  return Math.max(1, Math.ceil(settings.max_orders_per_run / 2));
}

interface WatchRow {
  order_id: string;
  store_id: string;
  message_id: string | null;
  reads: number | null;
  /**
   * «por_confirmar»: quedó en Por confirmar sin ubicación; «confirmado»: ya
   * confirmado, sin guía; «pedida»: quedó para la asesora por la dirección
   * incompleta (o se dejó de mirar sin ubicación) y se le pidió la ubicación
   * desde la ficha (owner, 08-11-2026; `chatbyHeldWatchDue`).
   */
  kind: "por_confirmar" | "confirmado" | "pedida";
  reason?: string | null;
  evidence?: Record<string, unknown> | null;
}

/**
 * Los pedidos sin guía porque la clienta no mandó su ubicación, mientras dure
 * la ventana: se vuelve a leer su chat cada `recheck_minutes` y, cuando llega
 * la ubicación, se crea la guía por el mismo camino (`tryChatbyGuide`, con el
 * tope del día). Los que seguían en Por confirmar se confirman con la guía
 * creada; los que ya estaban confirmados (los primeros, del 01-11) solo reciben
 * su guía.
 */
async function watchPass(
  admin: SupabaseClient,
  settings: ChatbyAutoSettings,
  ctx: PassCtx,
  guide: GuideCtx,
  report: ChatbyAutoReport,
): Promise<void> {
  const { now } = ctx;
  const recheckBefore = new Date(now.getTime() - settings.recheck_minutes * 60_000).toISOString();
  const since = new Date(now.getTime() - settings.window_hours * 3_600_000).toISOString();
  const limit = watchLimit(settings);
  const [heldRes, confirmedRes, askedRes] = await Promise.all([
    admin
      .from("chatby_auto_checks")
      .select("order_id,store_id,message_id,reads,evidence")
      .eq("org_id", settings.org_id)
      .eq("outcome", "para_asesora")
      .eq("reason", "sin_ubicacion")
      .lte("checked_at", recheckBefore)
      .order("checked_at", { ascending: true })
      .limit(limit),
    admin
      .from("chatby_auto_checks")
      .select("order_id,store_id,message_id,reads")
      .eq("org_id", settings.org_id)
      .eq("outcome", "confirmado")
      .eq("guide_state", "para_persona")
      .eq("guide_detail", "sin_ubicacion")
      .gte("confirmed_at", since)
      .lte("guide_at", recheckBefore)
      .order("guide_at", { ascending: true })
      .limit(limit),
    // A los que se les pidió la ubicación desde la ficha (`chatbyHeldWatchDue`).
    admin
      .from("chatby_auto_checks")
      .select("order_id,store_id,message_id,reads,outcome,reason,checked_at,evidence")
      .eq("org_id", settings.org_id)
      .eq("outcome", "para_asesora")
      .in("reason", ["direccion_incompleta", "sin_ubicacion_cerrado"])
      .not("evidence->>asked_at", "is", null)
      .lte("checked_at", recheckBefore)
      .order("checked_at", { ascending: true })
      .limit(limit),
  ]);
  if (heldRes.error) throw new Error(`leer los que esperan ubicación: ${heldRes.error.message}`);
  if (confirmedRes.error) throw new Error(`leer los confirmados sin ubicación: ${confirmedRes.error.message}`);
  if (askedRes.error) throw new Error(`leer a los que se les pidió la ubicación: ${askedRes.error.message}`);
  const rows: WatchRow[] = [
    ...((heldRes.data ?? []) as Omit<WatchRow, "kind">[]).map((r) => ({ ...r, kind: "por_confirmar" as const })),
    ...((confirmedRes.data ?? []) as Omit<WatchRow, "kind">[]).map((r) => ({ ...r, kind: "confirmado" as const })),
    ...((askedRes.data ?? []) as (Omit<WatchRow, "kind"> & { outcome: string; reason: string | null; checked_at: string })[])
      .filter((r) => chatbyHeldWatchDue(r, now, settings))
      .map(({ outcome: _o, checked_at: _c, ...r }) => ({ ...r, kind: "pedida" as const })),
  ];
  if (!rows.length) return;

  const { data: masters, error: mErr } = await admin
    .from("order_master")
    .select("*")
    .in("order_id", rows.map((r) => r.order_id));
  if (mErr) throw new Error(`leer el Master: ${mErr.message}`);
  const masterBy = new Map(((masters ?? []) as unknown as MasterRow[]).map((m) => [m.order_id, m]));

  // Lo que se escribe sin cambiar nada visible: «se miró, sigue sin ubicación».
  const touch = async (r: WatchRow, patch: Record<string, unknown> = {}) => {
    if (ctx.dry) return;
    const at = new Date().toISOString();
    const base = r.kind === "confirmado" ? { guide_at: at } : { checked_at: at };
    await admin
      .from("chatby_auto_checks")
      .update({ ...base, reads: (Number(r.reads) || 0) + 1, ...patch })
      .eq("order_id", r.order_id);
  };

  let errorsInARow = 0;
  for (const r of rows) {
    if (Date.now() - ctx.started > TIME_BUDGET_MS) {
      report.stopped = "tiempo";
      return;
    }
    const master = masterBy.get(r.order_id);
    if (!master) continue;
    const item: ChatbyAutoItem = { orderId: r.order_id, orderName: master.order_name, step: "ubicacion", outcome: "sin_ubicacion" };
    report.items.push(item);
    const key = { order_id: r.order_id, store_id: r.store_id, org_id: settings.org_id };
    const reads = (Number(r.reads) || 0) + 1;

    // ¿Sigue donde lo dejamos? Si una persona ya lo movió, se deja de mirar.
    const open =
      r.kind !== "confirmado"
        ? master.macro_stage === "por_confirmar" && ["sin_llamar", "por_confirmar"].includes(master.macro_substage ?? "")
        : master.macro_stage === "preparacion" && master.macro_substage === "por_generar_rotulo";
    const createdMs = Date.parse(master.order_created_at ?? "");
    const inWindow = Number.isFinite(createdMs) && createdMs >= Date.parse(since);
    // Ya no coincide con la búsqueda: no se vuelve a leer.
    const stopWatching = async () => {
      item.outcome = "fuera";
      await touch(
        r,
        r.kind === "pedida"
          ? { evidence: { ...(r.evidence ?? {}), asked_at: null } }
          : r.kind === "por_confirmar"
            ? { reason: "sin_ubicacion_cerrado" }
            : { guide_detail: "sin_ubicacion_cerrado" },
      );
    };
    if (!open) {
      await stopWatching();
      continue;
    }
    // Pasadas las 72 h del pedido, lo que quedó para la asesora por la
    // dirección o la ubicación se sigue mirando mientras la clienta haya
    // escrito hace menos de 24 h (la ventana de atención de WhatsApp manda,
    // owner 08-11-2026): se lee su chat y, si no, se deja de mirar. La misma
    // búsqueda y el mismo tope; nada de sondeo nuevo.
    const pastOrderWindow = r.kind !== "confirmado" && !inWindow;

    const conversation = await fetchChatbyConversation({ phone: master.customer_phone, apiKey: ctx.apiKey });
    report.read++;
    if (conversation.status === "error") {
      item.outcome = "error";
      item.detail = conversation.message;
      if (++errorsInARow >= MAX_CHATBY_ERRORS_IN_A_ROW) {
        report.stopped = "chatby";
        return;
      }
      continue;
    }
    errorsInARow = 0;
    if (conversation.status !== "ok") {
      if (pastOrderWindow) await stopWatching();
      else await touch(r);
      continue;
    }
    if (pastOrderWindow && !chatbyHeldInWindow({ orderCreatedAt: master.order_created_at, now, windowHours: settings.window_hours, messages: conversation.messages })) {
      await stopWatching();
      continue;
    }

    const watchInput = {
      messages: conversation.messages,
      orderName: master.order_name ?? "",
      orderCreatedAt: master.order_created_at ?? "",
      totalAmount: master.order_total,
      order: {
        address: master.address,
        reference: master.reference,
        district: master.district,
        province: master.province,
        region: master.region,
      },
    };
    // (0318) La dirección ya la corrigió la clienta: la del mensaje es la vieja
    // y no se compara (`chatbyCorrectedWatch`).
    const corrected = r.kind === "por_confirmar" && chatbyAddressCorrectedAt(r.evidence) !== null;
    const located = corrected ? null : chatbyLocationWatch(watchInput);
    const watch: ChatbyReaskVerdict = !located
      ? chatbyCorrectedWatch(watchInput)
      : located.kind === "confirm"
        ? { ...located, pin: false }
        : located;

    if (r.kind === "confirmado") {
      // Ya estaba confirmado: solo importa un «no lo quiero» o una anulación.
      if (watch.kind === "hold" && (watch.reason === "rechazo" || watch.reason === "anulado_en_chat")) {
        item.outcome = "para_asesora";
        item.detail = watch.reason;
        await touch(r, { guide_detail: `sin_ubicacion_cerrado: ${watch.reason}` });
        continue;
      }
      const g = await tryChatbyGuide(guide, master, conversation.messages);
      if (g.kind === "wait" || (g.kind === "hold" && g.reason === "sin_ubicacion")) {
        item.detail = g.kind === "wait" ? g.outcome : undefined;
        await touch(r);
        continue;
      }
      if (g.kind === "hold") {
        item.outcome = g.state === "fallo" ? "fallo" : "para_persona";
        item.detail = g.detail ? `${g.reason}: ${g.detail}` : g.reason;
        if (ctx.dry) continue;
        if (g.state === "fallo") {
          await admin.from("order_events").insert({
            store_id: master.store_id,
            order_id: master.order_id,
            kind: ALICLIK_AUTO_FAILED,
            occurred_at: new Date().toISOString(),
            actor: null,
            source: "system",
            courier: "aliclik",
            reason: (g.detail ?? g.reason).slice(0, 2000),
            note: "La clienta mandó su ubicación, pero no se pudo crear la guía Aliclik automática. Hay que crearla a mano.",
            payload: { date: guide.today, policy: CHATBY_AUTO_POLICY, origin: CHATBY_GUIDE_ORIGIN },
          });
        }
        await touch(r, { guide_state: g.state, guide_detail: item.detail.slice(0, 1000), guide_code: g.code ?? null });
        continue;
      }
      item.outcome = ctx.dry ? "simulada" : "creada";
      item.detail = g.code ?? g.detail ?? undefined;
      if (ctx.dry) continue;
      await touch(r, { guide_state: g.state, guide_detail: g.detail ?? null, guide_code: g.code });
      await recomputeOrderMasterSafe(admin, [master.order_id]);
      continue;
    }

    if (r.kind === "pedida") {
      await reaskWatch(admin, ctx, guide, report, { r, key, master, item, reads, conversation, touch });
      continue;
    }

    // Seguía en Por confirmar esperando la ubicación.
    if (watch.kind === "wait" || watch.kind === "correct") {
      await touch(r);
      continue;
    }
    if (watch.kind === "hold") {
      item.outcome = "para_asesora";
      item.detail = watch.reason;
      report.held++;
      if (ctx.dry) continue;
      await holdForAdvisor(admin, key, item, { reason: watch.reason, messageId: r.message_id, evidence: {}, reads });
      continue;
    }
    let g = await tryChatbyGuide(guide, master, conversation.messages, corrected ? { forcePin: watch.pin } : {});
    // (0317) Sigue sin ubicación: si la clienta ya recibió en esa casa, la guía
    // va con el GPS de esa entrega, ANTES de que Kapta le pida la ubicación.
    // También le llega a lo que quedó así antes de encender el interruptor.
    let history: HistoryGuideUse | null = null;
    let watchEvidence = r.evidence ?? {};
    if (g.kind === "hold" && g.reason === "sin_ubicacion" && ctx.historyMode !== "apagado") {
      const h = await historyGuideCheck(admin, ctx, report, { master, holdReason: "sin_ubicacion", item, prior: r.evidence?.history_guide });
      if (h.evidence) watchEvidence = { ...watchEvidence, history_guide: h.evidence };
      if (h.use) {
        history = h.use;
        g = await tryChatbyGuide(guide, master, conversation.messages, { history });
      }
    }
    if (g.kind === "wait" || (g.kind === "hold" && g.reason === "sin_ubicacion")) {
      if (g.kind === "wait") addDetail(item, g.outcome);
      await touch(r, watchEvidence === r.evidence ? {} : { evidence: watchEvidence });
      // (0318) Sigue sin ubicación: si Kapta todavía no se la pidió, se la pide
      // sola (una vez). Así también le llega a lo que quedó así antes de
      // encender el interruptor.
      if (g.kind === "hold") {
        await autoAsk(admin, ctx, report, {
          key,
          master,
          conversation,
          item,
          kind: chatbyAutoAskKindFor({ reason: "sin_ubicacion", ask: "ubicacion", corrected }),
          evidence: watchEvidence,
          holdReason: "sin_ubicacion",
        });
      }
      continue;
    }
    const evidence: Record<string, unknown> = { ...chatbyAutoAskCarry(r.evidence), amount_cents: watch.amountCents };
    if (watchEvidence.history_guide) evidence.history_guide = watchEvidence.history_guide;
    if (g.kind === "hold") {
      item.outcome = "para_asesora";
      item.detail = g.detail ? `${g.reason}: ${g.detail}` : g.reason;
      report.held++;
      if (ctx.dry) continue;
      await holdForAdvisor(admin, key, item, {
        reason: g.reason,
        detail: g.detail,
        messageId: watch.messageId,
        evidence,
        reads,
        guide: { state: g.state, detail: item.detail, code: g.code ?? null },
      });
      continue;
    }
    if (ctx.dry) {
      item.outcome = "confirmaria";
      item.detail = g.detail ?? undefined;
      continue;
    }
    await confirmWithGuide(
      admin,
      key,
      master,
      master.order_name ?? "el pedido",
      { ...watch, pin: corrected && g.detail === coordinateNote("whatsapp"), addressCorrected: corrected },
      g,
      reads,
      item,
      report,
      history,
    );
  }
}

/**
 * El que quedó para la asesora por la dirección incompleta (o se dejó de mirar
 * sin ubicación) y al que se le pidió la ubicación desde la ficha (owner,
 * 08-11-2026) o Kapta sola (0318). Sin un mensaje NUEVO de la clienta desde que
 * quedó para la asesora no se evalúa nada. Con él, `chatbyReaskWatch`: su
 * ubicación primero (va como coordenada de la guía, con las puertas del pin),
 * una dirección escrita después (con las reglas de siempre). Con «Pedir sola
 * la dirección o la ubicación» encendido, una dirección COMPLETA que no es la
 * del pedido se guarda como la dirección corregida y Google la vuelve a buscar
 * (`correctAddress`).
 */
async function reaskWatch(
  admin: SupabaseClient,
  ctx: PassCtx,
  guide: GuideCtx,
  report: ChatbyAutoReport,
  w: {
    r: WatchRow;
    key: { order_id: string; store_id: string; org_id: string };
    master: MasterRow;
    item: ChatbyAutoItem;
    reads: number;
    conversation: OkConversation;
    touch: (r: WatchRow, patch?: Record<string, unknown>) => Promise<void>;
  },
): Promise<void> {
  const { r, key, master, item, reads, conversation, touch } = w;
  const messages = conversation.messages;
  if (!chatbyNewCustomerMessage(messages, chatbyHeldAt({ evidence: r.evidence ?? null }))) {
    item.outcome = "sin_respuesta";
    await touch(r);
    return;
  }
  const input = {
    messages,
    orderName: master.order_name ?? "",
    orderCreatedAt: master.order_created_at ?? "",
    totalAmount: master.order_total,
    order: {
      address: master.address,
      reference: master.reference,
      district: master.district,
      province: master.province,
      region: master.region,
    },
  };
  // (0318) Ya corregida (la pasada guardó la dirección y quedó esperando): la
  // dirección vieja del mensaje no se compara.
  const corrected = chatbyAddressCorrectedAt(r.evidence) !== null;
  const correctionSince =
    ctx.askMode !== "apagado" && r.reason === "direccion_incompleta" ? chatbyAskedAt({ evidence: r.evidence ?? null }) : null;
  const verdict = corrected ? chatbyCorrectedWatch(input) : chatbyReaskWatch({ ...input }, { correctionSince });
  if (verdict.kind === "wait") {
    if (verdict.reply === "incompleta") {
      // Escribió, pero la dirección sigue incompleta: no se le pide otra vez;
      // la asesora la mira desde la ficha.
      item.outcome = "respuesta_incompleta";
      const mark = r.evidence?.reply_incomplete_at ? {} : { evidence: { ...(r.evidence ?? {}), reply_incomplete_at: new Date().toISOString() } };
      await touch(r, mark);
      return;
    }
    await touch(r);
    return;
  }
  if (verdict.kind === "hold") {
    item.outcome = "para_asesora";
    item.detail = verdict.reason;
    report.held++;
    if (ctx.dry) return;
    await holdForAdvisor(admin, key, item, { reason: verdict.reason, messageId: r.message_id, evidence: {}, reads });
    return;
  }
  if (verdict.kind === "correct") {
    await correctAddress(admin, ctx, guide, report, { ...w, verdict });
    return;
  }
  const g = await tryChatbyGuide(guide, master, messages, { forcePin: verdict.pin });
  // Se dejó de mirar sin ubicación y sigue sin ella: queda como estaba.
  if (g.kind === "wait" || (g.kind === "hold" && g.reason === "sin_ubicacion" && r.reason === "sin_ubicacion_cerrado")) {
    item.detail = g.kind === "wait" ? g.outcome : undefined;
    await touch(r);
    return;
  }
  const viaPin = verdict.pin || (corrected && g.kind === "ok" && g.detail === coordinateNote("whatsapp"));
  await guideOutcome(admin, ctx, guide, report, {
    ...w,
    verdict: { messageId: verdict.messageId, at: verdict.at, amountCents: verdict.amountCents, pin: viaPin, addressCorrected: corrected },
    g,
    corrected,
  });
}

type OkConversation = Extract<ChatbyConversation, { status: "ok" }>;

/**
 * Después de la guía de una relectura: para la asesora (con la marca de las
 * pedidas automáticas y, si falta la ubicación, la pedida sola de la
 * ubicación) o confirmado con la guía creada.
 */
async function guideOutcome(
  admin: SupabaseClient,
  ctx: PassCtx,
  guide: GuideCtx,
  report: ChatbyAutoReport,
  w: {
    r: WatchRow;
    key: { order_id: string; store_id: string; org_id: string };
    master: MasterRow;
    item: ChatbyAutoItem;
    reads: number;
    conversation: OkConversation;
    verdict: { messageId: string; at: string | null; amountCents: number; pin: boolean; addressCorrected?: boolean };
    g: GuideTry;
    corrected: boolean;
  },
): Promise<void> {
  const { r, key, master, item, reads, conversation, verdict, corrected } = w;
  let g = w.g;
  if (g.kind === "wait") return;
  const evidence: Record<string, unknown> = { ...chatbyAutoAskCarry(r.evidence), amount_cents: verdict.amountCents };
  // (0317) Falta la ubicación: si la clienta ya recibió en esa casa, la guía va
  // con el GPS de esa entrega, ANTES de pedirle la ubicación.
  let history: HistoryGuideUse | null = null;
  if (g.kind === "hold" && g.reason === "sin_ubicacion" && ctx.historyMode !== "apagado") {
    const h = await historyGuideCheck(admin, ctx, report, { master, holdReason: "sin_ubicacion", item, prior: r.evidence?.history_guide });
    if (h.evidence) evidence.history_guide = h.evidence;
    if (h.use) {
      history = h.use;
      g = await tryChatbyGuide(guide, master, conversation.messages, { history });
      if (g.kind === "wait") {
        addDetail(item, g.outcome);
        return;
      }
    }
  }
  if (g.kind === "hold") {
    // La dirección ya cuadra pero falta la ubicación (`sin_ubicacion`, que la
    // pasada de la ubicación sigue mirando) u otra puerta de la guía.
    item.outcome = "para_asesora";
    item.detail = g.detail ? `${g.reason}: ${g.detail}` : g.reason;
    report.held++;
    if (ctx.dry) return;
    await holdForAdvisor(admin, key, item, {
      reason: g.reason,
      detail: g.detail,
      messageId: verdict.messageId,
      evidence,
      reads,
      guide: { state: g.state, detail: item.detail, code: g.code ?? null },
    });
    // (0318) Sin ubicación: Kapta se la pide sola (una vez).
    if (g.reason === "sin_ubicacion" && item.outcome !== "error") {
      await autoAsk(admin, ctx, report, {
        key,
        master,
        conversation,
        item,
        kind: chatbyAutoAskKindFor({ reason: "sin_ubicacion", ask: "ubicacion", corrected }),
        evidence: { policy: CHATBY_AUTO_POLICY, ...evidence },
        holdReason: g.reason,
      });
    }
    return;
  }
  if (ctx.dry) {
    item.outcome = "confirmaria";
    item.detail = g.detail ?? undefined;
    return;
  }
  await confirmWithGuide(admin, key, master, master.order_name ?? "el pedido", verdict, g, reads, item, report, history);
}

/**
 * (0318) La clienta respondió a la pedida con una dirección COMPLETA: se guarda
 * como la dirección corregida del pedido (el camino de «Corregir ubicación»,
 * `order_geo_overrides`, con el distrito y la provincia de siempre) y la guía
 * se vuelve a intentar con ella, Google incluido (con la regla de la ubicación
 * aproximada). Si Google tampoco la encuentra, queda `sin_ubicacion` y Kapta le
 * pide la ubicación. En Simulación solo se dice qué habría hecho.
 */
async function correctAddress(
  admin: SupabaseClient,
  ctx: PassCtx,
  guide: GuideCtx,
  report: ChatbyAutoReport,
  w: {
    r: WatchRow;
    key: { order_id: string; store_id: string; org_id: string };
    master: MasterRow;
    item: ChatbyAutoItem;
    reads: number;
    conversation: OkConversation;
    touch: (r: WatchRow, patch?: Record<string, unknown>) => Promise<void>;
    verdict: Extract<ChatbyReaskVerdict, { kind: "correct" }>;
  },
): Promise<void> {
  const { r, key, item, touch, verdict } = w;
  if (ctx.askMode !== "activo") {
    item.outcome = "simulado";
    item.detail = "habría guardado la dirección que escribió la clienta y la habría vuelto a buscar en Google";
    if (!r.evidence?.correction_simulated_at) {
      report.asksSimulated++;
      console.info(`[chatby-pedir] ${JSON.stringify({ order: key.order_id, mode: "simulacion", outcome: "habria_corregido" })}`);
      await touch(r, { evidence: { ...(r.evidence ?? {}), correction_simulated_at: new Date().toISOString() } });
    } else {
      await touch(r);
    }
    return;
  }
  if (ctx.dry) {
    item.outcome = "corregiria";
    item.detail = "guardaría la dirección que escribió la clienta y la volvería a buscar en Google";
    return;
  }
  // Justo antes de escribir: ¿sigue en Por confirmar?
  const { data: fresh, error: fErr } = await admin.from("order_master").select("*").eq("order_id", key.order_id).maybeSingle();
  const row = fresh as unknown as MasterRow | null;
  if (fErr || !row || row.macro_stage !== "por_confirmar" || !["sin_llamar", "por_confirmar"].includes(row.macro_substage ?? "")) {
    item.outcome = "fuera";
    return;
  }
  const saved = await saveChatbyAddressCorrection(admin, {
    orderId: key.order_id,
    storeId: key.store_id,
    address: verdict.address,
    coverage: row.coverage ?? null,
  });
  if (saved.error) {
    item.outcome = "error";
    item.detail = saved.error;
    await touch(r);
    return;
  }
  report.addressesCorrected++;
  const evidence = { ...(r.evidence ?? {}), corrected_at: new Date().toISOString() };
  // El Master ya tiene la dirección nueva: la guía la usa (Google la vuelve a buscar).
  const { data: after } = await admin.from("order_master").select("*").eq("order_id", key.order_id).maybeSingle();
  const updated = (after as unknown as MasterRow | null) ?? { ...row, address: verdict.address };
  const g = await tryChatbyGuide(guide, updated, w.conversation.messages);
  if (g.kind === "wait") {
    item.detail = [saved.warning, g.outcome].filter(Boolean).join(" · ");
    // Sigue en la relectura, ya corregida: la próxima pasada lo vuelve a intentar.
    await touch(r, { evidence });
    return;
  }
  if (saved.warning) item.detail = saved.warning;
  await guideOutcome(admin, ctx, guide, report, {
    ...w,
    r: { ...r, evidence },
    master: updated,
    verdict: { messageId: verdict.messageId, at: verdict.at, amountCents: verdict.amountCents, pin: false, addressCorrected: true },
    g,
    corrected: true,
  });
}

// ---------------------------------------------------------------------------
// Kapta pide sola la dirección o la ubicación (0318, lib/chatby-auto-ask.ts)
// ---------------------------------------------------------------------------

function addDetail(item: ChatbyAutoItem, text: string): void {
  item.detail = item.detail ? `${item.detail} · ${text}` : text;
}

/**
 * El mensaje automático al quedar para la asesora por la dirección o la
 * ubicación: por el MISMO envío que la ficha (`sendChatbyReply`, como persona
 * del equipo, con el bot en pausa `CHATBY_REPLY_PAUSE_MINUTES`), con el mismo
 * hecho `chatby_message` (sin actor, `payload.auto = true`) y la misma marca
 * (`evidence.asked_at`/`held_at`, más `auto_asks`). Como mucho uno de cada
 * clase por pedido, solo con la ventana de 24 h abierta y si nadie del equipo
 * le escribió (`chatbyAutoAskDecision`). No lee Chatby otra vez: usa la
 * conversación que la pasada acaba de leer.
 */
async function autoAsk(
  admin: SupabaseClient,
  ctx: PassCtx,
  report: ChatbyAutoReport,
  a: {
    key: { order_id: string; store_id: string; org_id: string };
    master: MasterRow;
    conversation: OkConversation;
    item: ChatbyAutoItem;
    kind: ChatbyAutoAskKind;
    /** La marca como quedó escrita. */
    evidence: Record<string, unknown>;
    holdReason: string;
  },
): Promise<void> {
  const { key, master, conversation, item, kind } = a;
  if (ctx.askMode === "apagado") return;
  const label = chatbyAutoAskLabel(kind);
  // Lo que se sabe con la marca, sin leer la base (la pasada de la ubicación lo
  // mira cada 30 minutos).
  if (chatbyAutoAskMarkedSkip(a.evidence, kind, ctx.askMode)) return;
  if (ctx.dry) {
    addDetail(item, `pediría ${label}`);
    return;
  }
  const writeEvidence = async (evidence: Record<string, unknown>) => {
    await admin.from("chatby_auto_checks").update({ evidence }).eq("order_id", key.order_id);
  };

  const [freshRes, eventsRes] = await Promise.all([
    admin.from("order_master").select("macro_stage,macro_substage,coverage").eq("order_id", key.order_id).maybeSingle(),
    admin.from("order_events").select("actor,note,payload").eq("order_id", key.order_id).eq("kind", "chatby_message"),
  ]);
  if (freshRes.error || eventsRes.error || !freshRes.data) {
    addDetail(item, `no pidió ${label}: no se pudo leer el pedido`);
    return;
  }
  const decision = chatbyAutoAskDecision({
    mode: ctx.askMode,
    kind,
    master: freshRes.data as MasterRow,
    messages: conversation.messages,
    events: (eventsRes.data ?? []) as ChatbyMessageEvent[],
    evidence: a.evidence,
    now: new Date(),
  });
  if (!decision.send) {
    addDetail(item, `no pidió ${label}: ${CHATBY_AUTO_ASK_SKIP_LABEL[decision.skip]}`);
    if (decision.skip !== "ya_pedida") await writeEvidence(chatbyAutoAskSkipEvidence(a.evidence, decision.skip, kind, new Date()));
    return;
  }
  // Lo que es de una persona antes de cualquier guía, como en `tryChatbyGuide`:
  // a esa clienta Kapta no le escribe.
  const personal = await askBlockedForPerson(admin, master);
  if (personal) {
    addDetail(item, `no pidió ${label}: ${CHATBY_AUTO_ASK_SKIP_LABEL.para_persona} (${personal})`);
    await writeEvidence(chatbyAutoAskSkipEvidence(a.evidence, "para_persona", kind, new Date()));
    return;
  }
  if (decision.simulate) {
    report.asksSimulated++;
    addDetail(item, `habría pedido ${label}`);
    console.info(`[chatby-pedir] ${JSON.stringify({ order: key.order_id, mode: "simulacion", ask: kind })}`);
    await writeEvidence(chatbyAutoAskEvidence(a.evidence, { kind, mode: "simulacion" }, new Date()));
    return;
  }

  const text = chatbyAutoAskMessage({ kind, customerName: master.customer_name ?? conversation.name, orderName: master.order_name });
  const sent = await sendChatbyReply({
    userNs: conversation.userNs,
    text,
    apiKey: ctx.apiKey,
    pauseMinutes: CHATBY_REPLY_PAUSE_MINUTES,
  });
  forgetChatbyConversation(master.customer_phone);
  if (sent.status === "error") {
    addDetail(item, `no pidió ${label}: ${sent.message}`);
    await writeEvidence(chatbyAutoAskSkipEvidence(a.evidence, "envio_fallo", kind, new Date()));
    return;
  }
  const now = new Date();
  // La marca primero: si el hecho no se pudiera escribir, la marca igual dice
  // que salió y no se repite.
  await writeEvidence(chatbyAutoAskEvidence(a.evidence, { kind, mode: "activo" }, now));
  const { error: eErr } = await admin.from("order_events").insert({
    store_id: key.store_id,
    order_id: key.order_id,
    kind: "chatby_message",
    occurred_at: now.toISOString(),
    actor: null,
    source: CHATBY_SOURCE,
    reason: chatbyAutoAskReason(kind),
    note: text,
    payload: {
      auto: true,
      ask: kind,
      purpose: chatbyAutoAskPurpose(kind),
      hold_reason: a.holdReason,
      paused_minutes: sent.paused ? CHATBY_REPLY_PAUSE_MINUTES : 0,
      policy: CHATBY_AUTO_POLICY,
    },
  });
  report.asksSent++;
  addDetail(item, eErr ? `pidió ${label} (sin anotar en la Actividad: ${eErr.message})` : `pidió ${label}`);
  await recomputeOrderMasterSafe(admin, [key.order_id]);
}

/**
 * ¿Es de una persona? Las mismas rejas que `tryChatbyGuide` mira antes de la
 * coordenada: el envío programado, la lista de pago adelantado (MOM §41),
 * Shalom y un pago registrado. Lo que no se pudo leer también cuenta como «de
 * una persona»: ante la duda, Kapta no escribe.
 */
async function askBlockedForPerson(admin: SupabaseClient, row: MasterRow): Promise<string | null> {
  if (chatbyGuideBlock(row)) return "envío programado";
  const prepay = await prepayOrderCheck(admin, row as unknown as PrepayOrderRow, "confirmar");
  if (prepay.state === "blocked" && prepay.source === "pago_online") return "pago solo online (lista automática)";
  if (prepay.state !== "ok") return "lista de pago adelantado";
  const { data: draft, error } = await admin.from("shalom_order_drafts").select("order_id").eq("order_id", row.order_id).limit(1);
  if (error) return "no se pudo leer el borrador de Shalom";
  const hold = chatbyGuideHold({ hasShalomDraft: (draft ?? []).length > 0, paymentState: row.payment_state });
  if (hold === "shalom") return "Shalom";
  if (hold) return "tiene un pago registrado";
  return null;
}

// ---------------------------------------------------------------------------
// Guía automática para clientas con entregas (0317, lib/history-guide-auto.ts)
// ---------------------------------------------------------------------------
//
// La clienta confirmó por Chatby y la guía no sale por la dirección
// (`direccion_incompleta`, `sin_ubicacion`). Si ya recibió en esa misma casa sin
// un solo fallido, la guía va con el GPS de la guía de esa entrega. Corre
// ANTES de que Kapta le pida la dirección o la ubicación (0318): a la clienta
// que califica no se le escribe, se le crea la guía. Lee solo la base (su
// historial y las guías de esos pedidos), nada de Chatby.

/** Con qué se crea la guía: el veredicto (el pedido y el GPS) y por qué hizo falta. */
export interface HistoryGuideUse {
  verdict: Extract<HistoryGuideVerdict, { ok: true }>;
  holdReason: HistoryGuideHoldReason;
}

const HISTORY_PRIOR_COLUMNS =
  "order_id,order_name,order_created_at,general_status,operational_status,macro_stage,order_total," +
  "guide_code,current_courier,last_courier,delivered_courier,attempt_count,dispatched_at," +
  "address,district,province,latitude,longitude,geo_source,delivered_at";

/** El historial de la clienta (mismo celular, misma organización) y el veredicto. */
async function historyGuideLookup(admin: SupabaseClient, ctx: PassCtx, master: MasterRow): Promise<HistoryGuideVerdict> {
  const unread: HistoryGuideVerdict = { ok: false, reason: "historial_sin_leer", delivered: 0, failed: 0 };
  const phone = (master.customer_phone ?? "").trim();
  if (!phone || !ctx.orgStoreIds.length) return { ok: false, reason: "sin_entregas", delivered: 0, failed: 0 };
  const { data, error } = await admin
    .from("order_master")
    .select(HISTORY_PRIOR_COLUMNS)
    .eq("customer_phone", phone)
    .in("store_id", ctx.orgStoreIds)
    .neq("order_id", master.order_id)
    .order("order_created_at", { ascending: false })
    .limit(500);
  if (error) return unread;
  const priors = (data ?? []) as unknown as HistoryPrior[];
  const input = { order: master, priors };
  const candidate = historyGuideCandidate(input);
  if (!candidate.ok) return candidate;
  // Los rechazos en la puerta (§8.2) salen de las guías de sus pedidos.
  const { data: guides, error: gErr } = await admin
    .from("shipments")
    .select("order_id,reported_status")
    .in("order_id", [master.order_id, ...priors.map((p) => p.order_id)]);
  return evaluateHistoryGuide({ ...input, doorRejections: gErr ? null : countDoorRejections((guides ?? []) as DoorRejectionShipment[]) });
}

/**
 * La regla para un pedido cuya guía no sale por la dirección. Apagado: nada.
 * Simulación: la evidencia («habría usado el GPS de #…») y el pedido sigue
 * como hoy. Activo y califica: `use`, con lo que la guía se intenta. La
 * evidencia va en la marca (`evidence.history_guide`) en todos los casos.
 */
async function historyGuideCheck(
  admin: SupabaseClient,
  ctx: PassCtx,
  report: ChatbyAutoReport,
  h: { master: MasterRow; holdReason: HistoryGuideHoldReason; item: ChatbyAutoItem; prior?: unknown },
): Promise<{ evidence: Record<string, unknown> | null; use: HistoryGuideUse | null }> {
  const mode = ctx.historyMode;
  if (mode === "apagado") return { evidence: null, use: null };
  const verdict = await historyGuideLookup(admin, ctx, h.master);
  const evidence = historyGuideEvidence(mode, h.holdReason, verdict, new Date());
  if (!verdict.ok) {
    addDetail(h.item, `historial: ${HISTORY_GUIDE_SKIP_LABEL[verdict.reason]}`);
    return { evidence, use: null };
  }
  if (mode === "simulacion") {
    addDetail(h.item, `habría creado la guía con el GPS de ${verdict.source.orderName ?? "una entrega anterior"}`);
    // Una vez por pedido: la relectura de cada 30 minutos no lo vuelve a contar.
    const before = h.prior as { outcome?: unknown; mode?: unknown } | null | undefined;
    if (!(before?.outcome === "habria_usado" && before.mode === "simulacion")) {
      report.historySimulated++;
      console.info(
        `[chatby-historial] ${JSON.stringify({ order: h.master.order_id, mode, outcome: "habria_usado", source: verdict.source.orderName })}`,
      );
    }
    return { evidence, use: null };
  }
  return { evidence, use: { verdict, holdReason: h.holdReason } };
}

/**
 * El hecho de la línea de tiempo: la guía salió con el GPS de una entrega
 * anterior, y de cuál. Sin actor y `source = 'chatby'`, como la confirmación.
 * Si no se puede escribir, la guía ya existe y su `guide_registered` lo dice.
 */
async function recordHistoryGuideFact(admin: SupabaseClient, row: MasterRow, guideCode: string | null, use: HistoryGuideUse): Promise<void> {
  const { verdict } = use;
  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind: HISTORY_GUIDE_EVENT,
    occurred_at: new Date().toISOString(),
    actor: null,
    source: CHATBY_SOURCE,
    courier: "aliclik",
    guide_code: guideCode,
    reason: historyGuideFactReason(verdict),
    note: historyGuideFactNote(use.holdReason, verdict),
    payload: {
      policy: HISTORY_GUIDE_POLICY,
      hold_reason: use.holdReason,
      delivered: verdict.delivered,
      source_order_id: verdict.source.orderId,
      source_order_name: verdict.source.orderName,
      source_delivered_at: verdict.source.deliveredAt,
    },
  });
}
