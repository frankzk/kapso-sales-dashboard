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

  it("neutralizes formula-injection in text cells but not in numbers", () => {
    const csv = toCsv(
      [{ formula: "=HYPERLINK(0)", tag: ["@x", "+y"], neg: -5, note: "-danger" }],
      [
        { header: "formula", value: (r) => r.formula },
        { header: "tag", value: (r) => r.tag },
        { header: "neg", value: (r) => r.neg },
        { header: "note", value: (r) => r.note },
      ],
    );
    // string starting with = → apostrophe-prefixed; array element starting with @
    // → prefixed after join; a real negative NUMBER (-5) is left intact; a string
    // that happens to start with - is prefixed.
    expect(csv).toBe("formula,tag,neg,note\n'=HYPERLINK(0),'@x|+y,-5,'-danger\n");
  });

  it("prepends a UTF-8 BOM when requested", () => {
    const csv = toCsv([], [{ header: "A", value: () => "" }], { bom: true });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe("﻿A\n");
  });
});
