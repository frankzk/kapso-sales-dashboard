// El Excel de una importación (MOM §45.9).
//   GET /api/compras/excel/<id>
//
// `loadImportDetail` vuelve a pedir el permiso EN la organización de la
// importación («Compras» o «Montos de compras») y, sin «Montos de compras», no
// lee costos, precios, tipo de cambio, costos repartidos ni pagos; el libro
// tampoco los escribe. Sin permiso, de otra organización o inexistente: lo
// mismo (404), no se distingue.

import { NextResponse } from "next/server";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { loadImportDetail } from "@/lib/compras-server";
import { buildImportWorkbook, importExcelFilename } from "@/lib/exports/compras-importacion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers: NO_STORE });
  const detail = await loadImportDetail(id);
  if (!detail) return NextResponse.json({ error: "No encontramos esa importación." }, { status: 404, headers: NO_STORE });
  const stores = await getAccessibleStores();
  const storeNames = new Map(stores.filter((s) => s.org_id === detail.imp.org_id).map((s) => [s.id, s.name]));
  const body = await buildImportWorkbook(detail, { storeNames });
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      ...NO_STORE,
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${importExcelFilename(detail.imp.code)}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
