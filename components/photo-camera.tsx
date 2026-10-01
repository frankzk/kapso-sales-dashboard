"use client";

// La cámara DENTRO de la página, para la foto de la entrega, del rechazo y la
// captura del Yape (30-09-2026).
//
// Antes, el campo de foto usaba `<input capture>`, que abre la app de cámara de
// Android. En un celular con poca memoria, Android cierra Chrome mientras la
// cámara está al frente; al volver, Chrome dice «Memoria insuficiente para
// completar la operación anterior» y la foto se pierde (Roy, 30-09-2026). Con
// `getUserMedia` Chrome nunca deja de estar al frente, y el cuadro sale ya
// reducido (`fitWithin`): no hay una foto de 12 MB que decodificar ni subir.
//
// Se carga aparte (React.lazy desde PhotoCapture): quien no toma fotos no la
// descarga.

import { useEffect, useRef, useState } from "react";
import { classifyCameraError, type CameraFailure } from "@/lib/camera-error";
import { fitWithin, PHOTO_QUALITY } from "@/lib/photo-resize";
import { IconFlash, IconImage, IconX } from "@/components/icons";
import { cn } from "@/components/ui";

const FAILURE: Record<CameraFailure, string> = {
  unsupported: "Este navegador no abre la cámara aquí. Usa «Galería».",
  insecure: "La cámara solo funciona con el enlace seguro (https). Usa «Galería».",
  denied: "El navegador bloqueó la cámara. Toca el candado de la barra de direcciones, activa «Cámara» y vuelve a intentar. Mientras tanto, usa «Galería».",
  not_found: "No encontramos la cámara del celular. Usa «Galería».",
  in_use: "Otra aplicación está usando la cámara. Ciérrala y vuelve a intentar, o usa «Galería».",
  unknown: "No se pudo abrir la cámara. Usa «Galería».",
};

export function PhotoCamera({ title, onCapture, onClose, onGallery }: {
  title: string;
  /** El cuadro ya reducido, en JPEG. La cámara ya está apagada cuando llega. */
  onCapture: (photo: Blob) => void;
  onClose: () => void;
  /** Cambiar a la galería sin cerrar a mano. */
  onGallery: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<"abriendo" | "lista" | "error">("abriendo");
  const [failure, setFailure] = useState<string | null>(null);
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });
  const [shooting, setShooting] = useState(false);

  const stop = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    let cancelled = false;
    closeRef.current?.focus({ preventScroll: true });
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("sin getUserMedia"), { name: "TypeError" });
        // 1600 × 1200 ideal: lo que se sube, sin pedirle al sensor más de lo
        // que se va a guardar (menos memoria y menos calor).
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 }, height: { ideal: 1200 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        // La linterna no está en los tipos del DOM; Chrome en Android la ofrece.
        const caps = stream.getVideoTracks()[0]?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
        setTorch({ supported: Boolean(caps?.torch), on: false });
        setPhase("lista");
      } catch (error) {
        if (cancelled) return;
        setFailure(FAILURE[classifyCameraError(error, window.isSecureContext)]);
        setPhase("error");
      }
    })();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
      stop();
    };
    // La cámara se abre una vez por montaje; `onClose` puede cambiar de identidad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const on = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch({ supported: true, on });
    } catch {
      setTorch({ supported: false, on: false });
    }
  }

  async function shoot() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || shooting) return;
    setShooting(true);
    try {
      const { width, height } = fitWithin(video.videoWidth, video.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("canvas");
      ctx.drawImage(video, 0, 0, width, height);
      const photo = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
      // El lienzo y la cámara se sueltan YA: en un celular chico cada MB cuenta.
      canvas.width = 0;
      canvas.height = 0;
      if (!photo) throw new Error("toBlob");
      stop();
      onCapture(photo);
    } catch {
      setFailure("No se pudo tomar la foto. Vuelve a intentar o usa «Galería».");
      setPhase("error");
    } finally {
      setShooting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-[80] flex flex-col bg-black text-white">
      <div className="flex items-center justify-between gap-3 bg-black/60 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <p className="min-w-0 truncate text-base font-semibold">{title}</p>
        <button
          ref={closeRef}
          type="button"
          onClick={() => { stop(); onClose(); }}
          aria-label="Cerrar la cámara"
          className="-mr-2 grid size-12 shrink-0 place-items-center rounded-md text-white/90 transition-colors hover:bg-white/10"
        >
          <IconX className="size-6" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* `object-contain`: lo que se ve es lo que se guarda, sin recortes. */}
        <video ref={videoRef} muted playsInline className="absolute inset-0 h-full w-full object-contain" />
        {phase === "abriendo" && <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-white/80">Abriendo la cámara…</p>}
        {phase === "error" && failure && (
          <div role="alert" className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-lg bg-white p-4 text-sm text-ink-700 shadow-pop">
            <p className="font-semibold text-crit-fg">La cámara no abrió</p>
            <p className="mt-1">{failure}</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 items-center bg-black/60 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <button
          type="button"
          onClick={() => { stop(); onGallery(); }}
          className="flex flex-col items-center gap-1 justify-self-start rounded-md px-2 py-1 text-xs font-medium text-white/90 transition-colors hover:bg-white/10"
        >
          <IconImage className="size-6" />
          Galería
        </button>
        <button
          type="button"
          onClick={() => void shoot()}
          disabled={phase !== "lista" || shooting}
          aria-label="Tomar la foto"
          className="grid size-[4.5rem] place-items-center justify-self-center rounded-full ring-4 ring-inset ring-white transition-opacity disabled:opacity-40"
        >
          <span className={cn("size-14 rounded-full bg-white transition-transform duration-150", shooting && "scale-90")} />
        </button>
        {torch.supported ? (
          <button
            type="button"
            onClick={() => void toggleTorch()}
            aria-pressed={torch.on}
            className={cn("flex flex-col items-center gap-1 justify-self-end rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-white/10", torch.on ? "text-warn-bg" : "text-white/90")}
          >
            <IconFlash className="size-6" />
            {torch.on ? "Linterna sí" : "Linterna"}
          </button>
        ) : (
          <span aria-hidden />
        )}
      </div>
    </div>
  );
}
