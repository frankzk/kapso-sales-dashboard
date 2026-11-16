import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Un intento rechazado por GF (por ejemplo, sin cobertura) no debe bloquear el reintento con «creación en curso».
describe("guía GF: reintento después de un rechazo", () => {
  const src = readFileSync("lib/gf-courier-guide.ts", "utf8");
  it("reutiliza la intención fallida con la misma clave y la vuelve a pendiente", () => {
    expect(src).toMatch(/\["pending", "failed"\]\.includes\(prior\.data\.status\)/);
    expect(src).toMatch(/update\(\{ status: "pending", request: built\.input/);
    expect(src).toMatch(/\.eq\("status", "failed"\)/);
  });
  it("solo una intención enviada (con guía) cierra la clave", () => {
    expect(src).not.toMatch(/prior\.data\?\.status === "pending" \? prior\.data\.id/);
  });
});
