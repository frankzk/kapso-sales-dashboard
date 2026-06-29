// Ingest an Aliclik delivery report: create a batch, parse + match each row
// against synced orders, upsert shipments (idempotent), record per-row outcomes,
// and evaluate Fenix eligibility for failure-state rows. Writes via the service
// role; the caller (the API route) must authorize the user + store first.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedShipmentRow } from "./aliclik-import";
import { parseAliclikReport } from "./aliclik-import";
import { matchShipment, type OrderCandidate } from "./shipment-match";
import { categoryOf, isFailureState } from "./shipments";
import { evaluateFenix, type FenixStockRow } from "./fenix";

export interface IngestResult {
  batchId: string;
  rowCount: number;
  matchedCount: number;
  unmatchedCount: number;
  errorCount: number;
}

interface ExistingShipment {
  id: string;
  delivery_status: string;
  last_report_at: string | null;
}

/**
 * Process a parsed Aliclik report into shipments.
 * @param admin       service-role client
 * @param storeId     the batch's default store (used for unmatched/Kenku rows)
 * @param accessibleStoreIds  stores the uploader may match against
 * @param rawRows     raw header→value row objects (from CSV/XLSX)
 * @param meta        filename + uploader + report timestamp
 */
export async function ingestAliclikReport(
  admin: SupabaseClient,
  storeId: string,
  accessibleStoreIds: string[],
  rawRows: Record<string, string>[],
  meta: { filename: string | null; uploadedBy: string | null; reportAt: string },
): Promise<IngestResult> {
  const parsed = parseAliclikReport(rawRows);

  // 1) batch row
  const { data: batch, error: batchErr } = await admin
    .from("import_batches")
    .insert({
      store_id: storeId,
      kind: "aliclik_delivery",
      filename: meta.filename,
      uploaded_by: meta.uploadedBy,
      row_count: parsed.length,
      status: "processing",
    })
    .select("id")
    .single();
  if (batchErr || !batch) throw new Error(batchErr?.message ?? "No se pudo crear el batch.");
  const batchId = batch.id as string;

  // 2) candidate orders: anything in accessible stores matching a name or phone
  //    seen in the report (one query, then matched in-memory).
  const wantNames = [...new Set(parsed.map((p) => p.order_name).filter(Boolean) as string[])];
  const wantPhones = [...new Set(parsed.map((p) => p.customer_phone).filter(Boolean) as string[])];
  const candidates = await fetchOrderCandidates(admin, accessibleStoreIds, wantNames, wantPhones);

  // 3) existing shipments for these guide codes (for idempotent re-import)
  const wantGuides = [...new Set(parsed.map((p) => p.guide_code).filter(Boolean) as string[])];
  const existing = await fetchExistingShipments(admin, wantGuides);

  // 4) Fenix stock for this store's org (to flag eligibility on failure rows)
  const stockRows = await fetchOrgFenixStock(admin, storeId);

  let matchedCount = 0;
  let unmatchedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    if (!row) continue;
    try {
      if (!row.guide_code) {
        await recordImportRow(admin, batchId, storeId, i, row, "error", null, "Sin código de guía (AUR5X).");
        errorCount += 1;
        continue;
      }
      const match = matchShipment(row, candidates);
      const resolvedStore = match.matched && match.store_id ? match.store_id : storeId;

      const shipmentId = await upsertShipment(admin, {
        row,
        storeId: resolvedStore,
        orderId: match.order_id,
        matched: match.matched,
        matchMethod: match.method,
        batchId,
        reportAt: meta.reportAt,
        existing: existing.get(row.guide_code) ?? null,
        stockRows,
      });

      const rowStatus = match.matched ? "matched" : "review";
      await recordImportRow(admin, batchId, storeId, i, row, rowStatus, shipmentId, null);
      if (match.matched) matchedCount += 1;
      else unmatchedCount += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await recordImportRow(admin, batchId, storeId, i, row, "error", null, msg);
      errorCount += 1;
    }
  }

  await admin
    .from("import_batches")
    .update({
      matched_count: matchedCount,
      unmatched_count: unmatchedCount,
      status: "processed",
    })
    .eq("id", batchId);

  return { batchId, rowCount: parsed.length, matchedCount, unmatchedCount, errorCount };
}

async function fetchOrderCandidates(
  admin: SupabaseClient,
  storeIds: string[],
  names: string[],
  phones: string[],
): Promise<OrderCandidate[]> {
  if (!storeIds.length || (!names.length && !phones.length)) return [];
  const out: OrderCandidate[] = [];
  const seen = new Set<string>();
  const push = (rows: OrderCandidate[] | null) => {
    for (const r of rows ?? []) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        out.push(r);
      }
    }
  };
  // chunk the IN() lists to stay within URL limits
  for (const chunk of chunked(names, 200)) {
    const { data } = await admin
      .from("orders")
      .select("id,store_id,name,customer_phone")
      .in("store_id", storeIds)
      .in("name", chunk);
    push(data as OrderCandidate[] | null);
  }
  for (const chunk of chunked(phones, 200)) {
    const { data } = await admin
      .from("orders")
      .select("id,store_id,name,customer_phone")
      .in("store_id", storeIds)
      .in("customer_phone", chunk);
    push(data as OrderCandidate[] | null);
  }
  return out;
}

async function fetchExistingShipments(
  admin: SupabaseClient,
  guideCodes: string[],
): Promise<Map<string, ExistingShipment>> {
  const map = new Map<string, ExistingShipment>();
  for (const chunk of chunked(guideCodes, 200)) {
    const { data } = await admin
      .from("shipments")
      .select("id,guide_code,delivery_status,last_report_at")
      .eq("courier", "aliclik")
      .in("guide_code", chunk);
    for (const r of (data as (ExistingShipment & { guide_code: string })[]) ?? []) {
      map.set(r.guide_code, { id: r.id, delivery_status: r.delivery_status, last_report_at: r.last_report_at });
    }
  }
  return map;
}

async function fetchOrgFenixStock(admin: SupabaseClient, storeId: string): Promise<FenixStockRow[]> {
  const { data: store } = await admin.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (!orgId) return [];
  const { data } = await admin.from("fenix_stock").select("city,product,quantity").eq("org_id", orgId);
  return (data as FenixStockRow[]) ?? [];
}

interface UpsertArgs {
  row: ParsedShipmentRow;
  storeId: string;
  orderId: string | null;
  matched: boolean;
  matchMethod: string;
  batchId: string;
  reportAt: string;
  existing: ExistingShipment | null;
  stockRows: FenixStockRow[];
}

/** Insert a new shipment or advance an existing one (monotonic on report time). */
async function upsertShipment(admin: SupabaseClient, args: UpsertArgs): Promise<string> {
  const { row, storeId, orderId, matched, matchMethod, batchId, reportAt, existing, stockRows } = args;

  // Should this report advance the delivery status? Only if it's newer than what
  // we last saw (monotonic guard) — older/duplicate reports keep the current state.
  const advance = !existing?.last_report_at || reportAt >= existing.last_report_at;
  const status = advance ? row.delivery_status : existing!.delivery_status;
  const category = categoryOf(status);

  // Fenix eligibility only matters once a delivery has failed.
  const fenix = isFailureState(status) ? evaluateFenix(row, stockRows).eligible : false;

  const snapshot = {
    store_id: storeId,
    order_id: orderId,
    matched,
    match_method: matchMethod,
    order_name: row.order_name,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    product: row.product,
    district: row.district,
    city: row.city,
    delivery_status: status,
    status_category: category,
    fenix_eligible: fenix,
    source_batch_id: batchId,
    last_report_at: advance ? reportAt : existing!.last_report_at,
  };

  if (existing) {
    await admin.from("shipments").update(snapshot).eq("id", existing.id);
    return existing.id;
  }
  const { data, error } = await admin
    .from("shipments")
    .insert({ courier: "aliclik", guide_code: row.guide_code, ...snapshot })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "No se pudo crear el envío.");
  return data.id as string;
}

async function recordImportRow(
  admin: SupabaseClient,
  batchId: string,
  storeId: string,
  index: number,
  row: ParsedShipmentRow,
  matchStatus: string,
  shipmentId: string | null,
  error: string | null,
): Promise<void> {
  await admin.from("import_rows").insert({
    batch_id: batchId,
    store_id: storeId,
    row_index: index,
    raw: row.raw,
    parsed: {
      guide_code: row.guide_code,
      order_name: row.order_name,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      product: row.product,
      district: row.district,
      city: row.city,
      delivery_status: row.delivery_status,
      store_hint: row.store_hint,
    },
    match_status: matchStatus,
    shipment_id: shipmentId,
    error,
  });
}

function chunked<T>(arr: T[], size: number): T[][] {
  if (!arr.length) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
