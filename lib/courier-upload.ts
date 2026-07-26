// Carga de un reporte de courier: leer el archivo, conservarlo, elegir el
// adaptador y delegar en la ingesta. Compartido por /api/import/courier y por
// /api/import/aliclik (que se mantiene para no romper enlaces guardados).
//
// SERVER-ONLY.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCsv } from "@/lib/csv-parse";
import { parseSheet } from "@/lib/xlsx";
import { ingestAliclikReport } from "@/lib/aliclik-ingest";
import { ingestCourierReport, type ReportIngestResult } from "@/lib/report-ingest";
import { courierAdapter, detectAdapter } from "@/lib/couriers/registry";

/** Un XLSX es un zip: un archivo pequeño puede inflarse a cientos de MB al
 *  parsearlo (zip bomb) → OOM. Se corta ANTES de parsear, como en la ruta de
 *  Aliclik original. Las rutas no respetan el bodySizeLimit de Server Actions. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_ROWS = 50_000;

/** Los reportes llevan datos personales del cliente: el bucket es privado. */
export const REPORT_BUCKET = "courier-reports";

let bucketReady = false;

/**
 * Asegura el bucket privado. Igual que lib/backup.ts: crear falla si ya existe
 * (correcto) y se fuerza `public: false` por si alguien lo creó público — estos
 * archivos llevan nombre, teléfono y dirección de clientes reales.
 */
async function ensureBucket(admin: SupabaseClient): Promise<void> {
  if (bucketReady) return;
  await admin.storage.createBucket(REPORT_BUCKET, { public: false }).catch(() => {});
  await admin.storage.updateBucket(REPORT_BUCKET, { public: false }).catch(() => {});
  bucketReady = true;
}

export interface ParsedUpload {
  rows: Record<string, string>[];
  filename: string;
  fileType: string;
  sha256: string;
  bytes: Uint8Array;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Lee y parsea el archivo subido. Lanza UploadError con el status adecuado. */
export async function readUpload(file: File): Promise<ParsedUpload> {
  if (file.size === 0) throw new UploadError("El archivo está vacío.", 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadError("El archivo es demasiado grande (máx. 8 MB).", 413);
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const filename = file.name || "reporte";
  const lower = filename.toLowerCase();

  let rows: Record<string, string>[];
  let fileType: string;
  try {
    if (lower.endsWith(".csv") || file.type === "text/csv") {
      fileType = "csv";
      rows = parseCsv(new TextDecoder().decode(bytes));
    } else if (lower.endsWith(".xlsx") || file.type.includes("spreadsheet")) {
      fileType = "xlsx";
      rows = await parseSheet(buffer);
    } else {
      // Último recurso: intentarlo como texto delimitado.
      fileType = "csv";
      rows = parseCsv(new TextDecoder().decode(bytes));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new UploadError(`No se pudo leer el archivo: ${msg}`, 400);
  }

  if (!rows.length) throw new UploadError("El archivo no tiene filas de datos.", 400);
  if (rows.length > MAX_ROWS) {
    throw new UploadError(
      `El reporte tiene demasiadas filas (${rows.length}, máx. ${MAX_ROWS}).`,
      413,
    );
  }
  return { rows, filename, fileType, sha256, bytes };
}

/**
 * Guarda el archivo original (§19.8: "los reportes originales deberán
 * conservarse"). Best-effort: si el almacenamiento falla, la ingesta sigue —
 * perder la copia del archivo no debe costar el reporte entero.
 */
async function storeOriginal(
  admin: SupabaseClient,
  storeId: string,
  courier: string,
  upload: ParsedUpload,
): Promise<string | null> {
  try {
    await ensureBucket(admin);
    // La huella en la ruta hace la subida idempotente: recargar el mismo archivo
    // no multiplica copias.
    const path = `${storeId}/${courier}/${upload.sha256}-${upload.filename}`;
    const { error } = await admin.storage
      .from(REPORT_BUCKET)
      .upload(path, new Blob([upload.bytes as BlobPart]), { upsert: true });
    return error ? null : path;
  } catch {
    return null;
  }
}

export interface CourierUploadResult extends ReportIngestResult {
  courier: string;
  /** Otro lote con el mismo archivo, si ya se había cargado antes. */
  duplicateOfBatchId?: string | null;
  /** Filas que Aliclik aún no gestiona (ESTADO LLAMADA = IMPORTADO) y se omiten. */
  skippedImportadoCount?: number;
}

/**
 * Procesa una carga completa. `courier` puede venir del operador; si no, se
 * detecta por el contenido y, si ningún adaptador lo reconoce, se pide que lo
 * indique en vez de adivinar y ensuciar las guías.
 */
export async function handleCourierUpload(
  admin: SupabaseClient,
  params: {
    storeId: string;
    accessibleStoreIds: string[];
    courier?: string | null;
    reportDate?: string | null;
    uploadedBy: string | null;
    upload: ParsedUpload;
  },
): Promise<CourierUploadResult> {
  const { storeId, accessibleStoreIds, uploadedBy, upload } = params;

  const requested = params.courier ? courierAdapter(params.courier) : null;
  if (params.courier && !requested) {
    throw new UploadError(`Courier desconocido: ${params.courier}.`, 400);
  }
  const adapter = requested ?? detectAdapter(upload.rows);
  if (!adapter) {
    throw new UploadError(
      "No se reconoció el formato del reporte. Indica el courier al subirlo.",
      400,
    );
  }

  // Aviso de re-carga: no se bloquea (volver a subir un reporte corregido es
  // legítimo y el estado solo avanza), pero se informa.
  const { data: prior } = await admin
    .from("import_batches")
    .select("id")
    .eq("file_sha256", upload.sha256)
    .limit(1)
    .maybeSingle();

  const filePath = await storeOriginal(admin, storeId, adapter.id, upload);
  const reportAt = new Date().toISOString();

  // Aliclik conserva su ingesta propia: sus reglas (Fenix, dirección editada a
  // mano, fallback de provincia) están probadas y no hay nada que ganar
  // reescribiéndolas. Se le añaden los metadatos del reporte después.
  if (adapter.id === "aliclik") {
    const result = await ingestAliclikReport(admin, storeId, accessibleStoreIds, upload.rows, {
      filename: upload.filename,
      uploadedBy,
      reportAt,
    });
    await admin
      .from("import_batches")
      .update({
        courier: "aliclik",
        report_date: params.reportDate ?? null,
        file_path: filePath,
        file_type: upload.fileType,
        file_sha256: upload.sha256,
        found_count: result.matchedCount,
        unrecognized_count: result.errorCount,
      })
      .eq("id", result.batchId);
    return {
      courier: "aliclik",
      batchId: result.batchId,
      rowCount: result.rowCount,
      foundCount: result.matchedCount,
      matchedCount: result.matchedCount,
      unmatchedCount: result.unmatchedCount,
      updatedCount: result.matchedCount,
      errorCount: result.errorCount,
      duplicateOfBatchId: (prior as { id: string } | null)?.id ?? null,
      skippedImportadoCount: result.skippedImportadoCount,
    };
  }

  const result = await ingestCourierReport(admin, {
    storeId,
    accessibleStoreIds,
    courier: adapter.id,
    rows: adapter.parse(upload.rows),
    meta: {
      filename: upload.filename,
      uploadedBy,
      reportAt,
      reportDate: params.reportDate ?? null,
      filePath,
      fileType: upload.fileType,
      fileSha256: upload.sha256,
    },
  });
  return {
    courier: adapter.id,
    ...result,
    duplicateOfBatchId: (prior as { id: string } | null)?.id ?? null,
  };
}
