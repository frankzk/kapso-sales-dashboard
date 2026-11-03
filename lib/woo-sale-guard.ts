// El candado de «Generar pedido» en WooCommerce (MOM §38.12, «Un doble clic o
// un reintento no crea dos pedidos», 25-10-2026).
//
// POR QUÉ. El formulario de la asesora («Generar pedido», y «Venta telefónica»,
// que abre el mismo) manda un id por intento (`requestId`), que viaja como
// `kapta_request_id`, y `createWooSaleOrder` busca el pedido de ese intento
// antes de crear otro. Esa búsqueda no alcanza en dos casos:
//
//   · un POST sin respuesta: WordPress puede guardar el pedido DESPUÉS de la
//     búsqueda que sigue al corte (`postUnanswered`). Si la asesora reintenta
//     enseguida, su búsqueda tampoco lo ve y se crea otro: un `pending` de más
//     o, con un plugin que lo deja vivo al crearlo, dos pedidos vivos;
//   · dos llamadas a la vez con el mismo id (la primera sigue corriendo en el
//     servidor cuando la pantalla ya mostró un error de red y la asesora vuelve
//     a pulsar): las dos buscan antes de que cualquiera cree.
//
// El bot ya lo resuelve con un candado en la base (§38.13, `bot_order_requests`,
// 0277). Aquí se usa EL MISMO: la misma tabla, el mismo `unique (store_id,
// request_id)`, el mismo `claim_token` para retomar, el mismo `woo_order_id`
// para leer el pedido de un intento por su id y los mismos plazos
// (`BOT_ORDER_CLAIM_TTL_MS`, `BOT_ORDER_RETAKE_MAX_AGE_MS`). Las filas del
// formulario van con la llave `form-<requestId>` (`WOO_FORM_GUARD_PREFIX`): no
// se cruzan con las del bot, y el tope por minuto del bot no las cuenta. Sin
// migración nueva: la 0277 ya está en la base.
//
// LO QUE CAMBIA RESPECTO DEL BOT. La asesora puede corregir el formulario entre
// un intento y otro (otra cantidad después de un rechazo de precio): el mismo id
// con otra huella NO es un conflicto aquí; lo decide `createWooSaleOrder` como
// siempre (el pedido anterior vivo con otros datos es `conflict`; uno pendiente
// se borra). Tampoco hay «el mismo pedido con otro id» ni tope por minuto: un
// formulario nuevo es otro intento y ahí manda el aviso de duplicado. Y un
// intento ya terminado (`done`) no se devuelve desde la base: se retoma y
// `createWooSaleOrder` lee su pedido por `woo_order_id` y lo adopta, para que
// `generateWooOrder` registre la venta si faltaba. Por eso el candado se
// cierra recién con la venta registrada (`order_sales` y la nota «sale»): hasta
// ahí sigue `processing` y otro clic recibe `busy` en vez de registrarla dos
// veces.
//
// Nunca datos de la clienta en el registro: la tienda, el comienzo del sha256 de
// la llave y lo que pasó.

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BOT_ORDER_CLAIM_TTL_MS,
  BOT_ORDER_DB_TIMEOUT_MS,
  BOT_ORDER_RETAKE_MAX_AGE_MS,
  WOO_FORM_GUARD_PREFIX,
  isBotOrdersMigrationMissing,
} from "@/lib/bot-orders";

export { WOO_FORM_GUARD_PREFIX };

/** La llave de la fila: `form-<requestId>`, o con el sha256 si no cabe en los 64 de la 0277. */
export function wooFormGuardKey(requestId: string): string {
  const plain = `${WOO_FORM_GUARD_PREFIX}${requestId}`;
  if (/^[A-Za-z0-9_-]{8,64}$/.test(plain)) return plain;
  return `${WOO_FORM_GUARD_PREFIX}${createHash("sha256").update(requestId).digest("hex").slice(0, 59)}`;
}

export interface WooFormClaim {
  id: string;
  token: string;
  attempts: number;
  /** El pedido de WooCommerce que ya creó un intento anterior de este id. */
  wooOrderId: number | null;
}

export type WooFormClaimResult =
  /** Esta llamada tiene el candado: puede llamar a WooCommerce. */
  | { kind: "claim"; claim: WooFormClaim }
  /** Otra llamada con el mismo id lo tiene (o un POST sin respuesta espera a WordPress): no se llama a WooCommerce. */
  | { kind: "busy"; retryAfterSeconds: number; message: string }
  /** Un intento viejo que no terminó y no sabe qué pedido creó: no se arriesga otro. */
  | { kind: "expired"; message: string }
  /** Sin la 0277 (una base de pruebas): como antes, solo con la búsqueda por `kapta_request_id`. */
  | { kind: "unguarded" }
  /** La base no contestó o falló: no se crea nada. */
  | { kind: "error"; message: string };

interface GuardRow {
  id: string;
  status: "processing" | "done" | "failed";
  claim_token: string;
  claimed_at: string;
  created_at: string | null;
  attempts: number | null;
  woo_order_id: number | string | null;
}

const COLUMNS = "id,status,claim_token,claimed_at,created_at,attempts,woo_order_id";

class StepTimeout extends Error {}
class MigrationMissing extends Error {}

function withTimeout<T>(work: PromiseLike<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(work),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StepTimeout(`${step}: sin respuesta en ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function wooIdOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function logKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export type WooFormGuardLog = (event: string, data: Record<string, unknown>) => void;

const defaultLog: WooFormGuardLog = (event, data) => {
  const line = `[woo-form-guard] ${JSON.stringify({ event, ...data })}`;
  if (event.endsWith("_failed") || event === "unguarded") console.error(line);
  else console.info(line);
};

/** Segundos que le faltan a un candado vivo (al menos 1). */
export function wooFormRetryAfter(claimedAtMs: number, nowMs: number): number {
  if (!Number.isFinite(claimedAtMs)) return Math.ceil(BOT_ORDER_CLAIM_TTL_MS / 1000);
  return Math.max(1, Math.ceil((claimedAtMs + BOT_ORDER_CLAIM_TTL_MS - nowMs) / 1000));
}

/** El texto para la asesora cuando otra llamada con el mismo intento tiene el candado. */
export function wooFormBusyText(seconds: number): string {
  const espera = seconds > 60 ? `unos ${Math.ceil(seconds / 60)} minutos` : `${seconds} s`;
  return (
    `Pedido NO generado todavía: este mismo pedido ya se está generando (otro clic, o un intento anterior que espera la respuesta de WooCommerce). ` +
    `No cierres este formulario: espera ${espera} y vuelve a pulsar «Generar pedido». Kapta retoma ese mismo intento y no crea otro pedido.`
  );
}

export const WOO_FORM_EXPIRED_TEXT =
  `Pedido NO generado: este formulario empezó a generar el pedido hace más de ${Math.round(BOT_ORDER_RETAKE_MAX_AGE_MS / 60_000)} minutos y no terminó, ` +
  "así que Kapta ya no puede asegurar que no haya quedado un pedido suyo en WooCommerce y no crea otro. " +
  "Revisa en WooCommerce si esta clienta ya tiene el pedido; si no lo tiene, cierra este formulario y vuelve a abrirlo para generarlo.";

export const WOO_FORM_DB_ERROR_TEXT =
  "Pedido NO generado: no se pudo reservar este pedido en Kapta (la base no contestó). No se llamó a WooCommerce ni se creó nada: vuelve a pulsar «Generar pedido» en unos segundos.";

/** Lo que se le dice a la asesora cuando el POST no contestó (`postUnanswered`): esperar al candado. */
export function wooFormPostUnansweredText(message: string): string {
  const minutos = Math.ceil(BOT_ORDER_CLAIM_TTL_MS / 60_000);
  return (
    `${message} WooCommerce pudo haber creado el pedido igual y guardarlo en unos segundos. ` +
    `No cierres este formulario: espera ${minutos} minutos y vuelve a pulsar «Generar pedido». Kapta lo busca y, si se creó, lo retoma en vez de crear otro.`
  );
}

/**
 * Toma el candado del intento `requestId` de la tienda, o dice por qué no:
 *   · no hay fila: se inserta (`processing`, con un token nuevo). Si otra llamada
 *     la insertó en el mismo instante (23505), se lee la suya;
 *   · `processing` dentro de su plazo (`BOT_ORDER_CLAIM_TTL_MS`): `busy`, con lo
 *     que le falta;
 *   · `failed`, `done` o `processing` vencido: se retoma, solo si el
 *     `claim_token` sigue siendo el que se leyó (de dos que lo intentan, uno
 *     gana; el otro, `busy`); salvo un intento sin `woo_order_id` empezado hace
 *     más de `BOT_ORDER_RETAKE_MAX_AGE_MS`: `expired`, como en el bot;
 *   · sin la 0277: `unguarded` (como antes); otro fallo o una base que no
 *     contesta: `error`, sin llamar a WooCommerce.
 * La huella (`body_hash`) se guarda en cada intento: la del formulario de ahora.
 */
export async function claimWooFormSale(args: {
  admin: SupabaseClient;
  storeId: string;
  requestId: string;
  bodyHash: string;
  now?: () => number;
  dbTimeoutMs?: number;
  log?: WooFormGuardLog;
}): Promise<WooFormClaimResult> {
  const { admin, storeId, bodyHash } = args;
  const now = args.now ?? Date.now;
  const ms = args.dbTimeoutMs ?? BOT_ORDER_DB_TIMEOUT_MS;
  const log = args.log ?? defaultLog;
  const key = wooFormGuardKey(args.requestId);
  const ctx = { store: storeId, key: logKey(key) };
  const step = <T>(label: string, work: PromiseLike<T>) => withTimeout(work, ms, label);
  const check = (error: { message?: string; code?: string } | null | undefined, label: string) => {
    if (!error) return;
    if (isBotOrdersMigrationMissing(error)) throw new MigrationMissing();
    throw new Error(`${label}: ${error.message ?? "error"}`);
  };

  const read = async (): Promise<GuardRow | null> => {
    const { data, error } = await step(
      "guard_read",
      admin.from("bot_order_requests").select(COLUMNS).eq("store_id", storeId).eq("request_id", key).maybeSingle(),
    );
    check(error, "guard_read");
    return (data as GuardRow | null) ?? null;
  };

  const decide = async (row: GuardRow): Promise<WooFormClaimResult> => {
    const t = now();
    const claimedAt = Date.parse(row.claimed_at);
    if (row.status === "processing" && Number.isFinite(claimedAt) && t - claimedAt < BOT_ORDER_CLAIM_TTL_MS) {
      const seconds = wooFormRetryAfter(claimedAt, t);
      log("busy", { ...ctx, seconds });
      return { kind: "busy", retryAfterSeconds: seconds, message: wooFormBusyText(seconds) };
    }
    const wooOrderId = wooIdOrNull(row.woo_order_id);
    const createdAt = Date.parse(row.created_at ?? row.claimed_at);
    if (wooOrderId == null && Number.isFinite(createdAt) && t - createdAt > BOT_ORDER_RETAKE_MAX_AGE_MS) {
      log("expired", ctx);
      return { kind: "expired", message: WOO_FORM_EXPIRED_TEXT };
    }
    const token = randomUUID();
    const attempts = (row.attempts ?? 1) + 1;
    const { data, error } = await step(
      "guard_retake",
      admin
        .from("bot_order_requests")
        .update({
          status: "processing",
          body_hash: bodyHash,
          claim_token: token,
          claimed_at: new Date(t).toISOString(),
          attempts,
          error_code: null,
          finished_at: null,
        })
        .eq("id", row.id)
        .eq("claim_token", row.claim_token)
        .select("id"),
    );
    check(error, "guard_retake");
    if (!Array.isArray(data) || data.length !== 1) {
      const seconds = wooFormRetryAfter(t, t);
      log("busy", { ...ctx, seconds, lost_retake: true });
      return { kind: "busy", retryAfterSeconds: seconds, message: wooFormBusyText(seconds) };
    }
    log("retaken", { ...ctx, attempts, woo: wooOrderId });
    return { kind: "claim", claim: { id: row.id, token, attempts, wooOrderId } };
  };

  try {
    const existing = await read();
    if (existing) return await decide(existing);
    const id = randomUUID();
    const token = randomUUID();
    const at = new Date(now()).toISOString();
    const ins = await step(
      "guard_insert",
      admin.from("bot_order_requests").insert({
        id,
        store_id: storeId,
        request_id: key,
        body_hash: bodyHash,
        status: "processing",
        claim_token: token,
        claimed_at: at,
        attempts: 1,
        created_at: at,
      }),
    );
    if (ins.error) {
      if ((ins.error as { code?: string }).code === "23505") {
        // Otra llamada con el mismo intento llegó primero: su fila manda.
        const theirs = await read();
        if (theirs) return await decide(theirs);
      }
      check(ins.error, "guard_insert");
    }
    return { kind: "claim", claim: { id, token, attempts: 1, wooOrderId: null } };
  } catch (e) {
    if (e instanceof MigrationMissing) {
      log("unguarded", ctx);
      return { kind: "unguarded" };
    }
    log("claim_failed", { ...ctx, error: e instanceof StepTimeout ? "timeout" : "db" });
    return { kind: "error", message: WOO_FORM_DB_ERROR_TEXT };
  }
}

/** Una escritura del candado, solo de quien lo tiene, con tope. Lanza si falla. */
async function writeClaim(
  admin: SupabaseClient,
  claim: Pick<WooFormClaim, "id" | "token">,
  patch: Record<string, unknown>,
  label: string,
  ms: number,
): Promise<void> {
  const { error } = await withTimeout(
    admin.from("bot_order_requests").update(patch).eq("id", claim.id).eq("claim_token", claim.token),
    ms,
    label,
  );
  if (error) throw new Error(`${label}: ${error.message ?? "error"}`);
}

/** Apenas existe el pedido (`onCreated`): su id en el candado, para leerlo por su id al retomar. */
export function noteWooFormOrder(admin: SupabaseClient, claim: WooFormClaim, wooId: number, ms = BOT_ORDER_DB_TIMEOUT_MS): Promise<void> {
  return writeClaim(admin, claim, { woo_order_id: wooId }, "guard_woo_id", ms);
}

/**
 * El POST no contestó y el pedido no apareció: el candado NO se suelta, se
 * vuelve a armar desde ahora. Los reintentos reciben `busy` hasta el plazo, y el
 * que llega después encuentra el pedido tardío y lo retoma o lo adopta.
 */
export function rearmWooFormClaim(admin: SupabaseClient, claim: WooFormClaim, now: () => number = Date.now, ms = BOT_ORDER_DB_TIMEOUT_MS): Promise<void> {
  return writeClaim(admin, claim, { claimed_at: new Date(now()).toISOString(), error_code: "woocommerce_unavailable" }, "guard_rearm", ms);
}

/**
 * El pedido está vivo y su venta ya quedó registrada (o la llamada termina por
 * otro camino): el candado se cierra con él (`done`). No antes: un `done` se
 * retoma enseguida, y un clic que lo retomara antes de `order_sales` adoptaría
 * el pedido sin ver la venta y la registraría otra vez.
 */
export function finishWooFormClaim(
  admin: SupabaseClient,
  claim: WooFormClaim,
  order: { wooOrderId: number | null; orderId: string; orderName: string; total: number | null; currency: string | null },
  now: () => number = Date.now,
  ms = BOT_ORDER_DB_TIMEOUT_MS,
): Promise<void> {
  return writeClaim(
    admin,
    claim,
    {
      status: "done",
      ...(order.wooOrderId ? { woo_order_id: order.wooOrderId } : {}),
      order_id: order.orderId,
      order_name: order.orderName,
      order_total: order.total,
      currency: order.currency,
      error_code: null,
      finished_at: new Date(now()).toISOString(),
    },
    "guard_done",
    ms,
  );
}

/** No hay pedido vivo de este intento (o quedó a medias con respuesta): `failed`, y el reintento lo retoma enseguida. */
export function releaseWooFormClaim(
  admin: SupabaseClient,
  claim: WooFormClaim,
  code: string,
  now: () => number = Date.now,
  ms = BOT_ORDER_DB_TIMEOUT_MS,
): Promise<void> {
  const errorCode = /^[a-z_]{2,40}$/.test(code) ? code : "error";
  return writeClaim(admin, claim, { status: "failed", error_code: errorCode, finished_at: new Date(now()).toISOString() }, "guard_release", ms);
}
