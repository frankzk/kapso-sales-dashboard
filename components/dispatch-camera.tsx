"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { cameraErrorMessage } from "@/lib/camera-error";
import { CameraSessionError, startDispatchCamera } from "@/lib/dispatch-camera-session";
import { scanProgressDone, scanProgressText, type ScanProgress } from "@/lib/scan-progress";
import { cn } from "@/components/ui";

/** Un mismo QR leído dos veces seguidas en menos de esto se ignora. */
const REPEAT_MS = 2500;
/** Con todo confirmado, la cámara se cierra sola tras este tiempo. */
const AUTO_CLOSE_MS = 1000;

export function DispatchCamera({
  open,
  onClose,
  onScan,
  continuous = false,
  progress,
  status,
  pending = 0,
  lastCaptured,
  issues = [],
}: {
  open: boolean;
  onClose: () => void;
  onScan: (value: string) => void;
  /**
   * Escaneo continuo: tras cada lectura la cámara sigue abierta leyendo el
   * siguiente paquete; se cierra con «Listo» o sola cuando `progress` llega
   * al total. Sin esto, la primera lectura cierra la cámara (comportamiento
   * de siempre).
   */
  continuous?: boolean;
  /** Avance bajo el visor: «Confirmados X de N · faltan Y». */
  progress?: ScanProgress;
  /** Última lectura: qué pasó con el código anterior, sin cerrar la cámara. */
  status?: { ok: boolean; text: string } | null;
  /** Read locally, but not yet confirmed by the server. */
  pending?: number;
  lastCaptured?: string | null;
  /** Failed saves remain visible even if a later package succeeds. */
  issues?: string[];
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Parent callbacks change after every scan; they must not reopen the camera.
  const scanLatest = useEffectEvent((value: string) => onScan(value));
  const closeLatest = useEffectEvent(() => onClose());
  const finished = Boolean(continuous && pending === 0 && issues.length === 0 && progress && scanProgressDone(progress));
  useEffect(() => {
    if (!open || !finished) return;
    const t = window.setTimeout(() => closeLatest(), AUTO_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open, finished]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  useEffect(() => {
    if (!open) return;
    const visibility = () => setPageVisible(document.visibilityState !== "hidden");
    const restored = (event: PageTransitionEvent) => { if (event.persisted) setAttempt((value) => value + 1); };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pageshow", restored);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pageshow", restored);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus({ preventScroll: true }); };
  }, [open]);

  useEffect(() => {
    if (!open || !pageVisible) return;
    setError(null);
    setStarting(true);
    if (!videoRef.current) return;
    let handled = false;
    let last: { code: string; at: number } | null = null;
    const session = startDispatchCamera(videoRef.current, {
      onScan: (text) => {
        if (handled) return;
        if (continuous) {
          const now = Date.now();
          if (last && last.code === text && now - last.at < REPEAT_MS) return;
          last = { code: text, at: now };
        } else {
          handled = true;
          session.stop();
        }
        window.navigator.vibrate?.(80);
        scanLatest(text);
        if (!continuous) closeLatest();
      },
      onReady: () => setStarting(false),
      onError: (err) => {
        console.error("[dispatch-camera] cámara interrumpida", err);
        setStarting(false);
        setError(err instanceof CameraSessionError ? err.message : cameraErrorMessage(err, window.isSecureContext));
      },
    });
    return () => session.stop();
  }, [open, continuous, attempt, pageVisible]);

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="dispatch-camera-title" onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/70 p-0 sm:items-center sm:p-6">
      <div className="max-h-[95dvh] w-full overflow-y-auto rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <p id="dispatch-camera-title" className="font-semibold text-slate-950">Escanear QR</p>
            <p className="text-xs text-slate-500">{continuous ? "Apunta a cada rótulo; la cámara sigue abierta hasta que termines." : "Apunta al rótulo hasta que vibre el lector."}</p>
          </div>
          {continuous
            ? <button ref={closeRef} type="button" onClick={onClose} className="min-h-10 shrink-0 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800">Listo</button>
            : <button ref={closeRef} type="button" onClick={onClose} className="grid size-12 shrink-0 place-items-center rounded-full bg-slate-100 text-lg" aria-label="Cerrar cámara">×</button>}
        </div>
        <div role="status" aria-live="polite" aria-atomic="true" className={cn(
          "sticky top-0 z-10 border-b px-5 py-3 text-base font-semibold leading-snug break-words",
          status ? (status.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-800") : "border-slate-200 bg-slate-50 text-slate-600",
        )}>
          {status?.text ?? (pending > 0 ? "Lectura recibida" : "Apunta al QR del pedido para escanear.")}
          {pending > 0 && <p className="mt-1 text-sm font-medium text-slate-700">
            {lastCaptured ? `Leído: ${lastCaptured}. ` : ""}{pending} por confirmar. Puedes seguir escaneando.
          </p>}
          {issues.length > 0 && <div className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-800">
            <p className="font-semibold">{issues.length} sin confirmar · vuelve a escanear</p>
            <ul className="mt-1 max-h-24 overflow-y-auto font-normal">
              {issues.map((text) => <li key={text} className="py-1">{text}</li>)}
            </ul>
          </div>}
        </div>
        {error && <p role="alert" className="bg-red-50 px-5 py-3 text-sm text-red-700">{error}</p>}
        <div className="relative aspect-[4/3] max-h-[60dvh] overflow-hidden bg-slate-950">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-[16%] rounded-3xl border-2 border-white/90 shadow-[0_0_0_999px_rgba(2,6,23,.28)]" />
          {starting && <p role="status" className="absolute inset-0 grid place-items-center bg-slate-950/80 text-sm font-medium text-white">Abriendo cámara…</p>}
        </div>
        {continuous && progress && (
          <div className="px-5 py-3" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-sm">
              {/* 20 px: se lee de un vistazo con la pistola en la mano. */}
              <span className={cn("text-[20px] leading-tight", finished ? "font-semibold text-emerald-700" : "font-medium text-slate-800")}>{scanProgressText(progress)}</span>
              {progress.total != null && <span className="text-xs tabular-nums text-slate-500">{Math.min(progress.done, progress.total)}/{progress.total}</span>}
            </div>
            {progress.total != null && (
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0}%` }} />
              </div>
            )}
          </div>
        )}
        <div className="px-5 pb-3 pt-2">
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Reiniciar cámara</button>
        </div>
      </div>
    </div>
  );
}
