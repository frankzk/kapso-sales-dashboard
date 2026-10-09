import { createHash, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { routeReportAccess } from "@/lib/route-report-access";
import {
  PHOTO_AS_IS_BYTES,
  PHOTO_DIRECT_LIMIT,
  PHOTO_HEADER_BYTES,
  PHOTO_MAX_SIDE,
  PHOTO_QUALITY,
  PHOTO_UPLOAD_LIMIT,
  imageKind,
  readImageSize,
} from "@/lib/photo-resize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Fotos de entrega y comprobantes: llevan casa, cara y montos. Bucket privado. */
const BUCKET = "delivery-proofs";

// La pantalla del motorizado reduce cada foto a 1600 px en JPEG antes de
// subirla (PhotoCapture, 30-09-2026): llega en cientos de KB. El tope es el de
// `lib/photo-resize`, por debajo del corte de 4,5 MB con que Vercel rechaza el
// cuerpo antes de llegar aquí (y sin JSON que el teléfono pueda leer).
const MAX_BYTES = PHOTO_UPLOAD_LIMIT;
const TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"]);

let bucketReady = false;
async function ensureBucket(admin: ReturnType<typeof createAdminSupabase>) {
  if (bucketReady) return;
  await admin.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  await admin.storage.updateBucket(BUCKET, { public: false }).catch(() => {});
  bucketReady = true;
}

/**
 * Sube la foto de una entrega (o la captura del Yape) y devuelve su ruta, que
 * el reporte guarda después.
 *   POST /api/reparto/foto  — multipart: file, stopId, kind=entrega|yape
 *
 * Se sube ANTES de reportar para que la foto no viaje dentro del Server Action
 * y para que una conexión mala no obligue a rellenar el formulario otra vez.
 * La parada se comprueba con el cliente del usuario: si RLS no se la muestra,
 * no puede colgarle una foto.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });

  const perms = await getMasterPermissions();
  if (!perms.can("routes.deliver") && !perms.can("routes.report_others")) {
    return NextResponse.json({ error: "Tu rol no permite reportar entregas." }, { status: 403 });
  }

  // La foto que el celular no pudo achicar va por otro camino (08-10-2026).
  if ((req.headers.get("content-type") ?? "").includes("application/json")) return direct(req);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido." }, { status: 400 });
  }

  const stopId = String(form.get("stopId") ?? "");
  const kind = String(form.get("kind") ?? "entrega") === "yape" ? "yape" : "entrega";
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta la foto." }, { status: 400 });
  }
  if (file.size === 0) return NextResponse.json({ error: "La foto está vacía." }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "La foto es demasiado grande (máx. 4 MB). Tómala otra vez con «Cámara»." }, { status: 413 });
  }
  const type = (file.type ?? "").toLowerCase();
  if (type && !TYPES.has(type)) {
    return NextResponse.json({ error: "Eso no parece una foto." }, { status: 415 });
  }

  const stop = await stopForUpload(stopId);
  if (stop instanceof NextResponse) return stop;

  const received = new Uint8Array(await file.arrayBuffer());
  const light = await lighten(received);
  const bytes = light ?? received;
  const stored = light ? "image/jpeg" : type || "image/jpeg";
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const ext = light ? "jpg" : /hei[cf]/.test(type) ? "heic" : type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const path = `${stop.routeId}/${stopId}/${kind}-${sha}.${ext}`;

  const admin = createAdminSupabase();
  try {
    await ensureBucket(admin);
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(path, new Blob([bytes as BlobPart], { type: stored }), {
        upsert: true,
      });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true, path, kind });
}

/**
 * La parada tiene que ser visible para QUIEN sube: es la comprobación de que
 * es suya, y la hace la base (RLS), no este código. Y la ruta tiene que
 * seguir abierta para que pueda reportarla.
 */
async function stopForUpload(stopId: string): Promise<{ routeId: string } | NextResponse> {
  const sb = await createServerSupabase();
  const { data: stop } = await sb
    .from("delivery_stops")
    .select("id,route_id")
    .eq("id", stopId)
    .maybeSingle();
  if (!stop) return NextResponse.json({ error: "Esa parada no es tuya." }, { status: 403 });
  const routeId = (stop as { route_id: string }).route_id;
  if (!await routeReportAccess(routeId)) {
    return NextResponse.json({ error: "No tienes permiso para reportar esta ruta o ya no está en curso." }, { status: 403 });
  }
  return { routeId };
}

/** Lo que `sharp` sabe abrir. El HEIC de los iPhone y de algunos Android, no. */
const SERVER_READABLE = new Set(["jpeg", "png", "webp", "gif", "avif"]);

/**
 * La foto en JPEG de 1600 px por el lado mayor: lo mismo que hace el teléfono
 * cuando puede. Null si no se deja abrir (rota o rara).
 */
async function toLightJpeg(bytes: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(bytes, { animated: false, limitInputPixels: 200_000_000 })
      .rotate()
      .resize({ width: PHOTO_MAX_SIDE, height: PHOTO_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: Math.round(PHOTO_QUALITY * 100), mozjpeg: true })
      .toBuffer();
  } catch (e) {
    console.error("[reparto/foto] no se pudo reducir", e);
    return null;
  }
}

/**
 * La foto que llega pesada por la subida normal se reduce antes de guardarla
 * (09-10-2026). Son las que el celular no tuvo memoria para achicar y subió
 * enteras: de 1 a 4 por ruta, de 1 a 1,7 MB, entre fotos de 130 KB. Así toda
 * evidencia guardada pesa lo mismo y se abre rápido en el panel. Una foto ya
 * liviana y de 1600 px o menos se guarda tal cual; la que `sharp` no abre
 * (HEIC), también: la evidencia no se pierde. Null = se guarda la recibida.
 */
async function lighten(bytes: Uint8Array): Promise<Buffer | null> {
  if (!SERVER_READABLE.has(imageKind(bytes.subarray(0, 32)))) return null;
  if (bytes.length <= PHOTO_AS_IS_BYTES) {
    const size = readImageSize(bytes.subarray(0, PHOTO_HEADER_BYTES));
    if (!size || Math.max(size.width, size.height) <= PHOTO_MAX_SIDE) return null;
  }
  const jpg = await toLightJpeg(Buffer.from(bytes));
  return jpg && jpg.length < bytes.length ? jpg : null;
}

/**
 * La foto que el celular no pudo abrir para achicarla y pesa más que el corte
 * de Vercel (08-10-2026: la captura del Yape de #KP139761 que Roy no podía
 * adjuntar, aunque había subido otras 79 sin problema). Dos pasos, JSON:
 *
 *   { action: "firmar", stopId, kind, type, size } → { path, token }
 *     El teléfono la sube ENTERA directo a Storage con ese token: no pasa por
 *     esta función, así que el corte de 4,5 MB no aplica.
 *   { action: "reducir", stopId, kind, path } → { path, reduced }
 *     El servidor la baja, la reduce a 1600 px en JPEG —lo mismo que hace el
 *     teléfono cuando puede— y borra el original. Si no la puede abrir
 *     (HEIC), queda el original: la evidencia no se pierde.
 */
async function direct(req: NextRequest) {
  let body: { action?: unknown; stopId?: unknown; kind?: unknown; type?: unknown; size?: unknown; path?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido." }, { status: 400 });
  }
  const stopId = typeof body.stopId === "string" ? body.stopId : "";
  const kind = body.kind === "yape" ? "yape" : "entrega";
  const stop = await stopForUpload(stopId);
  if (stop instanceof NextResponse) return stop;
  const prefix = `${stop.routeId}/${stopId}/`;
  const admin = createAdminSupabase();
  await ensureBucket(admin);

  if (body.action === "firmar") {
    const size = Number(body.size);
    if (!(size > 0)) return NextResponse.json({ error: "La foto está vacía." }, { status: 400 });
    if (size > PHOTO_DIRECT_LIMIT) {
      return NextResponse.json({ error: "Esa foto pesa más de 25 MB. Tómala con «Cámara»." }, { status: 413 });
    }
    const type = typeof body.type === "string" ? body.type.toLowerCase() : "";
    if (type && !type.startsWith("image/")) return NextResponse.json({ error: "Eso no parece una foto." }, { status: 415 });
    const ext = /hei[cf]/.test(type) ? "heic" : type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    const path = `${prefix}${kind}-original-${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) return NextResponse.json({ error: error?.message ?? "No se pudo preparar la subida." }, { status: 500 });
    return NextResponse.json({ ok: true, path: data.path, token: data.token });
  }

  if (body.action === "reducir") {
    const original = typeof body.path === "string" ? body.path : "";
    // Solo un original de ESTA parada, subido por «firmar».
    if (!original.startsWith(prefix) || !original.includes(`/${kind}-original-`) || original.includes("..")) {
      return NextResponse.json({ error: "La foto no pertenece a esta parada." }, { status: 403 });
    }
    const { data: blob, error } = await admin.storage.from(BUCKET).download(original);
    if (error || !blob) return NextResponse.json({ error: "La foto no llegó. Vuelve a intentar." }, { status: 404 });
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (!SERVER_READABLE.has(imageKind(new Uint8Array(bytes.subarray(0, 32))))) {
      return NextResponse.json({ ok: true, path: original, reduced: false });
    }
    const jpg = await toLightJpeg(bytes);
    // Una foto rota o rara: se queda el original, que igual es la evidencia.
    if (!jpg) return NextResponse.json({ ok: true, path: original, reduced: false });
    const sha = createHash("sha256").update(jpg).digest("hex").slice(0, 16);
    const path = `${prefix}${kind}-${sha}.jpg`;
    const { error: upError } = await admin.storage
      .from(BUCKET)
      .upload(path, new Blob([new Uint8Array(jpg)], { type: "image/jpeg" }), { upsert: true });
    if (upError) return NextResponse.json({ ok: true, path: original, reduced: false });
    await admin.storage.from(BUCKET).remove([original]).catch(() => {});
    return NextResponse.json({ ok: true, path, reduced: true });
  }

  return NextResponse.json({ error: "Acción desconocida." }, { status: 400 });
}

/**
 * Enseña una foto de entrega o un comprobante ya subido.
 *   GET /api/reparto/foto?path=<ruta en el bucket>
 *
 * La foto lleva casa, cara y montos: solo la ve quien puede ver la parada. La
 * comprobación la hace la base (RLS de `delivery_stops`: tienda con acceso o
 * la ruta del propio motorizado); el archivo se sirve desde aquí y no como
 * enlace firmado, para que la URL no viaje ni se comparta.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  const path = (req.nextUrl.searchParams.get("path") ?? "").trim();
  if (!path || path.includes("..")) return NextResponse.json({ error: "Falta la foto." }, { status: 400 });
  const sb = await createServerSupabase();
  const { data: stop } = await sb
    .from("delivery_stops")
    .select("id")
    .or(`photo_path.eq.${JSON.stringify(path)},voucher_path.eq.${JSON.stringify(path)}`)
    .limit(1)
    .maybeSingle();
  if (!stop) return NextResponse.json({ error: "Esa foto no es de una parada tuya." }, { status: 404 });
  const admin = createAdminSupabase();
  const { data, error } = await admin.storage.from(BUCKET).download(path);
  if (error || !data) return NextResponse.json({ error: error?.message ?? "No se encontró la foto." }, { status: 404 });
  return new NextResponse(data, {
    headers: {
      "content-type": data.type || "image/jpeg",
      "cache-control": "private, max-age=300",
      "content-disposition": `inline; filename="${path.split("/").pop() ?? "foto"}"`,
    },
  });
}
