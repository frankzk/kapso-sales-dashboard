// Guías combinadas en lote desde el Master (30-09-2026): para imprimir la tanda
// de 15 pedidos Tanders había que abrir 15 drawers, porque «Descargar rótulos»
// baja el rótulo interno y la combinada solo existía en el drawer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasCombinedGuide, pickCombinadaOutputs, type CombinadaCandidate } from "@/lib/labels/guia-combinada-select";

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

describe("Shalom también tiene guía combinada (su etiqueta embebida)", () => {
  it("solo Tanders y Shalom la tienen; Olva y los demás no", () => {
    expect(hasCombinedGuide("tanders")).toBe(true);
    expect(hasCombinedGuide("shalom")).toBe(true);
    for (const courier of ["olva", "aliclik", "propio", "fenix", "axel", "", null]) {
      expect(hasCombinedGuide(courier), String(courier)).toBe(false);
    }
  });

  it("de Shalom, solo la guía creada por API: la del Excel no tiene PDF que embeber", () => {
    const shalom = (over: Partial<CombinadaCandidate>) => salida({ courier: "shalom", shalom_ose_id: 991, ...over });
    expect(pickCombinadaOutputs(["o1"], [shalom({})], "shalom").shipmentIds).toEqual(["s1"]);
    expect(pickCombinadaOutputs(["o1"], [shalom({ shalom_ose_id: null })], "shalom").missingOrderIds).toEqual(["o1"]);
    // Cada courier lee solo sus salidas.
    expect(pickCombinadaOutputs(["o1"], [shalom({})], "tanders").shipmentIds).toEqual([]);
  });
});

describe("las piezas", () => {
  it("las dos rutas aceptan pedidos y dicen cuántos no tenían guía", () => {
    const tanders = readFileSync("app/api/pedidos/guia-combinada/route.ts", "utf8");
    expect(tanders).toContain('request.nextUrl.searchParams.get("orders")');
    expect(tanders).toContain('pickCombinadaOutputs(requestedOrders, (candidates ?? []) as CombinadaCandidate[], "tanders")');
    expect(tanders).toContain('"x-combinadas-omitidas"');
    const shalom = readFileSync("app/api/shalom/rotulos/route.ts", "utf8");
    expect(shalom).toContain('pickCombinadaOutputs(orderIds, rows as CombinadaCandidate[], "shalom")');
    expect(shalom).toContain('"x-combinadas-omitidas"');
    expect(shalom).toContain('"x-combinadas-fallidas"');
  });

  it("el rótulo de Shalom del drawer y el del lote se componen con la MISMA función", () => {
    expect(readFileSync("app/api/shalom/rotulo/[shipmentId]/route.ts", "utf8")).toContain("composeShalomRotulo(");
    expect(readFileSync("app/api/shalom/rotulos/route.ts", "utf8")).toContain("composeShalomRotulo(");
  });

  it("la barra solo ofrece el botón si la selección tiene Tanders o Shalom, y solo lee", () => {
    const master = readFileSync("components/orders-master.tsx", "utf8");
    expect(master).toContain("Guías combinadas (PDF)");
    expect(master).not.toContain("Guías combinadas Tanders (PDF)");
    expect(master).toContain("{combinedCount > 0 && (");
    const fn = master.slice(master.indexOf("const downloadCombined"), master.indexOf("// Crear salidas y, si salió alguna"));
    expect(fn).toContain("downloadCombinadas(courier, ids)");
    expect(fn).not.toContain("resolveLabelsForOrders");
  });
});
