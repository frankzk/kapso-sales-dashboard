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
  nodes: AudioNode[];
}

function startAmplifier(stream: MediaStream, volume: number): Amplifier | null {
  try {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    source.connect(gain);
    gain.connect(comp);
    comp.connect(ctx.destination);
    void ctx.resume().catch(() => undefined);
    return { ctx, gain, nodes: [source, gain, comp] };
  } catch {
    return null;
  }
}

function stopAmplifier(amp: Amplifier | null) {
  if (!amp) return;
  for (const n of amp.nodes) {
    try {
      n.disconnect();
    } catch {
      // ya desconectado
    }
  }
  void amp.ctx.close().catch(() => undefined);
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
        const amp = startAmplifier(stream as MediaStream, volumeRef.current);
        ampRef.current = amp;
        // Con amplificador, el <audio> queda enganchado pero mudo (si no, se oiría doble).
        el.muted = amp !== null;
        el.volume = 1;
        void logAnuraPhoneDiag("audio_amplificador", { ok: amp !== null, estado: amp?.ctx.state ?? null, volumen: volumeRef.current }).catch(() => undefined);
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

  const call = useCallback(() => phone().call(), [phone]);
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
