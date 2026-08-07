// Descarga del Master en Excel, con los filtros que tuviera la tabla.
//
// POR QUÉ RECIBE LA URL ENTERA. El botón manda su propio `location.search`, y
// aquí se parsea con `parseMasterQuery` — el MISMO códec que usa la página
// (app/dashboard/pedidos/page.tsx). Así exportar no puede divergir de listar:
// mismos filtros, misma pestaña, misma subetapa, mismo orden. Si en su lugar
// recibiera "provincia=Arequipa" y montara la consulta por su cuenta, el día
// que se añada un filtro nuevo la hoja saldría con filas de más sin que nadie
// se entere.
//
// SE EXPORTA TODO LO FILTRADO, no la página que se ve. La tabla enseña 100 de
// 128 y bajar solo esas 100 sería la clase de error que no da ningún aviso:
// el fichero parece completo. Se pagina hasta agotar el conjunto.

import { NextResponse, type NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { getAccessibleStores } from "@/lib/access";
import {
  getOrderMasterPage,
  isMasterView,
  type MasterView,
} from "@/lib/orders-master-access";
import { parseMasterQuery } from "@/lib/master-query";
import { MACRO_SUBSTAGES_BY_STAGE, type MacroSubstage } from "@/lib/order-macro-stage";
import {
  MASTER_EXPORT_COLUMNS,
  exportFilename,
  toExportRow,
  type MasterExportContext,
} from "@/lib/master-export";
import type { OrderMasterRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Un Master filtrado puede ser de miles de filas; el tope por defecto se queda
// corto justo en el caso que más falta hace exportar.
export const maxDuration = 120;

/** Filas por consulta. Alto para dar pocos viajes, por debajo del tope de
 *  PostgREST para que ninguna página vuelva recortada en silencio. */
const CHUNK = 1000;
/**
 * Tope duro de filas. No es una preferencia: por encima de esto la petición se
 * acerca al límite de memoria y de tiempo de la función, y un fichero a medias
 * sin avisar sería peor que un aviso. Se informa en la respuesta.
 */
const MAX_ROWS = 20_000;

export async function GET(req: NextRequest) {
  // Mismo alcance que la pantalla: exportar es leer lo que ya se está viendo.
  // No hay permiso de "ver el Master" — quien tiene tiendas asignadas consulta,
  // y la RLS decide fila a fila dentro de `getOrderMasterPage`. Un permiso
  // propio aquí sería una regla nueva que la tabla no aplica, y acabaría
  // negando el fichero a quien sí ve las filas en pantalla.
  const stores = await getAccessibleStores();
  if (!stores.length) return new NextResponse("forbidden", { status: 403 });
  const storeIds = stores.map((s) => s.id);

  // Mismo parseo que la página: la URL es el contrato entre la tabla y esto.
  const sp = req.nextUrl.searchParams;
  const { filters } = parseMasterQuery(sp);
  const rawView = sp.get("view") ?? undefined;
  const view: MasterView = isMasterView(rawView) ? rawView : "todos";
  const rawSubstage = sp.get("substage") ?? "";
  const substage: MacroSubstage | null =
    view !== "todos" && rawSubstage && MACRO_SUBSTAGES_BY_STAGE[view].includes(rawSubstage as MacroSubstage)
      ? (rawSubstage as MacroSubstage)
      : null;

  const now = new Date();
  const rows: OrderMasterRow[] = [];
  let truncated = false;

  for (let page = 1; ; page++) {
    const res = await getOrderMasterPage(storeIds, {
      view,
      substage,
      filters,
      sortKey: "created",
      page,
      pageSize: CHUNK,
      now,
    });
    rows.push(...res.rows);
    if (res.rows.length < CHUNK) break;
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
  }

  const ctx: MasterExportContext = {
    storeNames: Object.fromEntries(stores.map((s) => [s.id, s.name])),
    now,
  };

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Kapta";
  workbook.created = now;
  const sheet = workbook.addWorksheet("PEDIDOS", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = MASTER_EXPORT_COLUMNS.map((c) => ({ width: c.width }));

  const header = sheet.addRow(MASTER_EXPORT_COLUMNS.map((c) => c.header));
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle" };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF08112F" } };
  });

  for (const row of rows) {
    const added = sheet.addRow(toExportRow(row, ctx));
    MASTER_EXPORT_COLUMNS.forEach((col, index) => {
      const cell = added.getCell(index + 1);
      if (col.kind === "date") cell.numFmt = "dd/mm/yyyy";
      else if (col.kind === "money") cell.numFmt = '"S/ "#,##0.00';
      else if (col.kind === "text") cell.numFmt = "@";
    });
  }

  // Filtros de Excel sobre la cabecera: quien baja el listado casi siempre
  // quiere seguir acotando dentro de la hoja.
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: MASTER_EXPORT_COLUMNS.length },
  };

  const bytes = await workbook.xlsx.writeBuffer();
  const headers: Record<string, string> = {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${exportFilename(view, now)}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    // El botón lo lee para avisar en pantalla cuando el corte se aplicó.
    "X-Export-Rows": String(rows.length),
    "X-Export-Truncated": truncated ? "1" : "0",
  };
  return new NextResponse(Buffer.from(bytes), { headers });
}
