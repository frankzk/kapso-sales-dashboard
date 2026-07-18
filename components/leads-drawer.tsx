"use client";

import { type ReactNode, useActionState, useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { LeadCallRow, LeadRow } from "@/lib/types";
import {
  adObjectiveLabel,
  adStatusLabel,
  adsManagerUrl,
  prettyAdName,
  type AdMeta,
} from "@/lib/meta-ads";
import { waKindLabel, type WaNumber } from "@/lib/wa-numbers";
import type { CustomerHistory } from "@/lib/leads-access";
import {
  MANUAL_STATUSES,
  categoryOf,
  labelOf,
  leadSegment,
  leadWindowInfo,
  yapeKind,
  type LeadSegment,
  type LeadWindow,
  type YapeKind,
} from "@/lib/leads";
import {
  confirmLeadWon,
  createQuickReply,
  deleteQuickReply,
  generateOrder,
  listQuickReplies,
  loadLeadConversation,
  loadOrderDraft,
  pollLeadState,
  registerCall,
  createWaMediaUpload,
  searchStoreProducts,
  sendLeadMedia,
  sendLeadMessage,
  retryLeadMessage,
  type LeadActionState,
  type LeadConversationMessage,
  type LeadThread,
  type QuickReply,
} from "@/app/dashboard/leads/actions";
import { shopifyDraftOrderAdminUrl } from "@/lib/shopify-urls";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { cn } from "@/components/ui";
import { YapeAssign } from "@/components/yape-alerts";
import { reportClientPerformanceMetric } from "@/lib/client-performance";

export type LeadDrawerProps = {
  lead: LeadRow;
  calls: LeadCallRow[] | null;
  history: CustomerHistory | null;
  adMeta: AdMeta | null;
  waNumber: WaNumber | null;
  shopifyDomain: string | null;
  currency: string;
  onClose: () => void;
  onRegistered: (update?: LeadDrawerUpdate) => void;
  onReady?: () => void;
};

export type LeadDrawerUpdate = {
  savedCall?: LeadCallRow;
  leadPatch?: LeadActionState["leadPatch"];
  refreshList?: boolean;
};

const inputCls =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const labelCls = "block text-sm font-medium text-slate-700";

function startUiMeasure(name: string) {
  if (typeof performance === "undefined") return;
  performance.clearMarks(`${name}:start`);
  performance.clearMarks(`${name}:end`);
  performance.clearMeasures(name);
  performance.mark(`${name}:start`);
}

function finishUiMeasure(name: string) {
  if (typeof performance === "undefined" || !performance.getEntriesByName(`${name}:start`).length) return;
  performance.mark(`${name}:end`);
  performance.measure(name, `${name}:start`, `${name}:end`);
  const duration = performance.getEntriesByName(name).at(-1)?.duration;
  if (duration != null && process.env.NODE_ENV !== "test") {
    console.info(`[Kapso performance] ${name} en ${Math.round(duration)} ms`);
    if (
      name === "kapso:call-save" ||
      name === "kapso:whatsapp-chat-first-paint" ||
      name === "kapso:whatsapp-send"
    ) {
      reportClientPerformanceMetric(name, duration);
    }
  }
}

/** Canonical acquisition-source bucket for a lead's `source` (Fuente filter). */
function leadSourceKey(
  s: string | null | undefined,
): "meta_ad" | "fb_web" | "cod_cart" | "abandoned_browse" | "organic" {
  return s === "meta_ad"
    ? "meta_ad"
    : s === "fb_web"
      ? "fb_web"
      : s === "cod_cart"
        ? "cod_cart"
        : s === "abandoned_browse"
          ? "abandoned_browse"
          : "organic";
}
function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-PE");
}

/** "12 may" — compact day+month for the previous-orders list. */
function orderDateShort(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("es-PE", { day: "numeric", month: "short" });
}

/** One label/value line inside the Meta attribution block (drawer). */
function MetaField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-xs font-medium text-violet-700/70">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-violet-900">{children}</dd>
    </div>
  );
}

/** Full Meta ad attribution for the lead drawer: the real creative plus the
 *  campaign / adset / objective / status chain behind the Click-to-WhatsApp
 *  lead. Falls back to a one-liner when the ad_id hasn't been resolved into the
 *  `meta_ads` lookup yet (only headline + id are then known). */
function MetaAttribution({ lead, adMeta }: { lead: LeadRow; adMeta: AdMeta | null }) {
  const [open, setOpen] = useState(false);
  const name = adMeta?.adName ? prettyAdName(adMeta.adName) : null;
  const href = adsManagerUrl(adMeta?.accountId ?? null, lead.ad_id ?? "");
  const objective = adObjectiveLabel(adMeta?.objective ?? null);
  const status = adStatusLabel(adMeta?.status ?? null);
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2"
      >
        <span className="text-xs font-semibold tracking-wide uppercase opacity-80">📣 Campaña Meta</span>
        <span className="shrink-0 text-xs text-violet-700">{open ? "ocultar ▲" : "ver más ▼"}</span>
      </button>
      {!open ? (
        <p className="mt-1 truncate text-xs text-violet-800">
          {lead.ad_headline || name || "Llegó por un anuncio de Meta"}
        </p>
      ) : (
        <dl className="mt-1.5 space-y-1">
        {lead.ad_headline && <MetaField label="Titular">{lead.ad_headline}</MetaField>}
        {name ? (
          <MetaField label="Anuncio">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-violet-800 underline decoration-violet-300 hover:decoration-violet-600"
              >
                {name}
              </a>
            ) : (
              <span className="font-medium">{name}</span>
            )}
          </MetaField>
        ) : (
          <p className="text-violet-800">📣 Llegó por un anuncio de Meta (Click-to-WhatsApp)</p>
        )}
        {adMeta?.adsetName && <MetaField label="Conjunto">{adMeta.adsetName}</MetaField>}
        {adMeta?.campaignName && <MetaField label="Campaña">{adMeta.campaignName}</MetaField>}
        {objective && <MetaField label="Objetivo">{objective}</MetaField>}
        {status && (
          <MetaField label="Estado">
            {status.label}
            {adMeta?.fetchedAt
              ? ` · al ${new Date(adMeta.fetchedAt).toLocaleDateString("es-PE")}`
              : ""}
          </MetaField>
        )}
        {lead.ad_id && (
          <p className="pt-0.5 text-xs break-all text-violet-700/70">
            id {lead.ad_id}
            {lead.ctwa_clid ? ` · clic ${lead.ctwa_clid}` : ""}
          </p>
        )}
        </dl>
      )}
    </div>
  );
}

const SEGMENT_BADGE: Record<LeadSegment, string> = {
  carrito: "bg-emerald-50 text-emerald-700",
  distrito: "bg-red-50 text-red-600",
  converso: "bg-blue-50 text-blue-700",
  frio: "bg-slate-100 text-slate-500",
};

// Plain calificación labels (no emoji) for the row/drawer pills, per the redesign.
const SEG_PILL_LABEL: Record<LeadSegment, string> = {
  carrito: "Con carrito",
  distrito: "Dio distrito",
  converso: "Conversó",
  frio: "Frío",
};

// Labels for the segment "accesos directos" row (only Carrito carries an emoji).
const SEG_TAB_LABEL: Record<LeadSegment, string> = {
  carrito: "🛒 Carrito",
  distrito: "Dio distrito",
  converso: "Conversó",
  frio: "Frío",
};

// Terminal outcomes shown in the Calificación column instead of an engagement
// segment — a cancelled lead is "Perdidos", not "🛒 Con carrito".
const OUTCOME_SEG_BADGE: Record<"won" | "lost", { label: string; cls: string }> = {
  won: { label: "Ganados", cls: "bg-emerald-100 text-emerald-700" },
  lost: { label: "Perdidos", cls: "bg-slate-200 text-slate-600" },
};

/** Calificación chip per row. Active leads (open/hot) show their engagement level
 *  (Frío → Conversó → Dio distrito → Con carrito); leads that are already won or
 *  lost show the outcome (Ganados/Perdidos) — the engagement level is meaningless
 *  once the lead is closed, and "Con carrito" on a cancelled lead is misleading.
 *  The specific reason (e.g. "Cancelado por cliente") stays available on hover. */
function SegmentBadge({ lead }: { lead: LeadRow }) {
  const cat = categoryOf(lead.status);
  if (cat === "won" || cat === "lost") {
    const b = OUTCOME_SEG_BADGE[cat];
    return (
      <span
        className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", b.cls)}
        title={labelOf(lead.status)}
      >
        {b.label}
      </span>
    );
  }
  const seg = leadSegment(lead);
  return (
    <span className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", SEGMENT_BADGE[seg])}>
      {SEG_PILL_LABEL[seg]}
    </span>
  );
}

const AVATAR_TINTS = [
  "bg-brand-50 text-brand-700",
  "bg-violet-50 text-violet-700",
  "bg-emerald-50 text-emerald-700",
  "bg-amber-50 text-amber-700",
  "bg-sky-50 text-sky-700",
  "bg-orange-50 text-orange-700",
];
function avatarTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % AVATAR_TINTS.length;
  return AVATAR_TINTS[h]!;
}

// Square source chip (📣 Campaña / 🌐 Meta/Web / 🛒 Carrito / 🔎 Búsqueda / "Directo").
const SOURCE_CHIP: Record<
  "meta_ad" | "fb_web" | "cod_cart" | "abandoned_browse" | "organic",
  { glyph: string; label: string; cls: string; title: string; isText?: boolean }
> = {
  meta_ad: { glyph: "📣", label: "Campaña", cls: "bg-violet-100 text-violet-700", title: "Campaña Meta (Click-to-WhatsApp, con anuncio)" },
  fb_web: { glyph: "🌐", label: "Meta/Web", cls: "bg-sky-100 text-sky-700", title: "Llegó por un link de Meta (Facebook/Instagram) en la web (sin anuncio confirmado)" },
  cod_cart: { glyph: "🛒", label: "Carrito", cls: "bg-emerald-100 text-emerald-700", title: "Carrito abandonado (formulario COD)" },
  abandoned_browse: { glyph: "🔎", label: "Búsqueda", cls: "bg-orange-100 text-orange-700", title: "Búsqueda abandonada" },
  organic: { glyph: "Directo", label: "Directo", cls: "bg-slate-100 text-slate-500", title: "Orgánico / directo", isText: true },
};
function SourceChip({ source }: { source: string | null | undefined }) {
  const s = SOURCE_CHIP[leadSourceKey(source)];
  return (
    <span
      title={s.title}
      className={cn(
        "inline-flex h-5 min-w-[22px] shrink-0 items-center justify-center rounded-md px-1.5 font-semibold leading-none",
        s.isText ? "text-[10px]" : "text-[11px]",
        s.cls,
      )}
    >
      {s.glyph}
    </span>
  );
}

const WIN_DISPLAY: Record<"fresca" | "por_vencer" | "cerrada", { dot: string; fg: string; accent: string }> = {
  fresca: { dot: "bg-emerald-500", fg: "text-emerald-700", accent: "#34d399" },
  por_vencer: { dot: "bg-amber-500", fg: "text-amber-700", accent: "#fbbf24" },
  cerrada: { dot: "bg-slate-400", fg: "text-slate-500", accent: "#cbd5e1" },
};
function winKey(state: LeadWindow | null): "fresca" | "por_vencer" | "cerrada" {
  if (state === "por_vencer" || state === "critica") return "por_vencer";
  if (state === "cerrada") return "cerrada";
  return "fresca"; // fresca or null (no inbound yet) → neutral-fresh accent
}

/** Small rounded pill (header/drawer chips). */
function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

// Chip para leads Yape/Shalom: distingue si el handoff fue por 💰 pago (verificar
// Yape) o 📦 agencia (coordinar el envío por Shalom/Olva). Se deriva del motivo del
// handoff — no parte la pestaña, solo aclara de un vistazo qué media es.
const YAPE_KIND_CHIP: Record<YapeKind, { glyph: string; label: string; cls: string; title: string }> = {
  pago: { glyph: "💰", label: "Pago", cls: "bg-amber-100 text-amber-800", title: "Verificar el pago (Yape / comprobante)" },
  agencia: { glyph: "📦", label: "Agencia", cls: "bg-indigo-100 text-indigo-700", title: "Coordinar el envío por agencia (Shalom / Olva)" },
};

/** Chip 💰 Pago / 📦 Agencia — solo para leads en Yape/Shalom (`yape_por_verificar`). */
function YapeKindChip({ lead }: { lead: LeadRow }) {
  if (lead.status !== "yape_por_verificar") return null;
  const k = YAPE_KIND_CHIP[yapeKind(lead.handoff_reason, lead.handoff_context)];
  return (
    <Pill className={k.cls} title={k.title}>
      {`${k.glyph} ${k.label}`}
    </Pill>
  );
}

export function LeadDrawer({
  lead,
  calls,
  history,
  adMeta,
  waNumber,
  shopifyDomain,
  currency,
  onClose,
  onRegistered,
  onReady,
}: LeadDrawerProps) {
  const handoffTone = categoryOf(lead.status) === "hot" ? "red" : "amber";
  const [orderOpen, setOrderOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingWon, startConfirmWon] = useTransition();
  const readyReportedRef = useRef(false);

  useEffect(() => {
    if (readyReportedRef.current) return;
    readyReportedRef.current = true;
    onReady?.();
  }, [onReady]);

  // Live sync while a lead WITHOUT an order is open: a Yape/bot purchase links the
  // order a few seconds later (webhook → lead becomes won). Poll the lead's
  // order/status signal every 12s and, the moment it flips, refresh the drawer —
  // so the asesora sees "✅ Pedido generado" instead of a stale "pendiente" (which
  // is what led to mistakenly marking a real sale as "ya compró en otro lado").
  // Stops once the lead has an order (deps change) or the drawer closes (unmount).
  const onRegisteredRef = useRef(onRegistered);
  onRegisteredRef.current = onRegistered;
  useEffect(() => {
    if (lead.has_order) return; // already won → nothing to watch
    let inFlight = false;
    const id = setInterval(() => {
      if (inFlight || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      inFlight = true;
      void pollLeadState(lead.id)
        .then((r) => {
          if ("error" in r) return;
          if (r.hasOrder !== lead.has_order || r.status !== lead.status || r.category !== lead.category) {
            onRegisteredRef.current(); // real change → full refresh (lead + historial + lista)
          }
        })
        .finally(() => {
          inFlight = false;
        });
    }, 12_000);
    return () => clearInterval(id);
  }, [lead.id, lead.has_order, lead.status, lead.category]);

  // cod_cart sin conversación → empty-state; el resto muestra el chat (que se
  // resuelve por teléfono si no hay conversation_id guardado).
  const hasWa = lead.source !== "cod_cart" || !!lead.kapso_conversation_id;
  const hasCart = !!lead.draft_order_gid && lead.draft_order_status !== "completed";
  // "Ver borrador" abre el draft en el ADMIN de Shopify, no el checkout del
  // cliente (invoiceUrl); ese queda solo como fallback si falta gid/dominio.
  const draftOrderHref =
    shopifyDraftOrderAdminUrl(shopifyDomain, lead.draft_order_gid) ?? lead.draft_order_url ?? null;
  // Recurrent if there are prior purchases — either the local last-order signal or
  // the (authoritative) Shopify "Pedidos anteriores" list, which catches customers
  // whose past orders were placed outside the bot (not in the kapso-only table).
  const isRecurrent = !!history?.lastOrderAt || (history?.recentOrders?.length ?? 0) > 0;
  const { state: winState, msLeft } = leadWindowInfo(lead.last_inbound_at ?? lead.last_interaction_at, Date.now());
  const wd = WIN_DISPLAY[winKey(winState)];
  const winLabel =
    winState === null
      ? "Sin ventana"
      : winState === "cerrada"
        ? "Ventana vencida"
        : `${Math.max(1, Math.ceil((msLeft ?? 0) / 3_600_000))}h restantes`;
  const src = SOURCE_CHIP[leadSourceKey(lead.source)];
  const initial = (lead.name || lead.phone).trim()[0]?.toUpperCase() || "?";

  async function copyPhone() {
    try {
      await navigator.clipboard.writeText(`+${lead.phone}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard no disponible */
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-10 bg-slate-900/30" onClick={onClose} aria-hidden="true" />
      <aside className="@container fixed inset-y-0 right-0 z-20 flex h-full w-[min(880px,96%)] flex-col border-l border-slate-200 bg-slate-50 shadow-xl">
        {/* Header */}
        <div className="border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-semibold",
                avatarTint(lead.id),
              )}
            >
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-slate-900">{lead.name || lead.phone}</h2>
                {isRecurrent && <Pill className="bg-amber-50 text-amber-700">★ Recurrente</Pill>}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
                <span className="tabular-nums text-slate-700">+{lead.phone}</span>
                <button
                  type="button"
                  onClick={copyPhone}
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                  {copied ? "copiado" : "copiar"}
                </button>
                <a href={`tel:+${lead.phone}`} className="text-xs text-slate-400 hover:text-slate-600">
                  · llamar
                </a>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              ✕
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Pill className="bg-slate-100">
              <span className={cn("h-1.5 w-1.5 rounded-full", wd.dot)} />
              <span className={wd.fg}>{winLabel}</span>
            </Pill>
            <SegmentBadge lead={lead} />
            <Pill className={src.cls}>{src.isText ? src.label : `${src.glyph} ${src.label}`}</Pill>
            <YapeKindChip lead={lead} />
          </div>
        </div>

        {/* Body: conversación (izq) · acción (der). Se apila ≤720px de ancho del panel. */}
        <div className="flex min-h-0 flex-1 flex-col @min-[720px]:flex-row">
          {/* Izquierda · conversación de WhatsApp */}
          <div className="flex max-h-[55vh] min-h-0 flex-col border-b border-slate-200 @min-[720px]:max-h-none @min-[720px]:w-1/2 @min-[720px]:border-r @min-[720px]:border-b-0">
            {hasWa ? (
              <WhatsappChat
                leadId={lead.id}
                lastInboundAt={lead.last_inbound_at}
                hasConversation={!!(lead.kapso_conversation_id || lead.phone)}
                onSent={onRegistered}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-100 text-violet-700">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
                    <path d="m4 4 16 16" />
                  </svg>
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-800">Sin conversación de WhatsApp</p>
                  <p className="mt-1 text-sm text-slate-500">
                    El cliente abandonó un carrito web sin escribir. Llámalo para recuperar la venta.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={copyPhone}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-slate-50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                  {copied ? "Copiado" : `Copiar +${lead.phone}`}
                </button>
              </div>
            )}
          </div>

          {/* Derecha · acción (scroll propio; el formulario de pedido la cubre al abrirse) */}
          <div className="relative min-h-0 flex-1 @min-[720px]:w-1/2">
            <div className="h-full space-y-4 overflow-y-auto p-5">
              {/* Contexto: carrito/producto visto + entrega */}
              {(lead.cart_item_count || lead.district || lead.draft_order_gid || lead.cart_summary) && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                  {lead.draft_order_gid && (
                    <p className="mb-1 text-xs font-semibold tracking-wide text-emerald-700/80 uppercase">
                      {lead.draft_order_status === "completed" ? "✅ Carrito recuperado" : "🛒 Carrito abandonado"}
                      {lead.draft_order_name ? ` · ${lead.draft_order_name}` : ""}
                    </p>
                  )}
                  {lead.cart_item_count ? (
                    <p>
                      🛒 <span className="font-medium">Carrito:</span>{" "}
                      {lead.cart_summary || `${lead.cart_item_count} producto(s)`}
                      {lead.cart_value != null ? ` · ${currency} ${Number(lead.cart_value).toFixed(2)}` : ""}
                    </p>
                  ) : lead.cart_summary ? (
                    <p>
                      🔎 <span className="font-medium">Vio:</span> {lead.cart_summary}
                    </p>
                  ) : null}
                  {(lead.ship_name || lead.address1 || lead.district || lead.referencia) && (
                    <div className={lead.cart_item_count ? "mt-1 space-y-0.5" : "space-y-0.5"}>
                      {lead.ship_name && lead.ship_name !== lead.name && (
                        <p>
                          👤 <span className="font-medium">Recibe:</span> {lead.ship_name}
                        </p>
                      )}
                      {lead.address1 && (
                        <p>
                          🏠 <span className="font-medium">Dirección:</span> {lead.address1}
                        </p>
                      )}
                      {lead.referencia && <p className="text-emerald-800/90">Ref: {lead.referencia}</p>}
                      {lead.district && (
                        <p>
                          📍 <span className="font-medium">Distrito:</span> {lead.district}
                          {lead.province ? <span className="text-emerald-800/70"> · {lead.province}</span> : null}
                        </p>
                      )}
                    </div>
                  )}
                  {draftOrderHref && (
                    <a
                      href={draftOrderHref}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-block text-xs font-medium text-emerald-700 underline hover:text-emerald-900"
                    >
                      Ver borrador en Shopify ↗
                    </a>
                  )}
                </div>
              )}

              {/* Resumen del bot */}
              {lead.handoff_context && (
                <div
                  className={cn(
                    "rounded-xl border px-3 py-2.5 text-sm",
                    handoffTone === "red"
                      ? "border-red-200 bg-red-50 text-red-800"
                      : "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                >
                  <p className="text-xs font-semibold tracking-wide uppercase opacity-80">Resumen del bot</p>
                  <p className="mt-1 whitespace-pre-wrap">{lead.handoff_context}</p>
                </div>
              )}

              {/* Asignar Yape (solo admins; se auto-oculta para vendedoras) */}
              {lead.status === "yape_por_verificar" && (
                <YapeAssign leadId={lead.id} storeId={lead.store_id} onAssigned={onRegistered} />
              )}

              {/* Pedidos anteriores: últimos 3 pedidos de Shopify de este cliente */}
              {history && history.recentOrders.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                      Pedidos anteriores · {history.recentOrders.length}
                    </p>
                    <span className="shrink-0 text-xs font-semibold text-emerald-700">
                      {currency} {history.recentOrders.reduce((s, o) => s + o.amount, 0).toFixed(2)} en total
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {history.recentOrders.map((o, i) => (
                      <div
                        key={o.name ?? i}
                        className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
                      >
                        <span className="truncate text-sm font-medium text-slate-800">Pedido {o.name ?? "—"}</span>
                        <span className="flex shrink-0 items-center gap-2.5">
                          <span className="text-xs text-slate-400">{orderDateShort(o.createdAt)}</span>
                          <span className="text-sm font-semibold text-emerald-700">
                            {currency} {o.amount.toFixed(2)}
                          </span>
                          {o.adminUrl && (
                            <a
                              href={o.adminUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Abrir en Shopify"
                              aria-label={`Abrir ${o.name ?? "pedido"} en Shopify (nueva pestaña)`}
                              className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
                            >
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M7 17 17 7" />
                                <path d="M8 7h9v9" />
                              </svg>
                            </a>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Resultado de la llamada */}
              <CallForm leadId={lead.id} onRegistered={onRegistered} />

              {/* Historial (timeline) */}
              <section>
                <p className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Historial</p>
                {calls === null ? (
                  <p className="text-sm text-slate-400">Cargando historial…</p>
                ) : calls.length ? (
                  <div>
                    {calls.map((c, i) => {
                      const last = i === calls.length - 1;
                      return (
                        <div key={c.id ?? i} className="flex gap-2.5">
                          <div className="flex flex-col items-center">
                            <span
                              className={cn(
                                "mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2 bg-white",
                                c.kind === "message"
                                  ? "border-emerald-500"
                                  : c.new_status
                                    ? "border-brand-500"
                                    : "border-slate-300",
                              )}
                            />
                            {!last && <span className="my-0.5 w-0.5 flex-1 bg-slate-200" />}
                          </div>
                          <div className={cn("min-w-0", last ? "pb-0" : "pb-3")}>
                            <p className="text-sm text-slate-800">
                              {c.kind === "message" ? (
                                <span className="font-medium text-brand-700">📤 WhatsApp</span>
                              ) : c.new_status ? (
                                <span className="font-medium">{labelOf(c.new_status)}</span>
                              ) : (
                                <span className="text-slate-500">Nota</span>
                              )}
                            </p>
                            {c.note && <p className="mt-0.5 text-sm text-slate-600">{c.note}</p>}
                            <p className="mt-0.5 text-[11px] text-slate-400">
                              {fmtDate(c.occurred_at)}
                              {c.vendedora_name ? ` · ${c.vendedora_name}` : ""}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">Sin actividad todavía.</p>
                )}
              </section>

              {/* Número de WhatsApp */}
              {lead.wa_phone_number_id && (
                <p className="text-xs text-slate-500">
                  📱 WhatsApp:{" "}
                  <span className="font-medium text-slate-700">
                    {waNumber?.name ?? waNumber?.displayPhone ?? "número sin nombre"}
                  </span>
                  {waKindLabel(waNumber?.kind ?? null) ? ` · ${waKindLabel(waNumber?.kind ?? null)}` : ""}
                </p>
              )}

              {/* Campaña Meta */}
              {lead.source === "meta_ad" && <MetaAttribution lead={lead} adMeta={adMeta} />}
            </div>

            {/* Formulario de pedido: lo abre el CTA del footer; cubre la columna de acción.
                allowExisting permite generar OTRO pedido aunque el lead ya tenga uno. */}
            {orderOpen && (
              <div className="absolute inset-0 overflow-y-auto bg-slate-50 p-4">
                <OrderFormPanel
                  leadId={lead.id}
                  currency={currency}
                  hasCart={hasCart}
                  allowExisting={lead.has_order}
                  onRegistered={onRegistered}
                  onClose={() => setOrderOpen(false)}
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer CTA: cierre de venta (oculto mientras el formulario está abierto) */}
        {!orderOpen && (
          <div className="border-t border-slate-200 bg-white p-3.5">
            {lead.has_order ? (
              <div className="space-y-2">
                {/* Lead has an order but the auto-linker didn't mark it won (a later
                    call disposition took precedence). Let the asesor confirm it. */}
                {lead.category !== "won" && (
                  <button
                    type="button"
                    onClick={() =>
                      startConfirmWon(async () => {
                        await confirmLeadWon(lead.id);
                        onRegistered();
                      })
                    }
                    disabled={confirmingWon}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {confirmingWon ? "Marcando…" : "Marcar como ganado (ya tiene pedido)"}
                  </button>
                )}
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium text-emerald-700">
                    ✅ Pedido generado{history?.currentOrderName ? ` · ${history.currentOrderName}` : ""}
                  </p>
                  <button
                    type="button"
                    onClick={() => setOrderOpen(true)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    Generar nuevo pedido
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setOrderOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 11l3 3 8-8" />
                  <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
                </svg>
                {hasCart ? "Generar pedido (contraentrega)" : "Registrar pedido (contraentrega)"}
              </button>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

const MEDIA_KIND_META: Record<NonNullable<LeadConversationMessage["mediaKind"]>, { icon: string; label: string }> = {
  image: { icon: "🖼️", label: "Imagen" },
  audio: { icon: "🎧", label: "Audio" },
  video: { icon: "🎬", label: "Video" },
  document: { icon: "📄", label: "Documento" },
  sticker: { icon: "🩷", label: "Sticker" },
};

/** yyyy-mm-dd key (local) for grouping chat messages by day. */
function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** WhatsApp-style day separator label: Hoy / Ayer / "26 jun". */
function chatDayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return "Hoy";
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay(d, yest)) return "Ayer";
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
}

/** Time-only (HH:mm) shown inside a chat bubble. */
function chatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * The lead's WhatsApp chat as a self-contained widget — the full conversation
 * (text + inline images like Yape vouchers) with the composer attached at the
 * bottom, styled like WhatsApp. Loads when the drawer opens (resolving the
 * conversation by phone if no id was stored) and refreshes after each send.
 */
function WhatsappChat({
  leadId,
  lastInboundAt,
  hasConversation,
  onSent,
}: {
  leadId: string;
  lastInboundAt?: string | null;
  hasConversation: boolean;
  onSent: (update?: LeadDrawerUpdate) => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | {
        status: "ready";
        messages: LeadConversationMessage[];
        reason?: string;
        threads: LeadThread[];
        activeId: string | null;
        activePhoneNumberId: string | null;
      }
  >({ status: "loading" });
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true); // is the user near the bottom of the thread?
  const countRef = useRef(0); // previous message count, to detect new arrivals
  const activeIdRef = useRef<string | null>(null); // active thread (for silent polls)
  const requestRef = useRef(0); // ignore a slower response after switching threads/leads
  const [showJump, setShowJump] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const load = useCallback(
    (opts?: { silent?: boolean; conversationId?: string }) => {
      const requestId = ++requestRef.current;
      if (!opts?.silent) {
        startUiMeasure("kapso:whatsapp-chat-first-paint");
        setState({ status: "loading" });
      }
      let firstPaintPending = !opts?.silent;
      const apply = (res: Awaited<ReturnType<typeof loadLeadConversation>>) => {
        if (requestRef.current !== requestId) return;
        activeIdRef.current = res.activeConversationId;
        setState((current) => {
          const localMessages =
            current.status === "ready"
              ? current.messages.filter((message) => message.id?.startsWith("local-") && message.status === "sending")
              : [];
          return {
            status: "ready",
            messages: [...res.messages, ...localMessages],
            reason: res.reason,
            threads: res.threads,
            activeId: res.activeConversationId,
            activePhoneNumberId: res.activePhoneNumberId,
          };
        });
        if (firstPaintPending) {
          firstPaintPending = false;
          finishUiMeasure("kapso:whatsapp-chat-first-paint");
        }
      };
      // First paint reads only the active session. Older sessions are merged in
      // a silent follow-up, while 20s polls remain cheap and active-session only.
      loadLeadConversation(leadId, opts?.conversationId, false).then((res) => {
        apply(res);
        if (!opts?.silent && res.activeConversationId) {
          void loadLeadConversation(leadId, res.activeConversationId, true).then(apply);
        }
      });
    },
    [leadId],
  );

  // Load on open; reset scroll/thread tracking when switching leads.
  useEffect(() => {
    atBottomRef.current = true;
    countRef.current = 0;
    activeIdRef.current = null;
    setShowJump(false);
    setSearch("");
    if (hasConversation) load();
  }, [hasConversation, load]);

  // Live updates: refresh the ACTIVE thread quietly every 20s while open + visible.
  useEffect(() => {
    if (!hasConversation) return;
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        load({ silent: true, conversationId: activeIdRef.current ?? undefined });
      }
    }, 20000);
    return () => clearInterval(id);
  }, [hasConversation, load]);

  // Smart scroll: stick to the bottom only if the user is already there; otherwise
  // surface a "nuevos mensajes" button when new messages arrive while scrolled up.
  useEffect(() => {
    if (state.status !== "ready") return;
    const el = scrollRef.current;
    const grew = state.messages.length > countRef.current;
    countRef.current = state.messages.length;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      // Re-anchor after layout settles (bubbles/players expanding).
      requestAnimationFrame(() => {
        const e = scrollRef.current;
        if (e && atBottomRef.current) e.scrollTop = e.scrollHeight;
      });
      setShowJump(false);
    } else if (grew) {
      setShowJump(true);
    }
  }, [state]);

  // Imágenes/audio/video cargan async y crecen el hilo, empujando el contenido;
  // re-anclamos al fondo cuando cada uno carga (solo si ya estabas abajo). El
  // evento `load` no burbujea → se escucha en fase de captura.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onMediaLoad = () => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("load", onMediaLoad, true);
    return () => el.removeEventListener("load", onMediaLoad, true);
  }, [hasConversation]);

  function onThreadScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottomRef.current = nearBottom;
    if (nearBottom) setShowJump(false);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  }

  function addOptimisticMessage(body: string): string {
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            messages: [
              ...current.messages,
              {
                id: localId,
                direction: "outbound",
                at: new Date().toISOString(),
                text: body,
                mediaKind: null,
                mediaUrl: null,
                status: "sending",
              },
            ],
          }
        : current,
    );
    return localId;
  }

  function settleOptimisticMessage(localId: string, sent: LeadConversationMessage | null) {
    setState((current) => {
      if (current.status !== "ready") return current;
      if (!sent) return { ...current, messages: current.messages.filter((message) => message.id !== localId) };
      return {
        ...current,
        messages: current.messages.map((message) =>
          message.id === localId ? { ...sent, id: sent.id ?? localId } : message,
        ),
      };
    });
  }

  async function retryMessage(message: LeadConversationMessage) {
    if (!message.outboxId || retryingId) return;
    setRetryingId(message.outboxId);
    try {
      const result = await retryLeadMessage(leadId, message.outboxId);
      setState((current) => {
        if (current.status !== "ready" || !result.sentMessage) return current;
        return {
          ...current,
          messages: current.messages.map((item) =>
            item.outboxId === message.outboxId ? result.sentMessage! : item,
          ),
        };
      });
      if (!result.error) onSent({ leadPatch: result.leadPatch });
    } finally {
      setRetryingId(null);
    }
  }

  // Switch to another number's thread (multi-number lead).
  function switchThread(convId: string) {
    if (convId === activeIdRef.current) return;
    atBottomRef.current = true;
    setShowJump(false);
    setSearch("");
    load({ conversationId: convId });
  }

  if (!hasConversation) return null;

  const threads = state.status === "ready" ? state.threads : [];
  const activeId = state.status === "ready" ? state.activeId : null;
  const activePhoneNumberId = state.status === "ready" ? state.activePhoneNumberId : null;
  const allMessages = state.status === "ready" ? state.messages : [];
  const transcriptLastInboundAt = [...allMessages].reverse().find((message) => message.direction === "inbound")?.at;
  const effectiveLastInboundAt = transcriptLastInboundAt ?? lastInboundAt;
  const activeThread = threads.find((t) => t.conversationId === activeId) ?? null;
  // Clarify which number you reply FROM — only when the lead has more than one.
  const numberHint =
    threads.length > 1 && activeThread
      ? activeThread.displayPhone
        ? `${activeThread.label} · ${activeThread.displayPhone}`
        : activeThread.label
      : null;
  const q = search.trim().toLowerCase();
  const messages = q ? allMessages.filter((m) => m.text.toLowerCase().includes(q)) : allMessages;
  // Interleave day separators ("Hoy", "Ayer", "26 jun") into the (filtered) thread.
  const rows: ReactNode[] = [];
  let lastDay = "";
  messages.forEach((m, i) => {
    const day = dayKeyOf(m.at);
    if (day !== lastDay) {
      rows.push(
        <div key={`day-${i}`} className="flex justify-center py-1.5">
          <span className="rounded-full bg-white/80 px-2.5 py-0.5 text-[11px] font-medium text-slate-500 shadow-sm">
            {chatDayLabel(m.at)}
          </span>
        </div>,
      );
      lastDay = day;
    }
    rows.push(
      <ChatBubble
        key={m.id ?? `m-${i}`}
        leadId={leadId}
        msg={m}
        highlight={q}
        onRetry={retryMessage}
        retrying={retryingId === m.outboxId}
      />,
    );
  });

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-white">
      {/* Cabecera estilo WhatsApp */}
      <div className="flex items-center justify-between gap-2 bg-emerald-600 px-3 py-2 text-white">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden>💬</span>
          <span className="truncate text-sm font-semibold">Conversación de WhatsApp</span>
          {state.status === "ready" && state.messages.length > 0 && (
            <span className="shrink-0 text-xs text-emerald-100">· {state.messages.length}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setSearchOpen((s) => !s)}
            title="Buscar en la conversación"
            aria-label="Buscar"
            className={cn(
              "rounded-full px-1.5 text-base leading-none hover:bg-white/15 hover:text-white",
              searchOpen ? "text-white" : "text-emerald-100",
            )}
          >
            🔍
          </button>
          <button
            type="button"
            onClick={() => load()}
            title="Actualizar"
            aria-label="Actualizar conversación"
            className="rounded-full px-1.5 text-lg leading-none text-emerald-100 hover:bg-white/15 hover:text-white"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Selector de número: solo si el cliente escribió a más de un número */}
      {threads.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-2 py-1.5">
          {threads.map((t) => (
            <button
              key={t.conversationId}
              type="button"
              onClick={() => switchThread(t.conversationId)}
              title={t.displayPhone ?? undefined}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
                t.conversationId === activeId
                  ? "bg-emerald-600 text-white"
                  : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-100",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Buscar dentro de la conversación */}
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Buscar en la conversación…"
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
          {q && (
            <span className="shrink-0 text-xs text-slate-500">
              {messages.length} {messages.length === 1 ? "coincidencia" : "coincidencias"}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setSearchOpen(false);
            }}
            className="shrink-0 text-sm text-slate-400 hover:text-slate-700"
            aria-label="Cerrar búsqueda"
          >
            ✕
          </button>
        </div>
      )}

      {/* Hilo de mensajes */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onThreadScroll}
          className="absolute inset-0 space-y-1 overflow-y-auto bg-[#efeae2] px-3 py-3"
        >
          {state.status === "loading" ? (
            <p className="py-10 text-center text-sm text-slate-500">Cargando conversación…</p>
          ) : messages.length ? (
            rows
          ) : (
            <p className="py-10 text-center text-sm text-slate-500">
              {state.status !== "ready"
                ? ""
                : q
                  ? `Sin coincidencias para «${search.trim()}»`
                  : (state.reason ?? "Sin mensajes todavía.")}
            </p>
          )}
        </div>
        {showJump && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-emerald-600 px-3 py-1 text-xs font-medium text-white shadow-md hover:bg-emerald-700"
          >
            ↓ Nuevos mensajes
          </button>
        )}
      </div>

      {/* Composer pegado abajo */}
      <WhatsappComposer
        leadId={leadId}
        lastInboundAt={effectiveLastInboundAt}
        phoneNumberId={activePhoneNumberId}
        numberHint={numberHint}
        onOptimisticSend={addOptimisticMessage}
        onSendSettled={settleOptimisticMessage}
        onSent={(leadPatch) => onSent({ leadPatch })}
      />
    </section>
  );
}

/** Render message text with clickable http(s) links. */
function linkify(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="underline">
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/** Render text with case-insensitive <mark> highlights of `term` (already lowercased). */
function highlightText(text: string, term: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  let pos = rest.toLowerCase().indexOf(term);
  while (pos >= 0 && term) {
    if (pos > 0) out.push(<span key={`t${k}`}>{rest.slice(0, pos)}</span>);
    out.push(
      <mark key={`h${k}`} className="rounded bg-yellow-200 px-0.5">
        {rest.slice(pos, pos + term.length)}
      </mark>,
    );
    rest = rest.slice(pos + term.length);
    k++;
    pos = rest.toLowerCase().indexOf(term);
  }
  if (rest) out.push(<span key={`t${k}`}>{rest}</span>);
  return out;
}

/** WhatsApp delivery ticks for an outbound message (null = no indicator). */
function statusTicks(status: string | null): { marks: string; cls: string; label: string } | null {
  switch (status) {
    case "read":
      return { marks: "✓✓", cls: "text-sky-500", label: "Leído" };
    case "delivered":
      return { marks: "✓✓", cls: "text-emerald-800/50", label: "Entregado" };
    case "sent":
      return { marks: "✓", cls: "text-emerald-800/50", label: "Enviado" };
    case "pending":
    case "sending":
      return { marks: "◷", cls: "text-emerald-800/40", label: "Enviando" };
    case "unknown":
      return { marks: "?", cls: "text-amber-600", label: "Estado por confirmar" };
    case "failed":
    case "error":
      return { marks: "⚠", cls: "text-red-500", label: "No se envió" };
    default:
      return null;
  }
}

/** One WhatsApp bubble: customer (left/white) vs. business (right/WA green), with
 *  inline image/audio/video players, delivery ticks (outbound) and clickable links. */
function ChatBubble({
  leadId,
  msg,
  highlight,
  onRetry,
  retrying,
}: {
  leadId: string;
  msg: LeadConversationMessage;
  highlight?: string;
  onRetry: (message: LeadConversationMessage) => void;
  retrying: boolean;
}) {
  const outbound = msg.direction === "outbound";
  const mediaSrc = msg.mediaUrl ? `/api/leads/${leadId}/media?u=${encodeURIComponent(msg.mediaUrl)}` : null;
  const meta = msg.mediaKind ? MEDIA_KIND_META[msg.mediaKind] : null;
  const ticks = outbound ? statusTicks(msg.status) : null;
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-2.5 py-1.5 text-sm shadow-sm",
          outbound ? "rounded-tr-sm bg-[#d9fdd3] text-slate-900" : "rounded-tl-sm bg-white text-slate-800",
        )}
      >
        {mediaSrc && (msg.mediaKind === "image" || msg.mediaKind === "sticker") ? (
          <a href={mediaSrc} target="_blank" rel="noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mediaSrc}
              alt={msg.text || "Imagen"}
              loading="lazy"
              className={cn(
                "rounded-lg object-cover",
                msg.mediaKind === "sticker" ? "max-h-28" : "mb-1 max-h-64 w-full",
              )}
            />
          </a>
        ) : mediaSrc && msg.mediaKind === "audio" ? (
          <audio controls preload="none" src={mediaSrc} className="mb-1 h-9 w-56 max-w-full" />
        ) : mediaSrc && msg.mediaKind === "video" ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video controls preload="none" src={mediaSrc} className="mb-1 max-h-64 w-full rounded-lg" />
        ) : mediaSrc && meta ? (
          <a
            href={mediaSrc}
            target="_blank"
            rel="noreferrer"
            className="mb-0.5 flex items-center gap-1.5 font-medium text-emerald-700 hover:underline"
          >
            <span>{meta.icon}</span> {meta.label}
          </a>
        ) : null}
        {msg.text && (
          <p className="break-words whitespace-pre-wrap">
            {highlight ? highlightText(msg.text, highlight) : linkify(msg.text)}
          </p>
        )}
        <p
          className={cn(
            "mt-0.5 flex items-center justify-end gap-1 text-[10px]",
            outbound ? "text-emerald-800/60" : "text-slate-400",
          )}
        >
          <span>{chatTime(msg.at)}</span>
          {ticks && (
            <span className={ticks.cls} title={ticks.label} aria-label={ticks.label}>
              {ticks.marks}
            </span>
          )}
        </p>
        {outbound && msg.status === "unknown" && (
          <p className="mt-1 text-[11px] text-amber-700">
            Estado por confirmar. Actualiza el chat antes de volver a enviar.
          </p>
        )}
        {outbound && (msg.status === "failed" || msg.status === "error") && (
          <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-red-700">
            <span className="min-w-0 truncate" title={msg.error ?? undefined}>No se envió</span>
            {msg.retryable && msg.outboxId && (
              <button
                type="button"
                onClick={() => onRetry(msg)}
                disabled={retrying}
                className="shrink-0 rounded-full border border-red-300 bg-white/70 px-2 py-0.5 font-semibold hover:bg-white disabled:opacity-60"
                aria-label="Reintentar mensaje fallido"
              >
                {retrying ? "Reintentando…" : "↻ Reintentar"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** WhatsApp-style composer bar, attached under the conversation: quick replies,
 *  inline attach (📎), Ctrl+V-to-attach, Enter-to-send. Enabled only inside the
 *  24h session window; otherwise shows why the customer must write first. */
function WhatsappComposer({
  leadId,
  lastInboundAt,
  phoneNumberId,
  numberHint,
  onOptimisticSend,
  onSendSettled,
  onSent,
}: {
  leadId: string;
  lastInboundAt?: string | null;
  phoneNumberId?: string | null;
  numberHint?: string | null;
  onOptimisticSend: (body: string) => string;
  onSendSettled: (localId: string, sent: LeadConversationMessage | null) => void;
  onSent: (leadPatch?: LeadActionState["leadPatch"]) => void;
}) {
  const [win, setWin] = useState<{ loading: boolean; open: boolean; reason?: string }>({
    loading: true,
    open: false,
  });
  const [text, setText] = useState("");
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the input as the advisor types (capped), like a real chat box.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  useEffect(() => {
    let alive = true;
    setText("");
    setAttachFile(null);
    setMsg(null);
    // The transcript/lead already carries the authoritative last inbound time.
    // Calculate the rolling window locally; Meta still enforces it on send, so a
    // boundary race is surfaced normally without blocking the composer on Kapso.
    const last = lastInboundAt ? new Date(lastInboundAt).getTime() : 0;
    if (!last || Date.now() - last > 24 * 60 * 60 * 1000) {
      setWin({ loading: false, open: false, reason: "El cliente debe escribirte primero." });
      return;
    }
    if (alive) setWin({ loading: false, open: true });
    return () => {
      alive = false;
    };
  }, [leadId, lastInboundAt]);

  function send() {
    const body = text.trim();
    if (!body) return;
    setMsg(null);
    setText("");
    const localId = onOptimisticSend(body);
    const clientToken = crypto.randomUUID();
    startUiMeasure("kapso:whatsapp-send");
    startTransition(async () => {
      const res = await sendLeadMessage(leadId, body, phoneNumberId ?? undefined, clientToken);
      finishUiMeasure("kapso:whatsapp-send");
      if (res.error) {
        onSendSettled(localId, res.sentMessage ?? null);
        // Once an attempt is persisted it stays in the transcript and owns its
        // retry action. Restore the draft only when no attempt was recorded.
        if (!res.sentMessage) setText(body);
        // Window closed mid-send → flip to the closed state with a clear reason
        // (retry is futile). Other errors keep the text so "Reintentar" can resend.
        if (res.windowClosed) {
          setWin({ loading: false, open: false, reason: "Se cerró la ventana de 24h." });
          setMsg(res.error);
          return;
        }
        setMsg(res.sentMessage ? null : res.error);
        return;
      }
      onSendSettled(localId, res.sentMessage ?? null);
      setMsg(null);
      onSent(res.leadPatch);
    });
  }

  if (win.loading) {
    return (
      <div className="border-t border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-400">
        Verificando ventana de 24h…
      </div>
    );
  }
  if (!win.open) {
    return (
      <div className="border-t border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-500">
        ⏳ {win.reason ?? "El cliente debe escribirte primero."} Solo puedes escribir dentro de las 24h
        desde su último mensaje.
      </div>
    );
  }

  return (
    <div className="border-t border-slate-200 bg-white">
      <div className="px-2 pt-2">
        <QuickReplyBar leadId={leadId} onInsert={(b) => setText(b)} />
      </div>
      {numberHint && (
        <p className="px-3 pt-1 text-[11px] text-slate-500">
          Respondes desde <span className="font-medium text-slate-700">{numberHint}</span>
        </p>
      )}
      {attachFile && (
        <div className="px-2 pt-2">
          <MediaAttach
            leadId={leadId}
            file={attachFile}
            setFile={setAttachFile}
            disabled={pending}
            phoneNumberId={phoneNumberId}
            onSent={onSent}
            onWindowClosed={() => setWin({ loading: false, open: false, reason: "Se cerró la ventana de 24h." })}
          />
        </div>
      )}
      <div className="flex items-end gap-1.5 px-2 py-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf,video/mp4,video/3gpp"
          className="hidden"
          onChange={(e) => {
            setAttachFile(e.currentTarget.files?.[0] ?? null);
            setMsg(null);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={pending}
          title="Adjuntar imagen, PDF o video"
          aria-label="Adjuntar"
          className="shrink-0 rounded-full p-2 text-lg leading-none text-slate-500 hover:bg-slate-100 disabled:opacity-60"
        >
          📎
        </button>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            // Ctrl+V de una imagen → la adjunta (reusa MediaAttach).
            const img = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
            if (img) {
              e.preventDefault();
              setAttachFile(img);
            }
          }}
          rows={1}
          placeholder="Escribe un mensaje…"
          disabled={pending}
          className="grow resize-none overflow-y-auto rounded-2xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
        />
        <button
          type="button"
          onClick={send}
          disabled={pending || !text.trim()}
          title="Enviar"
          aria-label="Enviar"
          className="shrink-0 rounded-full bg-emerald-600 p-2.5 text-sm leading-none text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {pending ? "…" : "➤"}
        </button>
      </div>
      {msg && (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs">
          <span className="text-red-600">{msg}</span>
          <button
            type="button"
            onClick={send}
            disabled={pending}
            className="shrink-0 font-medium text-emerald-700 hover:underline disabled:opacity-60"
          >
            ↻ Reintentar
          </button>
        </div>
      )}
    </div>
  );
}

/** Downscale + re-encode an image so WhatsApp sends stay fast and under the
 *  server-action body limit. Falls back to the original file on any failure. */
async function resizeImageToBlob(file: File, maxDim = 1600, quality = 0.8): Promise<Blob> {
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error("read"));
      r.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("decode"));
      i.src = dataUrl;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext("2d");
    if (!cx) return file;
    cx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob ?? file;
  } catch {
    return file;
  }
}

/** Per-store canned messages: chips that fill the composer + an inline manager. */
function QuickReplyBar({ leadId, onInsert }: { leadId: string; onInsert: (body: string) => void }) {
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [manage, setManage] = useState(false);
  const [label, setLabel] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    listQuickReplies(leadId).then((r) => {
      if (alive) setReplies(r);
    });
    return () => {
      alive = false;
    };
  }, [leadId]);

  function add() {
    if (!label.trim() || !body.trim()) return;
    startTransition(async () => {
      const res = await createQuickReply(leadId, label, body);
      if ("error" in res) {
        setMsg(res.error);
        return;
      }
      setReplies(res.replies);
      setLabel("");
      setBody("");
      setMsg(null);
    });
  }
  function remove(id: string) {
    startTransition(async () => {
      const res = await deleteQuickReply(leadId, id);
      if (!("error" in res)) setReplies(res.replies);
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {replies.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onInsert(r.body)}
            title={r.body}
            className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-0.5 text-xs text-brand-700 hover:bg-brand-100"
          >
            {r.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setManage((m) => !m)}
          className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
        >
          {manage ? "✕ cerrar" : "✎ respuestas"}
        </button>
      </div>
      {manage && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
          {replies.length === 0 && <p className="text-xs text-slate-400">Aún no hay respuestas rápidas.</p>}
          {replies.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-[90px] font-medium text-slate-700">{r.label}</span>
              <span className="flex-1 truncate text-slate-500">{r.body}</span>
              <button
                type="button"
                onClick={() => remove(r.id)}
                disabled={pending}
                className="text-slate-400 hover:text-red-600"
                aria-label="Eliminar"
              >
                ✕
              </button>
            </div>
          ))}
          <div className="grid gap-1.5 border-t border-slate-200 pt-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              placeholder="Título (ej. Datos de pago)"
              className="rounded border border-slate-200 px-2 py-1 text-xs"
              disabled={pending}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              rows={2}
              placeholder="Mensaje…"
              className="rounded border border-slate-200 px-2 py-1 text-xs"
              disabled={pending}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={add}
                disabled={pending || !label.trim() || !body.trim()}
                className="rounded border border-brand-300 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-60"
              >
                + Agregar
              </button>
              {msg && <span className="text-xs text-red-600">{msg}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Staged-attachment preview + send (image, PDF/boleta or video). The file is
 *  chosen/pasted by the composer; here we preview it, take an optional caption,
 *  upload it DIRECTLY to Storage via a signed URL (bypassing the Server-Action
 *  body limit) and send it to Meta by public link. Images are downscaled first. */
function MediaAttach({
  leadId,
  file,
  setFile,
  disabled,
  phoneNumberId,
  onSent,
  onWindowClosed,
}: {
  leadId: string;
  file: File | null;
  setFile: (f: File | null) => void;
  disabled: boolean;
  phoneNumberId?: string | null;
  onSent: () => void;
  onWindowClosed?: () => void;
}) {
  const [caption, setCaption] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Object-URL preview for image/video (revoked on change/unmount).
  useEffect(() => {
    if (file && (file.type.startsWith("image/") || file.type.startsWith("video/"))) {
      const url = URL.createObjectURL(file);
      setPreview(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreview(null);
  }, [file]);

  function clear() {
    setFile(null);
    setCaption("");
    setMsg(null);
  }

  function send() {
    if (!file) return;
    setMsg(null);
    startTransition(async () => {
      try {
        const isImage = file.type.startsWith("image/");
        const blob: Blob = isImage ? await resizeImageToBlob(file) : file;
        const contentType = isImage ? "image/jpeg" : file.type;
        const filename = file.name || (isImage ? "imagen.jpg" : "archivo");
        const prep = await createWaMediaUpload(leadId, contentType, filename);
        if ("error" in prep) {
          setMsg(prep.error);
          return;
        }
        const sb = createBrowserSupabase();
        const up = await sb.storage
          .from("whatsapp-media")
          .uploadToSignedUrl(prep.path, prep.token, blob, { contentType });
        if (up.error) {
          setMsg(`No se pudo subir: ${up.error.message}`);
          return;
        }
        const res = await sendLeadMedia(
          leadId,
          { path: prep.path, kind: prep.kind, filename, caption: caption.trim() },
          phoneNumberId ?? undefined,
        );
        if (res.error) {
          if (res.windowClosed) {
            clear();
            onWindowClosed?.(); // flip the composer to the closed state with a clear reason
            return;
          }
          setMsg(res.error);
          return;
        }
        clear();
        onSent(); // refresh the thread so the sent media appears
      } catch (e) {
        setMsg(`Error: ${(e as Error)?.message ?? "no se pudo enviar"}`);
      }
    });
  }

  if (!file) return null;
  const kindLabel = file.type.startsWith("image/")
    ? "imagen"
    : file.type.startsWith("video/")
      ? "video"
      : "documento";

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
      {file.type.startsWith("image/") ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview ?? ""} alt="Vista previa" className="max-h-40 rounded" />
      ) : file.type.startsWith("video/") ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={preview ?? ""} controls className="max-h-40 rounded" />
      ) : (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          📄 <span className="truncate">{file.name || "Documento"}</span>
        </div>
      )}
      <input
        value={caption}
        onChange={(e) => setCaption(e.currentTarget.value)}
        placeholder="Texto (opcional)"
        disabled={pending}
        className="w-full rounded border border-slate-200 px-2 py-1 text-sm"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={disabled || pending}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {pending ? "Enviando…" : `Enviar ${kindLabel}`}
        </button>
        <button type="button" onClick={clear} disabled={pending} className="text-xs text-slate-500 hover:underline">
          Quitar
        </button>
        {msg && <span className="text-xs text-red-600">{msg}</span>}
      </div>
    </div>
  );
}

/** Close a sale by phone (contraentrega / COD). Records a lightweight manual
 *  order, marks the lead Ganado and credits the advisor. Collapsed by default to
 *  keep the drawer tidy; expands into the amount / products / district form. */
// ---------------------------------------------------------------------------
// Unified order form (supersedes Cerrar venta + Generar pedido). Pre-fills from
// the cart's draft (or blank for a new sale), products from the real catalog
// (or a custom item), required address, then generates a REAL Shopify order.
// ---------------------------------------------------------------------------

type OrderItem = {
  key: string;
  variantId: string | null;
  title: string;
  quantity: number;
  unitPrice: number | null;
};
type ProductResult = Awaited<ReturnType<typeof searchStoreProducts>>[number]; // producto + variantes
// A single variant flattened for the line-item add (what ProductPicker returns).
type PickedVariant = { variantId: string; title: string; price: number | null; inventory: number | null };

const rid = () => Math.random().toString(36).slice(2);

const PERU_REGIONS = [
  "Amazonas", "Áncash", "Apurímac", "Arequipa", "Ayacucho", "Cajamarca", "Callao", "Cusco",
  "Huancavelica", "Huánuco", "Ica", "Junín", "La Libertad", "Lambayeque", "Lima", "Loreto",
  "Madre de Dios", "Moquegua", "Pasco", "Piura", "Puno", "San Martín", "Tacna", "Tumbes", "Ucayali",
];
/** Map a free-text province (e.g. "Lima (provincia)") to a canonical Peru region. */
function matchPeruRegion(v: string | null | undefined): string {
  if (!v) return "";
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const nv = norm(v);
  return PERU_REGIONS.find((r) => nv.includes(norm(r))) ?? v;
}

function OrderFormPanel({
  leadId,
  currency,
  hasCart,
  allowExisting,
  onRegistered,
  onClose,
}: {
  leadId: string;
  currency: string;
  hasCart: boolean;
  allowExisting?: boolean; // permitir generar OTRO pedido aunque el lead ya tenga uno
  onRegistered: () => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address1, setAddress1] = useState("");
  const [district, setDistrict] = useState("");
  const [province, setProvince] = useState("");
  const [referencia, setReferencia] = useState("");
  const [orderNote, setOrderNote] = useState(""); // → Notas del pedido en Shopify
  const [windowOpen, setWindowOpen] = useState(false);
  const [sendConfirm, setSendConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [discountKind, setDiscountKind] = useState<"none" | "fixed" | "percent">("none");
  const [discountValue, setDiscountValue] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadOrderDraft(leadId).then((res) => {
      if (!alive) return;
      if ("error" in res) {
        setMsg(res.error);
      } else {
        setItems(res.lineItems.map((li) => ({ ...li, key: rid() })));
        setName(res.customerName ?? "");
        setPhone(res.phone ?? "");
        setAddress1(res.address1 ?? "");
        setDistrict(res.district ?? "");
        setProvince(matchPeruRegion(res.province));
        setReferencia(res.referencia ?? "");
        setWindowOpen(res.windowOpen);
        setSendConfirm(res.windowOpen);
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [leadId]);

  const subtotal = items.reduce((s, it) => s + (it.unitPrice ?? 0) * (Number(it.quantity) || 0), 0);
  const discountAmount =
    discountKind !== "none" && discountValue != null && discountValue > 0
      ? discountKind === "percent"
        ? (subtotal * Math.min(100, discountValue)) / 100
        : Math.min(subtotal, discountValue)
      : 0;
  const total = Math.max(0, subtotal - discountAmount);
  const valid = items.length > 0 && address1.trim().length > 0 && district.trim().length > 0 && subtotal > 0;

  function patchItem(key: string, patch: Partial<OrderItem>) {
    setItems((x) => x.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }
  function removeItem(key: string) {
    setItems((x) => x.filter((it) => it.key !== key));
  }

  function submit() {
    if (!valid) {
      setMsg("Completa productos, dirección y distrito antes de generar.");
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await generateOrder(leadId, {
        lineItems: items.map((it) => ({
          variantId: it.variantId,
          title: it.title,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
        })),
        customerName: name.trim(),
        phone: phone.trim(),
        address1: address1.trim(),
        district: district.trim(),
        province: province.trim(),
        referencia: referencia.trim(),
        note: orderNote.trim() || undefined,
        sendConfirmation: sendConfirm,
        confirmationText: confirmText.trim() || undefined,
        discount:
          discountKind === "none" || discountValue == null || discountValue <= 0
            ? null
            : { kind: discountKind, value: discountValue },
        allowExisting,
      });
      if (res.error) {
        setMsg(res.error);
        return;
      }
      setMsg(res.notice ?? "Pedido generado.");
      onRegistered();
    });
  }

  return (
    <section className="space-y-3 rounded-xl border border-emerald-300 bg-emerald-50/50 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-wide text-emerald-800 uppercase">
          {hasCart ? "Generar pedido · contraentrega" : "Registrar pedido · contraentrega"}
        </h3>
        <button type="button" onClick={onClose} disabled={pending} className="text-xs text-slate-500 hover:underline">
          Cerrar
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">Cargando datos del pedido…</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <p className={labelCls}>Productos</p>
            {items.length === 0 && (
              <p className="text-xs text-slate-400">Sin productos. Agrega del catálogo o un ítem manual.</p>
            )}
            {items.map((it) => (
              <div key={it.key} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                <div className="flex items-start gap-2">
                  {it.variantId ? (
                    <span className="flex-1 text-sm text-slate-800">{it.title}</span>
                  ) : (
                    <input
                      value={it.title}
                      onChange={(e) => patchItem(it.key, { title: e.currentTarget.value })}
                      placeholder="Producto (ítem manual)"
                      className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm"
                      disabled={pending}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeItem(it.key)}
                    disabled={pending}
                    className="text-slate-400 hover:text-red-600"
                    aria-label="Quitar"
                  >
                    ✕
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                  <label className="flex items-center gap-1">
                    Cant.
                    <input
                      type="number"
                      min={1}
                      value={it.quantity}
                      onChange={(e) => patchItem(it.key, { quantity: Math.max(1, Number(e.currentTarget.value) || 1) })}
                      className="w-14 rounded border border-slate-200 px-1.5 py-0.5 text-sm"
                      disabled={pending}
                    />
                  </label>
                  {it.variantId ? (
                    // Catalog product: unit price is fixed to the catalog (read-only).
                    // Any reduction is handled via the order-level "Descuento" field.
                    <span className="flex items-center gap-1 text-slate-500">
                      {currency} {(it.unitPrice ?? 0).toFixed(2)}
                      <span className="text-[10px] text-slate-400">c/u</span>
                    </span>
                  ) : (
                    // Manual item: no catalog price to pull from, so it stays editable.
                    <label className="flex items-center gap-1">
                      {currency}
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={it.unitPrice ?? ""}
                        onChange={(e) =>
                          patchItem(it.key, {
                            unitPrice: e.currentTarget.value === "" ? null : Number(e.currentTarget.value),
                          })
                        }
                        className="w-20 rounded border border-slate-200 px-1.5 py-0.5 text-sm"
                        disabled={pending}
                      />
                    </label>
                  )}
                  <span className="ml-auto font-medium text-slate-700">
                    {currency} {((it.unitPrice ?? 0) * (Number(it.quantity) || 0)).toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                disabled={pending}
                className="rounded-lg border border-emerald-300 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
              >
                + Producto del catálogo
              </button>
              <button
                type="button"
                onClick={() => setItems((x) => [...x, { key: rid(), variantId: null, title: "", quantity: 1, unitPrice: null }])}
                disabled={pending}
                className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                + Ítem manual
              </button>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-2 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-600">Descuento</span>
                <select
                  value={discountKind}
                  onChange={(e) => {
                    const k = e.currentTarget.value as "none" | "fixed" | "percent";
                    setDiscountKind(k);
                    if (k === "none") setDiscountValue(null);
                  }}
                  disabled={pending}
                  className="rounded border border-slate-200 px-1.5 py-0.5 text-xs"
                >
                  <option value="none">Sin descuento</option>
                  <option value="fixed">Monto ({currency})</option>
                  <option value="percent">Porcentaje (%)</option>
                </select>
                {discountKind !== "none" && (
                  <input
                    type="number"
                    min={0}
                    step={discountKind === "percent" ? "1" : "0.01"}
                    max={discountKind === "percent" ? 100 : undefined}
                    value={discountValue ?? ""}
                    onChange={(e) =>
                      setDiscountValue(e.currentTarget.value === "" ? null : Math.max(0, Number(e.currentTarget.value)))
                    }
                    placeholder={discountKind === "percent" ? "%" : currency}
                    disabled={pending}
                    className="w-24 rounded border border-slate-200 px-1.5 py-0.5 text-sm"
                  />
                )}
              </div>
              {discountAmount > 0 && (
                <div className="mt-2 space-y-0.5">
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>Subtotal</span>
                    <span>
                      {currency} {subtotal.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-rose-600">
                    <span>
                      Descuento
                      {discountKind === "percent" && discountValue ? ` (${Math.min(100, discountValue)}%)` : ""}
                    </span>
                    <span>
                      −{currency} {discountAmount.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
              <div className="mt-1 flex justify-between text-sm font-semibold text-emerald-800">
                <span>Total</span>
                <span>
                  {currency} {total.toFixed(2)}
                </span>
              </div>
            </div>
            {showPicker && (
              <ProductPicker
                leadId={leadId}
                currency={currency}
                onPick={(p) => {
                  setItems((x) => [
                    ...x,
                    { key: rid(), variantId: p.variantId, title: p.title, quantity: 1, unitPrice: p.price },
                  ]);
                  setShowPicker(false);
                }}
                onClose={() => setShowPicker(false)}
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Cliente" value={name} onChange={setName} disabled={pending} placeholder="Nombre" />
            <Field label="Teléfono" value={phone} onChange={setPhone} disabled={pending} placeholder="519…" />
          </div>
          <Field label="Dirección *" value={address1} onChange={setAddress1} disabled={pending} placeholder="Av. / Calle y número" />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Distrito *" value={district} onChange={setDistrict} disabled={pending} placeholder="Distrito de entrega" />
            <div>
              <label className={labelCls}>Provincia / Región</label>
              <select
                value={province}
                onChange={(e) => setProvince(e.currentTarget.value)}
                className={inputCls}
                disabled={pending}
              >
                <option value="">—</option>
                {province && !PERU_REGIONS.includes(province) && <option value={province}>{province}</option>}
                {PERU_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Field label="Referencia" value={referencia} onChange={setReferencia} disabled={pending} placeholder="Frente a…, color de puerta…" />

          <div>
            <label className={labelCls}>Notas del pedido</label>
            <textarea
              value={orderNote}
              onChange={(e) => setOrderNote(e.currentTarget.value)}
              rows={2}
              placeholder="Ej: enviar con Alexis (opcional)"
              className={inputCls}
              disabled={pending}
            />
            <p className="mt-1 text-xs text-slate-400">
              Se guarda en las Notas del pedido en Shopify (no se envía al cliente).
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={sendConfirm}
                onChange={(e) => setSendConfirm(e.currentTarget.checked)}
                disabled={pending || !windowOpen}
              />
              Enviar confirmación por WhatsApp al cliente
            </label>
            {windowOpen ? (
              sendConfirm && (
                <textarea
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.currentTarget.value)}
                  rows={3}
                  placeholder="(Se usa un mensaje de confirmación por defecto si lo dejas vacío)"
                  className="mt-1.5 w-full rounded border border-slate-200 px-2 py-1 text-sm"
                  disabled={pending}
                />
              )
            ) : (
              <p className="mt-1 text-xs text-slate-400">
                Ventana de 24h cerrada — no se puede enviar texto libre (se necesitaría una plantilla).
              </p>
            )}
          </div>

          <p className="text-xs text-emerald-700/80">
            Pago contraentrega → queda como <span className="font-medium">pago pendiente</span> y sube como pedido
            real a Shopify. Marca el lead <span className="font-medium">Ganado</span> y suma a tu productividad.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={pending || !valid}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {pending ? "Generando…" : "Generar pedido"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="text-sm text-slate-500 hover:underline disabled:opacity-60"
            >
              Cancelar
            </button>
            {msg && <span className="text-xs text-slate-600">{msg}</span>}
          </div>
        </>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className={inputCls}
        disabled={disabled}
      />
    </div>
  );
}

function ProductPicker({
  leadId,
  currency,
  onPick,
  onClose,
}: {
  leadId: string;
  currency: string;
  onPick: (v: PickedVariant) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ProductResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [openProd, setOpenProd] = useState<string | null>(null); // productId cuyas variantes están expandidas

  // Flatten a chosen (product, variant) into the line-item shape, keeping the
  // "Producto · Variante" title the rest of the form + Shopify draft expect.
  const pick = (p: ProductResult, v: ProductResult["variants"][number]) =>
    onPick({
      variantId: v.variantId,
      title: v.variantTitle ? `${p.title} · ${v.variantTitle}` : p.title,
      price: v.price,
      inventory: v.inventory,
    });
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchStoreProducts(leadId, term);
      if (alive) {
        setResults(r);
        setOpenProd(null); // nueva búsqueda → colapsa cualquier producto expandido
        setSearching(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, leadId]);
  return (
    <div className="rounded-lg border border-emerald-200 bg-white p-2">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder="Buscar producto…"
          className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm"
        />
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:underline">
          Cerrar
        </button>
      </div>
      {searching && <p className="mt-1 text-xs text-slate-400">Buscando…</p>}
      {results && results.length === 0 && !searching && (
        <p className="mt-1 text-xs text-slate-400">Sin resultados (o falta el permiso read_products).</p>
      )}
      {results && results.length > 0 && (
        <ul className="mt-1 max-h-56 overflow-y-auto">
          {results.map((p) => {
            const single = p.variants.length === 1; // sin variantes reales → se agrega directo
            const expanded = openProd === p.productId;
            const totalStock = p.variants.reduce((s, v) => s + (v.inventory ?? 0), 0);
            return (
              <li key={p.productId}>
                <button
                  type="button"
                  onClick={() => (single ? pick(p, p.variants[0]!) : setOpenProd(expanded ? null : p.productId))}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-emerald-50"
                >
                  {!single && <span className="text-slate-300">{expanded ? "▾" : "▸"}</span>}
                  <span className="flex-1 text-sm text-slate-800">{p.title}</span>
                  {single ? (
                    <>
                      <span className={cn("text-xs", (p.variants[0]!.inventory ?? 0) > 0 ? "text-slate-500" : "text-amber-600")}>
                        {p.variants[0]!.inventory != null ? `stock ${p.variants[0]!.inventory}` : ""}
                      </span>
                      <span className="text-sm font-medium text-slate-700">
                        {currency} {(p.variants[0]!.price ?? 0).toFixed(2)}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-slate-400">
                      {p.variants.length} variantes{totalStock > 0 ? ` · stock ${totalStock}` : ""}
                    </span>
                  )}
                </button>
                {expanded && !single && (
                  <ul className="mb-1 ml-4 border-l border-slate-200 pl-2">
                    {p.variants.map((v) => (
                      <li key={v.variantId}>
                        <button
                          type="button"
                          onClick={() => pick(p, v)}
                          className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-emerald-50"
                        >
                          <span className="flex-1 text-sm text-slate-700">{v.variantTitle || "Estándar"}</span>
                          <span className={cn("text-xs", (v.inventory ?? 0) > 0 ? "text-slate-500" : "text-amber-600")}>
                            {v.inventory != null ? `stock ${v.inventory}` : ""}
                          </span>
                          <span className="text-sm font-medium text-slate-700">
                            {currency} {(v.price ?? 0).toFixed(2)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CallForm({
  leadId,
  onRegistered,
}: {
  leadId: string;
  onRegistered: (update?: LeadDrawerUpdate) => void;
}) {
  const [state, action, pending] = useActionState<LeadActionState, FormData>(registerCall, {});
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (state.notice || state.error) finishUiMeasure("kapso:call-save");
    if (state.notice) {
      onRegistered({ savedCall: state.savedCall, leadPatch: state.leadPatch, refreshList: true });
      setStatus("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.notice]);
  // Disposiciones más usadas como chips; el resto en el <select> "Otros estados"
  // (registerCall acepta cualquier estado válido, así que no se pierde ninguno).
  const CHIPS: [string, string][] = [
    ["casi_cierra", "🔥 Casi cierra"],
    ["no_responde", "🚫 No contestó"],
    ["volver_a_llamar", "📞 Volver a llamar"],
    ["contactado_dejo_wsp", "💬 Contactado"],
    ["buzon", "📭 Buzón"],
    ["sin_stock", "📦 Sin stock"],
  ];
  const chipKeys = new Set(CHIPS.map(([k]) => k));
  // El desplegable lista TODOS los estados (los de los chips primero, con su
  // etiqueta canónica) y muestra siempre el seleccionado, así chips y desplegable
  // quedan sincronizados en ambos sentidos.
  const STATUS_OPTIONS = [
    ...CHIPS.map(([code]) => ({ code, label: labelOf(code) })),
    ...MANUAL_STATUSES.filter((s) => !chipKeys.has(s.code)).map((s) => ({ code: s.code, label: s.label })),
  ];
  return (
    <section>
      <p className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Resultado de la llamada</p>
      <form action={action} onSubmit={() => startUiMeasure("kapso:call-save")} className="space-y-2.5">
        <input type="hidden" name="lead_id" value={leadId} />
        <input type="hidden" name="status" value={status} />
        <div className="flex flex-wrap gap-1.5">
          {CHIPS.map(([k, label]) => {
            const on = status === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setStatus(on ? "" : k)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                  on
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.currentTarget.value)}
          className={inputCls}
          aria-label="Estado de la llamada"
        >
          <option value="">(mantener estado)</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </select>
        <textarea name="note" rows={2} placeholder="Nota rápida…" className={inputCls} />
        {(status === "casi_cierra" || status === "volver_a_llamar") && (
          <p className="text-[11px] leading-snug text-slate-400">
            Sin fecha se agenda solo: <span className="font-medium text-slate-500">hoy 18:00</span> (si aún no son las
            16h) o <span className="font-medium text-slate-500">mañana 10:00</span> — lo verás en la vista
            Seguimientos a esa hora.
          </p>
        )}
        <div className="flex gap-2">
          <input
            name="next_followup_at"
            type="datetime-local"
            aria-label="Reprogramar seguimiento"
            className={cn(inputCls, "flex-1")}
          />
          <button
            type="submit"
            disabled={pending}
            className="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {pending ? "Guardando…" : "Guardar"}
          </button>
        </div>
        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
        {state.notice && <p className="text-sm text-emerald-600">{state.notice}</p>}
      </form>
    </section>
  );
}
