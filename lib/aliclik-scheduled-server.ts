import "server-only";

// La pasada de la guía Aliclik automática del día programado (MOM §6.2). La
// regla —qué pedido entra, qué transportadora, cuándo ya no es suyo— está en
// lib/aliclik-scheduled.ts; la creación, en lib/aliclik-guide.ts, la misma que
// usa el botón.

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { getStoreCreds } from "@/lib/ingest";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { limaTodayKey } from "@/lib/shipments";
import { limaTimeHHMM } from "@/lib/aliclik-geo";
import { loadAliclikHealthState } from "@/lib/aliclik-health-access";
import { sendTelegramToAll } from "@/lib/telegram";
import {
  activeAliclikBlocker,
  aliclikContextFor,
  aliclikReadScopeFor,
  createAliclikGuideFor,
  previewAliclikGuideFor,
  type AliclikReadScope,
} from "@/lib/aliclik-guide";
import {
  ALICLIK_AUTO_FAILED,
  ALICLIK_AUTO_POLICY,
  autoGuideReason,
  autoTransport,
  scheduledFailureTelegram,
  scheduledSkip,
  triedOn,
  waitForAliclik,
} from "@/lib/aliclik-scheduled";
import type { OrderMasterRow } from "@/lib/types";

/** El tiempo de una pasada. Lo que no entra se intenta en la siguiente hora. */
const TIME_BUDGET_MS = 240_000;

export type ScheduledOutcome =
  | "creada"
  | "fallo"
  | "ya_tiene_guia"
  | "ya_intentado"
  | "en_curso"
  | "esperando_aliclik"
  | "simulada"
  | "fuera";

export interface ScheduledItem {
  orderId: string;
  orderName: string | null;
  outcome: ScheduledOutcome;
  detail?: string;
  telegram?: boolean;
}

export interface ScheduledReport {
  today: string;
  candidates: number;
  created: number;
  failed: number;
  /** Se agotó el tiempo antes de terminar. Lo que quedó va en la pasada siguiente. */
  stopped: "tiempo" | null;
  items: ScheduledItem[];
  error: string | null;
}

/** Ubicación corta para la alerta: distrito y provincia, sin repetir. */
function placeOf(row: OrderMasterRow): string | null {
  const parts = [row.district, row.province].filter((p): p is string => Boolean(p?.trim()));
  return [...new Set(parts)].join(", ") || null;
}

async function telegramTarget(
  admin: SupabaseClient,
  storeId: string,
): Promise<{ token: string; chats: string; storeName: string } | null> {
  const [creds, { data: store }] = await Promise.all([
    getStoreCreds(storeId, admin),
    admin.from("stores").select("urgent_telegram_chat_id").eq("id", storeId).maybeSingle(),
  ]);
  // El grupo de alertas urgentes si la tienda lo tiene; si no, el del resumen
  // diario. Es el mismo destino que el comprobante repetido (0226).
  const chats =
    (store as { urgent_telegram_chat_id?: string | null } | null)?.urgent_telegram_chat_id?.trim() ||
    creds?.telegram_chat_id ||
    null;
  if (!creds?.telegram_bot_token || !chats) return null;
  return { token: creds.telegram_bot_token, chats, storeName: creds.name };
}

/**
 * Un intento fallido: avisa por Telegram de ESE pedido y deja el hecho en su
 * historial. El hecho va después del aviso a propósito: si no se pudiera
 * escribir, la pasada siguiente lo vuelve a intentar y avisa otra vez — un aviso
 * repetido se lee; uno perdido no.
 */
async function recordFailure(
  admin: SupabaseClient,
  row: OrderMasterRow,
  today: string,
  error: string,
): Promise<boolean> {
  let telegram = false;
  try {
    const target = await telegramTarget(admin, row.store_id);
    if (target) {
      const res = await sendTelegramToAll(
        target.token,
        target.chats,
        scheduledFailureTelegram({
          storeName: target.storeName,
          orderName: row.order_name,
          customerName: row.customer_name,
          place: placeOf(row),
          date: today,
          error,
          url: `${env.siteUrl()}/dashboard/pedidos?abrir=${encodeURIComponent(row.order_id)}`,
        }),
      );
      telegram = res.sent > 0;
    }
  } catch {
    /* el hecho queda igual en el historial */
  }
  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind: ALICLIK_AUTO_FAILED,
    occurred_at: new Date().toISOString(),
    actor: null,
    source: "system",
    courier: "aliclik",
    reason: error.slice(0, 2000),
    note: `No se pudo crear la guía Aliclik del envío programado para hoy. Hay que crearla a mano o reprogramarla.`,
    payload: { date: today, policy: ALICLIK_AUTO_POLICY, telegram },
  });
  return telegram;
}

/**
 * Una pasada. `dry` cotiza y dice qué haría, sin crear, sin escribir y sin
 * avisar: cotizar es un GET.
 */
export async function runScheduledAliclikGuides(
  admin: SupabaseClient,
  opts: { dry?: boolean; now?: Date } = {},
): Promise<ScheduledReport> {
  const started = Date.now();
  const today = limaTodayKey(opts.now);
  const report: ScheduledReport = { today, candidates: 0, created: 0, failed: 0, stopped: null, items: [], error: null };

  if (!opts.dry && !env.aliclikWriteEnabled()) {
    report.error = "ALICLIK_WRITE_ENABLED está apagado: no se crea nada.";
    return report;
  }

  const { data: stores, error: storesError } = await admin.from("stores").select("id").eq("aliclik_enabled", true);
  if (storesError) {
    report.error = `No se pudieron leer las tiendas con Aliclik: ${storesError.message}`;
    return report;
  }
  const storeIds = ((stores ?? []) as { id: string }[]).map((s) => s.id);
  if (!storeIds.length) return report;

  const { data: rows, error: rowsError } = await admin
    .from("order_master")
    .select("*")
    .in("store_id", storeIds)
    .eq("dispatch_scheduled_on", today)
    .eq("macro_stage", "preparacion")
    .eq("macro_substage", "por_generar_rotulo")
    .order("order_created_at", { ascending: true });
  if (rowsError) {
    report.error = `No se pudieron leer los pedidos programados: ${rowsError.message}`;
    return report;
  }
  const candidates = ((rows ?? []) as unknown as OrderMasterRow[]).filter((row) => scheduledSkip(row, today) === null);
  report.candidates = candidates.length;
  if (!candidates.length) return report;

  const { data: tried, error: triedError } = await admin
    .from("order_events")
    .select("order_id,kind,payload")
    .eq("kind", ALICLIK_AUTO_FAILED)
    .in(
      "order_id",
      candidates.map((row) => row.order_id),
    );
  if (triedError) {
    // Sin saber qué ya se intentó, repetir sería volver a avisar de lo mismo.
    report.error = `No se pudieron leer los intentos anteriores: ${triedError.message}`;
    return report;
  }
  const triedByOrder = new Map<string, { kind: string; payload: unknown }[]>();
  for (const event of (tried ?? []) as { order_id: string; kind: string; payload: unknown }[]) {
    triedByOrder.set(event.order_id, [...(triedByOrder.get(event.order_id) ?? []), event]);
  }

  const scopes = new Map<string, AliclikReadScope | string>();
  const waiting = new Map<string, boolean>();
  const limaHour = Number(limaTimeHHMM(opts.now ?? new Date()).slice(0, 2));

  for (const row of candidates) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      report.stopped = "tiempo";
      break;
    }
    const item: ScheduledItem = { orderId: row.order_id, orderName: row.order_name, outcome: "fuera" };
    report.items.push(item);

    if (triedOn(triedByOrder.get(row.order_id) ?? [], today)) {
      item.outcome = "ya_intentado";
      continue;
    }

    // Una guía creada que el Master todavía no recalculó: no es un fallo. Se
    // recalcula para que el pedido salga de la lista.
    const live = await activeAliclikBlocker(admin, row.order_id);
    if (live.guide) {
      item.outcome = "ya_tiene_guia";
      item.detail = live.guide.guide_code;
      if (!opts.dry) await recomputeOrderMasterSafe(admin, [row.order_id]);
      continue;
    }

    const fail = async (error: string) => {
      item.outcome = "fallo";
      item.detail = error;
      if (opts.dry) return;
      report.failed += 1;
      item.telegram = await recordFailure(admin, row, today, error);
    };

    if (live.error) {
      await fail(live.error);
      continue;
    }

    // La salud es de la organización (un token Aliclik): se lee una vez por tienda.
    if (!waiting.has(row.store_id)) {
      waiting.set(row.store_id, waitForAliclik(await loadAliclikHealthState(admin, row.store_id), limaHour));
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

    const { ctx, error: ctxError } = await aliclikContextFor(row, null, { blockAgencia: true });
    if (!ctx) {
      await fail(ctxError ?? "No se pudo preparar la conexión con Aliclik.");
      continue;
    }

    const preview = await previewAliclikGuideFor(ctx, { modality: "cod" }, scope);
    if (!preview.ok) {
      await fail(preview.error ?? "No se pudo cotizar el envío.");
      continue;
    }
    const transport = autoTransport(preview.couriers);
    if (!transport) {
      await fail("Ninguna transportadora de Aliclik se puede agendar ahora para este destino.");
      continue;
    }

    if (opts.dry) {
      item.outcome = "simulada";
      item.detail =
        `${transport.transportName ?? "courier"} S/ ${transport.deliveryCost} · ` +
        `cobrar S/ ${(preview.collectTotal ?? 0).toFixed(2)}`;
      continue;
    }

    const result = await createAliclikGuideFor(
      ctx,
      { transportId: transport.transportId, expectedCollectTotal: preview.collectTotal ?? null, note: null },
      scope,
      { kind: "envio_programado", scheduledOn: today, reason: autoGuideReason(today) },
    );
    if (result.locked) {
      // Otra creación de este pedido tiene el candado —una persona creándola
      // ahora, o un timeout que el barrido todavía resuelve—. No es un fallo
      // de este intento.
      item.outcome = "en_curso";
      item.detail = result.error;
      continue;
    }
    if (result.error) {
      await fail(result.error);
      continue;
    }
    item.outcome = "creada";
    item.detail = result.orderNumber;
    report.created += 1;
  }

  return report;
}
