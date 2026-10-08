import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { buildNotebookPlan, ddmm } from "@/lib/notebook-import";
import { loadNotebookContext, NOTEBOOK_BUCKET, notebookAccess } from "@/lib/notebook-import-access";
import { readRiderSheet } from "@/lib/rider-sheet-vision";
import { resolveVisionCreds } from "@/lib/vision";
import { storeVisionCreds } from "@/lib/store-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Tres capturas de 50 filas tardan; el lector corta a los 105 s.
export const maxDuration = 120;

const MAX_PHOTOS = 4;

/**
 * Lee la hoja del motorizado sin app y la cruza con su ruta (MOM §29.7).
 *   POST /api/courier/notebook — JSON: { routeId, sheetDate?, paths: string[] }
 *
 * No escribe en la ruta: guarda la lectura y la propuesta en
 * `rider_notebook_imports` y la devuelve para que quien liquida la revise.
 * Aplicar es POST /api/courier/notebook/apply.
 */
export async function POST(req: NextRequest) {
  let body: { routeId?: unknown; sheetDate?: unknown; paths?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido." }, { status: 400 });
  }
  const routeId = typeof body.routeId === "string" ? body.routeId.trim() : "";
  const sheetDate = typeof body.sheetDate === "string" ? body.sheetDate.trim() : null;
  const access = await notebookAccess(routeId, sheetDate);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const { target, userId } = access;

  const prefix = `${target.orgId}/${target.riderId}/`;
  const paths = (Array.isArray(body.paths) ? body.paths : [])
    .filter((p): p is string => typeof p === "string" && p.startsWith(prefix) && !p.includes(".."))
    .slice(0, MAX_PHOTOS);
  if (!paths.length) return NextResponse.json({ error: "Sube al menos una foto de la hoja." }, { status: 400 });

  const admin = createAdminSupabase();
  const images: { base64: string; contentType: string }[] = [];
  for (const path of paths) {
    const { data, error } = await admin.storage.from(NOTEBOOK_BUCKET).download(path);
    if (error || !data) return NextResponse.json({ error: "No encontramos una de las fotos: súbela otra vez." }, { status: 404 });
    images.push({ base64: Buffer.from(await data.arrayBuffer()).toString("base64"), contentType: data.type || "image/jpeg" });
  }

  const creds = resolveVisionCreds(target.storeId ? await storeVisionCreds(admin, target.storeId) : {});
  if (!creds.apiKey) return NextResponse.json({ error: "No hay clave de visión configurada para leer la foto." }, { status: 503 });
  const sheet = await readRiderSheet(images, creds);
  if (!sheet.ok) {
    return NextResponse.json({ error: `No se pudo leer la hoja: ${sheet.detail ?? "inténtalo otra vez."}` }, { status: 502 });
  }
  if (!sheet.lines.length) {
    return NextResponse.json({ error: "La foto no parece una hoja de reparto: no se leyó ninguna fila." }, { status: 422 });
  }

  const { ctx } = await loadNotebookContext(target, sheet.lines, admin);
  const plan = buildNotebookPlan(sheet.lines, ctx, sheet.totals);
  const notices: string[] = [];
  if (sheet.date && sheet.date !== target.routeDate) {
    notices.push(`La cabecera dice ${ddmm(sheet.date)}${sheet.date.slice(0, 4) !== target.routeDate.slice(0, 4) ? `/${sheet.date.slice(0, 4)}` : ""} y se cruza con la ruta del ${ddmm(target.routeDate)}: revisa que sea la hoja de ese día.`);
  }
  if (!target.routeId) notices.push(`${target.riderName} no tiene ruta el ${ddmm(target.routeDate)}: solo se pueden pasar sus reprogramados, y eso la abre.`);
  else if (target.routeStatus !== "en_curso") {
    notices.push(target.routeStatus === "cerrada"
      ? `La ruta del ${ddmm(target.routeDate)} ya está cerrada: no se puede reportar nada.`
      : `La ruta del ${ddmm(target.routeDate)} todavía no está en curso: ${target.riderName} tiene que recibir su caja antes de reportar.`);
  }

  const { data: saved, error } = await admin
    .from("rider_notebook_imports")
    .insert({
      org_id: target.orgId,
      rider_id: target.riderId,
      route_date: target.routeDate,
      route_id: target.routeId,
      photo_paths: paths,
      transcription: { date: sheet.date, rider_name: sheet.riderName, totals: sheet.totals, lines: sheet.lines, model: sheet.model },
      plan: plan.rows,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error || !saved) return NextResponse.json({ error: `No se pudo guardar la lectura: ${error?.message ?? "inténtalo otra vez."}` }, { status: 500 });

  return NextResponse.json({
    ok: true,
    importId: (saved as { id: string }).id,
    target: { riderName: target.riderName, routeDate: target.routeDate, routeId: target.routeId, routeStatus: target.routeStatus },
    sheetDate: sheet.date,
    photos: paths,
    plan,
    notices,
  });
}
