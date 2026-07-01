// Ingest an Aliclik delivery report: create a batch, parse + match each row
// against synced orders, bulk-upsert shipments (deduped by guide code), record
// per-row outcomes, and evaluate Fenix eligibility for failure-state rows.
// Writes via the service role; the caller (the API route) authorizes the user +
// store first. Bulk inserts keep large reports (1000s of rows) fast.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedShipmentRow } from "./aliclik-import";
import { parseAliclikReport } from "./aliclik-import";
import { matchShipment, type MatchResult, type OrderCandidate } from "./shipment-match";
import { categoryOf, isPending, reconcileDeliveryStatus } from "./shipments";
import { evaluateFenix, type FenixStockRow } from "./fenix";

// Existing shipment fields we need to reconcile a re-import against (so we don't
// reset progress the team already made). See reconcileDeliveryStatus + the
// linkage rules below.
interface ExistingShipment {
  guide_code: string;
  delivery_status: string;
  matched: boolean;
  match_method: string | null;
  order_id: string | null;
  store_id: string;
  last_report_at: string | null;
  delivered_source: string | null;
}

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

  // 4) classify each row; collect the incoming data per guide (deduped by guide,
  //    last row wins). We resolve the final upsert payload in step 4b, AFTER
  //    reading existing rows, so a re-import merges instead of resetting.
  interface RowMeta {
    index: number;
    guideCode: string | null;
    storeId: string;
    matchStatus: "matched" | "review" | "error";
    error: string | null;
    parsed: ParsedShipmentRow;
  }
  interface Incoming {
    row: ParsedShipmentRow;
    match: MatchResult;
    resolvedStore: string;
  }
  const rowMetas: RowMeta[] = [];
  const incomingByGuide = new Map<string, Incoming>();

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    if (!row) continue;
    if (!row.guide_code) {
      rowMetas.push({ index: i, guideCode: null, storeId, matchStatus: "error", error: "Sin código de guía (AUR5X).", parsed: row });
      continue;
    }
    const match = matchShipment(row, candidates);
    const resolvedStore = match.matched && match.store_id ? match.store_id : storeId;
    incomingByGuide.set(row.guide_code, { row, match, resolvedStore });
    rowMetas.push({
      index: i,
      guideCode: row.guide_code,
      storeId: resolvedStore,
      matchStatus: match.matched ? "matched" : "review",
      error: null,
      parsed: row,
    });
  }

  // 4b) read existing shipments for these guides, then build merged payloads.
  //   - delivery_status: reconciled (only ever moves forward; ENTREGADO/DEVUELTO
  //     close; an older re-upload can't regress it).
  //   - linkage: a manual order link or a "sin pedido" dismissal is preserved.
  //   - reroute_attempts / claims / next_followup / fenix sub-guide are NOT in
  //     the payload, so the upsert leaves them untouched.
  const existingByGuide = await fetchExistingShipments(admin, [...incomingByGuide.keys()]);
  const shipmentRows: Record<string, unknown>[] = [];
  for (const [guide, inc] of incomingByGuide) {
    const existing = existingByGuide.get(guide);
    const mergedStatus = reconcileDeliveryStatus(existing?.delivery_status, inc.row.delivery_status);
    // Fenix coverage/stock is evaluated for every managed (pendiente) guide — the
    // UI splits Pendiente vs "Sin cobertura" by this flag.
    const fenix = isPending(mergedStatus) ? evaluateFenix(inc.row, stockRows).eligible : false;
    // delivered_source: keep an existing source; a delivery that comes from the
    // report (not from agent gestión) is "aliclik".
    let delivered_source = existing?.delivered_source ?? null;
    if (mergedStatus === "entregado" && !delivered_source) delivered_source = "aliclik";

    // linkage: never downgrade an established link or a dismissal
    let order_id: string | null;
    let matched: boolean;
    let match_method: string | null;
    let linkStore: string;
    if (existing?.matched) {
      ({ order_id, store_id: linkStore } = existing);
      matched = true;
      match_method = existing.match_method;
    } else if (existing?.match_method === "dismissed") {
      order_id = existing.order_id;
      matched = false;
      match_method = "dismissed";
      linkStore = existing.store_id;
    } else {
      order_id = inc.match.order_id;
      matched = inc.match.matched;
      match_method = inc.match.method;
      linkStore = inc.resolvedStore;
    }

    const last_report_at =
      existing?.last_report_at && existing.last_report_at > meta.reportAt
        ? existing.last_report_at
        : meta.reportAt;

    shipmentRows.push({
      courier: "aliclik",
      guide_code: guide,
      store_id: linkStore,
      order_id,
      matched,
      match_method,
      order_name: inc.row.order_name,
      customer_name: inc.row.customer_name,
      customer_phone: inc.row.customer_phone,
      product: inc.row.product,
      district: inc.row.district,
      city: inc.row.city,
      delivery_status: mergedStatus,
      status_category: categoryOf(mergedStatus),
      delivered_source,
      fenix_eligible: fenix,
      source_batch_id: batchId,
      last_report_at,
    });
  }

  // 5) bulk-upsert shipments; map guide_code → id for the import_rows links
  const guideToId = new Map<string, string>();
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

/** Read existing aliclik shipments for the given guide codes (to merge on re-import). */
async function fetchExistingShipments(
  admin: SupabaseClient,
  guideCodes: string[],
): Promise<Map<string, ExistingShipment>> {
  const map = new Map<string, ExistingShipment>();
  if (!guideCodes.length) return map;
  for (const chunk of chunked(guideCodes, 200)) {
    const { data } = await admin
      .from("shipments")
      .select("guide_code,delivery_status,matched,match_method,order_id,store_id,last_report_at,delivered_source")
      .eq("courier", "aliclik")
      .in("guide_code", chunk);
    for (const r of (data as ExistingShipment[]) ?? []) map.set(r.guide_code, r);
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

function uniq(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter(Boolean) as string[])];
}

function chunked<T>(arr: T[], size: number): T[][] {
  if (!arr.length) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
