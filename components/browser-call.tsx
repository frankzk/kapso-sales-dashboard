"use client";

// Llamar desde la computadora (MOM §8.5). La asesora llama a la clienta desde
// la ficha y habla con audífonos; la clienta ve el número de la empresa. Va por
// Telnyx WebRTC: el servidor entrega un token de 24 horas (la clave de Telnyx
// no llega aquí) y el SDK se carga solo al llamar, para no pesar en la ficha.
//
// Al colgar, la llamada queda en el historial del pedido (`browser_call`). El
// resultado de la gestión se sigue registrando en la mesa de confirmación: la
// tarjeta lleva hasta ella.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { INotification, TelnyxRTC } from "@telnyx/webrtc";
import { recordBrowserCall, startBrowserCall } from "@/app/dashboard/pedidos/actions";
import {
  BROWSER_CALL_PHASE_LABEL,
  formatTalkTime,
  noAnswerReason,
  phaseFromSdkState,
  type BrowserCallPhase,
  type BrowserCallReport,
} from "@/lib/browser-call";
import { IconHeadset, IconMic, IconMicOff, IconPhone } from "@/components/icons";
import { OpsButton } from "@/components/ops-ui";
import { cn } from "@/components/ui";

/** Lo que se usa de una llamada del SDK. */
interface LiveCall {
  id: string;
  state: string;
  cause?: string;
  sipCode?: number;
  hangup(): unknown;
  muteAudio(): void;
  unmuteAudio(): void;
}

interface Ended {
  answered: boolean;
  talkSeconds: number;
  reason: string;
  saved: "guardando" | "guardada" | string;
}

/** El selector de la mesa de confirmación en la ficha (order-drawer). */
const CONFIRMATION_DESK = '[data-drawer-section="confirmacion"]';

export const MIC_DENIED =
  "Kapta no tiene permiso para usar el micrófono. Actívalo en el candado de la barra de direcciones y vuelve a llamar.";

const LIVE: readonly BrowserCallPhase[] = ["preparando", "conectando", "timbrando", "en_llamada"];

/** Cuelga sin que un rechazo quede suelto: el SDK devuelve una promesa. */
function safeHangup(call: LiveCall): Promise<boolean> {
  try {
    return Promise.resolve(call.hangup()).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

function sdkErrorText(event: unknown): string {
  const err = (event as { error?: { message?: string; name?: string } } | null)?.error;
  if (err?.name === "NotAllowedError") return MIC_DENIED;
  const message = err?.message?.trim();
  return `No se pudo conectar con la línea de Telnyx${message ? `: ${message}` : ""}.`;
}

export function BrowserCallButton({
  orderId,
  phone,
  onRecorded,
}: {
  orderId: string;
  /** El teléfono tal como lo ve la asesora en la ficha. */
  phone: string;
  /** Al guardarse la llamada, para recargar el historial. */
  onRecorded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<BrowserCallPhase>("preparando");
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [ended, setEnded] = useState<Ended | null>(null);
  const [hasDesk, setHasDesk] = useState(false);
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);

  const clientRef = useRef<TelnyxRTC | null>(null);
  const callRef = useRef<LiveCall | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Tiempos y si ya se guardó: en refs, porque los leen los avisos del SDK. Se
  // reinicia campo a campo, nunca se reemplaza: la limpieza al cerrar la ficha
  // guarda este mismo objeto. `rang`: la llamada llegó a la red (timbró o
  // contestó); una que no salió —sin micrófono, sin línea— no es un intento.
  const timesRef = useRef<{ dialedAt: number | null; answeredAt: number | null; rang: boolean; reported: boolean }>({
    dialedAt: null,
    answeredAt: null,
    rang: false,
    reported: false,
  });
  // Cada llamada es una sesión. «Cancelar» mientras se prepara la línea cierra
  // la sesión, y lo que llegue tarde de ella (el token, el SDK) se descarta.
  const sessionRef = useRef(0);

  const live = open && LIVE.includes(phase);

  function reportFor(call: LiveCall): BrowserCallReport {
    const t = timesRef.current;
    const end = Date.now();
    return {
      callId: call.id,
      answered: t.answeredAt !== null,
      talkSeconds: t.answeredAt ? Math.round((end - t.answeredAt) / 1000) : 0,
      totalSeconds: t.dialedAt ? Math.round((end - t.dialedAt) / 1000) : 0,
      cause: call.cause ?? null,
      sipCode: typeof call.sipCode === "number" ? call.sipCode : null,
    };
  }

  function teardown() {
    const client = clientRef.current;
    clientRef.current = null;
    callRef.current = null;
    if (client) void client.disconnect().catch(() => undefined);
  }

  async function finish(call: LiveCall) {
    if (timesRef.current.reported) return;
    timesRef.current.reported = true;
    const report = reportFor(call);
    setHasDesk(Boolean(document.querySelector(CONFIRMATION_DESK)));
    setEnded({
      answered: report.answered,
      talkSeconds: report.talkSeconds,
      reason: report.answered ? "" : noAnswerReason(report.cause, report.sipCode),
      saved: "guardando",
    });
    teardown();
    const res = await recordBrowserCall(orderId, report).catch((e: unknown) => ({ error: (e as Error).message }));
    setEnded((prev) => (prev ? { ...prev, saved: res.error ? res.error : "guardada" } : prev));
    if (!res.error) onRecorded();
  }

  function fail(message: string) {
    setError(message);
    setPhase("error");
    const call = callRef.current;
    if (call) void safeHangup(call);
    // Solo se guarda si llegó a timbrar: lo demás no fue un intento de contacto.
    if (call && timesRef.current.rang && !timesRef.current.reported) void finish(call);
    else teardown();
  }

  async function start() {
    const session = ++sessionRef.current;
    const current = () => sessionRef.current === session;
    Object.assign(timesRef.current, { dialedAt: null, answeredAt: null, rang: false, reported: false });
    setOpen(true);
    setPhase("preparando");
    setError(null);
    setEnded(null);
    setMuted(false);
    setAnsweredAt(null);
    try {
      const setup = await startBrowserCall(orderId);
      if (!current()) return;
      if (!setup.ok) return fail(setup.error);
      setFrom(setup.from);
      const { TelnyxRTC } = await import("@telnyx/webrtc");
      if (!current()) return;
      const client = new TelnyxRTC({ login_token: setup.token });
      clientRef.current = client;
      client.on("telnyx.ready", () => {
        // Una reconexión vuelve a avisar «listo»: se marca una sola vez.
        if (!current() || callRef.current || timesRef.current.dialedAt) return;
        timesRef.current.dialedAt = Date.now();
        setPhase("conectando");
        callRef.current = client.newCall({
          destinationNumber: setup.to,
          callerNumber: setup.from,
          audio: true,
          video: false,
          remoteElement: audioRef.current ?? undefined,
        }) as unknown as LiveCall;
      });
      client.on("telnyx.error", (event) => {
        if (current()) fail(sdkErrorText(event));
      });
      client.on("telnyx.socket.error", () => {
        if (current() && !timesRef.current.reported) fail("Se cortó la conexión con la línea de Telnyx.");
      });
      client.on("telnyx.notification", (n: INotification) => {
        if (!current()) return;
        if (n.type === "userMediaError") return fail(MIC_DENIED);
        if (n.type !== "callUpdate" || !n.call) return;
        const call = n.call as unknown as LiveCall;
        const next = phaseFromSdkState(call.state);
        if (next === "timbrando" || next === "en_llamada") timesRef.current.rang = true;
        if (next === "en_llamada" && timesRef.current.answeredAt === null) {
          const at = Date.now();
          timesRef.current.answeredAt = at;
          setAnsweredAt(at);
          setNow(at);
        }
        setPhase(next);
        if (next === "terminada") void finish(call);
      });
      await client.connect();
    } catch (e) {
      if (current()) fail(`No se pudo llamar: ${(e as Error).message}`);
    }
  }

  function hangup() {
    const call = callRef.current;
    if (!call) {
      sessionRef.current++;
      teardown();
      setOpen(false);
      return;
    }
    // Al colgar, el SDK avisa «hangup» y eso guarda la llamada. Si el SDK falla
    // al colgar, se guarda desde aquí.
    void safeHangup(call).then((ok) => {
      if (!ok) void finish(call);
    });
  }

  function toggleMute() {
    const call = callRef.current;
    if (!call) return;
    if (muted) call.unmuteAudio();
    else call.muteAudio();
    setMuted(!muted);
  }

  // El reloj, solo mientras se habla.
  useEffect(() => {
    if (!open || phase !== "en_llamada") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open, phase]);

  // Cerrar o recargar la pestaña corta la llamada: el navegador lo pregunta.
  useEffect(() => {
    if (!live) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live]);

  // Cerrar la ficha con la llamada en curso la cuelga, y se guarda igual si
  // llegó a timbrar.
  useEffect(() => {
    const times = timesRef.current;
    const session = sessionRef;
    return () => {
      // Lo que el SDK avise después ya no es de esta ficha.
      session.current++;
      const call = callRef.current;
      if (call) void safeHangup(call);
      if (call && times.rang && !times.reported) {
        times.reported = true;
        const end = Date.now();
        void recordBrowserCall(orderId, {
          callId: call.id,
          answered: times.answeredAt !== null,
          talkSeconds: times.answeredAt ? Math.round((end - times.answeredAt) / 1000) : 0,
          totalSeconds: times.dialedAt ? Math.round((end - times.dialedAt) / 1000) : 0,
          cause: call.cause ?? "ORIGINATOR_CANCEL",
          sipCode: null,
        }).catch(() => undefined);
      }
      const client = clientRef.current;
      clientRef.current = null;
      if (client) void client.disconnect().catch(() => undefined);
    };
  }, [orderId]);

  const talkSeconds = answeredAt ? Math.max(0, Math.round((now - answeredAt) / 1000)) : 0;

  const tone =
    phase === "en_llamada" ? "text-ok-fg" : phase === "error" ? "text-crit-fg" : "text-ink-500";

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
          <p className="text-xs font-medium text-ink-500">Llamada desde Kapta</p>
          <p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-ink-900">{phone}</p>
        </div>
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs font-medium", tone)}>
          <span aria-hidden className={cn("size-2 rounded-full bg-current", phase === "timbrando" && "animate-pulse")} />
          {BROWSER_CALL_PHASE_LABEL[phase]}
        </span>
      </div>

      {phase === "en_llamada" && (
        <p className="mt-3 text-2xl font-semibold tabular-nums text-ink-900">{formatTalkTime(talkSeconds)}</p>
      )}

      {live && (
        <p className="mt-2 text-xs text-ink-600">
          {from ? <>La clienta ve el número <span className="tabular-nums">{from}</span>. </> : null}
          Si cierras la ficha, la llamada se corta.
        </p>
      )}

      {error && <p className="mt-3 text-sm text-crit-fg">{error}</p>}

      {ended && (
        <div className="mt-3 text-sm text-ink-700">
          <p className="font-medium text-ink-900">
            {ended.answered ? `Contestó · ${formatTalkTime(ended.talkSeconds)} de conversación` : `Sin conversación: ${ended.reason}`}
          </p>
          <p className={cn("mt-1 text-xs", ended.saved === "guardada" || ended.saved === "guardando" ? "text-ink-600" : "text-crit-fg")}>
            {ended.saved === "guardando"
              ? "Guardando en el historial…"
              : ended.saved === "guardada"
                ? "Guardada en el historial del pedido."
                : ended.saved}
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {live ? (
          <>
            {phase === "en_llamada" && (
              <OpsButton size="sm" onClick={toggleMute} aria-pressed={muted}>
                {muted ? <IconMicOff aria-hidden className="text-ink-500" /> : <IconMic aria-hidden className="text-ink-500" />}
                {muted ? "Activar micrófono" : "Silenciar"}
              </OpsButton>
            )}
            <OpsButton size="sm" variant="danger" onClick={hangup}>
              <IconPhone aria-hidden />
              {phase === "preparando" ? "Cancelar" : "Colgar"}
            </OpsButton>
          </>
        ) : (
          <>
            {ended && hasDesk && (
              <OpsButton
                size="sm"
                variant="primary"
                onClick={() => {
                  document.querySelector(CONFIRMATION_DESK)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  setOpen(false);
                }}
              >
                Registrar el resultado
              </OpsButton>
            )}
            <OpsButton size="sm" onClick={() => setOpen(false)}>
              Cerrar
            </OpsButton>
          </>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <OpsButton
        size="sm"
        onClick={() => void start()}
        disabled={live}
        title="Llamar desde la computadora, con audífonos"
        aria-label="Llamar al cliente desde la computadora"
        className="pointer-coarse:h-11 pointer-coarse:min-w-11"
      >
        <IconHeadset aria-hidden className="text-ink-500" />
        <span className="hidden sm:inline">Llamar desde Kapta</span>
      </OpsButton>
      {/* El audio de la clienta. Fuera del aviso para que exista antes de marcar. */}
      <audio ref={audioRef} autoPlay hidden />
      {card && typeof document !== "undefined" ? createPortal(card, document.body) : null}
    </>
  );
}
