import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { readUpload, UploadError } from "@/lib/courier-upload";
import type { ParsedSettlementLine } from "@/lib/settlement-sheet";
import { parseSettlementFile } from "@/lib/settlements/registry";
import { MAX_PHOTO_BYTES, readSettlementPhotoFromEnv } from "@/lib/settlement-vision";
import { ingestSettlement } from "@/lib/settlement-ingest";
import { storeVisionCreds } from "@/lib/store-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Una foto de cuaderno con treinta filas manuscritas tarda; dale margen.
export const maxDuration = 120;

/** Los cuadernos llevan nombres y montos de clientes: bucket privado. */
const BUCKET = "rider-settlements";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/jpg"]);

function isImage(file: File): boolean {
  if (IMAGE_TYPES.has((file.type ?? "").toLowerCase())) return true;
  return /\.(jpe?g|png|gif|webp|heic)$/i.test(file.name ?? "");
}

let bucketReady = false;
async function ensureBucket(admin: ReturnType<typeof createAdminSupabase>) {
  if (bucketReady) return;
  await admin.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  await admin.storage.updateBucket(BUCKET, { public: false }).catch(() => {});
  bucketReady = true;
}

/**
 * Sube una liquidación de motorizado, en foto o en hoja.
 *   POST /api/settlements/upload
 *   multipart: file, storeId, settlementDate?, riderId?, declaredCash?, declaredYape?, note?
 *
 * Los dos formatos terminan en la MISMA ingesta: la foto se transcribe con
 * visión y la hoja se lee por alias de cabecera, y ambas producen las mismas
 * líneas canónicas. Lo que no se puede vincular queda en revisión.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });

  const perms = await getMasterPermissions();
  if (!perms.can("settlements.manage")) {
    return NextResponse.json({ error: "Tu rol no permite cargar liquidaciones." }, { status: 403 });
  }

  const stores = await getAccessibleStores();
  if (!stores.length) return NextResponse.json({ error: "Sin tiendas accesibles." }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido (se esperaba multipart)." }, { status: 400 });
  }

  const requestedStoreId = String(form.get("storeId") ?? "");
  const multiStore = requestedStoreId === "__all__";
  const storeId = multiStore ? stores[0]!.id : requestedStoreId;
  const store = stores.find((s) => s.id === storeId);
  if (!store) return NextResponse.json({ error: "Tienda inválida o sin acceso." }, { status: 403 });

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo de la liquidación." }, { status: 400 });
  }
  if (file.size === 0) return NextResponse.json({ error: "El archivo está vacío." }, { status: 400 });

  const rawDate = String(form.get("settlementDate") ?? "").trim();
  const askedDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  const riderId = String(form.get("riderId") ?? "").trim() || null;
  const note = String(form.get("note") ?? "").trim() || null;
  const money = (key: string): number => {
    const n = Number(String(form.get(key) ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const admin = createAdminSupabase();
  const accessibleIds = stores.map((s) => s.id);

  let lines: ParsedSettlementLine[];
  let riderNameRaw: string | null = null;
  let readDate: string | null = null;
  let source: "foto" | "hoja";
  let sha256: string;
  let filePath: string | null = null;
  let format = "foto";
  let posFee = 0;
  let storeHint: string | null = null;

  try {
    if (isImage(file)) {
      if (file.size > MAX_PHOTO_BYTES) {
        return NextResponse.json({ error: "La foto es demasiado grande (máx. 8 MB)." }, { status: 413 });
      }
      source = "foto";
      const bytes = new Uint8Array(await file.arrayBuffer());
      sha256 = createHash("sha256").update(bytes).digest("hex");

      let creds = await storeVisionCreds(admin, storeId);
      // En la carga combinada el primer store accesible es solo el ancla
      // administrativa. Si no tiene visión propia, usa otra clave configurada
      // de las tiendas incluidas en vez de caer innecesariamente al entorno.
      if (multiStore && !creds.anthropicApiKey) {
        for (const candidate of stores) {
          if (candidate.id === storeId) continue;
          const candidateCreds = await storeVisionCreds(admin, candidate.id);
          if (candidateCreds.anthropicApiKey) {
            creds = candidateCreds;
            break;
          }
        }
      }
      const read = await readSettlementPhotoFromEnv(
        Buffer.from(bytes).toString("base64"),
        file.type,
        creds,
      );
      // `ok:false` NO es "la hoja está vacía": es que no se pudo leer. Guardar
      // una liquidación vacía por un timeout sería darla por buena.
      if (!read.ok) {
        console.error("[settlements/upload] No se pudo leer la foto", {
          storeId,
          model: read.model,
          failure: read.failure ?? "unknown",
          detail: read.detail ?? null,
          bytes: file.size,
        });
        return NextResponse.json(
          {
            error:
              read.failure === "timeout"
                ? "La foto tiene muchas filas y la lectura agotó el tiempo. Reintenta una vez."
                : read.failure === "invalid_response"
                  ? `La lectura de la foto quedó incompleta. ${read.detail ?? "Reintenta una vez."}`
                  : read.failure === "missing_credentials"
                    ? "No hay una clave de visión válida configurada para leer la foto."
                    : "No se pudo leer la foto con el servicio de visión. Revisa la configuración o reintenta.",
          },
          { status: 502 },
        );
      }
      lines = read.lines;
      riderNameRaw = read.riderName;
      readDate = read.settlementDate;
      // La foto de Axel conserva su semántica contable igual que el Excel:
      // CLIENTE restringe la tienda, F. PAGO distingue cobros directos y
      // GANANCIA es la comisión del courier.
      if (
        lines.some(
          (line) =>
            line.store_hint ||
            line.payment_method ||
            line.declared_fee !== null ||
            line.raw.f_pago,
        )
      ) {
        format = "axel";
        storeHint = lines.find((line) => line.store_hint)?.store_hint ?? null;
      }

      try {
        await ensureBucket(admin);
        const path = `${storeId}/${sha256}-${file.name || "liquidacion"}`;
        const { error } = await admin.storage
          .from(BUCKET)
          .upload(path, new Blob([bytes as BlobPart]), { upsert: true });
        if (!error) filePath = path;
      } catch {
        // Perder la copia del cuaderno no debe costar la liquidación entera.
      }
    } else {
      source = "hoja";
      const upload = await readUpload(file);
      sha256 = upload.sha256;
      // El formato se detecta por contenido (Axel y los que vengan), y si nadie
      // lo reconoce se usa el lector genérico por alias de cabecera.
      const parsed = parseSettlementFile(upload.rows, String(form.get("format") ?? "") || null);
      lines = parsed.lines;
      riderNameRaw = parsed.riderName;
      readDate = parsed.settlementDate;
      format = parsed.format;
      posFee = parsed.posFee;
      storeHint = parsed.storeHint;

      try {
        await ensureBucket(admin);
        const path = `${storeId}/${sha256}-${upload.filename}`;
        const { error } = await admin.storage
          .from(BUCKET)
          .upload(path, new Blob([upload.bytes as BlobPart]), { upsert: true });
        if (!error) filePath = path;
      } catch {
        /* best-effort */
      }
    }
  } catch (e) {
    if (e instanceof UploadError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (!lines.length) {
    return NextResponse.json(
      { error: "No se reconoció ninguna fila de entrega en el archivo." },
      { status: 400 },
    );
  }

  // La fecha que escribe el operador manda sobre la leída del archivo: él sabe
  // de qué día es la liquidación, la hoja puede traer la fecha de otra cosa.
  const settlementDate = askedDate ?? readDate ?? new Date().toISOString().slice(0, 10);

  const result = await ingestSettlement(admin, {
    orgId: store.org_id,
    storeId,
    accessibleStoreIds: accessibleIds,
    settlementDate,
    source,
    riderId,
    riderNameRaw,
    declaredCash: money("declaredCash"),
    declaredYape: money("declaredYape"),
    filePath,
    fileSha256: sha256,
    note,
    userId: user.id,
    courier: format === "generico" || format === "foto" ? null : format,
    posFee,
    directCollected:
      format === "axel"
        ? lines.reduce((sum, line) => {
            const method = (line.payment_method ?? "").toLowerCase();
            return method && method !== "efectivo"
              ? sum + Math.max(0, Number(line.declared_amount ?? 0))
              : sum;
          }, 0)
        : 0,
    lines,
  });

  if (!result.settlementId) {
    return NextResponse.json(
      { error: result.errors[0] ?? "No se pudo guardar la liquidación." },
      { status: 500 },
    );
  }

  // La hoja de Axel dice a qué tienda pertenece cada fila ("CLIENTE"). Si no
  // coincide con la elegida se avisa, pero no se cambia por su cuenta: elegir la
  // tienda es del operador.
  const storeMismatch =
    !multiStore && storeHint && !store.name.toUpperCase().includes(storeHint.toUpperCase())
      ? `La hoja dice "${storeHint}" y cargaste en ${store.name}.`
      : null;

  return NextResponse.json({
    ok: true,
    source,
    format,
    posFee,
    multiStore,
    storeMismatch,
    ...result,
  });
}
