// La foto de un producto de una importación (MOM §45).
//   GET /api/compras/foto/<producto>
//
// Se entrega el archivo desde el servidor (no un enlace a Storage): la CSP del
// panel solo deja cargar imágenes del mismo origen. Pide `purchases.manage` o
// `purchases.money` EN la organización de la importación.

import { NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import { IMPORT_FILES_BUCKET, isUuid } from "@/lib/compras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "No encontramos esa foto." }, { status: 404 });

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  if (!isUuid(id)) return NOT_FOUND();

  const admin = createAdminSupabase();
  const { data } = await admin.from("import_items").select("org_id,image_path").eq("id", id).maybeSingle();
  const item = data as { org_id: string; image_path: string | null } | null;
  if (!item?.image_path) return NOT_FOUND();
  const [canManage, canMoney] = await Promise.all([
    hasOrgPermission(item.org_id, "purchases.manage"),
    hasOrgPermission(item.org_id, "purchases.money"),
  ]);
  if (!canManage && !canMoney) return NOT_FOUND();

  const { data: file, error } = await admin.storage.from(IMPORT_FILES_BUCKET).download(item.image_path);
  if (error || !file) return NOT_FOUND();
  return new NextResponse(file, {
    headers: {
      "content-type": file.type || "image/jpeg",
      // La ruta lleva un uuid y la foto no cambia: se guarda en el navegador.
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
