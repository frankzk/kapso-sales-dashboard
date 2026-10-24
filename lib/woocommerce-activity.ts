// La anulación y la reactivación de un pedido de WooCommerce en la Actividad de
// la ficha (MOM §38.3 y §25; prueba del owner del 24-10-2026: #AUR900004 se
// anuló en wp-admin, el Master lo dio por «Anulado y cerrado» y su Actividad no
// decía nada).
//
// QUÉ SE REGISTRA. Un hecho en `order_events` la PRIMERA vez que la entrada
// (webhook o pasada `woo_orders`, la que lo aplique antes) ve el pedido pasar
// de vivo a anulado —`cancelled_at` estaba vacío y queda puesto, el mismo
// momento que conserva `previousCancelledAt`— y otro cuando un anulado vuelve
// a estar vivo (no a `refunded`: el reembolso no reactiva). Con la hora en que
// WooCommerce lo cambió (`date_modified_gmt`) y, si se puede, QUIÉN: la nota de
// cambio de estado que WooCommerce escribe en el pedido («Estado del pedido
// cambiado de Procesando a Cancelado.»). Sin una nota que lo diga, sin autor:
// no se adivina.
//
// QUIÉN NO ES UN USUARIO DE KAPTA. Es el nombre visible de un usuario de
// WordPress: va como texto en la nota del hecho («por María Torres») y en
// `payload`, nunca en `order_events.actor` (que apunta a `auth.users`). El
// texto de la nota de WooCommerce NO se guarda (solo su id y su hora): puede
// llevar datos de la clienta y `order_events` no se borra ni se edita (0045).
//
// UNA VEZ POR CAMBIO. El webhook y la pasada pueden ver el mismo cambio, y un
// webhook puede repetirse. Solo hay hecho cuando lo guardado ANTES no estaba
// anulado y lo nuevo sí (o al revés); un cambio posterior de un pedido que ya
// estaba anulado no es un cambio. Y si dos escrituras leyeron a la vez el mismo
// estado guardado, las dos calculan la misma clave (`operation_id`, derivada
// del estado del que se sale) y el índice único de la 0122
// (`order_events_operation_kind_uniq`) deja entrar solo una. Además, si el
// último hecho de WooCommerce del pedido ya es del mismo tipo, no se repite:
// una pasada que pisó la anulación con una versión anterior del pedido (la
// carrera de siempre entre la pasada y el webhook) la vuelve a ver desde otro
// estado guardado, con otra clave, y no es otra anulación.
//
// NUNCA FRENA LA ENTRADA. La lectura de notas corta a los
// `WOO_NOTES_TIMEOUT_MS`; si falla, el hecho queda sin autor (y
// `payload.woo_notes_error` dice por qué). Sin claves de la API o pasado el
// tope de lecturas no se leen: sin autor, sin ese campo. Nada de aquí lanza: un
// fallo queda en el registro del servidor y el pedido entra igual.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderRow } from "@/lib/types";
import {
  fetchWooOrderNotes,
  wooGmt,
  type WooClientOpts,
  type WooOrderNote,
} from "@/lib/woocommerce";
import { withWooAuthFallback } from "@/lib/woocommerce-intake";

/** Los dos cambios que dejan hecho. */
export type WooStatusTransition = "cancelled" | "reactivated";

/** `order_events.kind` de cada cambio. Texto libre en la base (0045 no tiene CHECK de `kind`). */
export const WOO_EVENT_KIND: Readonly<Record<WooStatusTransition, string>> = Object.freeze({
  cancelled: "cancelled_woocommerce",
  reactivated: "reactivated_woocommerce",
});

/** `order_events.source` de estos hechos. */
export const WOO_EVENT_SOURCE = "woocommerce";

/** Notas que se buscan alrededor del cambio: hasta 10 minutos antes y 2 después de `date_modified_gmt`. */
export const WOO_NOTE_WINDOW_BEFORE_MS = 10 * 60_000;
export const WOO_NOTE_WINDOW_AFTER_MS = 2 * 60_000;

/**
 * Cuántas notas se leen como mucho en una sola llamada (una página de la pasada
 * con muchos anulados, un cambio masivo en wp-admin): en paralelo, cada una con
 * su tiempo límite corto. Los demás cambios quedan registrados sin autor.
 */
export const WOO_NOTES_MAX_LOOKUPS = 10;

/** Lo que `orders` tenía antes de este cambio (null: Kapta no tenía el pedido). */
export interface WooStoredState {
  cancelled_at: string | null;
  updated_at: string | null;
}

/** El estado de WooCommerce en minúsculas y sin `wc-` («wc-cancelled» → «cancelled»), o null. */
function normWooStatus(status: string | null | undefined): string | null {
  return (status ?? "").trim().toLowerCase().replace(/^wc-/, "") || null;
}

/**
 * ¿Este cambio anula o reactiva el pedido en Kapta? Compara lo guardado con lo
 * que se va a guardar. Un pedido que Kapta no tenía y que entra ya anulado
 * (llegó a «processing» y se anuló antes de que Kapta lo viera) también es
 * su anulación.
 *
 * Un anulado que pasa a `refunded` (el reembolso completo de un pedido pagado
 * y anulado) deja de tener `cancelled_at` (`mapWooOrder`: `refunded` no anula),
 * pero WooCommerce no lo reactivó: no es una reactivación y no deja hecho
 * (`wooStatus`, el estado de WooCommerce que trae el cambio).
 */
export function wooStatusTransition(
  before: Pick<WooStoredState, "cancelled_at"> | null | undefined,
  after: Pick<OrderRow, "cancelled_at">,
  wooStatus?: string | null,
): WooStatusTransition | null {
  const was = Boolean(before?.cancelled_at);
  const is = Boolean(after.cancelled_at);
  if (!was && is) return "cancelled";
  if (was && !is) return normWooStatus(wooStatus) === "refunded" ? null : "reactivated";
  return null;
}

function isoOr(value: string | null | undefined, fallback: string): string {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

/**
 * La clave del cambio (`order_events.operation_id`): un uuid derivado de la
 * tienda, el pedido, el cambio y el estado guardado DEL QUE SE SALE. Dos
 * escrituras que leyeron el mismo estado (el webhook y la pasada a la vez)
 * dan la misma clave aunque cada una haya visto otra versión del pedido; un
 * cambio siguiente sale de otro estado y tiene otra.
 */
export function wooTransitionOperationId(
  storeId: string,
  shopifyOrderId: string,
  transition: WooStatusTransition,
  before: WooStoredState | null | undefined,
): string {
  const from = before ? `${isoOr(before.updated_at, "")}|${isoOr(before.cancelled_at, "")}` : "nuevo";
  const hex = createHash("sha256")
    .update(`woo-transition|${storeId}|${shopifyOrderId}|${transition}|${from}`, "utf8")
    .digest("hex");
  // Con forma de uuid (versión 5, variante RFC 4122): la columna es `uuid`.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// La nota de WooCommerce: cuál es y quién la escribió
// ---------------------------------------------------------------------------

function plain(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Un estado que es anulado: «Cancelado», «Cancelled», «Anulado», «Papelera», `trash`. */
const CANCELLED_LABEL_RE = /cancel|anulad|papelera|trash/i;
/** La papelera: «Papelera», `trash`. */
const TRASH_LABEL_RE = /papelera|trash/i;
/** Lo que nombra una anulación en una nota que no es de cambio de estado. */
const MENTIONS_CANCEL_RE = /cancel|anulad/i;

// «Order status changed from Processing to Cancelled.» y las traducciones al
// español («Estado del pedido cambiado de Procesando a Cancelado.», «El estado
// del pedido cambió de … a …»). Va también detrás de un prefijo: «Pedido no
// pagado cancelado - se alcanzó el límite de tiempo. Estado del pedido …» o
// «… por edición masiva: Estado del pedido cambiado de … a …».
const TRANSITION_EN_RE = /\bstatus\b[^.]*?\bfrom\s+([^.]+?)\s+to\s+([^.]+?)\s*(?:\.|$)/i;
const TRANSITION_ES_RE = /\bestado\b[^.]*?\bde\s+([^.]+?)\s+a\s+([^.]+?)\s*(?:\.|$)/i;

/** El cambio de estado que dice una nota («de X a Y»), o null si no es una nota de cambio de estado. */
export function wooNoteTransition(note: unknown): { from: string; to: string } | null {
  const textNote = plain(note);
  if (!textNote) return null;
  const m = TRANSITION_ES_RE.exec(textNote) ?? TRANSITION_EN_RE.exec(textNote);
  if (!m) return null;
  return { from: m[1]!.trim(), to: m[2]!.trim() };
}

function noteTime(note: WooOrderNote): number {
  return Date.parse(wooGmt(note.date_created_gmt) ?? "");
}

/**
 * La nota de WooCommerce que corresponde al cambio, o null. Entre las notas
 * internas (no las de la clienta) escritas entre 10 minutos antes y 2 después
 * de `changedAt` (la fecha de modificación del pedido que trae el cambio), la
 * más nueva que diga el cambio: «… a Cancelado» para la anulación («… a
 * Papelera» si fue a la papelera), «de Cancelado a …» para la reactivación.
 * Para la anulación (no la papelera), si ninguna lo dice con esas palabras, la
 * más nueva que la nombre sin ser otro cambio de estado y que haya escrito
 * WooCommerce solo (un plugin con su propio texto). La nota de una persona que
 * no es un cambio de estado (un comentario del equipo) no dice quién anuló:
 * nunca cuenta. Tampoco para la papelera: WooCommerce no escribe nota al
 * mandar un pedido allí. Una reactivación nunca toma una nota de anulación, ni
 * al revés.
 */
export function pickWooStatusNote(
  notes: readonly WooOrderNote[],
  transition: WooStatusTransition,
  changedAt: string | null | undefined,
  status?: string | null,
): WooOrderNote | null {
  const at = Date.parse(changedAt ?? "");
  if (!Number.isFinite(at)) return null;
  const candidates = notes
    .filter((n) => n && typeof n === "object" && n.customer_note !== true)
    .filter((n) => {
      const t = noteTime(n);
      return Number.isFinite(t) && t >= at - WOO_NOTE_WINDOW_BEFORE_MS && t <= at + WOO_NOTE_WINDOW_AFTER_MS;
    })
    .sort((a, b) => noteTime(b) - noteTime(a) || Number(b.id ?? 0) - Number(a.id ?? 0));

  const trash = transition === "cancelled" && normWooStatus(status) === "trash";
  const said = candidates.find((n) => {
    const t = wooNoteTransition(n.note);
    if (!t) return false;
    if (transition === "reactivated") return CANCELLED_LABEL_RE.test(t.from) && !CANCELLED_LABEL_RE.test(t.to);
    return (trash ? TRASH_LABEL_RE : CANCELLED_LABEL_RE).test(t.to);
  });
  if (said) return said;
  if (transition !== "cancelled" || trash) return null;
  return (
    candidates.find(
      (n) => !wooNoteTransition(n.note) && MENTIONS_CANCEL_RE.test(plain(n.note)) && wooNoteActor(n)?.by === "system",
    ) ?? null
  );
}

/** Quién hizo el cambio: un usuario de WordPress (su nombre visible) o WooCommerce solo. */
export type WooStatusActor = { by: "user"; name: string } | { by: "system" };

const SYSTEM_AUTHOR_RE = /^(system|sistema|woocommerce)$/i;

/**
 * El autor de la nota. `added_by_user` verdadero → el usuario (`author`);
 * falso → WooCommerce solo. Sin `added_by_user` (no todas las versiones lo
 * devuelven), lo dice el autor: `system`/`WooCommerce` es WooCommerce solo.
 */
export function wooNoteActor(note: WooOrderNote | null | undefined): WooStatusActor | null {
  if (!note) return null;
  const author = plain(note.author).slice(0, 120);
  const system = !author || SYSTEM_AUTHOR_RE.test(author);
  if (note.added_by_user === true) return author ? { by: "user", name: author } : null;
  if (note.added_by_user === false) return { by: "system" };
  return system ? { by: "system" } : { by: "user", name: author };
}

/**
 * El detalle del hecho en la Actividad: «por <nombre>», «WooCommerce
 * (automático)» o nada si no se supo; «enviado a la papelera» si fue eso.
 */
export function wooTransitionDetail(actor: WooStatusActor | null, opts: { trash?: boolean } = {}): string | null {
  const who = !actor ? null : actor.by === "user" ? `por ${actor.name}` : "WooCommerce (automático)";
  if (!opts.trash) return who;
  return who ? `${who} · enviado a la papelera` : "Enviado a la papelera";
}

// ---------------------------------------------------------------------------
// El hecho
// ---------------------------------------------------------------------------

/** Un cambio por registrar. */
export interface WooTransitionItem {
  /** `orders.shopify_order_id` (`wc-<clave>-<id>`). */
  shopifyOrderId: string;
  /** El id de WooCommerce, para leer sus notas. */
  wooId: number | string | null;
  transition: WooStatusTransition;
  /** Lo guardado antes del cambio (null si Kapta no tenía el pedido). */
  before: WooStoredState | null;
  /** Cuándo lo cambió WooCommerce (`date_modified_gmt`; en la anulación, el `cancelled_at` que queda). */
  changedAt: string | null;
  /** El estado de WooCommerce que trae el cambio (`cancelled`, `trash`, `processing`…). */
  status: string | null;
}

interface ActorLookup {
  actor: WooStatusActor | null;
  note: WooOrderNote | null;
  error: string | null;
}

async function lookupActor(client: WooClientOpts, item: WooTransitionItem): Promise<ActorLookup> {
  if (item.wooId == null) return { actor: null, note: null, error: null };
  try {
    const { value: notes } = await withWooAuthFallback(client, (o) => fetchWooOrderNotes(o, item.wooId!));
    const note = pickWooStatusNote(notes, item.transition, item.changedAt, item.status);
    return { actor: wooNoteActor(note), note, error: null };
  } catch (e) {
    return { actor: null, note: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

/** La fila de `order_events` del cambio. Pura. */
export function wooTransitionEvent(
  storeId: string,
  orderId: string,
  item: WooTransitionItem,
  lookup: ActorLookup,
  nowIso: string,
): Record<string, unknown> {
  const status = normWooStatus(item.status);
  const trash = item.transition === "cancelled" && status === "trash";
  return {
    store_id: storeId,
    order_id: orderId,
    kind: WOO_EVENT_KIND[item.transition],
    occurred_at: isoOr(item.changedAt, nowIso),
    // No es un usuario de Kapta: el nombre va en la nota y en `payload`.
    actor: null,
    source: WOO_EVENT_SOURCE,
    note: wooTransitionDetail(lookup.actor, { trash }),
    operation_id: wooTransitionOperationId(storeId, item.shopifyOrderId, item.transition, item.before),
    payload: {
      woo_order_id: item.wooId == null ? null : String(item.wooId),
      woo_status: status,
      woo_by: lookup.actor?.by ?? null,
      woo_author: lookup.actor?.by === "user" ? lookup.actor.name : null,
      // Qué nota fue, no lo que dice: su texto puede llevar datos de la
      // clienta y `order_events` no se borra (0045).
      woo_note_id: lookup.note?.id ?? null,
      woo_note_at: lookup.note ? wooGmt(lookup.note.date_created_gmt) : null,
      ...(lookup.error ? { woo_notes_error: lookup.error } : {}),
    },
  };
}

/** Un hecho de WooCommerce ya guardado, lo justo para saber cuál es el último de cada pedido. */
export interface WooTransitionFactRow {
  order_id: string;
  kind: string;
  occurred_at: string | null;
  created_at?: string | null;
}

/**
 * El tipo del último hecho de WooCommerce (`cancelled_woocommerce` o
 * `reactivated_woocommerce`) de cada pedido: el de `occurred_at` más nuevo (y,
 * a igual hora, el que entró después). Pura.
 */
export function latestWooTransitionKinds(rows: readonly WooTransitionFactRow[]): Map<string, string> {
  const best = new Map<string, { kind: string; at: number; created: number }>();
  for (const r of rows) {
    if (!r?.order_id || !r.kind) continue;
    const at = Date.parse(r.occurred_at ?? "");
    const created = Date.parse(r.created_at ?? "");
    const cur = { kind: r.kind, at: Number.isFinite(at) ? at : -Infinity, created: Number.isFinite(created) ? created : -Infinity };
    const prev = best.get(r.order_id);
    if (!prev || cur.at > prev.at || (cur.at === prev.at && cur.created >= prev.created)) best.set(r.order_id, cur);
  }
  return new Map([...best].map(([id, v]) => [id, v.kind]));
}

/**
 * Registra en la Actividad los cambios de estado de pedidos de WooCommerce que
 * acaban de guardarse en `orders`. No repite el último hecho de WooCommerce
 * del pedido (si ya es del mismo tipo, el cambio ya está registrado). Lee las
 * notas (como mucho `WOO_NOTES_MAX_LOOKUPS`, en paralelo) si hay cliente de la
 * API; sin él, pasado el tope o si falla, el hecho queda sin autor. Devuelve
 * cuántos hechos nuevos entraron. Nunca lanza.
 */
export async function recordWooStatusTransitions(
  admin: SupabaseClient,
  storeId: string,
  items: readonly WooTransitionItem[],
  client: WooClientOpts | null,
  opts: { maxLookups?: number; now?: () => string } = {},
): Promise<number> {
  if (!items.length) return 0;
  try {
    const ids = [...new Set(items.map((i) => i.shopifyOrderId))];
    const { data, error } = await admin
      .from("orders")
      .select("id,shopify_order_id")
      .eq("store_id", storeId)
      .in("shopify_order_id", ids);
    if (error) throw new Error(`orders: ${error.message}`);
    const uuidOf = new Map(
      ((data ?? []) as { id: string; shopify_order_id: string }[]).map((r) => [String(r.shopify_order_id), r.id]),
    );
    const orderIds = [...new Set(uuidOf.values())];
    if (!orderIds.length) return 0;

    // El último hecho de WooCommerce de cada pedido. Si ya es del mismo tipo, el
    // cambio ya está registrado: la pasada que pisó la anulación con una versión
    // anterior la vuelve a ver desde otro estado guardado (otra clave). Si la
    // lectura falla, se sigue: la clave aún frena la carrera de verdad.
    const { data: prior, error: priorErr } = await admin
      .from("order_events")
      .select("order_id,kind,occurred_at,created_at")
      .eq("store_id", storeId)
      .in("order_id", orderIds)
      .in("kind", Object.values(WOO_EVENT_KIND));
    if (priorErr) {
      console.error(`[woo-activity] ${JSON.stringify({ storeId, error: `order_events: ${priorErr.message}` })}`);
    }
    const lastKind = latestWooTransitionKinds(priorErr ? [] : ((prior ?? []) as WooTransitionFactRow[]));
    const pending = items.flatMap((item) => {
      const orderId = uuidOf.get(item.shopifyOrderId);
      if (!orderId || lastKind.get(orderId) === WOO_EVENT_KIND[item.transition]) return [];
      return [{ item, orderId }];
    });

    const maxLookups = opts.maxLookups ?? WOO_NOTES_MAX_LOOKUPS;
    const lookups = await Promise.all(
      pending.map(({ item }, i) =>
        client && i < maxLookups
          ? lookupActor(client, item)
          : Promise.resolve<ActorLookup>({ actor: null, note: null, error: null }),
      ),
    );

    const nowIso = opts.now?.() ?? new Date().toISOString();
    let written = 0;
    for (const [i, { item, orderId }] of pending.entries()) {
      const row = wooTransitionEvent(storeId, orderId, item, lookups[i]!, nowIso);
      // Dos cambios del mismo pedido en la misma llamada: el segundo igual no entra.
      if (lastKind.get(orderId) === row.kind) continue;
      const { error: insErr } = await admin.from("order_events").insert(row);
      if (!insErr) {
        written++;
        lastKind.set(orderId, String(row.kind));
        continue;
      }
      // El mismo cambio ya está registrado (el webhook y la pasada a la vez).
      if ((insErr as { code?: string }).code === "23505") continue;
      console.error(
        `[woo-activity] ${JSON.stringify({ storeId, orderId: item.shopifyOrderId, kind: row.kind, error: insErr.message })}`,
      );
    }
    return written;
  } catch (e) {
    console.error(
      `[woo-activity] ${JSON.stringify({ storeId, error: e instanceof Error ? e.message : String(e) })}`,
    );
    return 0;
  }
}

