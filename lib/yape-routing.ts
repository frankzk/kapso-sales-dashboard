// Pure routing core for the Yape/Shalom advisor rotation (v2). Given the store's
// active Yapes (with their current offer state) and the online advisor pool, it
// decides which advisor each un-offered/expired Yape should be offered to next.
//
// Rules (all decided with the user):
//  - Only ONLINE advisors take part (presence heartbeat within ONLINE_TTL_MS).
//  - Each advisor gets OFFER_TTL_MS (90s) to take it before it escalates.
//  - "Best" = least loaded now; ties broken by most-recently-active.
//  - Distribute: never offer two Yapes to the same advisor in one pass.
//  - Cap: an advisor may hold at most 60% of the store's active Yapes (relaxed
//    only when every candidate is already at the cap, so nothing gets stuck).
//  - Infinite loop: once everyone online has passed, the lap resets and it
//    starts over — a Yape is never dropped; it cycles until someone takes it.
// Pure + deterministic (nowMs passed in) so it can be unit-tested without a DB.

export const OFFER_TTL_MS = 90_000; // 1.5 min per advisor before escalating
export const ONLINE_TTL_MS = 40_000; // "online" = seen within this of now
export const MAX_SHARE = 0.6; // an advisor holds ≤ 60% of active Yapes

export interface RoutingLead {
  id: string;
  claimedBy: string | null; // advisor currently handling it (claim still fresh), else null
  offeredTo: string | null;
  offeredAtMs: number | null;
  passed: string[]; // advisors who already let it pass this lap
}

export interface RoutingAdvisor {
  id: string;
  lastSeenMs: number; // presence heartbeat
}

export interface OfferPlan {
  leadId: string;
  offeredTo: string;
  passed: string[]; // the new `passed` array to persist alongside the offer
}

function isFreshOffer(l: RoutingLead, nowMs: number): boolean {
  return !!l.offeredTo && l.offeredAtMs != null && nowMs - l.offeredAtMs < OFFER_TTL_MS;
}

/** Pick the best advisor for one lead: least loaded, ties → most recently seen.
 *  Skips `passed`; respects the cap unless every remaining candidate is capped. */
function chooseAdvisor(
  online: RoutingAdvisor[],
  passed: Set<string>,
  load: Map<string, number>,
  cap: number,
): string | null {
  const candidates = online.filter((a) => !passed.has(a.id));
  if (!candidates.length) return null;
  const underCap = candidates.filter((a) => (load.get(a.id) ?? 0) < cap);
  const pool = underCap.length ? underCap : candidates; // relax cap if all are capped
  pool.sort((a, b) => {
    const la = load.get(a.id) ?? 0;
    const lb = load.get(b.id) ?? 0;
    if (la !== lb) return la - lb; // least loaded first
    return b.lastSeenMs - a.lastSeenMs; // tie → most recently active
  });
  return pool[0]?.id ?? null;
}

/**
 * Decide the offers to (re)assign right now. `leads` are the store's active Yapes
 * (status already filtered to yape/no-order upstream); claimed-fresh ones are
 * counted for load/cap but never offered. Returns one plan per lead that needs a
 * new offer; leads with a still-fresh offer are left untouched.
 */
export function planYapeOffers(
  leads: RoutingLead[],
  advisors: RoutingAdvisor[],
  nowMs: number,
): OfferPlan[] {
  const online = advisors.filter((a) => nowMs - a.lastSeenMs <= ONLINE_TTL_MS);
  if (!online.length) return [];
  const onlineIds = new Set(online.map((a) => a.id));

  // Cap is a share of ALL active Yapes (claimed + pending), min 1.
  const cap = Math.max(1, Math.floor(MAX_SHARE * leads.length));

  // Load = claimed-fresh + currently-offered-fresh, per advisor.
  const load = new Map<string, number>();
  const bump = (id: string | null) => {
    if (id) load.set(id, (load.get(id) ?? 0) + 1);
  };
  for (const l of leads) {
    if (l.claimedBy) bump(l.claimedBy);
    else if (isFreshOffer(l, nowMs)) bump(l.offeredTo);
  }

  // Leads needing a (new) offer: not claimed and without a fresh offer. Stable
  // order (by id) so distribution is deterministic.
  const needing = leads
    .filter((l) => !l.claimedBy && !isFreshOffer(l, nowMs))
    .sort((a, b) => a.id.localeCompare(b.id));

  const plans: OfferPlan[] = [];
  for (const l of needing) {
    // The advisor whose turn just expired joins `passed`; drop offline ones so
    // they never block the lap.
    const passed = new Set(l.passed.filter((id) => onlineIds.has(id)));
    if (l.offeredTo && onlineIds.has(l.offeredTo)) passed.add(l.offeredTo);

    let pick = chooseAdvisor(online, passed, load, cap);
    let nextPassed = [...passed];
    if (!pick) {
      // Everyone online has passed → reset the lap and start over (infinite loop).
      nextPassed = [];
      pick = chooseAdvisor(online, new Set(), load, cap);
    }
    if (!pick) continue; // unreachable while online non-empty, but stay safe
    plans.push({ leadId: l.id, offeredTo: pick, passed: nextPassed });
    bump(pick); // so the next needing lead goes to someone else (repartir)
  }
  return plans;
}
