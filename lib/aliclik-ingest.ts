// Ingest an Aliclik delivery report: create a batch, parse + match each row
// against synced orders, bulk-upsert shipments (deduped by guide code), record
// per-row outcomes, and evaluate Fenix eligibility for failure-state rows.
// Writes via the service role; the caller (the API route) authorizes the user +
// store first. Bulk inserts keep large reports (1000s of rows) fast.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedShipmentRow } from "./aliclik-import";
import { parseAliclikReport } from "./aliclik-import";
import { matchShipment, type MatchResult, type OrderCandidate } from "./shipment-match";
import { categoryOf, isPending, maxDeliveryDate, reconcileDeliveryStatus } from "./shipments";
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
  aliclik_attempts: number | null;
  aliclik_service_date: string | null;
  district: string | null;
  province: string | null;
  city: string | null;
  region: string | null;
  delivery_address: string | null;
  delivery_reference: string | null;
  latitude: number | null;
  longitude: number | null;
  address_override: boolean;
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
    const keepManualAddress = existing?.address_override === true;
    const district = keepManualAddress
      ? existing.district
      : (inc.row.district ?? existing?.district ?? null);
    const province = keepManualAddress
      ? existing.province
      : (inc.row.province ?? existing?.province ?? inc.row.region ?? null);
    const city = keepManualAddress ? existing.city : (inc.row.city ?? existing?.city ?? null);
    const region = keepManualAddress ? existing.region : (inc.row.region ?? existing?.region ?? null);
    const deliveryAddress = keepManualAddress
      ? existing.delivery_address
      : (inc.row.delivery_address ?? existing?.delivery_address ?? null);
    const deliveryReference = keepManualAddress
      ? existing.delivery_reference
      : (inc.row.delivery_reference ?? existing?.delivery_reference ?? null);
    const latitude = keepManualAddress
      ? existing.latitude
      : (inc.row.latitude ?? existing?.latitude ?? null);
    const longitude = keepManualAddress
      ? existing.longitude
      : (inc.row.longitude ?? existing?.longitude ?? null);
    // Fenix coverage/stock is evaluated for every managed (pendiente) guide — the
    // UI splits Pendiente vs "Sin cobertura" by this flag.
    const fenix = isPending(mergedStatus)
      ? evaluateFenix({ city, product: inc.row.product }, stockRows).eligible
      : false;
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
      district,
      province,
      city,
      region,
      delivery_address: deliveryAddress,
      delivery_reference: deliveryReference,
      latitude,
      longitude,
      address_override: keepManualAddress,
      delivery_status: mergedStatus,
      status_category: categoryOf(mergedStatus),
      delivered_source,
      fenix_eligible: fenix,
      aliclik_attempts: inc.row.aliclik_attempts ?? existing?.aliclik_attempts ?? null,
      // Última fecha de entrega: la MÁS RECIENTE vista (no retrocede si se sube
      // un reporte viejo fuera de orden).
      aliclik_service_date: maxDeliveryDate(inc.row.aliclik_service_date, existing?.aliclik_service_date),
      source_batch_id: batchId,
      last_report_at,
    });
  }

  // 5) bulk-upsert shipments; map guide_code → id for the import_rows links
  const guideToId = new Map<string, string>();
  for (const chunk of chunked(shipmentRows, CHUNK)) {
    let upsertResult = await admin
      .from("shipments")
      .upsert(chunk, { onConflict: "courier,guide_code" })
      .select("id,guide_code");
    if (isMissingProvinceColumn(upsertResult.error)) {
      const legacyChunk = chunk.map(({ province: _province, ...row }) => row);
      upsertResult = await admin
        .from("shipments")
        .upsert(legacyChunk, { onConflict: "courier,guide_code" })
        .select("id,guide_code");
    }
    const { data, error } = upsertResult;
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
      province: rm.parsed.province,
      city: rm.parsed.city,
      region: rm.parsed.region,
      delivery_address: rm.parsed.delivery_address,
      delivery_reference: rm.parsed.delivery_reference,
      latitude: rm.parsed.latitude,
      longitude: rm.parsed.longitude,
      delivery_status: rm.parsed.delivery_status,
      store_hint: rm.parsed.store_hint,
      aliclik_attempts: rm.parsed.aliclik_attempts,
      aliclik_service_date: rm.parsed.aliclik_service_date,
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
    const currentResult = await admin
      .from("shipments")
      .select("guide_code,delivery_status,matched,match_method,order_id,store_id,last_report_at,delivered_source,aliclik_attempts,aliclik_service_date,district,province,city,region,delivery_address,delivery_reference,latitude,longitude,address_override")
      .eq("courier", "aliclik")
      .in("guide_code", chunk);
    let data: unknown = currentResult.data;
    if (isMissingProvinceColumn(currentResult.error)) {
      const legacyResult = await admin
        .from("shipments")
        .select("guide_code,delivery_status,matched,match_method,order_id,store_id,last_report_at,delivered_source,aliclik_attempts,aliclik_service_date,district,city,region,delivery_address,delivery_reference,latitude,longitude,address_override")
        .eq("courier", "aliclik")
        .in("guide_code", chunk);
      data = legacyResult.data;
    }
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

function isMissingProvinceColumn(error: { code?: string; message?: string } | null): boolean {
  return !!error && (
    error.code === "PGRST204" ||
    error.code === "42703" ||
    error.message?.toLowerCase().includes("province") === true
  );
}
