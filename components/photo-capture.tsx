"use client";

// La evidencia de una parada: foto de la entrega, captura del Yape o foto del
// rechazo (30-09-2026, tras la captura de Roy con «Memoria insuficiente…»).
//
//   - «Cámara» abre la cámara DENTRO de la página (`PhotoCamera`): Chrome no
//     sale al frente de otra app y Android no lo cierra por memoria.
//   - «Galería» elige una foto ya tomada o la captura del Yape que mandó el
//     cliente. Es un `<input type="file">` SIN `capture`, para que Android deje
//     elegir el archivo en vez de forzar la cámara.
//   - Toda foto se reduce antes de subir (1600 px, JPEG): pesa cientos de KB,
//     no varios MB, y siempre entra bajo el corte de 4,5 MB de Vercel.
//   - Si la subida falla, la foto ya reducida se guarda en memoria y
//     «Reintentar» la vuelve a mandar sin tomarla otra vez.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { canUploadAsIs, fitWithin, PHOTO_QUALITY, PHOTO_UPLOAD_LIMIT } from "@/lib/photo-resize";
import { IconCamera, IconCheckCircle, IconImage } from "@/components/icons";
import { cn } from "@/components/ui";

const PhotoCamera = lazy(() => import("@/components/photo-camera").then((m) => ({ default: m.PhotoCamera })));

export interface PhotoCaptureResult {
  error?: string;
  notice?: string;
  path?: string;
}

type Phase = "idle" | "preparing" | "uploading" | "failed";

/** Un error que ya viene dicho para el motorizado. */
class PhotoError extends Error {}

/** Reduce la foto elegida a 1600 px en JPEG; un JPEG ya chico se sube tal cual. */
async function shrink(file: File): Promise<Blob> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bitmap = null;
  }
  if (!bitmap) {
    // Sin decodificar (p. ej. HEIC en Chrome): se manda tal cual si entra.
    if (file.size <= PHOTO_UPLOAD_LIMIT) return file;
    throw new PhotoError("No se pudo leer esa foto y pesa demasiado para subirla. Toma otra con «Cámara».");
  }
  try {
    if (canUploadAsIs(file, bitmap)) return file;
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("canvas");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    canvas.width = 0;
    canvas.height = 0;
    if (!out) throw new Error("toBlob");
    return out;
  } finally {
    bitmap.close();
  }
}

async function upload(photo: Blob, stopId: string, kind: "entrega" | "yape"): Promise<string> {
  const fd = new FormData();
  const name = photo instanceof File && photo.name ? photo.name : `${kind}.jpg`;
  fd.append("file", photo, name);
  fd.append("stopId", stopId);
  fd.append("kind", kind);
  const res = await fetch("/api/reparto/foto", { method: "POST", body: fd });
  let json: { path?: string; error?: string } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // Un corte de la plataforma (413) no responde JSON.
  }
  if (!res.ok || !json.path) {
    throw new PhotoError(json.error ?? (res.status === 413 ? "La foto pesa demasiado. Toma otra con «Cámara»." : "No se pudo subir la foto."));
  }
  return json.path;
}

export function PhotoCapture({ stopId, kind, label, photoPath, disabled = false, onResult }: {
  stopId?: string;
  kind: "entrega" | "yape";
  label: string;
  /** La foto ya guardada en la parada, si hay. */
  photoPath: string | null;
  disabled?: boolean;
  onResult: (result: PhotoCaptureResult) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const pending = useRef<Blob | null>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  // La miniatura es un objeto en memoria: se suelta al cambiarla o al salir.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function send(photo: Blob) {
    if (!stopId) return onResult({ error: "Falta la parada." });
    pending.current = photo;
    setFailure(null);
    setPhase("uploading");
    try {
      const path = await upload(photo, stopId, kind);
      pending.current = null;
      setPreview(URL.createObjectURL(photo));
      setPhase("idle");
      onResult({ path, notice: "Foto lista." });
    } catch (error) {
      // Sin respuesta del servidor (sin señal): `fetch` rechaza con TypeError.
      const message = error instanceof PhotoError ? error.message : "No se pudo subir la foto. Revisa tu señal.";
      setFailure(message);
      setPhase("failed");
      onResult({ error: message });
    }
  }

  async function fromGallery(file: File) {
    pending.current = null;
    setFailure(null);
    setPhase("preparing");
    try {
      await send(await shrink(file));
    } catch (error) {
      const message = error instanceof PhotoError ? error.message : "No se pudo preparar esa foto. Prueba con «Cámara».";
      setFailure(message);
      setPhase("idle");
      onResult({ error: message });
    }
  }

  const busy = phase === "preparing" || phase === "uploading";
  const done = Boolean(photoPath) && phase !== "failed";
  const status = phase === "preparing" ? "Preparando la foto…" : phase === "uploading" ? "Subiendo…" : done ? "Lista" : null;

  return (
    <div className={cn("rounded-lg bg-white p-3 shadow-control ring-1 ring-inset", phase === "failed" ? "ring-crit-fg/40" : "ring-line")}>
      <div className="flex items-center gap-3">
        <div className="relative grid size-14 shrink-0 place-items-center overflow-hidden rounded-md bg-wash text-ink-500">
          {preview && done ? (
            // La miniatura es la foto ya reducida que se subió, en memoria.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" className="size-full object-cover" />
          ) : done ? (
            <IconCheckCircle className="size-6 text-ok-fg" />
          ) : (
            <IconCamera className="size-6" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-900">{label}</p>
          <p aria-live="polite" className={cn("text-xs", done && !busy ? "font-medium text-ok-fg" : "text-ink-500")}>
            {status ?? (phase === "failed" ? "No se subió" : "Obligatoria")}
            {done && !busy && photoPath && !preview && (
              <> · <a href={`/api/reparto/foto?path=${encodeURIComponent(photoPath)}`} target="_blank" rel="noreferrer" className="font-medium text-brand-700 underline underline-offset-2">Ver</a></>
            )}
          </p>
        </div>
      </div>
      {busy && <div aria-hidden className="mt-3 h-1 overflow-hidden rounded-full bg-line"><div className="h-full w-1/3 animate-[photo-progress_1.1s_ease-in-out_infinite] rounded-full bg-brand-600" /></div>}
      {failure && <p role="alert" className="mt-2 text-sm text-crit-fg">{failure}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {phase === "failed" && pending.current ? (
          <button type="button" disabled={disabled} onClick={() => pending.current && void send(pending.current)} className="col-span-2 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-white text-sm font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-wash disabled:opacity-50">
            Reintentar la subida
          </button>
        ) : null}
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => setCameraOpen(true)}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-white text-sm font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-wash hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <IconCamera className="size-5 shrink-0" />
          {done ? "Otra foto" : "Cámara"}
        </button>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => galleryRef.current?.click()}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-white text-sm font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-wash hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <IconImage className="size-5 shrink-0" />
          Galería
        </button>
      </div>
      {/* Sin `capture`: Android ofrece la galería y los archivos, no fuerza la cámara. */}
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={`${label}: elegir de la galería`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void fromGallery(file);
        }}
      />
      {cameraOpen && (
        <Suspense fallback={<div className="fixed inset-0 z-[80] bg-black" aria-hidden />}>
          <PhotoCamera
            title={label}
            onClose={() => setCameraOpen(false)}
            onGallery={() => { setCameraOpen(false); galleryRef.current?.click(); }}
            onCapture={(photo) => { setCameraOpen(false); void send(photo); }}
          />
        </Suspense>
      )}
    </div>
  );
}
