"use client";

import { useEffect, useRef, useState } from "react";
import { cameraErrorMessage } from "@/lib/camera-error";

export function DispatchCamera({
  open,
  onClose,
  onScan,
}: {
  open: boolean;
  onClose: () => void;
  onScan: (value: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const handledRef = useRef(false);
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
            handledRef.current = true;
            controlsRef.current?.stop();
            window.navigator.vibrate?.(80);
            onScan(result.getText());
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
  }, [open, onClose, onScan]);

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
            <p className="text-xs text-slate-500">Apunta al rótulo hasta que vibre el lector.</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="grid size-12 shrink-0 place-items-center rounded-full bg-slate-100 text-lg" aria-label="Cerrar cámara">×</button>
        </div>
        <div className="relative aspect-[4/3] max-h-[60dvh] overflow-hidden bg-slate-950">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-[16%] rounded-3xl border-2 border-white/90 shadow-[0_0_0_999px_rgba(2,6,23,.28)]" />
        </div>
        {error && <p role="alert" className="bg-red-50 px-5 py-3 text-sm text-red-700">{error} Puedes cerrar la cámara y escribir el código.</p>}
      </div>
    </div>
  );
}
