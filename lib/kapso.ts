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
