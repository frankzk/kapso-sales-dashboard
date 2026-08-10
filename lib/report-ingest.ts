// Ingesta genérica de reportes de courier (§6).
//
// Un solo camino para cualquier courier: el adaptador (lib/couriers) traduce el
// archivo a registros canónicos, y aquí se vinculan con el pedido, se escriben
// las guías, se guarda el reporte con su auditoría y se refresca el Master.
//
// Aliclik NO pasa por aquí: tiene su propia ingesta (lib/aliclik-ingest.ts) con
// reglas específicas —elegibilidad Fenix, dirección editada a mano que no se
// pisa, fallback de provincia— que llevan tiempo en producción. Reescribirlas
// para "unificar" sería cambiar comportamiento probado sin ninguna ganancia; el
// endpoint elige el camino según el courier y ambos acaban en el mismo sitio.
//
// SERVER-ONLY: recibe el cliente service-role.

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk } from "@/lib/access";
import { matchShipment, type MatchResult, type OrderCandidate } from "@/lib/shipment-match";
import { reconcileReportedDeliveryStatus, categoryOf } from "@/lib/shipments";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import type { CanonicalReportRow } from "@/lib/couriers/registry";

const BATCH = 500;

export interface ReportIngestMeta {
  filename: string | null;
  uploadedBy: string | null;
  /** Momento de la carga; también hace de cota monotónica del reporte. */
  reportAt: string;
  /** Fecha a la que se refiere el reporte, si el operador la indicó. */
  reportDate?: string | null;
  filePath?: string | null;
  fileType?: string | null;
  fileSha256?: string | null;
}

export interface ReportIngestResult {
  batchId: string;
  rowCount: number;
  foundCount: number;
  matchedCount: number;
  unmatchedCount: number;
  updatedCount: number;
  errorCount: number;
}

interface RowMeta {
  index: number;
  guideCode: string | null;
  storeId: string;
  orderId: string | null;
  matchStatus: "matched" | "review" | "error";
  error: string | null;
  row: CanonicalReportRow;
}

/** Guías ya existentes, para no retroceder lo que el equipo ya avanzó. */
interface ExistingGuide {
  id: string;
  guide_code: string;
  store_id: string;
  delivery_status: string;
  matched: boolean;
  match_method: string | null;
  order_id: string | null;
  last_report_at: string | null;
  /** Solo la escribe la vía API; decide si este reporte puede tocar el estado. */
  api_report_at: string | null;
  pickup_state: string | null;
  returned_at: string | null;
  /** Procedencia del sello (0116). Acompaña a `returned_at` y no se pisa. */
  returned_source: string | null;
}

const EXISTING_COLUMNS =
  "id,guide_code,store_id,delivery_status,matched,match_method,order_id,last_report_at,api_report_at,pickup_state,returned_at,returned_source";

async function fetchExisting(
  admin: SupabaseClient,
  courier: string,
  guides: string[],
): Promise<Map<string, ExistingGuide>> {
  const out = new Map<string, ExistingGuide>();
  for (const batch of chunk(guides, 200)) {
    const { data } = await admin
      .from("shipments")
      .select(EXISTING_COLUMNS)
      .eq("courier", courier)
      .in("guide_code", batch);
    for (const row of (data ?? []) as unknown as ExistingGuide[]) {
      out.set(row.guide_code, row);
    }
  }
  return out;
}

/** Pedidos candidatos para el emparejamiento, por nº de pedido o por teléfono. */
async function fetchOrderCandidates(
  admin: SupabaseClient,
  storeIds: string[],
  names: string[],
  phones: string[],
): Promise<OrderCandidate[]> {
  if (!storeIds.length || (!names.length && !phones.length)) return [];
  const seen = new Set<string>();
  const out: OrderCandidate[] = [];
  const push = (rows: OrderCandidate[] | null) => {
    for (const r of rows ?? []) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        out.push(r);
      }
    }
  };
  for (const batch of chunk(names, 200)) {
    const { data } = await admin
      .from("orders")
      .select("id,store_id,name,customer_phone")
      .in("store_id", storeIds)
      .in("name", batch);
    push(data as OrderCandidate[] | null);
  }
  for (const batch of chunk(phones, 200)) {
    const { data } = await admin
      .from("orders")
      .select("id,store_id,name,customer_phone")
      .in("store_id", storeIds)
      .in("customer_phone", batch);
    push(data as OrderCandidate[] | null);
  }
  return out;
}

/**
 * Ingesta un reporte ya parseado a registros canónicos.
 *
 * Reglas que se respetan siempre, vengan del courier que vengan:
 *  - la API manda sobre el reporte (`reconcileReportedDeliveryStatus`): si su
 *    última lectura sigue fresca, el archivo importado no cambia el estado —
 *    la API describe el presente y el Excel es una foto que alguien subió;
 *  - fuera de esa ventana el estado solo AVANZA (`reconcileDeliveryStatus`):
 *    un reporte viejo recargado no puede devolver a "pendiente" una guía ya
 *    entregada;
 *  - un vínculo manual con un pedido, o un "sin pedido" ya decidido, no se pisa;
 *  - lo que no se pueda vincular queda en la cola de revisión manual, no se
 *    descarta ni se adivina.
 */
export async function ingestCourierReport(
  admin: SupabaseClient,
  params: {
    storeId: string;
    accessibleStoreIds: string[];
    courier: string;
    rows: CanonicalReportRow[];
    meta: ReportIngestMeta;
  },
): Promise<ReportIngestResult> {
  const { storeId, accessibleStoreIds, courier, rows, meta } = params;

  const { data: batch, error: batchErr } = await admin
    .from("import_batches")
    .insert({
      store_id: storeId,
      kind: `${courier}_report`,
      courier,
      filename: meta.filename,
      uploaded_by: meta.uploadedBy,
      row_count: rows.length,
      status: "processing",
      report_date: meta.reportDate ?? null,
      file_path: meta.filePath ?? null,
      file_type: meta.fileType ?? null,
      file_sha256: meta.fileSha256 ?? null,
    })
    .select("id")
    .single();
  if (batchErr || !batch) throw new Error(`import_batches: ${batchErr?.message ?? "sin id"}`);
  const batchId = (batch as { id: string }).id;

  // 1) Emparejar cada fila con un pedido (nº de pedido y guía son prioritarios,
  //    §6; el teléfono solo desempata).
  const names = [...new Set(rows.map((r) => r.order_name).filter((v): v is string => Boolean(v)))];
  const phones = [...new Set(rows.map((r) => r.customer_phone).filter((v): v is string => Boolean(v)))];
  const candidates = await fetchOrderCandidates(admin, accessibleStoreIds, names, phones);

  const rowMetas: RowMeta[] = [];
  const incoming = new Map<string, { row: CanonicalReportRow; match: MatchResult }>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    if (!row.guide_code) {
      rowMetas.push({
        index: i,
        guideCode: null,
        storeId,
        orderId: null,
        matchStatus: "error",
        error: "El registro no trae guía ni código de seguimiento.",
        row,
      });
      continue;
    }
    const match = matchShipment(row, candidates);
    const resolvedStore = match.matched && match.store_id ? match.store_id : storeId;
    incoming.set(row.guide_code, { row, match });
    rowMetas.push({
      index: i,
      guideCode: row.guide_code,
      storeId: resolvedStore,
      orderId: match.order_id,
      matchStatus: match.matched ? "matched" : "review",
      error: null,
      row,
    });
  }

  // 2) Fundir con lo que ya existe y escribir las guías.
  const existingByGuide = await fetchExisting(admin, courier, [...incoming.keys()]);
  const shipmentRows: Record<string, unknown>[] = [];
  let updatedCount = 0;

  for (const [guide, inc] of incoming) {
    const existing = existingByGuide.get(guide);
    // La API manda sobre el Excel mientras su lectura siga fresca.
    const mergedStatus = reconcileReportedDeliveryStatus(
      existing?.delivery_status,
      inc.row.delivery_status,
      existing?.api_report_at,
    );
    if (!existing || existing.delivery_status !== mergedStatus) updatedCount++;

    // El vínculo con el pedido nunca se degrada.
    let order_id: string | null;
    let matched: boolean;
    let match_method: string | null;
    let linkStore: string;
    if (existing?.matched) {
      order_id = existing.order_id;
      linkStore = existing.store_id;
      matched = true;
      match_method = existing.match_method;
    } else if (existing?.match_method === "dismissed") {
      order_id = existing.order_id;
      linkStore = existing.store_id;
      matched = false;
      match_method = "dismissed";
    } else {
      order_id = inc.match.order_id;
      linkStore = inc.match.matched && inc.match.store_id ? inc.match.store_id : storeId;
      matched = inc.match.matched;
      match_method = inc.match.matched ? inc.match.method : null;
    }

    shipmentRows.push({
      courier,
      guide_code: guide,
      store_id: linkStore,
      delivery_status: mergedStatus,
      status_category: categoryOf(mergedStatus),
      order_id,
      matched,
      match_method,
      order_name: inc.row.order_name,
      customer_name: inc.row.customer_name,
      customer_phone: inc.row.customer_phone,
      product: inc.row.product,
      district: inc.row.district,
      province: inc.row.province,
      region: inc.row.region,
      delivery_address: inc.row.delivery_address,
      delivery_reference: inc.row.delivery_reference,
      aliclik_attempts: inc.row.attempts,
      reported_status: inc.row.reported_status,
      non_delivery_reason: inc.row.non_delivery_reason,
      source: courier,
      assigned_at: inc.row.assigned_at,
      dispatched_at: inc.row.dispatched_at,
      out_for_delivery_at: inc.row.out_for_delivery_at,
      rescheduled_at: inc.row.rescheduled_at,
      closed_at: inc.row.closed_at,
      // Una devolución ya registrada no se borra porque un reporte posterior
      // omita la fecha: la devolución es un hecho físico, no un estado volátil.
      returned_at: inc.row.returned_at ?? existing?.returned_at ?? null,
      // La procedencia viaja con la fecha (0116) y corre su misma suerte: si se
      // conserva el sello de antes, se conserva de quién venía.
      returned_source: inc.row.returned_at
        ? `${courier}_report`
        : (existing?.returned_at ? existing.returned_source : null),
      pickup_state: inc.row.pickup_state ?? existing?.pickup_state ?? null,
      agency_branch: inc.row.agency_branch,
      agency_arrived_at: inc.row.agency_arrived_at,
      agency_expires_at: inc.row.agency_expires_at,
      source_batch_id: batchId,
      last_report_at: meta.reportAt,
    });
  }

  const guideToId = new Map<string, string>();
  for (const part of chunk(shipmentRows, BATCH)) {
    const { data, error } = await admin
      .from("shipments")
      .upsert(part, { onConflict: "courier,guide_code" })
      .select("id,guide_code");
    if (error) throw new Error(`shipments: ${error.message}`);
    for (const r of (data as { id: string; guide_code: string }[]) ?? []) {
      guideToId.set(r.guide_code, r.id);
    }
  }

  // 3) Auditoría fila a fila: el original se conserva y lo no vinculado queda en
  //    la cola de revisión manual (misma que ya usa Repro Provincia).
  const importRows = rowMetas.map((rm) => ({
    batch_id: batchId,
    store_id: rm.storeId,
    row_index: rm.index,
    raw: rm.row.raw,
    parsed: {
      guide_code: rm.row.guide_code,
      order_name: rm.row.order_name,
      customer_name: rm.row.customer_name,
      customer_phone: rm.row.customer_phone,
      product: rm.row.product,
      district: rm.row.district,
      province: rm.row.province,
      region: rm.row.region,
      delivery_status: rm.row.delivery_status,
      reported_status: rm.row.reported_status,
      pickup_state: rm.row.pickup_state,
      attempts: rm.row.attempts,
      cost: rm.row.cost,
      store_hint: rm.row.store_hint,
    },
    match_status: rm.matchStatus,
    shipment_id: rm.guideCode ? (guideToId.get(rm.guideCode) ?? null) : null,
    error: rm.error,
  }));
  for (const part of chunk(importRows, BATCH)) {
    const { error } = await admin.from("import_rows").insert(part);
    if (error) throw new Error(`import_rows: ${error.message}`);
  }

  const foundCount = rowMetas.filter((r) => r.matchStatus === "matched").length;
  const unmatchedCount = rowMetas.filter((r) => r.matchStatus === "review").length;
  const errorCount = rowMetas.filter((r) => r.matchStatus === "error").length;

  await admin
    .from("import_batches")
    .update({
      matched_count: foundCount,
      unmatched_count: unmatchedCount,
      found_count: foundCount,
      updated_count: updatedCount,
      unrecognized_count: errorCount,
      status: "processed",
    })
    .eq("id", batchId);

  // 4) Dejar el movimiento en la línea de tiempo de cada pedido tocado y
  //    refrescar el Master.
  const orderIds = [...new Set(rowMetas.map((r) => r.orderId).filter((v): v is string => Boolean(v)))];
  await recordImportEvents(admin, batchId, courier, meta, rowMetas);
  await recomputeOrderMasterSafe(admin, orderIds);

  return {
    batchId,
    rowCount: rows.length,
    foundCount,
    matchedCount: foundCount,
    unmatchedCount,
    updatedCount,
    errorCount,
  };
}

/** Un evento por pedido tocado: qué reporte lo movió y qué dijo. */
async function recordImportEvents(
  admin: SupabaseClient,
  batchId: string,
  courier: string,
  meta: ReportIngestMeta,
  rowMetas: RowMeta[],
): Promise<void> {
  const events = rowMetas
    .filter((rm) => rm.orderId)
    .map((rm) => ({
      store_id: rm.storeId,
      order_id: rm.orderId,
      kind: "import",
      occurred_at: meta.reportAt,
      actor: meta.uploadedBy,
      source: courier,
      courier,
      guide_code: rm.guideCode,
      new_status: null,
      new_operational: rm.row.pickup_state,
      reason: rm.row.non_delivery_reason,
      note: rm.row.reported_status
        ? `Reporte de ${courier}: ${rm.row.reported_status}`
        : `Reporte de ${courier} procesado.`,
      batch_id: batchId,
    }));
  for (const part of chunk(events, BATCH)) {
    // Best-effort: la ingesta ya quedó escrita; perder un evento de auditoría no
    // debe tumbar la carga entera.
    await admin.from("order_events").insert(part);
  }
}
