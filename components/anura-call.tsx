"use client";

// «Llamar con Anura» (fase 1, Click2Dial) en la ficha del pedido. No hay
// teléfono en el navegador: Kapta pide la llamada y Anura hace sonar el
// teléfono de Anura de la asesora (la terminal principal de su anexo); cuando
// ella contesta, Anura marca a la clienta. La ficha solo sigue el estado con
// un sondeo corto mientras la llamada está viva, y se detiene al terminar.
//
// Como «Llamar desde Kapta» (MOM §8.5): la llamada es un HECHO. Al terminar
// queda en el historial del pedido («Llamada con Anura»), y el resultado se
// sigue registrando en la mesa de confirmación (§6.1): el aviso y la tarjeta
// llevan hasta ella. El aviso solo lo ofrece si la llamada dejó su hecho y es
// de este pedido: la ficha retoma la llamada viva de quien mira aunque sea de
// otro pedido, y entonces enlaza a ese.
//
// FRONTERA. Del servidor solo se importan las acciones (`"use server"`) y
// TIPOS. Nada de `lib/anura/server`, `lib/anura/calls` ni `lib/db` en valor:
// romperían el bundle del cliente (lo vigila `test/anura-ui.test.ts`).

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getAnuraCallStatus, getAnuraOrderCalls, startAnuraCall } from "@/app/dashboard/pedidos/anura-actions";
import type { AnuraCallLive, AnuraOrderCall, AnuraOrderPanel } from "@/lib/anura/server";
import { ANURA_POLL_INTERVAL_MS, ANURA_STATUS_HINT, ANURA_STATUS_LABEL } from "@/lib/anura/events";
import { ANURA_MAX_POLL_FAILURES, anuraEndedFollowUp, anuraEndedLine, anuraRecordingNote, anuraStartErrorTitle } from "@/lib/anura/ui";
import { masterOrderHref } from "@/lib/order-drawer-href";
import { formatTalkTime } from "@/lib/browser-call";
import { IconPhone } from "@/components/icons";
import { OpsButton } from "@/components/ops-ui";
import { cn } from "@/components/ui";

/** El selector de la mesa de confirmación en la ficha (order-drawer). */
const CONFIRMATION_DESK = '[data-drawer-section="confirmacion"]';

const MAX_POLL_FAILURES = ANURA_MAX_POLL_FAILURES;

/**
 * El hecho del historial se escribe justo después del estado final: si el
 * sondeo ve el final antes, la ficha recarga otra vez pasado este tiempo.
 */
const ENDED_RELOAD_AGAIN_MS = 3_000;

/**
 * Lo que la ficha necesita de Anura: si sale el botón y las llamadas del
 * pedido (con su grabación). Se pide cuando la ficha ya cargó, para no
 * adelantarse a ella en la cola de acciones del servidor. Sin Anura (sin
 * token, sin la 0310, sin anexo) responde vacío y la ficha sigue igual.
 */
export function useAnuraOrderPanel(orderId: string, ready: boolean) {
  const [panel, setPanel] = useState<AnuraOrderPanel | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const n = ++seq.current;
    try {
      const next = await getAnuraOrderCalls(orderId);
      if (n === seq.current) setPanel(next);
    } catch {
      // Una falla de Anura no tumba la ficha: sin panel no sale el botón.
    }
  }, [orderId]);

  useEffect(() => {
    setPanel(null);
    seq.current++;
  }, [orderId]);

  useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);

  return { panel, reload };
}

interface StartError {
  title: string;
  text: string;
}

function talkSecondsSince(iso: string | null, now: number): number {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : 0;
}

export function AnuraCallButton({
  orderId,
  extension,
  resume,
  onEnded,
  onGoToDesk,
}: {
  orderId: string;
  /** El anexo de quien mira (para decirlo en el aviso). */
  extension: string | null;
  /** La llamada viva de quien mira, para retomar el sondeo al abrir la ficha. */
  resume: AnuraCallLive | null;
  /** Al terminar una llamada, para recargar el historial y la tarjeta. */
  onEnded: () => void;
  /** Lleva a la mesa de confirmación (cambia de pestaña si hace falta). */
  onGoToDesk: () => void;
}) {
  const [call, setCall] = useState<AnuraCallLive | null>(null);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<StartError | null>(null);
  const [pollTrouble, setPollTrouble] = useState(false);
  const [hasDesk, setHasDesk] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const failures = useRef(0);
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Al abrir la ficha con una llamada viva (de este u otro pedido), se retoma.
  const resumedId = useRef<string | null>(null);
  useEffect(() => {
    if (!resume?.active || resumedId.current === resume.id) return;
    resumedId.current = resume.id;
    setCall((prev) => prev ?? resume);
    setOpen(true);
  }, [resume]);

  const callId = call?.id ?? null;
  const active = call?.active ?? false;

  // El sondeo: cada 2,5 s mientras la llamada está viva; se detiene al terminar
  // o al cerrar la ficha. Cada sondeo también suelta en el servidor la llamada
  // que Anura nunca avisó (60 s).
  useEffect(() => {
    if (!callId || !active) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const res = await getAnuraCallStatus(callId);
        if (stopped) return;
        if (!res.ok) {
          setPollTrouble(true);
          return;
        }
        failures.current = 0;
        setPollTrouble(false);
        setCall(res.call);
        if (!res.call.active) {
          setHasDesk(Boolean(document.querySelector(CONFIRMATION_DESK)));
          onEndedRef.current();
          // Este efecto se limpia ahora (la llamada ya no está viva): la segunda
          // recarga depende solo de que la ficha siga abierta.
          window.setTimeout(() => {
            if (mounted.current) onEndedRef.current();
          }, ENDED_RELOAD_AGAIN_MS);
          return;
        }
      } catch {
        if (stopped) return;
        failures.current += 1;
        if (failures.current >= MAX_POLL_FAILURES) {
          setPollTrouble(true);
          return;
        }
      }
      timer = window.setTimeout(() => void tick(), ANURA_POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(() => void tick(), ANURA_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [callId, active]);

  // El reloj, solo mientras se habla.
  const talking = call?.status === "en_curso";
  useEffect(() => {
    if (!talking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [talking]);

  async function start() {
    if (call?.active) {
      setOpen(true);
      return;
    }
    setStarting(true);
    setOpen(true);
    setError(null);
    setPollTrouble(false);
    failures.current = 0;
    try {
      const res = await startAnuraCall(orderId);
      if (res.ok) {
        setCall({
          id: res.callId,
          mode: "pedido",
          orderId,
          inHistory: false,
          status: "solicitada",
          statusLabel: ANURA_STATUS_LABEL.solicitada,
          hint: ANURA_STATUS_HINT.solicitada ?? null,
          active: true,
          extension: res.extension,
          toMasked: res.toMasked,
          billSeconds: null,
          failureReason: null,
          requestedAt: new Date().toISOString(),
          answeredAt: null,
          endedAt: null,
          recordingStatus: "sin_grabacion",
        });
        return;
      }
      setError({ title: anuraStartErrorTitle(res.code), text: res.error });
      // Ya hay una viva, o Anura no respondió y puede que llame igual: se sigue
      // esa en vez de dejar a la asesora a ciegas.
      if (res.activeCallId) {
        const status = await getAnuraCallStatus(res.activeCallId).catch(() => null);
        if (status?.ok) setCall(status.call);
        else setCall(null);
      } else {
        setCall(null);
      }
    } catch (e) {
      setError({ title: "No se pudo llamar", text: (e as Error).message || "Vuelve a intentar." });
      setCall(null);
    } finally {
      setStarting(false);
    }
  }

  const ended = call && !call.active ? call : null;
  const failed = ended?.status === "fallida";
  // Lo que se ofrece al terminar depende de si dejó su hecho y de qué pedido es.
  const followUp = ended ? anuraEndedFollowUp(ended, orderId) : { inHistory: false, otherOrderId: null };
  const otherOrder = call?.mode === "pedido" && call.orderId && call.orderId !== orderId ? call.orderId : null;
  const tone =
    call?.status === "en_curso" || ended?.status === "contestada"
      ? "text-ok-fg"
      : failed || (error && !call)
        ? "text-crit-fg"
        : "text-ink-500";
  const statusLabel = starting ? "Pidiendo la llamada…" : call ? call.statusLabel : error ? "No se pudo llamar" : "";

  const card = open ? (
    <div
      role="status"
      aria-live="polite"
      // La ficha se cierra al tocar su fondo, y este aviso cuelga de ella en el
      // árbol de React aunque se pinte fuera: el toque no tiene que llegarle.
      onClick={(e) => e.stopPropagation()}
      className="fixed bottom-4 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-lg bg-white p-4 shadow-pop"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-500">Llamada con Anura</p>
          <p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-ink-900">
            {call?.toMasked || "Cliente del pedido"}
          </p>
          {(call?.extension ?? extension) && (
            <p className="mt-0.5 text-xs text-ink-500">Anexo {call?.extension ?? extension}</p>
          )}
        </div>
        {statusLabel && (
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs font-medium", tone)}>
            <span
              aria-hidden
              className={cn("size-2 rounded-full bg-current", (starting || call?.status === "solicitada" || call?.status === "sonando") && "animate-pulse")}
            />
            {statusLabel}
          </span>
        )}
      </div>

      {talking && call && (
        <p className="mt-3 text-2xl font-semibold tabular-nums text-ink-900">{formatTalkTime(talkSecondsSince(call.answeredAt, now))}</p>
      )}

      {call?.active && call.hint && <p className="mt-2 text-xs text-ink-600">{call.hint}</p>}
      {call?.active && (
        <p className="mt-1 text-xs text-ink-600">Para colgar, cuelga en tu teléfono de Anura. Puedes ocultar este aviso: la llamada sigue.</p>
      )}

      {error && (
        <div className="mt-3 text-sm">
          <p className="font-medium text-crit-fg">{error.title}</p>
          <p className="mt-0.5 text-ink-700">{error.text}</p>
        </div>
      )}

      {pollTrouble && call?.active && (
        <p className="mt-3 text-xs text-warn-fg">
          Kapta dejó de recibir el estado de la llamada. La llamada sigue en Anura; al terminar, recarga la ficha para verla en el historial.
        </p>
      )}

      {ended && (
        <div className="mt-3 text-sm text-ink-700">
          <p className={cn("font-medium", failed ? "text-crit-fg" : "text-ink-900")}>{anuraEndedLine(ended)}</p>
          {followUp.inHistory && (
            <p className="mt-1 text-xs text-ink-600">Queda en el historial del pedido. El resultado se registra en la confirmación.</p>
          )}
        </div>
      )}

      {otherOrder && (
        <p className="mt-3 text-xs text-ink-600">
          Esta llamada es de otro pedido: queda en su historial y su resultado se registra en su confirmación.{" "}
          <a href={masterOrderHref(otherOrder)} className="font-medium text-brand-700 hover:underline">
            Abrir ese pedido
          </a>
        </p>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {ended && followUp.inHistory && hasDesk && (
          <OpsButton
            size="sm"
            variant="primary"
            onClick={() => {
              onGoToDesk();
              setOpen(false);
            }}
          >
            Registrar el resultado
          </OpsButton>
        )}
        <OpsButton size="sm" onClick={() => setOpen(false)}>
          {call?.active ? "Ocultar" : "Cerrar"}
        </OpsButton>
      </div>
    </div>
  ) : null;

  return (
    <>
      <OpsButton
        size="sm"
        onClick={() => void start()}
        disabled={starting}
        title={
          call?.active
            ? "Ver la llamada con Anura en curso"
            : "Llamar con Anura: suena tu teléfono de Anura y, al contestar, Anura marca a la clienta"
        }
        aria-label={call?.active ? "Ver la llamada con Anura en curso" : "Llamar al cliente con Anura"}
        className="pointer-coarse:h-11 pointer-coarse:min-w-11"
      >
        <IconPhone aria-hidden className={call?.active ? "text-ok-fg" : "text-ink-500"} />
        <span className="hidden sm:inline">{call?.active ? "Llamada en curso" : "Llamar con Anura"}</span>
      </OpsButton>
      {card && typeof document !== "undefined" ? createPortal(card, document.body) : null}
    </>
  );
}

/**
 * Lo que la entrada «Llamada con Anura» del historial lleva debajo de su nota:
 * la grabación (URL firmada de 5 minutos) o por qué no la hay, y el paso a la
 * mesa de confirmación. La nota misma (quién, número enmascarado, anexo, si
 * contestó, cuánto se habló) ya viene del servidor.
 */
export function AnuraCallHistoryDetail({
  call,
  onReload,
  onGoToDesk,
}: {
  call: AnuraOrderCall | null;
  /** Vuelve a pedir las llamadas (nuevo enlace firmado). */
  onReload: () => void;
  /** Sin mesa de confirmación en esta etapa, no se ofrece. */
  onGoToDesk?: () => void;
}) {
  const [expired, setExpired] = useState(false);
  const url = call?.recordingUrl ?? null;
  useEffect(() => setExpired(false), [url]);
  if (!call) return null;
  const note = anuraRecordingNote(call.recordingStatus, Boolean(url), call.answered);
  return (
    <div className="mt-2 max-w-[68ch] space-y-2">
      {url && !expired ? (
        <audio
          controls
          preload="none"
          src={url}
          onError={() => setExpired(true)}
          className="h-9 w-full max-w-sm"
          aria-label="Grabación de la llamada con Anura"
        />
      ) : url && expired ? (
        <p className="text-[13px] leading-5 text-ink-500">
          El enlace de la grabación venció (dura 5 minutos).{" "}
          <button type="button" onClick={onReload} className="font-medium text-brand-700 hover:underline">
            Pedir otro
          </button>
        </p>
      ) : note ? (
        <p className="text-[13px] leading-5 text-ink-500">{note}</p>
      ) : null}
      {/* Una entrada del historial siempre tiene su hecho, también un fin con fallo. */}
      {onGoToDesk && (
        <button type="button" onClick={onGoToDesk} className="text-[13px] font-medium text-brand-700 hover:underline">
          Registrar el resultado en la confirmación
        </button>
      )}
    </div>
  );
}
