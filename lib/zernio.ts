import "server-only";

// Cliente de la API de Zernio (zernio.com), la que pone Kapta delante de Meta
// para los comentarios y mensajes directos de Facebook e Instagram (MOM §25.4).
//
// Base `https://zernio.com/api`, rutas `/v1/...`, `Authorization: Bearer <clave>`.
// La clave vive SOLO en Vercel (`ZERNIO_API_KEY`); nunca se escribe en la base
// ni se registra. Errores: `{ error, type, code, param, details }` → ZernioError.
// Los envíos llevan `Idempotency-Key` (24 h en Zernio): un reintento con la misma
// llave no manda dos veces.

const BASE = "https://zernio.com/api";

export class ZernioError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ZernioError";
  }
}

export function zernioConfigured(): boolean {
  return Boolean(process.env.ZERNIO_API_KEY?.trim());
}

async function call<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const key = process.env.ZERNIO_API_KEY?.trim();
  if (!key) throw new ZernioError(0, "not_configured", "Falta conectar Zernio (ZERNIO_API_KEY en Vercel).");
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: "no-store", signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new ZernioError(0, "network", `No se pudo contactar a Zernio: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const j = (json ?? {}) as { error?: unknown; code?: unknown; details?: unknown };
    const message = typeof j.error === "string" && j.error ? j.error : `HTTP ${res.status}`;
    throw new ZernioError(res.status, typeof j.code === "string" ? j.code : null, message, j.details ?? null);
  }
  return json as T;
}

export interface ZernioProfile { _id: string; name: string; externalId?: string | null }
export interface ZernioAccount { _id: string; platform: string; username?: string | null; displayName?: string | null; isActive?: boolean; profileId?: string | null; pageId?: string | null; platformUserId?: string | null }
export interface ZernioConversation { id: string; platform: string; accountId: string; participantId?: string; participantName?: string | null; participantPicture?: string | null; lastMessage?: string | null; updatedTime?: string; unreadCount?: number | null; status?: string }
export interface ZernioListedMessage { id: string; conversationId: string; message?: string | null; senderId?: string; senderName?: string | null; direction: "incoming" | "outgoing"; createdAt: string; attachments?: Array<{ type?: string; url?: string }> }
export interface ZernioPostWithComments { id: string; platform: string; accountId: string; content?: string | null; createdTime?: string; commentCount?: number; permalink?: string | null; thumbnailUrl?: string | null; isAd?: boolean }
export interface ZernioComment { id: string; message?: string; createdTime?: string; from?: { id?: string; name?: string; username?: string; picture?: string | null; isOwner?: boolean }; replies?: ZernioComment[]; isHidden?: boolean }

interface Page<T> { data: T[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } }

export const zernio = {
  listProfiles: () => call<{ profiles: ZernioProfile[] }>("GET", "/v1/profiles", { query: { limit: 100 } }),
  listAccounts: (profileId?: string) => call<{ accounts: ZernioAccount[] }>("GET", "/v1/accounts", { query: { profileId } }),
  listConversations: (q: { profileId?: string; accountId?: string; limit?: number; cursor?: string; updatedSince?: string }) =>
    call<Page<ZernioConversation>>("GET", "/v1/inbox/conversations", { query: { ...q, sortOrder: "desc" } }),
  listMessages: (conversationId: string, accountId: string, q: { limit?: number; cursor?: string } = {}) =>
    call<{ messages: ZernioListedMessage[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } }>(
      "GET", `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, { query: { accountId, sortOrder: "desc", ...q } }),
  /** Mensaje directo. `humanAgent`: entre 24 h y 7 días del último mensaje de la clienta, solo si lo escribió una persona. */
  sendMessage: (conversationId: string, body: { accountId: string; message: string; humanAgent?: boolean }, idempotencyKey: string) =>
    call<{ success?: boolean; data?: { messageId?: string; messageIds?: string[]; conversationId?: string } }>(
      "POST", `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
        body: { accountId: body.accountId, message: body.message, ...(body.humanAgent ? { messagingType: "MESSAGE_TAG", messageTag: "HUMAN_AGENT" } : {}) },
        idempotencyKey,
      }),
  listPostsWithComments: (q: { profileId?: string; accountId?: string; limit?: number; cursor?: string }) =>
    call<Page<ZernioPostWithComments>>("GET", "/v1/inbox/comments", { query: { ...q, sortBy: "date", sortOrder: "desc" } }),
  listPostComments: (postId: string, accountId: string, q: { limit?: number; cursor?: string } = {}) =>
    call<{ comments: ZernioComment[]; pagination?: { hasMore?: boolean; cursor?: string | null } }>(
      "GET", `/v1/inbox/comments/${encodeURIComponent(postId)}`, { query: { accountId, ...q } }),
  /** Respuesta pública a un comentario (gratis en Zernio). */
  replyToComment: (postId: string, body: { accountId: string; commentId: string; message: string }, idempotencyKey: string) =>
    call<{ success?: boolean; data?: { commentId?: string; isReply?: boolean } }>(
      "POST", `/v1/inbox/comments/${encodeURIComponent(postId)}`, { body, idempotencyKey }),
  /** Respuesta por privado: una sola por comentario y dentro de 7 días (Meta). Zernio no acepta llave de idempotencia aquí. */
  privateReply: (postId: string, commentId: string, body: { accountId: string; message: string }) =>
    call<{ status?: string; messageId?: string; commentId?: string }>(
      "POST", `/v1/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/private-reply`, { body }),
};
