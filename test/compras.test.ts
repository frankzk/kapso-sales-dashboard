// «Compras»: importaciones (MOM §45). Las reglas puras de lib/compras.ts,
// empezando por el ejemplo de la referencia (docs/compras/referencia-modulo-
// compras.md §6.3): A = 3,40 y B = 14,30 por unidad.

import { describe, expect, it } from "vitest";
import {
  IMPORT_STATUSES,
  IMPORT_STATUS_LABEL,
  LOW_MARGIN,
  checkImportFile,
  cleanCost,
  cleanFx,
  cleanHeader,
  cleanItem,
  cleanPayment,
  cleanReception,
  cleanStatusChange,
  cleanSupplier,
  costPushNote,
  costPushPlan,
  daysBetween,
  formatDmy,
  goodUnits,
  importAlerts,
  importChecklist,
  importFileMime,
  importTabOf,
  isActiveStatus,
  isBeforeReceived,
  isImportFilePath,
  landedCosts,
  limaDateOf,
  limaToday,
  limaYear,
  marginOf,
  moneySummary,
  nextImportCode,
  parseDecimal,
  parseInteger,
  receptionEventNote,
  receptionSummary,
  round2,
  trackingPublicUrl,
  warehouseMessage,
  whatsappShareUrl,
  type LandedCostRow,
  type LandedItem,
} from "@/lib/compras";

const A: LandedItem = { id: "a", name: "A", qty: 100, unitCostUsd: 2, unitWeightKg: 0.5 };
const B: LandedItem = { id: "b", name: "B", qty: 50, unitCostUsd: 12, unitWeightKg: 0.2 };
const COSTS: LandedCostRow[] = [
  { kind: "importacion", label: "Aranceles", amountUsd: 80, allocation: "value" },
  { kind: "envio", label: "Flete", amountUsd: 120, allocation: "weight" },
  { kind: "adicional", label: "Inspección", amountUsd: 30, allocation: "units" },
  { kind: "adicional", label: "Etiquetas B", amountUsd: 25, allocation: "item", itemId: "b" },
];

describe("estados", () => {
  it("los diez estados con sus etiquetas en español, en orden", () => {
    expect(IMPORT_STATUSES.map((s) => s.id)).toEqual([
      "cotizacion",
      "pagado",
      "en_produccion",
      "en_transito",
      "en_aduana",
      "en_camino_bodega",
      "recibido",
      "ingresado",
      "cerrado",
      "cancelado",
    ]);
    expect(IMPORT_STATUS_LABEL.ingresado).toBe("Ingresado al inventario");
    expect(IMPORT_STATUS_LABEL.en_camino_bodega).toBe("En camino a bodega");
  });

  it("pestañas: activas, recibidas y canceladas", () => {
    expect(importTabOf("cotizacion")).toBe("activas");
    expect(importTabOf("en_aduana")).toBe("activas");
    expect(importTabOf("recibido")).toBe("recibidas");
    expect(importTabOf("ingresado")).toBe("recibidas");
    expect(importTabOf("cerrado")).toBe("recibidas");
    expect(importTabOf("cancelado")).toBe("canceladas");
    expect(isActiveStatus("cotizacion")).toBe(true);
    expect(isActiveStatus("recibido")).toBe(false);
  });

  it("antes de Recibido: de Cotización a En camino a bodega; nunca la cancelada", () => {
    expect(isBeforeReceived("cotizacion")).toBe(true);
    expect(isBeforeReceived("en_camino_bodega")).toBe(true);
    expect(isBeforeReceived("recibido")).toBe(false);
    expect(isBeforeReceived("cerrado")).toBe(false);
    expect(isBeforeReceived("cancelado")).toBe(false);
  });

  it("cambio manual: el mismo estado sin nota no es nada; con nota es una novedad", () => {
    expect(cleanStatusChange("pagado", "pagado", "")).toHaveProperty("error");
    expect(cleanStatusChange("pagado", "pagado", "Proveedor confirma producción")).toEqual({
      value: { status: "pagado", note: "Proveedor confirma producción", changed: false },
    });
    expect(cleanStatusChange("pagado", "en_transito", "")).toEqual({ value: { status: "en_transito", note: null, changed: true } });
    expect(cleanStatusChange("pagado", "listo", "")).toEqual({ error: "Estado inválido." });
  });
});

describe("costo aterrizado (§6.3)", () => {
  it("el ejemplo de la referencia: A = 3,40 y B = 14,30", () => {
    const r = landedCosts([A, B], COSTS);
    const a = r.byItem.get("a")!;
    const b = r.byItem.get("b")!;
    expect(a.importacion).toBeCloseTo(20, 10);
    expect(b.importacion).toBeCloseTo(60, 10);
    expect(a.envio).toBeCloseTo(100, 10);
    expect(b.envio).toBeCloseTo(20, 10);
    expect(a.adicional).toBeCloseTo(20, 10);
    expect(b.adicional).toBeCloseTo(35, 10);
    expect(a.unitCost).toBeCloseTo(3.4, 10);
    expect(b.unitCost).toBeCloseTo(14.3, 10);
    expect(round2(a.unitCost)).toBe(3.4);
    expect(round2(b.unitCost)).toBe(14.3);
    expect(r.warnings).toEqual([]);
  });

  it("nada se pierde ni se duplica: Σ total = Σ producto + Σ costos", () => {
    const r = landedCosts([A, B], COSTS);
    expect(r.productTotal).toBe(800);
    expect(r.costsTotal).toBe(255);
    expect(r.lines.reduce((s, l) => s + l.total, 0)).toBeCloseTo(1055, 9);
    expect(r.total).toBe(1055);
  });

  it("el desglose por unidad suma el costo por unidad", () => {
    const b = landedCosts([A, B], COSTS).byItem.get("b")!;
    expect(b.perUnit.product + b.perUnit.envio + b.perUnit.importacion + b.perUnit.adicional).toBeCloseTo(b.unitCost, 10);
    expect(b.perUnit.product).toBe(12);
  });

  it("se reparte sobre lo pedido y se divide entre las unidades buenas (recibidas − dañadas)", () => {
    const counted = landedCosts([{ ...A, receivedQty: 90, damagedQty: 10 }, B], COSTS);
    const a = counted.byItem.get("a")!;
    expect(a.good).toBe(80);
    // Lo mismo repartido (340 USD), ahora entre 80 buenas.
    expect(a.total).toBeCloseTo(340, 9);
    expect(a.unitCost).toBeCloseTo(4.25, 10);
    // B sin contar: sobre lo pedido.
    expect(counted.byItem.get("b")!.good).toBe(50);
  });

  it("sin ninguna unidad buena: pérdida, se muestra sobre lo pedido y se avisa", () => {
    const r = landedCosts([{ ...A, receivedQty: 0, damagedQty: 0 }], []);
    const a = r.byItem.get("a")!;
    expect(a.good).toBe(0);
    expect(a.divisor).toBe(100);
    expect(a.loss).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/pérdida/);
  });

  it("por peso sin pesos: se reparte por unidades, con aviso", () => {
    const r = landedCosts(
      [
        { id: "x", qty: 30, unitCostUsd: 1 },
        { id: "y", qty: 10, unitCostUsd: 1 },
      ],
      [{ kind: "envio", label: "Flete", amountUsd: 40, allocation: "weight" }],
    );
    expect(r.byItem.get("x")!.envio).toBeCloseTo(30, 10);
    expect(r.byItem.get("y")!.envio).toBeCloseTo(10, 10);
    expect(r.warnings).toEqual(["Faltan pesos: «Flete» se reparte por unidades."]);
  });

  it("por valor sin costos cargados: por unidades, con aviso", () => {
    const r = landedCosts(
      [
        { id: "x", qty: 1, unitCostUsd: 0 },
        { id: "y", qty: 3, unitCostUsd: 0 },
      ],
      [{ kind: "importacion", label: "Agente", amountUsd: 8, allocation: "value" }],
    );
    expect(r.byItem.get("y")!.importacion).toBeCloseTo(6, 10);
    expect(r.warnings[0]).toMatch(/Sin costos por unidad cargados/);
  });

  it("un costo «a un producto» cuyo producto se quitó NO desaparece: va por valor, con aviso (§13.4)", () => {
    const r = landedCosts([A, B], [{ kind: "adicional", label: "Etiquetas", amountUsd: 80, allocation: "item", itemId: null }]);
    expect(r.byItem.get("a")!.adicional).toBeCloseTo(20, 10);
    expect(r.byItem.get("b")!.adicional).toBeCloseTo(60, 10);
    expect(r.total).toBe(880);
    expect(r.warnings).toEqual(["«Etiquetas» estaba asignado a un producto que ya no está: se reparte por valor."]);
    // Lo mismo si apunta a un id que ya no está entre las líneas.
    expect(landedCosts([A], [{ kind: "adicional", label: "E", amountUsd: 5, allocation: "item", itemId: "zz" }]).byItem.get("a")!.adicional).toBe(5);
  });

  it("sin productos, el costo queda sin repartir y se dice", () => {
    const r = landedCosts([], [{ kind: "envio", label: "Flete", amountUsd: 50, allocation: "units" }]);
    expect(r.unallocated).toBe(50);
    expect(r.total).toBe(50);
    expect(r.warnings[0]).toMatch(/no se puede repartir/);
  });

  it("unidades buenas", () => {
    expect(goodUnits({ qty: 10, receivedQty: null, damagedQty: null })).toBe(10);
    expect(goodUnits({ qty: 10, receivedQty: 8, damagedQty: 3 })).toBe(5);
    expect(goodUnits({ qty: 10, receivedQty: 2, damagedQty: 5 })).toBe(0);
  });
});

describe("margen en soles, pagado y falta pagar", () => {
  it("margen = precio − costo × tipo de cambio; bajo si es menos del 20 %", () => {
    const m = marginOf(3.4, 3.75, 20, 100)!;
    expect(m.unitCostPen).toBeCloseTo(12.75, 10);
    expect(m.unit).toBeCloseTo(7.25, 10);
    expect(m.pct).toBeCloseTo(0.3625, 10);
    expect(m.total).toBeCloseTo(725, 9);
    expect(m.low).toBe(false);
    expect(marginOf(3.4, 3.75, 15, 1)!.low).toBe(true);
    expect(LOW_MARGIN).toBe(0.2);
  });

  it("sin tipo de cambio o sin precio, no hay margen", () => {
    expect(marginOf(3.4, null, 20, 1)).toBeNull();
    expect(marginOf(3.4, 3.75, null, 1)).toBeNull();
    expect(marginOf(3.4, 3.75, 0, 1)).toBeNull();
  });

  it("pagado, falta pagar y ganancia esperada", () => {
    const landed = landedCosts([A, B], COSTS);
    const s = moneySummary(
      landed,
      [
        { id: "a", salePricePen: 20 },
        { id: "b", salePricePen: 60 },
      ],
      [{ amountUsd: 500 }, { amountUsd: 255 }],
      3.75,
    );
    expect(s.totalUsd).toBe(1055);
    expect(s.paidUsd).toBe(755);
    expect(s.pendingUsd).toBeCloseTo(300, 9);
    expect(s.avgUnitUsd).toBeCloseTo(1055 / 150, 9);
    // A: (20 − 12,75) × 100 = 725 · B: (60 − 53,625) × 50 = 318,75
    expect(s.expectedProfitPen).toBeCloseTo(1043.75, 6);
    expect(s.recoveryShare).toBeCloseTo((1055 * 3.75) / 5000, 9);
    // Medio centavo no es deuda.
    expect(moneySummary(landed, [], [{ amountUsd: 1054.996 }], null).pendingUsd).toBe(0);
    // Sin precio en alguna línea, no hay ganancia esperada.
    expect(moneySummary(landed, [{ id: "a", salePricePen: 20 }, { id: "b", salePricePen: null }], [], 3.75).expectedProfitPen).toBeNull();
  });
});

describe("recepción (§6.6)", () => {
  const items = [
    { id: "a", qty: 100, receivedQty: 90, damagedQty: 4 },
    { id: "b", qty: 50, receivedQty: 52, damagedQty: 0 },
    { id: "c", qty: 10, receivedQty: null, damagedQty: null },
  ];

  it("pedidas, llegaron, faltan, sobran, dañadas, buenas y sin contar", () => {
    const s = receptionSummary(items);
    expect(s).toMatchObject({ ordered: 160, received: 142, damaged: 4, missing: 10, extra: 2, good: 86 + 52 + 10, counted: 2, uncounted: 1, complete: false });
    expect(s.withDifferences).toEqual(["a", "b"]);
    expect(receptionEventNote(s)).toBe("Recepción: 142 de 160 u. · faltan 10 · sobran 2 · 4 dañadas · 1 sin contar");
    expect(receptionSummary(items.slice(0, 2)).complete).toBe(true);
  });

  it("valida lo contado: vacío = sin contar; dañadas ≤ recibidas; al menos una línea", () => {
    const ids = ["a", "b"];
    expect(cleanReception(ids, [{ itemId: "a", received: "", damaged: "" }])).toEqual({ error: "Anota lo recibido de al menos un producto." });
    expect(cleanReception(ids, [{ itemId: "a", received: "", damaged: "2" }])).toHaveProperty("error");
    expect(cleanReception(ids, [{ itemId: "a", received: "3", damaged: "4" }])).toEqual({ error: "Las dañadas no pueden ser más que las recibidas." });
    expect(cleanReception(ids, [{ itemId: "a", received: "-1" }])).toHaveProperty("error");
    expect(cleanReception(ids, [{ itemId: "zz", received: "1" }])).toHaveProperty("error");
    expect(cleanReception(ids, [{ itemId: "a", received: "1,500", damaged: "", note: " caja rota " }, { itemId: "b", received: "" }])).toEqual({
      value: [
        { itemId: "a", received_qty: 1500, damaged_qty: 0, reception_note: "caja rota" },
        { itemId: "b", received_qty: null, damaged_qty: null, reception_note: null },
      ],
    });
  });
});

describe("alertas con fechas de Lima", () => {
  const today = "2026-11-14";
  const base = { status: "en_transito" as const, eta: "2026-11-20", reportedAt: null, lastMovementAt: "2026-11-13T15:00:00Z" };

  it("atrasada: activa, no cotización, llegada estimada antes de hoy", () => {
    expect(importAlerts({ ...base, eta: "2026-11-13" }, today).late).toBe(true);
    expect(importAlerts({ ...base, eta: "2026-11-14" }, today).late).toBe(false);
    // Corrige §13.1 de la referencia: una cotización vencida no es «atrasada».
    expect(importAlerts({ ...base, status: "cotizacion", eta: "2026-11-01" }, today).late).toBe(false);
    expect(importAlerts({ ...base, status: "recibido", eta: "2026-11-01" }, today).late).toBe(false);
  });

  it("avisar a la bodega: sin reportar, no cotización y faltan 3 días o menos (o ya pasó)", () => {
    expect(importAlerts({ ...base, eta: "2026-11-17" }, today).notifyWarehouse).toBe(true);
    expect(importAlerts({ ...base, eta: "2026-11-18" }, today).notifyWarehouse).toBe(false);
    expect(importAlerts({ ...base, eta: "2026-11-10" }, today).notifyWarehouse).toBe(true);
    expect(importAlerts({ ...base, eta: "2026-11-15", reportedAt: "2026-11-12T10:00:00Z" }, today).notifyWarehouse).toBe(false);
    // Corrige §13.2: una cotización no se avisa.
    expect(importAlerts({ ...base, status: "cotizacion", eta: "2026-11-15" }, today).notifyWarehouse).toBe(false);
    expect(importAlerts({ ...base, eta: null }, today).notifyWarehouse).toBe(false);
  });

  it("sin novedades: viajando y 7 días o más desde la última novedad, contados en Lima", () => {
    expect(importAlerts({ ...base, lastMovementAt: "2026-11-07T12:00:00Z" }, today)).toMatchObject({ stale: true, daysSinceMovement: 7 });
    expect(importAlerts({ ...base, lastMovementAt: "2026-11-08T12:00:00Z" }, today).stale).toBe(false);
    // 8-11 a las 02:00 UTC es todavía el 7-11 en Lima: ya son 7 días.
    expect(importAlerts({ ...base, lastMovementAt: "2026-11-08T02:00:00Z" }, today).stale).toBe(true);
    expect(importAlerts({ ...base, status: "pagado", lastMovementAt: "2026-10-01T12:00:00Z" }, today).stale).toBe(false);
  });

  it("hoy en Lima no es la fecha UTC (§13.3)", () => {
    // 14-11 a las 03:00 UTC son las 22:00 del 13-11 en Lima.
    const night = new Date("2026-11-14T03:00:00Z");
    expect(limaToday(night)).toBe("2026-11-13");
    expect(limaDateOf("2026-11-14T05:00:00Z")).toBe("2026-11-14");
    // El año del código también: el 1-1 a las 02:00 UTC todavía es 31-12 en Lima.
    expect(limaYear(new Date("2027-01-01T02:00:00Z"))).toBe(2026);
    expect(daysBetween("2026-11-14", "2026-11-17")).toBe(3);
    expect(formatDmy("2026-11-04")).toBe("04/11/2026");
  });

  it("checklist: factura comercial y tracking (número de guía o documento de guía)", () => {
    expect(importChecklist([], null)).toEqual({ invoice: false, tracking: false });
    expect(importChecklist(["invoice"], "1234")).toEqual({ invoice: true, tracking: true });
    expect(importChecklist(["tracking", "proforma"], "  ")).toEqual({ invoice: false, tracking: true });
  });
});

describe("seguimiento y mensaje a la bodega", () => {
  it("enlace público: el manual http(s) primero; si no, la paquetera; si no, 17TRACK", () => {
    expect(trackingPublicUrl({ carrier: "DHL", trackingNumber: "123", trackingUrl: "https://mi.courier/1" })).toBe("https://mi.courier/1");
    expect(trackingPublicUrl({ carrier: "dhl", trackingNumber: "123" })).toContain("dhl.com");
    expect(trackingPublicUrl({ carrier: "FedEx", trackingNumber: "77" })).toBe("https://www.fedex.com/fedextrack/?trknbr=77");
    expect(trackingPublicUrl({ carrier: "UPS", trackingNumber: "1Z" })).toContain("ups.com");
    expect(trackingPublicUrl({ carrier: "USPS", trackingNumber: "9" })).toContain("usps.com");
    expect(trackingPublicUrl({ carrier: "Aramex", trackingNumber: "9" })).toContain("aramex.com");
    expect(trackingPublicUrl({ carrier: "DHL Express", trackingNumber: "A B" })).toBe("https://t.17track.net/es#nums=A%20B");
    expect(trackingPublicUrl({ carrier: "DHL", trackingNumber: "1", trackingUrl: "javascript:alert(1)" })).toContain("dhl.com");
    expect(trackingPublicUrl({ carrier: "DHL", trackingNumber: "" })).toBeNull();
  });

  it("el mensaje dice bodega de Kapta en Lima, productos con unidades, guía y llegada dd/mm/aaaa", () => {
    const msg = warehouseMessage({
      code: "IMP-2026-001",
      supplierName: "Yiwu Trading",
      carrier: "DHL",
      trackingNumber: "123456",
      trackingLink: "https://x",
      eta: "2026-11-20",
      items: [
        { qty: 100, name: "Shampoo", sku: "SH-1" },
        { qty: 50, name: "Peine", sku: null },
      ],
    });
    expect(msg).toContain("bodega de Kapta en Lima");
    expect(msg).toContain("*IMP-2026-001* · Proveedor: *Yiwu Trading*");
    expect(msg).toContain("Guía: DHL 123456");
    expect(msg).toContain("Llegada estimada: 20/11/2026");
    expect(msg).toContain("• 100 × Shampoo (SKU SH-1)");
    expect(msg).toContain("• 50 × Peine\n");
    expect(msg).toContain("Total: 150 u.");
    expect(whatsappShareUrl("a b")).toBe("https://wa.me/?text=a%20b");
    expect(whatsappShareUrl("", "+86 138-0000")).toBe("https://wa.me/861380000?text=");
  });
});

describe("código IMP-<año>-NNN", () => {
  it("el siguiente del año, con 3 dígitos mínimo; otros años no cuentan", () => {
    expect(nextImportCode([], 2026)).toBe("IMP-2026-001");
    expect(nextImportCode(["IMP-2026-001", "IMP-2026-009", "IMP-2025-120"], 2026)).toBe("IMP-2026-010");
    expect(nextImportCode(["IMP-2026-999"], 2026)).toBe("IMP-2026-1000");
  });
});

describe("validaciones", () => {
  it("cabecera: transporte, fechas y enlace http(s)", () => {
    expect(cleanHeader({ transport: "rocket" })).toEqual({ error: "Transporte inválido." });
    expect(cleanHeader({ trackingUrl: "ftp://x" })).toHaveProperty("error");
    expect(cleanHeader({ trackingUrl: "javascript:alert(1)" })).toHaveProperty("error");
    expect(cleanHeader({ eta: "2026-02-30" })).toEqual({ error: "Llegada estimada: fecha inválida." });
    const ok = cleanHeader({ origin: "  China,   Yiwu ", transport: "sea", eta: "2026-12-01", trackingUrl: "https://t.co/x" });
    expect(ok).toMatchObject({ value: { origin: "China, Yiwu", transport: "sea", eta: "2026-12-01", supplier_id: null } });
  });

  it("tipo de cambio: soles por 1 USD, mayor que 0", () => {
    expect(cleanFx("")).toEqual({ value: null });
    expect(cleanFx("3,7512")).toEqual({ value: 3.7512 });
    expect(cleanFx("0")).toHaveProperty("error");
  });

  it("producto: cantidad de 1 a 10.000.000; sin «Montos de compras» el costo y el precio NO se leen", () => {
    expect(cleanItem({ name: "X", qty: "0" }, true)).toHaveProperty("error");
    expect(cleanItem({ name: "X", qty: "10000001" }, true)).toHaveProperty("error");
    expect(cleanItem({ name: "", qty: "1" }, true)).toHaveProperty("error");
    const withMoney = cleanItem({ name: "X", sku: "S1", qty: "1,500", unitCostUsd: "2.1234", salePricePen: "19.9" }, true);
    expect(withMoney).toEqual({ value: { store_id: null, sku: "S1", name: "X", qty: 1500, unit_weight_kg: null, unit_cost_usd: 2.1234, sale_price_pen: 19.9 } });
    const noMoney = cleanItem({ name: "X", qty: "5", unitCostUsd: "99", salePricePen: "1" }, false);
    expect(noMoney).toEqual({ value: { store_id: null, sku: null, name: "X", qty: 5, unit_weight_kg: null } });
    expect("value" in noMoney && "unit_cost_usd" in noMoney.value).toBe(false);
    expect("value" in noMoney && "sale_price_pen" in noMoney.value).toBe(false);
  });

  it("costo: monto > 0, reparto válido, «a un producto» de ESTA importación", () => {
    expect(cleanCost({ kind: "envio", amountUsd: "0" }, [])).toHaveProperty("error");
    expect(cleanCost({ kind: "flete", amountUsd: "5" }, [])).toHaveProperty("error");
    expect(cleanCost({ kind: "envio", amountUsd: "5", allocation: "item", itemId: "otro" }, ["a"])).toHaveProperty("error");
    expect(cleanCost({ kind: "envio", amountUsd: "120", allocation: "weight", itemId: "a" }, ["a"])).toEqual({
      value: { kind: "envio", label: "Envío", amount_usd: 120, allocation: "weight", item_id: null },
    });
  });

  it("pago: monto > 0, fecha, método y comprobante de la misma importación", () => {
    expect(cleanPayment({ amountUsd: "10", paidOn: "2026-11-01", method: "bitcoin" }, [])).toHaveProperty("error");
    expect(cleanPayment({ amountUsd: "10", paidOn: "2026-11-01", method: "paypal", documentId: "d2" }, ["d1"])).toHaveProperty("error");
    expect(cleanPayment({ amountUsd: "1,234.5", paidOn: "2026-11-01", method: "transferencia", documentId: "d1" }, ["d1"])).toEqual({
      value: { amount_usd: 1234.5, paid_on: "2026-11-01", method: "transferencia", note: null, document_id: "d1" },
    });
  });

  it("proveedor: nombre obligatorio y WhatsApp con código de país", () => {
    expect(cleanSupplier({ name: " " })).toHaveProperty("error");
    expect(cleanSupplier({ name: "Yiwu", whatsapp: "abc" })).toHaveProperty("error");
    expect(cleanSupplier({ name: "Yiwu", whatsapp: "+86 138 0000 1111" })).toEqual({
      value: { name: "Yiwu", country: null, whatsapp: "+8613800001111", notes: null },
    });
  });

  it("números escritos a mano", () => {
    expect(parseDecimal("1,234.56")).toBe(1234.56);
    expect(parseDecimal("12,5")).toBe(12.5);
    expect(parseDecimal("1,500")).toBe(1500);
    expect(parseDecimal("US$ 30")).toBe(30);
    expect(parseDecimal("abc")).toBeNull();
    expect(parseInteger("1.500")).toBe(1500);
    expect(parseInteger("2.5")).toBeNull();
  });

  it("archivos: PDF, JPG, PNG, WEBP o XLSX hasta 25 MB; fotos solo imágenes", () => {
    expect(importFileMime("", "factura.PDF")).toBe("application/pdf");
    expect(importFileMime("image/jpg", "x")).toBe("image/jpeg");
    expect(importFileMime("text/html", "x.pdf")).toBeNull();
    expect(checkImportFile("invoice", { contentType: "application/pdf", size: 25 * 1024 * 1024 + 1 })).toEqual({ error: "El archivo pesa más de 25 MB." });
    expect(checkImportFile("photo", { contentType: "application/pdf", size: 10 })).toHaveProperty("error");
    expect(checkImportFile("item_photo", { contentType: "image/webp", size: 10 })).toEqual({ mime: "image/webp" });
    expect(checkImportFile("packing", { contentType: "", filename: "lista.xlsx", size: 10 })).toHaveProperty("mime");
  });

  it("rutas de archivos: solo las que el servidor generó para esa importación", () => {
    const org = "11111111-1111-4111-8111-111111111111";
    const imp = "22222222-2222-4222-8222-222222222222";
    const file = "33333333-3333-4333-8333-333333333333";
    expect(isImportFilePath(`${org}/${imp}/docs/${file}.pdf`, org, imp, "docs")).toBe(true);
    expect(isImportFilePath(`${org}/${imp}/items/${file}.pdf`, org, imp, "docs")).toBe(false);
    expect(isImportFilePath(`${org}/${imp}/docs/../${file}.pdf`, org, imp, "docs")).toBe(false);
    expect(isImportFilePath(`${org}/${file}/docs/${file}.pdf`, org, imp, "docs")).toBe(false);
  });
});

describe("«Pasar a Costos»", () => {
  const items = [
    { id: "a", name: "A", sku: "SKU-A", storeId: "s1", receivedQty: 100, costPushedAt: null },
    { id: "b", name: "B", sku: "SKU-B", storeId: null, receivedQty: 50, costPushedAt: null },
  ];
  const landed = landedCosts(
    [
      { ...A, receivedQty: 100, damagedQty: 0 },
      { ...B, receivedQty: 50, damagedQty: 0 },
    ],
    COSTS,
  );

  it("Recibida, contada y con tipo de cambio: el costo por unidad en soles a 2 decimales", () => {
    const plan = costPushPlan({ status: "recibido", fxPenPerUsd: 3.7517, items, landed });
    expect(plan.blockers).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.lines).toEqual([
      { itemId: "a", name: "A", sku: "SKU-A", storeId: "s1", state: "push", unitCostPen: 12.76 },
      { itemId: "b", name: "B", sku: "SKU-B", storeId: null, state: "push", unitCostPen: 53.65 },
    ]);
    expect(costPushNote("IMP-2026-001")).toBe("Costo aterrizado IMP-2026-001");
  });

  it("antes de Recibido, cancelada, sin tipo de cambio o sin contar: no se puede", () => {
    expect(costPushPlan({ status: "en_aduana", fxPenPerUsd: 3.75, items, landed }).ready).toBe(false);
    expect(costPushPlan({ status: "cancelado", fxPenPerUsd: 3.75, items, landed }).ready).toBe(false);
    expect(costPushPlan({ status: "cerrado", fxPenPerUsd: null, items, landed }).blockers).toContain("Falta el tipo de cambio (soles por 1 USD).");
    const uncounted = costPushPlan({ status: "ingresado", fxPenPerUsd: 3.75, items: [{ ...items[0]!, receivedQty: null }, items[1]!], landed });
    expect(uncounted.ready).toBe(false);
    expect(uncounted.blockers.join(" ")).toMatch(/Falta contar 1 producto/);
  });

  it("solo las líneas con SKU; una sin SKU no impide pasar las demás", () => {
    const plan = costPushPlan({
      status: "recibido",
      fxPenPerUsd: 3.75,
      items: [items[0]!, { id: "b", name: "B", sku: null, storeId: null, receivedQty: null, costPushedAt: null }],
      landed,
    });
    expect(plan.ready).toBe(true);
    expect(plan.lines.map((l) => l.itemId)).toEqual(["a"]);
  });

  it("dos veces no duplica: lo ya pasado sale «ya se pasó»", () => {
    const pushed = items.map((it) => ({ ...it, costPushedAt: "2026-11-14T15:00:00Z" }));
    const plan = costPushPlan({ status: "recibido", fxPenPerUsd: 3.75, items: pushed, landed });
    expect(plan.alreadyDone).toBe(true);
    expect(plan.ready).toBe(false);
    expect(plan.lines.every((l) => l.state === "already")).toBe(true);
  });

  it("el mismo SKU dos veces en la misma tienda bloquea; sin unidades buenas no se pasa", () => {
    const dup = costPushPlan({ status: "recibido", fxPenPerUsd: 3.75, items: [items[0]!, { ...items[1]!, sku: "sku-a ", storeId: "s1" }], landed });
    expect(dup.ready).toBe(false);
    const zero = landedCosts([{ ...A, receivedQty: 5, damagedQty: 5 }], []);
    const plan = costPushPlan({ status: "recibido", fxPenPerUsd: 3.75, items: [{ ...items[0]!, receivedQty: 5 }], landed: zero });
    expect(plan.lines[0]).toMatchObject({ state: "skip" });
    expect(plan.ready).toBe(false);
  });
});
