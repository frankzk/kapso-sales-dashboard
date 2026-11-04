// El acta del manifiesto de devolución (0307), para descargar e imprimir.
//   GET /api/pedidos/devoluciones/manifiestos/<id>/acta?formato=pdf|xlsx
//
// Permiso de Almacén (`warehouse.prepare`) en la organización del manifiesto;
// las líneas, de las tiendas de quien descarga. Sin datos de clientes.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/access";
import { getReturnManifestActa } from "@/lib/return-manifest-access";
import { actaFilename, buildReturnManifestActaPdf, buildReturnManifestActaWorkbook } from "@/lib/exports/return-manifest-acta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  // Sin permiso, de otra organización o inexistente: lo mismo, no se distingue.
  const acta = await getReturnManifestActa(id);
  if (!acta) return NextResponse.json({ error: "No encontramos ese manifiesto de devolución." }, { status: 404 });
  const format = request.nextUrl.searchParams.get("formato") === "xlsx" ? "xlsx" : "pdf";
  const body = format === "xlsx" ? await buildReturnManifestActaWorkbook(acta) : await buildReturnManifestActaPdf(acta);
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": format === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/pdf",
      "content-disposition": `attachment; filename="${actaFilename(acta, format)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
