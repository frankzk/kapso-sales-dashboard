// Pure matcher core: given a parsed report row and a set of candidate orders
// (already fetched from accessible stores), decide which order — if any — the
// Aliclik guide belongs to. Pure + tested; the DB wrapper lives in
// lib/aliclik-ingest.ts.

import type { ParsedShipmentRow } from "./aliclik-import";
import { normalizeOrderName } from "./aliclik-import";

export type MatchMethod = "order_name" | "order_name_phone" | "phone" | "none";

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
 *   1) by order name (#KP…) — exact on the normalized name. A CONFIRMED name
 *      (literal "KP" token found) behaves as before: unique → match, ambiguous
 *      → review. An UNCONFIRMED name (bare-number guess extracted from free-text
 *      NOTA) is only trusted after cross-validating the customer phone against
 *      the SAME candidate order — this also disambiguates the case where two
 *      orders share a phone number (see step 2) by picking the one whose order
 *      number the report actually mentioned.
 *   2) by phone — only when exactly one order carries that phone.
 * Ambiguous (multiple) or zero matches → review (no order linked).
 */
export function matchShipment(row: ParsedShipmentRow, candidates: OrderCandidate[]): MatchResult {
  // 1) order name
  const wantName = normalizeOrderName(row.order_name);
  if (wantName) {
    const byName = candidates.filter((c) => normalizeOrderName(c.name) === wantName);
    if (row.order_name_confirmed) {
      if (byName.length === 1) {
        const o = byName[0]!;
        return { order_id: o.id, store_id: o.store_id, matched: true, method: "order_name", status: "matched" };
      }
      if (byName.length > 1) {
        return { order_id: null, store_id: null, matched: false, method: "none", status: "review" };
      }
    } else if (row.customer_phone) {
      // unconfirmed bare-number candidate: only trust it cross-validated by phone
      const crossValidated = byName.filter((c) => c.customer_phone === row.customer_phone);
      if (crossValidated.length === 1) {
        const o = crossValidated[0]!;
        return {
          order_id: o.id,
          store_id: o.store_id,
          matched: true,
          method: "order_name_phone",
          status: "matched",
        };
      }
      // no cross-validated match → fall through to phone-only matching below
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
