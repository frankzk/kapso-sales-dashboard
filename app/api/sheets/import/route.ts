import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { parseWorkbookMatrices } from "@/lib/xlsx";
import { parseCsvRows } from "@/lib/csv-parse";
import { applyRepartoImport, importRepartoMatrix, statusLookupForSheet } from "@/lib/sheets/reparto-import-db";
import { parsedFromVisionLines } from "@/lib/sheets/reparto-import";
import { normalizeAlias } from "@/lib/sheets/statuses";
import { MAX_PHOTO_BYTES, readSettlementPhotoFromEnv } from "@/lib/settlement-vision";
import { storeVisionCreds } from "@/lib/store-settings";
import { isCuadernoSheet } from "@/lib/sheets/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/jpg"]);

function isImage(file: File): boolean {
  if (IMAGE_TYPES.has((file.type ?? "").toLowerCase())) return true;
  return /\.(jpe?g|png|gif|webp)$/i.test(file.name ?? "");
}

/**
 * POST multipart: file (xlsx, csv o FOTO del cuaderno), sheetId, worksheet?
 * (nombre de la hoja dentro del libro), fecha? (YYYY-MM-DD, para una foto
 * que no trae fecha). Importa una hoja de ruta en el formato del Excel
 * «MASTER KEY 2.0» (bloques por fecha) a una hoja cuaderno.
 *
 * Si el libro trae varias hojas y no se indica cuál, se busca una cuyo nombre
 * coincida con el motorizado de la hoja destino; si no, la primera.
 *
 * La foto se transcribe con la misma visión que usa Liquidaciones
 * (lib/settlement-vision): lo ilegible queda en blanco, nunca se inventa un
 * monto. Sin fecha en la foto ni en el formulario, responde 422 `needs_date`
 * para que la pantalla la pida en vez de guardar filas sin fecha.
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
  const cuaderno =
    domainKey === "reparto_propio" ||
    (domainKey === "courier_externo" && isCuadernoSheet({ config: sheet.config as Record<string, unknown> }, { row_key: "guia" }));
  if (!cuaderno) {
    return NextResponse.json(
      { error: "Por ahora solo se importan cuadernos de ruta: Reparto propio y los couriers con cuaderno (Alexis, Urpi)." },
      { status: 400 },
    );
  }

  const sheetRef = { id: sheet.id, org_id: sheet.org_id, domain_id: sheet.domain_id, key: sheet.key, name: sheet.name };

  if (isImage(file)) {
    if (file.size > MAX_PHOTO_BYTES) {
      return NextResponse.json({ error: "La foto pasa de 8 MB. Reduce la resolución." }, { status: 413 });
    }
    // Credenciales de visión: la primera tienda de la organización que las
    // tenga; si ninguna, las del entorno (resolveVisionCreds hace el fallback).
    let creds: { anthropicApiKey: string | null; anthropicModel: string | null } = { anthropicApiKey: null, anthropicModel: null };
    for (const store of stores.filter((s) => s.org_id === sheet.org_id)) {
      const c = await storeVisionCreds(admin, store.id);
      if (c.anthropicApiKey) {
        creds = c;
        break;
      }
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const read = await readSettlementPhotoFromEnv(bytes.toString("base64"), file.type, creds);
    if (!read.ok) {
      const message =
        read.failure === "missing_credentials"
          ? "No hay una clave de visión configurada (ANTHROPIC_API_KEY o la de la tienda): no se puede leer la foto."
          : read.failure === "timeout"
            ? "La foto tiene muchas filas y la lectura agotó el tiempo. Reintenta una vez."
            : `No se pudo leer la foto. ${read.detail ?? "Reintenta o sube un Excel."}`;
      return NextResponse.json({ error: message }, { status: 502 });
    }
    const askedDate = String(form.get("fecha") ?? "").trim();
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(askedDate) ? askedDate : read.settlementDate;
    if (!fecha) {
      return NextResponse.json(
        { error: "La foto no trae fecha: indica la fecha de la ruta.", needs_date: true, lines: read.lines.length },
        { status: 422 },
      );
    }
    if (!read.lines.length) return NextResponse.json({ error: "La foto no parece una hoja de ruta: no se leyó ninguna fila." }, { status: 400 });
    try {
      const lookup = await statusLookupForSheet(admin, sheetRef);
      const parsed = parsedFromVisionLines(read.lines, fecha, lookup);
      const summary = await applyRepartoImport(admin, sheetRef, parsed, { userId: user.id, filename: file.name || "foto" });
      return NextResponse.json({ ok: true, worksheet: `foto · ${fecha}`, ...summary });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
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
    const summary = await importRepartoMatrix(admin, sheetRef, matrix, { userId: user.id, filename: file.name || null });
    return NextResponse.json({ ok: true, worksheet: worksheetName, ...summary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
