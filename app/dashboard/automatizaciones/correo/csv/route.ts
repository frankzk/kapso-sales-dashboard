import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { limaDayOf } from "@/lib/agent-tools";
import { exportResendContacts } from "@/lib/resend-marketing-server";
import { isResendBucket, resendContactsCsv, resendCsvFilename } from "@/lib/resend-marketing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// «Descargar CSV» de Correo · Resend (MOM §46): el mismo archivo que Kapta sube
// a Resend, para cargarlo a mano o guardarlo. Pide `automations.manage` y
// `data.export` en la organización de la tienda, y que la tienda se vea.
//   /dashboard/automatizaciones/correo/csv?store=<id>&bucket=6m|12m|todos
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const storeId = sp.get("store") ?? "";
  const bucket = sp.get("bucket");
  if (!isResendBucket(bucket)) return text("Elige un tramo.", 400);
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return text("Inicia sesión.", 401);
  const { data: store } = await sb.from("stores").select("id, name, org_id").eq("id", storeId).maybeSingle();
  if (!store) return text("No encontramos esa tienda.", 404);
  const orgId = (store as { org_id: string }).org_id;
  const [manage, exportOk] = await Promise.all([
    hasOrgPermission(orgId, "automations.manage"),
    hasOrgPermission(orgId, "data.export"),
  ]);
  if (!manage || !exportOk) return text("Tu usuario no tiene permiso para descargar contactos. Pídeselo a un administrador.", 403);
  const res = await exportResendContacts(createAdminSupabase(), store.id, bucket);
  if (!res.ok) return text(res.error, 500);
  return new NextResponse(resendContactsCsv(res.value.contacts), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${resendCsvFilename(store.name, bucket, limaDayOf(new Date()))}"`,
      "Cache-Control": "no-store",
    },
  });
}

function text(body: string, status: number) {
  return new NextResponse(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
