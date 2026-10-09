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
//   - Sin señal (o con el servidor caído) ni siquiera hace falta tocarlo: se
//     vuelve a mandar sola, cada vez más espaciado y en cuanto vuelve la
//     señal, mientras la pantalla siga abierta (09-10-2026). Solo un «no» del
//     servidor (sin permiso, ruta cerrada) se le dice como error.
//   - La que el celular no puede abrir para achicarla y pesa más de 4 MB (una
//     foto de 50 MP de la pantalla del cliente, un HEIC) sube ENTERA directo a
//     Storage y la reduce el servidor (08-10-2026, el Yape de #KP139761 que
//     Roy no podía adjuntar). Antes salía «pesa demasiado» y no había salida.

import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";
import { canUploadAsIs, decodeResize, fitWithin, PHOTO_DIRECT_LIMIT, PHOTO_HEADER_BYTES, PHOTO_QUALITY, PHOTO_UPLOAD_LIMIT, readImageSize } from "@/lib/photo-resize";
import { retryableStatus, retryDelayMs, uploadTimeoutMs } from "@/lib/photo-retry";
import { Banner } from "@/components/ops-ui";
import { IconCamera, IconCheckCircle, IconImage } from "@/components/icons";
import { cn } from "@/components/ui";

const PhotoCamera = lazy(() => import("@/components/photo-camera").then((m) => ({ default: m.PhotoCamera })));

export interface PhotoCaptureResult {
  error?: string;
  notice?: string;
  path?: string;
}

type Phase = "idle" | "preparing" | "uploading" | "waiting" | "failed";

/** Un error que ya viene dicho para el motorizado. */
class PhotoError extends Error {}

/** Sin respuesta (sin señal, o se cortó) o una caída del servidor: se reintenta sola. */
class RetryLater extends Error {
  constructor(readonly noSignal: boolean) {
    super(noSignal ? "sin señal" : "servidor");
  }
}

/**
 * `fetch` con tope de tiempo: una subida colgada en una señal muerta se da por
 * cortada y se reintenta, en vez de quedarse minutos sin fallar.
 */
async function request(url: string, init: RequestInit, bytes: number): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), uploadTimeoutMs(bytes));
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } catch {
    // Sin respuesta del servidor: sin señal, o se cortó por tardar demasiado.
    throw new RetryLater(true);
  } finally {
    clearTimeout(timer);
  }
}

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
  const res = await request("/api/reparto/foto", { method: "POST", body: fd }, photo.size);
  let json: { path?: string; error?: string } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // Un corte de la plataforma (413) no responde JSON.
  }
  if (res.ok && json.path) return json.path;
  if (retryableStatus(res.status)) throw new RetryLater(false);
  throw new PhotoError(json.error ?? (res.status === 413 ? "La foto pesa demasiado. Toma otra con «Cámara»." : "No se pudo subir la foto."));
}

async function postJson<T>(body: Record<string, unknown>): Promise<T & { error?: string }> {
  const res = await request("/api/reparto/foto", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 0);
  let json = {} as T & { error?: string };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // sin JSON: abajo se dice en palabras
  }
  if (res.ok) return json;
  if (retryableStatus(res.status)) throw new RetryLater(false);
  throw new PhotoError(json.error ?? "No se pudo subir la foto.");
}

/** Lo ya hecho de una subida directa: al reintentar, lo que llegó no se vuelve a subir. */
interface DirectProgress {
  uploaded?: string;
}

/**
 * La foto entera, directo a Storage con un permiso de un solo uso, y después el
 * servidor la achica. No pasa por la función de subida, así que no la corta
 * el límite de 4,5 MB de Vercel.
 */
async function uploadDirect(file: File, stopId: string, kind: "entrega" | "yape", progress: DirectProgress): Promise<string> {
  if (file.size > PHOTO_DIRECT_LIMIT) throw new PhotoError("Esa foto pesa más de 25 MB. Tómala con «Cámara».");
  if (!progress.uploaded) {
    const signed = await postJson<{ path?: string; token?: string }>({ action: "firmar", stopId, kind, type: file.type, size: file.size });
    if (!signed.path || !signed.token) throw new PhotoError("No se pudo preparar la subida.");
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, "");
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file);
    const put = await request(
      `${base}/storage/v1/object/upload/sign/delivery-proofs/${signed.path.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(signed.token)}`,
      { method: "PUT", body, headers: { apikey: key, Authorization: `Bearer ${key}`, "x-upsert": "false" } },
      file.size,
    );
    if (!put.ok) {
      if (retryableStatus(put.status)) throw new RetryLater(false);
      throw new PhotoError("No se pudo subir la foto.");
    }
    progress.uploaded = signed.path;
  }
  const reduced = await postJson<{ path?: string }>({ action: "reducir", stopId, kind, path: progress.uploaded });
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
  /** Cuántas veces seguidas no subió por falta de señal o del servidor. */
  const [attempt, setAttempt] = useState(0);
  const [noSignal, setNoSignal] = useState(true);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ title: string; text: string } | null>(null);
  const pending = useRef<Blob | null>(null);
  /** El pendiente es una foto que va por la subida directa. */
  const direct = useRef(false);
  const directProgress = useRef<DirectProgress>({});
  /** Una subida en curso: el reintento solo no lanza otra encima. */
  const inFlight = useRef(false);
  /**
   * La subida vigente. Una foto nueva deja sin efecto la que seguía
   * reintentando: en Android, volver de la galería despierta el reintento de
   * la vieja justo antes de que llegue la nueva, y la vieja no debe ganar.
   */
  const ticket = useRef(0);

  /** Lo que estuviera subiendo o esperando ya no cuenta. */
  function supersede() {
    ticket.current += 1;
    inFlight.current = false;
  }
  const galleryRef = useRef<HTMLInputElement>(null);

  // La miniatura es un objeto en memoria: se suelta al cambiarla o al salir.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  /** No subió, pero no por la foto: queda pendiente y se vuelve a mandar sola. */
  function waitAndRetry(error: RetryLater) {
    setNoSignal(error.noSignal);
    setAttempt((n) => n + 1);
    setPhase("waiting");
  }

  function fail(error: unknown) {
    const message = error instanceof PhotoError ? error.message : "No se pudo subir la foto.";
    setFailure({ title: "No se subió la foto", text: message });
    setPhase("failed");
    onResult({ error: message });
  }

  /** `again`: es la misma foto que no subió, no una nueva. */
  async function send(photo: Blob, again = false) {
    if (!stopId) return onResult({ error: "Falta la parada." });
    if (again && inFlight.current) return;
    const mine = ++ticket.current;
    inFlight.current = true;
    pending.current = photo;
    direct.current = false;
    if (!again) setAttempt(0);
    setFailure(null);
    setPhase("uploading");
    try {
      const path = await upload(photo, stopId, kind);
      if (mine !== ticket.current) return;
      pending.current = null;
      setAttempt(0);
      setPreview(URL.createObjectURL(photo));
      setPhase("idle");
      onResult({ path, notice: "Foto lista." });
    } catch (error) {
      if (mine !== ticket.current) return;
      if (error instanceof RetryLater) waitAndRetry(error);
      else fail(error);
    } finally {
      if (mine === ticket.current) inFlight.current = false;
    }
  }

  /** La foto pesada que el celular no pudo achicar: sube entera y la achica el servidor. */
  async function sendDirect(file: File, again = false) {
    if (!stopId) return onResult({ error: "Falta la parada." });
    if (again && inFlight.current) return;
    const mine = ++ticket.current;
    inFlight.current = true;
    pending.current = file;
    direct.current = true;
    if (!again) {
      setAttempt(0);
      directProgress.current = {};
    }
    setFailure(null);
    setPhase("uploading");
    try {
      const path = await uploadDirect(file, stopId, kind, directProgress.current);
      if (mine !== ticket.current) return;
      pending.current = null;
      direct.current = false;
      setAttempt(0);
      // Sin miniatura: abrir entera una foto que el celular no pudo achicar es
      // lo que lo deja sin memoria. El cuadro la enseña desde el servidor.
      setPreview(null);
      setPhase("idle");
      onResult({ path, notice: "Foto lista." });
    } catch (error) {
      if (mine !== ticket.current) return;
      if (error instanceof RetryLater) waitAndRetry(error);
      else fail(error);
    } finally {
      if (mine === ticket.current) inFlight.current = false;
    }
  }

  /** Vuelve a mandar la foto pendiente, la misma, sin tomarla otra vez. */
  function retry(again: boolean) {
    const photo = pending.current;
    if (!photo || inFlight.current) return;
    if (direct.current && photo instanceof File) void sendDirect(photo, again);
    else void send(photo, again);
  }
  const retryOnItsOwn = useEffectEvent(() => retry(true));

  // Esperando: se reintenta sola al cumplirse la espera, al volver la señal
  // o al volver a la pantalla (con el teléfono bloqueado, Chrome duerme los
  // relojes).
  useEffect(() => {
    if (phase !== "waiting") return;
    const go = () => retryOnItsOwn();
    const onVisible = () => { if (document.visibilityState === "visible") go(); };
    const timer = window.setTimeout(go, retryDelayMs(attempt));
    window.addEventListener("online", go);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", go);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [phase, attempt]);

  async function fromGallery(file: File) {
    supersede();
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
  const waiting = phase === "waiting";
  const done = Boolean(photoPath) && phase !== "failed" && !waiting;
  const status = phase === "preparing"
    ? "Preparando la foto…"
    : phase === "uploading"
      ? (attempt > 0 ? "Reintentando…" : "Subiendo…")
      : waiting ? "Se subirá sola" : done ? "Lista" : null;

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
      {waiting && (
        <Banner tone="warn" role="status" title={noSignal ? "Sin señal" : "El servidor no respondió"} className="mt-3">
          La foto se subirá sola en cuanto se pueda. No cierres esta pantalla.
        </Banner>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {(phase === "failed" || waiting) && pending.current ? (
          <button type="button" disabled={disabled} onClick={() => retry(waiting)} className="col-span-2 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-white text-sm font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-wash disabled:opacity-50">
            {waiting ? "Reintentar ahora" : "Reintentar la subida"}
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
            onCapture={(photo) => { setCameraOpen(false); supersede(); void send(photo); }}
          />
        </Suspense>
      )}
    </div>
  );
}
