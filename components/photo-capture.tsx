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
//   - La que el celular no puede abrir para achicarla y pesa más de 4 MB (una
//     foto de 50 MP de la pantalla del cliente, un HEIC) sube ENTERA directo a
//     Storage y la reduce el servidor (08-10-2026, el Yape de #KP139761 que
//     Roy no podía adjuntar). Antes salía «pesa demasiado» y no había salida.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { canUploadAsIs, decodeResize, fitWithin, PHOTO_DIRECT_LIMIT, PHOTO_HEADER_BYTES, PHOTO_QUALITY, PHOTO_UPLOAD_LIMIT, readImageSize } from "@/lib/photo-resize";
import { Banner } from "@/components/ops-ui";
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

/** El celular no pudo achicarla y no entra por la subida normal: va directo. */
class NeedsDirectUpload extends Error {}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Abre la foto para achicarla. Primero YA reducida (poca memoria); si el
 * navegador no acepta esas opciones —Chrome viejo— o no puede, y la foto es
 * liviana, se prueba entera y después con una `<img>`. Una foto pesada que no
 * abrió reducida no se abre entera: es justo la que se queda sin memoria, y la
 * achica el servidor.
 */
async function decode(file: File, size: { width: number; height: number } | null): Promise<Decoded | null> {
  const fromBitmap = (b: ImageBitmap): Decoded => ({ source: b, width: b.width, height: b.height, release: () => b.close() });
  try {
    return fromBitmap(await createImageBitmap(file, { imageOrientation: "from-image", resizeQuality: "medium", ...decodeResize(size) }));
  } catch {
    if (file.size > PHOTO_UPLOAD_LIMIT) return null;
  }
  try {
    return fromBitmap(await createImageBitmap(file));
  } catch {
    // sigue con la <img>
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("vacía");
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/**
 * Reduce la foto elegida a 1600 px en JPEG; un JPEG ya chico se sube tal cual.
 * Las medidas se leen de la cabecera y el navegador la decodifica YA reducida:
 * una foto de 12 MP no ocupa 48 MB de memoria antes de achicarse.
 */
async function shrink(file: File): Promise<Blob> {
  let size: { width: number; height: number } | null = null;
  try {
    size = readImageSize(new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer()));
  } catch {
    size = null;
  }
  if (size && canUploadAsIs(file, size)) return file;
  const image = await decode(file, size);
  if (!image) {
    // Sin decodificar (p. ej. HEIC en Chrome): se manda tal cual si entra; si
    // no, sube entera directo a Storage y la achica el servidor.
    if (file.size <= PHOTO_UPLOAD_LIMIT) return file;
    throw new NeedsDirectUpload();
  }
  try {
    const { width, height } = fitWithin(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image.source, 0, 0, width, height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    canvas.width = 0;
    canvas.height = 0;
    if (!out) throw new Error("toBlob");
    return out;
  } finally {
    image.release();
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

async function postJson<T>(body: Record<string, unknown>): Promise<T & { error?: string }> {
  const res = await fetch("/api/reparto/foto", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = {} as T & { error?: string };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // sin JSON: abajo se dice en palabras
  }
  if (!res.ok) throw new PhotoError(json.error ?? "No se pudo subir la foto.");
  return json;
}

/**
 * La foto entera, directo a Storage con un permiso de un solo uso, y después el
 * servidor la achica. No pasa por la función de subida, así que no la corta
 * el límite de 4,5 MB de Vercel.
 */
async function uploadDirect(file: File, stopId: string, kind: "entrega" | "yape"): Promise<string> {
  if (file.size > PHOTO_DIRECT_LIMIT) throw new PhotoError("Esa foto pesa más de 25 MB. Tómala con «Cámara».");
  const signed = await postJson<{ path?: string; token?: string }>({ action: "firmar", stopId, kind, type: file.type, size: file.size });
  if (!signed.path || !signed.token) throw new PhotoError("No se pudo preparar la subida.");
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, "");
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const body = new FormData();
  body.append("cacheControl", "3600");
  body.append("", file);
  const put = await fetch(
    `${base}/storage/v1/object/upload/sign/delivery-proofs/${signed.path.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(signed.token)}`,
    { method: "PUT", body, headers: { apikey: key, Authorization: `Bearer ${key}`, "x-upsert": "false" } },
  );
  if (!put.ok) throw new PhotoError("No se pudo subir la foto.");
  const reduced = await postJson<{ path?: string }>({ action: "reducir", stopId, kind, path: signed.path });
  if (!reduced.path) throw new PhotoError("No se pudo subir la foto.");
  return reduced.path;
}

export function PhotoCapture({ stopId, kind, label, photoPath, disabled = false, onResult, fieldRef }: {
  stopId?: string;
  kind: "entrega" | "yape";
  label: string;
  /** La foto ya guardada en la parada, si hay. */
  photoPath: string | null;
  disabled?: boolean;
  onResult: (result: PhotoCaptureResult) => void;
  /** Para que «Guardar» lleve al campo cuando falta la foto. */
  fieldRef?: (el: HTMLDivElement | null) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ title: string; text: string } | null>(null);
  const pending = useRef<Blob | null>(null);
  /** El pendiente es una foto que va por la subida directa. */
  const direct = useRef(false);
  const galleryRef = useRef<HTMLInputElement>(null);

  // La miniatura es un objeto en memoria: se suelta al cambiarla o al salir.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function send(photo: Blob) {
    if (!stopId) return onResult({ error: "Falta la parada." });
    pending.current = photo;
    direct.current = false;
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
      const message = error instanceof PhotoError ? error.message : "Revisa tu señal y vuelve a intentar.";
      setFailure({ title: "No se subió la foto", text: message });
      setPhase("failed");
      onResult({ error: message });
    }
  }

  /** La foto pesada que el celular no pudo achicar: sube entera y la achica el servidor. */
  async function sendDirect(file: File) {
    if (!stopId) return onResult({ error: "Falta la parada." });
    pending.current = file;
    direct.current = true;
    setFailure(null);
    setPhase("uploading");
    try {
      const path = await uploadDirect(file, stopId, kind);
      pending.current = null;
      direct.current = false;
      // Sin miniatura: abrir entera una foto que el celular no pudo achicar es
      // lo que lo deja sin memoria. El cuadro la enseña desde el servidor.
      setPreview(null);
      setPhase("idle");
      onResult({ path, notice: "Foto lista." });
    } catch (error) {
      const message = error instanceof PhotoError ? error.message : "Revisa tu señal y vuelve a intentar.";
      setFailure({ title: "No se subió la foto", text: message });
      setPhase("failed");
      onResult({ error: message });
    }
  }

  async function fromGallery(file: File) {
    pending.current = null;
    direct.current = false;
    setFailure(null);
    setPhase("preparing");
    try {
      await send(await shrink(file));
    } catch (error) {
      if (error instanceof NeedsDirectUpload) return void sendDirect(file);
      const message = error instanceof PhotoError ? error.message : "Prueba con otra foto o tómala con «Cámara».";
      setFailure({ title: "No se pudo usar esa foto", text: message });
      setPhase("idle");
      onResult({ error: message });
    }
  }

  const busy = phase === "preparing" || phase === "uploading";
  const done = Boolean(photoPath) && phase !== "failed";
  const status = phase === "preparing" ? "Preparando la foto…" : phase === "uploading" ? "Subiendo…" : done ? "Lista" : null;

  return (
    <div ref={fieldRef} className="rounded-lg bg-white p-3 shadow-control ring-1 ring-inset ring-line">
      <div className="flex items-center gap-3">
        {done && !preview && photoPath ? (
          // Una foto ya guardada (otra visita, o recuperada del borrador) no se
          // descarga sola: el cuadro entero la abre, del tamaño de un dedo.
          <a
            href={`/api/reparto/foto?path=${encodeURIComponent(photoPath)}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`Ver ${label.toLowerCase()} guardada`}
            className="grid size-14 shrink-0 place-items-center rounded-md bg-ok-wash text-ok-fg ring-1 ring-inset ring-line transition-colors hover:bg-ok-bg"
          >
            <IconCheckCircle className="size-6" />
          </a>
        ) : (
          <div className="relative grid size-14 shrink-0 place-items-center overflow-hidden rounded-md bg-wash text-ink-500">
            {preview && done ? (
              // La miniatura es la foto ya reducida que se subió, en memoria.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="" className="size-full object-cover" />
            ) : (
              <IconCamera className="size-6" />
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-900">{label}</p>
          <p aria-live="polite" className={cn("text-xs", done && !busy ? "font-medium text-ok-fg" : "text-ink-500")}>
            {status ?? (phase === "failed" ? "No se subió" : "Obligatoria")}
            {done && !busy && !preview && " · toca el cuadro para verla"}
          </p>
        </div>
      </div>
      {busy && <div aria-hidden className="mt-3 h-1 overflow-hidden rounded-full bg-line"><div className="h-full w-1/3 animate-[photo-progress_1.1s_ease-in-out_infinite] rounded-full bg-info-fg" /></div>}
      {/* El error va en un aviso, no pintando el campo (DESIGN.md, Inputs). */}
      {failure && <Banner tone="crit" role="alert" title={failure.title} className="mt-3">{failure.text}</Banner>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {phase === "failed" && pending.current ? (
          <button type="button" disabled={disabled} onClick={() => {
            const photo = pending.current;
            if (!photo) return;
            if (direct.current && photo instanceof File) void sendDirect(photo);
            else void send(photo);
          }} className="col-span-2 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-white text-sm font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-wash disabled:opacity-50">
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
