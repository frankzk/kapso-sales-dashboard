// La lectura de la conversación en la API oficial de Chatby (MOM §25,
// «Chatby», 26-10-2026). Las reglas puras están en lib/chatby-conversation.ts;
// aquí van las dos llamadas, el tope y la caché.
//
//   1. `GET /subscribers?phone=%2B51…&limit=5`  → el `user_ns` de la clienta.
//   2. `GET /subscriber/chat-messages?user_ns=…&limit=20&include_bot=1&include_note=1`
//      → sus mensajes (`include_bot=1` es obligatorio: sin él no salen las
//      plantillas; `include_system` no se pide, es ruido).
//
// Para leer, solo esos dos GET. Chatby no tiene claves de solo lectura: con la
// clave «KAPTA» se pueden mandar mensajes, y Kapta solo lo hace cuando una
// persona responde desde la pestaña «Chatby» de la ficha (owner, 02-11-2026;
// `sendChatbyReply`):
//
//   3. `POST /subscriber/send-content` con `send_as_agent: 1` → el texto, como
//      persona del equipo (no como bot).
//   4. `POST /subscriber/pause-bot` → el bot de esa clienta en pausa, para que
//      no hable encima.
//
// La clave llega como argumento (la lee la acción del servidor de
// `CHATBY_API_KEY`): este archivo no la guarda ni la escribe en ningún registro.
// Tampoco escribe las respuestas: si Chatby falla, el registro lleva el paso y
// el código HTTP, nada más.

import {
  CHATBY_MESSAGES_LIMIT,
  chatbyInboxUrl,
  chatbyPhone,
  mapChatbyMessages,
  pickChatbySubscriber,
  type ChatbyConversation,
} from "@/lib/chatby-conversation";

export const CHATBY_API_BASE = "https://app.chatby.io/api";
/** Tope de toda la lectura (las dos llamadas): la ficha no espera más. */
export const CHATBY_TIMEOUT_MS = 5_000;
/** Lo leído se reusa un minuto: abrir y cerrar la pestaña no vuelve a llamar. */
export const CHATBY_CACHE_MS = 60_000;
const CACHE_MAX = 300;

/** Por celular: la conversación, un minuto. Datos personales: nunca más que eso. */
const cache = new Map<string, { at: number; value: ChatbyConversation }>();

/** Para las pruebas. */
export function clearChatbyCache(): void {
  cache.clear();
}

/** Olvida la conversación guardada de ese celular: después de responder, la ficha la vuelve a leer con lo enviado. */
export function forgetChatbyConversation(phone: string | null | undefined): void {
  const key = chatbyPhone(phone);
  if (key) cache.delete(key);
}

class ChatbyHttpError extends Error {
  constructor(
    readonly step: "subscribers" | "chat-messages" | "send-content" | "pause-bot",
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** El texto que se le enseña al equipo según lo que respondió Chatby. */
function errorMessage(cause: unknown): string {
  if (cause instanceof ChatbyHttpError) {
    if (cause.status === 401 || cause.status === 403) {
      return "Chatby rechazó la clave de Kapta: está mal copiada o la revocaron. Avísale al owner.";
    }
    return `Chatby respondió ${cause.status}${cause.message ? `: ${cause.message}` : ""}.`;
  }
  if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
    return `Chatby no respondió en ${CHATBY_TIMEOUT_MS / 1000} segundos.`;
  }
  return "No hubo conexión con Chatby.";
}

async function failure(res: Response, step: ChatbyHttpError["step"]): Promise<ChatbyHttpError> {
  // `{"message": "…"}` en los 400. Se enseña recortado; nunca el cuerpo entero.
  let message = "";
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body?.message === "string") message = body.message.trim().slice(0, 160);
  } catch {
    /* sin cuerpo legible */
  }
  return new ChatbyHttpError(step, res.status, message);
}

async function getJson(
  url: string,
  step: ChatbyHttpError["step"],
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw await failure(res, step);
  return res.json();
}

type ChatbyWriteAnswer = { status?: unknown; message?: unknown };

async function postJson(
  url: string,
  step: ChatbyHttpError["step"],
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHATBY_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw await failure(res, step);
  // Algunas respuestas de Chatby vienen con 200 y `{"status": "error", "message": …}`.
  let answer: ChatbyWriteAnswer | null = null;
  try {
    answer = (await res.json()) as ChatbyWriteAnswer;
  } catch {
    /* 200 sin cuerpo: hecho */
  }
  if (typeof answer?.status === "string" && !["ok", "success"].includes(answer.status.toLowerCase())) {
    throw new ChatbyHttpError(step, res.status, typeof answer.message === "string" ? answer.message.trim().slice(0, 160) : "");
  }
}

/**
 * La conversación de la clienta con ese celular: a pedido, solo lectura, con
 * un tope de 5 s y un minuto de caché. Nunca lanza: lo que falla vuelve como
 * `error`, para que la ficha siga entera.
 */
export async function fetchChatbyConversation(input: {
  phone: string | null | undefined;
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<ChatbyConversation> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) return { status: "sin_clave" };
  const phone = chatbyPhone(input.phone);
  if (!phone) return { status: "sin_celular" };

  const now = input.now ?? Date.now;
  const hit = cache.get(phone);
  if (hit && now() - hit.at < CHATBY_CACHE_MS) return hit.value;

  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHATBY_TIMEOUT_MS);
  let userNs: string | null = null;
  try {
    const found = pickChatbySubscriber(
      await getJson(
        `${CHATBY_API_BASE}/subscribers?phone=${encodeURIComponent(phone)}&limit=5`,
        "subscribers",
        apiKey,
        controller.signal,
        fetchImpl,
      ),
    );
    let value: ChatbyConversation;
    if (!found) {
      value = { status: "sin_conversacion" };
    } else {
      userNs = found.userNs;
      const params = new URLSearchParams({
        user_ns: found.userNs,
        limit: String(CHATBY_MESSAGES_LIMIT),
        include_bot: "1",
        include_note: "1",
      });
      const messages = mapChatbyMessages(
        await getJson(`${CHATBY_API_BASE}/subscriber/chat-messages?${params}`, "chat-messages", apiKey, controller.signal, fetchImpl),
      );
      value = { status: "ok", userNs: found.userNs, name: found.name, inboxUrl: chatbyInboxUrl(found.userNs), messages };
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(phone, { at: now(), value });
    return value;
  } catch (cause) {
    // El paso y el código, nunca la respuesta, el celular ni la clave.
    console.error(
      `[chatby] ${JSON.stringify({
        paso: cause instanceof ChatbyHttpError ? cause.step : "red",
        status: cause instanceof ChatbyHttpError ? cause.status : null,
        error: cause instanceof Error ? cause.name : "desconocido",
      })}`,
    );
    return { status: "error", message: errorMessage(cause), inboxUrl: userNs ? chatbyInboxUrl(userNs) : null };
  } finally {
    clearTimeout(timer);
  }
}

export type ChatbyReplyResult =
  /** Se mandó. `paused` dice si además quedó el bot en pausa. */
  | { status: "ok"; paused: boolean }
  | { status: "error"; message: string };

/**
 * Manda el texto de una persona del equipo a la clienta, como agente (no como
 * bot), y deja el bot de esa clienta en pausa `pauseMinutes` (MOM §25,
 * «Chatby», 02-11-2026). Si la pausa falla, el mensaje igual salió: se dice y
 * no se reintenta el envío. Nunca lanza; el registro lleva el paso y el código.
 */
export async function sendChatbyReply(input: {
  userNs: string;
  text: string;
  apiKey: string;
  pauseMinutes: number;
  fetchImpl?: typeof fetch;
}): Promise<ChatbyReplyResult> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) return { status: "error", message: "Falta la clave «KAPTA» de Chatby en Kapta (CHATBY_API_KEY)." };
  const fetchImpl = input.fetchImpl ?? fetch;
  const log = (cause: unknown) =>
    console.error(
      `[chatby] ${JSON.stringify({
        paso: cause instanceof ChatbyHttpError ? cause.step : "red",
        status: cause instanceof ChatbyHttpError ? cause.status : null,
        error: cause instanceof Error ? cause.name : "desconocido",
      })}`,
    );
  try {
    await postJson(
      `${CHATBY_API_BASE}/subscriber/send-content`,
      "send-content",
      apiKey,
      {
        user_ns: input.userNs,
        send_as_agent: 1,
        data: { version: "v1", content: { messages: [{ type: "text", text: input.text }] } },
      },
      fetchImpl,
    );
  } catch (cause) {
    log(cause);
    return { status: "error", message: errorMessage(cause) };
  }
  try {
    await postJson(
      `${CHATBY_API_BASE}/subscriber/pause-bot`,
      "pause-bot",
      apiKey,
      { user_ns: input.userNs, minutes: input.pauseMinutes },
      fetchImpl,
    );
    return { status: "ok", paused: true };
  } catch (cause) {
    log(cause);
    return { status: "ok", paused: false };
  }
}
