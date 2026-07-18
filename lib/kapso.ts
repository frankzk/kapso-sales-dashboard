// Kapso Platform API client.
// Base: https://api.kapso.ai/platform/v1  — header: X-API-Key.
//
// Endpoints (confirmed against docs.kapso.ai):
//   GET /whatsapp/conversations                     — list (cursor pagination)
//   GET /whatsapp/messages                          — list (cursor pagination)
//   GET /whatsapp/phone_numbers                     — list connected numbers (page pagination)
//   GET /whatsapp/phone_numbers/{id}/health         — live number health
//   GET /api_logs                                   — external API call logs
//
// The "operativo" family (family 4) is best-effort: number health + api_logs
// give errors/latency directly; 24h activity is derived from conversations.

import { env } from "@/lib/env";
import { type ConversationRow } from "@/lib/types";
import { normalizePhone } from "@/lib/phone";

export interface KapsoClientOpts {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface KapsoPage<T> {
  data: T[];
  paging?: {
    cursors?: { before?: string | null; after?: string | null };
    next?: string | null;
    [k: string]: unknown;
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface KapsoConversation {
  id: string;
  phone_number?: string | null;
  phone_number_id?: string | null;
  status?: string | null;
  created_at?: string | null;
  last_active_at?: string | null;
  messages_count?: number | null;
  kapso?: {
    messages_count?: number | null;
    last_message_timestamp?: string | null;
    [k: string]: unknown;
  } | null;
  [k: string]: any;
}

export interface KapsoApiLog {
  id?: string;
  endpoint?: string;
  status_code?: number;
  duration_ms?: number | null;
  latency_ms?: number | null;
  created_at?: string;
  [k: string]: any;
}

export interface KapsoHealth {
  status: string;
  timestamp: string;
  error?: string | null;
  checks?: Record<string, unknown> | null;
}

function baseFor(opts: KapsoClientOpts): string {
  return (opts.baseUrl ?? env.kapsoApiBase()).replace(/\/$/, "");
}

async function kapsoGet<T>(
  opts: KapsoClientOpts,
  path: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const url = new URL(baseFor(opts) + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url.toString(), {
    headers: { "X-API-Key": opts.apiKey, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kapso API HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface ListConversationsParams {
  phoneNumberId?: string;
  status?: "active" | "ended";
  createdAfter?: string;
  createdBefore?: string;
  lastActiveAfter?: string;
  lastActiveBefore?: string;
  limit?: number;
  after?: string;
  before?: string;
}

export function listConversations(
  opts: KapsoClientOpts,
  p: ListConversationsParams = {},
): Promise<KapsoPage<KapsoConversation>> {
  return kapsoGet<KapsoPage<KapsoConversation>>(opts, "/whatsapp/conversations", {
    phone_number_id: p.phoneNumberId,
    status: p.status,
    created_after: p.createdAfter,
    created_before: p.createdBefore,
    last_active_after: p.lastActiveAfter,
    last_active_before: p.lastActiveBefore,
    limit: p.limit ?? 100,
    after: p.after,
    before: p.before,
  });
}

/**
 * All Kapso conversations for a customer phone (newest-first), across the
 * project's connected business numbers. A customer who wrote to two of the
 * store's numbers has one conversation per number. Optionally scoped to one
 * business number. Never throws ([] on error).
 */
export async function listConversationsByPhone(
  opts: KapsoClientOpts,
  phone: string,
  phoneNumberId?: string | null,
): Promise<KapsoConversation[]> {
  if (!phone) return [];
  let page: KapsoPage<KapsoConversation>;
  try {
    page = await kapsoGet<KapsoPage<KapsoConversation>>(opts, "/whatsapp/conversations", {
      phone_number: phone,
      phone_number_id: phoneNumberId ?? undefined,
      limit: 20,
    });
  } catch {
    return [];
  }
  return (page.data ?? []).slice().sort((a, b) => {
    const ta = String(a.last_active_at ?? a.created_at ?? "");
    const tb = String(b.last_active_at ?? b.created_at ?? "");
    return tb.localeCompare(ta); // newest first
  });
}

/**
 * Find the most-recent Kapso conversation id for a customer phone (null if none).
 * Lets the lead drawer show a WhatsApp transcript even when the lead's
 * `kapso_conversation_id` wasn't captured at ingest (e.g. some ad/cart leads).
 * Optionally scoped to a business number. Never throws.
 */
export async function findConversationIdByPhone(
  opts: KapsoClientOpts,
  phone: string,
  phoneNumberId?: string | null,
): Promise<string | null> {
  const convs = await listConversationsByPhone(opts, phone, phoneNumberId);
  const id = convs[0]?.id;
  return id != null ? String(id) : null;
}

export interface ListMessagesParams {
  phoneNumberId?: string;
  conversationId?: string;
  direction?: "inbound" | "outbound";
  status?: string;
  messageType?: string;
  limit?: number;
  after?: string;
  /** Kapso field selector, e.g. `kapso(default)` to include media_url/direction. */
  fields?: string;
}

export function listMessages(
  opts: KapsoClientOpts,
  p: ListMessagesParams = {},
): Promise<KapsoPage<any>> {
  return kapsoGet<KapsoPage<any>>(opts, "/whatsapp/messages", {
    phone_number_id: p.phoneNumberId,
    conversation_id: p.conversationId,
    direction: p.direction,
    status: p.status,
    message_type: p.messageType,
    limit: p.limit ?? 100,
    after: p.after,
    fields: p.fields,
  });
}

export type WhatsappSendResult =
  | { ok: true; id: string | null }
  | { ok: false; error: string; code?: number; ambiguous?: boolean };

/**
 * POST a pre-built message payload to Kapso's Meta proxy
 * (`{origin}/meta/whatsapp/v24.0/{phoneNumberId}/messages`, header `X-API-Key`).
 * Shared by the text and template senders. Never throws — network/HTTP errors
 * come back as { ok:false }, surfacing Meta's error `code` when present (e.g.
 * 131047 = closed 24h window; 132xxx = template problems).
 */
async function postWhatsappMessage(
  opts: KapsoClientOpts,
  phoneNumberId: string,
  payload: Record<string, unknown>,
): Promise<WhatsappSendResult> {
  const origin = new URL(baseFor(opts)).origin;
  const url = `${origin}/meta/whatsapp/v24.0/${encodeURIComponent(phoneNumberId)}/messages`;
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        "X-API-Key": opts.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e: any) {
    // The request may have reached Meta even though its response never reached
    // us. Mark it ambiguous so callers do not auto-retry and duplicate a send.
    return { ok: false, error: e?.message ?? "network error", ambiguous: true };
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ?? json?.errors?.[0] ?? {};
    return {
      ok: false,
      error: err?.message ?? err?.title ?? `HTTP ${res.status}`,
      code: typeof err?.code === "number" ? err.code : undefined,
    };
  }
  const id = json?.messages?.[0]?.id;
  return { ok: true, id: typeof id === "string" ? id : null };
}

/**
 * Send a free-text WhatsApp *session* message via Kapso's Meta proxy. Only valid
 * inside the 24h customer-service window — outside it WhatsApp rejects with
 * error 131047, which we surface as { ok:false, code }. Never throws.
 */
export async function sendWhatsappText(
  opts: KapsoClientOpts,
  params: { phoneNumberId: string; to: string; body: string },
): Promise<WhatsappSendResult> {
  return postWhatsappMessage(opts, params.phoneNumberId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: params.to,
    type: "text",
    text: { preview_url: false, body: params.body },
  });
}

/**
 * Send a WhatsApp **template** (HSM) message via Kapso's Meta proxy. Templates
 * are the only way to open a conversation OUTSIDE the 24h window (cold
 * re-engagement) and must be pre-approved by Meta. `bodyParams` fill the
 * positional body variables ({{1}}, {{2}}, …) in order. Quick-reply buttons in
 * the template carry no variables, so no button component is needed here.
 * Never throws; a rejected template surfaces as { ok:false, code } (e.g. 132xxx).
 */
export async function sendWhatsappTemplate(
  opts: KapsoClientOpts,
  params: {
    phoneNumberId: string;
    to: string;
    templateName: string;
    language: string;
    bodyParams?: string[];
  },
): Promise<WhatsappSendResult> {
  const components = params.bodyParams?.length
    ? [{ type: "body", parameters: params.bodyParams.map((text) => ({ type: "text", text })) }]
    : [];
  return postWhatsappMessage(opts, params.phoneNumberId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: params.to,
    type: "template",
    template: {
      name: params.templateName,
      language: { code: params.language },
      components,
    },
  });
}

/**
 * Send an **image** message via Kapso's Meta proxy, by public link (Meta fetches
 * the image from `imageUrl` at send time, so it must be a public HTTPS URL).
 * Valid only inside the 24h session window, like free text. Never throws.
 */
export async function sendWhatsappImage(
  opts: KapsoClientOpts,
  params: { phoneNumberId: string; to: string; imageUrl: string; caption?: string },
): Promise<WhatsappSendResult> {
  return postWhatsappMessage(opts, params.phoneNumberId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: params.to,
    type: "image",
    image: { link: params.imageUrl, ...(params.caption ? { caption: params.caption } : {}) },
  });
}

/**
 * Send a **document** (PDF/boleta/etc.) by public link. `filename` is what the
 * recipient sees in WhatsApp. Valid inside the 24h window. Never throws.
 */
export async function sendWhatsappDocument(
  opts: KapsoClientOpts,
  params: { phoneNumberId: string; to: string; documentUrl: string; filename?: string; caption?: string },
): Promise<WhatsappSendResult> {
  return postWhatsappMessage(opts, params.phoneNumberId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: params.to,
    type: "document",
    document: {
      link: params.documentUrl,
      ...(params.filename ? { filename: params.filename } : {}),
      ...(params.caption ? { caption: params.caption } : {}),
    },
  });
}

/**
 * Send a **video** (mp4/3gpp) by public link. Valid inside the 24h window.
 * Never throws.
 */
export async function sendWhatsappVideo(
  opts: KapsoClientOpts,
  params: { phoneNumberId: string; to: string; videoUrl: string; caption?: string },
): Promise<WhatsappSendResult> {
  return postWhatsappMessage(opts, params.phoneNumberId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: params.to,
    type: "video",
    video: { link: params.videoUrl, ...(params.caption ? { caption: params.caption } : {}) },
  });
}

/** Latest inbound (customer) message time in ms for a conversation, or null. */
export async function fetchLastInboundAt(
  opts: KapsoClientOpts,
  conversationId: string,
): Promise<number | null> {
  let page: KapsoPage<any>;
  try {
    page = await listMessages(opts, { conversationId, direction: "inbound", limit: 5 });
  } catch {
    return null;
  }
  let max: number | null = null;
  for (const m of page.data ?? []) {
    const t = msgTimeMs(m);
    if (t != null && (max == null || t > max)) max = t;
  }
  return max;
}

export function getPhoneHealth(
  opts: KapsoClientOpts,
  phoneNumberId: string,
): Promise<KapsoHealth> {
  return kapsoGet<KapsoHealth>(
    opts,
    `/whatsapp/phone_numbers/${encodeURIComponent(phoneNumberId)}/health`,
  );
}

/** A connected WhatsApp number as returned by GET /whatsapp/phone_numbers.
 *  Only the label-relevant fields are typed; the rest are passed through. */
export interface KapsoPhoneNumber {
  phone_number_id?: string | null;
  name?: string | null;
  verified_name?: string | null;
  display_name?: string | null;
  display_phone_number?: string | null;
  display_phone_number_normalized?: string | null;
  is_coexistence?: boolean | null;
  kind?: string | null; // Kapso lifecycle: 'production' | 'sandbox'
  status?: string | null;
  [k: string]: any;
}

interface KapsoNumbersPage {
  data: KapsoPhoneNumber[];
  meta?: { page?: number; per_page?: number; total_pages?: number; total_count?: number } | null;
}

/** List every WhatsApp number connected to the project for this API key (most
 *  recent first), paging through all pages. Used to auto-populate the
 *  `whatsapp_numbers` label lookup during sync. */
export async function listWhatsappNumbers(opts: KapsoClientOpts): Promise<KapsoPhoneNumber[]> {
  const out: KapsoPhoneNumber[] = [];
  const maxPages = 20; // safety bound; a project has a handful of numbers
  for (let page = 1; page <= maxPages; page++) {
    const res = await kapsoGet<KapsoNumbersPage>(opts, "/whatsapp/phone_numbers", {
      per_page: 100,
      page,
    });
    out.push(...(res.data ?? []));
    const totalPages = res.meta?.total_pages ?? 1;
    if (!res.data?.length || page >= totalPages) break;
  }
  return out;
}

export interface ListApiLogsParams {
  endpoint?: string;
  statusCode?: number;
  errorsOnly?: boolean;
  period?: string;
  limit?: number;
  after?: string;
}

export function listApiLogs(
  opts: KapsoClientOpts,
  p: ListApiLogsParams = {},
): Promise<KapsoPage<KapsoApiLog>> {
  return kapsoGet<KapsoPage<KapsoApiLog>>(opts, "/api_logs", {
    endpoint: p.endpoint,
    status_code: p.statusCode,
    errors_only: p.errorsOnly,
    period: p.period,
    limit: p.limit ?? 100,
    after: p.after,
  });
}

/** Extract the "next page" cursor from a Kapso paging object, if any. */
export function nextCursor(page: KapsoPage<unknown>): string | null {
  const c = page.paging?.cursors?.after ?? page.paging?.next ?? null;
  return c ? String(c) : null;
}

/**
 * Page through conversations following the `after` cursor. Bounded by
 * `maxPages` to avoid runaway loops on a single sync run.
 */
export async function listAllConversations(
  opts: KapsoClientOpts,
  params: ListConversationsParams,
  maxPages = 50,
): Promise<KapsoConversation[]> {
  const out: KapsoConversation[] = [];
  let after = params.after;
  for (let i = 0; i < maxPages; i++) {
    const page = await listConversations(opts, { ...params, after });
    out.push(...(page.data ?? []));
    const next = nextCursor(page);
    if (!next || (page.data?.length ?? 0) === 0) break;
    after = next;
  }
  return out;
}

/** Map a Kapso conversation object to a `conversations` row. Defensive about
 *  field names (platform list vs. webhook payload vs. kapso() extension). */
export function mapKapsoConversation(
  c: KapsoConversation,
  storeId: string,
): ConversationRow {
  return {
    store_id: storeId,
    kapso_conversation_id: String(c.id),
    phone_number_id: c.phone_number_id ?? null,
    started_at: c.created_at ?? null,
    status: c.status ?? null,
    message_count: c.kapso?.messages_count ?? c.messages_count ?? 0,
    last_message_at:
      c.last_active_at ?? c.kapso?.last_message_timestamp ?? null,
    raw: c,
  };
}

// ---------------------------------------------------------------------------
// Message timing — best-effort first-response time + inbound count per conv.
// Defensive about the message payload shape (direction + timestamp field names)
// and bounded to a single page; most sales conversations fit in 100 messages.
// ---------------------------------------------------------------------------

function msgTimeMs(m: any): number | null {
  const t =
    m?.created_at ?? m?.timestamp ?? m?.inserted_at ?? m?.sent_at ?? m?.occurred_at ??
    m?.message_timestamp ?? m?.wa_timestamp ?? m?.kapso?.timestamp;
  if (t == null) return null;
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t; // seconds → ms
  const s = String(t).trim();
  if (/^\d+$/.test(s)) {
    // Kapso sends the timestamp as a unix epoch *string* (e.g. "1782249525").
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n; // seconds → ms (else already ms)
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function msgDirection(m: any): "inbound" | "outbound" | null {
  const d = String(m?.direction ?? m?.kapso?.direction ?? "").toLowerCase();
  if (d.includes("in")) return "inbound";
  if (d.includes("out")) return "outbound";
  if (typeof m?.is_inbound === "boolean") return m.is_inbound ? "inbound" : "outbound";
  if (typeof m?.from_me === "boolean") return m.from_me ? "outbound" : "inbound"; // bot = from_me
  return null;
}

/** Best-effort text of a message, across WhatsApp/Kapso payload shapes. */
function msgText(m: any): string {
  const t =
    m?.text?.body ??
    (typeof m?.text === "string" ? m.text : null) ??
    m?.body ??
    (typeof m?.content === "string" ? m.content : m?.content?.text) ??
    m?.message?.text?.body ??
    m?.message?.body ??
    (typeof m?.message?.content === "string" ? m.message.content : null) ??
    // Kapso's canonical rendered body — this is where TEMPLATE (HSM) messages
    // keep their text (the browse re-engagement template, etc.); they have no
    // `text.body`, so without this they rendered as empty bubbles.
    (typeof m?.kapso?.content === "string" ? m.kapso.content : null) ??
    m?.caption ??
    m?.kapso?.text ??
    "";
  return typeof t === "string" ? t : "";
}

export interface ParsedMsg {
  t: number;
  dir: "inbound" | "outbound";
  text: string;
  image?: boolean; // image/media attachment (Yape voucher, product photo, …)
  id?: string | null; // Kapso message id (for dedup of vision checks)
  mediaUrl?: string | null; // stored media URL (to fetch the image bytes)
}

export type MediaKind = "image" | "audio" | "video" | "document" | "sticker";

/** Classify a message's media attachment (null = plain text / no media). */
function msgMediaKind(m: any): MediaKind | null {
  const t = m?.type ?? m?.message?.type;
  if (t === "image" || t === "audio" || t === "video" || t === "document" || t === "sticker") return t;
  if (m?.image) return "image";
  if (m?.sticker) return "sticker";
  if (m?.video) return "video";
  if (m?.audio) return "audio";
  if (m?.document) return "document";
  const ct: string =
    m?.kapso?.media_data?.content_type ??
    m?.kapso?.message_type_data?.content_type ??
    m?.media_data?.content_type ??
    "";
  if (typeof ct === "string" && ct) {
    if (ct.startsWith("image/")) return "image";
    if (ct.startsWith("audio/")) return "audio";
    if (ct.startsWith("video/")) return "video";
    if (ct.startsWith("application/") || ct.startsWith("text/")) return "document";
  }
  return null;
}

/** Kapso's stored, stable media URL for a message (null if none). Prefers the
 *  `kapso.media_url` extension (returned with `fields=kapso(default)`); the
 *  Meta `image.url`/`lookaside.fbsbx.com` link expires + needs auth, so it's a
 *  last resort only. Must be requested through the authenticated media proxy. */
function msgMediaUrl(m: any): string | null {
  const u = m?.kapso?.media_url ?? m?.kapso?.media_data?.url ?? m?.media_data?.url ?? null;
  return typeof u === "string" && u ? u : null;
}

/** Caption that travels with an image/video/document (separate from a text body). */
function msgCaption(m: any): string {
  const c =
    m?.image?.caption ??
    m?.video?.caption ??
    m?.document?.caption ??
    m?.kapso?.message_type_data?.caption ??
    null;
  return typeof c === "string" ? c : "";
}

/** Template (HSM) name + body parameters, when the message is a template send. */
function msgTemplate(m: any): { name: string | null; params: string[] } | null {
  const tpl = m?.template ?? m?.kapso?.message_type_data ?? m?.message_type_data ?? null;
  if (!tpl || typeof tpl !== "object") return null;
  const name = typeof tpl.name === "string" ? tpl.name : null;
  const comps = Array.isArray(tpl.components) ? tpl.components : [];
  const body = comps.find((c: any) => c?.type === "body");
  const params = Array.isArray(body?.parameters)
    ? body.parameters.map((p: any) => String(p?.text ?? "").trim()).filter(Boolean)
    : [];
  if (!name && !params.length) return null;
  return { name, params };
}

/** A conversation message normalized for display in the lead drawer. */
export interface ConversationMessage {
  id: string | null;
  dir: "inbound" | "outbound";
  t: number; // epoch ms
  text: string; // text body or media caption
  mediaKind: MediaKind | null;
  mediaUrl: string | null; // Kapso stored URL — fetch via the authenticated proxy
  status: string | null; // WhatsApp delivery status (sent/delivered/read/failed) — outbound
  templateName?: string | null; // template (HSM) name, when this is a template send
  templateParams?: string[]; // template body params (e.g. [nombre, producto])
}

/**
 * Normalize a raw Kapso message page (fetched with `fields=kapso(default)`) into
 * an ordered, display-ready transcript: text + media (Yape vouchers, product
 * photos) with their stable `media_url`. Pure + defensive about payload shapes;
 * messages without a usable timestamp are dropped, unknown direction defaults to
 * inbound. Oldest first.
 */
export function parseConversationMessages(rawMsgs: any[]): ConversationMessage[] {
  return (rawMsgs ?? [])
    .map((m): ConversationMessage | null => {
      const t = msgTimeMs(m);
      if (t == null) return null;
      const caption = msgCaption(m);
      const status = m?.kapso?.status ?? m?.status;
      const tpl = msgTemplate(m);
      return {
        id: m?.id != null ? String(m.id) : null,
        dir: msgDirection(m) ?? "inbound",
        t,
        text: msgText(m) || caption,
        mediaKind: msgMediaKind(m),
        mediaUrl: msgMediaUrl(m),
        status: typeof status === "string" ? status : null,
        ...(tpl?.name ? { templateName: tpl.name } : {}),
        ...(tpl?.params.length ? { templateParams: tpl.params } : {}),
      };
    })
    .filter((m): m is ConversationMessage => m != null)
    .sort((a, b) => a.t - b.t);
}

/**
 * The product a re-engagement template was sent about: the LAST body parameter
 * of the first OUTBOUND message whose template name matches `templateName`. Our
 * browse template's params are [nombre, producto], so the product is last. Used
 * to recover a browse lead's product when its `cart_summary` was lost. Null when
 * no matching template message is found.
 */
export function templateProductParam(
  messages: ConversationMessage[],
  templateName: string | null | undefined,
): string | null {
  if (!templateName) return null;
  for (const m of messages) {
    if (m.dir === "outbound" && m.templateName === templateName && m.templateParams?.length) {
      return m.templateParams[m.templateParams.length - 1] ?? null;
    }
  }
  return null;
}

/**
 * Fetch a lead's full WhatsApp transcript for the drawer, oldest-first. Kapso
 * caps `limit` at 100, so page through the cursor (bounded by `maxPages`) and
 * concatenate. Requested with `fields=kapso(default)` so each message carries
 * its stable `media_url`. The first page may throw (the caller surfaces the
 * error); a later page failing just returns what was gathered so far.
 */
export async function fetchConversationTranscript(
  opts: KapsoClientOpts,
  conversationId: string,
  maxPages = 5,
): Promise<ConversationMessage[]> {
  const raw: any[] = [];
  let after: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    let page: KapsoPage<any>;
    try {
      page = await listMessages(opts, { conversationId, limit: 100, fields: "kapso(default)", after });
    } catch (e) {
      if (i === 0) throw e; // couldn't fetch even the first page → real error
      break; // already have some pages; stop on a later failure
    }
    const batch = page.data ?? [];
    raw.push(...batch);
    if (batch.length < 100) break; // partial page ⇒ last page
    const next = page.paging?.cursors?.after ?? page.paging?.next ?? null;
    if (!next) break;
    after = String(next);
  }
  // Dedupe by id (cursor pages shouldn't overlap, but be safe) + normalize.
  const seen = new Set<string>();
  const deduped = raw.filter((m) => {
    const id = m?.id != null ? String(m.id) : null;
    if (id == null) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return parseConversationMessages(deduped);
}

/**
 * Merge several conversations' transcripts into ONE oldest-first stream, deduped
 * by id. Kapso splits a contact's chat into session-window "conversations" (each
 * its own id), so the drawer — which wants the whole history for a number —
 * concatenates their per-conversation transcripts and re-sorts by timestamp (`t`,
 * epoch ms; id as a stable tiebreak). Pure.
 */
export function mergeTranscripts(perConversation: ConversationMessage[][]): ConversationMessage[] {
  const seen = new Set<string>();
  const out: ConversationMessage[] = [];
  for (const list of perConversation) {
    for (const m of list) {
      const id = m.id != null ? String(m.id) : null;
      if (id != null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(m);
    }
  }
  return out.sort((a, b) => a.t - b.t || String(a.id ?? "").localeCompare(String(b.id ?? "")));
}

/**
 * A normalized Click-to-WhatsApp (CTWA) ad referral. Meta attaches a top-level
 * `referral` object to the FIRST inbound message of an ad/post-sourced
 * conversation; its presence means the lead came from a paid Meta entry point.
 */
export interface LeadReferral {
  // "meta_ad" = a structured Click-to-WhatsApp referral (a real, provable ad click,
  // carries the ad_id). "fb_web" = the weaker fallback: the customer reached the
  // SITE from a Facebook/IG link (utm_source=facebook, fbclid, a placement macro)
  // and then opened WhatsApp from a web button — could be paid OR organic, and
  // there's no ad_id to tie it to a specific campaign. Kept separate so the
  // "Meta Ads (campañas)" bucket stays trustworthy (only real ad clicks).
  source: "meta_ad" | "fb_web";
  ad_id: string | null; // referral.source_id (Meta ad id) — null for fb_web
  ad_headline: string | null; // referral.headline (ad creative headline)
  ctwa_clid: string | null; // referral.ctwa_clid (click id, for Meta CAPI matching)
}

// Paid-Meta signals embedded in a pre-filled wa.me opening message (ad → site →
// "tengo una consulta" WhatsApp button) rather than a structured CTWA referral.
// These tokens essentially only appear in Meta ad destination URLs, so a customer
// message carrying one came from a Facebook/Instagram ad. No ad_id is available
// from the URL here, so we attribute the channel (Campaña) without a specific ad.
const META_AD_HINT_RE =
  /fbclid=|utm_source=(?:facebook|fb|meta|instagram|ig)\b|(?:facebook|instagram)_(?:mobile_feed|desktop_feed|feed|stories|reels|marketplace)/i;

/** Pull the Meta ad attribution off a raw Kapso message page (null = organic).
 *  Prefers the structured CTWA `referral` (carries the real ad_id); falls back to
 *  a Meta ad link inside the customer's opening message (channel only, no ad_id). */
export function extractReferral(rawMsgs: any[]): LeadReferral | null {
  // 1) Structured CTWA referral — preferred (has the real ad_id).
  for (const m of rawMsgs ?? []) {
    const ref = m?.referral ?? m?.message?.referral ?? m?.kapso?.referral;
    if (ref && typeof ref === "object" && (ref.source_id || ref.source_type || ref.ctwa_clid || ref.headline)) {
      return {
        source: "meta_ad",
        ad_id: ref.source_id != null ? String(ref.source_id) : null,
        ad_headline: typeof ref.headline === "string" ? ref.headline : null,
        ctwa_clid: typeof ref.ctwa_clid === "string" ? ref.ctwa_clid : null,
      };
    }
  }
  // 2) Fallback: a Facebook/IG link in a customer (inbound) message — they reached
  //    the SITE from Meta and opened WhatsApp from a web button. NOT a direct ad
  //    click (no CTWA referral, no ad_id) and possibly organic, so it's the weaker
  //    "fb_web" source, kept out of the provable "meta_ad" (campañas) bucket.
  for (const m of rawMsgs ?? []) {
    if (msgDirection(m) !== "inbound") continue;
    if (META_AD_HINT_RE.test(msgText(m))) {
      return { source: "fb_web", ad_id: null, ad_headline: null, ctwa_clid: null };
    }
  }
  return null;
}

export interface OrderSignals {
  district: string | null;
  cart_value: number | null;
  cart_item_count: number | null;
  cart_summary: string | null;
}

// Frases de TOTAL que anclan un "pedido armado" en un mensaje del bot. El ancla
// es siempre una frase de total con monto — nunca una mera mención de producto —
// para que "carrito" siga significando pedido armado. Orden: explícitas primero.
// "total del envío: S/ 10" NO calza en ninguna (el genérico exige el monto
// inmediatamente después de "total", sin palabras de por medio).
const ORDER_TOTAL_RES: RegExp[] = [
  /(?:total\s+a\s+pagar|total\s+del?\s+pedido|monto\s+(?:total|a\s+pagar))\s*:?\s*(?:es\s+|ser[ií]an?\s+|de\s+)?s\/\.?\s*([\d.,]+)/i,
  /(?:total\s+a\s+pagar|total\s+del?\s+pedido|monto\s+(?:total|a\s+pagar))\s*:?\s*(?:es\s+|ser[ií]an?\s+|de\s+)?([\d.,]+)\s*soles\b/i,
  /\btotal\s*:?\s*(?:es\s+|ser[ií]an?\s+|de\s+)?s\/\.?\s*([\d.,]+)/i,
  /\btotal\s*:?\s*(?:es\s+|ser[ií]an?\s+|de\s+)?([\d.,]+)\s*soles\b/i,
];

function matchOrderTotal(text: string): number | null {
  for (const re of ORDER_TOTAL_RES) {
    const m = text.match(re);
    if (m) return Number(m[1]!.replace(/,/g, "")) || null;
  }
  return null;
}

/** Líneas de ítems dentro de un resumen de pedido (solo se llama sobre mensajes
 *  que YA calzaron un total): "- 3 x Producto", "- 2 unidades de Producto" y
 *  "• Producto x2". Títulos que son puro precio se descartan. */
function parseSummaryItems(text: string): { qty: number; title: string }[] {
  const items: { qty: number; title: string }[] = [];
  const push = (qty: number, title: string) => {
    const t = title.trim();
    if (t && !/^s\/\.?\s*[\d.,]*$/i.test(t)) items.push({ qty, title: t });
  };
  for (const line of text.split(/\n/)) {
    let m = line.match(/^[\s\-•*]*(\d+)\s*x\s+(.+)$/i);
    if (m) {
      push(Number(m[1]), m[2]!);
      continue;
    }
    m = line.match(/^[\s\-•*]*(\d+)\s*(?:und\.?|unid\.?|unidad(?:es)?)\s*(?:de\s+)?(.+)$/i);
    if (m) {
      push(Number(m[1]), m[2]!);
      continue;
    }
    m = line.match(/^[\s\-•*]*(.{3,}?)\s+x\s?(\d+)\s*(?:[-–—:(].*)?$/i);
    if (m && !/^(?:talla|color|tama[nñ]o|medida)\b/i.test(m[1]!.trim())) {
      push(Number(m[2]), m[1]!);
    }
  }
  return items;
}

// Respuestas que NO son un lugar: puro relleno conversacional ("ok gracias",
// "sí claro") o una cantidad ("3", "3x2") — el cliente suele contestar la
// promo, no el distrito.
const LOCATION_FILLER_RE =
  /^(?:(?:ok(?:ay)?|s[ií]|ya|no|gracias|listo|bueno|claro|hola|buenas|dale|perfecto|genial)\b[\s!.,]*)+$/i;
// Arranques que delatan que la captura NO es un lugar: frase conversacional
// ("cuando quieras ver más modelos…", "que lo veas"), marketing ("todas las
// ciudades", "a nivel nacional", "a domicilio"), tiempos ("en el transcurso
// del día", "en la tarde") o residuos ("vivo en un departamento", "estoy en
// camino/casa/el trabajo"). Se evalúa tras quitar el artículo inicial.
const NOT_A_PLACE_RE =
  /^(?:en|de|del|al|tod[oa]s?|cualquier|nivel|domicilio|provincias|cuando|que|como|si|d[oó]nde|donde|gratis|recibir|coordinar|confirmar|transcurso|horario|d[ií]as?|madrugada|mañana|tarde|noche|semana|departamento|provincia|ciudad|distrito|zona|casa|depa|camino|trabajo|oficina|centro|momento|reuni[oó]n)\b/i;

/** ¿El texto PARECE un lugar? Corto (≤4 palabras — cubre "San Juan de
 *  Lurigancho"), sin dígitos y sin arranque de frase/relleno. Mata capturas
 *  conversacionales del eco ("te lo envío para cuando quieras…"). */
function looksLikePlace(s: string): boolean {
  if (s.length < 3 || /\d/.test(s)) return false;
  if (s.split(/\s+/).length > 4) return false;
  return !NOT_A_PLACE_RE.test(s);
}

/**
 * Extract buyer-intent signals from a conversation's messages. The bots collect
 * these in-chat (no Shopify draft order is created):
 *   - district: la respuesta del cliente al ÚLTIMO prompt de ubicación del bot.
 *     "distrito" vale siempre (bot clásico de Aurela); ciudad/provincia/
 *     departamento/"¿dónde…enviamos?" solo si el mensaje es una PREGUNTA (para
 *     no confundir marketing — "envíos a todas las ciudades" — con un prompt).
 *     Fallbacks: el eco del bot ("Envío: gratis a Ate") y, al final, la
 *     ubicación espontánea del cliente ("soy de Arequipa", "vivo en Comas") —
 *     clave para Kenku, que vende a nivel nacional y cuyo guion no siempre
 *     pregunta "distrito".
 *   - cart: el resumen de pedido del bot, anclado en una frase de total con
 *     monto (variantes en ORDER_TOTAL_RES) + líneas de ítems.
 * Pure + defensive: unknown formats just yield nulls.
 */
export function parseOrderSignals(msgs: ParsedMsg[]): OrderSignals {
  // District. The bot re-asks several times, so the FIRST reply is usually
  // about something else (qty). Use the LAST prompt's reply.
  const isLocationPrompt = (text: string): boolean =>
    /distrito/i.test(text) ||
    (/[?¿]/.test(text) && /(?:provincia|ciudad|departamento|d[oó]nde\s+.{0,24}(?:env[ií]|entreg))/i.test(text));
  let district: string | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.dir !== "outbound" || !isLocationPrompt(msgs[i]!.text)) continue;
    const reply = msgs.slice(i + 1).find((x) => x.dir === "inbound" && x.text.trim());
    if (reply) {
      const d = reply.text.trim().replace(/\s+/g, " ");
      // a place name: short, not a question, not filler, not a quantity
      if (d.length <= 40 && !d.includes("?") && !LOCATION_FILLER_RE.test(d) && !/^[\d\sx×]+$/i.test(d)) {
        district = d;
      }
    }
    break; // last prompt wins
  }
  if (!district) {
    for (const m of msgs) {
      if (m.dir !== "outbound") continue;
      const echo =
        m.text.match(/env[ií]o[^\n]*?\s(?:a|para)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][^\n.,!?]*)/i) ??
        m.text.match(/entrega\s+(?:en|para|a)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][^\n.,!?]*)/i);
      if (echo) {
        const e = echo[1]!.trim().replace(/\s+/g, " ");
        // Valida SIN el artículo ("La Molina" → "Molina" pasa el filtro) pero
        // guarda el texto original. Mata capturas conversacionales del bot:
        // "te lo envío para cuando quieras ver más modelos con calma".
        if (looksLikePlace(e.replace(/^(?:el|la|los|las|un|una)\s+/i, ""))) district = e.slice(0, 40); // last wins
      }
    }
  }
  // Último recurso: el cliente lo dice espontáneamente. Se limpia el artículo y
  // el "departamento/ciudad de …"; un residuo que no es lugar se descarta.
  if (!district) {
    for (const m of msgs) {
      if (m.dir !== "inbound") continue;
      const v = m.text.match(
        /(?:soy de|vivo en|estoy en|me encuentro en|mi (?:distrito|ciudad|provincia) es)\s+([a-záéíóúñü][a-záéíóúñü\s]{1,38}?)(?=\s+(?:y|pero|que|para|porque|cerca)\b|[.,;!?\n]|$)/i,
      );
      if (!v) continue;
      let d = v[1]!.trim().replace(/\s+/g, " ");
      d = d.replace(/^(?:el|la|los|las|un|una|mi)\s+/i, "");
      d = d.replace(/^(?:departamento|provincia|ciudad|distrito|zona)\s+(?:de\s+)?/i, "");
      if (looksLikePlace(d)) district = d.slice(0, 40); // last wins
    }
  }

  // Cart: the bot's order summary, anchored on a money-total phrase.
  let cart_value: number | null = null;
  let cart_item_count: number | null = null;
  let cart_summary: string | null = null;
  for (const m of msgs) {
    if (m.dir !== "outbound") continue;
    const total = matchOrderTotal(m.text);
    if (total == null) continue;
    cart_value = total;
    const items = parseSummaryItems(m.text);
    if (items.length) {
      cart_item_count = items.reduce((s, it) => s + it.qty, 0);
      const titles = items
        .map((it) => it.title.replace(/\s*\(.*$/, "").replace(/:\s*s\/.*$/i, "").trim())
        .filter(Boolean);
      cart_summary =
        titles.slice(0, 3).join(", ") + (titles.length > 3 ? ` +${titles.length - 3}` : "");
    } else {
      cart_item_count = 1; // summary present but no parseable line items
    }
    break; // first summary wins
  }
  return { district, cart_value, cart_item_count, cart_summary: cart_summary || null };
}

// Payment / Yape-Shalom detection. Aurela's bot reserves a Shalom-pickup order
// by asking for a Yape "adelanto" (advance) + a "voucher" screenshot; the
// customer replies with the receipt as an IMAGE (no text, so the cart/text
// parser alone can't see it). A real advance is signalled by any of:
//   - the bot/agent confirming it ("pago recibido", "recibí tu voucher"), or
//   - the customer sending an image right after the bot requested the adelanto, or
//   - the customer stating they paid ("ya yapeé", "número de operación", …).
const PAYMENT_CONFIRMED_RE =
  /pago\s+(recibido|confirmado|verificado)|recib[ií]\s+(tu|el)\s+(pago|yape|voucher|adelanto|comprobante)|adelanto\s+(recibido|confirmado)/i;
const CUSTOMER_PAID_RE =
  /\b(ya\s+)?(te\s+)?yape[eé]|yapead|ya\s+(pagu[eé]|deposit[eé]|transfer[ií])|ya\s+(hice|realic[eé])[^.]{0,18}(pago|adelanto|dep[oó]sito)|comprobante|constancia|n[uú]mero\s+de\s+operaci[oó]n|operaci[oó]n\s*[:#]/i;

/**
 * Detect a Yape/Shalom advance payment from a conversation's messages.
 * Confirmed ONLY from TEXT/caption signals: the customer states they paid
 * (`CUSTOMER_PAID_RE` — "ya yapeé", "comprobante", "número de operación", …) or
 * the bot/agent confirms receipt (`PAYMENT_CONFIRMED_RE`).
 *
 * A bare inbound IMAGE is deliberately NOT treated as a voucher: a screenshot of
 * a conversation, a product, or a document must not fire the "Yape/Shalom por
 * verificar" alert. Telling a real Yape receipt apart from any other image needs
 * its CONTENT (Yape logo/interfaz, monto, fecha/hora, destinatario "Grupo GF
 * SAC", estado "Pago realizado/Transferencia exitosa/Yapeaste", nº de operación)
 * — i.e. vision/OCR, which layers on separately when enabled. Image captions ARE
 * scanned (folded into `text` upstream), so a voucher sent with "ya pagué" still
 * fires.
 */
export function detectYapePayment(msgs: ParsedMsg[]): boolean {
  for (const m of msgs) {
    const text = m.text ?? "";
    if (m.dir === "outbound") {
      if (PAYMENT_CONFIRMED_RE.test(text)) return true;
    } else if (CUSTOMER_PAID_RE.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * A bare inbound IMAGE that the text detector could NOT confirm as a payment,
 * but which arrived after the bot/agent asked for the Yape "adelanto"/voucher —
 * i.e. a candidate the vision layer should look at before firing the alert.
 */
export interface VoucherCandidate {
  messageId: string;
  mediaUrl: string;
}

// The bot/agent asking the customer to pay the advance and send the receipt
// ("adelanto", "yapéame al …", "envíame el voucher/comprobante/captura"). An
// inbound image AFTER such a request — with no confirming text — is the exact
// case where a screenshot could be a real voucher OR just an unrelated capture,
// so it's what the vision check is for. Deliberately does NOT match a bare
// "Yape" (payment-method mention, e.g. "aceptamos Yape") — only a request/action
// ("yapéa(me)", "adelanto", "voucher", …) opens the candidate window.
const VOUCHER_REQUEST_RE =
  /adelanto|voucher|comprobante|constancia|dep[oó]sito|pantallazo|captura|yape[aá]|n[uú]mero\s+de\s+cuenta/i;

/**
 * Collect inbound images that MIGHT be Yape vouchers: an image, sent by the
 * customer, after the bot/agent requested the advance/voucher. Bare screenshots
 * with no request context are skipped (they'd be product photos, chats, etc.).
 * Deduped by message id; needs both a message id and a media URL to be fetchable.
 * Pure + exported for testing.
 */
export function collectVoucherCandidates(msgs: ParsedMsg[]): VoucherCandidate[] {
  let requestedAt: number | null = null;
  for (const m of msgs) {
    if (m.dir === "outbound" && VOUCHER_REQUEST_RE.test(m.text)) {
      requestedAt = m.t;
      break; // first request opens the window
    }
  }
  if (requestedAt == null) return [];
  const out: VoucherCandidate[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    if (m.dir !== "inbound" || !m.image || m.t < requestedAt) continue;
    const id = m.id ?? null;
    const url = m.mediaUrl ?? null;
    if (!id || !url || seen.has(id)) continue;
    seen.add(id);
    out.push({ messageId: id, mediaUrl: url });
  }
  return out;
}

export interface ConversationSignals extends OrderSignals {
  inbound_count: number;
  first_response_seconds: number | null;
  yape: boolean;
  referral: LeadReferral | null;
  // Inbound images (post voucher-request) the text detector did not confirm — a
  // vision check reads these to decide the alert. Empty when the flow doesn't
  // apply. Always present so the ingest gate can iterate without a null check.
  voucherCandidates: VoucherCandidate[];
}

/**
 * First-response timing + inbound count + buyer-intent signals (district, cart)
 * for a conversation, from a single message page. Returns null if messages
 * can't be read. Never throws.
 */
export async function fetchConversationSignals(
  opts: KapsoClientOpts,
  conversationId: string,
): Promise<ConversationSignals | null> {
  let page: KapsoPage<any>;
  try {
    page = await listMessages(opts, { conversationId, limit: 100 });
  } catch {
    return null;
  }
  const referral = extractReferral(page.data ?? []);
  const msgs = (page.data ?? [])
    // Fold the image caption into `text` so a voucher sent WITH a payment note
    // ("ya pagué", "mi comprobante") still trips the Yape text detector, while a
    // bare screenshot (no words) does not. Keep id + media URL so a bare voucher
    // image can be handed to the vision check (collectVoucherCandidates).
    .map((m) => ({
      t: msgTimeMs(m),
      dir: msgDirection(m),
      text: [msgText(m), msgCaption(m)].filter(Boolean).join(" ").trim(),
      // Strictly an image (not any media): a voice note / document must not be
      // sent to the vision check as a fake image. `msgMediaKind` reads the real
      // type/content-type, so a captionless audio is classified as audio, not
      // image.
      image: msgMediaKind(m) === "image",
      id: m?.id != null ? String(m.id) : null,
      mediaUrl: msgMediaUrl(m),
    }))
    .filter(
      (
        m,
      ): m is {
        t: number;
        dir: "inbound" | "outbound";
        text: string;
        image: boolean;
        id: string | null;
        mediaUrl: string | null;
      } => m.t != null && m.dir != null,
    )
    .sort((a, b) => a.t - b.t);
  if (!msgs.length) return null;

  const inbound_count = msgs.filter((m) => m.dir === "inbound").length;
  const firstInbound = msgs.find((m) => m.dir === "inbound");
  let first_response_seconds: number | null = null;
  if (firstInbound) {
    const reply = msgs.find((m) => m.dir === "outbound" && m.t >= firstInbound.t);
    if (reply) first_response_seconds = Math.max(0, Math.round((reply.t - firstInbound.t) / 1000));
  }
  return {
    inbound_count,
    first_response_seconds,
    yape: detectYapePayment(msgs),
    referral,
    voucherCandidates: collectVoucherCandidates(msgs),
    ...parseOrderSignals(msgs),
  };
}

// Only ever pull media from Kapso's own hosts (the stored blob on app.kapso.ai,
// or a future api.kapso.ai variant). Message data is external input, so this
// allowlist stops a crafted media_url from turning the fetch into an SSRF.
const KAPSO_MEDIA_HOSTS = new Set(["app.kapso.ai", "api.kapso.ai"]);
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_REDIRECTS = 4;
// Cap raw bytes so a huge upload can't blow the request budget; the Messages API
// rejects images over ~5MB base64 anyway (base64 inflates ~33%).
const MAX_IMAGE_BYTES = 3_500_000;

function isAllowedMediaUrl(u: URL): boolean {
  return u.protocol === "https:" && KAPSO_MEDIA_HOSTS.has(u.hostname);
}

/**
 * Fetch a Kapso-hosted image and return it base64-encoded (+ its content-type),
 * authenticated with the store's Kapso key. Host-allowlisted, size-capped,
 * timeout-bounded. Returns null on any problem — NEVER throws (callers treat a
 * null as "couldn't read the image", not an error).
 *
 * Redirects are followed MANUALLY (Kapso 3xx's the stored blob to a signed
 * storage CDN) so the store's `X-API-Key` is sent ONLY while the request stays
 * on an allowlisted Kapso host. Node's `fetch` (undici) does NOT strip custom
 * headers on cross-origin redirects, so `redirect: "follow"` would leak the key
 * to the CDN. Once we leave Kapso, the (signed) URL needs no key, so we drop it.
 */
export async function fetchKapsoImageBase64(
  opts: KapsoClientOpts,
  mediaUrl: string,
): Promise<{ base64: string; contentType: string | null } | null> {
  let url: URL;
  try {
    url = new URL(mediaUrl);
  } catch {
    return null;
  }
  if (!isAllowedMediaUrl(url)) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
      const onKapso = isAllowedMediaUrl(url);
      const res = await doFetch(url.toString(), {
        // Send the key only on Kapso's own hosts; never carry it to a CDN.
        headers: onKapso ? { "X-API-Key": opts.apiKey } : {},
        redirect: "manual",
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        let next: URL;
        try {
          next = new URL(loc, url); // resolve relative Location against current
        } catch {
          return null;
        }
        if (next.protocol !== "https:") return null; // never downgrade / non-http scheme
        url = next;
        continue; // re-evaluate auth for the new origin on the next hop
      }
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
      return {
        base64: Buffer.from(buf).toString("base64"),
        contentType: res.headers.get("content-type"),
      };
    }
    return null; // too many redirects
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Leads: rich conversation fetch (page-based) + lead extraction + handoff parse
// ---------------------------------------------------------------------------

export interface KapsoPaged<T> {
  data: T[];
  meta?: { page?: number; per_page?: number; total_pages?: number; total_count?: number };
  paging?: KapsoPage<T>["paging"];
}

export interface ListRichParams {
  phoneNumberId?: string;
  status?: "active" | "ended";
  lastActiveAfter?: string;
  page?: number;
  perPage?: number;
}

export function listConversationsRichPage(
  opts: KapsoClientOpts,
  p: ListRichParams = {},
): Promise<KapsoPaged<KapsoConversation>> {
  return kapsoGet<KapsoPaged<KapsoConversation>>(opts, "/whatsapp/conversations", {
    phone_number_id: p.phoneNumberId,
    status: p.status,
    last_active_after: p.lastActiveAfter,
    page: p.page ?? 1,
    per_page: p.perPage ?? 100,
  });
}

/** Page through conversations (rich fields). Stops at `sinceIso` or maxPages. */
export async function fetchAllConversationsRich(
  opts: KapsoClientOpts,
  p: ListRichParams,
  sinceIso?: string | null,
  maxPages = 50,
): Promise<KapsoConversation[]> {
  const out: KapsoConversation[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await listConversationsRichPage(opts, { ...p, page });
    const batch = res.data ?? [];
    out.push(...batch);
    const total = res.meta?.total_pages ?? page;
    const oldest = batch[batch.length - 1]?.last_active_at;
    if (!batch.length || page >= total) break;
    if (sinceIso && oldest && oldest <= sinceIso) break; // list is newest-first
  }
  return out;
}

export interface LeadSeed {
  phone: string;
  wa_id: string | null;
  name: string | null;
  kapso_conversation_id: string;
  phone_number_id: string | null; // destination WhatsApp business number
  last_interaction_at: string | null;
  first_seen_at: string | null;
  last_inbound_at?: string | null;
}

/** Extract the lead identity from a Kapso conversation (null if no phone). */
export function conversationToLeadSeed(c: KapsoConversation): LeadSeed | null {
  const phone = normalizePhone((c.phone_number as string) ?? null);
  if (!phone) return null;
  return {
    phone,
    wa_id: (c.wa_id as string) ?? (c.business_scoped_user_id as string) ?? null,
    name: (c.contact_name as string) ?? c.kapso?.contact_name ?? null,
    kapso_conversation_id: String(c.id),
    phone_number_id: (c.phone_number_id as string) ?? null,
    last_interaction_at: (c.last_active_at as string) ?? c.kapso?.last_message_timestamp ?? null,
    first_seen_at: (c.created_at as string) ?? null,
    last_inbound_at:
      ((c.kapso?.last_inbound_at as string | null | undefined) ??
        (c.last_inbound_at as string | null | undefined)) ||
      null,
  };
}

export interface HandoffInfo {
  conversationId: string | null;
  phone: string | null;
  name: string | null;
  reason: string | null;
  context: string | null;
}

/**
 * Decide how to handle an incoming Kapso webhook. Kapso runs two webhook
 * systems that can target the same endpoint:
 *   - Platform webhooks → `workflow.execution.handoff` (hot lead).
 *   - WhatsApp webhooks  → `whatsapp.conversation.ended` / `.inactive` (abandono).
 * Delivery-status message events update the reliable outbox; inbound message
 * events are acknowledged without a second ingestion path. Routing prefers the
 * `X-Webhook-Event` header (passed in as `event`) and falls back to the shape.
 */
export type KapsoEventKind = "handoff" | "conversation" | "message_status" | "skip";

export function classifyKapsoEvent(event: string | null | undefined, body: any): KapsoEventKind {
  const e = (event ?? body?.event ?? body?.type ?? "").toString().toLowerCase();
  if (e.includes("workflow.execution.handoff")) return "handoff";
  if (e.startsWith("whatsapp.conversation.")) return "conversation";
  if (
    e.startsWith("whatsapp.message.") &&
    (["sent", "delivered", "read", "failed"].some((status) => e.endsWith(`.${status}`)) ||
      [body?.status, body?.message?.status, body?.data?.message?.status].some((status) =>
        ["sent", "delivered", "read", "failed"].includes(String(status ?? "").toLowerCase()),
      ))
  ) {
    return "message_status";
  }
  if (e.startsWith("whatsapp.message.")) return "skip";
  // No/unknown event header — infer from payload shape.
  if (
    body?.reason != null ||
    body?.context_summary != null ||
    body?.execution != null ||
    body?.workflow_execution != null
  ) {
    return "handoff";
  }
  if (body?.conversation != null) return "conversation";
  if (
    Array.isArray(body?.statuses) ||
    Array.isArray(body?.data?.statuses) ||
    (Array.isArray(body?.entry) && body.entry.some((entry: any) =>
      entry?.changes?.some((change: any) => Array.isArray(change?.value?.statuses)),
    ))
  ) {
    return "message_status";
  }
  return "skip";
}

/** Best-effort extraction of a Kapso `workflow.execution.handoff` payload. */
export function parseHandoffPayload(body: any): HandoffInfo {
  const conv = body?.conversation ?? body?.data?.conversation ?? {};
  const exec = body?.execution ?? body?.workflow_execution ?? body?.data ?? {};
  const reason =
    body?.reason ?? exec?.reason ?? exec?.handoff_reason ?? exec?.context?.reason ?? null;
  const context =
    body?.context_summary ??
    exec?.context_summary ??
    exec?.context?.context_summary ??
    exec?.contextData?.context_summary ??
    exec?.input?.context_summary ??
    null;
  return {
    conversationId: conv?.id ?? body?.conversation_id ?? exec?.conversation_id ?? null,
    phone: normalizePhone(conv?.phone_number ?? body?.phone_number ?? null),
    name: conv?.contact_name ?? conv?.kapso?.contact_name ?? null,
    reason: reason ? String(reason) : null,
    context: context ? String(context) : null,
  };
}
