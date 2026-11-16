import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// #AUR900793: el acuerdo de Repro Lima es para el mié 18; la guía creada después no debe salir para el día siguiente.
describe("guía GF: día del acuerdo de Repro Lima", () => {
  const src = readFileSync("lib/gf-courier-guide.ts", "utf8");
  it("sin día pedido ni salida programada, usa el acuerdo abierto con GF Courier", () => {
    expect(src).toMatch(/\?\? await reproAgreedGfDay\(admin, orderId\)/);
  });
  it("solo un caso abierto, con GF Courier y un día que no pasó", () => {
    expect(src).toMatch(/from\("lima_repro_cases"\)/);
    expect(src).toMatch(/\.is\("closed_at", null\)\.eq\("agreed_courier", "gf_courier"\)/);
    expect(src).toMatch(/day >= today \? day : null/);
  });
  it("el MOM lo documenta", () => {
    expect(readFileSync("docs/mom/master-pedidos-v1.md", "utf8")).toContain("El día del acuerdo de Repro Lima manda");
  });
});
