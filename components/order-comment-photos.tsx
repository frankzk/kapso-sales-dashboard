"use client";

// Las fotos de constancia de un comentario del pedido (owner, 10-11-2026):
// «intenté contactar y le dejé WhatsApp, subo captura». Reglas y rutas en
// lib/order-comment-photos.ts.
//
// Se adjuntan como el comprobante del Yape en «Registrar un pago»: pegar con
// Ctrl+V, arrastrar o elegir. Pegar se escucha en la tarjeta «Comentario», no
// en toda la ventana: en la ficha también vive «Registrar un pago», que sí
// escucha la ventana, y una captura pegada en el comentario no debe terminar
// como comprobante (el `preventDefault` de aquí se lo impide,
// lib/global-paste-image.ts).

import { useEffect, useMemo, useRef } from "react";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { fitWithin } from "@/lib/photo-resize";
import {
  ORDER_COMMENT_MAX_PHOTOS,
  ORDER_COMMENT_PHOTO_BUCKET,
  imageFilesFrom,
  orderCommentPhotoUrl,
} from "@/lib/order-comment-photos";
import { createOrderCommentPhotoUpload } from "@/app/dashboard/pedidos/actions";
import { OpsButton } from "@/components/ops-ui";
import { IconImage, IconX } from "@/components/icons";
import { cn } from "@/components/ui";

/** Lado mayor con el que se guarda una foto grande (una captura ya cabe). */
const COMMENT_PHOTO_MAX_SIDE = 2000;

/** Una foto de celular de varios MB se achica antes de subir; una captura va tal cual. */
async function shrinkPhoto(file: File): Promise<File> {
  if (file.size <= 1.5 * 1024 * 1024 || file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, COMMENT_PHOTO_MAX_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

/**
 * Sube las fotos directo a Storage (URL firmada por el servidor) y devuelve
 * sus rutas, en el orden en que se adjuntaron. Si una falla, se dice cuál.
 */
export async function uploadOrderCommentPhotos(
  orderId: string,
  files: readonly File[],
): Promise<{ paths: string[] } | { error: string }> {
  const paths: string[] = [];
  const supabase = createBrowserSupabase();
  for (const [i, original] of files.entries()) {
    const label = files.length > 1 ? `la foto ${i + 1}` : "la foto";
    const file = await shrinkPhoto(original);
    const prep = await createOrderCommentPhotoUpload(orderId, file.type, file.size);
    if ("error" in prep) return { error: `No se pudo subir ${label}: ${prep.error}` };
    const { error } = await supabase.storage
      .from(ORDER_COMMENT_PHOTO_BUCKET)
      .uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type });
    if (error) return { error: `No se pudo subir ${label}: ${error.message}` };
    paths.push(prep.path);
  }
  return { paths };
}

/**
 * Lo que trae un pegado dentro de la tarjeta. Si en el portapapeles hay texto
 * Y una imagen (Maps, Word) y se pega en el cuadro de texto, gana el texto.
 */
export function commentPastedImages(e: React.ClipboardEvent): File[] {
  const images = imageFilesFrom(e.clipboardData?.files);
  if (!images.length) return [];
  const inEditor = e.target instanceof Element && e.target.closest("textarea, input");
  if (inEditor && e.clipboardData.getData("text/plain").trim()) return [];
  return images;
}

/** Junta las nuevas con las que ya había, sin pasar el tope. */
export function addCommentPhotos(current: readonly File[], incoming: readonly File[]): { files: File[]; dropped: number } {
  const room = Math.max(0, ORDER_COMMENT_MAX_PHOTOS - current.length);
  return { files: [...current, ...incoming.slice(0, room)], dropped: Math.max(0, incoming.length - room) };
}

/** Las fotos elegidas, con su miniatura y el botón para adjuntar más. */
export function CommentPhotoPicker({
  files,
  onChange,
  disabled = false,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);
  const full = files.length >= ORDER_COMMENT_MAX_PHOTOS;

  return (
    <div className="space-y-2">
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Fotos adjuntas">
          {files.map((file, i) => (
            <li key={`${file.name}-${file.size}-${i}`} className="relative">
              <img
                src={previews[i]}
                alt={`Foto ${i + 1} adjunta`}
                className="size-20 rounded-md object-cover ring-1 ring-line"
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(files.filter((_, k) => k !== i))}
                aria-label={`Quitar la foto ${i + 1}`}
                className="absolute -right-2 -top-2 grid size-6 place-items-center rounded-full bg-ink-900 text-white shadow-sm transition-colors hover:bg-ink-700 disabled:opacity-50 pointer-coarse:size-8"
              >
                <IconX aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <OpsButton
          size="sm"
          disabled={disabled || full}
          onClick={() => inputRef.current?.click()}
          className="pointer-coarse:h-11"
        >
          <IconImage aria-hidden className="text-ink-500" />
          {files.length ? "Adjuntar otra foto" : "Adjuntar foto"}
        </OpsButton>
        <p className="text-[13px] leading-5 text-ink-500">
          {full
            ? `Máximo ${ORDER_COMMENT_MAX_PHOTOS} fotos por comentario.`
            : "O pega la captura con Ctrl+V aquí, o arrástrala. Queda como constancia en Actividad."}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/gif,.webp"
          className="hidden"
          onChange={(e) => {
            onChange(addCommentPhotos(files, imageFilesFrom(e.target.files)).files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

/** Las fotos de un comentario en la Actividad: miniaturas que abren la foto entera. */
export function CommentPhotoStrip({
  orderId,
  photos,
  className,
}: {
  orderId: string;
  photos: readonly string[];
  className?: string;
}) {
  if (!photos.length) return null;
  return (
    <ul className={cn("flex flex-wrap gap-2", className)} aria-label="Fotos de constancia">
      {photos.map((path, i) => (
        <li key={path}>
          <a
            href={orderCommentPhotoUrl(orderId, path)}
            target="_blank"
            rel="noreferrer"
            className="block overflow-hidden rounded-md ring-1 ring-line transition-shadow hover:ring-brand-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            <img
              src={orderCommentPhotoUrl(orderId, path)}
              alt={`Constancia ${i + 1} del comentario`}
              loading="lazy"
              className="size-20 object-cover"
            />
          </a>
        </li>
      ))}
    </ul>
  );
}
