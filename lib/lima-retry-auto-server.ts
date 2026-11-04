import "server-only";

// La pasada de los reintentos Aliclik automáticos de Lima (MOM §9.5, entrega 3,
// y §40 «Panel de automatizaciones», owner 04-11-2026). La regla —variantes,
// posiciones, tope, horario, qué se reintenta— está en lib/lima-retry-auto.ts;
// la creación, en lib/lima-retry-approve.ts, la misma que «Aprobar».
//
// CÓMO EVITA CREAR DOS VECES. El renglón (pedido, día de Lima, `activo`) de
// `lima_retry_auto_log` es el candado: se inserta «en curso» y, si ya existía,
// solo se toma de nuevo con un update condicionado a un resultado que se
// reintenta (`RETRY_OUTCOMES_RETRYABLE`). Dos pasadas a la vez —el cron y una
// ejecución a mano— no pueden tomar el mismo pedido el mismo día. Debajo sigue
// el candado propio de `createAliclikGuideFor` (`aliclik_order_requests`), que
// también ataja a una persona pulsando «Aprobar» en ese momento.
//
// QUÉ NO HACE. No llama ni decide nada que la bandeja no decidiera: si una
// persona tiene el caso tomado en Repro Lima, espera; si Aliclik no ofrece el
// transporte, pasa a Repro Lima como con «Aprobar».

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { limaTodayKey } from "@/lib/shipments";
import { limaTimeHHMM } from "@/lib/aliclik-geo";
import { loadAliclikHealthState } from "@/lib/aliclik-health-access";
import { aliclikReadScopeFor, type AliclikReadScope } from "@/lib/aliclik-guide";
import { waitForAliclik } from "@/lib/aliclik-scheduled";
import { telegramTarget } from "@/lib/aliclik-scheduled-server";
import { escapeHtml, sendTelegramToAll } from "@/lib/telegram";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import { loadReproFacts, retryChainOf, type ReproFacts } from "@/lib/repro-lima-access";
import type { ReproOrderRow } from "@/lib/repro-lima-program";
import { claimView } from "@/lib/repro-lima";
import {
  RETRY_DAILY_CAP_DEFAULT,
  RETRY_DAILY_CAP_MAX,
  RETRY_DAILY_CAP_MIN,
  RETRY_OUTCOMES_COUNTED,
  RETRY_OUTCOMES_RETRYABLE,
  anyRetryVariantOn,
  retryCapLeft,
  retryModes,
  retryPassOpen,
  retryVariantLabel,
  retryVariantOf,
  type RetryMode,
  type RetryOutcome,
  type RetryVariant,
} from "@/lib/lima-retry-auto";
import {
  RETRY_TRANSPORT_LABEL,
  approveLimaRetry,
  type RetryApproveResult,
  type RetryChainNext,
  type RetryChainView,
} from "@/lib/lima-retry-approve";
import type { OrderMasterRow } from "@/lib/types";

/** El tiempo de una pasada. Lo que no entra se intenta en la siguiente hora. */
const TIME_BUDGET_MS = 240_000;

const LOG = "lima_retry_auto_log";

/** El hecho del historial de un reintento automático que no se pudo crear. */
export const LIMA_RETRY_AUTO_FAILED = "lima_retry_auto_failed";

export interface LimaRetryAutoItem {
  orderId: string;
  orderName: string | null;
  storeId: string;
  variant: RetryVariant;
  /** La posición guardada de la variante (en `preview`, aunque esté apagada). */
  mode: RetryMode;
  outcome: RetryOutcome;
  transport?: string | null;
  guide?: string | null;
  detail?: string | null;
}

export interface LimaRetryAutoOrgReport {
  orgId: string;
  dailyCap: number;
  /** Guías automáticas que quedan hoy, al terminar la pasada. */
  capLeft: number;
  items: LimaRetryAutoItem[];
}

export interface LimaRetryAutoReport {
  today: string;
  limaHour: number;
  /** `fuera_de_horario`: la pasada no corre fuera de 8:00–13:59 de Lima. */
  skipped: string | null;
  orgs: LimaRetryAutoOrgReport[];
  /** Se agotó el tiempo antes de terminar. Lo que quedó va en la pasada siguiente. */
  stopped: "tiempo" | null;
  error: string | null;
}

type Candidate = {
  row: OrderMasterRow;
  facts: ReproFacts;
  chain: RetryChainView;
  raw: RetryChainNext;
  variant: RetryVariant;
  mode: RetryMode;
  claimed: boolean;
};

/** Ubicación corta para la alerta: distrito y provincia, sin repetir. */
function placeOf(row: OrderMasterRow): string | null {
  const parts = [row.district, row.province].filter((p): p is string => Boolean(p?.trim()));
  return [...new Set(parts)].join(", ") || null;
}

const ALERT_REASON_MAX = 400;

/** La alerta de Telegram de UN reintento automático que no se creó (o quedó en duda). Pura. */
export function retryFailureTelegram(input: {
  storeName: string;
  orderName: string | null;
  customerName: string | null;
  place: string | null;
  variant: RetryVariant;
  outcome: "fallo" | "incierto";
  error: string;
  url: string;
}): string {
  const reason = input.error.length > ALERT_REASON_MAX ? `${input.error.slice(0, ALERT_REASON_MAX - 1)}…` : input.error;
  const who = [input.customerName, input.place].filter(Boolean).join(" · ");
  const title = input.outcome === "incierto"
    ? "reintento Aliclik automático sin respuesta: revisar si se creó"
    : "reintento Aliclik automático no creado";
  return [
    `⚠️ <b>${escapeHtml(input.storeName)}</b> · ${title}`,
    `<b>${escapeHtml(input.orderName ?? "Pedido sin número")}</b>${who ? ` · ${escapeHtml(who)}` : ""}`,
    `Regla: ${escapeHtml(retryVariantLabel(input.variant))}.`,
    "",
    `Motivo: ${escapeHtml(reason)}`,
    "",
    input.outcome === "incierto"
      ? "Revisa en Aliclik antes de crearla otra vez:"
      : "Créala a mano desde Repro Lima o pásalo a Repro Lima:",
    escapeHtml(input.url),
  ].join("\n");
}

/** El texto que queda en el log por cada resultado del núcleo. Pura. */
export function retryResultDetail(result: RetryApproveResult): string | null {
  switch (result.outcome) {
    case "simulada":
      return result.detail;
    case "sin_transporte":
      return `Aliclik no ofrece ${result.transport} para esta dirección: pasa a Repro Lima.`;
    case "no_seleccionable":
      return result.reason ?? `${result.transport} no se puede agendar ahora.`;
    case "creada":
      return null;
    default:
      return result.error;
  }
}

function clampCap(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return RETRY_DAILY_CAP_DEFAULT;
  return Math.min(RETRY_DAILY_CAP_MAX, Math.max(RETRY_DAILY_CAP_MIN, Math.round(n)));
}

/**
 * Un reintento que falló de verdad (o quedó en duda): UN aviso a la tienda y el
 * hecho en el historial. Va una sola vez por pedido y día porque el renglón del
 * log ya no vuelve a tomarse ese día (`fallo` e `incierto` no se reintentan).
 */
async function recordFailure(
  admin: SupabaseClient,
  row: OrderMasterRow,
  today: string,
  variant: RetryVariant,
  outcome: "fallo" | "incierto",
  error: string,
): Promise<void> {
  let telegram = false;
  try {
    const target = await telegramTarget(admin, row.store_id);
    if (target) {
      const res = await sendTelegramToAll(target.token, target.chats, retryFailureTelegram({
        storeName: target.storeName,
        orderName: row.order_name,
        customerName: row.customer_name,
        place: placeOf(row),
        variant,
        outcome,
        error,
        url: `${env.siteUrl()}/dashboard/pedidos?abrir=${encodeURIComponent(row.order_id)}`,
      }));
      telegram = res.sent > 0;
    }
  } catch {
    /* el hecho queda igual en el historial */
  }
  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind: LIMA_RETRY_AUTO_FAILED,
    occurred_at: new Date().toISOString(),
    actor: null,
    source: "system",
    courier: "aliclik",
    reason: error.slice(0, 2000),
    note: outcome === "incierto"
      ? "Aliclik no respondió al crear el reintento automático: puede haberse creado. Revísalo antes de crearlo otra vez."
      : "No se pudo crear el reintento Aliclik automático. Hay que crearlo a mano o pasarlo a Repro Lima.",
    payload: { date: today, variant, outcome, telegram },
  });
}

/** Las guías automáticas de hoy que cuentan para el tope, sin contar `exceptId`. */
async function countedToday(admin: SupabaseClient, orgId: string, today: string, exceptId?: number | string): Promise<number> {
  let query = admin.from(LOG).select("id")
    .eq("org_id", orgId)
    .eq("lima_day", today)
    .eq("mode", "activo")
    .in("outcome", RETRY_OUTCOMES_COUNTED as RetryOutcome[]);
  if (exceptId !== undefined) query = query.neq("id", exceptId);
  const { data, error } = await query;
  if (error) throw new Error(`No se pudo contar el tope del día: ${error.message}`);
  return (data ?? []).length;
}

/**
 * Toma el pedido para crear hoy. Inserta el renglón «en curso»; si ya existía,
 * lo toma solo si quedó en algo que se reintenta. Devuelve el id del renglón, o
 * null si otra pasada ya lo resolvió (o lo está resolviendo) hoy.
 */
async function claimActive(
  admin: SupabaseClient,
  base: Record<string, unknown>,
): Promise<{ id: number | string | null; error?: string }> {
  const now = new Date().toISOString();
  const inserted = await admin.from(LOG)
    .upsert({ ...base, mode: "activo", outcome: "en_curso", detail: null, updated_at: now }, { onConflict: "order_id,lima_day,mode", ignoreDuplicates: true })
    .select("id");
  if (inserted.error) return { id: null, error: inserted.error.message };
  const fresh = ((inserted.data ?? []) as { id: number | string }[])[0];
  if (fresh) return { id: fresh.id };
  // Ya había renglón hoy: se toma solo si quedó en algo que se reintenta. Es un
  // único update condicionado, así que de dos pasadas solo una lo gana.
  const retaken = await admin.from(LOG)
    .update({ outcome: "en_curso", variant: base.variant, detail: null, updated_at: now })
    .eq("order_id", base.order_id as string)
    .eq("lima_day", base.lima_day as string)
    .eq("mode", "activo")
    .in("outcome", RETRY_OUTCOMES_RETRYABLE as RetryOutcome[])
    .select("id");
  if (retaken.error) return { id: null, error: retaken.error.message };
  const rows = (retaken.data ?? []) as { id: number | string }[];
  return { id: rows[0]?.id ?? null };
}

/** Los pedidos de la organización en «Por reprogramar Lima» con un reintento listo hoy. */
async function candidatesOf(
  admin: SupabaseClient,
  storeIds: string[],
  modes: Record<RetryVariant, RetryMode>,
  today: string,
  now: Date,
  preview: boolean,
): Promise<Candidate[]> {
  // Por páginas: nunca confiar en una sola de 1000 filas.
  const rows = (await courierRowsByIds(storeIds, async (chunk) => ({
    data: await allCourierRows<OrderMasterRow>((from, to) => admin
      .from("order_master")
      .select("*")
      .in("store_id", chunk)
      .eq("macro_stage", "en_curso")
      .eq("macro_substage", "por_reprogramar_lima")
      .order("order_id")
      .range(from, to) as unknown as PromiseLike<{ data: OrderMasterRow[] | null; error: { message: string } | null }>),
    error: null,
  }))).data;
  if (!rows.length) return [];
  const facts = await loadReproFacts(admin as never, rows.map((row) => row.order_id), {
    orders: rows as unknown as ReproOrderRow[],
  });
  const out: Candidate[] = [];
  for (const row of rows) {
    const f = facts.get(row.order_id);
    if (!f) continue;
    const open = f.open && f.open.episode_key === f.episode.key ? f.open : null;
    const chain = retryChainOf(f, open, today);
    if (!chain || !chain.ready || f.retryChain.state !== "siguiente") continue;
    const raw = f.retryChain;
    const variant = retryVariantOf(raw);
    if (!variant) continue;
    const mode = modes[variant];
    if (mode === "apagado" && !preview) continue;
    // Una persona con el caso tomado ahora mismo: es suyo, la pasada espera.
    const claimed = claimView(open?.claimed_by, open?.claimed_until, "", now) !== "libre";
    out.push({ row, facts: f, chain, raw, variant, mode, claimed });
  }
  // El fallo más viejo primero: es el que más tiempo lleva esperando.
  return out.sort((a, b) => Date.parse(a.raw.failed.at) - Date.parse(b.raw.failed.at));
}

/**
 * Una pasada. Sin `preview`, solo de 8:00 a 13:59 de Lima: simula las variantes
 * en simulación (deja el renglón en el log) y crea las activas, con tope y
 * candado. Con `preview`, «qué pasaría hoy si todo estuviera en simulación»:
 * cotiza todas las variantes, a cualquier hora, y no escribe NADA (ni log, ni
 * hechos, ni Telegram). Es el «Simular ahora» del panel.
 */
export async function runLimaRetryAuto(
  admin: SupabaseClient,
  opts: { now?: Date; orgId?: string; preview?: boolean } = {},
): Promise<LimaRetryAutoReport> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const preview = !!opts.preview;
  const today = limaTodayKey(now);
  const limaHour = Number(limaTimeHHMM(now).slice(0, 2));
  const report: LimaRetryAutoReport = { today, limaHour, skipped: null, orgs: [], stopped: null, error: null };
  const errors: string[] = [];

  if (!preview && !retryPassOpen(limaHour)) {
    report.skipped = "fuera_de_horario";
    return report;
  }
  const writeOk = env.aliclikWriteEnabled();

  // Las posiciones de cada organización: sin renglón, apagada.
  let variantsQuery = admin.from("lima_retry_auto_variants").select("org_id,variant,mode");
  if (opts.orgId) variantsQuery = variantsQuery.eq("org_id", opts.orgId);
  const { data: variantRows, error: variantsError } = await variantsQuery;
  if (variantsError) {
    report.error = `No se pudieron leer las variantes: ${variantsError.message}`;
    return report;
  }
  const rowsByOrg = new Map<string, { variant: string; mode: string }[]>();
  for (const r of (variantRows ?? []) as { org_id: string; variant: string; mode: string }[]) {
    rowsByOrg.set(r.org_id, [...(rowsByOrg.get(r.org_id) ?? []), r]);
  }
  if (opts.orgId && !rowsByOrg.has(opts.orgId)) rowsByOrg.set(opts.orgId, []);
  const orgModes = [...rowsByOrg.entries()]
    .map(([orgId, rows]) => ({ orgId, modes: retryModes(rows) }))
    // Una organización con todo apagado ni lee pedidos; la vista previa de una
    // organización concreta sí, para que el panel pueda probar antes de encender.
    .filter(({ orgId, modes }) => anyRetryVariantOn(modes) || (preview && orgId === opts.orgId));
  if (!orgModes.length) return report;

  const { data: settingsRows, error: settingsError } = await admin
    .from("lima_retry_auto_settings")
    .select("org_id,daily_cap")
    .in("org_id", orgModes.map((o) => o.orgId));
  if (settingsError) {
    report.error = `No se pudo leer el tope diario: ${settingsError.message}`;
    return report;
  }
  const capByOrg = new Map(((settingsRows ?? []) as { org_id: string; daily_cap: number }[]).map((s) => [s.org_id, clampCap(s.daily_cap)]));

  if (!preview && !writeOk && orgModes.some(({ modes }) => Object.values(modes).includes("activo"))) {
    errors.push("ALICLIK_WRITE_ENABLED está apagado: las variantes activas no crean nada (la simulación sí corre).");
  }

  const scopes = new Map<string, AliclikReadScope | string>();
  const waiting = new Map<string, boolean>();
  const scopeOf = async (storeId: string): Promise<AliclikReadScope | string> => {
    let scope = scopes.get(storeId);
    if (!scope) {
      const resolved = await aliclikReadScopeFor(admin, storeId);
      scope = resolved.scope ?? resolved.error ?? "No se pudo leer la organización de la tienda.";
      scopes.set(storeId, scope);
    }
    return scope;
  };

  // El núcleo de «Aprobar», como sistema; sin scope de la tienda no se cotiza.
  const runCore = async (c: Candidate, dry: boolean): Promise<RetryApproveResult> => {
    const scope = await scopeOf(c.row.store_id);
    if (typeof scope === "string") {
      return { outcome: "fallo", stage: "contexto", transport: RETRY_TRANSPORT_LABEL[c.chain.next], error: scope };
    }
    return approveLimaRetry({
      admin, row: c.row, chain: c.chain, raw: c.raw, actor: { system: true, variant: c.variant }, today, dry, scope,
    });
  };

  outer: for (const { orgId, modes } of orgModes) {
    const dailyCap = capByOrg.get(orgId) ?? RETRY_DAILY_CAP_DEFAULT;
    const org: LimaRetryAutoOrgReport = { orgId, dailyCap, capLeft: dailyCap, items: [] };
    report.orgs.push(org);
    try {
      const { data: stores, error: storesError } = await admin
        .from("stores").select("id").eq("org_id", orgId).eq("status", "active");
      if (storesError) throw new Error(`No se pudieron leer las tiendas: ${storesError.message}`);
      const storeIds = ((stores ?? []) as { id: string }[]).map((s) => s.id);
      const candidates = storeIds.length ? await candidatesOf(admin, storeIds, modes, today, now, preview) : [];

      for (const c of candidates) {
        if (Date.now() - started > TIME_BUDGET_MS) {
          report.stopped = "tiempo";
          break outer;
        }
        const { row, chain, variant, mode } = c;
        const transport = RETRY_TRANSPORT_LABEL[chain.next];
        const item: LimaRetryAutoItem = {
          orderId: row.order_id, orderName: row.order_name, storeId: row.store_id,
          variant, mode, outcome: "atendiendo", transport,
        };

        // --- Vista previa: todo como simulación, sin escribir nada. --------
        if (preview) {
          org.items.push(item);
          if (c.claimed) {
            item.detail = "Caso tomado en Repro Lima.";
            continue;
          }
          const result = await runCore(c, true);
          item.outcome = result.outcome;
          item.detail = retryResultDetail(result);
          continue;
        }

        const base = {
          org_id: orgId, store_id: row.store_id, order_id: row.order_id, order_name: row.order_name,
          lima_day: today, variant, transport,
        };

        // --- Simulación: dice qué haría, deja el renglón y nada más. -------
        if (mode === "simulacion") {
          org.items.push(item);
          if (c.claimed) {
            item.detail = "Caso tomado en Repro Lima.";
          } else {
            const result = await runCore(c, true);
            item.outcome = result.outcome;
            item.detail = retryResultDetail(result);
          }
          const { error } = await admin.from(LOG).upsert({
            ...base, mode: "simulacion", outcome: item.outcome, detail: item.detail ?? null,
            guide_code: null, updated_at: new Date().toISOString(),
          }, { onConflict: "order_id,lima_day,mode" });
          if (error) errors.push(`No se pudo guardar la simulación de ${row.order_name ?? row.order_id}: ${error.message}`);
          continue;
        }

        // --- Activo: candado, persona, tope, salud de Aliclik y creación. --
        if (mode !== "activo" || !writeOk) continue;
        const claim = await claimActive(admin, base);
        if (claim.error) {
          errors.push(`No se pudo tomar ${row.order_name ?? row.order_id}: ${claim.error}`);
          continue;
        }
        if (claim.id === null) continue; // Ya resuelto (o en curso) hoy.
        org.items.push(item);
        const finish = async () => {
          const { error } = await admin.from(LOG).update({
            outcome: item.outcome, transport: item.transport ?? null, guide_code: item.guide ?? null,
            detail: item.detail ?? null, updated_at: new Date().toISOString(),
          }).eq("id", claim.id as number | string);
          if (error) errors.push(`No se pudo guardar el resultado de ${row.order_name ?? row.order_id}: ${error.message}`);
        };

        if (c.claimed) {
          item.outcome = "atendiendo";
          item.detail = "Caso tomado en Repro Lima.";
          await finish();
          continue;
        }
        const counted = await countedToday(admin, orgId, today, claim.id);
        if (retryCapLeft(counted, dailyCap) <= 0) {
          item.outcome = "tope";
          item.detail = `Tope de ${dailyCap} guías automáticas del día.`;
          await finish();
          continue;
        }
        // La salud es de la organización (un token Aliclik): se lee una vez por tienda.
        if (!waiting.has(row.store_id)) {
          waiting.set(row.store_id, waitForAliclik(await loadAliclikHealthState(admin as never, row.store_id), limaHour));
        }
        if (waiting.get(row.store_id)) {
          item.outcome = "esperando_aliclik";
          item.detail = "Aliclik está fallando: se reintenta en la pasada siguiente.";
          await finish();
          continue;
        }

        const result = await runCore(c, false);
        item.outcome = result.outcome;
        item.detail = retryResultDetail(result);
        if (result.outcome === "creada") item.guide = result.guide;
        await finish();
        // `createAliclikGuideFor` ya recalcula el Master al crear; no se repite.
        if (result.outcome === "fallo" || result.outcome === "incierto") {
          await recordFailure(admin, row, today, variant, result.outcome, result.error);
        }
      }
    } catch (e) {
      errors.push(`Organización ${orgId}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      try {
        org.capLeft = retryCapLeft(await countedToday(admin, orgId, today), dailyCap);
      } catch {
        /* el tope es informativo en el reporte */
      }
    }
  }

  report.error = errors.length ? errors.join(" · ") : null;
  return report;
}
