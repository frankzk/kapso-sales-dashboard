"use client";

// El aviso flotante de la cola de cobranza del número de Shalom.
//
// Hermano del de «Yape/Shalom por verificar», y a propósito distinto en dos
// cosas: aquí la alerta tiene DUEÑO —no se compite por tomarla— y trae el
// pedido y el importe delante, porque quien la atiende va a validar un pago
// concreto, no a investigar quién escribió.
//
// NO PIDE GESTOS. Dice una sola cosa: esto está esperando, ve a hacerlo. Las
// alertas se cierran con el HECHO que las resuelve —el pago validado, el
// comprobante subido— y no con un clic de confirmación, que es el clic que se
// deja de dar a la semana y deja la cola llena de trabajo ya hecho. El único
// botón es «Descartar», para lo que nunca se va a resolver solo.
//
// Sondea cada 20 s y solo con la pestaña visible: es una cola de minutos, no
// de segundos, y una pestaña de fondo no necesita gastar consultas.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  discardCollectionAlert,
  listMyCollectionAlerts,
  type CollectionAlertView,
} from "@/app/dashboard/cobranza/actions";

const POLL_MS = 20_000;

const TITULO: Record<CollectionAlertView["kind"], string> = {
  registrado: "Comprobante por validar",
  sin_atribuir: "Llegó un pago y no se sabe de qué pedido es",
};

export function CollectionAlerts({ enabled = true }: { enabled?: boolean }) {
  const [alerts, setAlerts] = useState<CollectionAlertView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const vistos = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const next = await listMyCollectionAlerts();
      setAlerts(next);
      // Un sonido corto la primera vez que aparece una: si estás en otra
      // pantalla, el pop-up solo no basta.
      const nueva = next.some((a) => !vistos.current.has(a.id));
      for (const a of next) vistos.current.add(a.id);
      if (nueva) beep();
    } catch {
      /* una pasada fallida no tira la cola: se reintenta en la siguiente */
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    const onVis = () => void poll();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, poll]);

  if (!enabled || !alerts.length) return null;

  const run = async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(id);
    setMsg(null);
    const res = await fn();
    setBusy(null);
    if (!res.ok) setMsg(res.error ?? "No se pudo.");
    await poll();
    router.refresh();
  };

  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {alerts.slice(0, 3).map((a) => (
        <div key={a.id} className="rounded-xl border border-amber-300 bg-white p-3 shadow-lg">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">{TITULO[a.kind]}</p>
            <span className="shrink-0 text-xs text-slate-400">{a.waitingMinutes} min</span>
          </div>

          <p className="mt-1 text-sm text-slate-700">
            {a.orderName ? <strong>{a.orderName}</strong> : "Pedido sin identificar"}
            {a.amount != null && <> · S/ {a.amount.toFixed(2)}</>}
          </p>
          {a.phone && <p className="text-xs text-slate-500">{a.phone}</p>}
          {a.detail && <p className="mt-1 text-xs text-slate-500">{a.detail}</p>}
          <p className="mt-1 text-xs text-slate-400">
            {a.storeName}
            {a.escalations > 0 && ` · escaló ${a.escalations} ${a.escalations === 1 ? "vez" : "veces"}`}
          </p>

          <div className="mt-2 flex flex-wrap gap-2">
            {a.kind === "registrado" && a.orderId && (
              <a
                href={`/dashboard/pagos?order=${a.orderId}`}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                Ir a validar
              </a>
            )}
            {/* Lo único que se cierra a mano: lo que nunca se va a resolver
                solo. El resto se cierra con el hecho —el pago validado, el
                comprobante subido— sin pedir ningún clic de confirmación. */}
            <button
              type="button"
              disabled={busy === a.id}
              onClick={() => {
                const motivo = window.prompt("¿Por qué se descarta?", "no es un comprobante");
                if (motivo === null) return;
                void run(a.id, () => discardCollectionAlert(a.id, motivo));
              }}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              Descartar
            </button>
          </div>
        </div>
      ))}
      {alerts.length > 3 && (
        <p className="text-right text-xs text-slate-500">y {alerts.length - 3} más esperando</p>
      )}
      {msg && <p className="text-right text-xs text-red-600">{msg}</p>}
    </div>
  );
}

/** Aviso corto por WebAudio, sin fichero. Si el navegador lo bloquea, calla. */
function beep() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    /* sin sonido, el pop-up sigue ahí */
  }
}
