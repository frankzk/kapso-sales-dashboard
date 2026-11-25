"use client";

// Leads → Redes (MOM §25.4): la bandeja de comentarios y mensajes directos de
// Facebook e Instagram de las tiendas, por Zernio. A la izquierda los hilos; a
// la derecha el hilo abierto, con su post (si es un comentario) y la respuesta.
// Lenguaje del panel (DESIGN.md «Leads → Redes»): página de lista de Stripe,
// el hilo como el chat de Leads y la respuesta siempre al alcance del teclado.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import {
  claimSocialThread,
  getSocialThreadMessages,
  replySocialThread,
  saveSocialAutoSettings,
  setSocialAccountStore,
  setSocialThreadStatus,
  suggestSocialReply,
  syncZernioInbox,
  type SocialAutoSettingsView,
  type SocialMessageView,
} from "@/app/dashboard/leads/redes/actions";
import { Badge, Banner, ChoiceChip, FIELD_BOX, OpsButton, SidePanel, Skeleton } from "@/components/ops-ui";
import { Switch } from "@/components/settings-ui";
import { IconAlert, IconArrowLeft, IconArrowUpRight, IconBot, IconChat, IconCheck, IconClock, IconImage, IconLock, IconRepeat, IconSearch, IconUndo, IconWhatsApp } from "@/components/icons";
import { cn } from "@/components/ui";
import { chatbyDayLabel, chatbyLimaDay, chatbyLimaTime } from "@/lib/chatby-conversation";
import { dmReplyMode, privateReplyAllowed, socialKindLabel, socialPlatformLabel } from "@/lib/social-inbox";

export interface SocialThreadView {
  id: string;
  store_id: string | null;
  account_id: string;
  platform: string;
  kind: "dm" | "comment";
  post_text: string | null;
  post_permalink: string | null;
  post_image_url: string | null;
  ad_id: string | null;
  participant_name: string | null;
  participant_username: string | null;
  participant_picture: string | null;
  last_inbound_at: string | null;
  last_message_at: string | null;
  last_message_text: string | null;
  last_direction: "in" | "out" | null;
  unread: number;
  status: "abierto" | "respondido" | "cerrado";
  private_reply_at: string | null;
  created_at: string;
}

export interface SocialAccountView {
  account_id: string;
  store_id: string | null;
  platform: string;
  username: string | null;
  display_name: string | null;
  active: boolean;
}

type StatusFilter = "pendientes" | "todos" | "cerrados";
type Net = "facebook" | "instagram";
type Kind = "comment" | "dm";

const REFRESH_MS = 20_000;
const MINUTE = 60_000;
/** Desde una hora esperando, la espera se lee en el tono de atención. */
const LATE_MS = 60 * MINUTE;

/** Espera respuesta: abierto y lo último lo dijo la clienta. */
function isPending(t: SocialThreadView): boolean {
  return t.status === "abierto" && t.last_direction === "in";
}

function matchesStatus(t: SocialThreadView, status: StatusFilter): boolean {
  return status === "pendientes" ? isPending(t) : status === "cerrados" ? t.status === "cerrado" : t.status !== "cerrado";
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function matchesQuery(t: SocialThreadView, q: string): boolean {
  if (!q) return true;
  return fold([t.participant_name, t.participant_username, t.last_message_text, t.post_text].filter(Boolean).join(" ")).includes(q);
}

/** «15:42» hoy; «24-11 15:42» otro día. En Lima. */
function when(iso: string | null): string {
  if (!iso) return "";
  const day = chatbyLimaDay(iso);
  const time = chatbyLimaTime(iso);
  if (!day || day === chatbyLimaDay(new Date().toISOString())) return time;
  const [, m, d] = day.split("-");
  return `${d}-${m} ${time}`;
}

/** Cuánto lleva esperando: «ahora», «12 min», «3 h», «2 d». */
function waited(ms: number): string {
  if (ms < MINUTE) return "ahora";
  if (ms < LATE_MS) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < 24 * LATE_MS) return `${Math.floor(ms / LATE_MS)} h`;
  return `${Math.floor(ms / (24 * LATE_MS))} d`;
}

function waitingMs(t: SocialThreadView, now: number): number | null {
  const at = Date.parse(t.last_inbound_at ?? t.last_message_at ?? "");
  return isPending(t) && Number.isFinite(at) ? Math.max(0, now - at) : null;
}

function personName(t: Pick<SocialThreadView, "participant_name" | "participant_username">): string {
  return t.participant_name ?? (t.participant_username ? `@${t.participant_username}` : "Sin nombre");
}

function platformTone(platform: string) {
  return platform === "instagram" ? "fuchsia" : "indigo";
}

/** Con ratón y teclado el campo de respuesta toma el foco al abrir; en el teléfono no (abriría el teclado). */
function finePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;
}

export function SocialInbox({ threads, accounts, stores, canManage, configured, whatsappByStore, autoSettings, aiReady = false }: {
  /** Hay clave de Anthropic: las respuestas automáticas las escribe la IA. */
  aiReady?: boolean;
  whatsappByStore: Record<string, string | null>;
  autoSettings: SocialAutoSettingsView[];
  threads: SocialThreadView[];
  accounts: SocialAccountView[];
  stores: Array<{ id: string; name: string }>;
  canManage: boolean;
  configured: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<StatusFilter>("pendientes");
  const [net, setNet] = useState<Net | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const [syncing, startSync] = useTransition();
  const [syncNotice, setSyncNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Lo nuevo llega por el webhook: la lista se refresca sola cada 20 s, y la espera se recuenta.
  useEffect(() => {
    const id = window.setInterval(() => { router.refresh(); setNow(Date.now()); }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [router]);

  const storeName = useMemo(() => new Map(stores.map((s) => [s.id, s.name])), [stores]);
  const q = fold(query.trim());
  const counts = useMemo(() => ({
    pendientes: threads.filter(isPending).length,
    todos: threads.filter((t) => t.status !== "cerrado").length,
    cerrados: threads.filter((t) => t.status === "cerrado").length,
  }), [threads]);
  // Cada fila de chips cuenta lo que quedaría con los otros filtros puestos.
  const facet = useMemo(() => {
    const base = threads.filter((t) => matchesStatus(t, status) && matchesQuery(t, q));
    const byNet = (n: Net) => base.filter((t) => t.platform === n && (!kind || t.kind === kind)).length;
    const byKind = (k: Kind) => base.filter((t) => t.kind === k && (!net || t.platform === net)).length;
    return { facebook: byNet("facebook"), instagram: byNet("instagram"), comment: byKind("comment"), dm: byKind("dm") };
  }, [threads, status, q, net, kind]);
  const visible = useMemo(() => threads.filter((t) =>
    matchesStatus(t, status) && (!net || t.platform === net) && (!kind || t.kind === kind) && matchesQuery(t, q)), [threads, status, net, kind, q]);
  const selected = threads.find((t) => t.id === selectedId) ?? null;
  const unassigned = accounts.filter((a) => !a.store_id);
  const oldestWait = useMemo(() => threads.reduce<number | null>((max, t) => {
    const w = waitingMs(t, now);
    return w != null && (max == null || w > max) ? w : max;
  }, null), [threads, now]);
  const autoOn = autoSettings.filter((s) => s.enabled).length;
  const filtered = Boolean(net || kind || q);

  function sync() {
    setSyncNotice(null);
    startSync(async () => {
      const res = await syncZernioInbox();
      setSyncNotice(res.ok ? { ok: true, text: res.notice ?? "Sincronizado." } : { ok: false, text: res.error });
      router.refresh();
    });
  }

  /** «Marcar resuelto» pasa a la siguiente de la lista, como «Guardar y pasar al siguiente». */
  function openNextAfter(id: string) {
    const i = visible.findIndex((t) => t.id === id);
    const next = visible.slice(i + 1).find((t) => t.id !== id) ?? visible.slice(0, Math.max(0, i)).find((t) => t.id !== id) ?? null;
    setSelectedId(next?.id ?? null);
  }

  // Flechas arriba y abajo recorren la lista; Enter la abre (abrirla la reserva, por eso no se abre al pasar).
  function onListKey(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-thread]"));
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[i < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) { e.preventDefault(); next.focus(); }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className={cn("flex flex-wrap items-start justify-between gap-3", selected && "hidden lg:flex")}>
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Redes</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Comentarios y mensajes de Facebook e Instagram
            {" · "}
            <span className="tabular-nums">{counts.pendientes.toLocaleString("es-PE")}</span> por responder
            {oldestWait != null && (
              <>
                {" · "}
                <span className={cn("tabular-nums", oldestWait >= LATE_MS && "font-medium text-warn-fg")}>la más antigua espera {waited(oldestWait)}</span>
              </>
            )}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <OpsButton onClick={() => setAutoOpen(true)} aria-haspopup="dialog">
              <IconBot />
              Respuestas automáticas
              <Badge tone={autoOn ? "ok" : "neutral"}>{autoOn ? `${autoOn} de ${autoSettings.length}` : "Apagadas"}</Badge>
            </OpsButton>
            {configured && (
              <OpsButton onClick={sync} disabled={syncing} title="Trae de Zernio las cuentas, las últimas conversaciones y los últimos comentarios">
                <IconRepeat className={cn(syncing && "motion-safe:animate-spin")} />
                {syncing ? "Sincronizando…" : "Sincronizar redes"}
              </OpsButton>
            )}
          </div>
        )}
      </header>

      {!configured && (
        canManage ? (
          <Banner tone="warn" title="Falta conectar Zernio">
            Kapta lee y responde las redes por Zernio. Falta la clave <code>ZERNIO_API_KEY</code> en Vercel (y <code>ZERNIO_WEBHOOK_SECRET</code> para recibir lo nuevo al instante).
          </Banner>
        ) : (
          <Banner tone="info" title="La bandeja todavía no está conectada">
            Cuando quien administra las tiendas conecte las redes, aquí llegan los comentarios y mensajes para responder.
          </Banner>
        )
      )}
      {syncNotice && <Banner tone={syncNotice.ok ? "ok" : "crit"} role="status">{syncNotice.text}</Banner>}
      {canManage && unassigned.length > 0 && <UnassignedAccounts accounts={unassigned} stores={stores} onDone={() => router.refresh()} />}

      {/* Una sola fila de chips: qué lista se mira, y tras una raya la red y el tipo (volver a tocar uno lo quita). */}
      <div className={cn("flex flex-wrap items-center gap-1.5", selected && "hidden lg:flex")} aria-label="Filtros">
        <ChoiceChip label="Por responder" count={counts.pendientes} active={status === "pendientes"} onClick={() => setStatus("pendientes")} />
        <ChoiceChip label="Abiertas" count={counts.todos} active={status === "todos"} onClick={() => setStatus("todos")} title="Todo lo que no está resuelto, respondido o no" />
        <ChoiceChip label="Resueltas" count={counts.cerrados} active={status === "cerrados"} onClick={() => setStatus("cerrados")} />
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line-strong sm:block" />
        <ChoiceChip label="Facebook" count={facet.facebook} active={net === "facebook"} onClick={() => setNet((v) => (v === "facebook" ? null : "facebook"))} />
        <ChoiceChip label="Instagram" count={facet.instagram} active={net === "instagram"} onClick={() => setNet((v) => (v === "instagram" ? null : "instagram"))} />
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line-strong sm:block" />
        <ChoiceChip label="Comentarios" count={facet.comment} active={kind === "comment"} onClick={() => setKind((v) => (v === "comment" ? null : "comment"))} />
        <ChoiceChip label="Mensajes directos" count={facet.dm} active={kind === "dm"} onClick={() => setKind((v) => (v === "dm" ? null : "dm"))} />
        {filtered && (
          <OpsButton size="sm" variant="ghost" onClick={() => { setNet(null); setKind(null); setQuery(""); }}>Quitar filtros</OpsButton>
        )}
      </div>

      <div className="grid gap-4 lg:h-[calc(100dvh-14rem)] lg:min-h-[560px] lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <section className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line", selected && "hidden lg:flex")} aria-label="Conversaciones">
          <div className="space-y-2 border-b border-line px-4 py-3">
            <p className="flex items-baseline justify-between gap-2 text-sm font-semibold text-ink-900">
              {status === "pendientes" ? "Por responder" : status === "cerrados" ? "Resueltas" : "Abiertas"}
              <span className="text-[13px] font-medium tabular-nums text-ink-500">{visible.length.toLocaleString("es-PE")}</span>
            </p>
            <label className="relative block">
              <span className="sr-only">Buscar por nombre o texto</span>
              <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Buscar por nombre o texto"
                className={cn(FIELD_BOX, "h-8 w-full pl-8 pr-3 pointer-coarse:h-11")}
              />
            </label>
          </div>
          <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto overscroll-contain" onKeyDown={onListKey}>
            {visible.length === 0 && (
              <li className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
                <IconCheck aria-hidden className="size-5 text-ink-500" />
                <p className="text-sm font-medium text-ink-900">
                  {threads.length === 0 ? "Todavía no llegó nada de las redes" : filtered ? "Nada con estos filtros" : status === "pendientes" ? "Todo respondido" : "No hay conversaciones aquí"}
                </p>
                <p className="max-w-[32ch] text-[13px] leading-5 text-ink-500">
                  {threads.length === 0
                    ? canManage && configured ? "Toca «Sincronizar redes» para traer las últimas conversaciones y comentarios." : "Los comentarios y mensajes nuevos aparecen aquí solos."
                    : filtered ? "Quita un filtro o cambia la búsqueda." : "Lo nuevo aparece aquí solo; la lista se revisa cada 20 segundos."}
                </p>
              </li>
            )}
            {visible.map((t) => {
              const wait = waitingMs(t, now);
              const dmWindow = t.kind === "dm" && isPending(t) ? dmReplyMode(t.last_inbound_at, new Date(now)) : null;
              const current = t.id === selectedId;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    data-thread
                    onClick={() => setSelectedId(t.id)}
                    aria-current={current ? "true" : undefined}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
                      current ? "bg-brand-100/70" : "hover:bg-wash",
                    )}
                  >
                    <Avatar name={personName(t)} picture={t.participant_picture} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={cn("truncate text-sm text-ink-900", isPending(t) ? "font-semibold" : "font-medium")}>{personName(t)}</span>
                        {wait != null ? (
                          <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs tabular-nums", wait >= LATE_MS ? "font-medium text-warn-fg" : "text-ink-500")} title={`Último mensaje: ${when(t.last_inbound_at ?? t.last_message_at)}`}>
                            <IconClock aria-hidden className="size-3.5" />
                            <span className="sr-only">Espera </span>{waited(wait)}
                          </span>
                        ) : (
                          <span className="shrink-0 text-xs tabular-nums text-ink-500">{when(t.last_message_at)}</span>
                        )}
                      </span>
                      <span className="mt-1 line-clamp-2 block text-[13px] leading-5 text-ink-600">
                        {t.last_direction === "out" && <span className="text-ink-500">Tienda: </span>}
                        {t.last_message_text ?? "—"}
                      </span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-1">
                        <Badge tone={platformTone(t.platform)}>{socialPlatformLabel(t.platform)}</Badge>
                        <Badge>{socialKindLabel(t.kind, t.platform)}</Badge>
                        {t.ad_id && <Badge tone="orange">Anuncio</Badge>}
                        {dmWindow === "humano" && <Badge tone="warn" title="Pasaron más de 24 h: se responde como persona, hasta 7 días">Más de 24 h</Badge>}
                        {dmWindow === "cerrado" && <Badge title="Pasaron más de 7 días: Meta no deja escribirle hasta que vuelva a escribir">Sin ventana</Badge>}
                        {t.store_id && stores.length > 1 && <span className="text-xs text-ink-500">{storeName.get(t.store_id)}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section
          className={cn("flex min-h-0 flex-col rounded-lg bg-white shadow-control ring-1 ring-line lg:overflow-hidden", !selected && "hidden lg:flex")}
          aria-label="Conversación"
        >
          {selected ? (
            <ThreadPanel
              key={selected.id}
              thread={selected}
              storeName={selected.store_id ? storeName.get(selected.store_id) ?? null : null}
              whatsapp={selected.store_id ? whatsappByStore[selected.store_id] ?? null : null}
              onBack={() => setSelectedId(null)}
              onChanged={() => router.refresh()}
              aiReady={aiReady}
              onResolved={() => openNextAfter(selected.id)}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <span className="grid size-10 place-items-center rounded-full bg-wash"><IconChat aria-hidden className="size-5 text-ink-500" /></span>
              <p className="text-sm font-medium text-ink-900">Elige una conversación</p>
              <p className="max-w-[40ch] text-[13px] leading-5 text-ink-500">
                Al abrirla queda reservada para ti 10 minutos. Responde con <kbd className="font-sans font-medium text-ink-700">Ctrl</kbd> + <kbd className="font-sans font-medium text-ink-700">Enter</kbd>.
              </p>
            </div>
          )}
        </section>
      </div>

      {autoOpen && canManage && <AutoRepliesPanel settings={autoSettings} storeName={storeName} aiReady={aiReady} onClose={() => setAutoOpen(false)} />}
    </div>
  );
}

function Avatar({ name, picture }: { name: string; picture: string | null }) {
  // Las fotos de Meta vencen o se bloquean fuera de su sitio: si no carga, va la inicial.
  const [broken, setBroken] = useState(false);
  if (picture && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={picture} alt="" onError={() => setBroken(true)} className="size-9 shrink-0 rounded-full bg-line object-cover" referrerPolicy="no-referrer" />;
  }
  return <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-line text-sm font-semibold text-ink-600">{name.replace(/^@/, "").slice(0, 1).toUpperCase()}</span>;
}

type ReplyMode = "dm" | "public" | "private";

function ThreadPanel({ thread, storeName, whatsapp, aiReady, onBack, onChanged, onResolved }: {
  thread: SocialThreadView;
  aiReady: boolean;
  storeName: string | null;
  whatsapp: string | null;
  onBack: () => void;
  onChanged: () => void;
  onResolved: () => void;
}) {
  const [hold, setHold] = useState<{ mine: boolean; heldBy: string | null; until: string | null } | null>(null);
  // Abrir el hilo lo reserva 10 minutos (fase 2); otra asesora lo ve tomado.
  useEffect(() => {
    let alive = true;
    void claimSocialThread(thread.id).then((res) => { if (alive && res.ok) setHold(res); });
    return () => { alive = false; };
  }, [thread.id]);
  const [messages, setMessages] = useState<SocialMessageView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ReplyMode>(thread.kind === "dm" ? "dm" : "public");
  // «Sugerir con IA»: el borrador de Claude Haiku 5.5; en un comentario trae el público y el privado.
  const [suggestion, setSuggestion] = useState<{ public: string | null; private: string | null } | null>(null);
  const [suggesting, startSuggest] = useTransition();
  const [sending, startSend] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLOListElement>(null);

  const load = useCallback(async () => {
    const res = await getSocialThreadMessages(thread.id);
    if ("error" in res) setLoadError(res.error);
    else { setLoadError(null); setMessages(res.messages); }
  }, [thread.id]);

  // Se vuelve a leer cuando el hilo cambia (llegó algo nuevo por el webhook).
  useEffect(() => { void load(); }, [load, thread.last_message_at]);
  // Lo último está abajo, como en el chat de Leads: el hilo abre ahí.
  // En el teléfono la página es la que se desplaza: la primera carga baja al último mensaje.
  const firstLoad = useRef(true);
  useEffect(() => {
    if (!messages) return;
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
    if (firstLoad.current && !window.matchMedia("(min-width: 1024px)").matches) window.scrollTo({ top: document.body.scrollHeight });
    firstLoad.current = false;
  }, [messages]);
  useEffect(() => { if (finePointer()) field.current?.focus({ preventScroll: true }); }, [thread.id]);
  // «Enviado.» se va solo; un error se queda hasta el próximo intento.
  useEffect(() => {
    if (!feedback?.ok) return;
    const id = window.setTimeout(() => setFeedback(null), 4000);
    return () => window.clearTimeout(id);
  }, [feedback]);

  const firstInbound = messages?.find((m) => m.direction === "in")?.occurredAt ?? null;
  const replyWindow = thread.kind === "dm" ? dmReplyMode(thread.last_inbound_at) : null;
  const canPrivate = thread.kind === "comment" && privateReplyAllowed(thread, firstInbound ?? thread.created_at);
  const heldElsewhere = Boolean(hold && !hold.mine);
  const windowClosed = thread.kind === "dm" && replyWindow === "cerrado";
  const blocked = windowClosed || heldElsewhere;
  const canSend = Boolean(text.trim()) && !sending && !blocked;

  function send() {
    if (!canSend) return;
    setFeedback(null);
    startSend(async () => {
      const res = await replySocialThread(thread.id, text, mode);
      if (res.ok) { setText(""); setFeedback({ ok: true, text: res.notice ?? "Enviado." }); }
      else setFeedback({ ok: false, text: res.error });
      await load();
      onChanged();
    });
  }

  function toggleClosed() {
    const closing = thread.status !== "cerrado";
    startSend(async () => {
      const res = await setSocialThreadStatus(thread.id, closing ? "cerrado" : "abierto");
      if (!res.ok) { setFeedback({ ok: false, text: res.error }); return; }
      onChanged();
      if (closing) onResolved();
    });
  }

  function suggest() {
    setFeedback(null);
    startSuggest(async () => {
      const res = await suggestSocialReply(thread.id);
      if (!res.ok) { setFeedback({ ok: false, text: res.error }); return; }
      const next = { public: res.publicText, private: res.privateText };
      setSuggestion(next);
      const forMode = thread.kind === "dm" ? next.private : mode === "private" ? next.private : next.public;
      setText(forMode ?? "");
      field.current?.focus();
    });
  }

  /** Al cambiar entre público y privado, el borrador de la IA cambia con él (si no se tocó). */
  function changeMode(next: "public" | "private") {
    if (suggestion && text === (mode === "private" ? suggestion.private : suggestion.public)) setText((next === "private" ? suggestion.private : suggestion.public) ?? "");
    setMode(next);
  }

  function toWhatsapp() {
    if (!whatsapp) return;
    const first = thread.participant_name?.trim().split(/\s+/)[0];
    setText(`¡Hola${first ? ` ${first}` : ""}! Para atenderte mejor escríbenos por WhatsApp 👉 ${whatsapp}`);
    field.current?.focus();
  }

  const statusBadge = thread.status === "cerrado"
    ? <Badge>Resuelta</Badge>
    : isPending(thread) ? <Badge tone="warn">Por responder</Badge> : <Badge tone="ok">Respondida</Badge>;
  const showPost = thread.kind === "comment" && Boolean(thread.post_text || thread.post_image_url || thread.post_permalink);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <button type="button" onClick={onBack} className="-ml-1.5 grid size-8 shrink-0 place-items-center rounded-md text-ink-600 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:size-11 lg:hidden" aria-label="Volver a la lista">
          <IconArrowLeft className="size-4" />
        </button>
        <span className="hidden sm:contents"><Avatar name={personName(thread)} picture={thread.participant_picture} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="min-w-0 truncate text-base font-semibold leading-6 text-ink-900">{personName(thread)}</h2>
            {statusBadge}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink-500">
            <Badge tone={platformTone(thread.platform)}>{socialPlatformLabel(thread.platform)}</Badge>
            <Badge>{socialKindLabel(thread.kind, thread.platform)}</Badge>
            {storeName && <span>{storeName}</span>}
            {thread.participant_username && thread.participant_name && <span>· @{thread.participant_username}</span>}
          </p>
        </div>
        <OpsButton size="sm" onClick={toggleClosed} disabled={sending} aria-label={thread.status === "cerrado" ? "Reabrir" : "Marcar resuelta"} className="pointer-coarse:h-11 pointer-coarse:w-11 sm:pointer-coarse:w-auto">
          {thread.status === "cerrado" ? <IconUndo /> : <IconCheck />}
          <span className="hidden sm:inline">{thread.status === "cerrado" ? "Reabrir" : "Marcar resuelta"}</span>
        </OpsButton>
      </header>

      {showPost && (
        <div className="flex gap-3 border-b border-line px-4 py-3">
          {thread.post_image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thread.post_image_url} alt="" className="size-12 shrink-0 rounded-md bg-line object-cover ring-1 ring-line" referrerPolicy="no-referrer" />
          ) : (
            <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-md bg-wash"><IconImage className="size-5 text-ink-500" /></span>
          )}
          <div className="min-w-0 flex-1 text-[13px] leading-5">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium text-ink-900">{thread.ad_id ? "Comentó en un anuncio" : "Comentó en una publicación"}</span>
              {thread.post_permalink && (
                <a href={thread.post_permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand-700 hover:underline">
                  Ver en {socialPlatformLabel(thread.platform)} <IconArrowUpRight aria-hidden className="size-3.5" />
                </a>
              )}
            </p>
            {thread.post_text && <p className="line-clamp-2 text-ink-600">{thread.post_text}</p>}
          </div>
        </div>
      )}

      <ol ref={log} className="min-h-[40vh] space-y-2 bg-wash px-4 py-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain" aria-label="Mensajes" role="log">
        {loadError && (
          <li>
            <Banner tone="crit" title="No se pudo leer la conversación">
              <p>{loadError}</p>
              <button type="button" onClick={() => void load()} className="mt-1 font-medium text-brand-700 hover:underline">Reintentar</button>
            </Banner>
          </li>
        )}
        {!messages && !loadError && (
          <li aria-label="Cargando mensajes" className="space-y-2">
            <Skeleton className="h-14 w-3/5 bg-line" />
            <Skeleton className="ml-auto h-10 w-2/5 bg-line" />
            <Skeleton className="h-10 w-1/2 bg-line" />
          </li>
        )}
        {messages?.length === 0 && <li className="py-6 text-center text-[13px] text-ink-500">Sin mensajes guardados todavía.</li>}
        {messages?.map((m, i) => {
          const day = chatbyLimaDay(m.occurredAt);
          const showDay = day !== null && day !== chatbyLimaDay(messages[i - 1]?.occurredAt ?? null);
          return (
            <Fragment key={m.id}>
              {showDay && (
                <li className="pt-1 text-center" aria-hidden>
                  <span className="rounded-md bg-white px-2 py-0.5 text-xs font-medium text-ink-600 shadow-control ring-1 ring-line">{chatbyDayLabel(day)}</span>
                </li>
              )}
              <MessageBubble m={m} />
            </Fragment>
          );
        })}
      </ol>

      <div className="sticky bottom-0 space-y-2 rounded-b-lg border-t border-line bg-white px-4 py-3 lg:static">
        {heldElsewhere && hold && (
          <Banner tone="warn" title={`La está atendiendo ${hold.heldBy ?? "otra persona"}`}>
            {hold.until ? `Se libera a las ${when(hold.until)} si no hay actividad.` : "Se libera sola si no hay actividad."}
          </Banner>
        )}
        {windowClosed && (
          <Banner tone="neutral" title="No se le puede escribir">
            Pasaron más de 7 días desde su último mensaje: Meta no deja escribirle hasta que vuelva a escribir.
          </Banner>
        )}
        {!blocked && thread.kind === "dm" && replyWindow === "humano" && (
          <p className="flex items-start gap-1.5 text-xs leading-4 text-warn-fg">
            <IconClock aria-hidden className="mt-px size-3.5 shrink-0" />
            Pasaron más de 24 h desde su último mensaje: sale como respuesta de una persona (Meta lo permite hasta 7 días).
          </p>
        )}
        {!blocked && mode === "private" && (
          <p className="text-xs leading-4 text-ink-500">Llega a su bandeja de mensajes. Es una sola por comentario; en Instagram, si no te sigue, va solo texto.</p>
        )}

        <div className={cn("rounded-lg bg-white shadow-control ring-1 ring-inset ring-line-strong transition-shadow duration-150 focus-within:ring-2 focus-within:ring-brand-500", blocked && "bg-wash")}>
          <label className="block">
            <span className="sr-only">Respuesta</span>
            <textarea
              ref={field}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
              rows={3}
              maxLength={1000}
              disabled={blocked}
              placeholder={blocked ? "No se puede responder ahora" : mode === "public" ? "Respuesta pública al comentario…" : mode === "private" ? "Mensaje por privado…" : "Escribe tu respuesta…"}
              className="block max-h-48 min-h-[4.5rem] w-full resize-none rounded-t-lg bg-transparent px-3 pt-2.5 text-sm leading-5 text-ink-900 placeholder:text-ink-500 focus:outline-none disabled:cursor-not-allowed"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 px-2 pb-2 pt-1">
            {thread.kind === "comment" && (
              <div role="radiogroup" aria-label="Cómo responder" className="inline-flex rounded-lg bg-wash p-0.5 ring-1 ring-inset ring-line">
                <ModeOption label="En público" active={mode === "public"} onClick={() => changeMode("public")} disabled={blocked} />
                <ModeOption
                  label="Por privado"
                  active={mode === "private"}
                  onClick={() => changeMode("private")}
                  disabled={blocked || !canPrivate}
                  title={canPrivate ? "Meta permite una sola respuesta por privado por comentario, dentro de 7 días" : "Ya se usó la respuesta por privado o pasaron 7 días"}
                />
              </div>
            )}
            {aiReady && !blocked && (
              <OpsButton size="sm" variant="ghost" onClick={suggest} disabled={suggesting} title="Claude Haiku 5.5 escribe la respuesta; la revisas y la envías" className="pointer-coarse:h-11">
                <IconBot />
                {suggesting ? "Escribiendo…" : "Sugerir con IA"}
              </OpsButton>
            )}
            {whatsapp && !blocked && (
              <OpsButton size="sm" variant="ghost" onClick={toWhatsapp} title="Escribe un mensaje con el WhatsApp de la tienda" className="pointer-coarse:h-11">
                <IconWhatsApp />
                Pasar a WhatsApp
              </OpsButton>
            )}
            <span className="ml-auto flex items-center gap-3">
              {text.length > 800 && <span className={cn("text-xs tabular-nums", text.length >= 1000 ? "text-crit-fg" : "text-ink-500")}>{text.length}/1000</span>}
              <span className="hidden text-xs text-ink-500 pointer-fine:inline">Ctrl + Enter</span>
              <OpsButton variant="primary" size="sm" onClick={send} disabled={!canSend} className="pointer-coarse:h-11">{sending ? "Enviando…" : "Enviar"}</OpsButton>
            </span>
          </div>
        </div>

        <div className="flex min-h-4 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
          {feedback ? (
            <p role="status" className={cn("flex items-center gap-1 font-medium", feedback.ok ? "text-ok-fg" : "text-crit-fg")}>
              {feedback.ok ? <IconCheck aria-hidden className="size-3.5" /> : <IconAlert aria-hidden className="size-3.5" />}
              {feedback.text}
            </p>
          ) : <span />}
          {hold?.mine && hold.until && (
            <p className="flex items-center gap-1 text-ink-500"><IconLock aria-hidden className="size-3.5" />Reservada para ti hasta las {when(hold.until)}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ModeOption({ label, active, onClick, disabled, title }: { label: string; active: boolean; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "h-7 rounded-md px-2.5 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-10",
        active ? "bg-white text-ink-900 shadow-control ring-1 ring-line" : "text-ink-600 hover:text-ink-900",
      )}
    >
      {label}
    </button>
  );
}

function MessageBubble({ m }: { m: SocialMessageView }) {
  const out = m.direction === "out";
  const who = out
    ? m.via === "kapta" ? (m.sentByName ?? "Kapta") : m.via === "auto" ? "Respuesta automática" : "Desde Meta"
    : m.authorName ?? "Cliente";
  const label = m.channel === "comment_private" ? "por privado" : m.channel === "comment_public" ? "en público" : null;
  const failed = m.status === "fallo";
  return (
    <li className={cn("flex", out ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-5 text-ink-900",
          failed ? "bg-crit-wash ring-1 ring-inset ring-crit-bg" : out ? "bg-line" : "bg-white shadow-control ring-1 ring-line",
        )}
      >
        <p className="mb-0.5 flex flex-wrap items-center gap-x-1 text-xs font-medium text-ink-500">
          {m.via === "auto" && <IconBot aria-hidden className="size-3.5" />}
          {who}{label ? ` · ${label}` : ""}
        </p>
        {failed && (
          <p className="mb-0.5 flex items-center gap-1.5 text-xs font-semibold text-crit-fg">
            <IconAlert aria-hidden className="size-3.5" />
            No se envió{m.error ? `: ${m.error}` : ""}
          </p>
        )}
        {m.attachments.map((a, i) => a.url ? (
          <a key={i} href={a.url} target="_blank" rel="noreferrer" className="mb-0.5 flex items-center gap-1.5 font-medium text-brand-700 hover:underline">
            <IconImage aria-hidden className="size-4 shrink-0" />
            Adjunto{a.type ? ` (${a.type})` : ""}
          </a>
        ) : null)}
        <p className="whitespace-pre-wrap break-words">
          {m.text || (m.attachments.length ? null : <span className="italic text-ink-500">Sin texto (sticker, reacción o publicación compartida)</span>)}
          <span className="ml-2 inline-flex translate-y-0.5 whitespace-nowrap align-baseline text-xs leading-none tabular-nums text-ink-500">
            {m.status === "enviando" ? "Enviando…" : chatbyLimaTime(m.occurredAt)}
          </span>
        </p>
      </div>
    </li>
  );
}

function UnassignedAccounts({ accounts, stores, onDone }: { accounts: SocialAccountView[]; stores: Array<{ id: string; name: string }>; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Banner tone="warn" title="Cuentas sin tienda">
      <p>Estas cuentas de Zernio no calzaron con una tienda por su nombre. Hasta asignarlas, sus mensajes no se ven en la bandeja.</p>
      <ul className="mt-2 space-y-1.5">
        {accounts.map((a) => (
          <li key={a.account_id} className="flex flex-wrap items-center gap-2">
            <Badge tone={platformTone(a.platform)}>{socialPlatformLabel(a.platform)}</Badge>
            <span className="font-medium text-ink-900">{a.display_name ?? a.username ?? a.account_id}</span>
            <select
              aria-label={`Tienda de ${a.display_name ?? a.username ?? "la cuenta"}`}
              className={cn(FIELD_BOX, "h-8 w-auto px-2 pointer-coarse:h-11")}
              defaultValue=""
              disabled={pending}
              onChange={(e) => {
                const storeId = e.currentTarget.value;
                if (!storeId) return;
                start(async () => {
                  const res = await setSocialAccountStore(a.account_id, storeId);
                  if (!res.ok) setError(res.error); else onDone();
                });
              }}
            >
              <option value="">Elegir tienda…</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </li>
        ))}
      </ul>
      {error && <p className="mt-1 text-crit-fg">{error}</p>}
    </Banner>
  );
}

const VAR = "rounded bg-wash px-1 py-px font-mono text-xs text-ink-700 ring-1 ring-inset ring-line";

function AutoRepliesPanel({ settings, storeName, aiReady, onClose }: { settings: SocialAutoSettingsView[]; storeName: Map<string, string>; aiReady: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const on = settings.filter((s) => s.enabled).length;
  return (
    <SidePanel
      label="Respuestas automáticas"
      title="Respuestas automáticas"
      badge={<Badge tone={on ? "ok" : "neutral"}>{on ? `Encendidas en ${on} de ${settings.length}` : "Apagadas"}</Badge>}
      meta={aiReady ? "Con IA: Claude Haiku 5.5 responde todo lo que escribe una clienta" : "Kapta contesta una sola vez por comentario o conversación"}
      width="max-w-[560px]"
      onClose={onClose}
    >
      <div className="space-y-3 text-[13px] leading-5 text-ink-600">
        {aiReady ? (
          <>
            <p>
              Encendidas, la IA contesta <span className="font-medium text-ink-900">cada comentario en público y por privado</span> y <span className="font-medium text-ink-900">cada mensaje directo</span>,
              con el catálogo publicado, sus precios, el producto del anuncio y el WhatsApp de la tienda. Lo que no sabe no lo inventa: invita a escribir por WhatsApp.
            </p>
            <p>Nunca da datos de la tienda (correos, direcciones, teléfonos ni otros enlaces): además de pedírselo, Kapta los borra antes de enviar. Si una asesora abrió la conversación hace menos de 10 minutos, la IA no se mete.</p>
            <p>Los textos de abajo son el respaldo: salen solo si la IA no responde.</p>
          </>
        ) : (
          <p>
            A un <span className="font-medium text-ink-900">comentario con palabras de compra</span> se le responde en público y por privado con el producto del anuncio, su precio y el WhatsApp de la tienda.
            Al <span className="font-medium text-ink-900">primer mensaje directo</span>, un saludo con el WhatsApp. Lo demás (quejas, preguntas raras) va a las asesoras.
          </p>
        )}
        <p className="flex flex-wrap items-center gap-1">
          Datos que se llenan solos: <code className={VAR}>{"{producto}"}</code> <code className={VAR}>{"{precio}"}</code> <code className={VAR}>{"{whatsapp}"}</code> <code className={VAR}>{"{nombre}"}</code>
        </p>
        <p>Si falta el producto o el precio, el privado sale sin ellos: nunca con un precio inventado.</p>
      </div>
      <div className="mt-5 divide-y divide-line border-t border-line">
        {settings.map((s) => <AutoStoreForm key={s.storeId} initial={s} name={storeName.get(s.storeId) ?? "Tienda"} />)}
      </div>
    </SidePanel>
  );
}

function AutoStoreForm({ initial, name }: { initial: SocialAutoSettingsView; name: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const area = cn(FIELD_BOX, "mt-1 w-full resize-y px-3 py-2 leading-5");
  const label = "block text-[13px] font-medium text-ink-700";
  const switchId = `auto-${initial.storeId}`;
  return (
    <form
      className="space-y-3 py-5"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setMsg(null);
        start(async () => {
          const res = await saveSocialAutoSettings({
            storeId: initial.storeId,
            enabled: fd.getAll("enabled").includes("true"),
            keywords: String(fd.get("keywords") ?? ""),
            publicText: String(fd.get("publicText") ?? ""),
            privateText: String(fd.get("privateText") ?? ""),
            dmText: String(fd.get("dmText") ?? ""),
          });
          setMsg(res.ok ? { ok: true, text: res.notice ?? "Guardado." } : { ok: false, text: res.error });
        });
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={switchId} className="text-sm font-semibold text-ink-900">{name}</label>
        <Switch id={switchId} name="enabled" defaultChecked={initial.enabled} on="Encendidas" off="Apagadas" />
      </div>
      <label className={label}>Palabras de compra
        <textarea name="keywords" rows={2} className={area} defaultValue={initial.keywords} />
        <span className="mt-1 block text-xs font-normal text-ink-500">Separadas por coma. Sin «quiero» ni «pedido»: también las usa un reclamo.</span>
      </label>
      <label className={label}>Respuesta pública al comentario
        <textarea name="publicText" rows={1} maxLength={640} className={area} defaultValue={initial.publicText} />
      </label>
      <label className={label}>Mensaje por privado al comentario
        <textarea name="privateText" rows={2} maxLength={640} className={area} defaultValue={initial.privateText} />
      </label>
      <label className={label}>Saludo al primer mensaje directo
        <textarea name="dmText" rows={2} maxLength={640} className={area} defaultValue={initial.dmText} />
      </label>
      <div className="flex items-center gap-3">
        <OpsButton type="submit" size="sm" variant="primary" disabled={pending}>{pending ? "Guardando…" : `Guardar ${name}`}</OpsButton>
        {msg && <span role="status" className={cn("text-xs font-medium", msg.ok ? "text-ok-fg" : "text-crit-fg")}>{msg.text}</span>}
      </div>
    </form>
  );
}
