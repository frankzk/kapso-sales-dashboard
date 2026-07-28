import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { handleCourierUpload, readUpload, UploadError } from "@/lib/courier-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Reportes grandes (miles de filas) se parsean y escriben aquí; dale margen.
export const maxDuration = 120;

// Sube un reporte de CUALQUIER courier (§6) y lo ingesta.
//   POST /api/import/courier
//   multipart: file=<reporte>, storeId=<tienda>, courier=<id|vacío>, reportDate=<YYYY-MM-DD|vacío>
//
// Sin `courier`, el formato se detecta por el contenido (lib/couriers/registry).
// Auth: el usuario debe tener acceso a la tienda y permiso de importación; las
// escrituras pesadas van por el service role dentro de la ingesta.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });

  const perms = await getMasterPermissions();
  if (!perms.can("master.import_report")) {
    return NextResponse.json({ error: "Tu rol no permite cargar reportes." }, { status: 403 });
  }

  const stores = await getAccessibleStores();
  if (!stores.length) return NextResponse.json({ error: "Sin tiendas accesibles." }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido (se esperaba multipart)." }, { status: 400 });
  }

  const storeId = String(form.get("storeId") ?? "");
  const accessibleIds = stores.map((s) => s.id);
  if (!storeId || !accessibleIds.includes(storeId)) {
    return NextResponse.json({ error: "Tienda inválida o sin acceso." }, { status: 403 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo del reporte." }, { status: 400 });
  }

  const courier = String(form.get("courier") ?? "").trim() || null;
  const rawDate = String(form.get("reportDate") ?? "").trim();
  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;

  try {
    const upload = await readUpload(file);
    const admin = createAdminSupabase();
    const result = await handleCourierUpload(admin, {
      storeId,
      accessibleStoreIds: accessibleIds,
      courier,
      reportDate,
      uploadedBy: user.id,
      upload,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof UploadError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
