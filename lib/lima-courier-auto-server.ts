import "server-only";

// La pasada de la guía Aliclik y Swayp del día programado en Lima (MOM §9.5 y
// §40; owner, 16-11-2026). La regla —qué pedido entra, qué día, qué motivo—
// está en lib/lima-courier-auto.ts. Aquí se lee la base y se crea por los
// MISMOS caminos que las personas: `createAliclikGuideFor` (con sus
// compuertas, el candado y la intención antes del POST) y
// `emitirGuiaSwaypDirecta` (pedido sano, stock, cobertura, vínculo de
// productos, fecha de despacho). Cada organización según su posición en
// Automatizaciones (Apagado / Simulación / Activo). Lo que falla deja su hecho
// y avisa por Telegram de ESE pedido, una vez por día.

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { limaTodayKey } from "@/lib/shipments";
import { limaTimeHHMM } from "@/lib/aliclik-geo";
import { sendTelegramToAll } from "@/lib/telegram";
import { telegramTarget } from "@/lib/aliclik-scheduled-server";
import {
  aliclikContextFor,
  aliclikCreateGates,
  aliclikReadScopeFor,
  aliclikRecipientBlock,
  createAliclikGuideFor,
  previewAliclikGuideFor,
  type AliclikGuideOrigin,
} from "@/lib/aliclik-guide";
import { emitirGuiaSwaypDirecta } from "@/lib/swayp-directa";
import { DIRECT_GUIDE_ORDER_COLUMNS, type DirectGuideOrderRecord } from "@/lib/swayp-reenvio";
import { loadReproFacts } from "@/lib/repro-lima-program";
import { sameCourier } from "@/lib/shipment-output";
import { defaultAliclikTransport } from "@/lib/repro-lima-blocks";
import { expectedDispatchDate } from "@/lib/aliclik-dispatch-date";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import { formatLimaDateTime } from "@/lib/automations-catalog";
import {
  LIMA_AUTO_COURIER_LABEL,
  LIMA_COURIER_AUTO_FAILED,
  LIMA_COURIER_AUTO_POLICY,
  isLimaCourierAutoOutcome,
  limaCourierAutoActivoBlocker,
  limaCourierAutoModeFrom,
  limaCourierAutoOutcomeLabel,
  limaAliclikPickupFits,
  limaCourierAutoPassOpen,
  limaCourierCaseCourier,
  limaCourierEnvioCourier,
  limaCourierFailedNote,
  limaCourierFailureTelegram,
  limaCourierMotive,
  limaCourierReason,
  limaCourierServes,
  limaCourierTargetDay,
  limaCourierTriedOn,
  type LimaAutoCourier,
  type LimaCourierAutoMode,
  type LimaCourierAutoOutcome,
  type LimaCourierCase,
} from "@/lib/lima-courier-auto";
import type { OrderMasterRow } from "@/lib/types";

export const LIMA_COURIER_AUTO_SETTINGS = "lima_courier_auto_settings";
export const LIMA_COURIER_AUTO_LOG = "lima_courier_auto_log";

/** El tiempo de una pasada. Lo que no entra se intenta en la siguiente. */
const TIME_BUDGET_MS = 240_000;

export type LimaCourierAutoItemOutcome = LimaCourierAutoOutcome | "ya_intentado" | "ya_tiene_guia" | "espera" | "error";

export interface LimaCourierAutoItem {
  orderId: string;
  orderName: string | null;
  storeId: string;
  courier: LimaAutoCourier;
  /** El día de despacho: hoy con Aliclik, el siguiente de Swayp con Swayp. */
  day: string;
  origin: "envio" | "acuerdo";
  mode: LimaCourierAutoMode;
  outcome: LimaCourierAutoItemOutcome;
  detail?: string | null;
  guide?: string | null;
  telegram?: boolean;
}

export interface LimaCourierAutoReport {
  today: string;
  limaHour: number;
  skipped: "fuera_de_horario" | null;
  candidates: number;
  created: number;
  failed: number;
  simulated: number;
  stopped: "tiempo" | null;
  items: LimaCourierAutoItem[];
  error: string | null;
}

function isMissingRelation(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /lima_courier_auto_(settings|log)/.test(error.message ?? "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Candidate {
  orderId: string;
  orderName: string | null;
  storeId: string;
  orgId: string;
  courier: LimaAutoCourier;
  day: string;
  origin: "envio" | "acuerdo";
  createdAt: string;
  /** El «Programar envío» ya leído (origen `envio`). */
  master?: OrderMasterRow;
  /** Con un acuerdo: la caja ya tiene la guía viva de ese courier. */
  liveSameCourier?: string | null;
}

/**
 * Un intento fallido en Activo: avisa por Telegram de ESE pedido y deja el
 * hecho en su historial. El hecho va después del aviso a propósito, como en la
 * guía Aliclik del día programado: si no se pudiera escribir, la pasada
 * siguiente lo vuelve a intentar y avisa otra vez —un aviso repetido se lee;
 * uno perdido no—.
 */
async function recordFailure(admin: SupabaseClient, c: Candidate, today: string, error: string, customer: { name: string | null; district: string | null }): Promise<boolean> {
  let telegram = false;
  try {
    const target = await telegramTarget(admin, c.storeId);
    if (target) {
      const res = await sendTelegramToAll(
        target.token,
        target.chats,
        limaCourierFailureTelegram({
          storeName: target.storeName,
          orderName: c.orderName,
          customerName: customer.name,
          district: customer.district,
          courier: c.courier,
          day: c.day,
          error,
          url: `${env.siteUrl()}/dashboard/pedidos?abrir=${encodeURIComponent(c.orderId)}`,
        }),
      );
      telegram = res.sent > 0;
    }
  } catch {
    /* el hecho queda igual en el historial */
  }
  await admin.from("order_events").insert({
    store_id: c.storeId,
    order_id: c.orderId,
    kind: LIMA_COURIER_AUTO_FAILED,
    occurred_at: new Date().toISOString(),
    actor: null,
    source: "system",
    courier: c.courier,
    reason: error.slice(0, 2000),
    note: limaCourierFailedNote(c.courier, c.day),
    payload: { date: today, dispatch_on: c.day, courier: c.courier, origin: c.origin, policy: LIMA_COURIER_AUTO_POLICY, telegram },
  });
  return telegram;
}

/**
 * Una pasada. `dry` dice qué haría en todas las organizaciones (o en `orgId`),
 * sin crear, sin escribir y sin avisar: Aliclik solo cotiza y mira las
 * compuertas de Kapta (`aliclikCreateGates`), y Swayp solo dice qué crearía.
 */
export async function runLimaCourierAuto(
  admin: SupabaseClient,
  opts: { dry?: boolean; now?: Date; orgId?: string } = {},
): Promise<LimaCourierAutoReport> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const dry = !!opts.dry;
  const today = limaTodayKey(now);
  const limaHour = Number(limaTimeHHMM(now).slice(0, 2));
  const report: LimaCourierAutoReport = {
    today, limaHour, skipped: null, candidates: 0, created: 0, failed: 0, simulated: 0, stopped: null, items: [], error: null,
  };
  const errors: string[] = [];
  const done = () => {
    report.error = errors.length ? errors.join(" · ") : null;
    return report;
  };

  if (!dry && !limaCourierAutoPassOpen(limaHour)) {
    report.skipped = "fuera_de_horario";
    return report;
  }

  // La posición de cada organización: sin fila, Apagado.
  let settingsQuery = admin.from(LIMA_COURIER_AUTO_SETTINGS).select("org_id,mode");
  if (opts.orgId) settingsQuery = settingsQuery.eq("org_id", opts.orgId);
  const { data: settingsRows, error: settingsError } = await settingsQuery;
  if (settingsError) {
    errors.push(
      isMissingRelation(settingsError)
        ? "Falta la migración 0349 en la base de datos: la guía Aliclik y Swayp del día programado no corre."
        : `No se pudo leer la posición de la guía del día programado: ${settingsError.message}`,
    );
    return done();
  }
  const modeByOrg = new Map<string, LimaCourierAutoMode>();
  for (const r of (settingsRows ?? []) as { org_id: string; mode: string }[]) modeByOrg.set(r.org_id, limaCourierAutoModeFrom(r.mode));

  const aliclikWrite = env.aliclikWriteEnabled();
  const swaypOn = env.swaypEnabled();
  const writers = !limaCourierAutoActivoBlocker({ aliclikWrite, swaypEnabled: swaypOn });
  if (!dry && !writers && [...modeByOrg.values()].some((m) => m === "activo")) {
    errors.push("Aliclik y Swayp están apagados en el servidor: en Activo no se crea nada (la Simulación sí corre).");
  }

  // Las tiendas de las organizaciones que hacen algo en esta pasada: con `dry`,
  // todas (o las de `orgId`); si no, Simulación, y Activo con algún courier encendido.
  let storesQuery = admin.from("stores").select("id,org_id");
  if (dry) {
    if (opts.orgId) storesQuery = storesQuery.eq("org_id", opts.orgId);
  } else {
    const acting = [...modeByOrg].filter(([, m]) => m === "simulacion" || (m === "activo" && writers)).map(([id]) => id);
    if (!acting.length) return done();
    storesQuery = storesQuery.in("org_id", acting);
  }
  const { data: storeRows, error: storesError } = await storesQuery;
  if (storesError) {
    errors.push(`No se pudieron leer las tiendas: ${storesError.message}`);
    return done();
  }
  const orgOfStore = new Map(((storeRows ?? []) as { id: string; org_id: string }[]).map((s) => [s.id, s.org_id]));
  const storeIds = [...orgOfStore.keys()];
  if (!storeIds.length) return done();

  const days = [...new Set([limaCourierTargetDay("aliclik", today, limaHour), limaCourierTargetDay("fenix", today, limaHour)])];
  const serves = (courier: LimaAutoCourier) => dry || limaCourierServes(courier, limaHour);

  // 1. «Programar envío» con courier (0348): Preparación · Por generar rótulo.
  // 2. Acuerdos de Repro Lima con Aliclik o Swayp para ese día.
  let envioRows: OrderMasterRow[];
  let caseRows: Array<LimaCourierCase & { store_id: string }>;
  try {
    const [envio, cases] = await Promise.all([
      courierRowsByIds(storeIds, async (chunk) => ({
        data: await allCourierRows<OrderMasterRow>(
          (from, to) =>
            admin
              .from("order_master")
              .select("*")
              .in("store_id", chunk)
              .eq("macro_stage", "preparacion")
              .eq("macro_substage", "por_generar_rotulo")
              .in("dispatch_courier", ["aliclik", "fenix"])
              .in("dispatch_scheduled_on", days)
              .order("order_id")
              .range(from, to) as unknown as PromiseLike<{ data: OrderMasterRow[] | null; error: { message: string } | null }>,
        ),
        error: null,
      })),
      courierRowsByIds(storeIds, (chunk) =>
        admin
          .from("lima_repro_cases")
          .select("id,order_id,store_id,agreed_on,agreed_courier,agreement_call_id,closed_at")
          .in("store_id", chunk)
          .is("closed_at", null)
          .in("agreed_courier", ["aliclik", "fenix"])
          .in("agreed_on", days) as unknown as PromiseLike<{ data: Array<LimaCourierCase & { store_id: string }> | null; error: { message: string } | null }>,
      ),
    ]);
    envioRows = envio.data;
    caseRows = cases.data;
  } catch (e) {
    errors.push(`No se pudieron leer los pedidos programados: ${errorText(e)}`);
    return done();
  }

  const byOrder = new Map<string, Candidate>();
  for (const row of envioRows) {
    const courier = limaCourierEnvioCourier(row, today, limaHour);
    const orgId = orgOfStore.get(row.store_id);
    if (!courier || !orgId || !serves(courier)) continue;
    byOrder.set(row.order_id, {
      orderId: row.order_id, orderName: row.order_name, storeId: row.store_id, orgId, courier,
      day: limaCourierTargetDay(courier, today, limaHour), origin: "envio", createdAt: row.order_created_at ?? "", master: row,
    });
  }
  // El acuerdo con la clienta manda sobre el «Programar envío» del mismo pedido.
  const agreed = caseRows.filter((c) => {
    const courier = limaCourierCaseCourier(c, today, limaHour);
    return Boolean(courier && serves(courier));
  });
  if (agreed.length) {
    let facts: Awaited<ReturnType<typeof loadReproFacts>>;
    try {
      facts = await loadReproFacts(admin, agreed.map((c) => c.order_id));
    } catch (e) {
      errors.push(`No se pudieron leer los acuerdos de Repro Lima: ${errorText(e)}`);
      return done();
    }
    for (const c of agreed) {
      const f = facts.get(c.order_id);
      const orgId = orgOfStore.get(c.store_id);
      // Solo el acuerdo vigente: el caso abierto de su episodio, en un pedido que sigue pendiente en Lima.
      if (!f?.order || !orgId || f.cancelled || !(f.inStage || f.attentionEligible)) continue;
      if (!f.open || f.open.id !== c.id || f.open.episode_key !== f.episode.key) continue;
      const courier = limaCourierCaseCourier(c, today, limaHour)!;
      byOrder.set(c.order_id, {
        orderId: c.order_id, orderName: f.order.order_name ?? null, storeId: c.store_id, orgId, courier,
        day: c.agreed_on!.slice(0, 10), origin: "acuerdo", createdAt: f.order.macro_since ?? "",
        liveSameCourier: f.box.kind === "con_courier" && sameCourier(f.box.courier, courier) ? f.box.courier : null,
      });
    }
  }
  // El más antiguo primero: es el que más tiempo lleva esperando su guía.
  const candidates = [...byOrder.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.orderId.localeCompare(b.orderId));
  report.candidates = candidates.length;
  if (!candidates.length) return done();

  // Lo que ya se intentó hoy: repetirlo sería volver a avisar de lo mismo.
  const triedByOrder = new Map<string, { kind: string; payload: unknown }[]>();
  try {
    const tried = await courierRowsByIds(candidates.map((c) => c.orderId), (chunk) =>
      admin.from("order_events").select("order_id,kind,payload").eq("kind", LIMA_COURIER_AUTO_FAILED).in("order_id", chunk) as unknown as PromiseLike<{
        data: { order_id: string; kind: string; payload: unknown }[] | null;
        error: { message: string } | null;
      }>,
    );
    for (const e of tried.data) triedByOrder.set(e.order_id, [...(triedByOrder.get(e.order_id) ?? []), e]);
  } catch (e) {
    errors.push(`No se pudieron leer los intentos de hoy: ${errorText(e)}`);
    return done();
  }

  for (const c of candidates) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      report.stopped = "tiempo";
      break;
    }
    const mode = modeByOrg.get(c.orgId) ?? "apagado";
    const simulate = dry || mode !== "activo";
    const logMode = simulate ? "simulacion" : "activo";
    const item: LimaCourierAutoItem = {
      orderId: c.orderId, orderName: c.orderName, storeId: c.storeId, courier: c.courier, day: c.day, origin: c.origin, mode, outcome: "en_curso",
    };
    report.items.push(item);
    const label = c.orderName ?? c.orderId;
    const courierName = LIMA_AUTO_COURIER_LABEL[c.courier];

    // El renglón del panel: uno por pedido, día y modo; la última pasada del día manda.
    const log = async () => {
      if (dry || !isLimaCourierAutoOutcome(item.outcome)) return;
      const { error } = await admin.from(LIMA_COURIER_AUTO_LOG).upsert(
        {
          org_id: c.orgId, store_id: c.storeId, order_id: c.orderId, order_name: c.orderName, lima_day: today, mode: logMode,
          courier: c.courier, dispatch_on: c.day, origin: c.origin, outcome: item.outcome, guide_code: item.guide ?? null,
          detail: item.detail ?? null, updated_at: new Date().toISOString(),
        },
        { onConflict: "order_id,lima_day,mode" },
      );
      if (error) errors.push(`No se pudo guardar el registro de ${label}: ${error.message}`);
    };
    let master: OrderMasterRow | null = c.master ?? null;
    // En Simulación, «fallo» es lo que diría Activo: sin aviso ni hecho.
    const fail = async (error: string) => {
      item.outcome = "fallo";
      item.detail = error;
      if (!simulate) {
        report.failed += 1;
        item.telegram = await recordFailure(admin, c, today, error, { name: master?.customer_name ?? null, district: master?.district ?? null });
      }
      await log();
    };
    const simulated = async (detail: string) => {
      item.outcome = "simulada";
      item.detail = detail;
      report.simulated += 1;
      await log();
    };

    if (limaCourierTriedOn(triedByOrder.get(c.orderId) ?? [], today)) {
      item.outcome = "ya_intentado";
      continue;
    }
    if (c.liveSameCourier) {
      item.outcome = "ya_tiene_guia";
      item.detail = `Ya tiene su guía de ${courierName}.`;
      continue;
    }

    try {
      if (!master) {
        const { data, error } = await admin.from("order_master").select("*").eq("order_id", c.orderId).maybeSingle();
        if (error || !data) {
          item.outcome = "error";
          item.detail = `No se pudo leer el pedido: ${error?.message ?? "no existe"}`;
          continue;
        }
        master = data as unknown as OrderMasterRow;
      }
      const reason = limaCourierReason(c.courier, c.day, c.origin);
      const motive = limaCourierMotive(c.courier, c.day, c.origin);

      if (c.courier === "aliclik") {
        if (!simulate && !aliclikWrite) {
          await fail("La escritura de Aliclik está apagada en el servidor (ALICLIK_WRITE_ENABLED).");
          continue;
        }
        const resolved = await aliclikReadScopeFor(admin, c.storeId);
        if (!resolved.scope) {
          await fail(resolved.error ?? "No se pudo leer la organización de la tienda.");
          continue;
        }
        const { ctx, error: ctxError } = await aliclikContextFor(master, null, { blockAgencia: true });
        if (!ctx) {
          await fail(ctxError ?? "No se pudo preparar la conexión con Aliclik.");
          continue;
        }
        const preview = await previewAliclikGuideFor(ctx, { modality: "cod" }, resolved.scope);
        if (!preview.ok) {
          await fail(
            preview.needsCoordinate
              ? "Falta la ubicación del pedido: ponla en la ficha (Aliclik) y crea la guía ahí."
              : preview.error ?? "No se pudo cotizar con Aliclik.",
          );
          continue;
        }
        const transportId = defaultAliclikTransport(preview.couriers);
        const transport = preview.couriers?.find((t) => t.transportId === transportId) ?? null;
        if (!transport) {
          await fail("Aliclik no ofrece un transporte que se pueda agendar ahora para esta dirección.");
          continue;
        }
        // Lo de un día que viene, solo si Aliclik lo recoge ese día: creada antes de su corte, la recogería hoy.
        const pickup = expectedDispatchDate(transport.schedule, now);
        if (!limaAliclikPickupFits(c.day, today, pickup)) {
          item.outcome = "espera";
          item.detail = `Aliclik la recogería el ${pickup}: se crea en una pasada que caiga ${c.day}.`;
          continue;
        }
        const extra = preview.additionalOutput;
        if (extra?.blocked) {
          await fail(extra.message);
          continue;
        }
        const createInput = {
          transportId: transport.transportId,
          expectedCollectTotal: preview.collectTotal ?? null,
          motivoSalidaAdicional: extra?.requiresReason ? motive : null,
          note: null,
        };
        const origin: AliclikGuideOrigin = { kind: "dia_programado_lima", scheduledOn: c.day, reason };
        if (simulate) {
          // Lo que la creación real rechazaría siempre, con el mismo motivo, origen y scope que usará Activo.
          const gates = await aliclikCreateGates(ctx, createInput, resolved.scope, origin);
          if (!gates.ok) {
            await fail(gates.kaptaBlock ? gates.error : `No se pudo comprobar: ${gates.error.replace(/\.$/, "")} (Activo lo reintentaría).`);
            continue;
          }
          const recipient = aliclikRecipientBlock(master);
          if (recipient) {
            await fail(recipient);
            continue;
          }
          await simulated(`${transport.transportName ?? "Aliclik"} S/ ${transport.deliveryCost} · cobrar S/ ${(preview.collectTotal ?? 0).toFixed(2)}`);
          continue;
        }
        const result = await createAliclikGuideFor(ctx, createInput, resolved.scope, origin);
        if (result.locked) {
          // Otra creación tiene el candado (una persona ahora, o un timeout que el barrido resuelve).
          item.outcome = "en_curso";
          item.detail = result.error ?? null;
          await log();
          continue;
        }
        if (result.error) {
          await fail(result.error);
          continue;
        }
        item.outcome = "creada";
        item.guide = result.orderNumber ?? null;
        report.created += 1;
        await log();
        continue;
      }

      // Swayp: la guía de la víspera, con la fecha de despacho programada.
      if (!simulate && !swaypOn) {
        await fail("La integración Swayp está apagada en el servidor.");
        continue;
      }
      if (simulate) {
        await simulated(`Crearía la guía Swayp con despacho el ${c.day}. El stock, la cobertura y el vínculo de productos se miran al crearla.`);
        continue;
      }
      const { data: order, error: orderError } = await admin.from("orders").select(DIRECT_GUIDE_ORDER_COLUMNS).eq("id", c.orderId).maybeSingle();
      if (orderError || !order) {
        await fail(`No se pudo leer el pedido: ${orderError?.message ?? "no existe"}`);
        continue;
      }
      const emitted = await emitirGuiaSwaypDirecta(admin, {
        order: order as unknown as DirectGuideOrderRecord,
        actorId: null,
        dispatchDateIso: `${c.day}T00:00:00.000Z`,
        note: reason,
        motivoSalidaAdicional: c.origin === "acuerdo" ? motive : null,
        automatico: { politica: LIMA_COURIER_AUTO_POLICY, origen: "dia_programado_lima", dia: c.day, desde: c.origin },
      });
      if ("error" in emitted) {
        await fail(emitted.error);
        continue;
      }
      item.outcome = "creada";
      item.guide = emitted.code;
      report.created += 1;
      await log();
    } catch (e) {
      // Un error inesperado no se vuelve un hecho de fallo: la pasada siguiente lo reintenta.
      item.outcome = "error";
      item.detail = errorText(e);
      errors.push(`${label}: ${errorText(e)}`);
    }
  }

  return done();
}

// ── El panel ────────────────────────────────────────────────────────────────

/** Un renglón de «Hoy y ayer». */
export interface LimaCourierAutoLogView {
  id: number;
  day: "hoy" | "ayer";
  orderId: string;
  orderName: string;
  storeId: string;
  /** Lo pone el panel, que ya leyó las tiendas. */
  storeName: string | null;
  mode: "simulacion" | "activo";
  courierName: string;
  dispatchOn: string;
  outcome: LimaCourierAutoOutcome | null;
  outcomeLabel: string;
  guideCode: string | null;
  detail: string | null;
  at: string;
}

export interface LimaCourierAutoView {
  /** Falso si la 0349 aún no está: el control se bloquea y todo es Apagado. */
  available: boolean;
  mode: LimaCourierAutoMode;
  aliclikWrite: boolean;
  swaypEnabled: boolean;
  /** Por qué Activo no crearía nada ahora (`limaCourierAutoActivoBlocker`), o null. */
  blocker: string | null;
  log: LimaCourierAutoLogView[];
  error: string | null;
}

const LOG_LIMIT = 200;

/** La posición, si Activo correría, y lo que hicieron las pasadas de hoy y ayer. */
export async function loadLimaCourierAutoView(admin: SupabaseClient, orgId: string, today: string, yesterday: string): Promise<LimaCourierAutoView> {
  const aliclikWrite = env.aliclikWriteEnabled();
  const swaypEnabled = env.swaypEnabled();
  const blocker = limaCourierAutoActivoBlocker({ aliclikWrite, swaypEnabled });
  const base: LimaCourierAutoView = { available: false, mode: "apagado", aliclikWrite, swaypEnabled, blocker, log: [], error: null };
  const [settingsRes, logRes] = await Promise.all([
    admin.from(LIMA_COURIER_AUTO_SETTINGS).select("mode").eq("org_id", orgId).maybeSingle(),
    admin
      .from(LIMA_COURIER_AUTO_LOG)
      .select("id,store_id,order_id,order_name,lima_day,mode,courier,dispatch_on,outcome,guide_code,detail,updated_at")
      .eq("org_id", orgId)
      .in("lima_day", [today, yesterday])
      .order("updated_at", { ascending: false })
      .limit(LOG_LIMIT),
  ]);
  if (isMissingRelation(settingsRes.error) || isMissingRelation(logRes.error)) return base;
  if (settingsRes.error) return { ...base, error: "No se pudo leer la posición de la guía del día programado: no se puede cambiar ahora." };
  const rows = (logRes.data ?? []) as {
    id: number;
    store_id: string;
    order_id: string;
    order_name: string | null;
    lima_day: string;
    mode: "simulacion" | "activo";
    courier: string;
    dispatch_on: string;
    outcome: string;
    guide_code: string | null;
    detail: string | null;
    updated_at: string;
  }[];
  return {
    ...base,
    available: true,
    mode: limaCourierAutoModeFrom((settingsRes.data as { mode?: string } | null)?.mode),
    log: rows.map((r) => {
      const outcome = isLimaCourierAutoOutcome(r.outcome) ? r.outcome : null;
      return {
        id: r.id,
        day: r.lima_day === today ? "hoy" : "ayer",
        orderId: r.order_id,
        orderName: r.order_name ?? "Pedido",
        storeId: r.store_id,
        storeName: null,
        mode: r.mode,
        courierName: r.courier === "fenix" ? "Swayp" : "Aliclik",
        dispatchOn: r.dispatch_on,
        outcome,
        outcomeLabel: outcome ? limaCourierAutoOutcomeLabel(outcome, r.mode) : r.outcome,
        guideCode: r.guide_code,
        detail: r.detail,
        at: formatLimaDateTime(r.updated_at),
      };
    }),
    error: logRes.error ? "No se pudo leer lo que hizo la guía del día programado hoy y ayer." : null,
  };
}

/**
 * Las tiendas cuya organización la tiene en Activo (best-effort): Repro Lima
 * dice entonces que Kapta crea la guía de Aliclik o Swayp sola.
 */
export async function loadLimaCourierAutoActiveStores(admin: SupabaseClient, storeIds: readonly string[]): Promise<string[]> {
  if (!storeIds.length) return [];
  const { data: stores, error } = await admin.from("stores").select("id,org_id").in("id", [...storeIds]);
  if (error || !stores?.length) return [];
  const orgIds = [...new Set((stores as { id: string; org_id: string }[]).map((s) => s.org_id))];
  const { data: settings, error: settingsError } = await admin.from(LIMA_COURIER_AUTO_SETTINGS).select("org_id,mode").in("org_id", orgIds);
  if (settingsError) return [];
  const active = new Set(((settings ?? []) as { org_id: string; mode: string }[]).filter((s) => s.mode === "activo").map((s) => s.org_id));
  return (stores as { id: string; org_id: string }[]).filter((s) => active.has(s.org_id)).map((s) => s.id);
}
