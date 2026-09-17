import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { getMyRider } from "@/lib/routes-access";
import { getRiderSheet } from "@/lib/sheets/rider-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Foto del comprobante de un punto del cuaderno del motorizado (MOM §30.9).
 *   POST /api/reparto/cuaderno-foto — multipart: file, rowKey
 *
 * Mismo bucket privado que las pruebas de entrega de rutas (`delivery-proofs`,
 * /api/reparto/foto) y misma idea: se sube ANTES de guardar el punto, así una
 * caída de red no obliga a volver a escribir. Devuelve la ruta; el punto la
 * guarda en `values.comprobante_path` al confirmar.
 */
const BUCKET = "delivery-proofs";
const MAX_BYTES = 12 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

let bucketReady = false;
async function ensureBucket(admin: ReturnType<typeof createAdminSupabase>) {
  if (bucketReady) return;
  await admin.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  bucketReady = true;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  const rider = await getMyRider();
  if (!rider) return NextResponse.json({ error: "Tu usuario no tiene ficha de motorizado." }, { status: 403 });
  const sheet = await getRiderSheet(rider.id);
  if (!sheet) return NextResponse.json({ error: "No tienes hoja de reparto." }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido." }, { status: 400 });
  }
  const rowKey = String(form.get("rowKey") ?? "").trim();
  const file = form.get("file");
  if (!rowKey) return NextResponse.json({ error: "Falta el punto." }, { status: 400 });
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Falta la foto." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "La foto es demasiado grande (máx. 12 MB)." }, { status: 413 });
  const type = (file.type ?? "").toLowerCase();
  if (type && !TYPES.has(type)) return NextResponse.json({ error: "Eso no parece una foto." }, { status: 415 });

  const admin = createAdminSupabase();
  const { data: row } = await admin.from("sheet_rows").select("id").eq("sheet_id", sheet.id).eq("row_key", rowKey).maybeSingle();
  if (!row) return NextResponse.json({ error: "Ese punto no está en tu cuaderno." }, { status: 403 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("hei") ? "heic" : "jpg";
  const path = `cuaderno/${sheet.id}/${row.id}/comprobante-${sha}.${ext}`;
  try {
    await ensureBucket(admin);
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(path, new Blob([bytes as BlobPart], { type: type || "image/jpeg" }), { upsert: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return NextResponse.json({ ok: true, path });
}
