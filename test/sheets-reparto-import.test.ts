// Liquidaciones 2 — lector de la hoja de ruta de un motorizado (MOM §30.6).
import { describe, expect, it } from "vitest";
import {
  interpretStatus,
  nextWeekday,
  normalizeOrderCode,
  normalizeStore,
  parseBlockDate,
  parseMoney,
  parseRepartoMatrix,
  puntoRowValues,
  resolvePayment,
} from "@/lib/sheets/reparto-import";
import { REPARTO_PROPIO_STATUSES, lookupFromTemplates } from "@/lib/sheets/statuses";

const lookup = lookupFromTemplates(REPARTO_PROPIO_STATUSES);

describe("piezas del lector", () => {
  it("lee las fechas de bloque tal como vienen del Excel, incluida la basura de tecleo", () => {
    expect(parseBlockDate("2025-12-02T00:00:00")).toBe("2025-12-02");
    expect(parseBlockDate("12/05/2026")).toBe("2026-05-12");
    expect(parseBlockDate("11/5/2026}")).toBe("2026-05-11");
    expect(parseBlockDate("ROY")).toBeNull();
    expect(parseBlockDate("05/05/0202")).toBeNull();
    expect(parseBlockDate("31/02/2026")).toBeNull();
  });

  it("lee montos con S/ y comas y deja vacío lo que no es número", () => {
    expect(parseMoney("89.0")).toBe(89);
    expect(parseMoney("S/.89,00")).toBe(89);
    expect(parseMoney("328.95")).toBe(328.95);
    expect(parseMoney("SOLO ENTREGAR")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });

  it("normaliza el código de pedido y la tienda", () => {
    expect(normalizeOrderCode("#aur 167846")).toBe("#AUR167846");
    expect(normalizeOrderCode("#kp112574")).toBe("#KP112574");
    expect(normalizeOrderCode("#FLEX")).toBeNull();
    expect(normalizeStore("AURELA")).toBe("Aurela");
    expect(normalizeStore("kenku")).toBe("Kenku");
    expect(normalizeStore("KAST")).toBe("Kast");
    expect(normalizeStore("")).toBeNull();
  });

  it("traduce el método de pago a la lista cerrada y guarda lo escrito", () => {
    expect(resolvePayment("YAPE GF")).toEqual({ method: "Yape Grupo GF", reported: "YAPE GF" });
    expect(resolvePayment("efectivo")).toEqual({ method: "Efectivo", reported: "EFECTIVO" });
    expect(resolvePayment("VENDE MAS")).toEqual({ method: null, reported: "VENDE MAS" });
    expect(resolvePayment("")).toEqual({ method: null, reported: null });
  });

  it("los días de la semana, hoy y mañana son reprogramaciones con fecha", () => {
    expect(nextWeekday("2026-09-15", 4)).toBe("2026-09-17"); // martes → jueves
    expect(nextWeekday("2026-09-17", 4)).toBe("2026-09-24"); // jueves → jueves siguiente
    expect(interpretStatus("JUEVES", "2026-09-15", lookup)).toEqual({ estado: "reprogramado", reprogramar_para: "2026-09-17", unknown: null });
    expect(interpretStatus("LUNES 29", "2026-09-15", lookup)).toEqual({ estado: "reprogramado", reprogramar_para: "2026-09-21", unknown: null });
    expect(interpretStatus("MAÑANA", "2026-09-15", lookup)).toEqual({ estado: "reprogramado", reprogramar_para: "2026-09-16", unknown: null });
    expect(interpretStatus("HOY", "2026-09-15", lookup)).toEqual({ estado: "reprogramado", reprogramar_para: "2026-09-15", unknown: null });
    expect(interpretStatus("NO DESEA", "2026-09-15", lookup)).toMatchObject({ estado: "rechazado" });
    expect(interpretStatus("LO DEJA", "2026-09-15", lookup)).toMatchObject({ estado: "no_salio" });
    expect(interpretStatus("MISMO CLIENTE PTO 37", "2026-09-15", lookup)).toMatchObject({ estado: "repetido" });
    expect(interpretStatus("ANULADO SOLO PTO 10", "2026-09-15", lookup)).toMatchObject({ estado: "cancelado" });
    expect(interpretStatus("ZZZ SIN SENTIDO", "2026-09-15", lookup)).toEqual({ estado: null, reprogramar_para: null, unknown: "ZZZ SIN SENTIDO" });
  });
});

const SHEET: string[][] = [
  ["Fecha", "ROY"],
  ["Motorizado:", "#REF!"],
  [],
  ["", "Vendedor", "Nombre del cliente", "# de Pedido", "A cobrar", "Efectivo", "A cobrar", "Método de Pago", "Observación 1", "Observación 2", "Fecha"],
  ["punto 1", "Aurela", "Juan Navarro", "#AUR167846", "ENTREGADO", "89", "89.0", "EFECTIVO", "", "", "ROY"],
  ["punto 2", "Kenku", "Adela", "#KP94649", "COSA RARA", "", "69.0", "", "portería", "", "ROY"],
  [],
  ["SUBTOTAL", "1 ENTREGADOS", "", "", "89", "89"],
  ["TOTAL A PAGAR A roy", "", "", "", "", "-631.6", "", "KAST YAP/PLN/ETC FK"],
  ["PTOS KAST", "0", "0", "", "EFECTIVO", "#N/A"],
  [],
  ["Fecha", "2026-09-15T00:00:00"],
  ["Motorizado:", "ROY"],
  ["", "Vendedor", "Nombre del cliente", "# de Pedido", "A cobrar", "Efectivo", "A cobrar", "Método de Pago", "Observación 1", "Observación 2", "Fecha"],
  ["Punto 01", "KAST", "Carlos Valencia", "#FLEX", "ENTREGADO", "", "SOLO ENTREGAR", "", "", "", "2026-09-15"],
  ["Punto 02", "AURELA", "Liliana", "#AUR169171", "JUEVES", "39", "59.0", "YAPE GF", "20 soles por POS", "", "2026-09-15"],
  ["Punto 03", "AURELA", "Rocío", "#AUR169171", "ENTREGADO", "59", "59.0", "VENDE MAS", "", "", "2026-09-15"],
  ["Punto 04", "", "", "", "", "", "", "", "", "", ""],
];

describe("parseRepartoMatrix", () => {
  const parsed = parseRepartoMatrix(SHEET, lookup);

  it("recorre los bloques, salta cabeceras y pies, y no inventa filas", () => {
    expect(parsed.blocks).toBe(2);
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rows.map((r) => r.punto)).toEqual(["punto 1", "punto 2", "Punto 01", "Punto 02", "Punto 03"]);
  });

  it("el primer bloque sin fecha legible queda a revisión, sin fecha, con clave propia", () => {
    const first = parsed.rows[0]!;
    expect(first.fecha).toBeNull();
    expect(first.row_key).toBe("s-f##AUR167846");
    expect(first.review).toContain("sin_fecha");
    expect(first).toMatchObject({ tienda: "Aurela", estado: "entregado", efectivo: 89, a_cobrar: 89, metodo_pago: "Efectivo" });
  });

  it("un estado desconocido se guarda literal, la fila queda a revisión y el alias se cuenta", () => {
    const second = parsed.rows[1]!;
    expect(second.estado).toBeNull();
    expect(second.estado_reportado).toBe("COSA RARA");
    expect(second.review).toContain("estado_sin_equivalente");
    expect(parsed.unknownStatuses.get("COSA RARA")).toBe(1);
  });

  it("un punto ajeno a Shopify se conserva pero no se vincula; el monto en texto queda vacío", () => {
    const kast = parsed.rows[2]!;
    expect(kast).toMatchObject({ pedido: "#FLEX", pedido_shopify: false, tienda: "Kast", a_cobrar: null, fecha: "2026-09-15" });
    expect(kast.review).toContain("pedido_no_shopify");
    expect(kast.row_key).toBe("2026-09-15##flex");
  });

  it("el jueves se convierte en reprogramado con fecha, y el pago fuera de lista se recuerda literal", () => {
    const jueves = parsed.rows[3]!;
    expect(jueves).toMatchObject({ estado: "reprogramado", reprogramar_para: "2026-09-17", metodo_pago: "Yape Grupo GF", observacion_1: "20 soles por POS" });
    const vende = parsed.rows[4]!;
    expect(vende).toMatchObject({ metodo_pago: null, metodo_pago_reportado: "VENDE MAS" });
    expect(parsed.unknownPayments.get("VENDE MAS")).toBe(1);
  });

  it("el mismo pedido dos veces el mismo día conserva las dos filas y avisa", () => {
    expect(parsed.rows[3]!.row_key).toBe("2026-09-15##AUR169171");
    expect(parsed.rows[4]!.row_key).toBe("2026-09-15##AUR169171#2");
    expect(parsed.rows[4]!.review).toContain("pedido_repetido_en_el_dia");
  });

  it("los valores guardados llevan la revisión como texto legible", () => {
    const values = puntoRowValues(parsed.rows[1]!);
    expect(values.revision).toBe("sin_fecha, estado_sin_equivalente");
    expect(values.estado_reportado).toBe("COSA RARA");
    expect(puntoRowValues(parsed.rows[3]!).revision).toBeNull();
  });
});
