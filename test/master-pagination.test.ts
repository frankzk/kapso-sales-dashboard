import { describe, expect, it } from "vitest";
import { compareMasterRows, loadMasterCursorPage, masterCursorFor, parseMasterCursor, type MasterCursor } from "@/lib/master-pagination";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rows = Array.from({ length: 53 }, (_, i) => ({
  id: id(i), store_id: i % 2 ? "a" : "b",
  order_created_at: i >= 43 ? null : `2026-09-25T00:00:${String(59 - Math.floor(i / 3)).padStart(2, "0")}.123${String(999 - i % 3).padStart(3, "0")}+00:00`,
}));

function readPage(cursor: MasterCursor | null, stores = ["a", "b"], source = rows) {
  const calls: { size: number; returned: number }[] = [];
  const backwards = cursor?.direction === "previous";
  return loadMasterCursorPage(stores, 7, cursor, async (store, segment, size) => {
    const result = source.filter((row) => {
      if (row.store_id !== store) return false;
      if (segment === "dated" && row.order_created_at === null) return false;
      if (segment === "undated" && row.order_created_at !== null) return false;
      if (!cursor) return true;
      const compared = compareMasterRows(row, { id: cursor.id, order_created_at: cursor.createdAt });
      return backwards ? compared < 0 : compared > 0;
    }).sort((a, b) => (backwards ? -1 : 1) * compareMasterRows(a, b)).slice(0, size);
    calls.push({ size, returned: result.length });
    return result;
  }).then(page => ({ page, calls }));
}

describe("Master cursor pagination", () => {
  it("traverses multiple stores, ties, microseconds and null dates without duplicates or gaps", async () => {
    let cursor: MasterCursor | null = null;
    const all: typeof rows = [];
    do {
      const { page, calls } = await readPage(cursor);
      all.push(...page);
      expect(calls.reduce((sum, c) => sum + c.returned, 0)).toBeLessThanOrEqual(14);
      if (page.length < 7) break;
      cursor = parseMasterCursor(masterCursorFor(page.at(-1)!, "next"));
    } while (all.length < 100);
    expect(all).toEqual([...rows].sort(compareMasterRows));
  });

  it("previous returns the immediately preceding page, including crossing from null dates", async () => {
    let cursor: MasterCursor | null = null;
    const pages: (typeof rows)[] = [];
    for (;;) {
      const { page } = await readPage(cursor);
      if (!page.length) break;
      pages.push(page);
      cursor = parseMasterCursor(masterCursorFor(page.at(-1)!, "next"));
    }
    for (let i = pages.length - 1; i > 0; i--) {
      const back = await readPage(parseMasterCursor(masterCursorFor(pages[i]![0]!, "previous")));
      expect(back.page).toEqual(pages[i - 1]);
    }
  });

  it("continues without gaps when newer orders arrive and already viewed orders including the anchor disappear", async () => {
    const first = (await readPage(null)).page;
    const anchor = first.at(-1)!;
    const newer = { id: id(1000), store_id: "a", order_created_at: "2026-09-25T01:00:00.000000Z" };
    const laterNull = { id: id(2000), store_id: "b", order_created_at: null };
    const changed = [newer, ...rows.filter(row => row.id !== first[0]!.id && row.id !== anchor.id), laterNull];
    let cursor = parseMasterCursor(masterCursorFor(anchor, "next"));
    const remaining: typeof rows = [];
    for (let reads = 0; reads < 20; reads++) {
      const { page } = await readPage(cursor, ["a", "b"], changed);
      remaining.push(...page);
      if (page.length < 7) break;
      cursor = parseMasterCursor(masterCursorFor(page.at(-1)!, "next"));
    }
    expect(remaining).toEqual(changed.filter(row => compareMasterRows(row, anchor) > 0).sort(compareMasterRows));
    expect(new Set([...first, ...remaining].map(row => row.id)).size).toBe(first.length + remaining.length);
    expect(remaining.some(row => row.id === laterNull.id)).toBe(true);
    // A new arrival belongs at the top, not in the remainder of an older page.
    const refreshedFirst = (await readPage(null, ["a", "b"], changed)).page;
    expect(refreshedFirst[0]).toEqual(newer);
    expect(refreshedFirst.some(row => row.id === anchor.id)).toBe(false);
  });

  it("shows an order newly entering a filter above the cursor when returning to the first page", async () => {
    const entering = rows[2]!;
    const initiallyEligible = rows.filter(row => row.id !== entering.id);
    const first = (await readPage(null, ["a", "b"], initiallyEligible)).page;
    const cursor = parseMasterCursor(masterCursorFor(first.at(-1)!, "next"));
    const next = (await readPage(cursor, ["a", "b"], rows)).page;
    expect(next.some(row => row.id === entering.id)).toBe(false);
    expect(next.every(row => compareMasterRows(row, first.at(-1)!) > 0)).toBe(true);
    // Cursor traversal is a live view, not a snapshot of every queue change.
    expect((await readPage(null, ["a", "b"], rows)).page).toContainEqual(entering);
  });

  it("does not include another store even when the cursor names its row", async () => {
    const { page } = await readPage(parseMasterCursor(masterCursorFor(rows[2]!, "next")), ["a"]);
    expect(page.every(row => row.store_id === "a")).toBe(true);
  });

  it("returns empty for no authorized stores", async () => {
    const { page, calls } = await readPage(null, []);
    expect(page).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("keeps Postgres microseconds and canonical ordering across timezone formats", () => {
    expect(compareMasterRows({ id: id(1), order_created_at: "2026-09-25T00:00:00.123001Z" },
      { id: id(0), order_created_at: "2026-09-25T00:00:00.123002+00:00" })).toBe(1);
    expect(compareMasterRows({ id: id(0), order_created_at: "2026-09-24T19:00:00.123001-05:00" },
      { id: id(1), order_created_at: "2026-09-25T00:00:00.123001Z" })).toBe(-1);
  });

  it("rejects malformed cursor values before they reach PostgREST expressions", () => {
    const valid = { id: id(1), createdAt: null, direction: "next" };
    for (const bad of ["{", "a".repeat(241), JSON.stringify({ ...valid, id: "a),store_id.neq.x" }), JSON.stringify({ ...valid, createdAt: "2026-09-25),id.neq.x" }), JSON.stringify({ ...valid, direction: "other" })]) {
      expect(parseMasterCursor(bad)).toBeNull();
    }
    expect(parseMasterCursor(JSON.stringify(valid))).toEqual(valid);
  });
});
