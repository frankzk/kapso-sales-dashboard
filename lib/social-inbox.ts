// La bandeja de redes de Leads (MOM §25.4): comentarios y mensajes directos de
// Facebook e Instagram que llegan por Zernio. PURO: la firma de los avisos, su
// lectura y los plazos de Meta. La escritura vive en lib/social-inbox-store.ts.


export type SocialPlatform = "facebook" | "instagram";
export type SocialKind = "dm" | "comment";
export type SocialVia = "cliente" | "kapta" | "auto" | "nativo";

export interface NormalizedAccount {
  accountId: string;
  platform: string;
  username: string | null;
  displayName: string | null;
  profileId: string | null;
  pageId: string | null;
}

export interface NormalizedDm {
  kind: "dm";
  account: NormalizedAccount;
  conversation: { externalId: string; participantId: string | null; name: string | null; username: string | null; picture: string | null };
  message: {
    externalId: string;
    direction: "in" | "out";
    text: string | null;
    attachments: Array<{ type: string | null; url: string | null }>;
    authorId: string | null;
    authorName: string | null;
    occurredAt: string;
    via: SocialVia;
  };
}

export interface NormalizedComment {
  kind: "comment";
  account: NormalizedAccount;
  post: { id: string; text: string | null; permalink: string | null; imageUrl: string | null };
  comment: {
    id: string;
    /** El comentario principal del hilo: el mismo id, o el del padre si es una respuesta. */
    threadId: string;
    text: string | null;
    authorId: string | null;
    authorName: string | null;
    authorUsername: string | null;
    isOwn: boolean;
    occurredAt: string;
    adId: string | null;
  };
}

export interface NormalizedAccountEvent { kind: "account"; account: NormalizedAccount; active: boolean }

export type NormalizedEvent = NormalizedDm | NormalizedComment | NormalizedAccountEvent;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function accountOf(payload: Obj): NormalizedAccount | null {
  const a = obj(payload.account);
  const accountId = str(a.accountId) ?? str(a.id);
  if (!accountId) return null;
  const profiles = Array.isArray(payload.profiles) ? payload.profiles.map(obj) : [];
  return {
    accountId,
    platform: (str(a.platform) ?? "").toLowerCase(),
    username: str(a.username),
    displayName: str(a.displayName),
    profileId: str(a.profileId) ?? str(profiles[0]?.id),
    pageId: str(a.pageId),
  };
}

/** Solo Facebook e Instagram entran a la bandeja (MOM §25.4). */
export function isSocialPlatform(p: string | null | undefined): p is SocialPlatform {
  return p === "facebook" || p === "instagram";
}

function viaOf(direction: "in" | "out", sentVia: string | null): SocialVia {
  if (direction === "in") return "cliente";
  if (!sentVia) return "nativo";
  if (sentVia === "api") return "kapta";
  return "auto";
}

/**
 * Lee un aviso de Zernio. Devuelve null para lo que la bandeja no guarda
 * (otras redes, lecturas, reacciones, pruebas). Defensivo: Zernio agrega
 * campos sin avisar y deja caer los desconocidos.
 */
export function normalizeZernioEvent(raw: unknown): NormalizedEvent | null {
  const payload = obj(raw);
  const event = str(payload.event);
  if (!event || payload.test === true) return null;
  const account = accountOf(payload);
  if (!account) return null;

  if (event === "account.connected" || event === "account.disconnected") {
    return { kind: "account", account, active: event === "account.connected" };
  }

  if (event === "message.received" || event === "message.sent") {
    const m = obj(payload.message);
    const c = obj(payload.conversation);
    const platform = (str(m.platform) ?? account.platform).toLowerCase();
    if (!isSocialPlatform(platform)) return null;
    const conversationId = str(m.conversationId) ?? str(c.id);
    const externalId = str(m.platformMessageId) ?? str(m.id);
    if (!conversationId || !externalId) return null;
    const direction: "in" | "out" = str(m.direction) === "outgoing" ? "out" : "in";
    const sender = obj(m.sender);
    const attachments = (Array.isArray(m.attachments) ? m.attachments : []).map((x) => {
      const att = obj(x);
      return { type: str(att.type), url: str(att.url) };
    });
    return {
      kind: "dm",
      account: { ...account, platform },
      conversation: {
        externalId: conversationId,
        participantId: str(c.participantId) ?? (direction === "in" ? str(sender.id) : null),
        name: str(c.participantName) ?? (direction === "in" ? str(sender.name) : null),
        username: str(c.participantUsername) ?? (direction === "in" ? str(sender.username) : null),
        picture: str(c.participantPicture),
      },
      message: {
        externalId,
        direction,
        text: str(m.text),
        attachments,
        authorId: str(sender.id),
        authorName: str(sender.name) ?? str(sender.username),
        occurredAt: str(m.sentAt) ?? str(payload.timestamp) ?? new Date().toISOString(),
        via: viaOf(direction, str(m.sentVia)),
      },
    };
  }

  if (event === "comment.received") {
    const cm = obj(payload.comment);
    const post = obj(payload.post);
    const platform = (str(cm.platform) ?? account.platform).toLowerCase();
    if (!isSocialPlatform(platform)) return null;
    const id = str(cm.id);
    const postId = str(cm.platformPostId) ?? str(post.platformPostId);
    if (!id || !postId) return null;
    const author = obj(cm.author);
    const parent = str(cm.parentCommentId);
    return {
      kind: "comment",
      account: { ...account, platform },
      post: { id: postId, text: str(post.content), permalink: str(post.permalink), imageUrl: str(post.imageUrl) },
      comment: {
        id,
        threadId: parent ?? id,
        text: str(cm.text),
        authorId: str(author.id),
        authorName: str(author.name) ?? str(author.username),
        authorUsername: str(author.username),
        isOwn: author.isOwnAccount === true,
        occurredAt: str(cm.createdAt) ?? str(payload.timestamp) ?? new Date().toISOString(),
        adId: str(obj(cm.ad).id),
      },
    };
  }
  return null;
}

const HOUR = 3_600_000;

/**
 * Cómo se puede contestar un mensaje directo, según Meta:
 * - `libre`: dentro de 24 h del último mensaje de la clienta.
 * - `humano`: entre 24 h y 7 días, solo si lo escribe una persona (etiqueta HUMAN_AGENT).
 * - `cerrado`: más de 7 días; Meta no deja escribir hasta que la clienta vuelva a escribir.
 */
export function dmReplyMode(lastInboundAt: string | null | undefined, now: Date = new Date()): "libre" | "humano" | "cerrado" {
  const at = Date.parse(lastInboundAt ?? "");
  if (!Number.isFinite(at)) return "cerrado";
  const age = now.getTime() - at;
  if (age <= 24 * HOUR) return "libre";
  if (age <= 7 * 24 * HOUR) return "humano";
  return "cerrado";
}

/** La respuesta por privado a un comentario: una sola y dentro de 7 días desde el comentario. */
export function privateReplyAllowed(thread: { kind: SocialKind; private_reply_at?: string | null; created_at?: string | null }, firstCommentAt: string | null | undefined, now: Date = new Date()): boolean {
  if (thread.kind !== "comment" || thread.private_reply_at) return false;
  const at = Date.parse(firstCommentAt ?? "");
  return Number.isFinite(at) && now.getTime() - at <= 7 * 24 * HOUR;
}

/** La red dicha en pantalla. */
export function socialPlatformLabel(p: string): string {
  return p === "instagram" ? "Instagram" : p === "facebook" ? "Facebook" : p;
}

/** «Comentario» o «Mensaje directo» (Messenger en Facebook). */
export function socialKindLabel(kind: SocialKind, platform: string): string {
  if (kind === "comment") return "Comentario";
  return platform === "facebook" ? "Messenger" : "Mensaje directo";
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * La tienda de una cuenta recién conectada, por su nombre: la cuenta
 * «Kenku Peru» o @kenku.peru es de la tienda cuya primera palabra es «kenku».
 * Solo si una sola tienda calza; si no, queda sin tienda y un responsable la
 * elige en Leads → Redes. PURO.
 */
export function matchStoreForAccount(
  account: Pick<NormalizedAccount, "username" | "displayName">,
  stores: ReadonlyArray<{ id: string; name: string }>,
): string | null {
  const hay = fold(`${account.displayName ?? ""} ${account.username ?? ""}`);
  if (!hay.trim()) return null;
  const hits = stores.filter((s) => {
    const first = fold(s.name).split(/[^a-z0-9]+/).find((w) => w.length >= 3);
    return Boolean(first && hay.includes(first));
  });
  return hits.length === 1 ? hits[0]!.id : null;
}
