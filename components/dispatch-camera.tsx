"use client";

import { useEffect, useRef, useState } from "react";

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
  const [error, setError] = useState<string | null>(null);

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
        controlsRef.current = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } }, audio: false },
          videoRef.current,
          (result) => {
            if (!result || handledRef.current) return;
            handledRef.current = true;
            controlsRef.current?.stop();
            onScan(result.getText());
            onClose();
          },
        );
      } catch {
        setError("No pudimos abrir la cámara. Revisa el permiso o usa el campo manual.");
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
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/70 p-0 sm:items-center sm:p-6">
      <div className="w-full overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:max-w-lg sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <p className="font-semibold text-slate-950">Escanear QR</p>
            <p className="text-xs text-slate-500">Apunta al rótulo hasta que vibre el lector.</p>
          </div>
          <button onClick={onClose} className="grid size-10 place-items-center rounded-full bg-slate-100 text-lg" aria-label="Cerrar cámara">×</button>
        </div>
        <div className="relative aspect-square bg-slate-950 sm:aspect-[4/3]">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-[16%] rounded-3xl border-2 border-white/90 shadow-[0_0_0_999px_rgba(2,6,23,.28)]" />
        </div>
        {error && <p className="bg-red-50 px-5 py-3 text-sm text-red-700">{error}</p>}
      </div>
    </div>
  );
}

