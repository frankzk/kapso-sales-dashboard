// La conversación de WhatsApp de la clienta con el bot de confirmación, en la
// ficha del pedido (MOM §25, «WhatsApp», 26-10-2026, pedido del owner).
//
// Chatby (`app.chatby.io`, white-label de uChat) es el bot que confirma los
// pedidos contra entrega de la web: el mismo bot y el mismo número para Kenku y
// Aurela. El equipo salía de Kapta para ver qué se le dijo a la clienta. Ahora
// la ficha lo lee de la API oficial, a pedido y solo para leer, con el contrato
// de docs/kapta/chatby-conversaciones.md (probado el 25-10-2026 contra la API
// real). La llamada vive en lib/chatby-api.ts; este archivo es puro (sin red,
// sin claves) para que la ficha y las pruebas usen las mismas reglas.
//
// De cada respuesta se copian SOLO los campos de abajo. Lo demás —sobre todo
// los campos del contacto (`user_fields`), que traen la clave de pedidos de una
// tienda— no sale de la lectura: ni a la pantalla, ni a la base, ni a los
// registros.

/** Quién escribió: la clienta, el bot, una persona del equipo o una nota interna. */
export type ChatbyMessageKind = "cliente" | "bot" | "equipo" | "nota" | "otro";

export type ChatbyMediaKind = "imagen" | "audio" | "video" | "archivo";

export interface ChatbyMessage {
  id: string;
  kind: ChatbyMessageKind;
  /** ISO; null si Chatby no mandó `ts`. */
  at: string | null;
  text: string;
  /** El nombre de la plantilla de WhatsApp («nuevo_pedido_cobertura_lima»). */
  template: string | null;
  /** La clienta tocó un botón (`postback`): `text` es el botón. */
  button: boolean;
  media: ChatbyMediaKind | null;
  /** Solo https. */
  mediaUrl: string | null;
  /** Error de WhatsApp («no entregado»). */
  error: boolean;
  /** Quién del equipo escribió, si Chatby lo dice. */
  agent: string | null;
}

export type ChatbyConversation =
  | { status: "ok"; userNs: string; name: string | null; inboxUrl: string; messages: ChatbyMessage[] }
  /** Chatby no tiene a nadie con ese celular. */
  | { status: "sin_conversacion" }
  /** El pedido no trae un celular que se pueda buscar. */
  | { status: "sin_celular" }
  /** Kapta no tiene la clave de Chatby (`CHATBY_API_KEY`). */
  | { status: "sin_clave" }
  | { status: "error"; message: string; inboxUrl: string | null };

export interface ChatbySubscriber {
  userNs: string;
  name: string | null;
}

/** Los mensajes que se piden: los últimos 20 (MOM §25). */
export const CHATBY_MESSAGES_LIMIT = 20;
const TEXT_MAX = 4_000;
const CHATBY_INBOX_BASE = "https://app.chatby.io/inbox/";

/**
 * El celular como lo busca Chatby: internacional, con el `+` (verificado: con
 * «51…» o los 9 dígitos solos devuelve 0 resultados). 9 dígitos que empiezan
 * con 9 → `+51` delante; 11 que empiezan con 51 → `+` delante; uno que ya viene
 * con `+`, tal cual. Lo demás no se busca.
 */
export function chatbyPhone(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  const digits = text.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("9")) return `+51${digits}`;
  if (digits.length === 11 && digits.startsWith("51")) return `+${digits}`;
  if (text.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** El `user_ns` va en la dirección de Chatby: solo letras, dígitos, `_` y `-`. */
function safeUserNs(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/** El enlace a la conversación en el panel de Chatby (el mismo que usa su panel). */
export function chatbyInboxUrl(userNs: string): string {
  return `${CHATBY_INBOX_BASE}${encodeURIComponent(userNs)}`;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, TEXT_MAX) : null;
}

/** Milisegundos de una fecha de Chatby: unix en segundos, milisegundos o texto. */
function timeOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function rowsOf(body: unknown): Record<string, unknown>[] {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
  return Array.isArray(data) ? data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : [];
}

/**
 * La clienta de `GET /subscribers?phone=…`: de cada fila solo `user_ns` y
 * `name`. Con más de una (raro), la de `last_message_at` más reciente.
 */
export function pickChatbySubscriber(body: unknown): ChatbySubscriber | null {
  let best: { sub: ChatbySubscriber; at: number } | null = null;
  for (const row of rowsOf(body)) {
    const userNs = safeUserNs(row.user_ns);
    if (!userNs) continue;
    const at = timeOf(row.last_message_at) ?? 0;
    if (!best || at > best.at) best = { sub: { userNs, name: text(row.name) }, at };
  }
  return best?.sub ?? null;
}

function payloadOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* no es JSON: sin payload */
    }
  }
  return {};
}

const KIND_BY_TYPE: Record<string, ChatbyMessageKind> = { in: "cliente", out: "bot", agent: "equipo", note: "nota" };

const MEDIA_BY_TYPE: Record<string, ChatbyMediaKind> = {
  image: "imagen",
  audio: "audio",
  voice: "audio",
  video: "video",
  file: "archivo",
  document: "archivo",
};

function httpsUrl(value: unknown): string | null {
  const t = text(value);
  if (!t || !/^https:\/\/[^\s]+$/i.test(t)) return null;
  try {
    return new URL(t).protocol === "https:" ? t : null;
  } catch {
    return null;
  }
}

/** Un mensaje de `GET /subscriber/chat-messages`, o null si no se muestra. */
function mapMessage(row: Record<string, unknown>, index: number): (ChatbyMessage & { ms: number | null; order: number }) | null {
  const type = typeof row.type === "string" ? row.type : "";
  // Los eventos internos («Tag added…») no se piden; si llegan, no se muestran.
  if (type === "system") return null;
  const kind = KIND_BY_TYPE[type] ?? "otro";
  const msgType = typeof row.msg_type === "string" ? row.msg_type : "";
  const payload = payloadOf(row.payload);
  const content = text(row.content);
  const ms = timeOf(row.ts);
  const base: ChatbyMessage = {
    id: String(row.id ?? row.mid ?? `m${index}`),
    kind,
    at: ms === null ? null : new Date(ms).toISOString(),
    text: content ?? "",
    template: null,
    button: false,
    media: null,
    mediaUrl: null,
    error: false,
    agent: kind === "equipo" ? text(row.username) : null,
  };
  if (msgType === "text" || msgType === "") {
    base.text = content ?? text(payload.text) ?? "";
  } else if (msgType === "wa_template") {
    // Lo que leyó la clienta está en `payload.body`; `content` dice «ES <nombre>».
    base.template = text(payload.name);
    base.text = text(payload.body) ?? content ?? "";
  } else if (msgType === "postback") {
    base.button = true;
    base.text = text(payload.title) ?? content ?? "";
  } else if (MEDIA_BY_TYPE[msgType]) {
    base.media = MEDIA_BY_TYPE[msgType];
    base.mediaUrl = httpsUrl(payload.url) ?? httpsUrl(payload.link) ?? httpsUrl(payload.file_url) ?? httpsUrl(content);
    base.text = content && content !== base.mediaUrl ? content : text(payload.caption) ?? "";
  } else if (msgType === "error") {
    base.error = true;
    base.text = content ?? "WhatsApp no entregó el mensaje.";
  } else {
    base.text = content ?? `[${msgType}]`;
  }
  if (!base.text && !base.media) return null;
  return { ...base, ms, order: index };
}

/**
 * Los mensajes para mostrar, del más viejo (arriba) al más nuevo (abajo).
 * Chatby los manda al revés (verificado); se ordenan por `ts` en vez de solo
 * invertir, por si algún día llegan mezclados. Sin `ts`, donde venían.
 */
export function mapChatbyMessages(body: unknown): ChatbyMessage[] {
  const rows = rowsOf(body)
    .map(mapMessage)
    .filter((m): m is NonNullable<ReturnType<typeof mapMessage>> => m !== null);
  // Venían del más nuevo al más viejo: el índice invertido es el orden de respaldo.
  rows.sort((a, b) => {
    if (a.ms !== null && b.ms !== null && a.ms !== b.ms) return a.ms - b.ms;
    return b.order - a.order;
  });
  return rows.map(({ ms: _ms, order: _order, ...message }) => message);
}

const LIMA_PARTS = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function limaParts(iso: string): Record<string, string> | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const out: Record<string, string> = {};
  for (const part of LIMA_PARTS.formatToParts(date)) out[part.type] = part.value;
  return out;
}

/** «2026-10-25»: el día en Lima, para agrupar los mensajes por día. */
export function chatbyLimaDay(iso: string | null): string | null {
  const p = iso ? limaParts(iso) : null;
  return p ? `${p.year}-${p.month}-${p.day}` : null;
}

/** «12:57»: la hora en Lima, dentro del globo. */
export function chatbyLimaTime(iso: string | null): string {
  const p = iso ? limaParts(iso) : null;
  return p ? `${p.hour}:${p.minute}` : "";
}

/** «Hoy», «Ayer» o «25-10-2026», contado en Lima. */
export function chatbyDayLabel(day: string, now: Date = new Date()): string {
  const today = chatbyLimaDay(now.toISOString());
  const yesterday = chatbyLimaDay(new Date(now.getTime() - 86_400_000).toISOString());
  if (day === today) return "Hoy";
  if (day === yesterday) return "Ayer";
  const [y, m, d] = day.split("-");
  return `${d}-${m}-${y}`;
}

/**
 * ¿El mensaje nombra este pedido? Las plantillas dicen el número («Hemos
 * recibido tu pedido #KP200123»); como Kenku y Aurela comparten el bot, en la
 * misma conversación puede haber pedidos de las dos marcas, y así se ve cuál es
 * el de esta ficha. Con o sin `#`, sin distinguir mayúsculas y sin confundir
 * #KP2001 con #KP20012.
 */
export function chatbyMentionsOrder(message: Pick<ChatbyMessage, "text">, orderName: string | null | undefined): boolean {
  const name = (orderName ?? "").replace(/^#/, "").trim();
  if (name.length < 3) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])#?${escaped}(?![A-Za-z0-9])`, "i").test(message.text);
}
