import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { parseCsv } from "@/lib/csv-parse";
import { parseSheet } from "@/lib/xlsx";
import { ingestAliclikReport } from "@/lib/aliclik-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Large reports (1000s of rows) parse + bulk-write here; give the function room.
export const maxDuration = 120;

// Upload an Aliclik delivery report (CSV or XLSX) and ingest it into shipments.
//   POST /api/import/aliclik   (multipart: file=<report>, storeId=<default store>)
// Auth: the caller must have access to the chosen store. Heavy writes go through
// the service role inside ingestAliclikReport.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });

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
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Falta el archivo del reporte." }, { status: 400 });
  }
  // Size cap BEFORE parsing: an XLSX is a zip, so a small upload can inflate to
  // hundreds of MB in memory (zip bomb) → OOM. Real Aliclik reports are well
  // under this. (Route handlers don't honor the Server Actions bodySizeLimit.)
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "El archivo es demasiado grande (máx. 8 MB)." },
      { status: 413 },
    );
  }

  // Parse by extension/type: CSV text vs XLSX binary.
  const name = file.name || "reporte";
  const lower = name.toLowerCase();
  let rows: Record<string, string>[];
  try {
    if (lower.endsWith(".csv") || file.type === "text/csv") {
      rows = parseCsv(await file.text());
    } else if (lower.endsWith(".xlsx") || file.type.includes("spreadsheet")) {
      rows = await parseSheet(await file.arrayBuffer());
    } else {
      // last resort: try CSV text
      rows = parseCsv(await file.text());
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `No se pudo leer el archivo: ${msg}` }, { status: 400 });
  }

  if (!rows.length) {
    return NextResponse.json({ error: "El archivo no tiene filas de datos." }, { status: 400 });
  }
  const MAX_ROWS = 50_000;
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `El reporte tiene demasiadas filas (${rows.length}, máx. ${MAX_ROWS}).` },
      { status: 413 },
    );
  }

  const admin = createAdminSupabase();
  try {
    const result = await ingestAliclikReport(admin, storeId, accessibleIds, rows, {
      filename: name,
      uploadedBy: user.id,
      reportAt: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
