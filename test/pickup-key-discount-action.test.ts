// La excepción por descuento en el servidor (MOM §12, 13-10-2026). El panel
// solo decide si ofrece el botón; quien suelta la clave es `revealPickupKey`, y
// tiene que volver a comprobarlo todo con los datos frescos.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve(process.cwd(), "app/dashboard/pedidos/payment-actions.ts"), "utf8");
const reveal = src.slice(src.indexOf("export async function revealPickupKey"), src.indexOf("export async function sharePickupKey"));

describe("revealPickupKey — la excepción por descuento", () => {
  it("vuelve a calcular la excepción en el servidor y exige el motivo", () => {
    expect(reveal).toContain("if (input.discount)");
    expect(reveal).toContain("const discount = discountException(keyCtx);");
    expect(reveal).toContain("if (!discount.eligible)");
    expect(reveal).toMatch(/input\.discount\)[\s\S]*?if \(!input\.reason\?\.trim\(\)\)/);
  });

  it("no pide el permiso de administrador: basta con poder ver la clave", () => {
    const discountBranch = reveal.slice(reveal.indexOf("if (input.discount)"), reveal.indexOf("} else {"));
    expect(discountBranch).not.toContain("shalom.override_payment_validation");
    expect(reveal.indexOf('perms.can("shalom.reveal_pickup_key")')).toBeLessThan(reveal.indexOf("if (input.discount)"));
  });

  it("queda en el historial como excepción, con lo que faltaba", () => {
    expect(reveal).toContain("override: !verdict.allowed");
    expect(reveal).toContain("exception,");
    expect(reveal).toContain("EXCEPCIÓN POR DESCUENTO");
  });
});
