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
import { fetchChatbyConversation } from "@/lib/chatby-api";
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
import { autoTransport, waitForAliclik } from "@/lib/aliclik-scheduled";
import {
  CHATBY_AUTO_POLICY,
  CHATBY_CONFIRMATION_HELD,
  CHATBY_GUIDE_ORIGIN,
  CHATBY_HOLD_REASONS,
  CHATBY_SOURCE,
  chatbyAutoSettingsFrom,
  chatbyCheckDue,
  chatbyConfirmationNote,
  chatbyGuideBlock,
  chatbyGuideHold,
  chatbyGuidePin,
  chatbyGuideReason,
  chatbyHoldNote,
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
import type { ChatbyMessage } from "@/lib/chatby-conversation";
import type { OrderMasterRow } from "@/lib/types";

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
  step: "confirmar" | "guia";
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
    stopped: null,
    items: [],
    error: null,
  };
  if (!settings.enabled) return report;
  const apiKey = (opts.apiKey ?? env.chatbyApiKey()).trim();

  try {
    const { data: stores, error: sErr } = await admin
      .from("stores")
      .select("id")
      .eq("org_id", settings.org_id)
      .eq("status", "active");
    if (sErr) throw new Error(`leer las tiendas: ${sErr.message}`);
    const storeIds = ((stores ?? []) as { id: string }[]).map((s) => s.id);
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
      await confirmPass(admin, settings, storeIds, { dry, now, started, apiKey }, report);
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
  ctx: { dry: boolean; now: Date; started: number; apiKey: string },
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

  // EL TOPE: las guías automáticas de hoy (día de Lima), de toda la organización.
  const { count, error: cErr } = await admin
    .from("chatby_auto_checks")
    .select("order_id", { count: "exact", head: true })
    .eq("org_id", settings.org_id)
    .eq("guide_state", "creada")
    .gte("guide_at", limaDayStartIso(now));
  if (cErr) throw new Error(`leer el tope de guías de hoy: ${cErr.message}`);
  // Sin saber si va por Shalom no se crea nada: es la diferencia entre esperar
  // diez minutos y mandar un paquete por el courier equivocado (§6.2).
  const { data: drafts, error: dErr } = await admin
    .from("shalom_order_drafts")
    .select("order_id")
    .in("order_id", due.map((d) => d.master.order_id));
  if (dErr) throw new Error(`leer los borradores de Shalom: ${dErr.message}`);
  const guide: GuideCtx = {
    admin,
    dry: ctx.dry,
    today: limaTodayKey(now),
    left: guideCapLeft(count ?? 0, settings.daily_cap),
    withShalom: new Set(((drafts ?? []) as { order_id: string }[]).map((d) => d.order_id)),
    scopes: new Map(),
    waiting: new Map(),
    report,
  };
  report.guideCapLeft = guide.left;

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

    const verdict = evaluateChatbyConfirmation({
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
    });

    if (!verdict.confirm && !verdict.final) {
      if (!ctx.dry) await upsertCheck(admin, key, { outcome: "sin_confirmacion", reason: verdict.reason, reads });
      continue;
    }

    if (!verdict.confirm) {
      // Había un mensaje de confirmación y no cuadró: la asesora lo ve en la
      // línea de tiempo, con el motivo, y la pasada ya no lo vuelve a leer.
      item.outcome = "para_asesora";
      item.detail = verdict.reason;
      report.held++;
      if (ctx.dry) continue;
      const evidence: Record<string, unknown> = { total_cents: Math.round(Number(order.total_amount) * 100) };
      if (verdict.amountCents != null) evidence.amount_cents = verdict.amountCents;
      await holdForAdvisor(admin, key, item, { reason: verdict.reason, messageId: verdict.messageId, evidence, reads });
      continue;
    }

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
    const evidence = { amount_cents: verdict.amountCents };
    const g = await tryChatbyGuide(guide, master, conversation.messages);
    if (g.kind === "wait") {
      // Aliclik en rojo, el tope del día o una creación en curso: sigue en Por
      // confirmar sin escribir nada visible y se vuelve a leer más tarde.
      item.outcome = g.outcome;
      item.detail = g.detail ?? undefined;
      if (!ctx.dry) await upsertCheck(admin, key, { outcome: "sin_confirmacion", reason: g.outcome, message_id: verdict.messageId, reads });
      continue;
    }
    if (g.kind === "hold") {
      item.outcome = "para_asesora";
      item.detail = g.detail ? `${g.reason}: ${g.detail}` : g.reason;
      report.held++;
      if (ctx.dry) continue;
      await holdForAdvisor(admin, key, item, {
        reason: g.reason,
        detail: g.detail,
        messageId: verdict.messageId,
        evidence,
        reads,
        guide: { state: g.state, detail: g.detail ? `${g.reason}: ${g.detail}` : g.reason, code: g.code ?? null },
      });
      continue;
    }
    if (ctx.dry) {
      item.outcome = "confirmaria";
      item.detail = g.detail ?? undefined;
      continue;
    }

    const occurredAt = new Date().toISOString();
    const { error: rpcErr } = await admin.rpc("register_confirmation_attempt_v2", {
      p_store_id: master.store_id,
      p_order_id: order.id,
      p_actor: null,
      p_operation_id: chatbyOperationId(order.id, verdict.messageId),
      p_result: "confirmado",
      p_channel: "mensaje",
      p_note: chatbyConfirmationNote({ orderName: order.name!, at: verdict.at, amountCents: verdict.amountCents }),
      p_next_contact_on: null,
      p_occurred_at: occurredAt,
      p_reminder_due_at: null,
      p_source: CHATBY_SOURCE,
      p_payload_extra: {
        chatby: { policy: CHATBY_AUTO_POLICY, message_id: verdict.messageId, message_at: verdict.at, amount_cents: verdict.amountCents },
      },
    });
    const guideMark = { state: g.state, detail: null, code: g.code };
    if (rpcErr) {
      // La guía ya existe: la pasada siguiente la encuentra («ya tenía») y
      // vuelve a intentar solo la confirmación.
      item.outcome = "error";
      item.detail = rpcErr.message;
      await upsertCheck(admin, key, { outcome: "error", reason: "confirmar", message_id: verdict.messageId, reads, guide: guideMark });
      continue;
    }
    await recomputeOrderMasterSafe(admin, [order.id]);
    item.outcome = "confirmado";
    item.detail = g.code ?? undefined;
    report.confirmed++;
    await upsertCheck(admin, key, {
      outcome: "confirmado",
      message_id: verdict.messageId,
      evidence,
      reads,
      confirmed_at: occurredAt,
      guide: guideMark,
    });
  }
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

interface GuideCtx {
  admin: SupabaseClient;
  dry: boolean;
  today: string;
  /** Guías automáticas que quedan hoy (tope de la organización). */
  left: number;
  withShalom: Set<string>;
  scopes: Map<string, AliclikReadScope | string>;
  waiting: Map<string, boolean>;
  report: ChatbyAutoReport;
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
async function tryChatbyGuide(g: GuideCtx, row: MasterRow, messages: readonly ChatbyMessage[]): Promise<GuideTry> {
  const { admin } = g;
  if (chatbyGuideBlock(row)) return { kind: "hold", reason: "programado", detail: null, state: "para_persona" };
  const hold = chatbyGuideHold({ hasShalomDraft: g.withShalom.has(row.order_id), paymentState: row.payment_state });
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
  if (row.latitude == null || row.longitude == null) {
    const pin = chatbyGuidePin(messages, row.order_created_at);
    if (!pin) return { kind: "hold", reason: "sin_ubicacion", detail: null, state: "para_persona" };
    coordinate = pin.coordinate;
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
    { kind: CHATBY_GUIDE_ORIGIN, scheduledOn: g.today, reason: chatbyGuideReason(row.order_name) },
  );
  if (result.locked) {
    // Otra creación tiene el candado (una persona creándola ahora): no es un fallo.
    return { kind: "wait", outcome: "en_curso", detail: result.error ?? null };
  }
  if (result.timedOut) {
    // Aliclik pudo crearla: cuenta para el tope y NO se reintenta, que es lo
    // que crea duplicados. La asesora mira Aliclik antes de crear otra.
    g.left--;
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
  return { kind: "ok", state: "creada", code: result.orderNumber ?? null };
}

function failed(g: GuideCtx, error: string): GuideTry {
  if (!g.dry) g.report.guidesFailed++;
  return { kind: "hold", reason: "guia_no_creada", detail: error, state: "fallo" };
}
