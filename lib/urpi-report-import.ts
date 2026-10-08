import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UrpiReport } from "./urpi-report";
import { loadUrpiCandidateOrders, resolveUrpiLinks, type UrpiLink, type UrpiLinkMethod, type UrpiLinkStatus } from "./urpi-report-link";

export interface UrpiReportImportResult {
  rows: number;
  new: number;
  changed: number;
  linked: number;
  review: number;
  notFound: number;
  unknownResults: string[];
}

interface StoredRow {
  urpi_row: number;
  digest: string;
  order_id: string | null;
  store_id: string | null;
  link_status: UrpiLinkStatus;
  link_method: UrpiLinkMethod | null;
  candidate_order_ids: string[] | null;
}

// ~1,5 KB por fila: 200 filas mantienen cada llamada muy por debajo del límite
// de cuerpo de la API.
const BATCH = 200;
const sameLink = (a: UrpiLink, b: StoredRow) => a.orderId === b.order_id && a.linkStatus === b.link_status
  && a.linkMethod === b.link_method && JSON.stringify(a.candidates) === JSON.stringify(b.candidate_order_ids ?? []);

/**
 * Guarda un reporte de Urpi. Reimportar lo mismo no toca ninguna fila; una fila
 * nueva o cambiada deja versión; el vínculo se recalcula salvo el manual. Cada
 * carga queda registrada, cambie algo o no. Cada
 * lote de 200 filas es atómico (save_urpi_report_batch); si un lote falla, lo
 * anterior queda guardado y volver a cargar el archivo completa el resto.
 */
export async function importUrpiReport(admin: SupabaseClient, input: {
  orgId: string; actor: string; filename: string | null; report: UrpiReport; stores: readonly { id: string; name: string }[];
}): Promise<UrpiReportImportResult> {
  const { orgId, report } = input;
  const stored = new Map<number, StoredRow>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("urpi_report_rows")
      .select("urpi_row,digest,order_id,store_id,link_status,link_method,candidate_order_ids")
      .eq("org_id", orgId).order("urpi_row").range(from, from + 999);
    if (error) throw new Error("No se pudo leer lo ya importado de Urpi. No se guardó el reporte.");
    for (const row of (data ?? []) as StoredRow[]) stored.set(row.urpi_row, row);
    if ((data ?? []).length < 1000) break;
  }
  const existing = new Map<number, UrpiLink>([...stored].map(([urpiRow, row]) => [urpiRow, {
    orderId: row.order_id, storeId: row.store_id, linkStatus: row.link_status, linkMethod: row.link_method, candidates: row.candidate_order_ids ?? [],
  }]));
  const phones = report.rows.map((row) => row.phone).filter((phone): phone is string => Boolean(phone));
  const orders = await loadUrpiCandidateOrders(admin, input.stores.map((store) => store.id), phones);
  const links = resolveUrpiLinks(report.rows, orders, existing, input.stores);

  const payload = report.rows.flatMap((row) => {
    const link = links.get(row.urpiRow)!;
    const digest = createHash("sha256").update(JSON.stringify(row)).digest("hex");
    const before = stored.get(row.urpiRow);
    if (before && before.digest === digest && (before.link_method === "manual" || sameLink(link, before))) return [];
    return [{
      urpi_row: row.urpiRow, previous_row: row.previousRow, report_date: row.reportDate, result_code: row.resultCode, phone: row.phone,
      data: row, digest, order_id: link.orderId, store_id: link.storeId, link_status: link.linkStatus, link_method: link.linkMethod,
      candidate_order_ids: link.candidates,
    }];
  });

  const result: UrpiReportImportResult = { rows: report.rows.length, new: 0, changed: 0, linked: 0, review: 0, notFound: 0, unknownResults: report.unknownResults };
  for (const link of links.values()) {
    if (link.linkStatus === "vinculado") result.linked++;
    else if (link.linkStatus === "varios") result.review++;
    else result.notFound++;
  }
  // La lectura se registra aunque no cambie nada: la pantalla dice cuándo se
  // cargó el último reporte.
  const { data: created, error: importError } = await admin.from("urpi_report_imports")
    .insert({ org_id: orgId, created_by: input.actor, filename: input.filename, row_count: report.rows.length }).select("id").single();
  if (importError || !created) throw new Error("No se pudo registrar la lectura del reporte. Vuelve a intentar.");
  for (let i = 0; i < payload.length; i += BATCH) {
    const { data, error } = await admin.rpc("save_urpi_report_batch", { p_org_id: orgId, p_import_id: created.id, p_rows: payload.slice(i, i + BATCH) });
    if (error) {
      const saved = i ? ` Se guardaron ${i} filas; vuelve a cargar el archivo para completar el resto.` : " No se guardó ninguna fila.";
      throw new Error(`No se pudo guardar el reporte de Urpi.${saved}`);
    }
    const counts = data as { new?: number; changed?: number } | null;
    result.new += counts?.new ?? 0;
    result.changed += counts?.changed ?? 0;
  }
  return result;
}
