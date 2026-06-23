// Kapso Platform API client.
// Base: https://api.kapso.ai/platform/v1  — header: X-API-Key.
//
// Endpoints (confirmed against docs.kapso.ai):
//   GET /whatsapp/conversations                     — list (cursor pagination)
//   GET /whatsapp/messages                          — list (cursor pagination)
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

export interface ListMessagesParams {
  phoneNumberId?: string;
  conversationId?: string;
  direction?: "inbound" | "outbound";
  status?: string;
  messageType?: string;
  limit?: number;
  after?: string;
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
  });
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
  const ms = Date.parse(String(t));
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

export interface ConversationTiming {
  inbound_count: number;
  first_response_seconds: number | null;
}

/**
 * First-inbound → first-outbound delta (seconds) + inbound message count for a
 * conversation. Returns null if messages can't be read. Never throws.
 */
export async function fetchConversationTiming(
  opts: KapsoClientOpts,
  conversationId: string,
): Promise<ConversationTiming | null> {
  let page: KapsoPage<any>;
  try {
    page = await listMessages(opts, { conversationId, limit: 100 });
  } catch {
    return null;
  }
  const msgs = (page.data ?? [])
    .map((m) => ({ t: msgTimeMs(m), dir: msgDirection(m) }))
    .filter((m): m is { t: number; dir: "inbound" | "outbound" } => m.t != null && m.dir != null)
    .sort((a, b) => a.t - b.t);
  if (!msgs.length) return null;

  const inbound_count = msgs.filter((m) => m.dir === "inbound").length;
  const firstInbound = msgs.find((m) => m.dir === "inbound");
  let first_response_seconds: number | null = null;
  if (firstInbound) {
    const reply = msgs.find((m) => m.dir === "outbound" && m.t >= firstInbound.t);
    if (reply) first_response_seconds = Math.max(0, Math.round((reply.t - firstInbound.t) / 1000));
  }
  return { inbound_count, first_response_seconds };
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
  last_interaction_at: string | null;
  first_seen_at: string | null;
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
    last_interaction_at: (c.last_active_at as string) ?? c.kapso?.last_message_timestamp ?? null,
    first_seen_at: (c.created_at as string) ?? null,
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
 * Message events are acknowledged but ignored. Routing prefers the
 * `X-Webhook-Event` header (passed in as `event`) and falls back to the shape.
 */
export type KapsoEventKind = "handoff" | "conversation" | "skip";

export function classifyKapsoEvent(event: string | null | undefined, body: any): KapsoEventKind {
  const e = (event ?? body?.event ?? body?.type ?? "").toString().toLowerCase();
  if (e.includes("workflow.execution.handoff")) return "handoff";
  if (e.startsWith("whatsapp.conversation.")) return "conversation";
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
