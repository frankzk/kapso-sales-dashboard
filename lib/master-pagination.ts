/** Stable cursors for created DESC NULLS LAST, id ASC. No customer data in URLs. */
export interface MasterCursor {
  id: string;
  createdAt: string | null;
  direction: "next" | "previous";
}

type OrderedRow = { id: string; order_created_at: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseMasterCursor(raw?: string | null): MasterCursor | null {
  if (!raw || raw.length > 240) return null;
  try {
    const c = JSON.parse(raw);
    if (!c || typeof c.id !== "string" || !UUID.test(c.id)) return null;
    if (c.direction !== "next" && c.direction !== "previous") return null;
    if (c.createdAt !== null && (typeof c.createdAt !== "string" || !TIMESTAMP.test(c.createdAt) || !Number.isFinite(Date.parse(c.createdAt)))) return null;
    return { id: c.id, createdAt: c.createdAt, direction: c.direction };
  } catch {
    return null;
  }
}

export function masterCursorFor(row: OrderedRow, direction: MasterCursor["direction"]): string {
  return JSON.stringify({ id: row.id, createdAt: row.order_created_at, direction });
}

// Date.parse alone loses Postgres microseconds and can reorder adjacent pages.
function micros(value: string): bigint {
  const fraction = value.match(/\.(\d+)/)?.[1] ?? "";
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3, 6));
}

export function compareMasterRows(a: OrderedRow, b: OrderedRow): number {
  if (a.order_created_at !== b.order_created_at) {
    if (a.order_created_at === null) return 1;
    if (b.order_created_at === null) return -1;
    const left = micros(a.order_created_at);
    const right = micros(b.order_created_at);
    if (left !== right) return left > right ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type MasterPageSegment = "initial" | "dated" | "undated";

/**
 * Read at most one page per store, then merge a bounded candidate set. Splitting
 * the null partition keeps the timestamp range indexable in both directions.
 * A legacy page-number URL keeps its offset; all UI next/previous links use a
 * cursor. `read` must return rows in the requested traversal direction.
 */
export async function loadMasterCursorPage<T extends OrderedRow>(
  storeIds: string[],
  pageSize: number,
  cursor: MasterCursor | null,
  read: (storeId: string, segment: MasterPageSegment, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const candidates: T[] = [];
  // Bounded concurrency even for an administrator with many stores.
  for (let i = 0; i < storeIds.length; i += 4) {
    const pages = await Promise.all(storeIds.slice(i, i + 4).map(async (storeId) => {
      if (!cursor) return read(storeId, "initial", pageSize);
      const first = cursor.createdAt === null ? "undated" : "dated";
      const rows = await read(storeId, first, pageSize);
      const crossPartition = cursor.createdAt === null
        ? cursor.direction === "previous"
        : cursor.direction === "next";
      if (rows.length < pageSize && crossPartition) {
        rows.push(...await read(storeId, first === "dated" ? "undated" : "dated", pageSize - rows.length));
      }
      return rows;
    }));
    candidates.push(...pages.flat());
  }
  const backwards = cursor?.direction === "previous";
  candidates.sort((a, b) => (backwards ? -1 : 1) * compareMasterRows(a, b));
  const page = candidates.slice(0, pageSize);
  return backwards ? page.reverse() : page;
}
