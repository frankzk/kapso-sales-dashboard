"use client";

// El siguiente lead de cada vendedora (DESIGN.md › Leads, MOM §11 › «El
// siguiente lead de cada vendedora»). Arriba de «Sin llamar», a lo ancho: el
// lead que le toca llamar ahora, ya reservado para ella, en tres columnas —el
// cliente y lo que pregunta, registrar la gestión, y el chat—. Nunca el mismo a
// dos vendedoras: aparecer aquí es tomarlo con la reserva de siempre
// (claimLead, 10 minutos), que cuenta como una de sus dos.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LeadCallRow, LeadRow } from "@/lib/types";
import {
  dayTimeLabel,
  isClaimCapError,
  leadCanCall,
  leadHook,
  leadPhoneLabel,
  leadQueueBucket,
  leadWindowInfo,
  categoryOf,
  labelOf,
  pickNextLead,
  usableAddress,
  type CartLine,
  type QueueBucket,
} from "@/lib/leads";
import { LEAD_COVERAGES, type LeadCoverage } from "@/lib/lead-coverage";
import { leadUrgency } from "@/lib/lead-urgency";
import type { CustomerHistory } from "@/lib/leads-access";
import { claimLead, releaseLead, type NextLeadCart } from "@/app/dashboard/leads/actions";
// Las lecturas van por /api/leads/read, como las de la ficha: fuera de la cola
// de Server Actions, que pondría la foto detrás de un guardado.
import { loadLeadCustomerHistory, loadLeadDeliveryCoverage, loadLeadDetail, loadNextLeadCart } from "@/lib/leads-read-client";
import type { LeadDrawerUpdate } from "@/components/leads-drawer";
import { useCopyToClipboard } from "@/components/copy-button";
import { Badge, Banner, OpsButton, Skeleton, type BadgeTone } from "@/components/ops-ui";
import { SEGMENT_TONE } from "@/components/lead-segment-tone";
import { CoverageBadge } from "@/components/coverage-badge";
import type { OrderCoverage } from "@/lib/order-coverage";
import { IconCheck, IconCopy, IconMapPin, IconPhone, IconWhatsApp } from "@/components/icons";
import { cartsTone, cartsVerdict } from "@/lib/customer-carts";

// El chat y el resultado son los de la ficha, cargados aparte: la cola no paga
// su peso en el primer pintado (test/leads-bundle.test.ts).
const NextChat = dynamic(() => import("@/components/leads-drawer").then((m) => m.WhatsappChat), {
  ssr: false,
  loading: () => <ChatLoading />,
});
const NextCallForm = dynamic(() => import("@/components/leads-drawer").then((m) => m.CallForm), {
  ssr: false,
  loading: () => <Skeleton className="h-24 w-full" />,
});

function ChatLoading() {
  return (
    <div className="flex flex-col gap-2 p-4" aria-hidden>
      <Skeleton className="h-10 w-3/4" />
      <Skeleton className="ml-auto h-10 w-2/3" />
      <Skeleton className="h-10 w-1/2" />
    </div>
  );
}

// ── La chapa del segmento (la comparte la fila de la cola) ──────────────────

/** Etiqueta del balde en la fila: la misma palabra que el chip que lo filtra. */
export const SEGMENT_LABEL: Record<QueueBucket, string> = {
  carrito: "Con carrito",
  distrito: "Dio distrito",
  producto: "Vio producto",
  converso: "Conversó",
  frio: "Frío",
};

/** Calificación del lead: su balde (con el monto del carrito) o, si ya se cerró,
 *  Ganado / Perdido. El motivo exacto va en el título. */
export function SegmentBadge({ lead }: { lead: LeadRow }) {
  const cat = categoryOf(lead.status);
  if (cat === "won" || cat === "lost") {
    return (
      <Badge tone={cat === "won" ? "ok" : "neutral"} title={labelOf(lead.status)}>
        {cat === "won" ? "Ganado" : "Perdido"}
      </Badge>
    );
  }
  const seg = leadQueueBucket(lead);
  // El monto va en la chapa: con la cola por prioridad, entre dos carritos el
  // ticket es lo que decide a cuál llamar primero.
  const cartValue = seg === "carrito" ? Number(lead.cart_value ?? 0) : 0;
  return (
    <Badge tone={SEGMENT_TONE[seg]}>
      {SEGMENT_LABEL[seg]}
      {cartValue > 0 && <span className="ml-1 font-semibold tabular-nums text-orange-950">S/ {Math.round(cartValue)}</span>}
    </Badge>
  );
}

// ── La reserva ──────────────────────────────────────────────────────────────

/** Cada cuánto se renueva la reserva mientras la pestaña se ve (el TTL es de 10). */
const RENEW_MS = 4 * 60_000;
/** Un lead que el servidor dijo que tiene otra no se vuelve a pedir en este rato. */
const TAKEN_RETRY_MS = 2 * 60_000;
/** Intentos seguidos contra leads que ya tenía otra antes de dejar de insistir. */
const MAX_TAKEN_STREAK = 5;
/** Saltados de esta pestaña: sobreviven a un F5, no a cerrarla. */
const SKIP_KEY = "kapso:leads:siguiente-saltados";

function readSkipped(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SKIP_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSkipped(ids: Set<string>) {
  try {
    sessionStorage.setItem(SKIP_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    /* sin almacenamiento, los saltados duran lo que la página */
  }
}

export type NextLeadProblem = { kind: "blocked" | "error"; message: string };

export interface NextLeadState {
  /** El lead reservado para ella, o null mientras se busca / si no hay. */
  lead: LeadRow | null;
  /** Buscando y reservando el siguiente. */
  searching: boolean;
  /** Nadie libre en lo que está mirando. */
  empty: boolean;
  problem: NextLeadProblem | null;
  heldId: string | null;
  skip: () => void;
  /** Suelta el siguiente (abrir otro lead de la cola lo pide ANTES de reservar el otro). */
  release: () => Promise<void>;
  retry: () => void;
}

/**
 * La reserva del siguiente. `queue` es la cola tal como la mira (filtrada y
 * ordenada); `drawerLeadId`, el lead de la ficha abierta. Con una ficha abierta
 * no se reserva nada nuevo, y si es de otro lead, el siguiente se suelta.
 */
export function useNextLead({
  enabled,
  queue,
  userId,
  drawerLeadId,
}: {
  enabled: boolean;
  queue: LeadRow[];
  userId: string;
  drawerLeadId: string | null;
}): NextLeadState {
  const [heldId, setHeldId] = useState<string | null>(null);
  const heldRef = useRef<string | null>(null);
  const [problem, setProblem] = useState<NextLeadProblem | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [taken, setTaken] = useState<Map<string, number>>(() => new Map());
  const [tick, setTick] = useState(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    setSkipped(readSkipped());
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const hold = useCallback((id: string | null) => {
    heldRef.current = id;
    setHeldId(id);
  }, []);

  const release = useCallback(async () => {
    const id = heldRef.current;
    if (!id) return;
    hold(null);
    await releaseLead(id).catch(() => undefined);
  }, [hold]);

  const excluded = useMemo(() => {
    const ids = new Set(skipped);
    const now = Date.now();
    for (const [id, at] of taken) if (now - at < TAKEN_RETRY_MS) ids.add(id);
    return ids;
    // `tick` vuelve a mirar los vencidos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipped, taken, tick]);

  const candidate = useMemo(
    () => (enabled ? pickNextLead(queue, { userId, current: heldId, skipped: excluded }) : null),
    [enabled, queue, userId, heldId, excluded],
  );

  // Una ficha de OTRO lead abierta, o la tarjeta apagada: el siguiente se suelta.
  useEffect(() => {
    if (heldRef.current && (!enabled || (drawerLeadId && drawerLeadId !== heldRef.current))) void release();
  }, [enabled, drawerLeadId, release]);

  // Al cerrar una ficha se libera una de las dos: el aviso del tope puede irse.
  useEffect(() => {
    if (!drawerLeadId) setProblem((p) => (p?.kind === "blocked" ? null : p));
  }, [drawerLeadId]);

  // Reservar el siguiente.
  useEffect(() => {
    if (!enabled || drawerLeadId || problem || inFlight.current) return;
    if (!candidate) {
      // El que tenía ya no sirve (se gestionó, se lo llevaron) y no hay otro.
      if (heldRef.current) void release();
      return;
    }
    if (candidate.id === heldRef.current) return;
    const target = candidate.id;
    inFlight.current = true;
    void (async () => {
      try {
        const previous = heldRef.current;
        if (previous) {
          hold(null);
          await releaseLead(previous).catch(() => undefined);
        }
        const res = await claimLead(target).catch(() => null);
        if (!mounted.current) {
          if (res && !res.error) void releaseLead(target);
          return;
        }
        if (!res) {
          setProblem({ kind: "error", message: "No se pudo reservar tu siguiente lead. Revisa la conexión." });
          return;
        }
        if (res.error) {
          if (isClaimCapError(res.error)) setProblem({ kind: "blocked", message: res.error });
          else if (res.error.startsWith("Sin acceso")) setProblem({ kind: "error", message: res.error });
          // «X está atendiendo este lead»: la lista venía atrasada; al siguiente.
          // Si pasa muchas veces seguidas no se insiste: una racha así es la
          // lista muy atrasada, y cada intento es una vuelta al servidor.
          else {
            const recent = [...taken.values()].filter((at) => Date.now() - at < TAKEN_RETRY_MS).length;
            if (recent >= MAX_TAKEN_STREAK) {
              setProblem({ kind: "error", message: "Varias vendedoras están tomando leads a la vez. Reintenta en un momento." });
            }
            setTaken((m) => new Map(m).set(target, Date.now()));
          }
          return;
        }
        hold(target);
      } finally {
        inFlight.current = false;
        setTick((t) => t + 1);
      }
    })();
  }, [enabled, drawerLeadId, problem, candidate, hold, release, tick, taken]);

  // Renovar mientras la pestaña se ve; al volver a ella, al instante. Si en el
  // rato oculta otra se la llevó (pasaron los 10 minutos), pasa al siguiente.
  useEffect(() => {
    if (!heldId) return;
    const renew = async () => {
      if (document.hidden) return;
      const id = heldRef.current;
      if (!id) return;
      const res = await claimLead(id).catch(() => null);
      if (!res || !res.error || heldRef.current !== id) return;
      hold(null);
      if (isClaimCapError(res.error)) setProblem({ kind: "blocked", message: res.error });
      else setTaken((m) => new Map(m).set(id, Date.now()));
    };
    const timer = setInterval(() => void renew(), RENEW_MS);
    const onVisible = () => {
      if (!document.hidden) void renew();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [heldId, hold]);

  // Cerrar o recargar la pestaña la suelta (el mismo beacon que la ficha).
  useEffect(() => {
    const onPageHide = () => {
      const leadId = heldRef.current;
      if (!leadId) return;
      navigator.sendBeacon?.(
        "/api/leads/release-claim",
        new Blob([JSON.stringify({ leadId })], { type: "application/json" }),
      );
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // Salir de Leads (otra página del panel) también.
  useEffect(
    () => () => {
      const leadId = heldRef.current;
      if (leadId) void releaseLead(leadId).catch(() => undefined);
    },
    [],
  );

  const skip = useCallback(() => {
    const id = heldRef.current;
    if (!id) return;
    setSkipped((s) => {
      const next = new Set(s).add(id);
      writeSkipped(next);
      return next;
    });
    void release();
  }, [release]);

  const retry = useCallback(() => {
    setProblem(null);
    setTaken(new Map());
  }, []);

  const lead = candidate && candidate.id === heldId ? candidate : null;
  return {
    lead,
    searching: enabled && !lead && !!candidate && !problem && !drawerLeadId,
    empty: enabled && !candidate && !problem,
    problem,
    heldId,
    skip,
    release,
    retry,
  };
}

// ── La tarjeta ──────────────────────────────────────────────────────────────

const SOURCE_WORD: Record<string, string> = {
  meta_ad: "una campaña",
  fb_web: "un enlace de Meta",
  cod_cart: "el formulario de carrito",
  abandoned_browse: "una búsqueda en la web",
};

/** «Llegó por»: de dónde vino, con nombre propio cuando lo hay. */
const SOURCE_LABEL: Record<string, string> = {
  meta_ad: "Campaña",
  fb_web: "Enlace de Meta",
  cod_cart: "Formulario de carrito",
  abandoned_browse: "Búsqueda en la web",
};

function soles(value: number): string {
  return `S/ ${value.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function units(n: number): string {
  return `${n} ${n === 1 ? "unidad" : "unidades"}`;
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "numeric", month: "short" }).replace(/\.$/, "");
}

type Loaded<T> = T | "loading" | "error";

interface NextLeadContext {
  cart: Loaded<NextLeadCart>;
  history: Loaded<CustomerHistory | null>;
  calls: Loaded<LeadCallRow[]>;
  /** La cobertura del Master para su dirección (`order_coverage_for`). */
  delivery: Loaded<{ coverage: OrderCoverage | null }>;
}

const LOADING: NextLeadContext = { cart: "loading", history: "loading", calls: "loading", delivery: "loading" };

/**
 * Lo que la fila de la cola no trae: el carrito con cantidades y su foto, los
 * pedidos de antes (Shopify, puede tardar unos segundos) y las llamadas. Cada
 * pieza llega por su lado y se pinta cuando llega; la tarjeta se usa desde el
 * primer momento.
 */
function useNextLeadContext(leadId: string | null): NextLeadContext {
  const [state, setState] = useState<{ id: string | null } & NextLeadContext>({ id: null, ...LOADING });
  useEffect(() => {
    if (!leadId) return;
    let alive = true;
    const put = (patch: Partial<NextLeadContext>) => {
      if (!alive) return;
      setState((s) => ({ ...(s.id === leadId ? s : LOADING), id: leadId, ...patch }));
    };
    loadNextLeadCart(leadId).then(
      (r) => put({ cart: "error" in r ? "error" : r }),
      () => put({ cart: "error" }),
    );
    loadLeadDetail(leadId).then(
      (r) => put({ calls: "error" in r ? "error" : r.calls }),
      () => put({ calls: "error" }),
    );
    loadLeadCustomerHistory(leadId).then(
      (r) => put({ history: "error" in r ? "error" : r.customerHistory }),
      () => put({ history: "error" }),
    );
    loadLeadDeliveryCoverage(leadId).then(
      (r) => put({ delivery: "error" in r ? "error" : r }),
      () => put({ delivery: "error" }),
    );
    return () => {
      alive = false;
    };
  }, [leadId]);
  return state.id === leadId ? state : LOADING;
}

/** Lo que pide, para la cabeza de la columna del cliente. */
function askedOf(
  lead: LeadRow,
  product: string | null,
  lines: CartLine[],
): { label: string; lines: { title: string; quantity: number | null }[]; detail: string | null } | null {
  const summary = (lead.cart_summary ?? "").trim();
  if (lines.length || summary) {
    const items = lines.length ? lines : [{ title: summary, quantity: null }];
    const single = items.length === 1 ? items[0] : null;
    const detail = [
      single?.quantity ? units(single.quantity) : null,
      Number(lead.cart_value ?? 0) > 0 ? soles(Number(lead.cart_value)) : null,
      lead.source === "cod_cart" ? "contra entrega" : null,
      lead.draft_order_name?.trim() ? `carrito ${lead.draft_order_name.trim()}` : null,
    ].filter(Boolean);
    return { label: "Lo que pidió", lines: items, detail: detail.length ? detail.join(" · ") : null };
  }
  if (product) return { label: "Lo que miraba", lines: [{ title: product, quantity: null }], detail: null };
  const hook = leadHook(lead);
  if (!hook) return null;
  return hook.kind === "anuncio"
    ? { label: "Llegó por el anuncio", lines: [{ title: hook.text, quantity: null }], detail: null }
    : { label: "Lo que escribió", lines: [{ title: `«${hook.text}»`, quantity: null }], detail: null };
}

/** Lo que la cobertura le dice a la vendedora, en el título de la chapa. */
const COVERAGE_HINT: Record<OrderCoverage, string> = {
  lima: "Cobertura del Master para esta dirección: llega a domicilio y paga al recibir.",
  provincia_cod: "Cobertura del Master para esta dirección: llega a domicilio y paga al recibir.",
  agencia: "Cobertura del Master para esta dirección: va por agencia y se separa con adelanto.",
  por_revisar: "La cobertura está por revisar: confirma el distrito en la llamada.",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-xs font-medium text-ink-500">{label}</dt>
      <dd className="min-w-0 text-[13px] leading-5 text-ink-900">{children}</dd>
    </>
  );
}

const QUIET_ICON =
  "grid size-8 shrink-0 place-items-center rounded-md text-ink-500 ring-1 ring-inset ring-line-strong transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:size-11";

/** Copiar, llamar y escribir: siguen a mano pero callados; hoy se llama desde el celular. */
function ContactIcons({ lead }: { lead: LeadRow }) {
  const { state: copy, copy: copyText } = useCopyToClipboard();
  if (!leadCanCall(lead)) return null;
  const phone = lead.phone!.trim();
  const copyLabel = copy === "ok" ? "Número copiado" : copy === "fail" ? "No se pudo copiar" : "Copiar número";
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button type="button" onClick={() => copyText(`+${phone}`)} title={copyLabel} aria-label={copyLabel} className={QUIET_ICON}>
        {copy === "ok" ? <IconCheck className="size-4 text-ok-fg" /> : <IconCopy className="size-4" />}
      </button>
      <a href={`tel:+${phone}`} title="Llamar" aria-label="Llamar" className={QUIET_ICON}>
        <IconPhone className="size-4" />
      </a>
      <a href={`https://wa.me/${phone}`} target="_blank" rel="noreferrer" title="Abrir WhatsApp" aria-label="Abrir WhatsApp" className={QUIET_ICON}>
        <IconWhatsApp className="size-4" />
      </a>
    </span>
  );
}

const CART_VERDICT_TONE: Record<ReturnType<typeof cartsTone>, string> = {
  warn: "text-warn-fg",
  ok: "text-ok-fg",
  neutral: "text-ink-700",
};

/**
 * ¿Termina la compra o solo deja carritos? (25-10-2026, lib/customer-carts.ts):
 * cuántos carritos dejó antes en esta tienda y cuántos terminaron en pedido.
 * La lista entera está en la ficha.
 */
function PriorCarts({ history }: { history: Loaded<CustomerHistory | null> }) {
  if (history === "loading") return <span className="text-ink-500">Buscando carritos…</span>;
  if (history === "error" || !history || history.carts === null) {
    return <span className="text-ink-500">No se pudo consultar ahora.</span>;
  }
  const summary = history.carts?.summary;
  if (!summary?.total) return <span className="text-ink-700">Ninguno: es su primer carrito</span>;
  return (
    <p>
      <span className="font-medium tabular-nums">
        {summary.total} {summary.total === 1 ? "carrito" : "carritos"}
      </span>
      <span className={`font-medium ${CART_VERDICT_TONE[cartsTone(summary)]}`}> · {cartsVerdict(summary)}</span>
    </p>
  );
}

function PriorOrders({ history }: { history: Loaded<CustomerHistory | null> }) {
  // Busca en la base, en el historial de Shopify importado (MOM §37.7) y en Shopify;
  // los pedidos de WooCommerce salen de la base (MOM §38.12).
  if (history === "loading") return <span className="text-ink-500">Buscando pedidos…</span>;
  if (history === "error") return <span className="text-ink-500">No se pudo consultar ahora.</span>;
  const count = Math.max(history?.orderCount ?? 0, history?.recentOrders.length ?? 0);
  if (!history || count === 0) return <span className="text-ink-700">Ninguno: es cliente nuevo</span>;
  return (
    <div className="space-y-1">
      <p>
        <span className="font-medium">
          {count} {count === 1 ? "pedido" : "pedidos"}
        </span>
        {history.lastProduct && <span className="text-ink-500"> · el último, {history.lastProduct}</span>}
      </p>
      {history.recentOrders.length > 0 && (
        <ul className="space-y-0.5 text-xs tabular-nums text-ink-600">
          {history.recentOrders.map((o, i) => (
            <li key={o.name ?? i} className="flex gap-3">
              {o.adminUrl ? (
                <a href={o.adminUrl} target="_blank" rel="noopener noreferrer" className="w-20 shrink-0 font-medium text-ink-700 hover:text-brand-700 hover:underline">
                  {o.name ?? "Pedido"}
                </a>
              ) : (
                <span className="w-20 shrink-0 font-medium text-ink-700">{o.name ?? "Pedido"}</span>
              )}
              <span className="w-12 shrink-0">{shortDate(o.createdAt) ?? "—"}</span>
              <span className={o.cancelled ? "text-ink-500 line-through decoration-ink-300" : undefined}>{soles(o.amount)}</span>
              {o.cancelled && <Badge tone="crit">Anulado</Badge>}
              {o.fromHistory && <span className="text-ink-500">del historial de Shopify</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CallsLine({ calls, now }: { calls: Loaded<LeadCallRow[]>; now: number }) {
  if (calls === "loading") return <span className="text-ink-500">…</span>;
  if (calls === "error") return <span className="text-ink-500">No se pudo consultar ahora.</span>;
  const real = calls.filter((c) => c.kind === "call" || c.kind === "voice_agent");
  if (!real.length) return <span className="text-ink-700">Ninguna todavía</span>;
  const last = real[0]!;
  const parts = [
    dayTimeLabel(last.occurred_at, new Date(now)),
    last.vendedora_name,
    last.new_status ? labelOf(last.new_status) : null,
  ].filter(Boolean);
  return (
    <span>
      <span className="font-medium">{real.length}</span>
      {parts.length > 0 && <span className="text-ink-600"> · la última {parts.join(" · ")}</span>}
    </span>
  );
}

function ClientColumn({
  lead,
  now,
  product,
  adName,
  storeName,
  coverage,
  context,
  filterNote,
}: {
  lead: LeadRow;
  now: number;
  product: string | null;
  adName: string | null;
  storeName: string | null;
  coverage: LeadCoverage | null;
  context: NextLeadContext;
  filterNote: ReactNode;
}) {
  const urgency = leadUrgency(lead.first_seen_at, now);
  const { state: win } = leadWindowInfo(lead.last_inbound_at ?? lead.last_interaction_at, now);
  const name = lead.name?.trim() || null;
  const title = name ?? leadPhoneLabel(lead);
  const via = adName ? `por «${adName}»` : lead.source && SOURCE_WORD[lead.source] ? `por ${SOURCE_WORD[lead.source]}` : null;
  const age = urgency ? (urgency.tier === "dorada" ? `${Math.round(urgency.ageMinutes)} min` : urgency.label) : null;
  const meta = [storeName, name ? leadPhoneLabel(lead) : null, age ? `entró hace ${age}${via ? ` ${via}` : ""}` : via]
    .filter(Boolean)
    .join(" · ");

  const cart = typeof context.cart === "object" ? context.cart : null;
  const asked = askedOf(lead, product, cart?.lines ?? []);
  const waitingPhoto = context.cart === "loading" && !!lead.draft_order_gid;
  const botNote = (lead.handoff_context ?? "").trim();
  const firstMessage = (lead.first_inbound_text ?? "").trim();
  const showFirst = !botNote && !!firstMessage && !asked?.lines.some((l) => l.title.includes(firstMessage));
  const history = context.history;
  const recurrent = typeof history === "object" && !!history && (history.orderCount > 0 || history.recentOrders.length > 0);

  const street = usableAddress(lead.address1);
  const place = [...new Set([lead.district, lead.province ?? lead.region].map((v) => v?.trim()).filter(Boolean))].join(", ");
  // Con dirección, la cobertura del Master (Lima, Provincia COD o Agencia):
  // dice si paga al recibir o separa con adelanto. Sin ella, la pista de la
  // cola en minúscula, y solo cuando el lugar no la dice ya («Miraflores, Lima ·
  // lima»); mientras la del Master llega, nada, para que no cambie bajo la vista.
  const masterCoverage = typeof context.delivery === "object" ? context.delivery.coverage : null;
  const coverageLabel =
    !masterCoverage && context.delivery !== "loading" && coverage && coverage !== "sin_identificar"
      ? LEAD_COVERAGES.find((c) => c.key === coverage)?.label
      : null;
  const coverageWord = coverageLabel && !place.toLowerCase().includes(coverageLabel.toLowerCase()) ? coverageLabel.toLowerCase() : null;
  const delivery = [street, place || null, coverageWord].filter(Boolean).join(" · ");
  const inbound = Number(lead.inbound_count ?? 0);
  const arrived = [
    lead.source === "meta_ad" && adName ? `Campaña «${adName}»` : SOURCE_LABEL[lead.source ?? ""] ?? "WhatsApp",
    dayTimeLabel(lead.first_seen_at, new Date(now)),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-w-0 flex-col gap-5 p-4 sm:p-5">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="siguiente-lead" className="break-words text-xl font-semibold leading-7 text-ink-900 tabular-nums">
              {title}
            </h2>
            {meta && <p className="mt-0.5 text-[13px] text-ink-500">{meta}</p>}
          </div>
          <ContactIcons lead={lead} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SegmentBadge lead={lead} />
          {urgency?.tier === "dorada" && <Badge tone="ok">{`Hora dorada · quedan ${urgency.minutesLeft} min`}</Badge>}
          {(win === "por_vencer" || win === "critica") && <Badge tone="warn">Ventana por vencer</Badge>}
          {win === "cerrada" && <Badge tone="crit">Sin ventana de 24 h</Badge>}
          {recurrent && <Badge tone="brand">Cliente recurrente</Badge>}
          <Badge tone="info" title="Las demás vendedoras ven otro lead. Se renueva sola mientras tengas Leads abierto; si lo saltas o cierras la pestaña, vuelve a la cola.">
            Reservado para ti
          </Badge>
        </div>
        {filterNote && <p>{filterNote}</p>}
      </div>

      {asked && (
        <div className="flex gap-3.5">
          {cart?.photoUrl ? (
            // La foto del catálogo, ya en JPG desde /api/wa-image (mismo origen: la CSP no deja cargar el CDN de Shopify).
            <img
              src={cart.photoUrl}
              alt=""
              width={72}
              height={72}
              loading="lazy"
              className="size-[72px] shrink-0 rounded-md bg-wash object-cover ring-1 ring-line"
            />
          ) : waitingPhoto ? (
            <Skeleton className="size-[72px] shrink-0 rounded-md" />
          ) : null}
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-ink-500">{asked.label}</p>
            {asked.lines.map((l, i) => (
              <p key={i} className="text-sm font-semibold leading-5 text-ink-900">
                {l.title}
                {asked.lines.length > 1 && l.quantity && <span className="font-normal tabular-nums text-ink-500"> × {l.quantity}</span>}
              </p>
            ))}
            {asked.detail && <p className="text-[13px] tabular-nums text-ink-600">{asked.detail}</p>}
          </div>
        </div>
      )}

      {(botNote || showFirst) && (
        <div className="rounded-md bg-wash px-3 py-2.5">
          <p className="text-xs font-medium text-ink-500">{botNote ? "Lo que dijo al bot" : "Su primer mensaje"}</p>
          <p className="mt-0.5 line-clamp-4 text-[13px] leading-5 text-ink-900">{botNote || `«${firstMessage}»`}</p>
        </div>
      )}

      <dl className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-t border-line pt-4">
        <Row label="Pedidos antes">
          <PriorOrders history={history} />
        </Row>
        <Row label="Carritos antes">
          <PriorCarts history={history} />
        </Row>
        <Row label="Llamadas">
          <CallsLine calls={context.calls} now={now} />
        </Row>
        <Row label="WhatsApp">
          {inbound > 0 ? (
            <span>
              Escribió {inbound} {inbound === 1 ? "vez" : "veces"}
              {lead.last_inbound_at && <span className="text-ink-600"> · la última {dayTimeLabel(lead.last_inbound_at, new Date(now))}</span>}
            </span>
          ) : (
            <span className="text-ink-700">No ha escrito todavía</span>
          )}
        </Row>
        <Row label="Entrega">
          {masterCoverage ? (
            <span className="flex items-start gap-2" title={COVERAGE_HINT[masterCoverage]}>
              <CoverageBadge coverage={masterCoverage} />
              <span className="min-w-0">{delivery}</span>
            </span>
          ) : delivery ? (
            <span>{delivery}</span>
          ) : (
            <span className="text-ink-700">Sin datos todavía</span>
          )}
          {!street && (
            <span className="mt-0.5 flex items-center gap-1 text-xs text-warn-fg">
              <IconMapPin aria-hidden className="size-3.5 shrink-0" />
              Falta la dirección exacta: pídela en la llamada
            </span>
          )}
        </Row>
        <Row label="Llegó por">{arrived}</Row>
      </dl>
    </div>
  );
}

export function NextLeadCard({
  state,
  now,
  product,
  adName,
  storeName,
  coverage = null,
  onOpen,
  onRegistered,
  filters = [],
  onClearFilters,
}: {
  state: NextLeadState;
  now: number;
  /** Producto resuelto por la cola (`handleOf`), ya en palabras. */
  product: string | null;
  adName: string | null;
  /** Solo en la vista de varias tiendas. */
  storeName: string | null;
  /** La cobertura que la cola ya resolvió para este lead. */
  coverage?: LeadCoverage | null;
  onOpen: (lead: LeadRow) => void;
  onRegistered: (leadId: string, update?: LeadDrawerUpdate) => void;
  /** Lo que «Más filtros» tiene puesto: también decide qué lead se reserva. */
  filters?: string[];
  onClearFilters?: () => void;
}) {
  const { lead, problem } = state;
  const context = useNextLeadContext(lead?.id ?? null);
  // Lo que «Más filtros» tenga puesto decide qué lead se reserva, así que se
  // dice aquí también.
  const filterNote =
    filters.length > 0 ? (
      <span className="text-xs text-ink-500">
        Sale de la cola con <span className="font-medium text-ink-700">{filters.join(", ")}</span>
        {onClearFilters && (
          <>
            {" · "}
            <button type="button" onClick={onClearFilters} className="font-medium text-brand-700 hover:underline">
              Quitar
            </button>
          </>
        )}
      </span>
    ) : null;

  if (problem) {
    return (
      <Banner tone={problem.kind === "blocked" ? "warn" : "crit"} title={problem.kind === "blocked" ? "Tu siguiente lead está en pausa" : "No se pudo reservar tu siguiente lead"}>
        <span className="flex flex-wrap items-center justify-between gap-3">
          <span>{problem.message}</span>
          <OpsButton size="sm" onClick={state.retry}>
            Reintentar
          </OpsButton>
        </span>
      </Banner>
    );
  }

  if (!lead) {
    if (state.empty) {
      return (
        <p className="rounded-lg bg-white px-4 py-3 text-[13px] text-ink-600 shadow-control ring-1 ring-line">
          No queda nadie libre para reservarte en lo que estás mirando. Cambia el segmento o la cobertura, o revisa
          «En seguimiento».{filterNote && <> {filterNote}</>}
        </p>
      );
    }
    return (
      <section aria-label="Tu siguiente lead" aria-busy className="rounded-lg bg-white p-5 shadow-control ring-1 ring-line">
        <span className="sr-only">Reservando tu siguiente lead…</span>
        <Skeleton className="h-7 w-72" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        <Skeleton className="mt-5 h-10 w-80 max-w-full" />
      </section>
    );
  }

  const hasConversation = !!(lead.kapso_conversation_id || lead.phone);

  return (
    <section aria-labelledby="siguiente-lead" className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
      {/* Tres columnas desde 1280 px: el cliente y lo que pregunta, registrar la
          gestión, y el chat. Entre 1024 y 1280 el chat baja a lo ancho; en el
          teléfono, una sola columna. */}
      <div className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] xl:min-h-[28rem] xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.95fr)_minmax(320px,0.95fr)]">
        <ClientColumn
          lead={lead}
          now={now}
          product={product}
          adName={adName}
          storeName={storeName}
          coverage={coverage}
          context={context}
          filterNote={filterNote}
        />

        <div className="@container flex min-w-0 flex-col gap-3 border-t border-line p-4 sm:p-5 lg:border-t-0 lg:shadow-[inset_1px_0_0_var(--color-line)]">
          <h3 className="text-sm font-semibold text-ink-900">Registrar la gestión</h3>
          <NextCallForm
            key={lead.id}
            leadId={lead.id}
            variant="card"
            submitLabel="Guardar y siguiente"
            onRegistered={(update) => onRegistered(lead.id, update)}
            footer={
              <div className="flex items-center justify-between gap-2">
                <OpsButton size="sm" onClick={() => onOpen(lead)}>
                  Abrir ficha
                </OpsButton>
                <OpsButton size="sm" variant="ghost" onClick={state.skip}>
                  Saltar este lead
                </OpsButton>
              </div>
            }
          />
        </div>

        {/* El chat no decide el alto de la tarjeta: se desplaza dentro del que
            marcan las otras dos columnas. */}
        <div className="relative h-[30rem] min-w-0 border-t border-line bg-wash lg:col-span-2 xl:col-span-1 xl:h-auto xl:border-t-0 xl:shadow-[inset_1px_0_0_var(--color-line)]">
          <div className="absolute inset-0 flex flex-col p-4">
            {hasConversation ? (
              <NextChat
                key={lead.id}
                leadId={lead.id}
                lastInboundAt={lead.last_inbound_at}
                hasConversation={hasConversation}
                onSent={(update) => onRegistered(lead.id, update)}
                variant="card"
              />
            ) : (
              <p className="m-auto max-w-[32ch] text-center text-[13px] text-ink-500">
                Este lead no tiene conversación de WhatsApp. Llámalo, o escríbele desde la ficha cuando deje su número.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
