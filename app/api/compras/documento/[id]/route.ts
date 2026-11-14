// Un documento de una importación (MOM §45).
//   GET /api/compras/documento/<id>          → lo abre
//   GET /api/compras/documento/<id>?dl=1     → lo descarga con su nombre
//
// El bucket `import-files` es privado. Se vuelve a pedir el permiso EN la
// organización de la importación: `purchases.manage` o `purchases.money`, y la
// proforma y el comprobante de pago solo con `purchases.money`. Responde 302 a
// un enlace firmado de 10 minutos; nadie recibe una URL permanente.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import { IMPORT_FILES_BUCKET, isMoneyDoc, isUuid } from "@/lib/compras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };
const NOT_FOUND = () => NextResponse.json({ error: "No encontramos ese documento." }, { status: 404, headers: NO_STORE });

/** El nombre para la descarga, sin lo que rompe una cabecera. */
function safeName(name: string | null): string {
  return (name ?? "documento").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "documento";
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers: NO_STORE });
  if (!isUuid(id)) return NOT_FOUND();

  const admin = createAdminSupabase();
  const { data } = await admin.from("import_documents").select("org_id,kind,storage_path,filename").eq("id", id).maybeSingle();
  const doc = data as { org_id: string; kind: string; storage_path: string; filename: string | null } | null;
  if (!doc) return NOT_FOUND();

  const [canManage, canMoney] = await Promise.all([
    hasOrgPermission(doc.org_id, "purchases.manage"),
    hasOrgPermission(doc.org_id, "purchases.money"),
  ]);
  if (!canManage && !canMoney) return NOT_FOUND();
  if (isMoneyDoc(doc.kind) && !canMoney) return NOT_FOUND();

  const download = req.nextUrl.searchParams.get("dl") === "1" ? safeName(doc.filename) : undefined;
  const { data: signed, error } = await admin.storage
    .from(IMPORT_FILES_BUCKET)
    .createSignedUrl(doc.storage_path, 600, download ? { download } : undefined);
  if (error || !signed) return NOT_FOUND();
  return NextResponse.redirect(signed.signedUrl, { status: 302, headers: NO_STORE });
}
