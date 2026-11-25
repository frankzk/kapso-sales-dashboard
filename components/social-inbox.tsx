"use client";

// Leads → Redes (MOM §25.4): la bandeja de comentarios y mensajes directos de
// Facebook e Instagram de las tiendas, por Zernio. A la izquierda los hilos; a
// la derecha el hilo abierto, con su post (si es un comentario) y la respuesta.

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  claimSocialThread,
  getSocialThreadMessages,
  replySocialThread,
  saveSocialAutoSettings,
  setSocialAccountStore,
  setSocialThreadStatus,
  syncZernioInbox,
  type SocialAutoSettingsView,
  type SocialMessageView,
} from "@/app/dashboard/leads/redes/actions";
import { Badge, Banner, ChoiceChip, FIELD_BOX, OpsButton } from "@/components/ops-ui";
import { IconArrowLeft, IconArrowUpRight, IconChat } from "@/components/icons";
import { cn } from "@/components/ui";
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
type NetFilter = "todas" | "facebook" | "instagram";
type KindFilter = "todos" | "comment" | "dm";

const REFRESH_MS = 20_000;

/** Espera respuesta: abierto y lo último lo dijo la clienta. */
function isPending(t: SocialThreadView): boolean {
  return t.status === "abierto" && t.last_direction === "in";
}

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toLocaleDateString("es-PE", { timeZone: "America/Lima" }) === today.toLocaleDateString("es-PE", { timeZone: "America/Lima" });
  return sameDay
    ? d.toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function personName(t: Pick<SocialThreadView, "participant_name" | "participant_username">): string {
  return t.participant_name ?? (t.participant_username ? `@${t.participant_username}` : "Sin nombre");
}

export function SocialInbox({ threads, accounts, stores, canManage, configured, whatsappByStore, autoSettings }: {
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
  const [net, setNet] = useState<NetFilter>("todas");
  const [kind, setKind] = useState<KindFilter>("todos");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, startSync] = useTransition();
  const [syncNotice, setSyncNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // Lo nuevo llega por el webhook: la lista se refresca sola cada 20 s.
  useEffect(() => {
    const id = window.setInterval(() => router.refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [router]);

  const storeName = useMemo(() => new Map(stores.map((s) => [s.id, s.name])), [stores]);
  const counts = useMemo(() => ({
    pendientes: threads.filter(isPending).length,
    todos: threads.filter((t) => t.status !== "cerrado").length,
    cerrados: threads.filter((t) => t.status === "cerrado").length,
  }), [threads]);
  const visible = useMemo(() => threads.filter((t) =>
    (status === "pendientes" ? isPending(t) : status === "cerrados" ? t.status === "cerrado" : t.status !== "cerrado")
    && (net === "todas" || t.platform === net)
    && (kind === "todos" || t.kind === kind)), [threads, status, net, kind]);
  const selected = threads.find((t) => t.id === selectedId) ?? null;
  const unassigned = accounts.filter((a) => !a.store_id);

  function sync() {
    setSyncNotice(null);
    startSync(async () => {
      const res = await syncZernioInbox();
      setSyncNotice(res.ok ? { ok: true, text: res.notice ?? "Sincronizado." } : { ok: false, text: res.error });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Redes</h1>
          <p className="mt-0.5 text-sm text-ink-600">Comentarios y mensajes directos de Facebook e Instagram de las tiendas. Se responden desde aquí.</p>
        </div>
        {canManage && configured && (
          <OpsButton onClick={sync} disabled={syncing} title="Trae de Zernio las cuentas, las últimas conversaciones y los últimos comentarios">
            {syncing ? "Sincronizando…" : "Sincronizar redes"}
          </OpsButton>
        )}
      </header>

      {!configured && (
        <Banner tone="warn" title="Falta conectar Zernio">
          Kapta lee y responde las redes por Zernio. Falta la clave <code>ZERNIO_API_KEY</code> en Vercel (y <code>ZERNIO_WEBHOOK_SECRET</code> para recibir lo nuevo al instante).
        </Banner>
      )}
      {syncNotice && <Banner tone={syncNotice.ok ? "ok" : "crit"} role="status">{syncNotice.text}</Banner>}
      {canManage && unassigned.length > 0 && <UnassignedAccounts accounts={unassigned} stores={stores} onDone={() => router.refresh()} />}
      {canManage && <AutoRepliesPanel settings={autoSettings} storeName={storeName} />}

      <div className="flex flex-wrap items-center gap-1.5">
        <ChoiceChip label="Por responder" count={counts.pendientes} active={status === "pendientes"} onClick={() => setStatus("pendientes")} />
        <ChoiceChip label="Todos" count={counts.todos} active={status === "todos"} onClick={() => setStatus("todos")} />
        <ChoiceChip label="Cerrados" count={counts.cerrados} active={status === "cerrados"} onClick={() => setStatus("cerrados")} />
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line-strong sm:block" />
        {(["todas", "facebook", "instagram"] as const).map((n) => (
          <ChoiceChip key={n} label={n === "todas" ? "Todas las redes" : socialPlatformLabel(n)} active={net === n} onClick={() => setNet(n)} />
        ))}
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line-strong sm:block" />
        {(["todos", "comment", "dm"] as const).map((k) => (
          <ChoiceChip key={k} label={k === "todos" ? "Comentarios y mensajes" : k === "comment" ? "Comentarios" : "Mensajes directos"} active={kind === k} onClick={() => setKind(k)} />
        ))}
      </div>

      <div className="grid min-h-[60vh] gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <ul className={cn("divide-y divide-line overflow-hidden rounded-lg bg-white shadow-card ring-1 ring-line", selected && "hidden lg:block")} aria-label="Conversaciones">
          {visible.length === 0 && (
            <li className="px-4 py-10 text-center text-sm text-ink-500">
              {threads.length === 0 ? "Todavía no llegó nada de las redes." : "Nada en este filtro."}
            </li>
          )}
          {visible.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setSelectedId(t.id)}
                aria-current={t.id === selectedId ? "true" : undefined}
                className={cn("flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500", t.id === selectedId && "bg-brand-50")}
              >
                <Avatar name={personName(t)} picture={t.participant_picture} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn("truncate text-sm text-ink-900", isPending(t) ? "font-semibold" : "font-medium")}>{personName(t)}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-500">{when(t.last_message_at)}</span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1">
                    <Badge tone={t.platform === "instagram" ? "fuchsia" : "indigo"}>{socialPlatformLabel(t.platform)}</Badge>
                    <Badge>{socialKindLabel(t.kind, t.platform)}</Badge>
                    {t.ad_id && <Badge tone="orange">Anuncio</Badge>}
                    {t.store_id && <span className="text-xs text-ink-500">{storeName.get(t.store_id)}</span>}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-[13px] leading-5 text-ink-600">
                    {t.last_direction === "out" && <span className="text-ink-500">Tú: </span>}
                    {t.last_message_text ?? "—"}
                  </span>
                </span>
                {isPending(t) && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-600" aria-label="Por responder" />}
              </button>
            </li>
          ))}
        </ul>

        <section className={cn("rounded-lg bg-white shadow-card ring-1 ring-line", !selected && "hidden lg:block")} aria-label="Conversación">
          {selected ? (
            <ThreadPanel key={selected.id} thread={selected} storeName={selected.store_id ? storeName.get(selected.store_id) ?? null : null} whatsapp={selected.store_id ? whatsappByStore[selected.store_id] ?? null : null} onBack={() => setSelectedId(null)} onChanged={() => router.refresh()} />
          ) : (
            <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-2 p-8 text-center text-sm text-ink-500">
              <IconChat className="size-6 text-ink-400" />
              Elige una conversación para leerla y responder.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Avatar({ name, picture }: { name: string; picture: string | null }) {
  if (picture) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={picture} alt="" className="size-9 shrink-0 rounded-full object-cover" referrerPolicy="no-referrer" />;
  }
  return <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-line text-sm font-semibold text-ink-600">{name.replace(/^@/, "").slice(0, 1).toUpperCase()}</span>;
}

function ThreadPanel({ thread, storeName, whatsapp, onBack, onChanged }: { thread: SocialThreadView; storeName: string | null; whatsapp: string | null; onBack: () => void; onChanged: () => void }) {
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
  const [mode, setMode] = useState<"dm" | "public" | "private">(thread.kind === "dm" ? "dm" : "public");
  const [sending, startSend] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await getSocialThreadMessages(thread.id);
    if ("error" in res) setLoadError(res.error);
    else { setLoadError(null); setMessages(res.messages); }
  }, [thread.id]);

  // Se vuelve a leer cuando el hilo cambia (llegó algo nuevo por el webhook).
  useEffect(() => { void load(); }, [load, thread.last_message_at]);

  const firstInbound = messages?.find((m) => m.direction === "in")?.occurredAt ?? null;
  const replyWindow = thread.kind === "dm" ? dmReplyMode(thread.last_inbound_at) : null;
  const canPrivate = thread.kind === "comment" && privateReplyAllowed(thread, firstInbound ?? thread.created_at);
  const heldElsewhere = Boolean(hold && !hold.mine);
  const blocked = (thread.kind === "dm" && replyWindow === "cerrado") || heldElsewhere;

  function send() {
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
    startSend(async () => {
      const res = await setSocialThreadStatus(thread.id, thread.status === "cerrado" ? "abierto" : "cerrado");
      if (!res.ok) setFeedback({ ok: false, text: res.error });
      onChanged();
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <button type="button" onClick={onBack} className="mt-1 rounded p-1 text-ink-600 hover:bg-wash lg:hidden" aria-label="Volver a la lista"><IconArrowLeft className="size-4" /></button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-ink-900">{personName(thread)}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-ink-500">
            <Badge tone={thread.platform === "instagram" ? "fuchsia" : "indigo"}>{socialPlatformLabel(thread.platform)}</Badge>
            <Badge>{socialKindLabel(thread.kind, thread.platform)}</Badge>
            {storeName && <span>{storeName}</span>}
            {thread.participant_username && <span>· @{thread.participant_username}</span>}
          </p>
        </div>
        <OpsButton size="sm" variant="ghost" onClick={toggleClosed} disabled={sending}>
          {thread.status === "cerrado" ? "Reabrir" : "Marcar resuelto"}
        </OpsButton>
      </div>

      {thread.kind === "comment" && (thread.post_text || thread.post_image_url || thread.post_permalink) && (
        <div className="flex gap-3 border-b border-line bg-wash px-4 py-3">
          {thread.post_image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thread.post_image_url} alt="" className="size-14 shrink-0 rounded object-cover" referrerPolicy="no-referrer" />
          )}
          <div className="min-w-0 flex-1 text-[13px] leading-5 text-ink-600">
            <p className="font-medium text-ink-700">{thread.ad_id ? "Comentó en un anuncio" : "Comentó en el post"}</p>
            {thread.post_text && <p className="line-clamp-2">{thread.post_text}</p>}
            {thread.post_permalink && (
              <a href={thread.post_permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
                Ver post <IconArrowUpRight className="size-3.5" />
              </a>
            )}
          </div>
        </div>
      )}

      <ol className="flex-1 space-y-2 overflow-y-auto px-4 py-4" aria-label="Mensajes">
        {loadError && <li className="text-sm text-crit-fg">{loadError}</li>}
        {!messages && !loadError && <li className="text-sm text-ink-500">Cargando…</li>}
        {messages?.map((m) => <MessageBubble key={m.id} m={m} />)}
      </ol>

      <div className="space-y-2 border-t border-line px-4 py-3">
        {thread.kind === "comment" && (
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Cómo responder">
            <ChoiceChip label="Responder en público" active={mode === "public"} onClick={() => setMode("public")} />
            <ChoiceChip
              label={canPrivate ? "Responder por privado" : "Por privado (ya no disponible)"}
              active={mode === "private"}
              onClick={() => canPrivate && setMode("private")}
              title={canPrivate ? "Meta permite una sola respuesta por privado por comentario, dentro de 7 días" : "Ya se usó la respuesta por privado o pasaron 7 días"}
            />
          </div>
        )}
        {thread.kind === "dm" && replyWindow === "humano" && (
          <p className="text-xs text-warn-fg">Pasaron más de 24 h desde su último mensaje: se envía como respuesta de una persona (Meta lo permite hasta 7 días).</p>
        )}
        {heldElsewhere && hold && <p className="text-xs text-warn-fg">La atiende {hold.heldBy}{hold.until ? ` · se libera a las ${when(hold.until)} si no hay actividad` : ""}.</p>}
        {hold?.mine && hold.until && <p className="text-xs text-ink-500">La atiendes tú · se libera a las {when(hold.until)} si no hay actividad.</p>}
        {thread.kind === "dm" && replyWindow === "cerrado" && <p className="text-xs text-crit-fg">Pasaron más de 7 días desde su último mensaje: Meta no deja escribirle hasta que vuelva a escribir.</p>}
        {mode === "private" && <p className="text-xs text-ink-500">Llega a su bandeja de mensajes. En Instagram, si no te sigue, manda solo texto.</p>}
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Respuesta</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim() && !sending && !blocked) send(); }}
              rows={2}
              maxLength={1000}
              disabled={blocked}
              placeholder={mode === "public" ? "Respuesta pública al comentario…" : "Escribe tu respuesta…"}
              className={cn(FIELD_BOX, "w-full resize-y px-3 py-2 leading-5")}
            />
          </label>
          <OpsButton variant="primary" onClick={send} disabled={sending || blocked || !text.trim()}>{sending ? "Enviando…" : "Enviar"}</OpsButton>
        </div>
        {whatsapp && !blocked && (
          <button
            type="button"
            onClick={() => setText(`¡Hola${thread.participant_name ? ` ${thread.participant_name.split(/\s+/)[0]}` : ""}! Para atenderte mejor escríbenos por WhatsApp 👉 ${whatsapp}`)}
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            Pasar a WhatsApp
          </button>
        )}
        {feedback && <p role="status" className={cn("text-xs", feedback.ok ? "text-ok-fg" : "text-crit-fg")}>{feedback.text}</p>}
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: SocialMessageView }) {
  const out = m.direction === "out";
  const who = out
    ? m.via === "kapta" ? `Kapta${m.sentByName ? ` · ${m.sentByName}` : ""}` : m.via === "auto" ? "Automático" : "Desde Meta"
    : m.authorName ?? "Cliente";
  const label = m.channel === "comment_private" ? "Por privado" : m.channel === "comment_public" ? "Comentario" : null;
  return (
    <li className={cn("flex", out ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[85%] rounded-lg px-3 py-2 text-sm leading-5", out ? "bg-brand-50 text-ink-900" : "bg-wash text-ink-900", m.status === "fallo" && "ring-1 ring-crit-fg")}>
        <p className="mb-0.5 text-[11px] text-ink-500">{who}{label ? ` · ${label}` : ""} · {when(m.occurredAt)}</p>
        {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
        {m.attachments.map((a, i) => a.url ? (
          <a key={i} href={a.url} target="_blank" rel="noreferrer" className="mt-1 block text-xs font-medium text-brand-700 hover:underline">Adjunto{a.type ? ` (${a.type})` : ""}</a>
        ) : null)}
        {m.status === "enviando" && <p className="mt-0.5 text-[11px] text-ink-500">Enviando…</p>}
        {m.status === "fallo" && <p className="mt-0.5 text-[11px] text-crit-fg">No se envió: {m.error}</p>}
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
            <Badge tone={a.platform === "instagram" ? "fuchsia" : "indigo"}>{socialPlatformLabel(a.platform)}</Badge>
            <span className="font-medium text-ink-900">{a.display_name ?? a.username ?? a.account_id}</span>
            <select
              aria-label={`Tienda de ${a.display_name ?? a.username ?? "la cuenta"}`}
              className={cn(FIELD_BOX, "h-8 w-auto px-2")}
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

function AutoRepliesPanel({ settings, storeName }: { settings: SocialAutoSettingsView[]; storeName: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const on = settings.filter((s) => s.enabled).length;
  return (
    <section className="rounded-lg bg-white shadow-card ring-1 ring-line">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <span>
          <span className="text-sm font-semibold text-ink-900">Respuestas automáticas</span>
          <span className="ml-2 text-xs text-ink-500">{on ? `Encendidas en ${on} de ${settings.length} tiendas` : "Apagadas"}</span>
        </span>
        <span className="text-xs font-medium text-brand-700">{open ? "Cerrar" : "Configurar"}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4">
          <p className="text-[13px] leading-5 text-ink-600">
            A un comentario con palabras de compra se le responde en público y por privado con el producto del anuncio, su precio y el WhatsApp de la tienda.
            Al primer mensaje directo, un saludo con el WhatsApp. Lo demás va a las asesoras. Datos: <code>{"{producto}"}</code>, <code>{"{precio}"}</code>,
            <code>{" {whatsapp}"}</code>, <code>{"{nombre}"}</code>. Si falta el producto o el precio, el privado sale sin ellos.
          </p>
          {settings.map((s) => <AutoStoreForm key={s.storeId} initial={s} name={storeName.get(s.storeId) ?? "Tienda"} />)}
        </div>
      )}
    </section>
  );
}

function AutoStoreForm({ initial, name }: { initial: SocialAutoSettingsView; name: string }) {
  const [form, setForm] = useState(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<SocialAutoSettingsView>) => setForm((f) => ({ ...f, ...patch }));
  const area = cn(FIELD_BOX, "w-full px-3 py-2 leading-5");
  return (
    <form
      className="space-y-2 rounded-md bg-wash p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        start(async () => {
          const res = await saveSocialAutoSettings(form);
          setMsg(res.ok ? { ok: true, text: res.notice ?? "Guardado." } : { ok: false, text: res.error });
        });
      }}
    >
      <label className="flex items-center gap-2 text-sm font-medium text-ink-900">
        <input type="checkbox" className="size-4 accent-brand-600" checked={form.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
        {name}: responder solo
      </label>
      <label className="block text-xs font-medium text-ink-700">Palabras de compra (separadas por coma)
        <textarea rows={2} className={area} value={form.keywords} onChange={(e) => set({ keywords: e.currentTarget.value })} />
      </label>
      <label className="block text-xs font-medium text-ink-700">Respuesta pública al comentario
        <textarea rows={1} className={area} value={form.publicText} onChange={(e) => set({ publicText: e.currentTarget.value })} />
      </label>
      <label className="block text-xs font-medium text-ink-700">Mensaje por privado al comentario
        <textarea rows={2} className={area} value={form.privateText} onChange={(e) => set({ privateText: e.currentTarget.value })} />
      </label>
      <label className="block text-xs font-medium text-ink-700">Saludo al primer mensaje directo
        <textarea rows={2} className={area} value={form.dmText} onChange={(e) => set({ dmText: e.currentTarget.value })} />
      </label>
      <div className="flex items-center gap-3">
        <OpsButton type="submit" size="sm" variant="primary" disabled={pending}>{pending ? "Guardando…" : "Guardar"}</OpsButton>
        {msg && <span role="status" className={cn("text-xs", msg.ok ? "text-ok-fg" : "text-crit-fg")}>{msg.text}</span>}
      </div>
    </form>
  );
}
