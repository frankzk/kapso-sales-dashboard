import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALICLIK_API_SHAPE_PROBE_UNTIL, apiShapeProbeOn, keyPaths, redactForProbe, summarizeApiShape } from "@/lib/aliclik-api-shape";

// Sonda temporal (owner, 03-11-2026): ¿la API de Aliclik trae subestado o
// comentario del motorizado, como el Excel?
const cancelled = {
  orderNumber: "AUR5X1", status: "CANCEL", dispatchStatus: "TO_RETURN", callStatus: "CONFIRMED",
  customer: { name: "Ana Pérez", phone: "51987654321" },
  shipping: { address1: "Av. Siempre Viva 123", lat: -12.1 },
  subStatus: "DE VIAJE",
  lastComment: "Cliente de viaje, llamar al 987654321 el sábado",
  histories: [{ status: "NOT_RESPOND", comment: "no contesta" }],
};
const delivered = { orderNumber: "AUR5X2", status: "DELIVERED", customer: { name: "Luis" } };

describe("keyPaths", () => {
  it("lista las rutas, con [] para las listas", () => {
    expect(keyPaths(cancelled)).toEqual(expect.arrayContaining(["subStatus", "histories", "histories[]", "histories[].comment", "customer.phone"]));
  });
});

describe("redactForProbe", () => {
  it("enmascara cliente y envío, y los números largos en lo demás", () => {
    const r = redactForProbe(cancelled) as Record<string, any>;
    expect(r.customer).toEqual({ name: "<texto 9>", phone: "<texto 11>" });
    expect(r.shipping).toEqual({ address1: "<texto 20>", lat: "<número>" });
    expect(r.lastComment).toBe("Cliente de viaje, llamar al <9 dígitos> el sábado");
    expect(r.subStatus).toBe("DE VIAJE");
  });
});

describe("summarizeApiShape", () => {
  it("cuenta rutas, separa las que Kapta no lee y muestra solo guías no entregadas", () => {
    const out = summarizeApiShape([cancelled, delivered]);
    expect(out.scanned).toBe(2);
    expect(out.paths.orderNumber).toBe(2);
    expect(out.unknownPaths).toEqual(expect.arrayContaining(["subStatus", "lastComment", "histories[].comment"]));
    expect(out.unknownPaths).not.toContain("status");
    expect(out.samples).toHaveLength(1);
    expect(JSON.stringify(out.samples)).not.toContain("Ana Pérez");
    expect(JSON.stringify(out.samples)).not.toContain("987654321");
  });

  it("como mucho seis muestras", () => {
    expect(summarizeApiShape(Array.from({ length: 20 }, () => cancelled)).samples).toHaveLength(6);
  });
});

describe("se apaga sola", () => {
  it(`escribe hasta el ${ALICLIK_API_SHAPE_PROBE_UNTIL}`, () => {
    expect(apiShapeProbeOn("2026-11-03")).toBe(true);
    expect(apiShapeProbeOn(ALICLIK_API_SHAPE_PROBE_UNTIL)).toBe(true);
    expect(apiShapeProbeOn("2026-11-11")).toBe(false);
  });

  it("el barrido la usa sobre lo que lista, sin cambiar lo que aplica", () => {
    const route = readFileSync("app/api/cron/aliclik-reconcile/route.ts", "utf8");
    expect(route).toContain("if (probeShape) shapeOrders.push(...rows);");
    expect(route).toContain("if (probeShape && shapeOrders.length) logApiShape(storeId, summarizeApiShape(shapeOrders));");
  });
});
