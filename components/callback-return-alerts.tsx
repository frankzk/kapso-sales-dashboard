"use client";

// «Tu cliente respondió» (owner, 16-11-2026; 0351, MOM «Bloques por asesora»).
// Cuando la clienta escribe después de que esta asesora agendó «Volver a
// llamar», el lead vuelve a ser solo suyo 10 minutos desde el mensaje. Este
// aviso se lo dice esté donde esté en Kapta, con la cuenta atrás de esos 10
// minutos y un botón para abrir el lead. Lee cada 15 s con la pestaña visible
// (`listCallbackReturns`); el apartado lo decide la base, el aviso solo avisa.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CallbackReturn } from "@/lib/callback-returns";
import { listCallbackReturns } from "@/lib/leads-read-client";
import { beep } from "@/components/yape-alerts";
import { CallbackReturnStack, keyOf } from "@/components/callback-return-stack";

const POLL_MS = 15_000;

export function CallbackReturnAlerts({ enabled = true }: { enabled?: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<CallbackReturn[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const dismissed = useRef<Set<string>>(new Set());
  const known = useRef<Set<string>>(new Set());
  const polling = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || polling.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    polling.current = true;
    let next: CallbackReturn[];
    try {
      next = await listCallbackReturns();
    } catch {
      return; // un error pasajero: se queda lo que había y se reintenta
    } finally {
      polling.current = false;
    }
    const visible = next.filter((item) => !dismissed.current.has(keyOf(item)));
    if (visible.some((item) => !known.current.has(keyOf(item)))) beep();
    known.current = new Set(visible.map(keyOf));
    setItems(visible);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      return;
    }
    void refresh();
    const poll = window.setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);

  // La cuenta atrás corre solo mientras hay algo que contar.
  useEffect(() => {
    if (!items.length) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [items.length]);

  const live = items.filter((item) => Date.parse(item.reservedUntil) > now);
  if (!enabled || !live.length) return null;

  function dismiss(item: CallbackReturn) {
    dismissed.current.add(keyOf(item));
    setItems((list) => list.filter((x) => keyOf(x) !== keyOf(item)));
  }

  function open(item: CallbackReturn) {
    dismiss(item);
    // `oid` sella esta pulsación (la cola solo cumple una orden de abrir una vez).
    router.push(`/dashboard/leads?store=${item.storeId}&view=${item.view}&open=${item.id}&oid=${Date.now()}`);
  }

  return <CallbackReturnStack items={live} now={now} onOpen={open} onDismiss={dismiss} />;
}
