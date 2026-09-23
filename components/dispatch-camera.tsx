"use client";

import { useEffect, useRef, useState } from "react";
import { cameraErrorMessage } from "@/lib/camera-error";
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
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const handledRef = useRef(false);
  const lastRef = useRef<{ code: string; at: number } | null>(null);
  const finished = Boolean(continuous && progress && scanProgressDone(progress));
  useEffect(() => {
    if (!open || !finished) return;
    const t = window.setTimeout(onClose, AUTO_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open, finished, onClose]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus({ preventScroll: true }); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    handledRef.current = false;
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        if (cancelled || !videoRef.current) return;
        const reader = new BrowserQRCodeReader();
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } }, audio: false },
          videoRef.current,
          (result) => {
            if (!result || handledRef.current) return;
            const text = result.getText();
            if (continuous) {
              // Sigue leyendo: solo se descarta el mismo código repetido
              // seguido (el lector lo ve varias veces por segundo).
              const now = Date.now();
              if (lastRef.current && lastRef.current.code === text && now - lastRef.current.at < REPEAT_MS) return;
              lastRef.current = { code: text, at: now };
              window.navigator.vibrate?.(80);
              onScan(text);
              return;
            }
            handledRef.current = true;
            controlsRef.current?.stop();
            window.navigator.vibrate?.(80);
            onScan(text);
            onClose();
          },
        );
        if (cancelled || handledRef.current) controls.stop();
        else controlsRef.current = controls;
      } catch (err) {
        if (cancelled) return;
        // El error crudo va a la consola: es lo único que distingue un permiso
        // denegado a mano de uno bloqueado por la Permissions-Policy del server.
        console.error("[dispatch-camera] getUserMedia falló", err);
        setError(cameraErrorMessage(err, window.isSecureContext));
      }
    })();
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [open, onClose, onScan, continuous]);

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="dispatch-camera-title" onKeyDown={(event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") { event.preventDefault(); closeRef.current?.focus(); }
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
        <div className="relative aspect-[4/3] max-h-[60dvh] overflow-hidden bg-slate-950">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-[16%] rounded-3xl border-2 border-white/90 shadow-[0_0_0_999px_rgba(2,6,23,.28)]" />
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
            {status && <p role="status" className={status.ok ? "mt-2 text-sm text-emerald-700" : "mt-2 text-sm text-red-700"}>{status.text}</p>}
          </div>
        )}
        {error && <p role="alert" className="bg-red-50 px-5 py-3 text-sm text-red-700">{error} Puedes cerrar la cámara y escribir el código.</p>}
      </div>
    </div>
  );
}
