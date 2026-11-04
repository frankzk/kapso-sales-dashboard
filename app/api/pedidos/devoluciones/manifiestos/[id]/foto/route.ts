// La foto opcional de un manifiesto de devolución (0307): la hoja que trae el
// motorizado o el acta firmada (owner, 04-11-2026: opcional).
//   POST /api/pedidos/devoluciones/manifiestos/<id>/foto — multipart: file
//   GET  /api/pedidos/devoluciones/manifiestos/<id>/foto?path=<ruta>
//
// Se guarda en el bucket privado de las hojas del motorizado, bajo
// `return-manifests/<org>/<manifiesto>/`. Abierto o cerrado se pueden AÑADIR
// fotos (el acta se firma después de cerrar); nunca quitar (0307).

import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { PHOTO_UPLOAD_LIMIT } from "@/lib/photo-resize";
import { NOTEBOOK_BUCKET } from "@/lib/notebook-import-access";
import { returnManifestAccess } from "@/lib/return-manifest-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
/** El tope de la base (`photo_paths`, 0307). */
const MAX_PHOTOS = 20;

async function manifestAccess(id: string) {
  const user = await getCurrentUser();
  if (!user) return { status: 401, error: "No autenticado." } as const;
  const admin = createAdminSupabase();
  const { data } = await admin.from("return_manifests").select("id,org_id,state,photo_paths").eq("id", id).maybeSingle();
  const header = data as { id: string; org_id: string; state: string; photo_paths: string[] | null } | null;
  if (!header) return { status: 404, error: "No encontramos ese manifiesto de devolución." } as const;
  const access = await returnManifestAccess(header.org_id);
  if (!access.ok) return { status: 404, error: "No encontramos ese manifiesto de devolución." } as const;
  return { admin, header } as const;
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const ctx = await manifestAccess(id);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  if (ctx.header.state === "cancelled") return NextResponse.json({ error: "El manifiesto está anulado." }, { status: 409 });
  // Lleno: se dice antes de subir nada, en vez de guardar una foto que no se verá.
  if ((ctx.header.photo_paths ?? []).length >= MAX_PHOTOS) {
    return NextResponse.json({ error: `Ya tiene ${MAX_PHOTOS} fotos: no caben más.` }, { status: 409 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Falta la foto." }, { status: 400 });
  if (file.size > PHOTO_UPLOAD_LIMIT) return NextResponse.json({ error: "La foto pesa más de 4 MB." }, { status: 413 });
  const type = (file.type ?? "").toLowerCase();
  if (!TYPES.has(type)) return NextResponse.json({ error: "Eso no parece una foto (JPG, PNG o WEBP)." }, { status: 415 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const path = `return-manifests/${ctx.header.org_id}/${id}/${sha}.${ext}`;
  await ctx.admin.storage.createBucket(NOTEBOOK_BUCKET, { public: false }).catch(() => {});
  const { error } = await ctx.admin.storage.from(NOTEBOOK_BUCKET).upload(path, new Blob([bytes as BlobPart], { type }), { upsert: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const paths = [...new Set([...(ctx.header.photo_paths ?? []), path])];
  const { error: updateError } = await ctx.admin.from("return_manifests").update({ photo_paths: paths, updated_at: new Date().toISOString() }).eq("id", id);
  if (updateError) return NextResponse.json({ error: updateError.message.replace(/^.*?ERROR:\s*/, "") }, { status: 409 });
  return NextResponse.json({ ok: true, path });
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const ctx = await manifestAccess(id);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const path = (req.nextUrl.searchParams.get("path") ?? "").trim();
  if (!path || path.includes("..") || !(ctx.header.photo_paths ?? []).includes(path)) {
    return NextResponse.json({ error: "No encontramos esa foto." }, { status: 404 });
  }
  const { data, error } = await ctx.admin.storage.from(NOTEBOOK_BUCKET).download(path);
  if (error || !data) return NextResponse.json({ error: "No encontramos esa foto." }, { status: 404 });
  return new NextResponse(data, { headers: { "content-type": data.type || "image/jpeg", "cache-control": "private, max-age=300" } });
}
