import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getAdminOrgs, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { PHOTO_UPLOAD_LIMIT } from "@/lib/photo-resize";
import { NOTEBOOK_BUCKET, notebookAccess } from "@/lib/notebook-import-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

let bucketReady = false;
async function ensureBucket(admin: ReturnType<typeof createAdminSupabase>) {
  if (bucketReady) return;
  await admin.storage.createBucket(NOTEBOOK_BUCKET, { public: false }).catch(() => {});
  await admin.storage.updateBucket(NOTEBOOK_BUCKET, { public: false }).catch(() => {});
  bucketReady = true;
}

/**
 * Sube una captura de la hoja del motorizado sin app (MOM §29.7).
 *   POST /api/courier/notebook/photo — multipart: file, routeId, sheetDate?
 *
 * Una captura por pedido HTTP: tres capturas de Excel juntas pasan el corte de
 * 4,5 MB con que Vercel rechaza el cuerpo. La lectura viene después, con las
 * rutas que devuelve esto (POST /api/courier/notebook).
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido." }, { status: 400 });
  }
  const access = await notebookAccess(String(form.get("routeId") ?? "").trim(), String(form.get("sheetDate") ?? "").trim() || null);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Falta la foto de la hoja." }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "La foto está vacía." }, { status: 400 });
  if (file.size > PHOTO_UPLOAD_LIMIT) return NextResponse.json({ error: "La foto pesa más de 4 MB: mándala como captura o recórtala." }, { status: 413 });
  const type = (file.type ?? "").toLowerCase();
  if (!TYPES.has(type)) return NextResponse.json({ error: "Eso no parece una foto (JPG, PNG o WEBP)." }, { status: 415 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const { orgId, riderId, routeDate } = access.target;
  const path = `${orgId}/${riderId}/${routeDate}/${sha}.${ext}`;
  const admin = createAdminSupabase();
  try {
    await ensureBucket(admin);
    const { error } = await admin.storage.from(NOTEBOOK_BUCKET).upload(path, new Blob([bytes as BlobPart], { type }), { upsert: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return NextResponse.json({ ok: true, path });
}

/**
 * Enseña una captura ya subida, para revisar la hoja fila por fila.
 *   GET /api/courier/notebook/photo?path=<org>/<motorizado>/<día>/<archivo>
 * Solo quien arma rutas en esa org; se sirve desde aquí, sin enlace firmado.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  const permissions = await getMasterPermissions();
  if (!permissions.can("routes.manage")) return NextResponse.json({ error: "Sin permiso." }, { status: 403 });
  const path = (req.nextUrl.searchParams.get("path") ?? "").trim();
  if (!path || path.includes("..")) return NextResponse.json({ error: "Falta la foto." }, { status: 400 });
  const orgs = await getAdminOrgs();
  if (!orgs.some((o) => path.startsWith(`${o.org_id}/`))) return NextResponse.json({ error: "No encontramos esa foto." }, { status: 404 });
  const { data, error } = await createAdminSupabase().storage.from(NOTEBOOK_BUCKET).download(path);
  if (error || !data) return NextResponse.json({ error: "No encontramos esa foto." }, { status: 404 });
  return new NextResponse(data, {
    headers: { "content-type": data.type || "image/jpeg", "cache-control": "private, max-age=300" },
  });
}
