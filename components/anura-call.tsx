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
//     `clave_rechazada` / `dominio_no_reconocido` / `sin_dominio`: no se llama
//     y se dice por qué.
//
// En las dos, el estado llega con el mismo sondeo corto mientras la llamada
// está viva (lo que dice si la clienta contestó llega por ahí).
//
// La llamada del teléfono de Kapta NO vive en la ficha (07-11-2026): el
// teléfono es uno por pestaña, en el panel (`AnuraPhoneProvider`,
// components/anura-phone.tsx). Cerrar la ficha, abrir otro pedido o ir a otra
// pantalla no la corta; entonces la sigue la tarjeta global del panel. Si la
// ficha que se abre es la del pedido de esa llamada, la muestra ella (y la
// global se esconde). Con una llamada en marcha de otro pedido, «Llamar con
// Anura» no pide otra: la tarjeta global lo dice.
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
  releaseAnuraReservation,
  reportAnuraPhoneRejected,
  startAnuraCall,
} from "@/app/dashboard/pedidos/anura-actions";
import type { AnuraCallLive, AnuraKaptaPhoneView, AnuraOrderCall, AnuraOrderPanel } from "@/lib/anura/server";
import { ANURA_POLL_INTERVAL_MS, ANURA_STATUS_HINT } from "@/lib/anura/events";
import { ANURA_MAX_POLL_FAILURES, anuraEndedFollowUp, anuraEndedLine, anuraRecordingNote } from "@/lib/anura/ui";
import { ANURA_KAPTA_PHONE_TEXT } from "@/lib/anura/sip";
import { anuraFreeLinesLabel } from "@/lib/anura/pool";
import {
  ANURA_PHONE_BLOCKED_TITLE,
  ANURA_PHONE_KEEPS_GOING,
  ANURA_RECORDING_MAX_RETRIES,
  isAnuraPhoneBlocked,
  anuraFase1StartError,
  anuraPhoneCallIsFor,
  anuraPhoneCanMute,
  anuraPhoneEndedLine,
  anuraPhoneErrorTitle,
  anuraPhoneHangUpLabel,
  anuraPhoneHint,
  anuraPhoneModeOf,
  anuraPhoneNeedsPanelReload,
  anuraPhoneOutlivesServer,
  anuraPhoneStartDecision,
  anuraPhoneStatusLabel,
  anuraRecordingSrc,
  anuraRequestedCall,
  anuraTalkClock,
  talkSecondsFrom,
} from "@/lib/anura/phone-ui";
import { masterOrderHref } from "@/lib/order-drawer-href";
import { formatTalkTime } from "@/lib/browser-call";
import { AnuraVolumeControl, useAnuraKaptaPhone, useAnuraPhoneClaim, type AnuraPhoneServer } from "@/components/anura-phone";
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

/** La llamada recién pedida en la fase 1, hasta que el primer sondeo traiga la de verdad. */
function requestedCall(input: { id: string; orderId: string; extension: string | null; toMasked: string | null; hint: string | null }): AnuraCallLive {
  return anuraRequestedCall({ ...input, mode: "pedido" });
}

const PULSING_PHASES = new Set(["credenciales", "microfono", "conectando", "pidiendo", "esperando_anura"]);

export function AnuraCallButton({
  orderId,
  orderName,
  storeName,
  extension,
  resume,
  kaptaPhone,
  pool,
  onEnded,
  onPhoneChanged,
  onGoToDesk,
}: {
  orderId: string;
  /** «#KP123456»: lo dice la tarjeta global si se cierra la ficha durante la llamada. */
  orderName?: string | null;
  /** La tienda del pedido, para la misma tarjeta. */
  storeName?: string | null;
  /** El anexo de quien mira (para decirlo en el aviso). */
  extension: string | null;
  /** La llamada viva de quien mira, para retomar el sondeo al abrir la ficha. */
  resume: AnuraCallLive | null;
  /** ¿El anexo de quien mira tiene teléfono en Kapta? Sin esto, fase 1. */
  kaptaPhone?: AnuraKaptaPhoneView | null;
  /**
   * Sin anexo propio, con «Puede llamar con Anura»: las líneas compartidas
   * («2 de 3 líneas libres» al abrir la ficha). La línea se elige al llamar.
   */
  pool?: { total: number; free: number } | null;
  /** Al terminar una llamada, para recargar el historial y la tarjeta. */
  onEnded: () => void;
  /** El teléfono del anexo cambió (p. ej. Anura rechazó la clave): recargar el panel. */
  onPhoneChanged?: () => void;
  /** Lleva a la mesa de confirmación (cambia de pestaña si hace falta). */
  onGoToDesk: () => void;
}) {
  // La llamada que sigue ESTA ficha por su cuenta: la de la fase 1, o una viva
  // retomada al abrir (de otra pestaña o de antes de recargar).
  const [localCall, setLocalCall] = useState<AnuraCallLive | null>(null);
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
      requestCall: (input) => startAnuraCall(orderId, input?.reservationId ?? null),
      reportRejected: (input) => reportAnuraPhoneRejected(orderId, input),
      releaseReservation: (reservationId) => releaseAnuraReservation(reservationId),
    }),
    [orderId],
  );
  // El teléfono de Kapta es UNO por pestaña y vive en el panel
  // (`AnuraPhoneProvider`): cerrar la ficha ya no cuelga.
  const phone = useAnuraKaptaPhone();
  // La llamada del teléfono es de ESTE pedido: la ficha la muestra y la
  // tarjeta global se esconde mientras la ficha esté abierta.
  const owned = anuraPhoneCallIsFor(phone.session?.meta, { origin: "pedido", orderId }) ? phone.session : null;
  useAnuraPhoneClaim(owned?.seq ?? null);
  const snap = owned ? phone.snapshot : null;
  const phoneCallId = phone.snapshot?.callId ?? null;
  const kaptaBusy = owned !== null && phone.busy;

  // Al abrir la ficha del pedido que tiene la llamada en marcha (o que terminó
  // con la ficha cerrada), la tarjeta de la ficha la muestra.
  const ownedSeq = owned?.seq ?? null;
  const ownedShows = owned !== null && (phone.busy || owned.endedUnseen);
  useEffect(() => {
    if (ownedSeq === null || !ownedShows) return;
    setViaKapta(true);
    setOpen(true);
    // Solo al tomar la llamada: después manda lo que haga la asesora.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownedSeq]);

  // Al abrir la ficha con una llamada viva (de este u otro pedido), se retoma.
  // La que tiene el teléfono de esta pestaña no: esa la muestra la ficha de su
  // pedido o la tarjeta global.
  const resumedId = useRef<string | null>(null);
  // Con el teléfono de Kapta en el anexo, se muestra con sus textos: no hay
  // «teléfono de Anura» donde colgar (se cuelga en la pestaña que la abrió).
  useEffect(() => {
    if (!resume?.active || resumedId.current === resume.id || resume.id === phoneCallId) return;
    resumedId.current = resume.id;
    setLocalCall((prev) => prev ?? resume);
    setViaKapta(way !== "fase1");
    setOpen(true);
  }, [resume, way, phoneCallId]);

  // Lo que muestra la tarjeta: la llamada propia de la ficha, o la del
  // teléfono de Kapta si es de este pedido.
  const local = localCall && localCall.id !== phoneCallId ? localCall : null;
  const call = local ?? (viaKapta && owned && phoneCallId ? phone.serverCall : null);

  const callId = local?.id ?? null;
  const active = local?.active ?? false;

  // El sondeo de la llamada propia: cada 2,5 s mientras está viva; se detiene
  // al terminar o al cerrar la ficha. Cada sondeo también suelta en el servidor
  // la llamada que Anura nunca avisó (60 s). La del teléfono de Kapta la sondea
  // el panel (`AnuraPhoneProvider`), con la ficha abierta o no.
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
        setLocalCall(res.call);
        if (!res.call.active) {
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

  // La llamada del teléfono de Kapta terminó con la ficha abierta: recargar el
  // historial y la tarjeta, como con el sondeo propio.
  const ownedCall = !local && owned && phoneCallId ? phone.serverCall : null;
  const seenLive = useRef<string | null>(null);
  useEffect(() => {
    if (!ownedCall) return;
    if (ownedCall.active) {
      seenLive.current = ownedCall.id;
      return;
    }
    if (seenLive.current !== ownedCall.id) return;
    seenLive.current = null;
    onEndedRef.current();
    window.setTimeout(() => {
      if (mounted.current) onEndedRef.current();
    }, ENDED_RELOAD_AGAIN_MS);
  }, [ownedCall?.id, ownedCall?.active]); // eslint-disable-line react-hooks/exhaustive-deps

  // El plazo del servidor sin avisos de Anura no corta a Kapta (`anuraPhoneOutlivesServer`):
  // de eso, y de colgar cuando Anura da la llamada por terminada, se encarga el panel.
  const outlives = anuraPhoneOutlivesServer(snap, call);

  // El reloj, solo mientras se habla (con el teléfono de Kapta, hasta colgar).
  // Si el servidor la cerró por su plazo y Kapta sigue en la llamada, corre
  // desde que el teléfono de Kapta contestó (`anuraTalkClock`).
  const clock = anuraTalkClock(snap, call, viaKapta);
  const talking = clock.running;
  useEffect(() => {
    if (!talking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [talking]);

  const ended = call && !call.active && !outlives ? call : null;
  const endedId = ended?.id ?? null;
  useEffect(() => {
    if (endedId) setHasDesk(Boolean(document.querySelector(CONFIRMATION_DESK)));
  }, [endedId]);

  /** Sigue la llamada viva que devolvió el servidor (ya había una, o Anura no respondió). */
  async function follow(activeCallId: string | undefined) {
    if (!activeCallId) {
      setLocalCall(null);
      return;
    }
    const status = await getAnuraCallStatus(activeCallId).catch(() => null);
    if (!mounted.current) return;
    if (status?.ok) setLocalCall(status.call);
    else setLocalCall(null);
  }

  /** Con el teléfono de Kapta: micrófono → conectar → pedir → contestar el aviso propio. */
  async function startWithKapta() {
    setViaKapta(true);
    setLocalCall(null);
    // Sin esperas antes: `phone.call` desbloquea el audio dentro del clic.
    const result = await phone.call(server, { origin: "pedido", orderId, orderLabel: orderName ?? null, storeLabel: storeName ?? null });
    if (!mounted.current || result.phase !== "error" || !result.error) return;
    setError({ title: anuraPhoneErrorTitle(result.error), text: result.error.message });
    if (anuraPhoneNeedsPanelReload(result.error)) onPhoneChangedRef.current?.();
    if (result.error.start?.activeCallId) await follow(result.error.start.activeCallId);
  }

  async function start() {
    // El teléfono de Kapta ya está en una llamada: la de este pedido se
    // enseña; si es de otro pedido (o la prueba de Ajustes), no se pide otra
    // y la tarjeta de esa llamada lo dice.
    const decision = anuraPhoneStartDecision({ phoneBusy: phone.busy, isThisCall: owned !== null });
    if (decision === "mostrar") {
      setViaKapta(true);
      setOpen(true);
      return;
    }
    if (decision === "ocupado") {
      phone.notifyBusy();
      return;
    }
    if (local?.active) {
      setOpen(true);
      return;
    }
    setOpen(true);
    setError(null);
    setPollTrouble(false);
    failures.current = 0;

    if (way === "bloqueado" && kaptaPhone && isAnuraPhoneBlocked(kaptaPhone.status)) {
      // Con la «-websocket» como principal, la fase 1 haría sonar una terminal
      // sin conectar: no se intenta nada.
      setViaKapta(true);
      setLocalCall(null);
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
        setLocalCall(
          requestedCall({ id: res.callId, orderId, extension: res.extension, toMasked: res.toMasked, hint: ANURA_STATUS_HINT.solicitada ?? null }),
        );
        return;
      }
      // Sin clave del teléfono de Kapta y con la «-websocket» como principal,
      // «tu teléfono de Anura no está conectado» confunde: se dice qué falta.
      setError(anuraFase1StartError(res, { kaptaKeyMissing: kaptaPhone?.status === "sin_telefono", extension }));
      // Ya hay una viva, o Anura no respondió y puede que llame igual: se sigue
      // esa en vez de dejar a la asesora a ciegas.
      if (res.activeCallId) {
        const status = await getAnuraCallStatus(res.activeCallId).catch(() => null);
        if (status?.ok) setLocalCall(status.call);
        else setLocalCall(null);
      } else {
        setLocalCall(null);
      }
    } catch (e) {
      setError({ title: "No se pudo llamar", text: (e as Error).message || "Vuelve a intentar." });
      setLocalCall(null);
    } finally {
      setStarting(false);
    }
  }

  const failed = ended?.status === "fallida";
  // Lo que se ofrece al terminar depende de si dejó su hecho y de qué pedido es.
  const followUp = ended ? anuraEndedFollowUp(ended, orderId) : { inHistory: false, otherOrderId: null };
  const otherOrder = call?.mode === "pedido" && call.orderId && call.orderId !== orderId ? call.orderId : null;
  const live = Boolean(call?.active) || kaptaBusy;
  // El teléfono de Kapta está en una llamada de otro pedido (o la prueba de Ajustes).
  const busyElsewhere = phone.busy && owned === null;
  const phoneFailed = viaKapta && snap?.phase === "error";
  // Un fallo del teléfono que pasó con la ficha cerrada también se dice al volver.
  const shownError = error ?? (phoneFailed && snap?.error ? { title: anuraPhoneErrorTitle(snap.error), text: snap.error.message } : null);
  const trouble = local ? pollTrouble : call ? phone.pollTrouble : false;
  const tone =
    call?.status === "en_curso" || ended?.status === "contestada" || outlives
      ? "text-ok-fg"
      : failed || (shownError && !call) || (phoneFailed && !call?.active)
        ? "text-crit-fg"
        : "text-ink-500";
  const statusLabel = viaKapta
    ? anuraPhoneStatusLabel(snap, call) || (shownError && !call ? "No se pudo llamar" : "")
    : starting
      ? "Pidiendo la llamada…"
      : call
        ? call.statusLabel
        : shownError
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
      className="fixed bottom-4 right-4 z-[60] w-[min(22rem,calc(100vw-2rem))] rounded-lg bg-white p-4 shadow-pop"
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

      {talking && (
        <p className="mt-3 text-2xl font-semibold tabular-nums text-ink-900">{formatTalkTime(talkSecondsFrom(clock.fromMs, now))}</p>
      )}

      {hint && <p className="mt-2 text-xs text-ink-600">{hint}</p>}
      {!viaKapta && call?.active && (
        <p className="mt-1 text-xs text-ink-600">Para colgar, cuelga en tu teléfono de Anura. Puedes ocultar este aviso: la llamada sigue.</p>
      )}
      {viaKapta && kaptaBusy && <p className="mt-1 text-xs text-ink-600">{ANURA_PHONE_KEEPS_GOING}</p>}
      {viaKapta && kaptaBusy && <AnuraVolumeControl volume={phone.volume} onChange={phone.setVolume} />}

      {shownError && (
        <div className="mt-3 text-sm">
          <p className="font-medium text-crit-fg">{shownError.title}</p>
          <p className="mt-0.5 text-ink-700">{shownError.text}</p>
        </div>
      )}

      {trouble && call?.active && (
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
        {viaKapta && kaptaBusy && (
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
            : busyElsewhere
              ? "Ya tienes una llamada con Anura en curso: cuélgala antes de llamar a este cliente"
              : way === "kapta" && pool
                ? `Llamar con Anura desde Kapta con una línea compartida (${anuraFreeLinesLabel(pool.free, pool.total)}): hablas con tus audífonos y Anura marca a la clienta`
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
      {/* El audio de Anura ya no va aquí: es UNO por pestaña, en AnuraPhoneProvider. */}
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
