import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Fotos de entrega y comprobantes: llevan casa, cara y montos. Bucket privado. */
const BUCKET = "delivery-proofs";

// Las cámaras de móvil sacan fotos grandes; se acepta hasta 12 MB y el
// navegador ya las reduce antes de subirlas.
const MAX_BYTES = 12 * 1024 * 1024;
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
  if (!perms.can("routes.deliver") && !perms.can("routes.manage")) {
    return NextResponse.json({ error: "Tu rol no permite reportar entregas." }, { status: 403 });
  }

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
    return NextResponse.json({ error: "La foto es demasiado grande (máx. 12 MB)." }, { status: 413 });
  }
  const type = (file.type ?? "").toLowerCase();
  if (type && !TYPES.has(type)) {
    return NextResponse.json({ error: "Eso no parece una foto." }, { status: 415 });
  }

  // La parada tiene que ser visible para QUIEN sube: es la comprobación de que
  // es suya, y la hace la base, no este código.
  const sb = await createServerSupabase();
  const { data: stop } = await sb
    .from("delivery_stops")
    .select("id,route_id")
    .eq("id", stopId)
    .maybeSingle();
  if (!stop) {
    return NextResponse.json({ error: "Esa parada no es tuya." }, { status: 403 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const path = `${(stop as { route_id: string }).route_id}/${stopId}/${kind}-${sha}.${ext}`;

  const admin = createAdminSupabase();
  try {
    await ensureBucket(admin);
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(path, new Blob([bytes as BlobPart], { type: type || "image/jpeg" }), {
        upsert: true,
      });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true, path, kind });
}
