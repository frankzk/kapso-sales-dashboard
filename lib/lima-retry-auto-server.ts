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
// ANTES DE CREAR SE VUELVE A LEER (04-11-2026). La lista de candidatos se lee
// al empezar y la pasada puede durar cuatro minutos. Con el renglón ya tomado,
// se relee ESE pedido (hechos, caso, cadena, quién lo tiene) y la posición de
// ESA variante (`retryRecheck`): si la tienda lo pasó «A Repro Lima», acordó
// otra cosa, el owner apagó la variante o el paso cambió, no se crea y el
// renglón se BORRA. Borrarlo —y no dejarlo en otro resultado— mantiene la
// máquina de estados: el log no tiene un resultado «no tocaba» (0306 los
// cierra con un check), «en curso» contaría para el tope sin haber creado
// nada, y un resultado que se reintenta mentiría en «Hoy y ayer». Sin
// renglón, el pedido queda como si esta pasada no lo hubiera tomado: si sigue
// tocando, la siguiente lo toma con un insert nuevo; si no, ya no es
// candidato. Solo se borra el renglón «en curso» propio (por id y resultado),
// así que no pisa a otra pasada.
//
// QUÉ NO HACE. No llama ni decide nada que la bandeja no decidiera: si una
// persona tiene el caso tomado en Repro Lima, espera; si Aliclik no ofrece el
// transporte, pasa a Repro Lima como con «Aprobar». Si una regla de Kapta no
// deja crear la guía (venta anulada, adelanto exigido, rechazos en la puerta,
// salidas…), avisa una vez y lo pasa a Repro Lima: mañana diría lo mismo.
//
// SIN UBICACIÓN (05-11-2026). Aliclik exige la coordenada y desde WooCommerce
// casi ningún pedido de Lima la trae. Un pedido sin coordenada queda
// `sin_ubicacion`: se reintenta, no cuenta para el tope, no avisa ni deja hecho
// de fallo y sigue en la bandeja. Si el owner encendió «Usar la ubicación por
// dirección (Google)» (`lima_retry_auto_settings.geocode_enabled`), la clave
// está y la última medición de Lima cumple B con el edificio
// (`geocodeLimaGate`), la pasada busca la dirección en Google UNA vez por
// pedido (`geocodeOrderAddress`, caché `order_geocodes`) y cotiza y crea con
// ese punto, como la guía de Chatby. Si Google contesta que se acabó el cupo,
// no se le pregunta más en esta pasada: lo que falta queda `sin_ubicacion`.

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
import { CHAIN_EVENT_KINDS } from "@/lib/lima-retry-chain";
import { askRetryLocation } from "@/lib/lima-retry-chatby-ask-server";
import { retryAskModeFrom, type RetryAskMode } from "@/lib/lima-retry-chatby-ask";
import { locateRetryOrder, retryGeocodeKey, type RetryCoordinate, type RetryLocated } from "@/lib/lima-retry-location";
import { unsavedAliclikIntent, type CreationIntent } from "@/lib/aliclik-intent-release";
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
  retryHeldDetail,
  retryNoLocationDetail,
  retryKaptaBlockReason,
  retryPassOpen,
  retryRecheck,
  retryVariantLabel,
  retryVariantOf,
  type RetryGeocodeMiss,
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

/**
 * El tiempo de una pasada. Lo que no entra se intenta en la siguiente hora. La
 * ruta del cron tiene 300 s (`maxDuration`); se corta 60 s antes porque una
 * cotización o una creación en curso puede tardar hasta 20 s por intento.
 */
const TIME_BUDGET_MS = 240_000;
/**
 * El de «Simular ahora»: corre dentro de la acción de la página
 * (`app/dashboard/automatizaciones/page.tsx`, `maxDuration = 300`), que además
 * comprueba permisos antes y tiene que devolver la respuesta. Más margen que
 * el cron: si se corta, muestra lo evaluado en vez de morir a los 300 s.
 */
const PREVIEW_TIME_BUDGET_MS = 200_000;

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
  /** Tomados y soltados sin crear: al releerlos ya no tocaba (`retryRecheck`). */
  released: { orderId: string; orderName: string | null; reason: string }[];
  /**
   * En Activo, los que tienen una creación de Aliclik sin guardar en Kapta: no
   * se toman ni cuentan para el tope; los resuelve una persona (el aviso salió
   * el día que pasó, como «Puede estar creada»).
   */
  held: { orderId: string; orderName: string | null; detail: string }[];
}

export interface LimaRetryAutoReport {
  today: string;
  limaHour: number;
  /** `fuera_de_horario`: la pasada no corre fuera de 8:00–13:59 de Lima. */
  skipped: string | null;
  orgs: LimaRetryAutoOrgReport[];
  /** Se agotó el tiempo antes de terminar. Lo que quedó va en la pasada siguiente. */
  stopped: "tiempo" | null;
  /** La ubicación por dirección en esta pasada: consultas (o lecturas de caché) y si se acabó el cupo. */
  geocode: { lookups: number; quotaHit: boolean };
  /** «Pedir la ubicación por WhatsApp» (0324): mensajes que salieron y los que se habrían mandado. */
  chatbyAsk: { sent: number; simulated: number };
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
  /**
   * Una creación de Aliclik de este pedido sin su guía en Kapta
   * (`unsavedAliclikIntent`): la pasada no lo cotiza ni lo toma, es de una persona.
   */
  unsaved: { status: string; orderNumber: string | null } | null;
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
  /** Con `incierto`: la guía que Aliclik SÍ creó y Kapta no pudo guardar. */
  guide?: string | null;
  /** Con `fallo`: una regla de Kapta no la deja crear y el pedido pasó a Repro Lima. */
  kaptaBlock?: boolean;
}): string {
  const reason = input.error.length > ALERT_REASON_MAX ? `${input.error.slice(0, ALERT_REASON_MAX - 1)}…` : input.error;
  const who = [input.customerName, input.place].filter(Boolean).join(" · ");
  const kind = retryFailureKind(input);
  const title = {
    sin_vincular: "reintento Aliclik automático creado en Aliclik pero sin guardar en Kapta",
    incierto: "reintento Aliclik automático sin respuesta: revisar si se creó",
    bloqueo_kapta: "reintento Aliclik automático bloqueado por Kapta: pasó a Repro Lima",
    fallo: "reintento Aliclik automático no creado",
  }[kind];
  // Lo que hay que hacer. Con la guía ya en Aliclik, crearla «a mano» sería
  // un segundo pedido real: se vincula o se revisa, nunca se crea otra vez.
  const action = {
    sin_vincular: `La guía ${input.guide ?? ""} ya existe en Aliclik: vincúlala o revísala a mano desde la ficha del pedido. No la crees otra vez:`,
    incierto: "Revisa en Aliclik antes de crearla otra vez:",
    bloqueo_kapta: "No se reintenta: la tienda lo atiende en Repro Lima como siempre.",
    fallo: "Créala a mano desde Repro Lima o pásalo a Repro Lima:",
  }[kind];
  return [
    `⚠️ <b>${escapeHtml(input.storeName)}</b> · ${title}`,
    `<b>${escapeHtml(input.orderName ?? "Pedido sin número")}</b>${who ? ` · ${escapeHtml(who)}` : ""}`,
    `Regla: ${escapeHtml(retryVariantLabel(input.variant))}.`,
    "",
    `Motivo: ${escapeHtml(reason)}`,
    "",
    escapeHtml(action),
    escapeHtml(input.url),
  ].join("\n");
}

/** Qué clase de aviso es: la guía existe sin guardar, sin respuesta, regla de Kapta o rechazo. Pura. */
export function retryFailureKind(input: {
  outcome: "fallo" | "incierto";
  guide?: string | null;
  kaptaBlock?: boolean;
}): "sin_vincular" | "incierto" | "bloqueo_kapta" | "fallo" {
  if (input.outcome === "incierto") return input.guide ? "sin_vincular" : "incierto";
  return input.kaptaBlock ? "bloqueo_kapta" : "fallo";
}

const FAILURE_NOTE: Record<ReturnType<typeof retryFailureKind>, string> = {
  sin_vincular:
    "Aliclik creó la guía del reintento automático, pero Kapta no pudo guardarla. Vincúlala o revísala a mano desde la ficha; no la crees otra vez.",
  incierto: "Aliclik no respondió al crear el reintento automático: puede haberse creado. Revísalo antes de crearlo otra vez.",
  bloqueo_kapta: "Una regla de Kapta no deja crear el reintento Aliclik automático: el pedido pasó a Repro Lima y no se reintenta.",
  fallo: "No se pudo crear el reintento Aliclik automático. Hay que crearlo a mano o pasarlo a Repro Lima.",
};

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
      return result.coordinateNote ?? null;
    default:
      // Si una regla de Kapta lo sacó de la cadena, lo agrega la pasada, y
      // solo cuando el hecho de «A Repro Lima» quedó escrito.
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
  extra: { guide?: string | null; kaptaBlock?: boolean } = {},
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
        ...extra,
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
    ...(extra.guide ? { guide_code: extra.guide } : {}),
    reason: error.slice(0, 2000),
    note: FAILURE_NOTE[retryFailureKind({ outcome, ...extra })],
    payload: {
      date: today, variant, outcome, telegram,
      ...(extra.guide ? { guide: extra.guide } : {}),
      ...(extra.kaptaBlock ? { kapta_block: true } : {}),
    },
  });
}

/**
 * Saca de la cadena, como sistema, un pedido que una regla de Kapta no deja
 * crear: el mismo hecho que «A Repro Lima» (`lima_retry_dismissed`), sin
 * persona. Sin esto la pasada volvía a tomarlo cada día, fallaba igual y
 * volvía a avisar hasta que la cadena vencía.
 */
async function dismissForKaptaBlock(
  admin: SupabaseClient,
  c: Pick<Candidate, "row" | "chain" | "variant">,
  error: string,
): Promise<string | null> {
  const { error: insertError } = await admin.from("order_events").insert({
    store_id: c.row.store_id,
    order_id: c.row.order_id,
    kind: CHAIN_EVENT_KINDS.dismissed,
    occurred_at: new Date().toISOString(),
    actor: null,
    source: "system",
    reason: retryKaptaBlockReason(error),
    payload: {
      attempt: c.chain.attempt, of: c.chain.of, transport: RETRY_TRANSPORT_LABEL[c.chain.next],
      why: "bloqueo_kapta", auto: true, variant: c.variant,
    },
  });
  return insertError ? insertError.message : null;
}

/** Suelta el candado propio: borra el renglón «en curso» que tomó esta pasada. */
async function releaseClaim(admin: SupabaseClient, id: number | string, why: string): Promise<string | null> {
  let failure: string;
  try {
    const { error } = await admin.from(LOG).delete().eq("id", id).eq("outcome", "en_curso");
    if (!error) return null;
    failure = error.message;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  // No se pudo borrar: que al menos no se quede «en curso» todo el día (cuenta
  // para el tope y no se vuelve a tomar). `esperando_aliclik` se reintenta y
  // no cuenta; el detalle dice por qué.
  try {
    const { error } = await admin.from(LOG)
      .update({ outcome: "esperando_aliclik", detail: `Se reintenta en la pasada siguiente: ${why}`, updated_at: new Date().toISOString() })
      .eq("id", id);
    return error ? `${failure}; tampoco se pudo dejar para reintentar: ${error.message}` : `${failure} (quedó para reintentar)`;
  } catch (e) {
    return `${failure}; tampoco se pudo dejar para reintentar: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Las creaciones de Aliclik sin su guía en Kapta de estos pedidos
 * (`unsavedAliclikIntent`). Una lectura que falla lanza: sin saberlo no se
 * cotiza ni se crea (el candado de la creación lo ataja igual).
 */
async function unsavedIntentsOf(
  admin: SupabaseClient,
  orderIds: string[],
): Promise<Map<string, { status: string; orderNumber: string | null }>> {
  const out = new Map<string, { status: string; orderNumber: string | null }>();
  if (!orderIds.length) return out;
  const [intents, guides] = await Promise.all([
    courierRowsByIds(orderIds, (chunk) => admin.from("aliclik_order_requests")
      .select("id,order_id,status,order_number,released_at")
      .in("order_id", chunk).neq("status", "failed").is("released_at", null) as unknown as PromiseLike<{
        data: (CreationIntent & { order_id: string })[] | null; error: { message: string } | null }>),
    courierRowsByIds(orderIds, (chunk) => admin.from("shipments")
      .select("order_id,courier,guide_code,external_order_number")
      .in("order_id", chunk).eq("courier", "aliclik") as unknown as PromiseLike<{
        data: { order_id: string; courier: string | null; guide_code: string | null; external_order_number: string | null }[] | null;
        error: { message: string } | null }>),
  ]);
  for (const id of orderIds) {
    const unsaved = unsavedAliclikIntent(
      intents.data.filter((i) => i.order_id === id),
      guides.data.filter((g) => g.order_id === id),
    );
    if (unsaved) out.set(id, unsaved);
  }
  return out;
}

/**
 * Vuelve a leer UN pedido y la posición de SU variante justo antes de crear
 * (`retryRecheck`). Con `crear`, devuelve el candidato con la fila y la cadena
 * de ahora: se crea con lo que hay, no con lo que había al empezar.
 */
async function recheckCandidate(
  admin: SupabaseClient,
  orgId: string,
  c: Candidate,
  today: string,
  at: Date,
): Promise<{ action: "crear"; candidate: Candidate } | { action: "atendiendo" } | { action: "soltar"; reason: string }> {
  const [orderRes, modeRes, unsaved] = await Promise.all([
    admin.from("order_master").select("*").eq("order_id", c.row.order_id).maybeSingle(),
    admin.from("lima_retry_auto_variants").select("mode").eq("org_id", orgId).eq("variant", c.variant).maybeSingle(),
    unsavedIntentsOf(admin, [c.row.order_id]),
  ]);
  // Lo que no se pudo leer no autoriza a crear: quien llama suelta y lo anota.
  if (orderRes.error || modeRes.error) {
    throw new Error(`no se pudo volver a leer antes de crear: ${(orderRes.error ?? modeRes.error)!.message}`);
  }
  const row = orderRes.data as OrderMasterRow | null;
  if (!row) return { action: "soltar", reason: "El pedido ya no está en el Master." };
  const facts = (await loadReproFacts(admin as never, [row.order_id], {
    orders: [row as unknown as ReproOrderRow],
  })).get(row.order_id);
  const open = facts?.open && facts.open.episode_key === facts.episode.key ? facts.open : null;
  const chain = facts ? retryChainOf(facts, open, today) : null;
  const saved = modeRes.data as { mode?: string } | null;
  const mode = retryModes(saved?.mode ? [{ variant: c.variant, mode: saved.mode }] : [])[c.variant];
  const decision = retryRecheck({
    chain,
    raw: facts?.retryChain ?? null,
    variant: c.variant,
    mode,
    claimed: claimView(open?.claimed_by, open?.claimed_until, "", at) !== "libre",
  });
  if (decision.action !== "crear" || !facts || !chain || facts.retryChain.state !== "siguiente") {
    return decision.action === "crear" ? { action: "soltar", reason: "La cadena ya no sigue." } : decision;
  }
  // Apareció una creación sin guardar (una persona creándola, o una que
  // quedó sin respuesta): no se pide otra.
  const held = unsaved.get(row.order_id);
  if (held) return { action: "soltar", reason: retryHeldDetail(held) };
  return { action: "crear", candidate: { ...c, row, facts, chain, raw: facts.retryChain, mode, claimed: false, unsaved: null } };
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
    out.push({ row, facts: f, chain, raw, variant, mode, claimed, unsaved: null });
  }
  // Una guía que Aliclik ya creó y Kapta no guardó (o una creación sin
  // respuesta) no tiene salida, así que la cadena sigue pidiendo otra: se
  // marca para no cotizarla ni tomarla cada día.
  const unsaved = await unsavedIntentsOf(admin, out.map((c) => c.row.order_id));
  for (const c of out) c.unsaved = unsaved.get(c.row.order_id) ?? null;
  // El fallo más viejo primero: es el que más tiempo lleva esperando.
  return out.sort((a, b) => Date.parse(a.raw.failed.at) - Date.parse(b.raw.failed.at));
}

/**
 * La clave de Google para esta organización, o null (`retryGeocodeKey`,
 * lib/lima-retry-location.ts: la misma regla que «Aprobar»). Lo que no se pudo
 * leer no enciende nada y queda en los errores de la pasada.
 */
async function geocodeKeyFor(admin: SupabaseClient, orgId: string, errors: string[]): Promise<string | null> {
  const { key, error } = await retryGeocodeKey(admin, orgId);
  if (error) errors.push(`No se pudo leer la medición de Lima: la ubicación por dirección no se usa en esta pasada (${error}).`);
  return key;
}

/**
 * Una pasada. Sin `preview`, solo de 8:00 a 13:59 de Lima: simula las variantes
 * en simulación (deja el renglón en el log) y crea las activas, con tope y
 * candado. Con `preview`, «qué pasaría hoy si todo estuviera en simulación»:
 * cotiza todas las variantes, a cualquier hora, y no escribe nada del reintento
 * (ni log, ni hechos, ni Telegram). Es el «Simular ahora» del panel. Lo único
 * que puede guardar es la respuesta de Google en la caché `order_geocodes`, si
 * la ubicación por dirección está encendida: así la pasada real no la pide otra
 * vez. Con `noGeocode` (el `?dry=1` del cron) no se busca nada en Google: los
 * pedidos sin coordenada propia salen `sin_ubicacion`.
 */
export async function runLimaRetryAuto(
  admin: SupabaseClient,
  opts: { now?: Date; orgId?: string; preview?: boolean; noGeocode?: boolean } = {},
): Promise<LimaRetryAutoReport> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const preview = !!opts.preview;
  const budget = preview ? PREVIEW_TIME_BUDGET_MS : TIME_BUDGET_MS;
  // La hora de la pasada avanzada por lo que lleva corriendo: el candado de
  // una persona en Repro Lima se mira con la hora de ahora, no la del inicio.
  const nowish = () => new Date(now.getTime() + (Date.now() - started));
  const today = limaTodayKey(now);
  const limaHour = Number(limaTimeHHMM(now).slice(0, 2));
  const report: LimaRetryAutoReport = {
    today, limaHour, skipped: null, orgs: [], stopped: null, geocode: { lookups: 0, quotaHit: false }, chatbyAsk: { sent: 0, simulated: 0 }, error: null,
  };
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

  // `*`: sin la 0308, `geocode_enabled` no viene y se lee como apagado.
  const { data: settingsRows, error: settingsError } = await admin
    .from("lima_retry_auto_settings")
    .select("*")
    .in("org_id", orgModes.map((o) => o.orgId));
  if (settingsError) {
    report.error = `No se pudo leer el tope diario: ${settingsError.message}`;
    return report;
  }
  const settings = (settingsRows ?? []) as { org_id: string; daily_cap: number; geocode_enabled?: boolean; chatby_ask_mode?: string }[];
  const capByOrg = new Map(settings.map((s) => [s.org_id, clampCap(s.daily_cap)]));
  const geocodeOnByOrg = new Map(settings.map((s) => [s.org_id, s.geocode_enabled === true]));
  // `*`: sin la 0324, `chatby_ask_mode` no viene y es Apagado.
  const askModeByOrg = new Map<string, RetryAskMode>(settings.map((s) => [s.org_id, retryAskModeFrom(s.chatby_ask_mode)]));

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
  const runCore = async (c: Candidate, dry: boolean, coordinate: RetryCoordinate | null): Promise<RetryApproveResult> => {
    const scope = await scopeOf(c.row.store_id);
    if (typeof scope === "string") {
      return { outcome: "fallo", stage: "contexto", transport: RETRY_TRANSPORT_LABEL[c.chain.next], error: scope };
    }
    return approveLimaRetry({
      admin, row: c.row, chain: c.chain, raw: c.raw, actor: { system: true, variant: c.variant }, today, dry, scope,
      ...(coordinate ? { coordinate } : {}),
    });
  };

  // La ubicación por dirección (Google). Una búsqueda por pedido y pasada (y
  // una consulta a Google por pedido y dirección, por la caché de 0301). El
  // cupo es de la cuenta de Google, así que se corta para toda la pasada.
  //
  // El pin del pedido se usa tal cual SALVO que sea el punto de Google de ese
  // mismo pedido (`googlePinnedOrderIds`): una guía anterior de la cadena se
  // creó con la ubicación por dirección, la guía guardó el punto y el Master lo
  // tomó como pin. Ese punto lo puso Kapta, no la clienta, así que se trata
  // como lo que es —Google— y pasa por el interruptor, la medición (B), la nota
  // del log y el camino de `pinSinCorroborar` → `sin_ubicacion`.
  const located = new Map<string, RetryLocated>();
  // La ubicación que la clienta ya mandó por WhatsApp (08-11-2026): se lee su
  // conversación de Chatby, sin mandarle nada. Sin clave, se sigue con Google.
  const chatbyApiKey = opts.noGeocode ? "" : env.chatbyApiKey();
  const chatbyRead = chatbyApiKey ? { apiKey: chatbyApiKey } : null;
  const locate = async (c: Candidate, geocodeKey: string | null): Promise<RetryLocated> => {
    const seen = located.get(c.row.order_id);
    if (seen) return seen;
    // La misma regla que «Aprobar» (`locateRetryOrder`): el pin del pedido, el
    // que mandó por WhatsApp o el edificio en Google con el candado; el cupo se
    // corta para toda la pasada. El tope de tiempo de arriba también corta las
    // lecturas de Chatby (5 s como mucho cada una).
    const where = await locateRetryOrder(admin, c.row, geocodeKey, { quotaHit: report.geocode.quotaHit, chatby: chatbyRead });
    if (where.lookedUp) report.geocode.lookups += 1;
    if (where.quotaHit) report.geocode.quotaHit = true;
    // Un error o el cupo se vuelven a probar en la pasada siguiente, no en esta.
    located.set(c.row.order_id, where.located);
    return where.located;
  };

  // «Pedir la ubicación por WhatsApp» (0324, owner 08-11-2026): cuando el
  // reintento llega a «Sin ubicación», Kapta le pide su ubicación a la clienta
  // si escribió en las últimas 23 h (lib/lima-retry-chatby-ask.ts). Una vez por
  // episodio; en la vista previa y en Simulación solo dice «habría pedido…». No
  // con un error de la ubicación (no se sabe si falta) ni en el `?dry=1` del cron.
  const askFor = async (c: Candidate, orgId: string, miss: RetryGeocodeMiss): Promise<string | null> => {
    const mode = askModeByOrg.get(orgId) ?? "apagado";
    if (mode === "apagado" || miss === "error" || opts.noGeocode) return null;
    const result = await askRetryLocation(admin, {
      orgId,
      row: c.row,
      episodeAt: c.raw.failed.at,
      attempt: c.chain.attempt,
      of: c.chain.of,
      mode,
      apiKey: chatbyApiKey,
      dry: preview,
    });
    if (!result) return null;
    if (result.outcome === "pedida") report.chatbyAsk.sent += 1;
    if (result.outcome === "simulada") report.chatbyAsk.simulated += 1;
    return result.detail;
  };
  const withAsk = (detail: string, ask: string | null) => (ask ? `${detail} ${ask}` : detail);

  outer: for (const { orgId, modes } of orgModes) {
    const dailyCap = capByOrg.get(orgId) ?? RETRY_DAILY_CAP_DEFAULT;
    const org: LimaRetryAutoOrgReport = { orgId, dailyCap, capLeft: dailyCap, items: [], released: [], held: [] };
    report.orgs.push(org);
    try {
      const geocodeKey = !opts.noGeocode && geocodeOnByOrg.get(orgId) ? await geocodeKeyFor(admin, orgId, errors) : null;
      const { data: stores, error: storesError } = await admin
        .from("stores").select("id").eq("org_id", orgId).eq("status", "active");
      if (storesError) throw new Error(`No se pudieron leer las tiendas: ${storesError.message}`);
      const storeIds = ((stores ?? []) as { id: string }[]).map((s) => s.id);
      const candidates = storeIds.length ? await candidatesOf(admin, storeIds, modes, today, now, preview) : [];

      for (const c of candidates) {
        if (Date.now() - started > budget) {
          report.stopped = "tiempo";
          break outer;
        }
        const { row, chain, variant, mode } = c;
        const transport = RETRY_TRANSPORT_LABEL[chain.next];
        const item: LimaRetryAutoItem = {
          orderId: row.order_id, orderName: row.order_name, storeId: row.store_id,
          variant, mode, outcome: "atendiendo", transport,
        };

        // --- Vista previa: todo como simulación; solo la caché de Google. ---
        if (preview) {
          org.items.push(item);
          if (c.unsaved) {
            item.outcome = "incierto";
            item.detail = retryHeldDetail(c.unsaved);
            continue;
          }
          if (c.claimed) {
            item.detail = "Caso tomado en Repro Lima.";
            continue;
          }
          const where = await locate(c, geocodeKey);
          if ("miss" in where) {
            item.outcome = "sin_ubicacion";
            item.detail = withAsk(retryNoLocationDetail(where.miss), await askFor(c, orgId, where.miss));
            continue;
          }
          const result = await runCore(c, true, where.coordinate);
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
          if (c.unsaved) {
            // Simulación no cuenta para el tope: dice que es de una persona.
            item.outcome = "incierto";
            item.detail = retryHeldDetail(c.unsaved);
          } else if (c.claimed) {
            item.detail = "Caso tomado en Repro Lima.";
          } else {
            const where = await locate(c, geocodeKey);
            if ("miss" in where) {
              item.outcome = "sin_ubicacion";
              item.detail = withAsk(retryNoLocationDetail(where.miss), await askFor(c, orgId, where.miss));
            } else {
              const result = await runCore(c, true, where.coordinate);
              item.outcome = result.outcome;
              item.detail = retryResultDetail(result);
            }
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
        if (c.unsaved) {
          // No se toma ni cuenta para el tope: Aliclik ya tiene (o puede
          // tener) su guía. El aviso salió el día que pasó; aquí se informa.
          org.held.push({ orderId: row.order_id, orderName: row.order_name, detail: retryHeldDetail(c.unsaved) });
          continue;
        }
        const label = row.order_name ?? row.order_id;
        let claim: { id: number | string | null; error?: string };
        try {
          claim = await claimActive(admin, base);
        } catch (e) {
          claim = { id: null, error: e instanceof Error ? e.message : String(e) };
        }
        if (claim.error) {
          errors.push(`No se pudo tomar ${label}: ${claim.error}`);
          continue;
        }
        if (claim.id === null) continue; // Ya resuelto (o en curso) hoy.
        const claimId = claim.id;
        org.items.push(item);
        const finish = async () => {
          const { error } = await admin.from(LOG).update({
            outcome: item.outcome, transport: item.transport ?? null, guide_code: item.guide ?? null,
            detail: item.detail ?? null, updated_at: new Date().toISOString(),
          }).eq("id", claimId);
          if (error) errors.push(`No se pudo guardar el resultado de ${label}: ${error.message}`);
        };
        // Se suelta sin crear: el renglón se borra (o, si no se puede, queda
        // para reintentar sin contar) y la pasada sigue con el siguiente.
        const release = async (why: string) => {
          org.items.splice(org.items.indexOf(item), 1);
          const releaseError = await releaseClaim(admin, claimId, why);
          if (releaseError) errors.push(`No se pudo soltar ${label}: ${releaseError}`);
        };

        // De la toma a la creación, cualquier excepción suelta el candado:
        // nada se creó todavía, y un «en curso» olvidado contaría para el tope
        // todo el día y dejaría sin revisar al resto de la organización.
        let fresh: Candidate;
        let coordinate: RetryCoordinate | null;
        try {
          if (c.claimed) {
            item.outcome = "atendiendo";
            item.detail = "Caso tomado en Repro Lima.";
            await finish();
            continue;
          }
          const counted = await countedToday(admin, orgId, today, claimId);
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
          // Se relee el pedido y la variante justo antes de crear (ver arriba).
          const recheck = await recheckCandidate(admin, orgId, c, today, nowish());
          if (recheck.action === "atendiendo") {
            item.outcome = "atendiendo";
            item.detail = "Caso tomado en Repro Lima.";
            await finish();
            continue;
          }
          if (recheck.action === "soltar") {
            org.released.push({ orderId: row.order_id, orderName: row.order_name, reason: recheck.reason });
            await release(recheck.reason);
            continue;
          }
          fresh = recheck.candidate;
          // La ubicación, con la fila de ahora. Sin ella no se cotiza: queda
          // `sin_ubicacion` (se reintenta y no cuenta), sin aviso ni hecho.
          const where = await locate(fresh, geocodeKey);
          if ("miss" in where) {
            item.outcome = "sin_ubicacion";
            item.detail = withAsk(retryNoLocationDetail(where.miss), await askFor(fresh, orgId, where.miss));
            await finish();
            continue;
          }
          coordinate = where.coordinate;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await release(message);
          errors.push(`No se pudo preparar ${label}: ${message}`);
          continue;
        }

        let attempted: RetryApproveResult;
        try {
          attempted = await runCore(fresh, false, coordinate);
        } catch (e) {
          // Pudo haber pasado el POST: no se suelta. Queda en duda (cuenta
          // para el tope y no se repite hoy) y avisa como «revisar».
          const message = `Error inesperado al crear: ${e instanceof Error ? e.message : String(e)}`;
          item.outcome = "incierto";
          item.detail = message;
          try {
            await finish();
            await recordFailure(admin, fresh.row, today, variant, "incierto", message);
          } catch (inner) {
            errors.push(`${label}: ${inner instanceof Error ? inner.message : String(inner)}`);
          }
          continue;
        }

        const result = attempted;
        try {
          item.outcome = result.outcome;
          item.detail = retryResultDetail(result);
          if (result.outcome === "creada") item.guide = result.guide;
          // El candado lo tiene otra creación (una persona creándola ahora, o una
          // sin respuesta): no es de esta pasada. `atendiendo` se reintenta y no
          // cuenta para el tope; «en curso» quedaba así todo el día.
          if (result.outcome === "en_curso") item.outcome = "atendiendo";
          // Aliclik la creó y Kapta no pudo guardarla: el código queda en el log.
          if (result.outcome === "incierto" && result.stage === "creacion" && result.guide) item.guide = result.guide;

          // Una regla de Kapta: mañana diría lo mismo. PRIMERO sale de la
          // cadena (`lima_retry_dismissed`); solo si quedó escrito, el log, el
          // aviso y el hecho dicen «pasó a Repro Lima».
          const kaptaBlock = result.outcome === "fallo" && result.stage === "creacion" && result.kaptaBlock;
          let dismissError: string | null = null;
          if (kaptaBlock) {
            try {
              dismissError = await dismissForKaptaBlock(admin, fresh, result.error);
            } catch (e) {
              dismissError = e instanceof Error ? e.message : String(e);
            }
            if (dismissError) errors.push(`No se pudo pasar ${label} a Repro Lima: ${dismissError}`);
          }
          const dismissed = kaptaBlock && !dismissError;
          if (dismissed) item.detail = `${item.detail ?? ""} Pasó a Repro Lima.`.trim();
          else if (kaptaBlock) item.detail = `${item.detail ?? ""} No se pudo pasar a Repro Lima: ${dismissError}.`.trim();
          await finish();
          // `createAliclikGuideFor` ya recalcula el Master al crear; no se repite.
          if (result.outcome === "fallo" || result.outcome === "incierto") {
            const guide = result.stage === "creacion" ? result.guide ?? null : null;
            const error = kaptaBlock && !dismissed ? `${result.error} (No se pudo pasar a Repro Lima: ${dismissError}.)` : result.error;
            await recordFailure(admin, fresh.row, today, variant, result.outcome, error, { guide, kaptaBlock: dismissed });
          }
        } catch (e) {
          errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
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
