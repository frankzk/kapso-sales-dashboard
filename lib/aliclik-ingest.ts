// Ingest an Aliclik delivery report: create a batch, parse + match each row
// against synced orders, bulk-upsert shipments (deduped by guide code), record
// per-row outcomes, and evaluate Fenix eligibility for failure-state rows.
// Writes via the service role; the caller (the API route) authorizes the user +
// store first. Bulk inserts keep large reports (1000s of rows) fast.

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

const CHUNK = 500;

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

  // 2) candidate orders (one query each for names + phones seen in the report)
  const wantNames = uniq(parsed.map((p) => p.order_name));
  const wantPhones = uniq(parsed.map((p) => p.customer_phone));
  const candidates = await fetchOrderCandidates(admin, accessibleStoreIds, wantNames, wantPhones);

  // 3) Fenix stock for this store's org (to flag eligibility on failure rows)
  const stockRows = await fetchOrgFenixStock(admin, storeId);

  // 4) classify each row; build the shipment upserts (deduped by guide code)
  interface RowMeta {
    index: number;
    guideCode: string | null;
    storeId: string;
    matchStatus: "matched" | "review" | "error";
    error: string | null;
    parsed: ParsedShipmentRow;
  }
  const rowMetas: RowMeta[] = [];
  const shipmentByGuide = new Map<string, Record<string, unknown>>();

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    if (!row) continue;
    if (!row.guide_code) {
      rowMetas.push({ index: i, guideCode: null, storeId, matchStatus: "error", error: "Sin código de guía (AUR5X).", parsed: row });
      continue;
    }
    const match = matchShipment(row, candidates);
    const resolvedStore = match.matched && match.store_id ? match.store_id : storeId;
    const status = row.delivery_status;
    const fenix = isFailureState(status) ? evaluateFenix(row, stockRows).eligible : false;

    shipmentByGuide.set(row.guide_code, {
      courier: "aliclik",
      guide_code: row.guide_code,
      store_id: resolvedStore,
      order_id: match.order_id,
      matched: match.matched,
      match_method: match.method,
      order_name: row.order_name,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      product: row.product,
      district: row.district,
      city: row.city,
      delivery_status: status,
      status_category: categoryOf(status),
      fenix_eligible: fenix,
      source_batch_id: batchId,
      last_report_at: meta.reportAt,
    });
    rowMetas.push({
      index: i,
      guideCode: row.guide_code,
      storeId: resolvedStore,
      matchStatus: match.matched ? "matched" : "review",
      error: null,
      parsed: row,
    });
  }

  // 5) bulk-upsert shipments; map guide_code → id for the import_rows links
  const guideToId = new Map<string, string>();
  const shipmentRows = [...shipmentByGuide.values()];
  for (const chunk of chunked(shipmentRows, CHUNK)) {
    const { data, error } = await admin
      .from("shipments")
      .upsert(chunk, { onConflict: "courier,guide_code" })
      .select("id,guide_code");
    if (error) throw new Error(error.message);
    for (const r of (data as { id: string; guide_code: string }[]) ?? []) {
      guideToId.set(r.guide_code, r.id);
    }
  }

  // 6) bulk-insert import_rows (audit + manual-review queue)
  const importRows = rowMetas.map((rm) => ({
    batch_id: batchId,
    store_id: rm.storeId,
    row_index: rm.index,
    raw: rm.parsed.raw,
    parsed: {
      guide_code: rm.parsed.guide_code,
      order_name: rm.parsed.order_name,
      customer_name: rm.parsed.customer_name,
      customer_phone: rm.parsed.customer_phone,
      product: rm.parsed.product,
      district: rm.parsed.district,
      city: rm.parsed.city,
      delivery_status: rm.parsed.delivery_status,
      store_hint: rm.parsed.store_hint,
    },
    match_status: rm.matchStatus,
    shipment_id: rm.guideCode ? (guideToId.get(rm.guideCode) ?? null) : null,
    error: rm.error,
  }));
  for (const chunk of chunked(importRows, CHUNK)) {
    const { error } = await admin.from("import_rows").insert(chunk);
    if (error) throw new Error(error.message);
  }

  const matchedCount = rowMetas.filter((r) => r.matchStatus === "matched").length;
  const unmatchedCount = rowMetas.filter((r) => r.matchStatus === "review").length;
  const errorCount = rowMetas.filter((r) => r.matchStatus === "error").length;

  await admin
    .from("import_batches")
    .update({ matched_count: matchedCount, unmatched_count: unmatchedCount, status: "processed" })
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

async function fetchOrgFenixStock(admin: SupabaseClient, storeId: string): Promise<FenixStockRow[]> {
  const { data: store } = await admin.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (!orgId) return [];
  const { data } = await admin.from("fenix_stock").select("city,product,quantity").eq("org_id", orgId);
  return (data as FenixStockRow[]) ?? [];
}

function uniq(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter(Boolean) as string[])];
}

function chunked<T>(arr: T[], size: number): T[][] {
  if (!arr.length) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
