import { describe, it, expect } from "vitest";
import { toCsv } from "@/lib/csv";

describe("toCsv", () => {
  it("serializes header + rows", () => {
    const csv = toCsv(
      [{ a: 1, b: "x" }],
      [
        { header: "A", value: (r) => r.a },
        { header: "B", value: (r) => r.b },
      ],
    );
    expect(csv).toBe("A,B\n1,x\n");
  });

  it("quotes commas, quotes and newlines (RFC-4180)", () => {
    const csv = toCsv([{ v: 'he,llo "q"\nn' }], [{ header: "v", value: (r) => r.v }]);
    expect(csv).toBe('v\n"he,llo ""q""\nn"\n');
  });

  it("joins arrays with | and blanks null/undefined", () => {
    const csv = toCsv(
      [{ t: ["a", "b"], n: null }],
      [
        { header: "t", value: (r) => r.t },
        { header: "n", value: (r) => r.n },
      ],
    );
    expect(csv).toBe("t,n\na|b,\n");
  });

  it("prepends a UTF-8 BOM when requested", () => {
    const csv = toCsv([], [{ header: "A", value: () => "" }], { bom: true });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe("﻿A\n");
  });
});
