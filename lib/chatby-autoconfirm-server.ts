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
import { ALICLIK_AUTO_FAILED, autoTransport, waitForAliclik } from "@/lib/aliclik-scheduled";
import {
  CHATBY_AUTO_POLICY,
  CHATBY_CONFIRMATION_HELD,
  CHATBY_GUIDE_ORIGIN,
  CHATBY_HOLD_REASONS,
  CHATBY_SOURCE,
  chatbyAutoSettingsFrom,
  chatbyCheckDue,
  chatbyConfirmationNote,
  chatbyGuideHold,
  chatbyGuideReason,
  chatbyGuideSkip,
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
} from "@/lib/chatby-autoconfirm";
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

    // ── 1. Confirmar ────────────────────────────────────────────────────────
    if (apiKey) {
      await confirmPass(admin, settings, storeIds, { dry, now, started, apiKey }, report);
    } else {
      report.items.push({ orderId: "", orderName: null, step: "confirmar", outcome: "sin_clave", detail: "Falta CHATBY_API_KEY." });
    }

    // ── 2. La guía de lo confirmado por Chatby ──────────────────────────────
    if (settings.guide_enabled && report.stopped !== "tiempo") {
      await guidePass(admin, settings, { dry, now, started }, report);
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
      const { error: eErr } = await admin.from("order_events").insert({
        store_id: master.store_id,
        order_id: order.id,
        kind: CHATBY_CONFIRMATION_HELD,
        occurred_at: new Date().toISOString(),
        actor: null,
        source: CHATBY_SOURCE,
        reason: CHATBY_HOLD_REASONS[verdict.reason],
        note: chatbyHoldNote(verdict.reason),
        payload: { policy: CHATBY_AUTO_POLICY, reason: verdict.reason, message_id: verdict.messageId, ...evidence },
      });
      // Sin el hecho, la asesora no sabría por qué: se reintenta en la próxima pasada.
      if (eErr) {
        item.outcome = "error";
        item.detail = eErr.message;
        await upsertCheck(admin, key, { outcome: "error", reason: "hecho", reads });
        continue;
      }
      await upsertCheck(admin, key, {
        outcome: "para_asesora",
        reason: verdict.reason,
        message_id: verdict.messageId,
        evidence,
        reads,
      });
      continue;
    }

    item.outcome = ctx.dry ? "confirmaria" : "confirmado";
    if (ctx.dry) continue;

    // Justo antes de escribir: ¿sigue en Por confirmar? Una asesora pudo
    // confirmarlo (o anularlo) mientras se leía Chatby.
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
    if (rpcErr) {
      item.outcome = "error";
      item.detail = rpcErr.message;
      await upsertCheck(admin, key, { outcome: "error", reason: "confirmar", message_id: verdict.messageId, reads });
      continue;
    }
    await recomputeOrderMasterSafe(admin, [order.id]);
    report.confirmed++;
    await upsertCheck(admin, key, {
      outcome: "confirmado",
      message_id: verdict.messageId,
      evidence: { amount_cents: verdict.amountCents },
      reads,
      confirmed_at: occurredAt,
    });
  }
}

type GuideState = "creada" | "fallo" | "para_persona" | "ya_tenia" | "fuera";

async function guidePass(
  admin: SupabaseClient,
  settings: ChatbyAutoSettings,
  ctx: { dry: boolean; now: Date; started: number },
  report: ChatbyAutoReport,
): Promise<void> {
  const { now } = ctx;
  if (!ctx.dry && !env.aliclikWriteEnabled()) {
    report.items.push({ orderId: "", orderName: null, step: "guia", outcome: "apagado", detail: "ALICLIK_WRITE_ENABLED está apagado." });
    return;
  }

  // EL TOPE: las guías automáticas de hoy (día de Lima), de toda la organización.
  const { count, error: cErr } = await admin
    .from("chatby_auto_checks")
    .select("order_id", { count: "exact", head: true })
    .eq("org_id", settings.org_id)
    .eq("guide_state", "creada")
    .gte("guide_at", limaDayStartIso(now));
  if (cErr) throw new Error(`leer el tope de guías de hoy: ${cErr.message}`);
  let left = guideCapLeft(count ?? 0, settings.daily_cap);
  report.guideCapLeft = left;
  if (left <= 0) return;

  const since = new Date(now.getTime() - settings.window_hours * 3_600_000).toISOString();
  const { data: pending, error: pErr } = await admin
    .from("chatby_auto_checks")
    .select("order_id,store_id,confirmed_at")
    .eq("org_id", settings.org_id)
    .eq("outcome", "confirmado")
    .is("guide_state", null)
    .gte("confirmed_at", since)
    .order("confirmed_at", { ascending: true })
    .limit(100);
  if (pErr) throw new Error(`leer los confirmados por Chatby: ${pErr.message}`);
  const pendingRows = (pending ?? []) as { order_id: string; store_id: string }[];
  if (!pendingRows.length) return;
  const ids = pendingRows.map((p) => p.order_id);

  const [mastersRes, draftsRes] = await Promise.all([
    admin.from("order_master").select("*").in("order_id", ids),
    admin.from("shalom_order_drafts").select("order_id").in("order_id", ids),
  ]);
  if (mastersRes.error) throw new Error(`leer el Master: ${mastersRes.error.message}`);
  // Sin saber si va por Shalom no se crea nada: es la diferencia entre esperar
  // diez minutos y mandar un paquete por el courier equivocado (§6.2).
  if (draftsRes.error) throw new Error(`leer los borradores de Shalom: ${draftsRes.error.message}`);
  const masterBy = new Map(((mastersRes.data ?? []) as unknown as MasterRow[]).map((m) => [m.order_id, m]));
  const withShalom = new Set(((draftsRes.data ?? []) as { order_id: string }[]).map((d) => d.order_id));

  const today = limaTodayKey(now);
  const scopes = new Map<string, AliclikReadScope | string>();
  const waiting = new Map<string, boolean>();

  const mark = async (orderId: string, state: GuideState, detail: string | null, code: string | null = null) => {
    if (ctx.dry) return;
    await admin
      .from("chatby_auto_checks")
      .update({ guide_state: state, guide_detail: detail?.slice(0, 1000) ?? null, guide_code: code, guide_at: new Date().toISOString() })
      .eq("order_id", orderId);
  };

  for (const p of pendingRows) {
    if (left <= 0) return;
    if (Date.now() - ctx.started > TIME_BUDGET_MS) {
      report.stopped = "tiempo";
      return;
    }
    const row = masterBy.get(p.order_id);
    if (!row) continue;
    const item: ChatbyAutoItem = { orderId: row.order_id, orderName: row.order_name, step: "guia", outcome: "fuera" };
    report.items.push(item);

    const skip = chatbyGuideSkip(row);
    if (skip === "sin_recalcular") {
      // El Master todavía no lo pasó a Preparación: la próxima pasada.
      item.outcome = "esperando_master";
      if (!ctx.dry) await recomputeOrderMasterSafe(admin, [row.order_id]);
      continue;
    }
    if (skip) {
      item.outcome = skip === "programado" ? "programado" : "fuera";
      item.detail = skip;
      await mark(row.order_id, "fuera", skip);
      continue;
    }
    const hold = chatbyGuideHold({ hasShalomDraft: withShalom.has(row.order_id), paymentState: row.payment_state });
    if (hold) {
      item.outcome = "para_persona";
      item.detail = hold;
      await mark(row.order_id, "para_persona", hold);
      continue;
    }

    const live = await activeAliclikBlocker(admin, row.order_id);
    if (live.guide) {
      item.outcome = "ya_tenia";
      item.detail = live.guide.guide_code;
      await mark(row.order_id, "ya_tenia", live.guide.courier, live.guide.guide_code);
      continue;
    }

    const fail = async (error: string) => {
      item.outcome = "fallo";
      item.detail = error;
      if (ctx.dry) return;
      report.guidesFailed++;
      // El mismo hecho que la guía del día programado (§6.2): «Guía automática
      // no creada», con el motivo. Queda en la mesa como hoy; un intento por pedido.
      await admin.from("order_events").insert({
        store_id: row.store_id,
        order_id: row.order_id,
        kind: ALICLIK_AUTO_FAILED,
        occurred_at: new Date().toISOString(),
        actor: null,
        source: "system",
        courier: "aliclik",
        reason: error.slice(0, 2000),
        note: "No se pudo crear la guía Aliclik automática del pedido que confirmó por Chatby. Hay que crearla a mano.",
        payload: { date: today, policy: CHATBY_AUTO_POLICY, origin: CHATBY_GUIDE_ORIGIN },
      });
      await mark(row.order_id, "fallo", error);
    };

    if (live.error) {
      await fail(live.error);
      continue;
    }

    // Con Aliclik en rojo se espera a la pasada siguiente, sin avisar (§10.2).
    if (!waiting.has(row.store_id)) {
      waiting.set(row.store_id, waitForAliclik(await loadAliclikHealthState(admin, row.store_id), 0));
    }
    if (waiting.get(row.store_id)) {
      item.outcome = "esperando_aliclik";
      continue;
    }

    let scope = scopes.get(row.store_id);
    if (!scope) {
      const resolved = await aliclikReadScopeFor(admin, row.store_id);
      scope = resolved.scope ?? resolved.error ?? "No se pudo leer la organización de la tienda.";
      scopes.set(row.store_id, scope);
    }
    if (typeof scope === "string") {
      await fail(scope);
      continue;
    }

    const { ctx: aliclik, error: ctxError } = await aliclikContextFor(row, null, { blockAgencia: true });
    if (!aliclik) {
      await fail(ctxError ?? "No se pudo preparar la conexión con Aliclik.");
      continue;
    }
    const preview = await previewAliclikGuideFor(aliclik, { modality: "cod" }, scope);
    if (!preview.ok) {
      await fail(preview.error ?? "No se pudo cotizar el envío.");
      continue;
    }
    const transport = autoTransport(preview.couriers);
    if (!transport) {
      await fail("Ninguna transportadora de Aliclik se puede agendar ahora para este destino.");
      continue;
    }
    if (ctx.dry) {
      item.outcome = "simulada";
      item.detail = `${transport.transportName ?? "courier"} S/ ${transport.deliveryCost} · cobrar S/ ${(preview.collectTotal ?? 0).toFixed(2)}`;
      left--;
      continue;
    }

    const result = await createAliclikGuideFor(
      aliclik,
      { transportId: transport.transportId, expectedCollectTotal: preview.collectTotal ?? null, note: null },
      scope,
      { kind: CHATBY_GUIDE_ORIGIN, scheduledOn: today, reason: chatbyGuideReason(row.order_name) },
    );
    if (result.locked) {
      // Otra creación tiene el candado (una persona creándola ahora): no es un fallo.
      item.outcome = "en_curso";
      item.detail = result.error;
      continue;
    }
    if (result.timedOut) {
      // Aliclik pudo crearla: el barrido la reencuentra. Cuenta para el tope y
      // no se reintenta, que es lo que crea duplicados.
      item.outcome = "fallo";
      item.detail = result.error;
      left--;
      await mark(row.order_id, "creada", result.error ?? "timeout");
      continue;
    }
    if (result.error && result.orderNumber) {
      // Se creó en Aliclik y no se pudo guardar la fila: existe, cuenta para el
      // tope, y una persona la vincula con el número que deja el hecho.
      left--;
      report.guidesCreated++;
      await fail(result.error);
      await mark(row.order_id, "creada", result.error, result.orderNumber);
      continue;
    }
    if (result.error) {
      await fail(result.error);
      continue;
    }
    item.outcome = "creada";
    item.detail = result.orderNumber;
    report.guidesCreated++;
    left--;
    await mark(row.order_id, "creada", null, result.orderNumber ?? null);
  }
  report.guideCapLeft = left;
}
