// Guías combinadas en lote desde el Master (30-09-2026): para imprimir la tanda
// de 15 pedidos Tanders había que abrir 15 drawers, porque «Descargar rótulos»
// baja el rótulo interno y la combinada solo existía en el drawer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pickCombinadaOutputs, type CombinadaCandidate } from "@/lib/labels/guia-combinada-select";

const salida = (over: Partial<CombinadaCandidate>): CombinadaCandidate => ({
  id: "s1",
  order_id: "o1",
  courier: "tanders",
  delivery_status: "pendiente",
  output_number: 1,
  ...over,
});

describe("pickCombinadaOutputs", () => {
  it("una salida de Tanders por pedido, en el orden en que se pidieron", () => {
    const picked = pickCombinadaOutputs(
      ["o2", "o1"],
      [salida({ id: "a", order_id: "o1" }), salida({ id: "b", order_id: "o2" })],
    );
    expect(picked).toEqual({ shipmentIds: ["b", "a"], missingOrderIds: [] });
  });

  it("la anulada no se imprime: no sale a la calle", () => {
    const picked = pickCombinadaOutputs(["o1"], [salida({ delivery_status: "anulado" })]);
    expect(picked).toEqual({ shipmentIds: [], missingOrderIds: ["o1"] });
  });

  it("con dos salidas de Tanders vivas, la de consecutivo más alto", () => {
    const picked = pickCombinadaOutputs(
      ["o1"],
      [salida({ id: "vieja", output_number: 1 }), salida({ id: "nueva", output_number: 2 })],
    );
    expect(picked.shipmentIds).toEqual(["nueva"]);
  });

  it("un pedido sin guía de Tanders se cuenta aparte, no se inventa", () => {
    const picked = pickCombinadaOutputs(["o1", "o2"], [salida({ order_id: "o1" }), salida({ id: "x", order_id: "o2", courier: "propio" })]);
    expect(picked).toEqual({ shipmentIds: ["s1"], missingOrderIds: ["o2"] });
  });

  it("un pedido repetido en la selección sale una sola vez", () => {
    expect(pickCombinadaOutputs(["o1", "o1"], [salida({})]).shipmentIds).toEqual(["s1"]);
  });
});

describe("las piezas", () => {
  it("la ruta acepta pedidos y dice cuántos no tenían guía de Tanders", () => {
    const route = readFileSync("app/api/pedidos/guia-combinada/route.ts", "utf8");
    expect(route).toContain('request.nextUrl.searchParams.get("orders")');
    expect(route).toContain("pickCombinadaOutputs(requestedOrders");
    expect(route).toContain('"x-combinadas-omitidas"');
  });

  it("la barra en lote del Master tiene el botón y solo lee (no crea salidas)", () => {
    const master = readFileSync("components/orders-master.tsx", "utf8");
    expect(master).toContain("Guías combinadas Tanders (PDF)");
    const fn = master.slice(master.indexOf("const downloadCombined"), master.indexOf("// Crear salidas y, si salió alguna"));
    expect(fn).toContain("downloadCombinadas(Array.from(selectedIds))");
    expect(fn).not.toContain("resolveLabelsForOrders");
  });
});
