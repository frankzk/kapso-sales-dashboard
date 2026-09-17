import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { parseWorkbookMatrices } from "@/lib/xlsx";
import { parseCsvRows } from "@/lib/csv-parse";
import { importRepartoMatrix } from "@/lib/sheets/reparto-import-db";
import { normalizeAlias } from "@/lib/sheets/statuses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * POST multipart: file (xlsx o csv), sheetId, worksheet? (nombre de la hoja
 * dentro del libro). Importa una hoja de ruta de motorizado en el formato del
 * Excel «MASTER KEY 2.0» (bloques por fecha) a una hoja de Reparto propio.
 *
 * Si el libro trae varias hojas y no se indica cuál, se busca una cuyo nombre
 * coincida con el motorizado de la hoja destino; si no, la primera.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  const perms = await getMasterPermissions();
  if (!perms.can("sheets.edit")) {
    return NextResponse.json({ error: "Tu rol no permite importar en Liquidaciones 2." }, { status: 403 });
  }
  const stores = await getAccessibleStores();
  const orgIds = new Set(stores.map((s) => s.org_id));

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido (se esperaba multipart)." }, { status: 400 });
  }
  const sheetId = String(form.get("sheetId") ?? "").trim();
  const file = form.get("file");
  if (!sheetId) return NextResponse.json({ error: "Falta la hoja destino." }, { status: 400 });
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Falta el archivo." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "El archivo pasa de 25 MB. Exporta solo la hoja del motorizado." }, { status: 413 });
  }

  const admin = createAdminSupabase();
  const { data: sheet } = await admin
    .from("sheets")
    .select("id,org_id,domain_id,key,name,config,sheet_domains!inner(key)")
    .eq("id", sheetId)
    .maybeSingle();
  const domainKey = (sheet as { sheet_domains?: { key?: string } } | null)?.sheet_domains?.key;
  if (!sheet || !orgIds.has(sheet.org_id)) {
    return NextResponse.json({ error: "Hoja fuera de tu acceso." }, { status: 403 });
  }
  if (domainKey !== "reparto_propio") {
    return NextResponse.json({ error: "Por ahora solo se importan hojas de Reparto propio." }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let matrix: string[][];
  let worksheetName: string | null = null;
  const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";
  try {
    if (isCsv) {
      matrix = parseCsvRows(bytes.toString("utf8"));
    } else {
      const books = await parseWorkbookMatrices(bytes);
      const asked = String(form.get("worksheet") ?? "").trim();
      const riderName = String((sheet.config as { rider_name?: string })?.rider_name ?? sheet.name);
      const wanted = normalizeAlias(asked || riderName);
      const names = [...books.keys()];
      worksheetName =
        (asked && names.find((n) => normalizeAlias(n) === normalizeAlias(asked))) ||
        names.find((n) => normalizeAlias(n) === wanted) ||
        names.find((n) => normalizeAlias(n).startsWith(wanted.split(" ")[0] ?? wanted)) ||
        names[0] ||
        null;
      matrix = worksheetName ? (books.get(worksheetName) ?? []) : [];
    }
  } catch (e) {
    return NextResponse.json({ error: `No se pudo leer el archivo: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }
  if (!matrix.length) return NextResponse.json({ error: "La hoja está vacía." }, { status: 400 });

  try {
    const summary = await importRepartoMatrix(
      admin,
      { id: sheet.id, org_id: sheet.org_id, domain_id: sheet.domain_id, key: sheet.key, name: sheet.name },
      matrix,
      { userId: user.id, filename: file.name || null },
    );
    return NextResponse.json({ ok: true, worksheet: worksheetName, ...summary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
