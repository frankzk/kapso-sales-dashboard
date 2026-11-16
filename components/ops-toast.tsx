"use client";

// El aviso flotante del mundo de operación (owner, 16-11-2026: «esa alerta en
// verde que salga como un popup también»). Es el toast del panel de Stripe:
// una tarjeta oscura de tinta (`ink-900`), corta, con el resultado en una
// línea y su dato debajo, que aparece donde está la mano —abajo a la derecha
// en el escritorio, arriba en el teléfono, lejos de la barra de lote— y se va
// sola. No reemplaza el aviso de la página: lo repite donde se mira, para que
// el éxito de una acción hecha en una hoja anclada no pase inadvertido.
//
// Se queda mientras el puntero o el foco están encima (WCAG 2.2.1) y se cierra
// con Esc o con su «x». Entra con un desplazamiento corto y salida exponencial;
// con movimiento reducido, sin desplazamiento.
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { IconCheck, IconX } from "@/components/icons";

export interface OpsToastData {
  /** Un id por aviso: uno nuevo reinicia el reloj aunque diga lo mismo. */
  id: number;
  title: string;
  detail?: string | null;
  action?: { label: string; onClick: () => void } | null;
}

/** Cuánto se queda a la vista sin el puntero encima. */
export const OPS_TOAST_MS = 6000;

export function OpsToast({ toast, onClose }: { toast: OpsToastData | null; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  const [shown, setShown] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);

  // Entra en el cuadro siguiente: así la transición tiene desde dónde partir.
  useEffect(() => {
    setShown(false);
    if (!toast) return;
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [toast]);

  useEffect(() => {
    if (!toast || paused) return;
    const timer = window.setTimeout(close, OPS_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast, paused, close]);

  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-4 top-4 z-[60] flex justify-center sm:inset-x-auto sm:top-auto sm:bottom-6 sm:right-6 sm:justify-end">
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false); }}
        onKeyDown={(e) => { if (e.key === "Escape") close(); }}
        className={cn(
          "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg bg-ink-900 py-3 pl-3.5 pr-2 text-white shadow-pop",
          "transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-opacity",
          shown ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0 motion-reduce:translate-y-0",
        )}
      >
        <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-ok-bg text-ok-fg" aria-hidden="true">
          <IconCheck className="size-3.5" strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-5">{toast.title}</p>
          {toast.detail && (
            // Cada tramo entre «·» se queda entero («S/ 13.50», la fecha): la línea se parte entre tramos.
            <p className="mt-0.5 text-[13px] leading-5 text-white/70 tabular-nums">
              {toast.detail.split(" · ").map((part, i, parts) => (
                <span key={i}>
                  <span className="inline-block max-w-full [overflow-wrap:anywhere]">
                    {part}
                    {i < parts.length - 1 && <span aria-hidden="true">&nbsp;·</span>}
                  </span>
                  {i < parts.length - 1 && " "}
                </span>
              ))}
            </p>
          )}
          {toast.action && (
            <button
              type="button"
              onClick={() => { toast.action!.onClick(); close(); }}
              className="-ml-1 mt-1.5 inline-flex h-8 items-center rounded-md px-1 text-[13px] font-semibold text-brand-200 underline-offset-4 hover:text-white hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-300 pointer-coarse:h-11"
            >
              {toast.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Cerrar el aviso"
          className="grid size-8 shrink-0 place-items-center rounded-md text-white/60 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-300 pointer-coarse:size-11"
        >
          <IconX className="size-4" />
        </button>
      </div>
    </div>
  );
}
