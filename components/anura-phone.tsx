"use client";

// «Llamar con Anura», fase 2: el teléfono DENTRO de Kapta (solo salidas; MOM
// §8.7). `AnuraPhoneProvider` cablea la lógica pura (`createAnuraPhone`,
// lib/anura/sip-phone.ts) con el navegador: JsSIP se carga con import
// dinámico solo al pedir la llamada (lib/anura/jssip-client.ts), el
// micrófono, el candado entre pestañas y el `<audio autoplay>` del audio de
// Anura.
//
// LA LLAMADA VIVE EN KAPTA, NO EN LA FICHA (07-11-2026). Antes el teléfono
// vivía dentro de la ficha y cerrarla (el fondo gris, la X, abrir otro pedido,
// ir a otra pantalla) colgaba: en producción una llamada se cortó 1 s después
// de conectar porque la ficha se cerró. Ahora hay UN teléfono por pestaña y
// UN `<audio>`, montados en el panel (app/dashboard/layout.tsx), y la llamada
// sigue al cerrar la ficha o al moverse entre pantallas. Solo la terminan
// «Colgar», el otro lado, un fallo, o cerrar/recargar la pestaña.
//
//   · La ficha (components/anura-call.tsx) y la «Llamada de prueba» de Ajustes
//     piden la llamada con SUS acciones del servidor (`call(server, meta)`):
//     se guardan para esa llamada.
//   · La tarjeta global (abajo) sale mientras hay llamada y ninguna pantalla
//     la está mostrando: la ficha de ESE pedido o la prueba de Ajustes la
//     «toman» (`useAnuraPhoneClaim`) y entonces no hay dos tarjetas.
//   · El estado que dice si la clienta contestó llega por el sondeo de la
//     fase 1 (`getAnuraCallStatus`), que también vive aquí.
//   · El teléfono se crea en la primera llamada, no al abrir la ficha.
//   · La clave SIP solo vive en memoria mientras dura la llamada: no se guarda
//     en el estado de React, ni en el almacenamiento del navegador, ni se escribe
//     en la consola.
//   · En `pagehide` (cerrar o recargar la pestaña), `dispose()` cuelga,
//     desregistra y suelta el micrófono y el candado. Mientras hay llamada, el
//     navegador pregunta antes de cerrar o recargar la pestaña.
//   · Kapta no recibe llamadas: un aviso que llega sin una llamada pedida en
//     esta pestaña, fuera de tiempo o de más se rechaza sin sonar (lo decide
//     `shouldAnswerInvite`).
//   · La pestaña recuerda en memoria las claves que Anura rechazó y la espera
//     tras un fallo (`browserAnuraPhoneMemory`).
//
// FRONTERA. Del servidor solo se importan TIPOS y acciones `"use server"`; las
// acciones de cada llamada llegan como funciones desde quien la pide.

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { AnuraCallLive, AnuraStartResult } from "@/lib/anura/calls";
import {
  createAnuraPhone,
  type AnuraPhone,
  type AnuraPhoneCredentialsResult,
  type AnuraPhoneSnapshot,
  type AnuraRegistrationFailureKind,
} from "@/lib/anura/sip-phone";
import { browserAnuraPhoneMemory, browserAnuraTabLock, browserMicrophone, createJsSipUa } from "@/lib/anura/jssip-client";
import { getAnuraCallStatus, logAnuraPhoneDiag } from "@/app/dashboard/pedidos/anura-actions";
import { ANURA_POLL_INTERVAL_MS } from "@/lib/anura/events";
import { ANURA_MAX_POLL_FAILURES } from "@/lib/anura/ui";
import {
  ANURA_PHONE_BUSY_TITLE,
  ANURA_PHONE_KEEPS_GOING,
  ANURA_VOLUME_DEFAULT,
  ANURA_VOLUME_MAX,
  ANURA_VOLUME_MIN,
  ANURA_VOLUME_STEP,
  anuraGlobalCardVisible,
  anuraPhoneBusyText,
  anuraPhoneCallContextLine,
  anuraPhoneCanMute,
  anuraPhoneEndedLine,
  anuraPhoneErrorTitle,
  anuraPhoneHangUpLabel,
  anuraPhoneHint,
  anuraPhoneOutlivesServer,
  anuraPhoneStatusLabel,
  anuraRequestedCall,
  anuraTalkClock,
  clampAnuraVolume,
  talkSecondsFrom,
  type AnuraPhoneCallMeta,
} from "@/lib/anura/phone-ui";
import { readAnuraVolumePref, saveAnuraVolumePref } from "@/lib/anura/volume-pref";
import { formatTalkTime } from "@/lib/browser-call";
import { OrderLink } from "@/components/order-link";
import { IconMic, IconMicOff, IconPhone } from "@/components/icons";
import { OpsButton } from "@/components/ops-ui";
import { cn } from "@/components/ui";

export type { AnuraPhoneCallMeta } from "@/lib/anura/phone-ui";

/**
 * Amplificador del audio de Anura (07-11-2026: «se escuchó, pero muy bajito»).
 * La línea telefónica llega a nivel de teléfono y `<audio>.volume` no pasa de
 * 1, así que el audio va por Web Audio: ganancia + compresor (sube la voz sin
 * reventar). Chrome solo deja salir el audio remoto de WebRTC por Web Audio si
 * también está enganchado a un `<audio>`: ese queda silenciado. Si Web Audio
 * no arranca, se usa el `<audio>` normal (sin amplificar).
 */
interface Amplifier {
  ctx: AudioContext;
  gain: GainNode;
  /** Escucha lo que entra al amplificador (para saber si de verdad le llega audio). */
  analyser: AnalyserNode;
  /** Último nodo de la cadena: se conecta a los parlantes solo si llega audio. */
  out: AudioNode;
  nodes: AudioNode[];
  engaged: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

/** El AudioContext del teléfono. Se crea y se reanuda EN el clic de «Llamar»: fuera de un clic, Chrome lo deja en pausa. */
function newAudioContext(): AudioContext | null {
  try {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return Ctx ? new Ctx() : null;
  } catch {
    return null;
  }
}

function startAmplifier(ctx: AudioContext, stream: MediaStream, volume: number): Amplifier | null {
  try {
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    source.connect(gain);
    gain.connect(comp);
    // `comp` NO va a los parlantes todavía: primero se comprueba que llegue audio.
    return { ctx, gain, analyser, out: comp, nodes: [source, analyser, gain, comp], engaged: false, timer: null };
  } catch {
    return null;
  }
}

/** ¿Le llega sonido al amplificador ahora? (RMS de la señal que entra). */
function hearsSignal(amp: Amplifier): boolean {
  const buf = new Float32Array(amp.analyser.fftSize);
  amp.analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const x of buf) sum += x * x;
  return Math.sqrt(sum / buf.length) > 1e-4;
}

function stopAmplifier(amp: Amplifier | null) {
  if (!amp) return;
  if (amp.timer) clearInterval(amp.timer);
  amp.timer = null;
  for (const n of amp.nodes) {
    try {
      n.disconnect();
    } catch {
      // ya desconectado
    }
  }
}

/** Lo que el teléfono pide al servidor (server actions) en UNA llamada. */
export interface AnuraPhoneServer {
  /** Las credenciales del anexo PROPIO, en el momento de llamar. */
  fetchCredentials(): Promise<AnuraPhoneCredentialsResult>;
  /** Pide la llamada a Anura (Click2Dial). */
  requestCall(): Promise<AnuraStartResult>;
  /** Anura rechazó la clave (o no reconoce el dominio): el servidor lo marca. */
  reportRejected(input: { credentialVersion: string; kind: AnuraRegistrationFailureKind; status: number | null; domain?: string }): Promise<unknown>;
}

/** Sin acciones (no debería pasar: cada `call` trae las suyas). */
const NO_SERVER: AnuraPhoneServer = {
  fetchCredentials: async () => ({ ok: false, code: "base", error: "No se pudo preparar el teléfono de Kapta. Vuelve a intentar." }),
  requestCall: async () => ({ ok: false, error: "No se pudo pedir la llamada. Vuelve a intentar." }),
  reportRejected: async () => null,
};

/** La llamada (actual o la última) del teléfono de Kapta de esta pestaña. */
export interface AnuraPhoneSession {
  /** Sube con cada `call`: así una pantalla «toma» SU llamada y no otra. */
  seq: number;
  meta: AnuraPhoneCallMeta;
  /** Terminó sin que ninguna pantalla la mostrara: la tarjeta global enseña cómo. */
  endedUnseen: boolean;
}

export interface AnuraKaptaPhoneApi {
  snapshot: AnuraPhoneSnapshot | null;
  busy: boolean;
  session: AnuraPhoneSession | null;
  /** Lo que dice el sondeo de esa llamada (o la recién pedida, hasta el primer sondeo). */
  serverCall: AnuraCallLive | null;
  pollTrouble: boolean;
  /**
   * Pide la llamada con las acciones de quien llama. Va DENTRO del clic y sin
   * esperas antes: desbloquea el audio (AudioContext) mientras Chrome lo deja.
   * Con el teléfono ocupado no pide otra: devuelve la foto actual.
   */
  call(server: AnuraPhoneServer, meta: AnuraPhoneCallMeta): Promise<AnuraPhoneSnapshot>;
  hangUp(): void;
  setMuted(muted: boolean): void;
  volume: number;
  setVolume(v: number): void;
  /** Una pantalla muestra esta llamada (la ficha de ese pedido, Ajustes). Devuelve cómo soltarla. */
  claim(seq: number): () => void;
  /** Se intentó otra llamada con esta en marcha: la tarjeta global lo dice. */
  notifyBusy(): void;
}

const AnuraPhoneContext = createContext<AnuraKaptaPhoneApi | null>(null);

/** El teléfono de Kapta de esta pestaña (lo da `AnuraPhoneProvider`, en el layout del panel). */
export function useAnuraKaptaPhone(): AnuraKaptaPhoneApi {
  const api = useContext(AnuraPhoneContext);
  if (!api) throw new Error("El teléfono de Kapta necesita AnuraPhoneProvider (app/dashboard/layout.tsx).");
  return api;
}

/** Esta pantalla está mostrando la llamada `seq`: la tarjeta global se esconde mientras tanto. */
export function useAnuraPhoneClaim(seq: number | null) {
  const { claim } = useAnuraKaptaPhone();
  useEffect(() => (seq === null ? undefined : claim(seq)), [seq, claim]);
}

export function AnuraPhoneProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<AnuraPhoneSnapshot | null>(null);
  const [session, setSession] = useState<AnuraPhoneSession | null>(null);
  const [claims, setClaims] = useState<readonly { token: number; seq: number }[]>([]);
  const claimsRef = useRef(claims);
  const claimToken = useRef(0);
  const [busyNotice, setBusyNotice] = useState(false);
  const [polled, setPolled] = useState<AnuraCallLive | null>(null);
  const [pollTrouble, setPollTrouble] = useState(false);
  const phoneRef = useRef<AnuraPhone | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ampRef = useRef<Amplifier | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  // Las acciones de la llamada en curso (las de la ficha de ese pedido o las de Ajustes).
  const serverRef = useRef<AnuraPhoneServer>(NO_SERVER);
  const seqRef = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);

  /** En el clic de «Llamar»: crea o reanuda el AudioContext mientras Chrome lo permite. */
  const unlockAudio = useCallback(() => {
    if (!ctxRef.current || ctxRef.current.state === "closed") ctxRef.current = newAudioContext();
    void ctxRef.current?.resume().catch(() => undefined);
  }, []);
  /** Al terminar: suelta el amplificador y el AudioContext (la próxima llamada crea otro en su clic). */
  const releaseAudio = useCallback(() => {
    stopAmplifier(ampRef.current);
    ampRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    void ctx?.close().catch(() => undefined);
  }, []);

  const [volume, setVolumeState] = useState<number>(ANURA_VOLUME_DEFAULT);
  const volumeRef = useRef(volume);
  useEffect(() => {
    const saved = readAnuraVolumePref();
    volumeRef.current = saved;
    setVolumeState(saved);
  }, []);
  const setVolume = useCallback((v: number) => {
    const next = clampAnuraVolume(v);
    volumeRef.current = next;
    setVolumeState(next);
    const amp = ampRef.current;
    if (amp) amp.gain.gain.setTargetAtTime(next, amp.ctx.currentTime, 0.05);
    saveAnuraVolumePref(next);
  }, []);

  const phone = useCallback((): AnuraPhone => {
    if (phoneRef.current) return phoneRef.current;
    const created = createAnuraPhone({
      createUa: createJsSipUa,
      getMicrophone: browserMicrophone,
      lock: browserAnuraTabLock(),
      memory: browserAnuraPhoneMemory(),
      fetchCredentials: () => serverRef.current.fetchCredentials(),
      requestCall: () => serverRef.current.requestCall(),
      reportRejected: (input) => serverRef.current.reportRejected(input),
      makeStream: (tracks) => new MediaStream(tracks as MediaStreamTrack[]),
      onRemoteStream: (stream) => {
        const el = audioRef.current;
        if (!el) {
          void logAnuraPhoneDiag("audio_play", { ok: false, name: "sin_elemento" }).catch(() => undefined);
          return;
        }
        el.srcObject = (stream as MediaStream | null) ?? null;
        stopAmplifier(ampRef.current);
        ampRef.current = null;
        if (!stream) {
          el.muted = false;
          return;
        }
        // El <audio> suena SIEMPRE (nunca mudo): Chrome solo procesa el audio
        // remoto de WebRTC si un reproductor lo está sonando, y silenciarlo dejó
        // la llamada sin audio (prueba real 07-11 15:52 UTC). El amplificador es
        // un extra: escucha en paralelo y, solo cuando comprueba que le llega
        // sonido, toma la salida (el <audio> baja a volumen 0, no a mudo). Si
        // después deja de oír por 4 s, devuelve la salida al <audio> y ya no
        // vuelve a tomarla en esta llamada.
        el.muted = false;
        el.volume = 1;
        const ctx = ctxRef.current;
        const amp = ctx && ctx.state === "running" ? startAmplifier(ctx, stream as MediaStream, volumeRef.current) : null;
        ampRef.current = amp;
        void logAnuraPhoneDiag("audio_amplificador", { ok: amp !== null, estado: ctx?.state ?? null, volumen: volumeRef.current }).catch(() => undefined);
        if (amp) {
          let checks = 0;
          let quiet = 0;
          amp.timer = setInterval(() => {
            if (ampRef.current !== amp) return;
            const signal = hearsSignal(amp);
            if (!amp.engaged) {
              checks += 1;
              if (signal) {
                try {
                  amp.out.connect(amp.ctx.destination);
                  amp.engaged = true;
                  el.volume = 0;
                  void logAnuraPhoneDiag("audio_modo", { modo: "amplificado", tras_ms: checks * 250 }).catch(() => undefined);
                } catch {
                  // sin amplificador: sigue el <audio>
                }
              } else if (checks >= 40) {
                // 10 s sin oír nada por el amplificador: se queda el <audio>.
                if (amp.timer) clearInterval(amp.timer);
                amp.timer = null;
                void logAnuraPhoneDiag("audio_modo", { modo: "normal", motivo: "sin_senal" }).catch(() => undefined);
              }
              return;
            }
            quiet = signal ? 0 : quiet + 1;
            if (quiet >= 16) {
              try {
                amp.out.disconnect();
              } catch {
                // ya desconectado
              }
              amp.engaged = false;
              el.volume = 1;
              if (amp.timer) clearInterval(amp.timer);
              amp.timer = null;
              void logAnuraPhoneDiag("audio_modo", { modo: "normal", motivo: "silencio_amplificado" }).catch(() => undefined);
            }
          }, 250);
        }
        void el
          .play()
          .then(() => logAnuraPhoneDiag("audio_play", { ok: true }))
          .catch((err: unknown) => {
            // El navegador bloqueó el audio: se vuelve a intentar con el siguiente clic.
            const name = (err as { name?: unknown } | null)?.name;
            void logAnuraPhoneDiag("audio_play", { ok: false, name: typeof name === "string" ? name : null }).catch(() => undefined);
            const retry = () => {
              void el.play().catch(() => undefined);
              void ampRef.current?.ctx.resume().catch(() => undefined);
            };
            document.addEventListener("pointerdown", retry, { once: true });
            document.addEventListener("keydown", retry, { once: true });
          });
      },
      onChange: (s) => {
        if (!mounted.current) return;
        const wasBusy = busyRef.current;
        busyRef.current = s.busy;
        setSnapshot(s);
        if (wasBusy && !s.busy) {
          // Terminó: si ninguna pantalla la estaba mostrando, la tarjeta global
          // se queda con cómo terminó hasta que la cierren.
          const seq = seqRef.current;
          const seen = claimsRef.current.some((c) => c.seq === seq);
          setSession((prev) => (prev && prev.seq === seq ? { ...prev, endedUnseen: !seen } : prev));
          setBusyNotice(false);
          releaseAudio();
        }
      },
      // Cada paso al log de Vercel (`[anura-phone]`), sin datos personales.
      diag: (event, data) => {
        void logAnuraPhoneDiag(event, data).catch(() => undefined);
      },
    });
    phoneRef.current = created;
    return created;
  }, [releaseAudio]);

  // `unlockAudio` va sin esperas antes: así corre dentro del clic.
  const call = useCallback(
    (server: AnuraPhoneServer, meta: AnuraPhoneCallMeta) => {
      const p = phone();
      if (p.snapshot().busy) return Promise.resolve(p.snapshot());
      unlockAudio();
      serverRef.current = server;
      seqRef.current += 1;
      setSession({ seq: seqRef.current, meta, endedUnseen: false });
      setBusyNotice(false);
      setPolled(null);
      setPollTrouble(false);
      return p.call();
    },
    [phone, unlockAudio],
  );
  const hangUp = useCallback(() => phoneRef.current?.hangUp(), []);
  const setMuted = useCallback((muted: boolean) => phoneRef.current?.setMuted(muted), []);
  const claim = useCallback((seq: number) => {
    const token = ++claimToken.current;
    claimsRef.current = [...claimsRef.current, { token, seq }];
    setClaims(claimsRef.current);
    return () => {
      claimsRef.current = claimsRef.current.filter((c) => c.token !== token);
      setClaims(claimsRef.current);
    };
  }, []);
  const notifyBusy = useCallback(() => {
    if (busyRef.current) setBusyNotice(true);
  }, []);
  const dismiss = useCallback(() => {
    setSession((prev) => (prev ? { ...prev, endedUnseen: false } : prev));
    setBusyNotice(false);
  }, []);

  // Cerrar o recargar la pestaña: colgar, desregistrar y soltar todo. Solo
  // eso (y salir del panel): cerrar la ficha o cambiar de pantalla no.
  useEffect(() => {
    mounted.current = true;
    const onPageHide = () => phoneRef.current?.dispose();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", onPageHide);
      phoneRef.current?.dispose();
      phoneRef.current = null;
      releaseAudio();
    };
  }, [releaseAudio]);

  // Con la llamada en marcha, el navegador pregunta antes de cerrar o recargar.
  const busy = snapshot?.busy ?? false;
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  // El sondeo de la fase 1 (cada 2,5 s) mientras la llamada está viva, aunque
  // ninguna ficha esté abierta: dice si la clienta contestó y cómo terminó.
  const callId = snapshot?.callId ?? null;
  useEffect(() => {
    if (!callId) return;
    let stopped = false;
    let timer = 0;
    let failures = 0;
    const tick = async () => {
      try {
        const res = await getAnuraCallStatus(callId);
        if (stopped) return;
        if (!res.ok) {
          setPollTrouble(true);
          return;
        }
        failures = 0;
        setPollTrouble(false);
        setPolled(res.call);
        if (!res.call.active) return;
      } catch {
        if (stopped) return;
        failures += 1;
        if (failures >= ANURA_MAX_POLL_FAILURES) {
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
  }, [callId]);

  const meta = session?.meta ?? null;
  const toMasked = snapshot?.toMasked ?? null;
  const extension = snapshot?.extension ?? null;
  const serverCall = useMemo<AnuraCallLive | null>(() => {
    if (!callId) return null;
    if (polled?.id === callId) return polled;
    return anuraRequestedCall({ id: callId, mode: meta?.origin ?? "pedido", orderId: meta?.orderId ?? null, extension, toMasked, hint: null });
  }, [callId, polled, meta?.origin, meta?.orderId, extension, toMasked]);

  // Anura dio la llamada por terminada: el teléfono de Kapta cuelga y se
  // desconecta. Si la cerró solo el plazo del servidor (no llegó ningún aviso
  // de Anura) y Kapta ya está en la llamada, NO se corta: la asesora cuelga.
  const active = serverCall?.active ?? false;
  const phoneBusy = busy;
  const outlives = anuraPhoneOutlivesServer(snapshot, serverCall);
  useEffect(() => {
    if (callId && !active && phoneBusy && !outlives) hangUp();
  }, [callId, active, phoneBusy, outlives, hangUp]);

  // Una pantalla que toma una llamada ya terminada ya enseña cómo terminó.
  const shownElsewhere = session !== null && claims.some((c) => c.seq === session.seq);
  const endedUnseen = session?.endedUnseen ?? false;
  useEffect(() => {
    if (shownElsewhere && endedUnseen) setSession((prev) => (prev ? { ...prev, endedUnseen: false } : prev));
  }, [shownElsewhere, endedUnseen]);

  const api = useMemo<AnuraKaptaPhoneApi>(
    () => ({ snapshot, busy, session, serverCall, pollTrouble, call, hangUp, setMuted, volume, setVolume, claim, notifyBusy }),
    [snapshot, busy, session, serverCall, pollTrouble, call, hangUp, setMuted, volume, setVolume, claim, notifyBusy],
  );

  const showCard = anuraGlobalCardVisible({ hasSession: session !== null, busy, endedUnseen, shownElsewhere, busyNotice });

  return (
    <AnuraPhoneContext.Provider value={api}>
      {children}
      {/* El ÚNICO audio de Anura de la pestaña: siempre montado y nunca mudo. */}
      <AnuraPhoneAudio audioRef={audioRef} />
      {showCard && session && typeof document !== "undefined"
        ? createPortal(
            <AnuraGlobalCallCard
              meta={session.meta}
              snapshot={snapshot}
              call={serverCall}
              pollTrouble={pollTrouble}
              busyNotice={busyNotice}
              volume={volume}
              onVolume={setVolume}
              onHangUp={hangUp}
              onMute={setMuted}
              onClose={dismiss}
            />,
            document.body,
          )
        : null}
    </AnuraPhoneContext.Provider>
  );
}

const PULSING_PHASES = new Set(["credenciales", "microfono", "conectando", "pidiendo", "esperando_anura"]);

/**
 * La tarjeta de la llamada cuando ninguna pantalla la muestra: la ficha se
 * cerró, se abrió otro pedido o se fue a otra pantalla. Mismo sitio que la de
 * la ficha (abajo a la derecha, z-[60]: encima de los avisos de
 * «Comprobante por validar», z-50).
 */
function AnuraGlobalCallCard({
  meta,
  snapshot: snap,
  call,
  pollTrouble,
  busyNotice,
  volume,
  onVolume,
  onHangUp,
  onMute,
  onClose,
}: {
  meta: AnuraPhoneCallMeta;
  snapshot: AnuraPhoneSnapshot | null;
  call: AnuraCallLive | null;
  pollTrouble: boolean;
  busyNotice: boolean;
  volume: number;
  onVolume: (v: number) => void;
  onHangUp: () => void;
  onMute: (muted: boolean) => void;
  onClose: () => void;
}) {
  const busy = snap?.busy ?? false;
  const outlives = anuraPhoneOutlivesServer(snap, call);
  const ended = call && !call.active && !outlives ? call : null;
  const failed = ended?.status === "fallida" || (!call && snap?.phase === "error");
  const clock = anuraTalkClock(snap, call, true);
  const talking = clock.running;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!talking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [talking]);

  const statusLabel = anuraPhoneStatusLabel(snap, call);
  const tone = call?.status === "en_curso" || ended?.status === "contestada" || outlives ? "text-ok-fg" : failed ? "text-crit-fg" : "text-ink-500";
  const pulsing = (snap ? PULSING_PHASES.has(snap.phase) : false) || (snap?.phase === "en_llamada" && call?.status !== "en_curso");
  const hint = ended ? null : anuraPhoneHint(snap, call);
  const error = snap?.phase === "error" && snap.error ? { title: anuraPhoneErrorTitle(snap.error), text: snap.error.message } : null;
  const context = anuraPhoneCallContextLine(meta);
  const extension = call?.extension ?? snap?.extension ?? null;

  return (
    <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-[60] w-[min(22rem,calc(100vw-2rem))] rounded-lg bg-white p-4 shadow-pop">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-500">Llamada con Anura desde Kapta</p>
          <p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-ink-900">
            {call?.toMasked || snap?.toMasked || (meta.origin === "prueba" ? "Llamada de prueba" : "Cliente del pedido")}
          </p>
          {context && <p className="mt-0.5 truncate text-xs text-ink-500">{context}</p>}
          {extension && <p className="mt-0.5 text-xs text-ink-500">Anexo {extension}</p>}
        </div>
        {statusLabel && (
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs font-medium", tone)}>
            <span aria-hidden className={cn("size-2 rounded-full bg-current", pulsing && "animate-pulse")} />
            {statusLabel}
          </span>
        )}
      </div>

      {talking && <p className="mt-3 text-2xl font-semibold tabular-nums text-ink-900">{formatTalkTime(talkSecondsFrom(clock.fromMs, now))}</p>}

      {busyNotice && busy && (
        <div className="mt-3 text-sm">
          <p className="font-medium text-warn-fg">{ANURA_PHONE_BUSY_TITLE}</p>
          <p className="mt-0.5 text-ink-700">{anuraPhoneBusyText(meta)}</p>
        </div>
      )}

      {hint && <p className="mt-2 text-xs text-ink-600">{hint}</p>}
      {busy && <p className="mt-1 text-xs text-ink-600">{ANURA_PHONE_KEEPS_GOING}</p>}
      {busy && <AnuraVolumeControl volume={volume} onChange={onVolume} />}

      {error && (
        <div className="mt-3 text-sm">
          <p className="font-medium text-crit-fg">{error.title}</p>
          <p className="mt-0.5 text-ink-700">{error.text}</p>
        </div>
      )}

      {pollTrouble && call?.active && (
        <p className="mt-3 text-xs text-warn-fg">
          Kapta dejó de recibir el estado de la llamada. La llamada sigue en Anura; al terminar, abre el pedido para verla en el historial.
        </p>
      )}

      {ended && (
        <div className="mt-3 text-sm text-ink-700">
          <p className={cn("font-medium", failed ? "text-crit-fg" : "text-ink-900")}>{anuraPhoneEndedLine(ended)}</p>
          {meta.origin === "pedido" && ended.inHistory && (
            <p className="mt-1 text-xs text-ink-600">Queda en el historial del pedido. El resultado se registra en su confirmación.</p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {meta.origin === "pedido" && meta.orderId && (
          <Suspense fallback={null}>
            <OrderLink orderId={meta.orderId} title="Abrir la ficha del pedido de esta llamada" className="mr-auto text-sm font-medium text-brand-700 hover:underline">
              Abrir el pedido
            </OrderLink>
          </Suspense>
        )}
        {busy ? (
          <>
            {anuraPhoneCanMute(snap) && (
              <OpsButton size="sm" onClick={() => onMute(!snap?.muted)} aria-pressed={Boolean(snap?.muted)}>
                {snap?.muted ? <IconMicOff aria-hidden className="text-ink-500" /> : <IconMic aria-hidden className="text-ink-500" />}
                {snap?.muted ? "Activar micrófono" : "Silenciar"}
              </OpsButton>
            )}
            <OpsButton size="sm" variant="danger" onClick={onHangUp}>
              <IconPhone aria-hidden />
              {anuraPhoneHangUpLabel(snap)}
            </OpsButton>
          </>
        ) : (
          <OpsButton size="sm" onClick={onClose}>
            Cerrar
          </OpsButton>
        )}
        {busy && busyNotice && (
          <OpsButton size="sm" onClick={onClose}>
            Entendido
          </OpsButton>
        )}
      </div>
    </div>
  );
}

/** Volumen de lo que se oye de la llamada (100 % a 400 %, se recuerda en este navegador). */
export function AnuraVolumeControl({ volume, onChange }: { volume: number; onChange: (v: number) => void }) {
  return (
    <label className="mt-3 flex items-center gap-3 text-xs text-ink-600">
      <span className="shrink-0 font-medium text-ink-700">Volumen</span>
      <input
        type="range"
        min={ANURA_VOLUME_MIN}
        max={ANURA_VOLUME_MAX}
        step={ANURA_VOLUME_STEP}
        value={volume}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Volumen de la llamada"
        className="h-2 w-full cursor-pointer accent-brand-600"
      />
      <span className="w-11 shrink-0 text-right tabular-nums">{Math.round(volume * 100)}%</span>
    </label>
  );
}

/** El audio de Anura. Fuera de la tarjeta, para que exista antes de contestar. */
export function AnuraPhoneAudio({ audioRef }: { audioRef: RefObject<HTMLAudioElement | null> }) {
  return <audio ref={audioRef} autoPlay hidden />;
}
