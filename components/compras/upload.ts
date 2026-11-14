"use client";

// Subida de archivos de una importación (MOM §45): el servidor da la ruta y un
// enlace firmado (`startImportUpload`) y el navegador sube DIRECTO a Storage,
// sin el corte de tamaño de las acciones del servidor.

import { createBrowserSupabase } from "@/lib/supabase-browser";
import { IMPORT_FILES_BUCKET, importFileMime } from "@/lib/compras";
import { startImportUpload } from "@/app/dashboard/compras/actions";

export async function uploadImportFile(
  importId: string,
  kind: string,
  file: File,
): Promise<{ path: string } | { error: string }> {
  const prep = await startImportUpload(importId, {
    kind,
    contentType: file.type,
    filename: file.name,
    size: file.size,
  });
  if ("error" in prep) return { error: `${file.name}: ${prep.error}` };
  // El tipo que acepta el bucket: si el navegador no lo dice (pasa con XLSX), por la extensión.
  const contentType = importFileMime(file.type, file.name) ?? (file.type || undefined);
  const { error } = await createBrowserSupabase()
    .storage.from(IMPORT_FILES_BUCKET)
    .uploadToSignedUrl(prep.path, prep.token, file, { contentType });
  if (error) return { error: `${file.name}: ${error.message}` };
  return { path: prep.path };
}
