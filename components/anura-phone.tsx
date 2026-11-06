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

/** Lo que el teléfono pide al servidor (server actions). */
export interface AnuraPhoneServer {
  /** Las credenciales del anexo PROPIO, en el momento de llamar. */
  fetchCredentials(): Promise<AnuraPhoneCredentialsResult>;
  /** Pide la llamada a Anura (Click2Dial). */
  requestCall(): Promise<AnuraStartResult>;
  /** Anura rechazó la clave: el servidor la marca «clave rechazada». */
  reportRejected(input: { credentialVersion: string; kind: AnuraRegistrationFailureKind; status: number | null }): Promise<unknown>;
}

export function useAnuraKaptaPhone(server: AnuraPhoneServer) {
  const [snapshot, setSnapshot] = useState<AnuraPhoneSnapshot | null>(null);
  const phoneRef = useRef<AnuraPhone | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
        if (!el) return;
        el.srcObject = (stream as MediaStream | null) ?? null;
        if (stream) void el.play().catch(() => undefined);
      },
      onChange: (s) => {
        if (mounted.current) setSnapshot(s);
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

  return { snapshot, busy, call, hangUp, setMuted, audioRef };
}

/** El audio de Anura. Fuera de la tarjeta, para que exista antes de contestar. */
export function AnuraPhoneAudio({ audioRef }: { audioRef: RefObject<HTMLAudioElement | null> }) {
  return <audio ref={audioRef} autoPlay hidden />;
}
