"use client";

// La ficha del lead (14-10-2026, mundo de operación): un `SidePanel` de
// 1.040 px con la conversación de WhatsApp fija a la izquierda —estilo Kapta:
// hilo sobre `wash`, burbujas blancas del cliente y en `line` las nuestras— y
// el trabajo a la derecha en tarjetas: lo que pidió, el resumen del bot, el
// resultado de la llamada, el historial y el resto, con «Generar pedido»
// pegado al pie de esa columna. Bajo 1.024 px es una sola columna.
//
// `CallForm` y `WhatsappChat` se exportan con `variant="card"` para la tarjeta
// del siguiente lead de la lista: la misma conducta sin el marco de la ficha.

import { mergeConversationMessages } from "@/lib/conversation-merge";
import { canUseActiveChatPoll, chatContextAfterRead } from "@/lib/leads-chat-poll";
import {
  type ComponentType,
  Fragment,
  type ReactNode,
  type SVGProps,
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { CallQr } from "@/components/call-qr";
import { SEGMENT_TONE } from "@/components/lead-segment-tone";
import { CoverageBadge } from "@/components/coverage-badge";
import type { OrderCoverage } from "@/lib/order-coverage";
import { copyLabel, useCopyToClipboard } from "@/components/copy-button";
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
import { AliclikGuidePanel } from "@/components/aliclik-guide-panel";
import {
  LEAD_VOICE_AGENT_HANDOFF,
  LEAD_VOICE_AGENT_KIND,
  LEAD_VOICE_AGENT_NAME,
  LeadVoiceAgentPanel,
  leadVoiceAgentTitle,
} from "@/components/lead-voice-agent-panel";
import {
  Badge,
  Banner,
  CARD_ZONE,
  CHECKBOX,
  ChoiceChip,
  FIELD,
  FIELD_BOX,
  OpsButton,
  SECTION_CARD,
  SectionHead,
  SidePanel,
  Skeleton,
  choiceChipClass,
  opsButtonClass,
  type BadgeTone,
} from "@/components/ops-ui";
import {
  IconAlert,
  IconArrowRight,
  IconArrowUpRight,
  IconCamera,
  IconChat,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconImage,
  IconInfo,
  IconMic,
  IconPlus,
  IconReceipt,
  IconRepeat,
  IconSearch,
  IconX,
} from "@/components/icons";
import { EmojiPicker } from "@/components/emoji-picker";
import { insertAtCursor } from "@/lib/emoji";
import {
  MANUAL_STATUSES,
  categoryOf,
  labelOf,
  leadQueueBucket,
  leadWindowInfo,
  yapeKind,
  type QueueBucket,
  type YapeKind,
  leadHandle,
  leadCanCall,
  leadPhoneLabel,
} from "@/lib/leads";
import {
  confirmLeadWon,
  createQuickReply,
  deleteQuickReply,
  generateOrder,
  registerCall,
  createWaMediaUpload,
  sendLeadMedia,
  sendLeadMessage,
  sendLeadTemplate,
  retryLeadMessage,
  type LeadActionState,
  type LeadConversationMessage,
  type LeadReplyTemplate,
  type LeadThread,
  type QuickReply,
} from "@/app/dashboard/leads/actions";
import {
  listLeadTemplates,
  listQuickReplies,
  loadLeadConversation,
  loadLeadDeliveryCoverage,
  loadOrderDraft,
  pollLeadState,
  searchStoreProducts,
} from "@/lib/leads-read-client";
import { REPLY_TOKEN_LABEL, renderReplyPreview, validateReplyParams } from "@/lib/wa-reply-templates";
import { shopifyDraftOrderAdminUrl } from "@/lib/shopify-urls";
import { isCodCoreFormGid } from "@/lib/cod-core-abandoned";
import { cartCreatedAtLabel } from "@/lib/lead-cart-detail";
import { orderPlatformName } from "@/lib/order-admin-url";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { cn } from "@/components/ui";
import { formatPeruMobile, peruMobileDigits, peruMobileProblem } from "@/lib/phone";
import { YapeAssign } from "@/components/yape-alerts";
import { reportClientPerformanceMetric } from "@/lib/client-performance";
import { cartsTone, cartsVerdict, type CustomerCarts } from "@/lib/customer-carts";

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
  /**
   * «Siguiente lead»: el de debajo en la lista que está mirando (`leadAfter`).
   * Sin `lead`, es el último de la lista y el botón queda apagado. Sin la prop
   * entera (otra pantalla abre la ficha), no hay botón.
   */
  next?: { lead: LeadRow | null; opening: boolean; onOpen: () => void };
};

export type LeadDrawerUpdate = {
  savedCall?: LeadCallRow;
  leadPatch?: LeadActionState["leadPatch"];
  refreshList?: boolean;
};

/** Etiqueta de campo (13 px, tinta media), como en la ficha del pedido. */
const LABEL = "block text-[13px] font-medium leading-5 text-ink-700";

/** La franja del agente de voz: lo mínimo, una línea con «Probar en mi
 *  teléfono» (Frankz, 14-10-2026); crece solo con sus llamadas o al probar. */
const VOICE_STRIP = "rounded-lg bg-white px-4 py-3 shadow-control ring-1 ring-line sm:px-5";

/** Botón de solo icono: 32 px (44 con el dedo), en reposo sin fondo. El color
 *  lo pone quien lo usa: `cn` no resuelve dos `text-*` que choquen. */
const ICON_BTN =
  "grid size-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-wash hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11";

/** Respuesta rápida: píldora de 28 px sobre el pie del chat. */
const QUICK_PILL =
  "inline-flex h-7 max-w-full items-center whitespace-nowrap rounded-full bg-white px-2.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-line-strong transition-shadow hover:ring-ink-300 disabled:opacity-50 pointer-coarse:h-11";

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

/** Cuántos carritos se ven antes de «Ver todos»: los últimos, que son los que cuentan. */
const CARTS_PREVIEW = 4;
/** Tope de la lista abierta; el conteo de arriba es siempre el completo. */
const CARTS_LIST_MAX = 40;

const CARTS_VERDICT_TONE: Record<ReturnType<typeof cartsTone>, string> = {
  warn: "text-warn-fg",
  ok: "text-ok-fg",
  neutral: "text-ink-700",
};

/**
 * Carritos anteriores de la clienta en esta tienda. Arriba, el hecho que cambia
 * cómo se la llama —cuántos terminaron en pedido—; debajo, los últimos con su
 * producto, monto y en qué quedó. Misma anatomía que «Pedidos anteriores».
 */
function CustomerCartsCard({ carts, currency }: { carts: CustomerCarts; currency: string }) {
  const [open, setOpen] = useState(false);
  const { summary } = carts;
  const verdict = cartsVerdict(summary);
  const shown = open ? carts.carts.slice(0, CARTS_LIST_MAX) : carts.carts.slice(0, CARTS_PREVIEW);
  const hidden = carts.carts.length - shown.length;
  return (
    <section aria-label="Carritos anteriores" className={SECTION_CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-ink-900">
          Carritos anteriores <span className="font-normal tabular-nums text-ink-500">· {summary.total}</span>
        </h3>
        {summary.completed > 0 && summary.abandoned > 0 && (
          <span className="text-[13px] tabular-nums text-ink-600">
            {summary.abandoned} {summary.abandoned === 1 ? "abandonado" : "abandonados"}
          </span>
        )}
      </div>
      {verdict && <p className={cn("mt-0.5 text-[13px] font-medium leading-5", CARTS_VERDICT_TONE[cartsTone(summary)])}>{verdict}</p>}
      <ul className="-mx-4 -mb-4 mt-3 divide-y divide-line border-t border-line sm:-mx-5 sm:-mb-5">
        {shown.map((cart) => (
          <li key={cart.key} className="flex items-start justify-between gap-3 px-4 py-2.5 sm:px-5">
            <div className="min-w-0">
              <p className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium text-ink-900">
                  {cart.kind === "carrito" ? "Checkout web" : cart.name ?? "Borrador"}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-ink-500">{orderDateShort(cart.createdAt)}</span>
              </p>
              {cart.products && <p className="mt-0.5 truncate text-[13px] leading-5 text-ink-600">{cart.products}</p>}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {cart.total != null && (
                <span className="text-sm font-semibold tabular-nums text-ink-900">
                  {currency} {cart.total.toFixed(2)}
                </span>
              )}
              {cart.completed ? (
                <Badge tone="ok">{cart.orderName ? `Pedido ${cart.orderName}` : "Terminó en pedido"}</Badge>
              ) : (
                <Badge>Abandonado</Badge>
              )}
            </div>
          </li>
        ))}
      </ul>
      {(hidden > 0 || open) && carts.carts.length > CARTS_PREVIEW && (
        <div className="-mx-4 -mb-4 mt-4 border-t border-line px-4 py-2 sm:-mx-5 sm:-mb-5 sm:px-5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex min-h-8 items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline pointer-coarse:min-h-11"
          >
            {open ? "Ver menos" : `Ver los ${Math.min(carts.carts.length, CARTS_LIST_MAX)}`}
            <IconChevronDown aria-hidden className={cn("size-4 transition-transform", open && "rotate-180")} />
          </button>
          {open && carts.carts.length > CARTS_LIST_MAX && (
            <span className="ml-2 text-[13px] tabular-nums text-ink-500">
              y {carts.carts.length - CARTS_LIST_MAX} más antiguos
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** Monto corto para una chapa: «129» o «129.9», con el formato es-PE. */
function fmtAmount(value: number): string {
  return Number(value).toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

/** Una fila etiqueta / valor de la tarjeta «Origen». */
function MetaField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3">
      <dt className="text-ink-500">{label}</dt>
      <dd className="min-w-0 break-words text-ink-900">{children}</dd>
    </div>
  );
}

/** De dónde llegó el lead: el número de WhatsApp al que escribió y, si vino por
 *  un anuncio Click-to-WhatsApp, el creativo real con su cadena campaña /
 *  conjunto / objetivo / estado. Plegado muestra una línea; si el ad_id todavía
 *  no se resolvió en `meta_ads`, solo se conocen el titular y el id. */
function LeadOrigin({ lead, adMeta, waNumber }: { lead: LeadRow; adMeta: AdMeta | null; waNumber: WaNumber | null }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const isAd = lead.source === "meta_ad";
  const name = adMeta?.adName ? prettyAdName(adMeta.adName) : null;
  const href = adsManagerUrl(adMeta?.accountId ?? null, lead.ad_id ?? "");
  const objective = adObjectiveLabel(adMeta?.objective ?? null);
  const status = adStatusLabel(adMeta?.status ?? null);
  const kind = waKindLabel(waNumber?.kind ?? null);
  return (
    <section aria-label="Origen del lead" className={SECTION_CARD}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink-900">Origen</h3>
        {isAd && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailsId}
            className="inline-flex items-center gap-1 rounded text-[13px] font-medium text-brand-700 hover:underline pointer-coarse:min-h-11"
          >
            {open ? "Ocultar" : "Ver más"}
            <IconChevronDown
              aria-hidden
              className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-180")}
            />
          </button>
        )}
      </div>
      <dl id={detailsId} className="mt-3 space-y-1 text-[13px] leading-5">
        {lead.wa_phone_number_id && (
          <MetaField label="WhatsApp">
            {waNumber?.name ?? waNumber?.displayPhone ?? "número sin nombre"}
            {kind ? <span className="text-ink-500">{` · ${kind}`}</span> : null}
          </MetaField>
        )}
        {isAd && !open && (
          <MetaField label="Anuncio">
            <span className="block truncate">{lead.ad_headline || name || "Llegó por un anuncio de Meta"}</span>
          </MetaField>
        )}
        {isAd && open && (
          <>
            {lead.ad_headline && <MetaField label="Titular">{lead.ad_headline}</MetaField>}
            <MetaField label="Anuncio">
              {name ? (
                href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
                  >
                    {name}
                    <IconArrowUpRight aria-hidden className="size-3.5 shrink-0" />
                  </a>
                ) : (
                  <span className="font-medium">{name}</span>
                )
              ) : (
                "Llegó por un anuncio de Meta (Click-to-WhatsApp)"
              )}
            </MetaField>
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
          </>
        )}
      </dl>
      {isAd && open && lead.ad_id && (
        <p className="mt-2 break-all text-xs text-ink-500">
          id {lead.ad_id}
          {lead.ctwa_clid ? ` · clic ${lead.ctwa_clid}` : ""}
        </p>
      )}
    </section>
  );
}

// Las mismas etiquetas de calificación que la fila de components/leads.tsx,
// sin emoji. La chapa es neutra: la calificación clasifica, no avisa.
const SEG_PILL_LABEL: Record<QueueBucket, string> = {
  carrito: "Con carrito",
  distrito: "Dio distrito",
  producto: "Vio producto",
  converso: "Conversó",
  frio: "Frío",
};

// Terminal outcomes shown in the Calificación column instead of an engagement
// segment — a cancelled lead is "Perdidos", not "Con carrito".
const OUTCOME_SEG_BADGE: Record<"won" | "lost", { label: string; tone: BadgeTone }> = {
  won: { label: "Ganados", tone: "ok" },
  lost: { label: "Perdidos", tone: "neutral" },
};

/** Calificación chip per row. Active leads (open/hot) show their engagement level
 *  (Frío → Conversó → Vio producto → Dio distrito → Con carrito, con el monto del
 *  carrito); leads that are already won or lost show the outcome
 *  (Ganados/Perdidos) — the engagement level is meaningless once the lead is
 *  closed, and "Con carrito" on a cancelled lead is misleading. The specific
 *  reason (e.g. "Cancelado por cliente") stays available on hover. */
function SegmentBadge({ lead, currency }: { lead: LeadRow; currency: string }) {
  const cat = categoryOf(lead.status);
  if (cat === "won" || cat === "lost") {
    const b = OUTCOME_SEG_BADGE[cat];
    return (
      <Badge tone={b.tone} title={labelOf(lead.status)}>
        {b.label}
      </Badge>
    );
  }
  const seg = leadQueueBucket(lead);
  return (
    <Badge tone={SEGMENT_TONE[seg]}>
      {SEG_PILL_LABEL[seg]}
      {seg === "carrito" && lead.cart_value != null && (
        <span className="font-semibold tabular-nums text-orange-950">
          {currency} {fmtAmount(lead.cart_value)}
        </span>
      )}
    </Badge>
  );
}

// La fuente del lead, dicha en palabras en la línea de contexto de la cabecera.
const SOURCE_META: Record<
  "meta_ad" | "fb_web" | "cod_cart" | "abandoned_browse" | "organic",
  { label: string; title: string }
> = {
  meta_ad: { label: "Campaña Meta", title: "Campaña Meta (Click-to-WhatsApp, con anuncio)" },
  fb_web: { label: "Meta/Web", title: "Llegó por un link de Meta (Facebook/Instagram) en la web (sin anuncio confirmado)" },
  cod_cart: { label: "Carrito", title: "Carrito abandonado (formulario COD)" },
  abandoned_browse: { label: "Búsqueda", title: "Búsqueda abandonada" },
  organic: { label: "Directo", title: "Orgánico / directo" },
};

// Chapa para leads Yape/Shalom: distingue si el handoff fue por pago (verificar
// Yape) o por agencia (coordinar el envío por Shalom/Olva). Se deriva del motivo
// del handoff — no parte la pestaña, solo aclara de un vistazo qué media es.
const YAPE_KIND_CHIP: Record<YapeKind, { label: string; tone: BadgeTone; title: string }> = {
  pago: { label: "Pago", tone: "warn", title: "Verificar el pago (Yape / comprobante)" },
  agencia: { label: "Agencia", tone: "info", title: "Coordinar el envío por agencia (Shalom / Olva)" },
};

/** Chapa Pago / Agencia — solo para leads en Yape/Shalom (`yape_por_verificar`). */
function YapeKindChip({ lead }: { lead: LeadRow }) {
  if (lead.status !== "yape_por_verificar") return null;
  const k = YAPE_KIND_CHIP[yapeKind(lead.handoff_reason, lead.handoff_context)];
  return (
    <Badge tone={k.tone} title={k.title}>
      {k.label}
    </Badge>
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
  next,
}: LeadDrawerProps) {
  const [orderOpen, setOrderOpen] = useState(false);
  const { state: copied, copy } = useCopyToClipboard();
  const [confirmingWon, startConfirmWon] = useTransition();
  const readyReportedRef = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const orderRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const orderWasOpenRef = useRef(false);

  useEffect(() => {
    if (readyReportedRef.current) return;
    readyReportedRef.current = true;
    onReady?.();
  }, [onReady]);

  // La cobertura del Master para la dirección del lead (MOM §11): junto al
  // distrito, la misma chapa que lleva el pedido. Se vuelve a preguntar si la
  // dirección cambia; sin respuesta, el distrito se queda solo.
  const [deliveryCoverage, setDeliveryCoverage] = useState<{ key: string; coverage: OrderCoverage | null } | null>(null);
  const deliveryKey = [lead.id, lead.district, lead.province, lead.region].join("|");
  useEffect(() => {
    if (!lead.district) return;
    let alive = true;
    loadLeadDeliveryCoverage(lead.id).then(
      (r) => {
        if (alive) setDeliveryCoverage({ key: deliveryKey, coverage: "error" in r ? null : r.coverage });
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [deliveryKey, lead.id, lead.district]);
  const masterCoverage = deliveryCoverage?.key === deliveryKey ? deliveryCoverage.coverage : null;

  // La conversación queda fija bajo la cabecera del panel mientras se baja por
  // la columna de trabajo. La cabecera crece si las chapas o el contexto parten
  // en dos líneas, así que se mide en vez de suponerla: el alto va en
  // `--lead-head` y de él salen el `top` y el alto del chat y el margen al que
  // salta el formulario de pedido.
  useEffect(() => {
    const grid = gridRef.current;
    const head = grid?.closest('[role="dialog"]')?.querySelector<HTMLElement>(":scope > header");
    if (!grid || !head) return;
    const sync = () => grid.style.setProperty("--lead-head", `${Math.round(head.getBoundingClientRect().height)}px`);
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(head);
    return () => observer.disconnect();
  }, []);

  // El formulario de pedido ocupa la columna de trabajo: al abrirlo se lleva a
  // la vista y recibe el foco (el botón que lo abrió desaparece); al cerrarlo,
  // el foco vuelve al botón del pie.
  useEffect(() => {
    if (orderOpen) {
      orderRef.current?.scrollIntoView({ block: "start" });
      orderRef.current?.focus({ preventScroll: true });
    } else if (orderWasOpenRef.current) {
      ctaRef.current?.focus();
    }
    orderWasOpenRef.current = orderOpen;
  }, [orderOpen]);

  // Live sync while a lead WITHOUT an order is open: a Yape/bot purchase links the
  // order a few seconds later (webhook → lead becomes won). Poll the lead's
  // order/status signal every 12s and, the moment it flips, refresh the drawer —
  // so the asesora sees "Pedido generado" instead of a stale "pendiente" (which
  // is what led to mistakenly marking a real sale as "ya compró en otro lado").
  // Stops once the lead has an order (deps change) or the drawer closes (unmount).
  const onRegisteredRef = useRef(onRegistered);
  onRegisteredRef.current = onRegistered;
  useEffect(() => {
    if (lead.has_order) return; // already won → nothing to watch
    let inFlight = false;
    let alive = true;
    const id = setInterval(() => {
      if (inFlight || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      inFlight = true;
      void pollLeadState(lead.id)
        .then((r) => {
          if (!alive || "error" in r) return;
          if (r.hasOrder !== lead.has_order || r.status !== lead.status || r.category !== lead.category) {
            onRegisteredRef.current(); // real change → full refresh (lead + historial + lista)
          }
        })
        .catch(() => { /* retry on the next tick */ })
        .finally(() => {
          inFlight = false;
        });
    }, 12_000);
    return () => { alive = false; clearInterval(id); };
  }, [lead.id, lead.has_order, lead.status, lead.category]);

  // cod_cart sin conversación → empty-state; el resto muestra el chat (que se
  // resuelve por teléfono si no hay conversation_id guardado).
  const hasWa = lead.source !== "cod_cart" || !!lead.kapso_conversation_id;
  const hasCart = !!lead.draft_order_gid && lead.draft_order_status !== "completed";
  // "Ver borrador" abre el draft en el ADMIN de Shopify, no el checkout del
  // cliente (invoiceUrl); ese queda solo como fallback si falta gid/dominio.
  // COD Core conserva su enlace en los datos, pero no se ofrece a las asesoras.
  const codCoreForm = isCodCoreFormGid(lead.draft_order_gid);
  const draftOrderHref = codCoreForm
    ? null
    : (shopifyDraftOrderAdminUrl(shopifyDomain, lead.draft_order_gid) ?? lead.draft_order_url ?? null);
  const cartCreatedIso = lead.cart_detail?.createdAt;
  const cartCreatedAt = cartCreatedAtLabel(cartCreatedIso);
  const cartLines = lead.cart_detail?.lines ?? [];
  // Recurrent if there are prior purchases — either the local last-order signal or
  // the (authoritative) Shopify "Pedidos anteriores" list, which catches customers
  // whose past orders were placed outside the bot (not in the kapso-only table).
  const isRecurrent = !!history?.lastOrderAt || (history?.recentOrders?.length ?? 0) > 0;
  const priorOrders = history?.orderCount ?? 0;
  const priorText = !isRecurrent
    ? null
    : priorOrders > 0
      ? `${priorOrders.toLocaleString("es-PE")} ${priorOrders === 1 ? "pedido" : "pedidos"} antes`
      : "Recurrente";
  const { state: winState, msLeft } = leadWindowInfo(lead.last_inbound_at ?? lead.last_interaction_at, Date.now());
  const hoursLeft = Math.max(1, Math.ceil((msLeft ?? 0) / 3_600_000));
  const winLabel =
    winState === null
      ? "Sin ventana"
      : winState === "cerrada"
        ? "Ventana vencida"
        : `Ventana: ${hoursLeft}\u00a0h`;
  const winTitle =
    winState === null
      ? "El cliente todavía no ha escrito por WhatsApp"
      : winState === "cerrada"
        ? "Pasaron más de 24 h desde su último mensaje: solo se puede enviar una plantilla aprobada"
        : `Quedan ${hoursLeft} h de la ventana de 24 h para escribirle por WhatsApp`;
  const winTone: BadgeTone =
    winState === null ? "neutral" : winState === "cerrada" ? "crit" : winState === "fresca" ? "ok" : "warn";
  const sourceKey = leadSourceKey(lead.source);
  const src = SOURCE_META[sourceKey];
  const campaignLabel =
    sourceKey === "meta_ad"
      ? (adMeta?.campaignName ?? (adMeta?.adName ? prettyAdName(adMeta.adName) : null) ?? lead.ad_headline ?? null)
      : null;
  const sourceText = campaignLabel ? `Campaña «${campaignLabel}»` : src.label;
  // Un lead sin teléfono (0105) se nombra por @username o BSUID. `leadHandle`
  // es la única fuente de esa decisión, para que la lista y el drawer no puedan
  // discrepar sobre cómo se llama la misma persona.
  const handle = leadHandle(lead);
  const canCall = leadCanCall(lead);
  const title = lead.name || handle;

  // «Lo que pidió»: el carrito o el producto visto, la entrega y las palabras
  // con las que abrió. Las palabras se muestran siempre que existan (incluso un
  // "hola" pelado), que ya le dice a la asesora que no hay más contexto que
  // trabajar; en la lista se filtran los saludos vacíos para no llenarla.
  const firstText = (lead.first_inbound_text ?? "").trim();
  const showContext = !!(lead.cart_item_count || lead.district || lead.draft_order_gid || lead.cart_summary);
  const askLine: ReactNode[] = [];
  if (showContext && lead.draft_order_gid) {
    const recovered = lead.draft_order_status === "completed";
    askLine.push(
      <span key="draft" className={recovered ? "font-medium text-ok-fg" : undefined}>
        {codCoreForm
          ? recovered
            ? "Formulario recuperado"
            : "Formulario abandonado"
          : recovered
            ? "Carrito recuperado"
            : "Carrito abandonado"}
        {lead.draft_order_name ? ` ${lead.draft_order_name}` : ""}
      </span>,
    );
  }
  if (showContext && (lead.cart_item_count || cartLines.length > 0)) {
    if (cartLines.length === 0) {
      askLine.push(
        <span key="cart">
          {lead.draft_order_gid ? "" : "Carrito: "}
          {lead.cart_summary || `${lead.cart_item_count} producto(s)`}
        </span>,
      );
    }
    if (lead.cart_value != null) {
      askLine.push(
        <span key="value" className="font-semibold tabular-nums text-ink-900">
          {currency} {Number(lead.cart_value).toFixed(2)}
        </span>,
      );
    }
  } else if (showContext && lead.cart_summary) {
    askLine.push(
      <span key="seen">
        <span className="text-ink-500">Vio: </span>
        {lead.cart_summary}
      </span>,
    );
  }
  const showRecibe = showContext && !!lead.ship_name && lead.ship_name !== lead.name;
  const showAddress = showContext && !!(lead.ship_name || lead.address1 || lead.district || lead.referencia);
  const hasAskRows = !!lead.draft_order_gid || (showAddress && !!(showRecibe || lead.address1 || lead.referencia || lead.district)) || !!firstText;

  return (
    <SidePanel
      label={title}
      title={title}
      badge={
        <>
          <SegmentBadge lead={lead} currency={currency} />
          <Badge tone={winTone} title={winTitle}>
            {winLabel}
          </Badge>
          <YapeKindChip lead={lead} />
          {/* Se lo pidió al agente de voz (MOM §33): ni el agente ni el
              drip ni la secuencia de carritos lo vuelven a contactar. Una
              persona sí puede; la chapa es para que lo sepa antes. */}
          {lead.contact_opt_out_at && (
            <Badge tone="crit" title="Pidió no ser contactado">
              No contactar
            </Badge>
          )}
        </>
      }
      meta={
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {/* El número y «copiar» parten juntos: sueltos, el número bajaba
              solo y el botón quedaba colgando en la línea siguiente. */}
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <span className="tabular-nums text-ink-700">{leadPhoneLabel(lead)}</span>
            <button
              type="button"
              onClick={() => copy(handle)}
              title={copyLabel(copied, `Copiar ${handle}`)}
              aria-label={`Copiar ${handle}`}
              className="inline-flex items-center gap-1 rounded px-0.5 text-ink-500 transition-colors hover:text-ink-900 pointer-coarse:min-w-11 pointer-coarse:justify-center"
            >
              {copied === "ok" ? (
                <IconCheck aria-hidden className="size-3.5 text-ok-fg" />
              ) : copied === "fail" ? (
                <IconX aria-hidden className="size-3.5 text-crit-fg" />
              ) : (
                <IconCopy aria-hidden className="size-3.5" />
              )}
              {copied !== "idle" && (
                <span className={copied === "ok" ? "text-ok-fg" : "text-crit-fg"}>{copyLabel(copied)}</span>
              )}
            </button>
            <span role="status" className="sr-only">
              {copied === "idle" ? "" : copyLabel(copied)}
            </span>
          </span>
          {canCall ? (
            <>
              <span aria-hidden>·</span>
              <a
                href={`tel:+${lead.phone}`}
                className="inline-flex items-center font-medium text-brand-700 hover:underline pointer-coarse:min-h-11"
              >
                Llamar
              </a>
            </>
          ) : (
            // Sin número no hay llamada: decirlo es más útil que ofrecer un
            // botón que no marca. La acción real es escribirle por WhatsApp
            // pidiéndole el teléfono — el hilo ya está a la izquierda.
            <span className="font-medium text-warn-fg">· sin número, pídeselo por chat</span>
          )}
          <span aria-hidden>·</span>
          <span title={src.title} className="max-w-[40ch] truncate">
            {sourceText}
          </span>
          {priorText && (
            <>
              <span aria-hidden>·</span>
              <span>{priorText}</span>
            </>
          )}
        </span>
      }
      actions={
        // QR tel: arriba a la derecha (Frankz, 14-10-2026): la asesora lo
        // escanea con su celular y el marcador abre listo. Solo en escritorio;
        // en el teléfono ya está «Llamar». A su derecha, antes de «Cerrar»,
        // «Siguiente lead» (25-10-2026): pasar al de debajo en la lista sin
        // cerrar la ficha y buscar otro.
        canCall || next ? (
          <>
            {canCall && (
              <div className="hidden lg:block">
                <CallQr phone={lead.phone as string} size={64} />
              </div>
            )}
            {next && (
              <OpsButton
                size="sm"
                onClick={next.onOpen}
                disabled={!next.lead || next.opening}
                title={
                  next.lead
                    ? `Abrir ${next.lead.name?.trim() || leadPhoneLabel(next.lead)}, el que sigue en la lista`
                    : "Es el último de la lista"
                }
                className="pointer-coarse:h-11"
              >
                <span className="sm:hidden">Siguiente</span>
                <span className="hidden sm:inline">Siguiente lead</span>
                <IconArrowRight aria-hidden className="size-4 text-ink-500" />
              </OpsButton>
            )}
          </>
        ) : null
      }
      width="max-w-[1040px]"
      onClose={onClose}
    >
      {/* Conversación (izq., fija) · trabajo (der.). Una sola columna bajo 1.024 px. */}
      <div
        ref={gridRef}
        className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      >
        <div
          className={cn(
            "min-w-0 lg:sticky lg:top-[calc(var(--lead-head,78px)_+_1.25rem)] lg:h-[calc(100dvh_-_var(--lead-head,78px)_-_2.5rem)]",
            hasWa && "h-[min(36rem,70dvh)]",
          )}
        >
          {hasWa ? (
            <WhatsappChat
              leadId={lead.id}
              lastInboundAt={lead.last_inbound_at}
              hasConversation={!!(lead.kapso_conversation_id || lead.phone)}
              onSent={onRegistered}
            />
          ) : (
            <section
              aria-label="Conversación de WhatsApp"
              className="flex flex-col items-center justify-center gap-3 rounded-lg bg-white px-6 py-10 text-center shadow-control ring-1 ring-line lg:h-full"
            >
              <span className="grid size-12 place-items-center rounded-full bg-wash text-ink-500">
                <IconChat aria-hidden className="size-6" />
              </span>
              <div>
                <p className="text-sm font-semibold text-ink-900">Sin conversación de WhatsApp</p>
                <p className="mx-auto mt-1 max-w-[40ch] text-[13px] leading-5 text-ink-500">
                  El cliente abandonó un carrito web sin escribir. Llámalo para recuperar la venta.
                </p>
              </div>
              <OpsButton onClick={() => copy(handle)}>
                <IconCopy aria-hidden className="text-ink-500" />
                {copyLabel(copied, `Copiar ${handle}`)}
              </OpsButton>
            </section>
          )}
        </div>

        {/* Trabajo. En escritorio llega al menos al pie del chat, para que
            «Generar pedido» quede a la altura del «Enviar» de la conversación. */}
        <div className="flex min-w-0 flex-col gap-4 lg:min-h-[calc(100dvh_-_var(--lead-head,78px)_-_2.5rem)]">
          {/* Formulario de pedido: lo abre el botón del pie y ocupa la columna
              de trabajo, sin tapar la conversación.
              noReutilizarBorrador: este pedido es nuevo, no toques el borrador del anterior. */}
          {orderOpen && (
            <div
              ref={orderRef}
              tabIndex={-1}
              // Recibe el foco solo para que Tab siga dentro del formulario;
              // no es un control, así que sin anillo.
              style={{ outline: "none" }}
              className="scroll-mt-[calc(var(--lead-head,78px)_+_1.25rem)]"
            >
              <OrderFormPanel
                leadId={lead.id}
                currency={currency}
                hasCart={hasCart}
                noReutilizarBorrador={lead.has_order}
                onRegistered={onRegistered}
                onClose={() => setOrderOpen(false)}
              />
            </div>
          )}

          {/* Las tarjetas se ocultan —no se desmontan— mientras el formulario
              está abierto: una nota a medio escribir en el resultado de la
              llamada o el panel de la guía siguen ahí al cerrarlo. */}
          <div className={orderOpen ? "hidden" : "flex flex-col gap-4"}>
            {(showContext || firstText) && (
              <section aria-label="Lo que pidió" className={SECTION_CARD}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="text-sm font-semibold text-ink-900">Lo que pidió</h3>
                  {showContext && draftOrderHref && (
                    <a
                      href={draftOrderHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline pointer-coarse:min-h-11"
                    >
                      Ver borrador en Shopify
                      <IconArrowUpRight aria-hidden className="size-3.5" />
                    </a>
                  )}
                </div>
                {askLine.length > 0 && (
                  <p className="mt-1 text-[13px] leading-5 text-ink-700">
                    {askLine.map((part, i) => (
                      <Fragment key={i}>
                        {i > 0 && " · "}
                        {part}
                      </Fragment>
                    ))}
                  </p>
                )}
                {cartLines.length > 0 && (
                  <ul aria-label="Productos del carrito" className="mt-2 space-y-1.5 text-[13px] leading-5 text-ink-900">
                    {cartLines.map((line, index) => (
                      <li key={index} className="flex items-start gap-2">
                        <span className="shrink-0 font-semibold tabular-nums">{line.quantity} ×</span>
                        <span className="min-w-0 break-words">
                          {line.title}
                          {line.variant && <span className="text-ink-500"> · {line.variant}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {hasAskRows && (
                  <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px] leading-5">
                    {lead.draft_order_gid && (
                      <>
                        <dt className="text-ink-500">Carrito creado</dt>
                        <dd className="min-w-0 text-ink-900">
                          {cartCreatedAt && cartCreatedIso ? (
                            <time dateTime={cartCreatedIso}>
                              {cartCreatedAt} <span className="text-ink-500">(Lima)</span>
                            </time>
                          ) : lead.cart_detail === undefined ? "Cargando…" : "No registrado"}
                        </dd>
                      </>
                    )}
                    {showRecibe && (
                      <>
                        <dt className="text-ink-500">Recibe</dt>
                        <dd className="min-w-0 break-words text-ink-900">{lead.ship_name}</dd>
                      </>
                    )}
                    {showAddress && lead.address1 && (
                      <>
                        <dt className="text-ink-500">Dirección</dt>
                        <dd className="min-w-0 break-words text-ink-900">{lead.address1}</dd>
                      </>
                    )}
                    {showAddress && lead.referencia && (
                      <>
                        <dt className="text-ink-500">Referencia</dt>
                        <dd className="min-w-0 break-words text-ink-900">{lead.referencia}</dd>
                      </>
                    )}
                    {showAddress && lead.district && (
                      <>
                        <dt className="text-ink-500">Distrito</dt>
                        <dd className="flex min-w-0 items-start gap-2 text-ink-900">
                          {masterCoverage && <CoverageBadge coverage={masterCoverage} />}
                          <span className="min-w-0 break-words">
                            {lead.district}
                            {lead.province ? <span className="text-ink-500">{` · ${lead.province}`}</span> : null}
                          </span>
                        </dd>
                      </>
                    )}
                    {firstText && (
                      <>
                        <dt className="text-ink-500">Escribió primero</dt>
                        <dd className="min-w-0 break-words text-ink-900">“{lead.first_inbound_text}”</dd>
                      </>
                    )}
                  </dl>
                )}
              </section>
            )}

            {/* Pedidos anteriores: los 3 últimos (de Shopify, de WooCommerce y del historial de Shopify, §37.7), justo bajo «Lo que pidió»:
                es lo primero que se mira al abrir la ficha (Frankz, 14-10-2026). */}
            {history && history.recentOrders.length > 0 && (
              <section aria-label="Pedidos anteriores" className={SECTION_CARD}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="text-sm font-semibold text-ink-900">
                    Pedidos anteriores{" "}
                    <span className="font-normal tabular-nums text-ink-500">· {history.recentOrders.length}</span>
                  </h3>
                  <span className="text-[13px] tabular-nums text-ink-600">
                    {currency}{" "}
                    {history.recentOrders
                      .filter((o) => !o.cancelled)
                      .reduce((s, o) => s + o.amount, 0)
                      .toFixed(2)}{" "}
                    en total
                  </span>
                </div>
                <ul className="-mx-4 -mb-4 mt-3 divide-y divide-line border-t border-line sm:-mx-5 sm:-mb-5">
                  {history.recentOrders.map((o, i) => (
                    <li key={o.name ?? i} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink-900">Pedido {o.name ?? "—"}</span>
                        {o.cancelled && <Badge tone="crit">Anulado</Badge>}
                        {/* Del archivo importado de Shopify (MOM §37.7): no es un pedido de Kapta. */}
                        {o.fromHistory && <span className="shrink-0 text-xs text-ink-500">del historial de Shopify</span>}
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <span className="text-xs tabular-nums text-ink-500">{orderDateShort(o.createdAt)}</span>
                        <span
                          className={cn(
                            "text-sm font-semibold tabular-nums",
                            o.cancelled ? "text-ink-500 line-through decoration-ink-300" : "text-ink-900",
                          )}
                        >
                          {currency} {o.amount.toFixed(2)}
                        </span>
                        {/* El enlace va al admin de la tienda del pedido
                            (`orders.platform`, MOM §38.12): se nombra la suya. */}
                        {o.adminUrl && (
                          <a
                            href={o.adminUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`Abrir en ${orderPlatformName(o.platform)}`}
                            aria-label={`Abrir ${o.name ?? "pedido"} en ${orderPlatformName(o.platform)} (nueva pestaña)`}
                            className="-mr-1.5 grid size-7 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:size-11"
                          >
                            <IconArrowUpRight aria-hidden className="size-4" />
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Carritos anteriores (25-10-2026): ¿termina la compra o solo deja
                carritos? Las asesoras lo iban a buscar a Shopify → Borradores,
                cliente por cliente; ahora sale del espejo y del archivo de
                Shopify en Kapta (lib/customer-carts.ts). */}
            {history?.carts && history.carts.summary.total > 0 && (
              <CustomerCartsCard carts={history.carts} currency={currency} />
            )}

            {/* Resumen del bot */}
            {lead.handoff_context && (
              <Banner
                tone="info"
                title={lead.handoff_reason === LEAD_VOICE_AGENT_HANDOFF ? "Resumen del agente de voz" : "Resumen del bot"}
              >
                <p className="mt-0.5 whitespace-pre-wrap">{lead.handoff_context}</p>
              </Banner>
            )}

            {/* Asignar Yape (solo admins; se auto-oculta para vendedoras) */}
            {lead.status === "yape_por_verificar" && (
              <YapeAssign leadId={lead.id} storeId={lead.store_id} onAssigned={onRegistered} />
            )}

            {/* Crear guía en Aliclik. Es EL MISMO componente que usa el Master de
                Pedidos, con las mismas server actions: crear desde aquí o desde
                allí escribe la misma fila de `shipments`, porque las dos cuelgan
                del id interno del pedido. No hay una versión "de Leads".

                Va en esta columna y no en un modal a propósito: la vendedora
                necesita seguir viendo la conversación de WhatsApp mientras crea
                la guía —de ahí sale la ubicación cuando Shopify no la trae— y un
                modal taparía justo lo que tiene que mirar.

                Se muestra en CUALQUIER lead con pedido y sin guía, no solo tras
                generarlo: si entra una llamada y cierra el drawer, puede volver
                y terminar aquí en vez de irse al Master a buscar el pedido. */}
            {/* Guía ya creada: bloque permanente. Antes, en cuanto la guía
                existía el panel desaparecía y con él la confirmación, así que
                la vendedora la veía dos segundos y se quedaba sin saber qué
                código se había generado. Los dos códigos juntos —el pedido de
                Shopify y la guía— son los que hay que cruzar si algo se
                tuerce, así que se enseñan siempre. */}
            {history?.currentOrderGuide && (
              <section aria-label="Guía de Aliclik" className={SECTION_CARD}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink-900">Guía de Aliclik</h3>
                  <Badge tone="ok">Creada</Badge>
                </div>
                <p className="mt-2 break-all font-mono text-sm font-semibold text-ink-900">
                  {history.currentOrderGuide}
                </p>
                {history.currentOrderName && (
                  <p className="mt-0.5 text-[13px] text-ink-500">Pedido {history.currentOrderName}</p>
                )}
              </section>
            )}

            {/* El panel trae su contenido sin marco (en la ficha lo enmarca la
                tarjeta de su sección); aquí lleva su propia tarjeta. */}
            {history?.currentOrderId && !history.currentOrderGuide && (
              <div className={SECTION_CARD}>
                <AliclikGuidePanel
                  // `key` = candado de identidad. Sin ella, si la vendedora pulsa
                  // "Generar nuevo pedido" con el panel abierto, React reutiliza
                  // la instancia: cambia `orderId` pero se queda dentro la
                  // cotización del pedido ANTERIOR. Crear entonces mandaría a
                  // Aliclik el courier y el precio de un pedido y el id de otro.
                  // Con la key el panel se monta de cero para cada pedido.
                  key={history.currentOrderId}
                  orderId={history.currentOrderId}
                  hasCoordinate={history.currentOrderHasCoordinate}
                  health={history.currentOrderAliclikHealth}
                  // Sin argumento a propósito: `{refreshList:true}` toma un atajo
                  // que NO recarga el historial, y el panel se quedaría visible
                  // ofreciendo crear una guía que ya existe.
                  onCreated={() => onRegistered()}
                />
              </div>
            )}

            {/* Agente de voz de leads (MOM §33): si entra a su cola, llamar o
                probarlo, y sus llamadas. Solo con teléfono: sin número no hay
                a quién llamar. Sin argumento en onRegistered a propósito: lo
                que el agente escribe toca lead, historial y lista. */}
            {canCall && (
              <div className={VOICE_STRIP}>
                <LeadVoiceAgentPanel key={lead.id} leadId={lead.id} onChanged={() => onRegistered()} />
              </div>
            )}

            {/* Resultado de la llamada */}
            <CallForm key={lead.id} leadId={lead.id} onRegistered={onRegistered} />

            {/* Historial (timeline) */}
            <section aria-label="Historial" className={SECTION_CARD}>
              <h3 className="text-sm font-semibold text-ink-900">Historial</h3>
              {calls === null ? (
                <div role="status" className="mt-3 space-y-2">
                  <span className="sr-only">Cargando historial…</span>
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </div>
              ) : calls.length ? (
                <ol className="mt-3 flex flex-col gap-3 text-[13px] leading-5">
                  {calls.map((c, i) => (
                    <li key={c.id ?? i} className="grid grid-cols-[12px_minmax(0,1fr)] gap-2">
                      {/* Un cambio de estado se lee antes que un mensaje o una nota. */}
                      <span
                        aria-hidden
                        className={cn(
                          "mt-1.5 size-2 rounded-full",
                          c.kind !== "message" && c.new_status ? "bg-ink-600" : "bg-ink-300",
                        )}
                      />
                      <div className="min-w-0">
                        <p className="font-medium text-ink-900">
                          {c.kind === "message" ? (
                            "WhatsApp enviado"
                          ) : c.kind === LEAD_VOICE_AGENT_KIND ? (
                            // El agente de voz de leads: que no se lea como
                            // una asesora ni como el drip (MOM §33).
                            leadVoiceAgentTitle(c.new_status)
                          ) : c.new_status ? (
                            labelOf(c.new_status)
                          ) : (
                            <span className="font-normal text-ink-500">Nota</span>
                          )}
                        </p>
                        {c.note && <p className="break-words text-ink-600">{c.note}</p>}
                        <p className="text-xs tabular-nums text-ink-500">
                          {fmtDate(c.occurred_at)}
                          {c.vendedora_name
                            ? ` · ${c.vendedora_name}`
                            : c.kind === LEAD_VOICE_AGENT_KIND
                              ? ` · ${LEAD_VOICE_AGENT_NAME}`
                              : ""}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-[13px] text-ink-500">Sin actividad todavía.</p>
              )}
            </section>

            {/* Número de WhatsApp y campaña Meta */}
            {(lead.wa_phone_number_id || lead.source === "meta_ad") && (
              <LeadOrigin lead={lead} adMeta={adMeta} waNumber={waNumber} />
            )}
          </div>

          {/* Cierre de venta, pegado al pie de la columna (oculto mientras el
              formulario está abierto). El margen negativo cubre el relleno del
              panel: así el botón queda a la altura del «Enviar» del chat tanto
              pegado como al final del desplazamiento. */}
          {!orderOpen && (
            <div className="sticky bottom-0 z-[1] -mx-1 -mb-5 mt-auto bg-white px-1 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
              {lead.has_order ? (
                <div className="space-y-2">
                  {/* Lead has an order but the auto-linker didn't mark it won (a later
                      call disposition took precedence). Let the asesor confirm it. */}
                  {lead.category !== "won" && (
                    <OpsButton
                      variant="primary"
                      size="lg"
                      className="w-full"
                      onClick={() =>
                        startConfirmWon(async () => {
                          const res = await confirmLeadWon(lead.id);
                          onRegistered({ leadPatch: res.leadPatch, refreshList: true });
                        })
                      }
                      disabled={confirmingWon}
                    >
                      <IconCheck aria-hidden />
                      {confirmingWon ? "Marcando…" : "Marcar como ganado (ya tiene pedido)"}
                    </OpsButton>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-ok-fg">
                      <IconCheckCircle aria-hidden className="size-4 shrink-0" />
                      <span className="truncate">
                        Pedido generado{history?.currentOrderName ? ` · ${history.currentOrderName}` : ""}
                      </span>
                    </p>
                    <OpsButton ref={ctaRef} onClick={() => setOrderOpen(true)}>
                      <IconPlus aria-hidden className="text-ink-500" />
                      Generar nuevo pedido
                    </OpsButton>
                  </div>
                </div>
              ) : (
                <OpsButton
                  ref={ctaRef}
                  variant="primary"
                  size="lg"
                  className="w-full"
                  onClick={() => setOrderOpen(true)}
                >
                  {hasCart ? "Generar pedido (contraentrega)" : "Registrar pedido (contraentrega)"}
                </OpsButton>
              )}
            </div>
          )}
        </div>
      </div>
    </SidePanel>
  );
}

type GlyphIcon = ComponentType<SVGProps<SVGSVGElement>>;

const MEDIA_KIND_META: Record<NonNullable<LeadConversationMessage["mediaKind"]>, { icon: GlyphIcon; label: string }> = {
  image: { icon: IconImage, label: "Imagen" },
  audio: { icon: IconMic, label: "Audio" },
  video: { icon: IconCamera, label: "Video" },
  document: { icon: IconReceipt, label: "Documento" },
  sticker: { icon: IconImage, label: "Sticker" },
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
 * bottom, in the Kapta style (thread on `wash`). Loads when it mounts (resolving
 * the conversation by phone if no id was stored) and refreshes after each send.
 *
 * `variant="panel"` (la ficha): tarjeta propia que llena el alto que le da quien
 * la monta. `variant="card"` (la tarjeta del siguiente lead): sin marco, el hilo
 * con 320 px como máximo y desplazamiento propio; la misma conducta.
 */
export function WhatsappChat({
  leadId,
  lastInboundAt,
  hasConversation,
  onSent,
  variant = "panel",
}: {
  leadId: string;
  lastInboundAt?: string | null;
  hasConversation: boolean;
  onSent: (update?: LeadDrawerUpdate) => void;
  variant?: "panel" | "card";
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
  const chatRequestRef = useRef<AbortController | null>(null);
  const lastDiscoveryAtRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const load = useCallback(
    (opts?: { silent?: boolean; conversationId?: string }) => {
      if (opts?.silent && chatRequestRef.current) return;
      chatRequestRef.current?.abort();
      const controller = new AbortController();
      chatRequestRef.current = controller;
      const requestId = ++requestRef.current;
      if (!opts?.silent) {
        startUiMeasure("kapso:whatsapp-chat-first-paint");
        setState({ status: "loading" });
      }
      let firstPaintPending = !opts?.silent;
      const apply = (
        res: Awaited<ReturnType<typeof loadLeadConversation>>,
        applyOpts?: { merge?: boolean },
      ) => {
        if (requestRef.current !== requestId) return;
        activeIdRef.current = res.activeConversationId;
        if (!res.threadsUnchanged) lastDiscoveryAtRef.current = Date.now();
        setState((current) => {
          const localMessages =
            current.status === "ready"
              ? current.messages.filter((message) => message.id?.startsWith("local-") && message.status === "sending")
              : [];
          // El poll solo trae la sesión ACTIVA. Si reemplazara, borraría las
          // sesiones viejas ya fundidas (el hilo "se ocultaba" a los 20s), así
          // que se funde con lo que ya hay. Solo aplica dentro del MISMO hilo:
          // al cambiar de número hay que reemplazar, no acumular los dos.
          const prior =
            applyOpts?.merge &&
            current.status === "ready" &&
            current.activeId === res.activeConversationId
              ? current.messages.filter(
                  (message) => !(message.id?.startsWith("local-") && message.status === "sending"),
                )
              : [];
          return {
            status: "ready",
            messages: [...mergeConversationMessages(prior, res.messages), ...localMessages],
            reason: res.reason,
            ...chatContextAfterRead(current.status === "ready" ? current : null, res),
            activeId: res.activeConversationId,
          };
        });
        if (firstPaintPending) {
          firstPaintPending = false;
          finishUiMeasure("kapso:whatsapp-chat-first-paint");
        }
      };
      // First paint reads only the active session. Older sessions are merged in
      // a silent follow-up, while 20s polls remain cheap and active-session only.
      const refreshActiveOnly = !!opts?.silent && canUseActiveChatPoll(lastDiscoveryAtRef.current, Date.now());
      void loadLeadConversation(leadId, opts?.conversationId, false, controller.signal, refreshActiveOnly).then(async (res) => {
        apply(res, { merge: !!opts?.silent });
        if (!controller.signal.aborted && !opts?.silent && res.activeConversationId) {
          // El segundo pase trae el hilo completo (sesiones viejas incluidas):
          // es un superconjunto, así que reemplaza sin merge.
          const full = await loadLeadConversation(leadId, res.activeConversationId, true, controller.signal);
          apply(full);
        }
      }).catch(() => {
        if (controller.signal.aborted || requestRef.current !== requestId) return;
        setState((current) => current.status === "ready" ? current : {
          status: "ready", messages: [], threads: [], activeId: null, activePhoneNumberId: null,
          reason: "No se pudo cargar la conversación. Vuelve a intentarlo.",
        });
      }).finally(() => {
        if (chatRequestRef.current === controller) chatRequestRef.current = null;
      });
    },
    [leadId],
  );

  // Load on open; reset scroll/thread tracking when switching leads.
  useEffect(() => {
    atBottomRef.current = true;
    countRef.current = 0;
    activeIdRef.current = null;
    lastDiscoveryAtRef.current = null;
    setShowJump(false);
    setSearch("");
    if (hasConversation) load();
    return () => {
      requestRef.current++;
      chatRequestRef.current?.abort();
      chatRequestRef.current = null;
    };
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

  const card = variant === "card";
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
  const total = allMessages.length;
  const headContext = [
    total > 0 ? `${total.toLocaleString("es-PE")} ${total === 1 ? "mensaje" : "mensajes"}` : null,
    activeThread?.label ? `desde ${activeThread.label}` : null,
  ].filter(Boolean);
  // La hairline bajo cada franja de la tarjeta; en la variante sin marco basta el aire.
  const band = card ? "pb-2" : "px-4 py-2 shadow-[inset_0_-1px_0_var(--color-line)]";
  // Interleave day separators ("Hoy", "Ayer", "26 jun") into the (filtered) thread.
  const rows: ReactNode[] = [];
  let lastDay = "";
  messages.forEach((m, i) => {
    const day = dayKeyOf(m.at);
    if (day !== lastDay) {
      rows.push(
        <div key={`day-${i}`} className="flex justify-center py-1">
          <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-medium text-ink-500 ring-1 ring-line">
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
    <section
      aria-label="Conversación de WhatsApp"
      className={
        card
          ? "flex h-full min-h-0 min-w-0 flex-col"
          : "flex h-full min-h-0 min-w-0 flex-col rounded-lg bg-white shadow-control ring-1 ring-line"
      }
    >
      {/* Cabecera: qué es, cuántos mensajes y desde qué número; buscar y actualizar. */}
      <div className={cn("flex items-center justify-between gap-2", card ? "pb-2 shadow-[inset_0_-1px_0_var(--color-line)]" : "px-4 py-1.5 shadow-[inset_0_-1px_0_var(--color-line)]")}>
        <p className="min-w-0 truncate text-sm font-semibold text-ink-900">
          Conversación
          {headContext.length > 0 && (
            <span className="font-normal tabular-nums text-ink-500">{` · ${headContext.join(" · ")}`}</span>
          )}
        </p>
        <div className="-mr-1.5 flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setSearchOpen((s) => !s)}
            title="Buscar en la conversación"
            aria-label="Buscar"
            aria-pressed={searchOpen}
            className={cn(ICON_BTN, searchOpen ? "bg-wash text-ink-900" : "text-ink-500")}
          >
            <IconSearch aria-hidden className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => load()}
            title="Actualizar"
            aria-label="Actualizar conversación"
            className={cn(ICON_BTN, "text-ink-500")}
          >
            <IconRepeat aria-hidden className="size-4" />
          </button>
        </div>
      </div>

      {/* Selector de número: solo si el cliente escribió a más de un número */}
      {threads.length > 1 && (
        <div className={cn("flex gap-1.5 overflow-x-auto", band)}>
          {threads.map((t) => (
            <ChoiceChip
              key={t.conversationId}
              label={t.label}
              active={t.conversationId === activeId}
              onClick={() => switchThread(t.conversationId)}
              title={t.displayPhone ?? undefined}
            />
          ))}
        </div>
      )}

      {/* Buscar dentro de la conversación */}
      {searchOpen && (
        <div className={cn("flex items-center gap-2", band)}>
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Buscar en la conversación…"
            aria-label="Buscar en la conversación"
            className={cn(FIELD_BOX, "h-8 w-full px-3")}
          />
          {q && (
            <span className="shrink-0 text-xs tabular-nums text-ink-500">
              {messages.length} {messages.length === 1 ? "coincidencia" : "coincidencias"}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setSearchOpen(false);
            }}
            className={cn(ICON_BTN, "text-ink-500")}
            aria-label="Cerrar búsqueda"
          >
            <IconX aria-hidden className="size-4" />
          </button>
        </div>
      )}

      {/* Hilo de mensajes */}
      {/* En la tarjeta el hilo no decide el alto: se desplaza dentro del que
          marcan las otras dos columnas. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onThreadScroll}
          className={cn(
            "absolute inset-0 space-y-2 overflow-y-auto overscroll-contain bg-wash",
            card ? "rounded-md px-1 py-3" : "px-4 py-4",
          )}
        >
          {state.status === "loading" ? (
            <p className="py-10 text-center text-[13px] text-ink-500">Cargando conversación…</p>
          ) : messages.length ? (
            rows
          ) : (
            <p className="py-10 text-center text-[13px] text-ink-500">
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
            className="absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1 rounded-full bg-white px-3 text-[13px] font-medium text-brand-700 shadow-control ring-1 ring-inset ring-line-strong hover:bg-wash"
          >
            <IconChevronDown aria-hidden className="size-4" />
            Nuevos mensajes
          </button>
        )}
      </div>

      {/* Composer pegado abajo */}
      <WhatsappComposer
        leadId={leadId}
        lastInboundAt={effectiveLastInboundAt}
        phoneNumberId={activePhoneNumberId}
        numberHint={numberHint}
        compact={card}
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
      <a key={i} href={part} target="_blank" rel="noreferrer" className="break-all text-brand-700 underline">
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
      <mark key={`h${k}`} className="rounded-sm bg-warn-bg px-0.5 text-ink-900">
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

type TickKind = "read" | "delivered" | "sent" | "pending" | "unknown" | "failed";

/** WhatsApp delivery state for an outbound message (null = no indicator). */
function statusTicks(status: string | null): { kind: TickKind; cls: string; label: string } | null {
  switch (status) {
    case "read":
      return { kind: "read", cls: "text-info-fg", label: "Leído" };
    case "delivered":
      return { kind: "delivered", cls: "text-ink-500", label: "Entregado" };
    case "sent":
      return { kind: "sent", cls: "text-ink-500", label: "Enviado" };
    case "pending":
    case "sending":
      return { kind: "pending", cls: "text-ink-500", label: "Enviando" };
    case "unknown":
      return { kind: "unknown", cls: "text-warn-fg", label: "Estado por confirmar" };
    case "failed":
    case "error":
      return { kind: "failed", cls: "text-crit-fg", label: "No se envió" };
    default:
      return null;
  }
}

/** El dibujo del estado: uno o dos vistos, el reloj mientras sale, o el aviso. */
function TickGlyph({ kind }: { kind: TickKind }) {
  if (kind === "read" || kind === "delivered") {
    return (
      <span aria-hidden className="inline-flex">
        <IconCheck className="size-3" strokeWidth={2.4} />
        <IconCheck className="-ml-1.5 size-3" strokeWidth={2.4} />
      </span>
    );
  }
  if (kind === "sent") return <IconCheck aria-hidden className="size-3" strokeWidth={2.4} />;
  if (kind === "pending") return <IconClock aria-hidden className="size-3" />;
  if (kind === "unknown") return <IconInfo aria-hidden className="size-3" />;
  return <IconAlert aria-hidden className="size-3" />;
}

/** One WhatsApp bubble: customer (left, white with ring) vs. business (right, on
 *  `line`), with inline image/audio/video players, delivery state (outbound) and
 *  clickable links. */
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
  const MediaGlyph = meta?.icon;
  const ticks = outbound ? statusTicks(msg.status) : null;
  // La hora va al final del texto, como en WhatsApp; sin texto, sola a la derecha.
  const stamp = (
    <span className="ml-2 inline-flex translate-y-0.5 items-center gap-1 whitespace-nowrap align-baseline text-xs leading-none tabular-nums text-ink-500">
      {chatTime(msg.at)}
      {ticks && (
        <span className={ticks.cls} title={ticks.label} role="img" aria-label={ticks.label}>
          <TickGlyph kind={ticks.kind} />
        </span>
      )}
    </span>
  );
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-[13px] leading-5 text-ink-900",
          outbound ? "bg-line" : "bg-white shadow-control ring-1 ring-line",
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
                "rounded-md object-cover",
                msg.mediaKind === "sticker" ? "max-h-28" : "mb-1 max-h-64 w-full",
              )}
            />
          </a>
        ) : mediaSrc && msg.mediaKind === "audio" ? (
          <audio controls preload="none" src={mediaSrc} className="mb-1 h-9 w-56 max-w-full" />
        ) : mediaSrc && msg.mediaKind === "video" ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video controls preload="none" src={mediaSrc} className="mb-1 max-h-64 w-full rounded-md" />
        ) : mediaSrc && meta && MediaGlyph ? (
          <a
            href={mediaSrc}
            target="_blank"
            rel="noreferrer"
            className="mb-0.5 flex items-center gap-1.5 font-medium text-brand-700 hover:underline"
          >
            <MediaGlyph aria-hidden className="size-4 shrink-0" />
            {meta.label}
          </a>
        ) : null}
        {msg.text ? (
          <p className="whitespace-pre-wrap break-words">
            {highlight ? highlightText(msg.text, highlight) : linkify(msg.text)}
            {stamp}
          </p>
        ) : (
          <p className="text-right">{stamp}</p>
        )}
        {outbound && msg.status === "unknown" && (
          <p className="mt-1 text-xs text-warn-fg">
            Estado por confirmar. Actualiza el chat antes de volver a enviar.
          </p>
        )}
        {outbound && (msg.status === "failed" || msg.status === "error") && (
          <div className="mt-1.5 flex items-center justify-end gap-2 text-xs text-crit-fg">
            <span className="min-w-0 truncate" title={msg.error ?? undefined}>No se envió</span>
            {msg.retryable && msg.outboxId && (
              <button
                type="button"
                onClick={() => onRetry(msg)}
                disabled={retrying}
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-white px-2 font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong hover:bg-wash disabled:opacity-50"
                aria-label="Reintentar mensaje fallido"
              >
                <IconRepeat aria-hidden className="size-3.5" />
                {retrying ? "Reintentando…" : "Reintentar"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** El pie del chat: respuestas rápidas, adjuntar (o pegar con Ctrl+V), emojis,
 *  Enter para enviar. Solo dentro de la ventana de 24 h; fuera de ella ofrece
 *  las plantillas aprobadas y dice por qué. */
function WhatsappComposer({
  leadId,
  lastInboundAt,
  phoneNumberId,
  numberHint,
  compact = false,
  onOptimisticSend,
  onSendSettled,
  onSent,
}: {
  leadId: string;
  lastInboundAt?: string | null;
  phoneNumberId?: string | null;
  numberHint?: string | null;
  /** Variante sin marco (la tarjeta del siguiente lead): sin relleno lateral ni hairline. */
  compact?: boolean;
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
  const foot = compact ? "pt-2" : "px-4 py-3 shadow-[inset_0_1px_0_var(--color-line)]";

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

  /**
   * Mete el emoji DONDE ESTÁ EL CURSOR, no al final. Quien corrige una frase ya
   * escrita espera que caiga donde tenía el punto de inserción; si saltara al
   * final, el segundo emoji de un mensaje quedaría en otro sitio que el primero.
   * Sin el textarea montado se añade al final, que es lo único posible.
   */
  function insertEmoji(emoji: string) {
    const ta = taRef.current;
    if (!ta) {
      setText((t) => t + emoji);
      return;
    }
    const { text: next, caret } = insertAtCursor(text, ta.selectionStart, ta.selectionEnd, emoji);
    setText(next);
    // Tras el re-render de React: antes, `setSelectionRange` actuaría sobre el
    // valor viejo del textarea y el cursor acabaría en un sitio arbitrario.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  }

  if (win.loading) {
    return <p className={cn("text-xs text-ink-500", foot)}>Verificando ventana de 24h…</p>;
  }
  if (!win.open) {
    return (
      <TemplateComposer
        leadId={leadId}
        phoneNumberId={phoneNumberId}
        reason={win.reason ?? "El cliente debe escribirte primero."}
        compact={compact}
        onOptimisticSend={onOptimisticSend}
        onSendSettled={onSendSettled}
        onSent={onSent}
      />
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", foot)}>
      <QuickReplyBar leadId={leadId} onInsert={(b) => setText(b)} />
      {numberHint && (
        <p className="text-xs text-ink-500">
          Respondes desde <span className="font-medium text-ink-700">{numberHint}</span>
        </p>
      )}
      {attachFile && (
        <MediaAttach
          leadId={leadId}
          file={attachFile}
          setFile={setAttachFile}
          disabled={pending}
          phoneNumberId={phoneNumberId}
          onSent={onSent}
          onWindowClosed={() => setWin({ loading: false, open: false, reason: "Se cerró la ventana de 24h." })}
        />
      )}
      <div className="flex items-end gap-2">
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
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={pending}
            title="Adjuntar imagen, PDF o video"
            aria-label="Adjuntar"
            className="grid size-9 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11"
          >
            <IconPlus aria-hidden className="size-5" />
          </button>
          <EmojiPicker disabled={pending} onPick={insertEmoji} />
        </div>
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
          aria-label="Mensaje"
          disabled={pending}
          className={cn(FIELD_BOX, "flex-1 resize-none overflow-y-auto px-3 py-2 leading-5", compact ? "min-h-9" : "min-h-16")}
        />
        <OpsButton variant="primary" onClick={send} disabled={pending || !text.trim()}>
          {pending ? "Enviando…" : "Enviar"}
        </OpsButton>
      </div>
      {msg && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span role="alert" className="text-crit-fg">{msg}</span>
          <button
            type="button"
            onClick={send}
            disabled={pending}
            className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-700 hover:underline disabled:opacity-50"
          >
            <IconRepeat aria-hidden className="size-3.5" />
            Reintentar
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Lo que reemplaza al texto libre cuando la ventana de 24 h está cerrada: el
 * catálogo de plantillas aprobadas de la tienda.
 *
 * Antes acá solo había un aviso de que no se podía escribir, que es cierto pero
 * deja al asesor sin salida —se iba a Kapso a mandar la plantilla desde allá—.
 * El aviso se conserva, porque explica POR QUÉ no hay caja de texto; lo que se
 * añade es la única acción que Meta sí permite fuera de la ventana.
 *
 * Los parámetros llegan pre-rellenados del lead y se dejan editar: el dato
 * guardado puede estar incompleto o mal escrito, y un parámetro vacío lo rechaza
 * Meta con un código que no dice nada. El preview se pinta mientras se edita
 * para que nadie mande a ciegas un mensaje que no puede retirar.
 */
function TemplateComposer({
  leadId,
  phoneNumberId,
  reason,
  compact = false,
  onOptimisticSend,
  onSendSettled,
  onSent,
}: {
  leadId: string;
  phoneNumberId?: string | null;
  reason: string;
  compact?: boolean;
  onOptimisticSend: (body: string) => string;
  onSendSettled: (localId: string, sent: LeadConversationMessage | null) => void;
  onSent: (leadPatch?: LeadActionState["leadPatch"]) => void;
}) {
  const [templates, setTemplates] = useState<LeadReplyTemplate[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [values, setValues] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    setTemplates(null);
    setSelectedId("");
    setValues([]);
    setMsg(null);
    listLeadTemplates(leadId).then((list) => {
      if (!alive) return;
      setTemplates(list);
      // Con una sola plantilla no se elige nada: se deja lista.
      if (list.length === 1) {
        setSelectedId(list[0]!.id);
        setValues(list[0]!.defaults);
      }
    }).catch(() => { if (alive) { setTemplates([]); setMsg("No se pudieron cargar las plantillas."); } });
    return () => {
      alive = false;
    };
  }, [leadId]);

  const selected = templates?.find((t) => t.id === selectedId) ?? null;
  const preview = selected ? renderReplyPreview(selected.bodyPreview, values) : "";

  function pick(id: string) {
    setSelectedId(id);
    setMsg(null);
    const t = templates?.find((x) => x.id === id);
    // Cada plantilla tiene sus propios tokens: los valores de la anterior no se
    // arrastran, o {{2}} llevaría el distrito donde va el monto.
    setValues(t ? t.defaults : []);
  }

  function send() {
    if (!selected) return;
    setMsg(null);
    // Se valida ANTES de la burbuja optimista. El servidor vuelve a validar —es
    // quien manda—, pero un parámetro vacío es el error más frecuente de esta
    // pantalla, y hacerlo allá pintaría un mensaje que desaparece medio segundo
    // después: parece que se envió y se perdió.
    const invalid = validateReplyParams(selected.tokens, values);
    if (invalid) {
      setMsg(invalid);
      return;
    }
    const body = preview || `[plantilla] ${selected.label}`;
    const localId = onOptimisticSend(body);
    const clientToken = crypto.randomUUID();
    startTransition(async () => {
      const res = await sendLeadTemplate(
        leadId,
        selected.id,
        values,
        phoneNumberId ?? undefined,
        clientToken,
      );
      if (res.error) {
        onSendSettled(localId, res.sentMessage ?? null);
        setMsg(res.error);
        return;
      }
      onSendSettled(localId, res.sentMessage ?? null);
      setMsg(null);
      onSent(res.leadPatch);
    });
  }

  return (
    <div className={cn("flex flex-col gap-2", compact ? "pt-2" : "px-4 py-3 shadow-[inset_0_1px_0_var(--color-line)]")}>
      {/* En la tarjeta, sin plantillas los dos avisos van en uno: la columna
          del chat es angosta y dos cajas seguidas se comían el hilo. */}
      <Banner tone="warn">
        {reason} Fuera de las 24h solo se puede enviar una plantilla aprobada
        {compact && templates?.length === 0
          ? ", y esta tienda todavía no tiene ninguna: se cargan en Ajustes, en «Plantillas de respuesta»."
          : "."}
      </Banner>

      {templates === null ? (
        <p className="text-xs text-ink-500">Buscando plantillas…</p>
      ) : templates.length === 0 ? (
        compact ? null : (
          <p className="text-xs leading-5 text-ink-500">
            Esta tienda todavía no tiene plantillas cargadas. Se configuran en Ajustes, en «Plantillas de
            respuesta», con el nombre exacto aprobado en Meta.
          </p>
        )
      ) : (
        <div className="space-y-2">
          <select
            value={selectedId}
            onChange={(e) => pick(e.currentTarget.value)}
            disabled={pending}
            aria-label="Plantilla"
            className={FIELD}
          >
            <option value="">Elige una plantilla…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>

          {selected && selected.tokens.length > 0 && (
            <div className="space-y-2">
              {selected.tokens.map((tok, i) => (
                <label key={`${selected.id}:${i}`} className="block">
                  <span className="text-xs text-ink-600">
                    {REPLY_TOKEN_LABEL[tok]} · {`{{${i + 1}}}`}
                  </span>
                  <input
                    value={values[i] ?? ""}
                    onChange={(e) => {
                      const next = [...values];
                      next[i] = e.currentTarget.value;
                      setValues(next);
                      setMsg(null);
                    }}
                    disabled={pending}
                    placeholder={REPLY_TOKEN_LABEL[tok]}
                    className={cn(FIELD_BOX, "mt-1 h-8 w-full px-3")}
                  />
                </label>
              ))}
            </div>
          )}

          {/* La vista previa se ve como la burbuja que va a salir. */}
          {selected && preview && (
            <div className="whitespace-pre-wrap rounded-lg bg-line px-3 py-2 text-[13px] leading-5 text-ink-900">
              {preview}
            </div>
          )}

          {selected && !selected.bodyPreview && (
            <p className="text-xs text-warn-fg">
              Esta plantilla no tiene el cuerpo cargado en Ajustes, así que no se puede previsualizar
              lo que se enviará.
            </p>
          )}

          <OpsButton variant="primary" className="w-full" onClick={send} disabled={pending || !selected}>
            {pending ? "Enviando…" : "Enviar plantilla"}
          </OpsButton>

          {msg && <p role="alert" className="text-xs text-crit-fg">{msg}</p>}
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

/** Per-store canned messages: pills that fill the composer + an inline manager. */
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
    }).catch(() => { if (alive) setMsg("No se pudieron cargar las respuestas rápidas."); });
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
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {replies.map((r) => (
          <button key={r.id} type="button" onClick={() => onInsert(r.body)} title={r.body} className={QUICK_PILL}>
            {r.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setManage((m) => !m)}
          aria-expanded={manage}
          className="inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium text-ink-600 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:h-11"
        >
          {manage ? "Cerrar" : "Editar respuestas"}
        </button>
      </div>
      {manage && (
        <div className="space-y-2 rounded-md bg-wash p-3">
          {replies.length === 0 ? (
            <p className="text-xs text-ink-500">Aún no hay respuestas rápidas.</p>
          ) : (
            <ul className="divide-y divide-line">
              {replies.map((r) => (
                <li key={r.id} className="flex items-center gap-2 py-1 text-xs">
                  <span className="min-w-[90px] font-medium text-ink-900">{r.label}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-600">{r.body}</span>
                  <button
                    type="button"
                    onClick={() => remove(r.id)}
                    disabled={pending}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-white hover:text-crit-fg disabled:opacity-50 pointer-coarse:size-11"
                    title="Eliminar"
                    aria-label={`Eliminar ${r.label}`}
                  >
                    <IconX aria-hidden className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 border-t border-line pt-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              placeholder="Título (ej. Datos de pago)"
              aria-label="Título de la respuesta"
              className={cn(FIELD_BOX, "h-8 w-full px-3")}
              disabled={pending}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              rows={2}
              placeholder="Mensaje…"
              aria-label="Mensaje de la respuesta"
              className={cn(FIELD_BOX, "w-full px-3 py-1.5")}
              disabled={pending}
            />
            <div className="flex flex-wrap items-center gap-2">
              <OpsButton size="sm" onClick={add} disabled={pending || !label.trim() || !body.trim()}>
                <IconPlus aria-hidden className="text-ink-500" />
                Agregar
              </OpsButton>
              {msg && <span role="alert" className="text-xs text-crit-fg">{msg}</span>}
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
    <div className="space-y-2 rounded-md bg-wash p-3">
      {file.type.startsWith("image/") ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview ?? ""} alt="Vista previa" className="max-h-40 rounded-md" />
      ) : file.type.startsWith("video/") ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={preview ?? ""} controls className="max-h-40 rounded-md" />
      ) : (
        <div className="flex items-center gap-2 text-[13px] text-ink-700">
          <IconReceipt aria-hidden className="size-4 shrink-0 text-ink-500" />
          <span className="truncate">{file.name || "Documento"}</span>
        </div>
      )}
      <input
        value={caption}
        onChange={(e) => setCaption(e.currentTarget.value)}
        placeholder="Texto (opcional)"
        aria-label="Texto del adjunto"
        disabled={pending}
        className={cn(FIELD_BOX, "h-8 w-full px-3")}
      />
      <div className="flex flex-wrap items-center gap-2">
        <OpsButton variant="primary" size="sm" onClick={send} disabled={disabled || pending}>
          {pending ? "Enviando…" : `Enviar ${kindLabel}`}
        </OpsButton>
        <OpsButton variant="ghost" size="sm" onClick={clear} disabled={pending}>
          Quitar
        </OpsButton>
        {msg && <span role="alert" className="text-xs text-crit-fg">{msg}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified order form (supersedes Cerrar venta + Generar pedido). Pre-fills from
// the cart's draft (or blank for a new sale), products from the real catalog
// (or a custom item), required address, then generates a REAL Shopify order
// (contraentrega / COD: pago pendiente, lead Ganado, crédito a la asesora).
//
// En una tienda que ya crea sus pedidos en WooCommerce (MOM §38.12) el pedido
// se crea allí, cada línea por su SKU: no hay ítem manual.
// ---------------------------------------------------------------------------

type OrderItem = {
  key: string;
  variantId: string | null;
  title: string;
  quantity: number;
  unitPrice: number | null;
  /** El SKU del catálogo. WooCommerce crea la línea por él; Shopify no lo usa. */
  sku: string | null;
};
type ProductResult = Awaited<ReturnType<typeof searchStoreProducts>>[number]; // producto + variantes
// A single variant flattened for the line-item add (what ProductPicker returns).
type PickedVariant = { variantId: string; title: string; price: number | null; inventory: number | null; sku: string | null };

const rid = () => Math.random().toString(36).slice(2);
/**
 * El id de un intento de «Generar pedido»: el mismo en cada reintento hasta que
 * sale bien. En WooCommerce es lo que evita dos pedidos por un doble clic o un
 * reintento (`kapta_request_id`, MOM §38.12).
 */
const newRequestId = () => globalThis.crypto?.randomUUID?.() ?? `${rid()}${rid()}${rid()}`;

const PERU_REGIONS = [
  "Amazonas", "Áncash", "Apurímac", "Arequipa", "Ayacucho", "Cajamarca", "Callao", "Cusco",
  "Huancavelica", "Huánuco", "Ica", "Junín", "La Libertad", "Lambayeque", "Lima", "Loreto",
  "Madre de Dios", "Moquegua", "Pasco", "Piura", "Puno", "San Martín", "Tacna", "Tumbes", "Ucayali",
];
/** Map a free-text province (e.g. "Lima (provincia)") to a canonical Peru region. */
function matchPeruRegion(v: string | null | undefined): string {
  if (!v) return "";
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const nv = norm(v);
  return PERU_REGIONS.find((r) => nv.includes(norm(r))) ?? v;
}

export function OrderFormPanel({
  leadId,
  currency,
  hasCart,
  noReutilizarBorrador,
  onRegistered,
  onClose,
}: {
  leadId: string;
  currency: string;
  hasCart: boolean;
  noReutilizarBorrador?: boolean; // pedido NUEVO: no reutilizar el borrador anterior
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
  const [orderNote, setOrderNote] = useState(""); // → Notas del pedido en la tienda
  // Dónde se creará el pedido (`stores.platform`). Null hasta que carga, o si
  // no se pudo leer: sin saberlo no se ofrece «Ítem manual», que WooCommerce
  // no puede crear (el servidor decide y frena igual).
  const [platform, setPlatform] = useState<"shopify" | "woocommerce" | null>(null);
  const requestIdRef = useRef(newRequestId());
  const [windowOpen, setWindowOpen] = useState(false);
  const [sendConfirm, setSendConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [discountKind, setDiscountKind] = useState<"none" | "fixed" | "percent">("none");
  const [discountValue, setDiscountValue] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  /**
   * El aviso de posible duplicado que el asesor puede saltarse (09-10-2026).
   * El servidor pedía «vuelve a confirmar», pero la pantalla nunca mandaba la
   * confirmación: «Generar pedido» repetía el mismo aviso para siempre y el
   * cliente que pedía una unidad más se quedaba sin pedido.
   */
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [generatedOrder, setGeneratedOrder] = useState<NonNullable<LeadActionState["generatedOrder"]> | null>(null);
  const { state: copiedOrder, copy: copyOrder, reset: resetCopiedOrder } = useCopyToClipboard();
  const headingId = useId();
  const provinceId = useId();
  const noteId = useId();

  useEffect(() => {
    let alive = true;
    setGeneratedOrder(null);
    resetCopiedOrder();
    requestIdRef.current = newRequestId();
    setPlatform(null);
    loadOrderDraft(leadId).then((res) => {
      if (!alive) return;
      if ("error" in res) {
        setMsg(res.error);
      } else {
        setPlatform(res.platform === "woocommerce" ? "woocommerce" : "shopify");
        setItems(res.lineItems.map((li) => ({ ...li, sku: li.sku ?? null, key: rid() })));
        setName(res.customerName ?? "");
        // Solo la parte nacional: el campo pinta el `+51` fijo al lado, y el
        // teléfono del lead viene de WhatsApp CON el 51 delante. Sin quitarlo se
        // vería "+51 51988805509", que confunde y da un dígito de más al ojo.
        setPhone(formatPeruMobile(res.phone));
        setAddress1(res.address1 ?? "");
        setDistrict(res.district ?? "");
        setProvince(matchPeruRegion(res.province));
        setReferencia(res.referencia ?? "");
        setWindowOpen(res.windowOpen);
        setSendConfirm(res.windowOpen);
      }
      setLoading(false);
    }).catch(() => {
      if (alive) { setMsg("No se pudo cargar el borrador."); setLoading(false); }
    });
    return () => {
      alive = false;
    };
  }, [leadId, resetCopiedOrder]);

  const subtotal = items.reduce((s, it) => s + (it.unitPrice ?? 0) * (Number(it.quantity) || 0), 0);
  const discountAmount =
    discountKind !== "none" && discountValue != null && discountValue > 0
      ? discountKind === "percent"
        ? (subtotal * Math.min(100, discountValue)) / 100
        : Math.min(subtotal, discountValue)
      : 0;
  const total = Math.max(0, subtotal - discountAmount);
  // El celular es obligatorio y con forma de móvil peruano: es por donde el
  // courier llama y por donde va la confirmación de WhatsApp que ofrece este
  // mismo formulario. La regla NO se escribe acá — sale de lib/phone.ts, la
  // misma que vuelve a comprobar la server action. Dos copias de la regla
  // acabarían discrepando, y quien lo sufriría es quien se fía de la pantalla.
  const phoneProblem = peruMobileProblem(phone);
  const valid =
    items.length > 0 &&
    address1.trim().length > 0 &&
    district.trim().length > 0 &&
    subtotal > 0 &&
    !phoneProblem;

  function patchItem(key: string, patch: Partial<OrderItem>) {
    setItems((x) => x.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }
  function removeItem(key: string) {
    setItems((x) => x.filter((it) => it.key !== key));
  }

  /** `confirmarDuplicado`: el asesor vio el aviso de duplicado y lo crea igual. */
  function submit(confirmarDuplicado = false) {
    if (!valid) {
      setMsg("Completa productos, dirección y distrito antes de generar.");
      return;
    }
    setMsg(null);
    setDuplicateWarning(null);
    setGeneratedOrder(null);
    resetCopiedOrder();
    startTransition(async () => {
      const res = await generateOrder(leadId, {
        lineItems: items.map((it) => ({
          variantId: it.variantId,
          title: it.title,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          sku: it.sku,
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
        noReutilizarBorrador,
        confirmarDuplicado,
        requestId: requestIdRef.current,
      });
      if (res.requiereConfirmacion && res.error) {
        setDuplicateWarning(res.error);
        return;
      }
      if (res.error) {
        setMsg(res.error);
        return;
      }
      setMsg(res.notice ?? "Pedido generado.");
      // Salió bien: la próxima venta desde este formulario es otro intento.
      requestIdRef.current = newRequestId();
      setGeneratedOrder(
        res.generatedOrder ?? {
          id: "",
          orderId: "",
          name: "Pedido generado",
          total,
          currency,
          adminUrl: null,
          confirmationSent: sendConfirm,
        },
      );
      onRegistered();
    });
  }

  function copyGeneratedOrder() {
    if (!generatedOrder) return;
    copyOrder(generatedOrder.name || generatedOrder.id || "Pedido generado");
  }

  return (
    <section aria-labelledby={headingId} className={SECTION_CARD}>
      <SectionHead
        id={headingId}
        title={hasCart ? "Generar pedido · contraentrega" : "Registrar pedido · contraentrega"}
        aside={
          <OpsButton variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cerrar
          </OpsButton>
        }
      />

      {loading ? (
        <div role="status" className="space-y-2 pt-4 sm:pt-5">
          <span className="sr-only">Cargando datos del pedido…</span>
          <Skeleton className="h-12" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : (
        <>
          {/* Productos y total */}
          <div className="space-y-3 pt-4 sm:pt-5">
            <p className={LABEL}>Productos</p>
            {items.length === 0 && (
              <p className="text-[13px] text-ink-500">
                {platform === "shopify" ? "Sin productos. Agrega del catálogo o un ítem manual." : "Sin productos. Agrega del catálogo."}
              </p>
            )}
            {items.length > 0 && (
              <ul className="-mx-4 divide-y divide-line border-y border-line sm:-mx-5">
                {items.map((it) => (
                  <li key={it.key} className="px-4 py-2.5 sm:px-5">
                    <div className="flex items-start gap-2">
                      {it.variantId || it.sku ? (
                        <span className="min-w-0 flex-1 pt-1.5 text-sm text-ink-900">{it.title}</span>
                      ) : (
                        <input
                          value={it.title}
                          onChange={(e) => patchItem(it.key, { title: e.currentTarget.value })}
                          placeholder="Producto (ítem manual)"
                          aria-label="Producto (ítem manual)"
                          className={cn(FIELD_BOX, "h-8 min-w-0 flex-1 px-2.5")}
                          disabled={pending}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => removeItem(it.key)}
                        disabled={pending}
                        className="grid size-8 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-crit-fg disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11"
                        title="Quitar"
                        aria-label="Quitar"
                      >
                        <IconX aria-hidden className="size-4" />
                      </button>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-600">
                      <label className="flex items-center gap-1.5">
                        Cant.
                        <input
                          type="number"
                          min={1}
                          value={it.quantity}
                          onChange={(e) => patchItem(it.key, { quantity: Math.max(1, Number(e.currentTarget.value) || 1) })}
                          className={cn(FIELD_BOX, "h-8 w-16 px-2 tabular-nums")}
                          disabled={pending}
                        />
                      </label>
                      {it.variantId || it.sku ? (
                        // Catalog product: unit price is fixed to the catalog (read-only).
                        // Any reduction is handled via the order-level "Descuento" field.
                        <span className="tabular-nums">
                          {currency} {(it.unitPrice ?? 0).toFixed(2)}{" "}
                          <span className="text-xs text-ink-500">c/u</span>
                        </span>
                      ) : (
                        // Manual item: no catalog price to pull from, so it stays editable.
                        <label className="flex items-center gap-1.5">
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
                            className={cn(FIELD_BOX, "h-8 w-24 px-2 tabular-nums")}
                            disabled={pending}
                          />
                        </label>
                      )}
                      <span className="ml-auto font-medium tabular-nums text-ink-900">
                        {currency} {((it.unitPrice ?? 0) * (Number(it.quantity) || 0)).toFixed(2)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <OpsButton size="sm" onClick={() => setShowPicker(true)} disabled={pending}>
                <IconPlus aria-hidden className="text-ink-500" />
                Producto del catálogo
              </OpsButton>
              {/* WooCommerce crea cada línea por SKU: un ítem manual no se puede
                  crear allí (el servidor lo frena igual, MOM §38.12). */}
              {platform === "woocommerce" ? (
                <span className="text-xs text-ink-500">WooCommerce: solo productos del catálogo (con SKU).</span>
              ) : platform !== "shopify" ? null : (
                <OpsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setItems((x) => [...x, { key: rid(), variantId: null, title: "", quantity: 1, unitPrice: null, sku: null }])}
                  disabled={pending}
                >
                  <IconPlus aria-hidden />
                  Ítem manual
                </OpsButton>
              )}
            </div>
            {showPicker && (
              <ProductPicker
                leadId={leadId}
                currency={currency}
                onPick={(p) => {
                  setItems((x) => [
                    ...x,
                    { key: rid(), variantId: p.variantId, title: p.title, quantity: 1, unitPrice: p.price, sku: p.sku },
                  ]);
                  setShowPicker(false);
                }}
                onClose={() => setShowPicker(false)}
              />
            )}

            {/* Descuento y total: un marco de cifras sobre el lavado. */}
            <div className="rounded-md bg-wash px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-ink-700">Descuento</span>
                <select
                  value={discountKind}
                  onChange={(e) => {
                    const k = e.currentTarget.value as "none" | "fixed" | "percent";
                    setDiscountKind(k);
                    if (k === "none") setDiscountValue(null);
                  }}
                  disabled={pending}
                  aria-label="Tipo de descuento"
                  className={cn(FIELD_BOX, "h-8 px-2")}
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
                    aria-label="Valor del descuento"
                    disabled={pending}
                    className={cn(FIELD_BOX, "h-8 w-24 px-2 tabular-nums")}
                  />
                )}
              </div>
              {discountAmount > 0 && (
                <div className="mt-2 space-y-0.5 text-[13px] tabular-nums text-ink-600">
                  <div className="flex justify-between">
                    <span>Subtotal</span>
                    <span>
                      {currency} {subtotal.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
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
              <div className="mt-2 flex justify-between border-t border-line-strong pt-2 text-sm font-semibold tabular-nums text-ink-900">
                <span>Total</span>
                <span>
                  {currency} {total.toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          {/* Entrega */}
          <div className={cn(CARD_ZONE, "mt-4 space-y-3 sm:mt-5")}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Cliente" value={name} onChange={setName} disabled={pending} placeholder="Nombre" />
              <PeruMobileField value={phone} onChange={setPhone} disabled={pending} problem={phoneProblem} />
            </div>
            <Field label="Dirección *" value={address1} onChange={setAddress1} disabled={pending} placeholder="Av. / Calle y número" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Distrito *" value={district} onChange={setDistrict} disabled={pending} placeholder="Distrito de entrega" />
              <div className="min-w-0">
                <label htmlFor={provinceId} className={LABEL}>Provincia / Región</label>
                <select
                  id={provinceId}
                  value={province}
                  onChange={(e) => setProvince(e.currentTarget.value)}
                  className={cn(FIELD, "mt-1")}
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
              <label htmlFor={noteId} className={LABEL}>Notas del pedido</label>
              <textarea
                id={noteId}
                value={orderNote}
                onChange={(e) => setOrderNote(e.currentTarget.value)}
                rows={2}
                placeholder="Ej: enviar con Alexis (opcional)"
                className={cn(FIELD_BOX, "mt-1 w-full px-3 py-2")}
                disabled={pending}
              />
              <p className="mt-1 text-xs text-ink-500">
                Se guarda en las Notas del pedido en{" "}
                {platform === "woocommerce" ? "WooCommerce" : platform === "shopify" ? "Shopify" : "la tienda"} (no se envía al cliente).
              </p>
            </div>
          </div>

          {/* Confirmación y creación */}
          <div className={cn(CARD_ZONE, "mt-4 space-y-3 sm:mt-5")}>
            <div>
              <label className="flex items-center gap-2 text-sm text-ink-900">
                <input
                  type="checkbox"
                  className={CHECKBOX}
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
                    aria-label="Mensaje de confirmación"
                    className={cn(FIELD_BOX, "mt-2 w-full px-3 py-2")}
                    disabled={pending}
                  />
                )
              ) : (
                <p className="mt-1 text-xs text-ink-500">
                  Ventana de 24h cerrada — no se puede enviar texto libre (se necesitaría una plantilla).
                </p>
              )}
            </div>

            {!generatedOrder && (
              <p className="text-xs leading-5 text-ink-500">
                Pago contraentrega: queda como <span className="font-medium text-ink-700">pago pendiente</span> y sube
                como pedido real a {platform === "woocommerce" ? "WooCommerce" : platform === "shopify" ? "Shopify" : "la tienda"}. Marca el lead <span className="font-medium text-ink-700">Ganado</span> y suma
                a tu productividad.
              </p>
            )}

            {generatedOrder && (
              <div className="space-y-3">
                <Banner tone="ok" role="status" title="Pedido generado correctamente">
                  <p className="mt-0.5 font-medium text-ink-900">{generatedOrder.name || generatedOrder.id || msg}</p>
                  <p className="tabular-nums">
                    {generatedOrder.currency} {generatedOrder.total.toFixed(2)}
                    {generatedOrder.confirmationSent ? " · confirmación enviada por WhatsApp" : " · sin confirmación por WhatsApp"}
                  </p>
                </Banner>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <OpsButton size="sm" onClick={copyGeneratedOrder}>
                    <IconCopy aria-hidden className="text-ink-500" />
                    {copyLabel(copiedOrder, "Copiar pedido")}
                  </OpsButton>
                  {generatedOrder.adminUrl && (
                    <a
                      href={generatedOrder.adminUrl}
                      target="_blank"
                      rel="noreferrer"
                      className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11")}
                    >
                      {generatedOrder.platform === "woocommerce" ? "Ver en WooCommerce" : "Ver en Shopify"}
                      <IconArrowUpRight aria-hidden className="text-ink-500" />
                    </a>
                  )}
                  {/* La única salida del formulario. Antes, tras generar el pedido
                      solo quedaban "Copiar" y "Ver en Shopify": el formulario se
                      quedaba abierto tapando la columna entera, y el panel para
                      crear la guía de Aliclik —que está justo debajo— era
                      inalcanzable sin recargar la página. */}
                  <OpsButton variant="primary" size="sm" onClick={onClose}>
                    Continuar · crear guía
                  </OpsButton>
                </div>
              </div>
            )}

            {!generatedOrder && duplicateWarning && (
              <Banner tone="warn" role="alert">
                <p>{duplicateWarning}</p>
                {/* Los botones dentro de un aviso son secundarios (DESIGN.md). */}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <OpsButton size="sm" onClick={() => submit(true)} disabled={pending || !valid}>
                    {pending ? "Generando..." : "Sí, crear otro pedido"}
                  </OpsButton>
                  <OpsButton variant="ghost" size="sm" onClick={() => setDuplicateWarning(null)} disabled={pending}>
                    No, revisar primero
                  </OpsButton>
                </div>
              </Banner>
            )}

            {!generatedOrder && !duplicateWarning && (
              <div className="flex flex-wrap items-center gap-2">
                <OpsButton variant="primary" onClick={() => submit()} disabled={pending || !valid}>
                  {pending ? "Generando..." : "Generar pedido"}
                </OpsButton>
                <OpsButton variant="ghost" onClick={onClose} disabled={pending}>
                  Cancelar
                </OpsButton>
                {msg && <span role="alert" className="text-[13px] text-crit-fg">{msg}</span>}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * El celular del cliente, con el `+51` fuera del campo y los 9 dígitos dentro.
 *
 * POR QUÉ ASÍ. El campo era libre, y unos 9 dígitos sueltos acababan en Shopify
 * como `+988805509` —sin código de país—, que Shopify rechaza; el pedido se
 * creaba SIN teléfono y el aviso no lo mencionaba. Con el prefijo fuera del
 * input no hay forma de olvidarlo ni de escribirlo dos veces.
 *
 * Y la máscara `XXX-XXX-XXX` no es decoración: en una tira de nueve cifras
 * seguidas nadie ve que falta una; partida en tres grupos, salta a la vista.
 *
 * El estado guarda lo formateado y `peruMobileDigits` lo desnuda cuando hace
 * falta, así que da igual si alguien pega `+51 988 805 509` o `51988805509`.
 */
function PeruMobileField({
  value,
  onChange,
  disabled,
  problem,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  problem: string | null;
}) {
  const id = useId();
  // Solo se avisa de lo que ya se escribió: gritarle "faltan 9 dígitos" a un
  // campo vacío que nadie ha tocado es ruido, no ayuda.
  const showProblem = Boolean(problem) && peruMobileDigits(value).length > 0;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={LABEL}>Teléfono *</label>
      {/* El anillo va en el marco y no en el campo: el `+51` queda dentro. */}
      <div className="mt-1 flex h-9 items-stretch overflow-hidden rounded-md bg-white shadow-control ring-1 ring-inset ring-line-strong transition-shadow focus-within:ring-2 focus-within:ring-brand-500 pointer-coarse:h-11">
        <span className="flex select-none items-center border-r border-line px-2.5 text-[13px] font-medium text-ink-500">
          +51
        </span>
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(formatPeruMobile(e.currentTarget.value))}
          // `tel` saca el teclado numérico en el móvil, que es donde más se usa.
          type="tel"
          inputMode="numeric"
          placeholder="988-805-509"
          // El foco lo dibuja el marco; el contorno global iría alrededor del campo solo.
          style={{ outline: "none" }}
          className="h-full w-full min-w-0 bg-transparent px-2.5 text-sm tabular-nums text-ink-900 placeholder:text-ink-500 disabled:text-ink-500"
          disabled={disabled}
          aria-invalid={showProblem}
          aria-describedby={showProblem ? `${id}-problema` : undefined}
        />
      </div>
      {showProblem && <p id={`${id}-problema`} className="mt-1 text-xs text-crit-fg">{problem}</p>}
    </div>
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
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={LABEL}>{label}</label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className={cn(FIELD, "mt-1")}
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
      sku: v.sku ?? null,
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
      try {
        const r = await searchStoreProducts(leadId, term);
        if (alive) {
          setResults(r);
          setOpenProd(null); // nueva búsqueda → colapsa cualquier producto expandido
        }
      } catch {
        if (alive) setResults(null);
      } finally {
        if (alive) setSearching(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, leadId]);
  return (
    <div className="rounded-md bg-wash p-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="Buscar producto…"
            aria-label="Buscar producto"
            className={cn(FIELD_BOX, "h-8 w-full pl-8 pr-3")}
          />
        </div>
        <OpsButton variant="ghost" size="sm" onClick={onClose}>
          Cerrar
        </OpsButton>
      </div>
      {searching && <p className="mt-2 text-xs text-ink-500">Buscando…</p>}
      {results && results.length === 0 && !searching && (
        <p className="mt-2 text-xs text-ink-500">Sin resultados (o falta el permiso read_products).</p>
      )}
      {results && results.length > 0 && (
        <ul className="mt-2 max-h-56 overflow-y-auto overscroll-contain">
          {results.map((p) => {
            const single = p.variants.length === 1; // sin variantes reales → se agrega directo
            const expanded = openProd === p.productId;
            const totalStock = p.variants.reduce((s, v) => s + (v.inventory ?? 0), 0);
            return (
              <li key={p.productId}>
                <button
                  type="button"
                  onClick={() => (single ? pick(p, p.variants[0]!) : setOpenProd(expanded ? null : p.productId))}
                  aria-expanded={single ? undefined : expanded}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white"
                >
                  {!single &&
                    (expanded ? (
                      <IconChevronDown aria-hidden className="size-4 shrink-0 text-ink-500" />
                    ) : (
                      <IconChevronRight aria-hidden className="size-4 shrink-0 text-ink-500" />
                    ))}
                  <span className="min-w-0 flex-1 text-sm text-ink-900">{p.title}</span>
                  {single ? (
                    <>
                      <span className={cn("text-xs tabular-nums", (p.variants[0]!.inventory ?? 0) > 0 ? "text-ink-500" : "text-warn-fg")}>
                        {p.variants[0]!.inventory != null ? `stock ${p.variants[0]!.inventory}` : ""}
                      </span>
                      <span className="text-sm font-medium tabular-nums text-ink-900">
                        {currency} {(p.variants[0]!.price ?? 0).toFixed(2)}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs tabular-nums text-ink-500">
                      {p.variants.length} variantes{totalStock > 0 ? ` · stock ${totalStock}` : ""}
                    </span>
                  )}
                </button>
                {expanded && !single && (
                  <ul className="mb-1 ml-4 border-l border-line-strong pl-2">
                    {p.variants.map((v) => (
                      <li key={v.variantId}>
                        <button
                          type="button"
                          onClick={() => pick(p, v)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white"
                        >
                          <span className="min-w-0 flex-1 text-sm text-ink-700">{v.variantTitle || "Estándar"}</span>
                          <span className={cn("text-xs tabular-nums", (v.inventory ?? 0) > 0 ? "text-ink-500" : "text-warn-fg")}>
                            {v.inventory != null ? `stock ${v.inventory}` : ""}
                          </span>
                          <span className="text-sm font-medium tabular-nums text-ink-900">
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

/**
 * El resultado de la llamada: los estados más usados como chips y el resto en
 * «Otro estado» (registerCall acepta cualquier estado válido, así que no se
 * pierde ninguno), la fecha del próximo seguimiento y una nota.
 *
 * `variant="panel"` (la ficha): tarjeta propia con su título. `variant="card"`
 * (la tarjeta del siguiente lead): sin marco ni título —los pone quien la
 * monta—, los chips en una fila y debajo, en otra, la fecha, la nota de una
 * línea y el botón. La conducta es la misma en las dos.
 */
export function CallForm({
  leadId,
  onRegistered,
  submitLabel = "Guardar resultado",
  variant = "panel",
  footer,
}: {
  leadId: string;
  onRegistered: (update?: LeadDrawerUpdate) => void;
  submitLabel?: string;
  variant?: "panel" | "card";
  /** Solo en la tarjeta: lo que va bajo el botón de guardar («Abrir ficha», «Saltar»). */
  footer?: ReactNode;
}) {
  const [state, action, pending] = useActionState<LeadActionState, FormData>(registerCall, {});
  const [status, setStatus] = useState("");
  const headingId = useId();
  useEffect(() => {
    if (state.notice || state.error) finishUiMeasure("kapso:call-save");
    if (state.notice) {
      onRegistered({ savedCall: state.savedCall, leadPatch: state.leadPatch });
      setStatus("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  // Disposiciones más usadas como chips; el resto en el <select> "Otro estado"
  // (registerCall acepta cualquier estado válido, así que no se pierde ninguno).
  const CHIPS: [string, string][] = [
    ["casi_cierra", "Casi cierra"],
    ["no_responde", "No contestó"],
    ["volver_a_llamar", "Volver a llamar"],
    ["contactado_dejo_wsp", "Contactado"],
    ["buzon", "Buzón"],
    ["sin_stock", "Sin stock"],
  ];
  const chipKeys = new Set(CHIPS.map(([k]) => k));
  // El desplegable lista TODOS los estados (los de los chips primero, con su
  // etiqueta canónica) y muestra siempre el seleccionado, así chips y desplegable
  // quedan sincronizados en ambos sentidos.
  const STATUS_OPTIONS = [
    ...CHIPS.map(([code]) => ({ code, label: labelOf(code) })),
    ...MANUAL_STATUSES.filter((s) => !chipKeys.has(s.code)).map((s) => ({ code: s.code, label: s.label })),
  ];
  const card = variant === "card";
  const chips = CHIPS.map(([k, label]) => {
    const on = status === k;
    return <ChoiceChip key={k} label={label} active={on} onClick={() => setStatus(on ? "" : k)} />;
  });
  const options = STATUS_OPTIONS.map((s) => (
    <option key={s.code} value={s.code}>
      {s.label}
    </option>
  ));
  const autoHint = (status === "casi_cierra" || status === "volver_a_llamar") && (
    <p className="text-xs leading-5 text-ink-500">
      Sin fecha se agenda solo: <span className="font-medium text-ink-700">hoy 18:00</span> (si aún no son las
      16:00) o <span className="font-medium text-ink-700">mañana 10:00</span>. Lo verás en la vista Seguimientos a
      esa hora.
    </p>
  );
  const feedback = (state.error || state.notice) && (
    <div className="min-w-0 text-[13px]">
      {state.error && <p role="alert" className="text-crit-fg">{state.error}</p>}
      {state.notice && <p role="status" className="text-ok-fg">{state.notice}</p>}
    </div>
  );
  const fields = (
    <>
      <input type="hidden" name="lead_id" value={leadId} />
      <input type="hidden" name="status" value={status} />
    </>
  );

  if (card) {
    // La columna del medio de la tarjeta del siguiente lead (DESIGN.md › Leads):
    // registrar la gestión de arriba abajo, con «Guardar y siguiente» al pie.
    return (
      <form action={action} onSubmit={() => startUiMeasure("kapso:call-save")} className="flex flex-1 flex-col gap-4">
        {fields}
        <div className="space-y-2">
          <div role="group" aria-label="Resultado" className="grid grid-cols-2 gap-1.5 @xs:grid-cols-3">
            {CHIPS.map(([k, label]) => {
              const on = status === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setStatus(on ? "" : k)}
                  className={cn(choiceChipClass(on), "w-full justify-center")}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {/* «Otro estado» con el aspecto del chip: encendido solo cuando lo
              elegido no es uno de los chips. */}
          <select
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value)}
            className={cn(choiceChipClass(status !== "" && !chipKeys.has(status)), "w-full cursor-pointer")}
            aria-label="Estado de la llamada"
          >
            <option value="">Otro estado</option>
            {options}
          </select>
        </div>
        <label className="block min-w-0">
          <span className="mb-1 block text-xs text-ink-600">Próximo seguimiento</span>
          <input name="next_followup_at" type="datetime-local" className={cn(FIELD_BOX, "h-9 w-full px-3 tabular-nums")} />
        </label>
        {autoHint}
        <label className="block min-w-0">
          <span className="mb-1 block text-xs text-ink-600">Nota</span>
          <textarea
            name="note"
            rows={3}
            placeholder="Lo que te dijo, qué quedó pendiente…"
            className={cn(FIELD_BOX, "w-full resize-none px-3 py-2 leading-5")}
          />
        </label>
        <div className="mt-auto space-y-2 pt-1">
          {feedback}
          <OpsButton type="submit" variant="primary" size="lg" className="w-full" disabled={pending}>
            {pending ? "Guardando…" : submitLabel}
          </OpsButton>
          {footer}
        </div>
      </form>
    );
  }

  return (
    <section aria-labelledby={headingId} className={SECTION_CARD}>
      <h3 id={headingId} className="text-sm font-semibold text-ink-900">Resultado de la llamada</h3>
      <form action={action} onSubmit={() => startUiMeasure("kapso:call-save")} className="mt-3 space-y-3">
        {fields}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{chips}</div>
        <div className="grid grid-cols-1 gap-x-2 gap-y-3 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className={LABEL}>Otro estado</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.currentTarget.value)}
              className={cn(FIELD, "mt-1")}
              aria-label="Estado de la llamada"
            >
              <option value="">Mantener estado</option>
              {options}
            </select>
          </label>
          <label className="block min-w-0">
            <span className={LABEL}>Próximo seguimiento</span>
            <input
              name="next_followup_at"
              type="datetime-local"
              aria-label="Reprogramar seguimiento"
              className={cn(FIELD, "mt-1 tabular-nums")}
            />
          </label>
        </div>
        <textarea
          name="note"
          rows={2}
          placeholder="Nota rápida…"
          aria-label="Nota"
          className={cn(FIELD_BOX, "min-h-16 w-full px-3 py-2 leading-5")}
        />
        {autoHint}
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <div className="mr-auto">{feedback}</div>
          <OpsButton type="submit" variant="primary" disabled={pending}>
            {pending ? "Guardando…" : submitLabel}
          </OpsButton>
        </div>
      </form>
    </section>
  );
}
