"use client";

// «Llamar con Anura» en la ficha del pedido (MOM §8.7). Dos maneras, según el
// anexo de quien mira (`panel.kaptaPhone.status`, `anuraPhoneModeOf`):
//
//   · FASE 1 (Click2Dial, `sin_telefono`). No hay teléfono en el navegador:
//     Kapta pide la llamada y Anura hace sonar el teléfono de Anura de la
//     asesora (la terminal principal de su anexo); cuando ella contesta, Anura
//     marca a la clienta.
//   · FASE 2 (`listo`): el teléfono vive DENTRO de Kapta y SOLO hace salidas.
//     El mismo botón pide el micrófono, conecta el teléfono de Kapta a Anura,
//     pide la llamada y contesta solo el aviso de su propio Click2Dial; luego
//     Anura marca a la clienta y la asesora habla con audífonos. Aquí sí se
//     puede colgar y silenciar. Al colgar, Kapta se desconecta de Anura.
//     Kapta no recibe llamadas: cualquier otro aviso se rechaza sin sonar.
//     `clave_rechazada` / `sin_dominio`: no se llama y se dice por qué.
//
// En las dos, la ficha sigue el estado con el mismo sondeo corto mientras la
// llamada está viva (lo que dice si la clienta contestó llega por ahí).
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
// romperían el bundle del cliente (lo vigila `test/anura-ui.test.ts`). JsSIP
// se carga con import dinámico solo al llamar (components/anura-phone.tsx).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getAnuraCallStatus,
  getAnuraOrderCalls,
  getAnuraPhone,
  reportAnuraPhoneRejected,
  startAnuraCall,
} from "@/app/dashboard/pedidos/anura-actions";
import type { AnuraCallLive, AnuraKaptaPhoneView, AnuraOrderCall, AnuraOrderPanel } from "@/lib/anura/server";
import { ANURA_POLL_INTERVAL_MS, ANURA_STATUS_HINT, ANURA_STATUS_LABEL } from "@/lib/anura/events";
import { ANURA_MAX_POLL_FAILURES, anuraEndedFollowUp, anuraEndedLine, anuraRecordingNote, anuraStartErrorTitle } from "@/lib/anura/ui";
import { ANURA_KAPTA_PHONE_TEXT } from "@/lib/anura/sip";
import {
  ANURA_PHONE_BLOCKED_TITLE,
  ANURA_RECORDING_MAX_RETRIES,
  anuraPhoneCanMute,
  anuraPhoneEndedLine,
  anuraPhoneErrorTitle,
  anuraPhoneHangUpLabel,
  anuraPhoneHint,
  anuraPhoneModeOf,
  anuraPhoneNeedsPanelReload,
  anuraPhoneOutlivesServer,
  anuraPhoneStatusLabel,
  anuraRecordingSrc,
  talkSecondsSince,
} from "@/lib/anura/phone-ui";
import { masterOrderHref } from "@/lib/order-drawer-href";
import { formatTalkTime } from "@/lib/browser-call";
import { AnuraPhoneAudio, useAnuraKaptaPhone, type AnuraPhoneServer } from "@/components/anura-phone";
import { IconMic, IconMicOff, IconPhone } from "@/components/icons";
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

/** La llamada recién pedida, hasta que el primer sondeo traiga la de verdad. */
function requestedCall(input: { id: string; orderId: string; extension: string | null; toMasked: string | null; hint: string | null }): AnuraCallLive {
  return {
    id: input.id,
    mode: "pedido",
    orderId: input.orderId,
    inHistory: false,
    status: "solicitada",
    statusLabel: ANURA_STATUS_LABEL.solicitada,
    hint: input.hint,
    active: true,
    extension: input.extension,
    toMasked: input.toMasked ?? "",
    billSeconds: null,
    failureReason: null,
    requestedAt: new Date().toISOString(),
    answeredAt: null,
    endedAt: null,
    recordingStatus: "sin_grabacion",
    closedByTimeout: false,
  };
}

const PULSING_PHASES = new Set(["credenciales", "microfono", "conectando", "pidiendo", "esperando_anura"]);

export function AnuraCallButton({
  orderId,
  extension,
  resume,
  kaptaPhone,
  onEnded,
  onPhoneChanged,
  onGoToDesk,
}: {
  orderId: string;
  /** El anexo de quien mira (para decirlo en el aviso). */
  extension: string | null;
  /** La llamada viva de quien mira, para retomar el sondeo al abrir la ficha. */
  resume: AnuraCallLive | null;
  /** ¿El anexo de quien mira tiene teléfono en Kapta? Sin esto, fase 1. */
  kaptaPhone?: AnuraKaptaPhoneView | null;
  /** Al terminar una llamada, para recargar el historial y la tarjeta. */
  onEnded: () => void;
  /** El teléfono del anexo cambió (p. ej. Anura rechazó la clave): recargar el panel. */
  onPhoneChanged?: () => void;
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
  // Esta llamada va con el teléfono de Kapta (la tarjeta trae Colgar y Silenciar).
  const [viaKapta, setViaKapta] = useState(false);
  const failures = useRef(0);
  const onEndedRef = useRef(onEnded);
  const onPhoneChangedRef = useRef(onPhoneChanged);
  useEffect(() => {
    onEndedRef.current = onEnded;
    onPhoneChangedRef.current = onPhoneChanged;
  }, [onEnded, onPhoneChanged]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const way = anuraPhoneModeOf(kaptaPhone);
  const server = useMemo<AnuraPhoneServer>(
    () => ({
      fetchCredentials: () => getAnuraPhone(orderId),
      requestCall: () => startAnuraCall(orderId),
      reportRejected: (input) => reportAnuraPhoneRejected(orderId, input),
    }),
    [orderId],
  );
  const phone = useAnuraKaptaPhone(server);
  const snap = phone.snapshot;

  // Al abrir la ficha con una llamada viva (de este u otro pedido), se retoma.
  const resumedId = useRef<string | null>(null);
  // Con el teléfono de Kapta en el anexo, se muestra con sus textos: no hay
  // «teléfono de Anura» donde colgar (se cuelga en la pestaña que la abrió).
  useEffect(() => {
    if (!resume?.active || resumedId.current === resume.id) return;
    resumedId.current = resume.id;
    setCall((prev) => prev ?? resume);
    setViaKapta(way !== "fase1");
    setOpen(true);
  }, [resume, way]);

  // El teléfono de Kapta ya tiene la llamada del servidor: empieza el sondeo.
  const phoneCallId = snap?.callId ?? null;
  const phoneToMasked = snap?.toMasked ?? null;
  const phoneExtension = snap?.extension ?? null;
  useEffect(() => {
    if (!phoneCallId) return;
    setCall((prev) =>
      prev?.id === phoneCallId ? prev : requestedCall({ id: phoneCallId, orderId, extension: phoneExtension, toMasked: phoneToMasked, hint: null }),
    );
  }, [phoneCallId, phoneToMasked, phoneExtension, orderId]);

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

  // Anura dio la llamada por terminada: el teléfono de Kapta cuelga y se
  // desconecta. Si la cerró solo el plazo del servidor (no llegó ningún aviso
  // de Anura) y Kapta ya está en la llamada, NO se corta: la asesora cuelga.
  const phoneBusy = phone.busy;
  const { hangUp } = phone;
  const outlives = anuraPhoneOutlivesServer(snap, call);
  useEffect(() => {
    if (callId && !active && phoneBusy && !outlives) hangUp();
  }, [callId, active, phoneBusy, outlives, hangUp]);

  // El reloj, solo mientras se habla (con el teléfono de Kapta, hasta colgar).
  const talking = call?.status === "en_curso" && !(viaKapta && snap?.phase === "terminada");
  useEffect(() => {
    if (!talking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [talking]);

  /** Sigue la llamada viva que devolvió el servidor (ya había una, o Anura no respondió). */
  async function follow(activeCallId: string | undefined) {
    if (!activeCallId) {
      setCall(null);
      return;
    }
    const status = await getAnuraCallStatus(activeCallId).catch(() => null);
    if (!mounted.current) return;
    if (status?.ok) setCall(status.call);
    else setCall(null);
  }

  /** Con el teléfono de Kapta: micrófono → conectar → pedir → contestar el aviso propio. */
  async function startWithKapta() {
    setViaKapta(true);
    setCall(null);
    const result = await phone.call();
    if (!mounted.current || result.phase !== "error" || !result.error) return;
    setError({ title: anuraPhoneErrorTitle(result.error), text: result.error.message });
    if (anuraPhoneNeedsPanelReload(result.error)) onPhoneChangedRef.current?.();
    if (result.error.start?.activeCallId) await follow(result.error.start.activeCallId);
  }

  async function start() {
    if (call?.active || phone.busy) {
      setOpen(true);
      return;
    }
    setOpen(true);
    setError(null);
    setPollTrouble(false);
    failures.current = 0;

    if (way === "bloqueado" && (kaptaPhone?.status === "clave_rechazada" || kaptaPhone?.status === "sin_dominio")) {
      // Con la «-websocket» como principal, la fase 1 haría sonar una terminal
      // sin conectar: no se intenta nada.
      setViaKapta(true);
      setCall(null);
      setError({ title: ANURA_PHONE_BLOCKED_TITLE[kaptaPhone.status], text: kaptaPhone.message ?? ANURA_KAPTA_PHONE_TEXT[kaptaPhone.status] });
      return;
    }
    if (way === "kapta") {
      await startWithKapta();
      return;
    }

    setViaKapta(false);
    setStarting(true);
    try {
      const res = await startAnuraCall(orderId);
      if (res.ok) {
        setCall(
          requestedCall({ id: res.callId, orderId, extension: res.extension, toMasked: res.toMasked, hint: ANURA_STATUS_HINT.solicitada ?? null }),
        );
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

  const ended = call && !call.active && !outlives ? call : null;
  const failed = ended?.status === "fallida";
  // Lo que se ofrece al terminar depende de si dejó su hecho y de qué pedido es.
  const followUp = ended ? anuraEndedFollowUp(ended, orderId) : { inHistory: false, otherOrderId: null };
  const otherOrder = call?.mode === "pedido" && call.orderId && call.orderId !== orderId ? call.orderId : null;
  const live = Boolean(call?.active) || phone.busy;
  const phoneFailed = viaKapta && snap?.phase === "error";
  const tone =
    call?.status === "en_curso" || ended?.status === "contestada"
      ? "text-ok-fg"
      : failed || (error && !call) || (phoneFailed && !call?.active)
        ? "text-crit-fg"
        : "text-ink-500";
  const statusLabel = viaKapta
    ? anuraPhoneStatusLabel(snap, call) || (error && !call ? "No se pudo llamar" : "")
    : starting
      ? "Pidiendo la llamada…"
      : call
        ? call.statusLabel
        : error
          ? "No se pudo llamar"
          : "";
  const pulsing = viaKapta
    ? (snap ? PULSING_PHASES.has(snap.phase) : false) || (snap?.phase === "en_llamada" && call?.status !== "en_curso")
    : starting || call?.status === "solicitada" || call?.status === "sonando";
  const hint = viaKapta ? (ended ? null : anuraPhoneHint(snap, call)) : call?.active ? call.hint : null;

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
          <p className="text-xs font-medium text-ink-500">{viaKapta ? "Llamada con Anura desde Kapta" : "Llamada con Anura"}</p>
          <p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-ink-900">
            {call?.toMasked || (viaKapta ? snap?.toMasked : null) || "Cliente del pedido"}
          </p>
          {(call?.extension ?? (viaKapta ? snap?.extension : null) ?? extension) && (
            <p className="mt-0.5 text-xs text-ink-500">Anexo {call?.extension ?? (viaKapta ? snap?.extension : null) ?? extension}</p>
          )}
        </div>
        {statusLabel && (
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs font-medium", tone)}>
            <span aria-hidden className={cn("size-2 rounded-full bg-current", pulsing && "animate-pulse")} />
            {statusLabel}
          </span>
        )}
      </div>

      {talking && call && (
        <p className="mt-3 text-2xl font-semibold tabular-nums text-ink-900">{formatTalkTime(talkSecondsSince(call.answeredAt, now))}</p>
      )}

      {hint && <p className="mt-2 text-xs text-ink-600">{hint}</p>}
      {!viaKapta && call?.active && (
        <p className="mt-1 text-xs text-ink-600">Para colgar, cuelga en tu teléfono de Anura. Puedes ocultar este aviso: la llamada sigue.</p>
      )}
      {viaKapta && phone.busy && (
        <p className="mt-1 text-xs text-ink-600">Si cierras la ficha o la pestaña, la llamada se corta. Puedes ocultar este aviso.</p>
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
          <p className={cn("font-medium", failed ? "text-crit-fg" : "text-ink-900")}>{viaKapta ? anuraPhoneEndedLine(ended) : anuraEndedLine(ended)}</p>
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
        {viaKapta && phone.busy && (
          <>
            {anuraPhoneCanMute(snap) && (
              <OpsButton size="sm" onClick={() => phone.setMuted(!snap?.muted)} aria-pressed={Boolean(snap?.muted)}>
                {snap?.muted ? <IconMicOff aria-hidden className="text-ink-500" /> : <IconMic aria-hidden className="text-ink-500" />}
                {snap?.muted ? "Activar micrófono" : "Silenciar"}
              </OpsButton>
            )}
            <OpsButton size="sm" variant="danger" onClick={() => phone.hangUp()}>
              <IconPhone aria-hidden />
              {anuraPhoneHangUpLabel(snap)}
            </OpsButton>
          </>
        )}
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
          {live ? "Ocultar" : "Cerrar"}
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
          live
            ? "Ver la llamada con Anura en curso"
            : way === "kapta"
              ? "Llamar con Anura desde Kapta: hablas con tus audífonos y Anura marca a la clienta"
              : way === "bloqueado"
                ? "Llamar con Anura desde Kapta: ahora no se puede; al tocar, Kapta dice por qué"
                : "Llamar con Anura: suena tu teléfono de Anura y, al contestar, Anura marca a la clienta"
        }
        aria-label={live ? "Ver la llamada con Anura en curso" : "Llamar al cliente con Anura"}
        className="pointer-coarse:h-11 pointer-coarse:min-w-11"
      >
        <IconPhone aria-hidden className={live ? "text-ok-fg" : "text-ink-500"} />
        <span className="hidden sm:inline">{live ? "Llamada en curso" : "Llamar con Anura"}</span>
      </OpsButton>
      {/* El audio de Anura (teléfono de Kapta). Fuera del aviso: existe antes de contestar. */}
      <AnuraPhoneAudio audioRef={phone.audioRef} />
      {card && typeof document !== "undefined" ? createPortal(card, document.body) : null}
    </>
  );
}

/**
 * Lo que la entrada «Llamada con Anura» del historial lleva debajo de su nota:
 * la grabación o por qué no la hay, y el paso a la mesa de confirmación. La
 * grabación se oye por una ruta del MISMO origen (`/api/anura/recordings/<id>`):
 * el servidor comprueba quién la pide y firma cada pedido, así que el enlace
 * no vence y la URL firmada de Storage nunca llega al navegador. La nota misma
 * (quién, número enmascarado, anexo, si contestó, cuánto se habló) ya viene
 * del servidor.
 */
export function AnuraCallHistoryDetail({
  call,
  onReload,
  onGoToDesk,
}: {
  call: AnuraOrderCall | null;
  /** Vuelve a pedir las llamadas (por si la grabación cambió de estado). */
  onReload: () => void;
  /** Sin mesa de confirmación en esta etapa, no se ofrece. */
  onGoToDesk?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const url = call?.recordingUrl ?? null;
  useEffect(() => {
    setAttempt(0);
    setLoadFailed(false);
  }, [url]);
  if (!call) return null;
  const note = anuraRecordingNote(call.recordingStatus, Boolean(url), call.answered);
  return (
    <div className="mt-2 max-w-[68ch] space-y-2">
      {url && !loadFailed ? (
        <audio
          key={attempt}
          controls
          preload="none"
          src={anuraRecordingSrc(url, attempt)}
          onError={() => setLoadFailed(true)}
          className="h-9 w-full max-w-sm"
          aria-label="Grabación de la llamada con Anura"
        />
      ) : url && loadFailed ? (
        <p className="text-[13px] leading-5 text-ink-500">
          No se pudo cargar la grabación. Si tu sesión venció, recarga la página.{" "}
          <button
            type="button"
            onClick={() => {
              const next = attempt + 1;
              setAttempt(next);
              setLoadFailed(false);
              if (next >= ANURA_RECORDING_MAX_RETRIES) onReload();
            }}
            className="font-medium text-brand-700 hover:underline"
          >
            Volver a cargar
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
