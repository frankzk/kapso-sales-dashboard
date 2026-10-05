import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { parseUrpiReport } from "@/lib/urpi-report";
import { requireUrpiReportOrg } from "@/lib/urpi-report-access";
import { importUrpiReport } from "@/lib/urpi-report-import";

export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_BYTES = 8 * 1024 * 1024;

/** Carga el export «Reporte del mes – detallado» de Urpi (.csv). */
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > MAX_BYTES + 65536) return NextResponse.json({ error: "El archivo supera 8 MB." }, { status: 413 });
    const form = await request.formData();
    const access = await requireUrpiReportOrg(String(form.get("orgId") ?? ""), "sheets.edit")
      .catch((error: unknown) => error instanceof Error ? error : new Error("Sin acceso."));
    if (access instanceof Error) return NextResponse.json({ error: access.message }, { status: 403 });
    const file = form.get("file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv")) return NextResponse.json({ error: "Carga el archivo .csv que exporta Urpi desde «Reporte del mes – detallado»." }, { status: 400 });
    if (!file.size || file.size > MAX_BYTES) return NextResponse.json({ error: "El archivo debe pesar entre 1 byte y 8 MB." }, { status: 413 });
    const report = parseUrpiReport(await file.text());
    const result = await importUrpiReport(access.admin, {
      orgId: String(form.get("orgId")), actor: access.user.id, filename: file.name.slice(0, 200), report, stores: access.stores,
    });
    revalidatePath("/dashboard/urpi");
    const unknown = result.unknownResults.length ? ` Estados que Kapta no reconoce y no interpreta: ${result.unknownResults.join(", ")}.` : "";
    return NextResponse.json({
      ok: true, ...result,
      message: `Reporte de Urpi leído: ${result.rows} intentos (${result.new} nuevos, ${result.changed} con cambios). ${result.linked} vinculados a un pedido, ${result.review} con varios pedidos posibles y ${result.notFound} sin pedido.${unknown}`,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "No se pudo importar el reporte." }, { status: 400 });
  }
}
