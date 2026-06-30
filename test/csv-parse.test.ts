import { describe, it, expect } from "vitest";
import { parseCsv, parseCsvRows } from "@/lib/csv-parse";
import { toCsv } from "@/lib/csv";

describe("parseCsvRows (RFC-4180)", () => {
  it("parses quoted fields with commas, newlines and escaped quotes", () => {
    const text = 'a,b,c\r\n1,"x, y","line1\nline2"\n2,"she said ""hi""",z\n';
    const rows = parseCsvRows(text);
    expect(rows[0]).toEqual(["a", "b", "c"]);
    expect(rows[1]).toEqual(["1", "x, y", "line1\nline2"]);
    expect(rows[2]).toEqual(["2", 'she said "hi"', "z"]);
  });

  it("strips a leading UTF-8 BOM", () => {
    const text = "﻿h1,h2\nv1,v2\n";
    const rows = parseCsvRows(text);
    expect(rows[0]).toEqual(["h1", "h2"]);
  });
});

describe("parseCsv (objects keyed by header)", () => {
  it("keys cells by trimmed header and skips blank trailing rows", () => {
    const text = " PEDIDO , GUIA \n#KP1, AUR5X1 \n\n";
    const out = parseCsv(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ PEDIDO: "#KP1", GUIA: "AUR5X1" });
  });

  it("round-trips with the csv writer", () => {
    const rows = [{ a: "1", b: "x, y" }];
    const csv = toCsv(rows, [
      { header: "a", value: (r) => r.a },
      { header: "b", value: (r) => r.b },
    ]);
    const parsed = parseCsv(csv);
    expect(parsed).toEqual(rows);
  });
});
