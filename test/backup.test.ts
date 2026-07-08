import { describe, it, expect } from "vitest";
import {
  toCsv,
  backupFolderName,
  foldersToPrune,
  formatBackupSummary,
  BACKUP_RETENTION,
  type StorageBackupReport,
} from "@/lib/backup";

describe("toCsv", () => {
  it("returns empty string for no rows", () => {
    expect(toCsv([])).toBe("");
  });

  it("writes a header from the union of keys and one line per row", () => {
    const csv = toCsv([
      { id: "1", name: "Ana" },
      { id: "2", name: "Beto" },
    ]);
    expect(csv).toBe("id,name\n1,Ana\n2,Beto");
  });

  it("renders null/undefined as empty cells", () => {
    expect(toCsv([{ a: null, b: undefined, c: 0 }])).toBe("a,b,c\n,,0");
  });

  it("quotes values containing commas, quotes or newlines (doubling quotes)", () => {
    const csv = toCsv([{ note: 'dijo "hola", chau', addr: "line1\nline2" }]);
    expect(csv).toBe('note,addr\n"dijo ""hola"", chau","line1\nline2"');
  });

  it("JSON-encodes object/array cells (jsonb columns)", () => {
    const csv = toCsv([{ id: "1", meta: { k: 1, v: "x" }, tags: ["a", "b"] }]);
    // both get quoted because JSON contains commas/quotes
    expect(csv).toBe('id,meta,tags\n1,"{""k"":1,""v"":""x""}","[""a"",""b""]"');
  });

  it("unions keys across rows of differing shape (first-seen order, missing → empty)", () => {
    const csv = toCsv([{ a: "1" }, { b: "2" }]);
    expect(csv).toBe("a,b\n1,\n,2");
  });
});

describe("backupFolderName", () => {
  it("is the UTC calendar day as YYYY-MM-DD", () => {
    expect(backupFolderName(new Date("2026-07-08T05:00:00Z"))).toBe("2026-07-08");
    // late-UTC time stays on the same UTC day
    expect(backupFolderName(new Date("2026-07-08T23:30:00Z"))).toBe("2026-07-08");
  });
});

describe("foldersToPrune", () => {
  it("keeps the newest `retention` and returns the rest (oldest)", () => {
    const names = ["2026-07-01", "2026-07-08", "2026-06-24"];
    expect(foldersToPrune(names, 2)).toEqual(["2026-06-24"]);
  });

  it("returns nothing when at or under the retention count", () => {
    expect(foldersToPrune(["2026-07-01", "2026-07-08"], 2)).toEqual([]);
    expect(foldersToPrune(["2026-07-01"], 8)).toEqual([]);
    expect(foldersToPrune([], 8)).toEqual([]);
  });

  it("dedupes before selecting", () => {
    expect(foldersToPrune(["2026-07-08", "2026-07-08", "2026-07-01"], 1)).toEqual(["2026-07-01"]);
  });

  it("retention 0 prunes everything", () => {
    expect(foldersToPrune(["2026-07-01", "2026-07-08"], 0).sort()).toEqual([
      "2026-07-01",
      "2026-07-08",
    ]);
  });

  it("defaults to BACKUP_RETENTION", () => {
    const many = Array.from({ length: BACKUP_RETENTION + 3 }, (_, i) =>
      `2026-07-${String(i + 1).padStart(2, "0")}`,
    );
    expect(foldersToPrune(many)).toHaveLength(3);
  });
});

describe("formatBackupSummary", () => {
  const base: StorageBackupReport = {
    folder: "2026-07-08",
    tables: [
      { table: "leads", rows: 1234, bytes: 100, truncated: false },
      { table: "lead_calls", rows: 5678, bytes: 200, truncated: false },
    ],
    pruned: [],
    totalRows: 6912,
    ok: true,
  };

  it("headlines a clean run and lists row counts", () => {
    const s = formatBackupSummary(base);
    expect(s).toContain("🗄️");
    expect(s).toContain("2026-07-08");
    expect(s).toContain("leads: 1,234 filas");
    expect(s).toContain("db-backups");
  });

  it("flags a warning headline and surfaces errors / truncation", () => {
    const s = formatBackupSummary({
      ...base,
      ok: false,
      tables: [
        { table: "leads", rows: 100000, bytes: 1, truncated: true },
        { table: "lead_calls", rows: 0, bytes: 0, truncated: false, error: "boom" },
      ],
    });
    expect(s).toContain("⚠️");
    expect(s).toContain("truncado");
    expect(s).toContain("❌ boom");
  });
});
