"use client";

// «Kapta tiene mejoras nuevas» (owner, 24-11-2026: «puede ser, pero un aviso muy amigable»). Vercel deja cada pestaña
// en la versión con la que se abrió, y una pestaña de días seguía con reglas ya corregidas. Cada 5 minutos, y al
// volver a la pestaña, se pregunta la versión publicada (/api/version); si es otra, aparece una tarjeta pequeña abajo
// a la izquierda (arriba en el teléfono), lejos del teléfono de Anura y de los avisos de operación. No recarga sola ni
// tapa nada: «Recargar» cuando la persona quiera, «Ahora no» la esconde media hora.
import { useEffect, useState } from "react";
import { cn } from "@/components/ui";
import { opsButtonClass } from "@/components/ops-styles";
import { IconRepeat, IconX } from "@/components/icons";
import { isNewerBuild } from "@/lib/app-version";

const TAB_BUILD = process.env.NEXT_PUBLIC_KAPTA_BUILD ?? "";
const EVERY_MS = 5 * 60_000;
const MIN_GAP_MS = 60_000;
const SNOOZE_MS = 30 * 60_000;

export function NewVersionNotice() {
  const [newer, setNewer] = useState(false);
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!TAB_BUILD) return;
    let last = 0;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== "visible" || Date.now() - last < MIN_GAP_MS) return;
      last = Date.now();
      try {
        const res = await fetch(`/api/version?t=${last}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { build?: unknown };
        if (!stopped && isNewerBuild(TAB_BUILD, typeof body.build === "string" ? body.build : null)) setNewer(true);
      } catch {
        /* sin red: se vuelve a preguntar en la siguiente vuelta */
      }
    };
    const timer = window.setInterval(check, EVERY_MS);
    const onVisible = () => { void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // «Ahora no»: vuelve a aparecer pasada la media hora.
  useEffect(() => {
    if (!snoozedUntil) return;
    const wait = Math.max(0, snoozedUntil - Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), wait + 50);
    return () => window.clearTimeout(timer);
  }, [snoozedUntil]);

  const visible = newer && now >= snoozedUntil;
  // Entra en el cuadro siguiente para que la transición tenga desde dónde partir.
  useEffect(() => {
    if (!visible) { setShown(false); return; }
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  if (!visible) return null;
  const later = () => { const until = Date.now() + SNOOZE_MS; setSnoozedUntil(until); setNow(Date.now()); };
  return <NewVersionCard shown={shown} onReload={() => window.location.reload()} onLater={later} />;
}

/** La tarjeta, sin la consulta: pequeña, blanca, abajo a la izquierda (arriba en el teléfono). */
export function NewVersionCard({ shown, onReload, onLater }: { shown: boolean; onReload: () => void; onLater: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-4 top-4 z-[55] flex justify-center sm:inset-x-auto sm:top-auto sm:bottom-5 sm:left-5 sm:justify-start">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-auto w-full max-w-[22rem] rounded-xl bg-white p-4 shadow-pop",
          "transition duration-300 ease-out motion-reduce:transition-none",
          shown ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0 motion-reduce:translate-y-0",
        )}
      >
        <div className="flex items-start gap-3">
          <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600">
            <IconRepeat className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink-900">Kapta tiene mejoras nuevas</p>
            <p className="mt-0.5 text-sm leading-5 text-ink-600">
              Cuando termines lo que estás haciendo, recarga la página para usarlas.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={onReload} className={opsButtonClass("primary", "sm")}>
                Recargar
              </button>
              <button type="button" onClick={onLater} className={opsButtonClass("ghost", "sm")}>
                Ahora no
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onLater}
            aria-label="Cerrar el aviso"
            className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <IconX className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
