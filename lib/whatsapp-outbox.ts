import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConversationMessage } from "@/lib/kapso";

export type WhatsappDeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed" | "unknown";

export interface WhatsappStatusEvent {
  providerMessageId: string;
  status: Exclude<WhatsappDeliveryStatus, "pending" | "unknown">;
  at: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface WhatsappOutboxRow {
  id: string;
  store_id: string;
  lead_id: string;
  client_token: string;
  retry_of: string | null;
  provider_message_id: string | null;
  phone_number_id: string;
  to_phone: string;
  kind: string;
  body: string | null;
  status: WhatsappDeliveryStatus;
  retryable: boolean;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
}

const STATUS_RANK: Record<WhatsappDeliveryStatus, number> = {
  pending: 0,
  unknown: 1,
  sent: 2,
  failed: 2,
  delivered: 3,
  read: 4,
};

export function normalizeWhatsappStatus(value: unknown): WhatsappStatusEvent["status"] | null {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "sent" || status === "delivered" || status === "read" || status === "failed") {
    return status;
  }
  return null;
}

export function shouldAdvanceWhatsappStatus(
  current: WhatsappDeliveryStatus,
  incoming: WhatsappStatusEvent["status"],
): boolean {
  if (current === "read") return false;
  if (incoming === "failed") return STATUS_RANK[current] < STATUS_RANK.delivered;
  if (current === "failed" && incoming === "sent") return false;
  return STATUS_RANK[incoming] > STATUS_RANK[current];
}

/** Errors that cannot be fixed by repeating the same payload. */
export function isRetryableWhatsappFailure(code: string | number | null | undefined): boolean {
  return !new Set(["131021", "131026", "131047"]).has(String(code ?? ""));
}

function isoFromTimestamp(value: unknown): string | null {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return new Date(n < 10_000_000_000 ? n * 1000 : n).toISOString();
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function eventFromCandidate(candidate: any, fallbackStatus?: unknown): WhatsappStatusEvent | null {
  if (!candidate || typeof candidate !== "object") return null;
  const status = normalizeWhatsappStatus(candidate.status ?? fallbackStatus);
  const providerMessageId = candidate.id ?? candidate.message_id ?? candidate.messageId ?? candidate.wamid;
  if (!status || typeof providerMessageId !== "string" || !providerMessageId.trim()) return null;
  const error = Array.isArray(candidate.errors) ? candidate.errors[0] : candidate.error;
  return {
    providerMessageId: providerMessageId.trim(),
    status,
    at: isoFromTimestamp(candidate.timestamp ?? candidate.at ?? candidate.updated_at),
    errorCode:
      error?.code != null
        ? String(error.code)
        : candidate.error_code != null
          ? String(candidate.error_code)
          : null,
    errorMessage:
      error?.message != null
        ? String(error.message)
        : error?.title != null
          ? String(error.title)
          : candidate.error_message != null
            ? String(candidate.error_message)
            : null,
  };
}

/** Parse both Meta Cloud API status payloads and Kapso's flattened status events. */
export function parseWhatsappStatusEvents(body: any, eventHeader?: string | null): WhatsappStatusEvent[] {
  const candidates: any[] = [];
  const add = (value: any) => {
    if (Array.isArray(value)) candidates.push(...value);
  };

  add(body?.statuses);
  add(body?.data?.statuses);
  add(body?.value?.statuses);
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) add(change?.value?.statuses);
  }

  const headerStatus = normalizeWhatsappStatus(
    String(eventHeader ?? body?.event ?? body?.type ?? "").split(".").pop(),
  );
  if (body?.message && typeof body.message === "object") candidates.push(body.message);
  if (body?.data?.message && typeof body.data.message === "object") candidates.push(body.data.message);
  if (body && typeof body === "object") candidates.push(body);

  const unique = new Map<string, WhatsappStatusEvent>();
  for (const candidate of candidates) {
    const event = eventFromCandidate(candidate, headerStatus);
    if (event) unique.set(`${event.providerMessageId}:${event.status}`, event);
  }
  return [...unique.values()];
}

export function isMissingWhatsappOutbox(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "42P01" || /whatsapp_outbox.*does not exist/i.test(error?.message ?? "");
}

export async function applyWhatsappStatusEvents(
  admin: SupabaseClient,
  storeId: string,
  events: WhatsappStatusEvent[],
): Promise<number> {
  let updated = 0;
  for (const event of events) {
    const { data, error } = await admin
      .from("whatsapp_outbox")
      .select("id,status")
      .eq("store_id", storeId)
      .eq("provider_message_id", event.providerMessageId)
      .maybeSingle();
    if (error) {
      if (isMissingWhatsappOutbox(error)) return 0;
      throw new Error(`whatsapp_outbox status lookup: ${error.message}`);
    }
    if (!data) continue;
    const current = (data.status as WhatsappDeliveryStatus) ?? "pending";
    if (!shouldAdvanceWhatsappStatus(current, event.status)) continue;
    const at = event.at ?? new Date().toISOString();
    const patch: Record<string, unknown> = {
      status: event.status,
      updated_at: at,
      retryable: event.status === "failed" && isRetryableWhatsappFailure(event.errorCode),
      error_code: event.errorCode,
      error_message: event.errorMessage,
    };
    if (event.status === "sent") patch.sent_at = at;
    if (event.status === "delivered") patch.delivered_at = at;
    if (event.status === "read") patch.read_at = at;
    if (event.status === "failed") patch.failed_at = at;
    const { error: updateError } = await admin
      .from("whatsapp_outbox")
      .update(patch)
      .eq("id", data.id)
      .eq("store_id", storeId);
    if (updateError) throw new Error(`whatsapp_outbox status update: ${updateError.message}`);
    updated++;
  }
  return updated;
}

export async function listLeadWhatsappOutbox(
  admin: SupabaseClient,
  storeId: string,
  leadId: string,
): Promise<WhatsappOutboxRow[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("whatsapp_outbox")
    .select("*")
    .eq("store_id", storeId)
    .eq("lead_id", leadId)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    if (isMissingWhatsappOutbox(error)) return [];
    throw new Error(`whatsapp_outbox list: ${error.message}`);
  }
  return (data ?? []) as WhatsappOutboxRow[];
}

export interface OutboxConversationMessage {
  id: string | null;
  direction: "inbound" | "outbound";
  at: string;
  text: string;
  mediaKind: ConversationMessage["mediaKind"];
  mediaUrl: string | null;
  status: string | null;
  outboxId?: string;
  retryable?: boolean;
  error?: string | null;
}

/** Merge provider transcript with local attempts, hiding superseded failed attempts. */
export function mergeTranscriptWithOutbox(
  messages: OutboxConversationMessage[],
  rows: WhatsappOutboxRow[],
  phoneNumberId: string | null,
): OutboxConversationMessage[] {
  const scoped = rows.filter((row) => !phoneNumberId || row.phone_number_id === phoneNumberId);
  const superseded = new Set(scoped.map((row) => row.retry_of).filter(Boolean) as string[]);
  const visible = scoped.filter((row) => !superseded.has(row.id));
  const byProviderId = new Map(visible.filter((row) => row.provider_message_id).map((row) => [row.provider_message_id!, row]));
  const consumed = new Set<string>();
  const merged = messages.map((message) => {
    const row = message.id ? byProviderId.get(message.id) : undefined;
    if (!row) return message;
    consumed.add(row.id);
    const providerStatus = normalizeWhatsappStatus(message.status);
    const status =
      providerStatus && shouldAdvanceWhatsappStatus(row.status, providerStatus)
        ? providerStatus
        : row.status;
    return {
      ...message,
      status,
      outboxId: row.id,
      retryable: status === "failed" ? row.retryable : false,
      error: row.error_message,
    };
  });
  for (const row of visible) {
    if (consumed.has(row.id)) continue;
    merged.push({
      id: row.provider_message_id ?? `outbox:${row.id}`,
      direction: "outbound",
      at: row.created_at,
      text: row.body ?? "",
      mediaKind: null,
      mediaUrl: null,
      status: row.status,
      outboxId: row.id,
      retryable: row.retryable,
      error: row.error_message,
    });
  }
  return merged.sort((a, b) => a.at.localeCompare(b.at));
}
