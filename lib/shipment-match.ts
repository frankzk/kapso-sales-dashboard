// Pure matcher core: given a parsed report row and a set of candidate orders
// (already fetched from accessible stores), decide which order — if any — the
// Aliclik guide belongs to. Pure + tested; the DB wrapper lives in
// lib/aliclik-ingest.ts.

import type { ParsedShipmentRow } from "./aliclik-import";
import { normalizeOrderName } from "./aliclik-import";

export type MatchMethod = "order_name" | "phone" | "none";

export interface OrderCandidate {
  id: string;
  store_id: string;
  name: string | null; // "#KP114985"
  customer_phone: string | null; // normalized
}

export interface MatchResult {
  order_id: string | null;
  store_id: string | null; // resolved store when matched
  matched: boolean;
  method: MatchMethod;
  // "review" when ambiguous (multiple candidates) or no confident match
  status: "matched" | "review";
}

/**
 * Match a parsed row against candidate orders.
 *   1) by order name (#KP…) — exact on the normalized name.
 *   2) by phone — only when exactly one order carries that phone.
 * Ambiguous (multiple) or zero matches → review (no order linked).
 */
export function matchShipment(row: ParsedShipmentRow, candidates: OrderCandidate[]): MatchResult {
  // 1) order name
  const wantName = normalizeOrderName(row.order_name);
  if (wantName) {
    const byName = candidates.filter((c) => normalizeOrderName(c.name) === wantName);
    if (byName.length === 1) {
      const o = byName[0]!;
      return { order_id: o.id, store_id: o.store_id, matched: true, method: "order_name", status: "matched" };
    }
    if (byName.length > 1) {
      return { order_id: null, store_id: null, matched: false, method: "none", status: "review" };
    }
  }

  // 2) phone (single unambiguous match only)
  if (row.customer_phone) {
    const byPhone = candidates.filter((c) => c.customer_phone && c.customer_phone === row.customer_phone);
    if (byPhone.length === 1) {
      const o = byPhone[0]!;
      return { order_id: o.id, store_id: o.store_id, matched: true, method: "phone", status: "matched" };
    }
  }

  return { order_id: null, store_id: null, matched: false, method: "none", status: "review" };
}
