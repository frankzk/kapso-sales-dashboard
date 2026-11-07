"use client";

// «Llamar con Anura», fase 2: el teléfono DENTRO de Kapta (solo salidas; MOM
// §8.7). Este hook cablea la lógica pura (`createAnuraPhone`,
// lib/anura/sip-phone.ts) con el navegador: JsSIP se carga con import
// dinámico solo al pedir la llamada (lib/anura/jssip-client.ts), el
// micrófono, el candado entre pestañas y el `<audio autoplay>` del audio de
// Anura. Lo usan la ficha (components/anura-call.tsx) y la «Llamada de
// prueba» de Ajustes.
//
//   · El teléfono se crea en la primera llamada, no al abrir la ficha.
//   · La clave SIP solo vive en memoria mientras dura la llamada: no se guarda
//     en el estado de React, ni en el almacenamiento del navegador, ni se escribe
//     en la consola.
//   · Al desmontar (cerrar la ficha) y en `pagehide`, `dispose()` cuelga,
//     desregistra y suelta el micrófono y el candado. Mientras hay llamada, el
//     navegador pregunta antes de cerrar o recargar la pestaña.
//   · Kapta no recibe llamadas: un aviso que llega sin una llamada pedida en
//     esta pestaña, fuera de tiempo o de más se rechaza sin sonar (lo decide
//     `shouldAnswerInvite`).
//   · La pestaña recuerda en memoria las claves que Anura rechazó y la espera
//     tras un fallo (`browserAnuraPhoneMemory`), aunque se cierre la ficha.
//
// FRONTERA. Del servidor solo se importan TIPOS; las acciones llegan como
// funciones desde quien usa el hook.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AnuraStartResult } from "@/lib/anura/calls";
import {
  createAnuraPhone,
  type AnuraPhone,
  type AnuraPhoneCredentialsResult,
  type AnuraPhoneSnapshot,
  type AnuraRegistrationFailureKind,
} from "@/lib/anura/sip-phone";
import { browserAnuraPhoneMemory, browserAnuraTabLock, browserMicrophone, createJsSipUa } from "@/lib/anura/jssip-client";
import { logAnuraPhoneDiag } from "@/app/dashboard/pedidos/anura-actions";
import { ANURA_VOLUME_DEFAULT, ANURA_VOLUME_MAX, ANURA_VOLUME_MIN, ANURA_VOLUME_STEP, clampAnuraVolume } from "@/lib/anura/phone-ui";
import { readAnuraVolumePref, saveAnuraVolumePref } from "@/lib/anura/volume-pref";

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

/** Lo que el teléfono pide al servidor (server actions). */
export interface AnuraPhoneServer {
  /** Las credenciales del anexo PROPIO, en el momento de llamar. */
  fetchCredentials(): Promise<AnuraPhoneCredentialsResult>;
  /** Pide la llamada a Anura (Click2Dial). */
  requestCall(): Promise<AnuraStartResult>;
  /** Anura rechazó la clave (o no reconoce el dominio): el servidor lo marca. */
  reportRejected(input: { credentialVersion: string; kind: AnuraRegistrationFailureKind; status: number | null; domain?: string }): Promise<unknown>;
}

export function useAnuraKaptaPhone(server: AnuraPhoneServer) {
  const [snapshot, setSnapshot] = useState<AnuraPhoneSnapshot | null>(null);
  const phoneRef = useRef<AnuraPhone | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ampRef = useRef<Amplifier | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  /** En el clic de «Llamar»: crea o reanuda el AudioContext mientras Chrome lo permite. */
  const unlockAudio = useCallback(() => {
    if (!ctxRef.current || ctxRef.current.state === "closed") ctxRef.current = newAudioContext();
    void ctxRef.current?.resume().catch(() => undefined);
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
  // Las acciones más recientes (el pedido puede cambiar sin rehacer el teléfono).
  const serverRef = useRef(server);
  useEffect(() => {
    serverRef.current = server;
  }, [server]);
  const mounted = useRef(true);

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
        if (mounted.current) setSnapshot(s);
      },
      // Cada paso al log de Vercel (`[anura-phone]`), sin datos personales.
      diag: (event, data) => {
        void logAnuraPhoneDiag(event, data).catch(() => undefined);
      },
    });
    phoneRef.current = created;
    return created;
  }, []);

  // `unlockAudio` va primero y sin esperas: así corre dentro del clic.
  const call = useCallback(() => {
    unlockAudio();
    return phone().call();
  }, [phone, unlockAudio]);
  const hangUp = useCallback(() => phoneRef.current?.hangUp(), []);
  const setMuted = useCallback((muted: boolean) => phoneRef.current?.setMuted(muted), []);

  // Al cerrar la ficha o la pestaña: colgar, desregistrar y soltar todo.
  useEffect(() => {
    mounted.current = true;
    const onPageHide = () => phoneRef.current?.dispose();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", onPageHide);
      phoneRef.current?.dispose();
      phoneRef.current = null;
      stopAmplifier(ampRef.current);
      ampRef.current = null;
      void ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
    };
  }, []);

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

  return { snapshot, busy, call, hangUp, setMuted, audioRef, volume, setVolume };
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
