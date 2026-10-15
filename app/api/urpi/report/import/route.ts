import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { parseUrpiReport } from "@/lib/urpi-report";
import { canMarkUrpiDeliveries, requireUrpiReportOrg } from "@/lib/urpi-report-access";
import { importUrpiReport } from "@/lib/urpi-report-import";
import { applyUrpiDeliveriesFor, urpiAutoApplyMessage, urpiDeliveredOrderIds } from "@/lib/urpi-report-apply";

export const runtime = "nodejs";
// Además de guardar, marca los entregados y rellena sus salidas: la primera
// carga con esta regla tocó ~110 pedidos (MOM §30.11, 15-10-2026).
export const maxDuration = 300;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Carga el export «Reporte del mes – detallado» de Urpi (.csv) y, si quien lo
 * carga puede editar el Master, marca entregados los pedidos que Urpi entregó
 * (MOM §30.11, desde el 15-10-2026). Si el marcado falla, el reporte ya quedó
 * guardado y «Entregados por marcar» sigue ahí para hacerlo a mano.
 */
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > MAX_BYTES + 65536) return NextResponse.json({ error: "El archivo supera 8 MB." }, { status: 413 });
    const form = await request.formData();
    const orgId = String(form.get("orgId") ?? "");
    const access = await requireUrpiReportOrg(orgId, "sheets.edit")
      .catch((error: unknown) => error instanceof Error ? error : new Error("Sin acceso."));
    if (access instanceof Error) return NextResponse.json({ error: access.message }, { status: 403 });
    const file = form.get("file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv")) return NextResponse.json({ error: "Carga el archivo .csv que exporta Urpi desde «Reporte del mes – detallado»." }, { status: 400 });
    if (!file.size || file.size > MAX_BYTES) return NextResponse.json({ error: "El archivo debe pesar entre 1 byte y 8 MB." }, { status: 413 });
    const report = parseUrpiReport(await file.text());
    const result = await importUrpiReport(access.admin, {
      orgId, actor: access.user.id, filename: file.name.slice(0, 200), report, stores: access.stores,
    });
    let delivered: string;
    if (!(await canMarkUrpiDeliveries(orgId))) delivered = "No tienes permiso para editar el Master: los entregados quedan en «Entregados por marcar».";
    else {
      try {
        const ids = await urpiDeliveredOrderIds(access.admin, orgId);
        const applied = await applyUrpiDeliveriesFor(access.admin, { orgId, actor: access.user.id, visibleStoreIds: access.visibleStoreIds, orderIds: ids, auto: "carga" });
        delivered = urpiAutoApplyMessage(applied);
        revalidatePath("/dashboard/pedidos");
      } catch (error) {
        delivered = `No se pudieron marcar los entregados: ${error instanceof Error ? error.message : "error desconocido"}. Márcalos desde «Entregados por marcar».`;
      }
    }
    revalidatePath("/dashboard/urpi");
    const unknown = result.unknownResults.length ? ` Estados que Kapta no reconoce y no interpreta: ${result.unknownResults.join(", ")}.` : "";
    return NextResponse.json({
      ok: true, ...result,
      message: `Reporte de Urpi leído: ${result.rows} intentos (${result.new} nuevos, ${result.changed} con cambios). ${result.linked} vinculados a un pedido, ${result.review} con varios pedidos posibles y ${result.notFound} sin pedido.${unknown}\n${delivered}`,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "No se pudo importar el reporte." }, { status: 400 });
  }
}
