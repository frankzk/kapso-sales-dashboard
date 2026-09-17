// Liquidaciones 2 — la pantalla del motorizado (MOM §30.9), parte pura.
import { describe, expect, it } from "vitest";
import {
  buildNewPoint,
  buildRiderPointChanges,
  diffChanges,
  isDigitalMethod,
  montoDiffers,
  needsReason,
  nextPuntoLabel,
  puntoOrder,
} from "@/lib/sheets/rider-cuaderno";
import { REPARTO_PROPIO_STATUSES, lookupFromTemplates } from "@/lib/sheets/statuses";

const lookup = lookupFromTemplates(REPARTO_PROPIO_STATUSES);

describe("motivo obligatorio", () => {
  it("solo cuando es entrega, hay monto de Kapta y difiere en más de 0.50", () => {
    expect(needsReason({ aCobrar: 80, kaptaTotal: 89, effect: "entrega" })).toBe(true);
    expect(needsReason({ aCobrar: 89.3, kaptaTotal: 89, effect: "entrega" })).toBe(false);
    expect(needsReason({ aCobrar: 80, kaptaTotal: 89, effect: "informa" })).toBe(false);
    expect(needsReason({ aCobrar: 80, kaptaTotal: null, effect: "entrega" })).toBe(false);
    expect(needsReason({ aCobrar: null, kaptaTotal: 89, effect: "entrega" })).toBe(false);
    expect(montoDiffers(89.51, 89)).toBe(true);
    expect(montoDiffers(89.5, 89)).toBe(false);
  });

  it("distingue los métodos digitales, que piden comprobante", () => {
    expect(isDigitalMethod("Yape Grupo GF")).toBe(true);
    expect(isDigitalMethod("Link de pago")).toBe(true);
    expect(isDigitalMethod("Efectivo")).toBe(false);
    expect(isDigitalMethod(null)).toBe(false);
  });
});

describe("correlativo del día", () => {
  it("sigue al mayor número, con dos dígitos, y ordena los sin número al final", () => {
    expect(nextPuntoLabel([])).toBe("Punto 01");
    expect(nextPuntoLabel(["Punto 01", "punto 7", null, "Punto 03"])).toBe("Punto 08");
    expect(puntoOrder("Punto 12")).toBe(12);
    expect(puntoOrder("Kast")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("buildRiderPointChanges", () => {
  it("guarda lo escrito, lo traduce por alias y conserva la foto", () => {
    const current = { fecha: "2026-09-16", revision: null };
    const out = buildRiderPointChanges(
      current,
      { estado: "mañana", efectivo: 89, a_cobrar: 89, metodo_pago: "Efectivo", observacion_1: "  dejar en portería ", comprobante_path: "cuaderno/x.jpg" },
      lookup,
    );
    expect(out.changes).toMatchObject({
      estado_reportado: "mañana",
      estado: "reprogramado",
      reprogramar_para: "2026-09-17",
      efectivo: 89,
      a_cobrar: 89,
      metodo_pago: "Efectivo",
      metodo_pago_reportado: "Efectivo",
      observacion_1: "dejar en portería",
      comprobante_path: "cuaderno/x.jpg",
    });
    expect(out.unknownAlias).toBeNull();
  });

  it("un estado nuevo queda literal, a revisión y como alias sin equivalente", () => {
    const out = buildRiderPointChanges({ fecha: "2026-09-16" }, { estado: "SE FUE DE VIAJE A ICA", efectivo: null, a_cobrar: 89, metodo_pago: null, observacion_1: null }, lookup);
    expect(out.changes.estado).toBeNull();
    expect(out.changes.estado_reportado).toBe("SE FUE DE VIAJE A ICA");
    expect(out.changes.revision).toBe("estado_sin_equivalente");
    expect(out.unknownAlias).toBe("SE FUE DE VIAJE A ICA");
  });

  it("diffChanges deja solo lo que cambia, para el historial", () => {
    const diff = diffChanges({ a: 1, b: "x", c: null }, { a: 1, b: "y", c: null, d: 5 });
    expect(diff).toEqual({ b: { previous: "x", next: "y" }, d: { previous: null, next: 5 } });
  });
});

describe("buildNewPoint", () => {
  it("clave fecha#pedido, correlativo y monto de Kapta precargado", () => {
    const p = buildNewPoint({ fecha: "2026-09-16", pedido: "#kp 134494", cliente: "Fredy", tienda: "Kenku", a_cobrar: 149, existingPuntos: ["Punto 01"], existingKeys: new Set(["2026-09-16##KP1"]) });
    expect(p.row_key).toBe("2026-09-16##KP134494");
    expect(p.pedido_shopify).toBe(true);
    expect(p.values).toMatchObject({ punto: "Punto 02", pedido: "#KP134494", cliente: "Fredy", tienda: "Kenku", a_cobrar: 149, revision: null });
  });

  it("el mismo pedido dos veces el mismo día no choca de clave", () => {
    const p = buildNewPoint({ fecha: "2026-09-16", pedido: "#KP134494", cliente: null, tienda: null, a_cobrar: null, existingPuntos: [], existingKeys: new Set(["2026-09-16##KP134494"]) });
    expect(p.row_key).toBe("2026-09-16##KP134494#2");
  });

  it("un punto sin pedido Shopify se identifica por el cliente y queda marcado", () => {
    const p = buildNewPoint({ fecha: "2026-09-16", pedido: "FLEX-9", cliente: "Carlos Valencia", tienda: "Kast", a_cobrar: null, existingPuntos: [], existingKeys: new Set() });
    expect(p.pedido_shopify).toBe(false);
    expect(p.row_key).toBe("2026-09-16#flex-9");
    expect(p.values.revision).toBe("pedido_no_shopify");
    const q = buildNewPoint({ fecha: "2026-09-16", pedido: null, cliente: "Ana Pérez", tienda: "Kast", a_cobrar: null, existingPuntos: [], existingKeys: new Set() });
    expect(q.row_key).toBe("2026-09-16#ana_perez");
    expect(q.values.revision).toBeNull();
  });
});
