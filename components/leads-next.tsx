"use client";

// El siguiente lead de cada vendedora (DESIGN.md › Leads, MOM §11 › «El
// siguiente lead de cada vendedora»). Arriba de «Sin llamar», a lo ancho: el
// lead que le toca llamar ahora, ya reservado para ella, con lo que pidió, el
// chat y el resultado de la llamada. Nunca el mismo a dos vendedoras: aparecer
// aquí es tomarlo con la reserva de siempre (claimLead, 10 minutos), que cuenta
// como una de sus dos.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LeadRow } from "@/lib/types";
import {
  isClaimCapError,
  leadCanCall,
  leadHandle,
  leadHook,
  leadPhoneLabel,
  leadQueueBucket,
  leadWindowInfo,
  categoryOf,
  labelOf,
  pickNextLead,
  type QueueBucket,
} from "@/lib/leads";
import { leadUrgency } from "@/lib/lead-urgency";
import { claimLead, releaseLead } from "@/app/dashboard/leads/actions";
import type { LeadDrawerUpdate } from "@/components/leads-drawer";
import { Badge, Banner, OpsButton, Skeleton, opsButtonClass, type BadgeTone } from "@/components/ops-ui";
import { IconPhone, IconWhatsApp } from "@/components/icons";

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
    <Badge tone="neutral">
      {SEGMENT_LABEL[seg]}
      {cartValue > 0 && <span className="ml-1 font-semibold tabular-nums text-ink-900">S/ {Math.round(cartValue)}</span>}
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

function soles(value: number): string {
  return `S/\u00a0${value.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Qué pidió, en una línea: el carrito, el producto que miraba, o con qué llegó. */
function askedText(lead: LeadRow, product: string | null): string | null {
  const cart = (lead.cart_summary ?? "").trim();
  if (cart) {
    const parts = [lead.draft_order_name?.trim() ? `Carrito ${lead.draft_order_name.trim()}` : "Carrito", cart];
    if (Number(lead.cart_value ?? 0) > 0) parts.push(soles(Number(lead.cart_value)));
    return parts.join(" · ");
  }
  if (product) return `Miraba ${product}`;
  const hook = leadHook(lead);
  if (!hook) return null;
  return hook.kind === "anuncio" ? `Llegó por el anuncio «${hook.text}»` : `«${hook.text}»`;
}

function addressText(lead: LeadRow): string | null {
  const place = [lead.district, lead.province ?? lead.region].map((v) => v?.trim()).filter(Boolean);
  const parts = [lead.address1?.trim(), place.length ? [...new Set(place)].join(", ") : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function NextLeadCard({
  state,
  now,
  product,
  adName,
  storeName,
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
  onOpen: (lead: LeadRow) => void;
  onRegistered: (leadId: string, update?: LeadDrawerUpdate) => void;
  /** Lo que «Más filtros» tiene puesto: también decide qué lead se reserva. */
  filters?: string[];
  onClearFilters?: () => void;
}) {
  const { lead, problem } = state;
  // «Más filtros» vive en la cabecera de la cola, debajo de esta tarjeta; lo
  // que tenga puesto decide qué lead se reserva, así que se dice aquí también.
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

  const urgency = leadUrgency(lead.first_seen_at, now);
  const { state: win } = leadWindowInfo(lead.last_inbound_at ?? lead.last_interaction_at, now);
  const asked = askedText(lead, product);
  const address = addressText(lead);
  const botNote = (lead.handoff_context ?? "").trim();
  const firstMessage = (lead.first_inbound_text ?? "").trim();
  const via = adName ? `por «${adName}»` : lead.source && SOURCE_WORD[lead.source] ? `por ${SOURCE_WORD[lead.source]}` : null;
  const ageTone: BadgeTone = urgency?.tier === "dorada" ? "ok" : "neutral";

  return (
    <section aria-labelledby="siguiente-lead" className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,440px)]">
        <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 id="siguiente-lead" className="min-w-0 truncate text-xl font-semibold leading-7 text-ink-900">
                {lead.name || leadHandle(lead)}
              </h2>
              {storeName && <span className="text-xs font-medium text-ink-500">{storeName}</span>}
              <SegmentBadge lead={lead} />
              {urgency && (
                <Badge tone={ageTone}>
                  {urgency.tier === "dorada" ? `Hora dorada · quedan ${urgency.minutesLeft}\u00a0min` : `Entró hace ${urgency.label}`}
                </Badge>
              )}
              {(win === "por_vencer" || win === "critica") && <Badge tone="warn">Ventana por vencer</Badge>}
              {win === "cerrada" && <Badge tone="crit">Sin ventana de 24 h</Badge>}
            </div>
            <p className="mt-0.5 text-[13px] text-ink-500">
              {leadPhoneLabel(lead)}
              {urgency && <>{" · "}entró hace {urgency.tier === "dorada" ? `${Math.round(urgency.ageMinutes)}\u00a0min` : urgency.label}</>}
              {via && <> {via}</>}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-500">
              <Badge tone="info" title="Se renueva sola mientras tengas Leads abierto; si cierras la pestaña, se suelta.">
                Reservado para ti
              </Badge>
              Las demás vendedoras ven otro lead. Si lo saltas, vuelve a la cola.
            </p>
            {filterNote && <p className="mt-1">{filterNote}</p>}
          </div>

          {(asked || address || botNote || firstMessage) && (
            <dl className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
              {asked && (
                <>
                  <dt className="text-ink-500">Lo que pidió</dt>
                  <dd className="min-w-0 text-ink-900">{asked}</dd>
                </>
              )}
              {address && (
                <>
                  <dt className="text-ink-500">Entrega</dt>
                  <dd className="min-w-0 text-ink-900">{address}</dd>
                </>
              )}
              {botNote ? (
                <>
                  <dt className="text-ink-500">Resumen del bot</dt>
                  <dd className="line-clamp-3 min-w-0 text-ink-700">{botNote}</dd>
                </>
              ) : (
                firstMessage &&
                !asked?.includes(firstMessage) && (
                  <>
                    <dt className="text-ink-500">Primer mensaje</dt>
                    <dd className="line-clamp-2 min-w-0 text-ink-700">«{firstMessage}»</dd>
                  </>
                )
              )}
            </dl>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/* Sin número no se ofrece llamar: un `tel:` vacío abre el marcador
                en blanco. A esos se les escribe desde el chat (BSUID). */}
            {leadCanCall(lead) && (
              <>
                <a href={`tel:+${lead.phone}`} className={opsButtonClass("primary", "lg")}>
                  <IconPhone />
                  Llamar
                </a>
                <a href={`https://wa.me/${lead.phone}`} target="_blank" rel="noreferrer" className={opsButtonClass("secondary", "lg")}>
                  <IconWhatsApp />
                  WhatsApp
                </a>
              </>
            )}
            <OpsButton size="lg" onClick={() => onOpen(lead)}>
              Abrir ficha
            </OpsButton>
            <OpsButton size="lg" variant="ghost" onClick={state.skip}>
              Saltar
            </OpsButton>
          </div>

          <div className="border-t border-line pt-4">
            <h3 className="mb-2 text-xs font-semibold text-ink-600">Resultado de la llamada</h3>
            <NextCallForm
              key={lead.id}
              leadId={lead.id}
              variant="card"
              submitLabel="Guardar y siguiente"
              onRegistered={(update) => onRegistered(lead.id, update)}
            />
          </div>
        </div>
        <div className="flex min-w-0 flex-col border-t border-line bg-wash p-4 sm:p-5 lg:border-t-0 lg:shadow-[inset_1px_0_0_var(--color-line)]">
          <NextChat
            key={lead.id}
            leadId={lead.id}
            lastInboundAt={lead.last_inbound_at}
            hasConversation={!!(lead.kapso_conversation_id || lead.phone)}
            onSent={(update) => onRegistered(lead.id, update)}
            variant="card"
          />
        </div>
      </div>
    </section>
  );
}
