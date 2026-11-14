// «Compras»: cada costo y cada pago en su moneda, e «Incluye IGV» (0342, MOM
// §45.3, decisión del owner del 14-11-2026). Las reglas puras:
//   - El costo aterrizado con costos en USD y en soles: en soles, el proveedor y
//     los USD × el tipo de cambio de la importación y los soles TAL CUAL (sin ida
//     y vuelta); en USD, los soles ÷ el tipo de cambio. El reparto no cambia
//     («por valor» es el valor del proveedor en USD).
//   - Sin tipo de cambio, lo que necesita convertir es null («Falta el tipo de
//     cambio»), nunca una cifra a medias.
//   - «Incluye IGV»: monto ÷ 1,18 a 2 decimales (S/ 504.16 → S/ 427.25).
//   - «Pagado / Falta pagar» sin mezclar monedas.
//   - «Leer con IA»: la moneda de CADA cargo y el IGV aparte, nunca como costo.
//   - Los reportes: los USD necesitan el tipo de cambio para los soles, y dicen
//     cuántas importaciones no lo tienen.

import { describe, expect, it } from "vitest";
import {
  IGV_HELP,
  IGV_RATE,
  MISSING_FX,
  cleanCost,
  cleanCurrency,
  cleanPayment,
  costAmountText,
  costPushPlan,
  igvOf,
  landedCosts,
  moneyInPen,
  moneyInUsd,
  moneySummary,
  netOfIgv,
  paidSplit,
  paymentBalance,
  round2,
  type LandedCostRow,
  type LandedItem,
} from "@/lib/compras";
import { aiChargeNeedsFx, aiConfirmToInputs, isoCurrency, parseAiProposal, type AiConfirmInput } from "@/lib/compras-ia";
import {
  importsMissingFxForUsd,
  moneyInTransit,
  monthlySpend,
  needsFxForUsd,
  supplierStats,
  unitCostHistory,
  type ReportImport,
} from "@/lib/compras-reportes";

const close = (n: number | null | undefined, expected: number, digits = 9) => expect(n ?? NaN).toBeCloseTo(expected, digits);

// El ejemplo de la referencia (A y B) con la factura de DHL Express Perú en soles.
const X: LandedItem = { id: "x", name: "X", qty: 100, unitCostUsd: 2, unitWeightKg: 0.5 };
const Y: LandedItem = { id: "y", name: "Y", qty: 50, unitCostUsd: 12, unitWeightKg: 0.2 };
const DHL: LandedCostRow[] = [
  { kind: "importacion", label: "Gastos de nacionalización", amount: 37.6, currency: "PEN", allocation: "value" },
  { kind: "importacion", label: "Aforo físico", amount: 114.5, currency: "PEN", allocation: "value" },
  { kind: "importacion", label: "Rectificación de la declaración aduanera", amount: 189.7, currency: "PEN", allocation: "value" },
  { kind: "importacion", label: "Cargo por aranceles e impuestos pagados", amount: 85.45, currency: "PEN", allocation: "value" },
];
const FLETE: LandedCostRow = { kind: "envio", label: "Flete", amount: 120, currency: "USD", allocation: "weight" };
const MIXED = [FLETE, ...DHL];

describe("costo aterrizado con costos en USD y en soles", () => {
  const r = landedCosts([X, Y], MIXED, 3.75);
  const x = r.byItem.get("x")!;
  const y = r.byItem.get("y")!;

  it("cada costo se reparte en SU moneda, con la regla de siempre («por valor» = valor del proveedor en USD)", () => {
    // Por valor: X 200 y Y 600 USD → X lleva ¼ de los soles y Y ¾, aunque el costo sea en soles.
    close(x.split.importacion.pen, 427.25 / 4);
    close(y.split.importacion.pen, (427.25 * 3) / 4);
    expect(x.split.importacion.usd).toBe(0);
    // Por peso: el flete en USD, como en la referencia.
    close(x.split.envio.usd, 100);
    close(y.split.envio.usd, 20);
    expect(r.split.costs.usd).toBe(120);
    close(r.split.costs.pen, 427.25, 10);
    expect(r.hasPenCosts).toBe(true);
  });

  it("en soles: el proveedor y los USD × tipo de cambio, y los soles TAL CUAL", () => {
    close(x.pen!.product, 750);
    close(x.pen!.envio, 375);
    // Los soles de la factura, sin pasar por el dólar.
    close(x.pen!.importacion, 106.8125, 10);
    close(x.pen!.total, 750 + 375 + 106.8125);
    close(x.pen!.unitCost, 12.318125);
    // Σ de lo que entra en soles = los soles de la factura.
    close(r.lines.reduce((a, l) => a + l.pen!.importacion, 0), 427.25, 10);
    close(r.pen!.total, (800 + 120) * 3.75 + 427.25);
  });

  it("en USD: los soles ÷ el tipo de cambio", () => {
    close(x.usd!.importacion, 106.8125 / 3.75);
    close(x.usd!.total, 200 + 100 + 106.8125 / 3.75);
    close(r.usd!.costsTotal, 120 + 427.25 / 3.75);
    close(r.usd!.total, 920 + 427.25 / 3.75);
    // Las dos vistas son la misma cuenta: USD × tipo de cambio = soles.
    close(x.usd!.unitCost * 3.75, x.pen!.unitCost);
    close(y.usd!.unitCost * 3.75, y.pen!.unitCost);
  });

  it("«Pasar a Costos» usa los soles tal cual: un centavo distinto de la ida y vuelta por el dólar", () => {
    // 1 u. de 10 USD + S/ 427.25 de nacionalización, a 3,7517.
    const one = landedCosts([{ id: "z", name: "Z", qty: 1, unitCostUsd: 10, receivedQty: 1, damagedQty: 0 }], [{ ...DHL[0]!, amount: 427.25 }], 3.7517);
    const plan = costPushPlan({
      status: "recibido",
      fxPenPerUsd: 3.7517,
      items: [{ id: "z", name: "Z", sku: "SKU-Z", storeId: null, receivedQty: 1, costPushedAt: null }],
      landed: one,
    });
    expect(plan.ready).toBe(true);
    // 10 × 3,7517 + 427,25 = 464,767 → S/ 464.77.
    expect(plan.lines[0]).toMatchObject({ state: "push", unitCostPen: 464.77 });
    // Convertir al guardar (427,25 ÷ 3,7517 = 113,88 USD) y volver daría S/ 464.76.
    expect(round2((10 + round2(427.25 / 3.7517)) * 3.7517)).toBe(464.76);
  });

  it("los soles de un producto que solo tiene costos en soles son exactos", () => {
    const only = landedCosts([{ id: "p", qty: 1, unitCostUsd: 0 }], [{ kind: "importacion", label: "Aforo", amount: 114.5, currency: "PEN", allocation: "units" }], 3.7517);
    expect(only.byItem.get("p")!.pen!.unitCost).toBe(114.5);
  });

  it("un costo sin moneda es USD (como antes de la 0342)", () => {
    const old = landedCosts([X], [{ kind: "envio", label: "Flete", amount: 50, allocation: "units" }]);
    expect(old.hasPenCosts).toBe(false);
    expect(old.usd!.costsTotal).toBe(50);
  });
});

describe("sin tipo de cambio: «Falta el tipo de cambio», nunca una cifra a medias", () => {
  it("con costos en soles, ni la vista en USD ni la de soles; lo de cada moneda sí", () => {
    const r = landedCosts([X, Y], MIXED, null);
    expect(r.usd).toBeNull();
    expect(r.pen).toBeNull();
    expect(r.byItem.get("x")!.usd).toBeNull();
    expect(r.byItem.get("x")!.pen).toBeNull();
    expect(r.split.total.usd).toBe(920);
    close(r.split.total.pen, 427.25, 10);
    expect(MISSING_FX).toBe("Falta el tipo de cambio");
  });

  it("todo en USD: la vista en USD sí (como siempre), la de soles no", () => {
    const r = landedCosts([X, Y], [FLETE], null);
    expect(r.usd!.total).toBe(920);
    expect(r.pen).toBeNull();
  });

  it("solo soles (sin costo del proveedor): la vista en soles no necesita tipo de cambio", () => {
    const r = landedCosts([{ id: "p", qty: 10, unitCostUsd: 0 }], [{ ...DHL[1]!, allocation: "units" }], null);
    expect(r.byItem.get("p")!.pen!.unitCost).toBeCloseTo(11.45, 10);
    expect(r.byItem.get("p")!.usd).toBeNull();
  });

  it("un tipo de cambio 0 o negativo es como no tenerlo", () => {
    expect(landedCosts([X], DHL, 0).usd).toBeNull();
    expect(landedCosts([X], DHL, -3).pen).toBeNull();
    expect(moneyInUsd({ usd: 1, pen: 2 }, 0)).toBeNull();
    expect(moneyInPen({ usd: 0, pen: 2 }, null)).toBe(2);
  });

  it("el resumen: sin totales convertidos, sin promedio, sin margen ni ganancia; el saldo pide el tipo de cambio", () => {
    const landed = landedCosts([X, Y], MIXED, null);
    const s = moneySummary(landed, [{ id: "x", salePricePen: 20 }, { id: "y", salePricePen: 60 }], [{ amount: 500 }]);
    expect(s.totalUsd).toBeNull();
    expect(s.totalPen).toBeNull();
    expect(s.avgUnitUsd).toBeNull();
    expect(s.expectedProfitPen).toBeNull();
    expect(s.pendingUsd).toBeNull();
    expect(s.needsFx).toBe(true);
    expect(s.total).toEqual(landed.split.total);
    expect(s.paid).toEqual({ usd: 500, pen: 0 });
  });

  it("«Pasar a Costos» sigue pidiendo el tipo de cambio", () => {
    const landed = landedCosts([{ ...X, receivedQty: 100, damagedQty: 0 }], DHL, null);
    const plan = costPushPlan({
      status: "recibido",
      fxPenPerUsd: null,
      items: [{ id: "x", name: "X", sku: "SKU-X", storeId: null, receivedQty: 100, costPushedAt: null }],
      landed,
    });
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContain("Falta el tipo de cambio (soles por 1 USD).");
  });
});

describe("«Incluye IGV» (18 %)", () => {
  it("la factura de DHL: S/ 504.16 con IGV → S/ 427.25 sin IGV, IGV S/ 76.91", () => {
    expect(IGV_RATE).toBe(0.18);
    expect(netOfIgv(504.16)).toBe(427.25);
    expect(igvOf(504.16)).toBe(76.91);
    expect(round2(netOfIgv(504.16) + igvOf(504.16))).toBe(504.16);
  });

  it("el monto sin IGV se redondea a 2 decimales", () => {
    expect(netOfIgv(118)).toBe(100);
    // 100 ÷ 1,18 = 84,7457… → 84,75.
    expect(netOfIgv(100)).toBe(84.75);
    // 0,01 ÷ 1,18 = 0,0085 → 0,01: nunca 0.
    expect(netOfIgv(0.01)).toBe(0.01);
    expect(netOfIgv(1)).toBe(0.85);
  });

  it("con la casilla se guarda el monto con IGV y entra al costo ÷ 1,18; sin ella, tal cual", () => {
    expect(cleanCost({ kind: "importacion", label: "DHL Express Perú", amount: "504.16", currency: "PEN", includesIgv: true }, [])).toEqual({
      value: {
        kind: "importacion",
        label: "DHL Express Perú",
        currency: "PEN",
        amount_usd: null,
        amount_pen: 427.25,
        includes_igv: true,
        gross_amount: 504.16,
        allocation: "value",
        item_id: null,
      },
    });
    // La casilla viene apagada: las líneas de la factura ya suelen venir sin IGV.
    expect(cleanCost({ kind: "importacion", amount: "427.25", currency: "PEN" }, [])).toMatchObject({
      value: { amount_pen: 427.25, includes_igv: false, gross_amount: null },
    });
    expect(cleanCost({ kind: "adicional", amount: "100", currency: "USD", includesIgv: "on" }, [])).toMatchObject({
      value: { currency: "USD", amount_usd: 84.75, amount_pen: null, includes_igv: true, gross_amount: 100 },
    });
  });

  it("el historial, el detalle y el Excel lo cuentan con los dos montos", () => {
    expect(costAmountText({ amount: 427.25, currency: "PEN", includes_igv: true, gross_amount: 504.16 })).toBe("S/ 504.16 con IGV → S/ 427.25 sin IGV");
    expect(costAmountText({ amount: 114.5, currency: "PEN" })).toBe("S/ 114.50");
    expect(costAmountText({ amount: 20.07, currency: "USD", includes_igv: false, gross_amount: null })).toBe("US$ 20.07");
  });

  it("la ayuda de la casilla", () => {
    expect(IGV_HELP).toBe("Las líneas de la factura ya suelen venir sin IGV; marca esta casilla solo si cargas el total con IGV.");
  });
});

describe("la moneda de cada costo y de cada pago", () => {
  it("USD o soles; vacío es USD; otra, error", () => {
    expect(cleanCurrency("")).toBe("USD");
    expect(cleanCurrency("pen")).toBe("PEN");
    expect(cleanCurrency("S/")).toBe("PEN");
    expect(cleanCurrency("US$")).toBe("USD");
    expect(cleanCurrency("EUR")).toBeNull();
    expect(cleanCost({ kind: "envio", amount: "5", currency: "EUR" }, [])).toEqual({ error: "Moneda inválida: US$ o S/." });
    expect(cleanPayment({ amount: "5", currency: "CNY", paidOn: "2026-11-01", method: "otro" }, [])).toEqual({ error: "Moneda inválida: US$ o S/." });
  });

  it("un pago en soles se guarda en soles, sin convertir", () => {
    expect(cleanPayment({ amount: "504.16", currency: "PEN", paidOn: "2026-11-14", method: "transferencia" }, [])).toEqual({
      value: { currency: "PEN", amount_usd: null, amount_pen: 504.16, paid_on: "2026-11-14", method: "transferencia", note: null, document_id: null },
    });
  });
});

describe("«Pagado / Falta pagar» sin mezclar monedas", () => {
  it("con tipo de cambio: se compara en la base (USD), con su equivalente en soles", () => {
    const b = paymentBalance({ usd: 1055, pen: 0 }, { usd: 500, pen: 375 }, 3.75);
    close(b.paidUsd, 600);
    close(b.pendingUsd, 455);
    close(b.totalPen, 3956.25);
    close(b.paidPen, 2250);
    close(b.pendingPen, 1706.25);
    expect(b.needsFx).toBe(false);
  });

  it("sin tipo de cambio y con monedas mezcladas: cada moneda por separado, el saldo no se dice", () => {
    const b = paymentBalance({ usd: 1055, pen: 0 }, { usd: 500, pen: 375 }, null);
    expect(b.paidUsd).toBeNull();
    expect(b.pendingUsd).toBeNull();
    expect(b.pendingPen).toBeNull();
    expect(b.needsFx).toBe(true);
    expect(paymentBalance({ usd: 0, pen: 427.25 }, { usd: 100, pen: 0 }, null).needsFx).toBe(true);
  });

  it("sin tipo de cambio pero todo en una moneda: el saldo en esa moneda", () => {
    const pen = paymentBalance({ usd: 0, pen: 427.25 }, { usd: 0, pen: 400 }, null);
    close(pen.pendingPen, 27.25);
    expect(pen.pendingUsd).toBeNull();
    expect(pen.needsFx).toBe(false);
    const usd = paymentBalance({ usd: 1055, pen: 0 }, { usd: 1000, pen: 0 }, null);
    close(usd.pendingUsd, 55);
    expect(usd.pendingPen).toBeNull();
  });

  it("pagado de más o menos de medio centavo: nada pendiente, tampoco en soles", () => {
    const more = paymentBalance({ usd: 100, pen: 0 }, { usd: 0, pen: 400 }, 3.75);
    expect(more.pendingUsd).toBe(0);
    expect(more.pendingPen).toBe(0);
    const tiny = paymentBalance({ usd: 100, pen: 0 }, { usd: 99.996, pen: 0 }, 3.75);
    expect(tiny.pendingUsd).toBe(0);
    expect(tiny.pendingPen).toBe(0);
  });

  it("los pagos se suman por moneda; sin moneda, USD", () => {
    expect(paidSplit([{ amount: 10 }, { amount: 5, currency: "PEN" }, { amount: 2.5, currency: "USD" }])).toEqual({ usd: 12.5, pen: 5 });
  });

  it("el resumen de la importación: pagos en dólares y en soles contra costos en las dos monedas", () => {
    const landed = landedCosts([X, Y], MIXED, 3.75);
    const s = moneySummary(landed, [], [{ amount: 500 }, { amount: 427.25, currency: "PEN" }]);
    close(s.totalUsd, 920 + 427.25 / 3.75);
    close(s.paidUsd, 500 + 427.25 / 3.75);
    close(s.pendingUsd, 420);
    close(s.pendingPen, 420 * 3.75);
  });
});

describe("«Leer con IA»: la moneda de cada cargo y el IGV aparte", () => {
  // La factura de DHL Express Perú, como la devuelve la herramienta.
  const DHL_AI = {
    currency: "PEN",
    igv: 76.91,
    igv_currency: null,
    lines: [],
    charges: [
      { kind: "importacion", label: "Gastos de nacionalización", amount: 37.6, currency: "PEN" },
      { kind: "importacion", label: "Aforo físico", amount: 114.5, currency: null },
      { kind: "importacion", label: "Rectificación de la declaración aduanera", amount: "189.70", currency: "S/" },
      { kind: "importacion", label: "Cargo por aranceles e impuestos pagados", amount: 85.45, currency: "PEN" },
    ],
  };

  it("los cargos quedan en soles y el IGV es un dato aparte, no un cargo", () => {
    const p = parseAiProposal(DHL_AI)!;
    expect(p.currency).toBe("PEN");
    expect(p.charges.map((c) => c.currency)).toEqual(["PEN", "PEN", "PEN", "PEN"]);
    close(p.charges.reduce((a, c) => a + c.amount, 0), 427.25, 10);
    expect(p.igv).toEqual({ amount: 76.91, currency: "PEN" });
    expect(p.charges.some((c) => c.amount === 76.91 || /igv/i.test(c.label))).toBe(false);
  });

  it("monedas que dice el modelo", () => {
    expect(isoCurrency("S/")).toBe("PEN");
    expect(isoCurrency("s/.")).toBe("PEN");
    expect(isoCurrency("soles")).toBe("PEN");
    expect(isoCurrency("US$")).toBe("USD");
    expect(isoCurrency("cny")).toBe("CNY");
    expect(isoCurrency("dólares")).toBeNull();
    expect(parseAiProposal({ currency: "CNY", charges: [{ kind: "envio", amount: 20, currency: "USD" }] })!.charges[0]!.currency).toBe("USD");
    // Sin IGV (o en 0): null.
    expect(parseAiProposal({ currency: "USD", igv: 0 })!.igv).toBeNull();
  });

  it("al agregar: los cargos en soles se guardan en soles, sin pedir tipo de cambio", () => {
    const p = parseAiProposal(DHL_AI)!;
    const input: AiConfirmInput = {
      currency: "PEN",
      fx: "",
      lines: [],
      charges: p.charges.map((c) => ({ kind: c.kind, label: c.label, amount: String(c.amount), currency: c.currency, allocation: "value" })),
    };
    const r = aiConfirmToInputs(input, true);
    if ("error" in r) throw new Error(r.error);
    expect(r.fx).toBeNull();
    expect(r.costs.map((c) => [c.currency, c.amount])).toEqual([
      ["PEN", "37.6"],
      ["PEN", "114.5"],
      ["PEN", "189.7"],
      ["PEN", "85.45"],
    ]);
    const cleaned = r.costs.map((c) => cleanCost(c, []));
    expect(cleaned.every((c) => "value" in c && c.value.currency === "PEN" && c.value.amount_usd === null && !c.value.includes_igv)).toBe(true);
    // El IGV no entra aunque el navegador lo mande.
    const withIgv = aiConfirmToInputs({ ...input, igv: 76.91 } as AiConfirmInput, true);
    expect("costs" in withIgv && withIgv.costs).toHaveLength(4);
  });

  it("una proforma en CNY: los precios pasan a USD; un cargo en USD queda en USD; uno en CNY, ÷ X", () => {
    const r = aiConfirmToInputs(
      {
        currency: "CNY",
        fx: "7.1",
        lines: [{ name: "A", qty: "10", unitPrice: "14.2" }],
        charges: [
          { kind: "envio", label: "Flete", amount: "142.5", currency: "", allocation: "weight" },
          { kind: "envio", label: "Courier", amount: "20", currency: "USD", allocation: "units" },
          { kind: "importacion", label: "Agente", amount: "150", currency: "PEN", allocation: "value" },
        ],
      },
      true,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.items[0]!.unitCostUsd).toBe("2");
    expect(r.costs.map((c) => [c.label, c.currency, c.amount])).toEqual([
      ["Flete", "USD", "20.07"],
      ["Courier", "USD", "20"],
      ["Agente", "PEN", "150"],
    ]);
  });

  it("el tipo de cambio del documento se pide solo si algo lo necesita", () => {
    expect(aiChargeNeedsFx("PEN")).toBe(false);
    expect(aiChargeNeedsFx("USD")).toBe(false);
    expect(aiChargeNeedsFx("CNY")).toBe(true);
    // CNY con un cargo en soles y sin precios: no hace falta.
    expect(aiConfirmToInputs({ currency: "CNY", charges: [{ kind: "envio", amount: "50", currency: "PEN" }] }, true)).toMatchObject({ fx: null });
    // CNY con un cargo en CNY: sí.
    expect(aiConfirmToInputs({ currency: "CNY", charges: [{ kind: "envio", amount: "50" }] }, true)).toEqual({ error: "Escribe el tipo de cambio: 1 USD = X CNY." });
    // Un documento en soles con precios: los precios pasan a USD y piden «1 USD = X PEN».
    expect(aiConfirmToInputs({ currency: "PEN", lines: [{ name: "A", qty: "1", unitPrice: "37.5" }] }, true)).toEqual({ error: "Escribe el tipo de cambio: 1 USD = X PEN." });
    // Una moneda que no es USD, soles ni la del documento: error.
    expect(aiConfirmToInputs({ currency: "CNY", fx: "7", charges: [{ kind: "envio", amount: "5", currency: "EUR" }] }, true)).toEqual({
      error: "Cargo 1: la moneda es US$, S/ o la del documento (CNY).",
    });
  });
});

describe("reportes con montos en soles (MOM §45.8)", () => {
  const SKU = { sku: "SKU-X", storeId: "store-1", name: "Producto X" };
  const imp = (p: Partial<ReportImport> & Pick<ReportImport, "id" | "status">): ReportImport => ({
    code: `IMP-2026-${p.id}`,
    supplierId: "sup-1",
    orderedOn: null,
    createdAt: "2026-11-01T15:00:00Z",
    eta: null,
    arrivedOn: null,
    fxPenPerUsd: null,
    items: [],
    costs: [],
    payments: [],
    ...p,
  });
  const item = { ...SKU, qty: 10, unitCostUsd: 10, unitWeightKg: null, receivedQty: null, damagedQty: null };
  const IMPORTS: ReportImport[] = [
    // J1: con tipo de cambio: 100 USD del proveedor + S/ 375 (= 100 USD), pagada en las dos monedas.
    imp({
      id: "101",
      status: "en_aduana",
      orderedOn: "2026-11-01",
      fxPenPerUsd: 3.75,
      items: [{ id: "j1", ...item }],
      costs: [{ kind: "importacion", label: "Aduana", amount: 375, currency: "PEN", allocation: "value" }],
      payments: [
        { amount: 100, currency: "USD", paidOn: "2026-11-02" },
        { amount: 375, currency: "PEN", paidOn: "2026-11-03" },
      ],
    }),
    // J2: costos en soles SIN tipo de cambio.
    imp({
      id: "102",
      status: "en_transito",
      orderedOn: "2026-11-05",
      items: [{ id: "j2", ...item }],
      costs: [{ kind: "importacion", label: "DHL", amount: 427.25, currency: "PEN", allocation: "value" }],
      payments: [
        { amount: 50, currency: "USD", paidOn: "2026-11-06" },
        { amount: 100, currency: "PEN", paidOn: "2026-11-07" },
      ],
    }),
  ];

  it("«Comprado»: en USD las que se pueden convertir; las demás se cuentan aparte", () => {
    const s = supplierStats("sup-1", IMPORTS, { money: true });
    close(s.boughtUsd, 200);
    expect(s.boughtUsdWithoutFx).toBe(1);
    // En soles: 100 × 3,75 + 375 tal cual.
    close(s.boughtPen, 750);
    expect(s.boughtWithoutFx).toBe(1);
  });

  it("dinero en camino: costo, pagado y lo que falta de las que se pueden convertir", () => {
    const t = moneyInTransit(IMPORTS);
    expect(t.imports).toBe(2);
    close(t.totalUsd, 200);
    close(t.paidUsd, 200);
    close(t.pendingUsd, 0);
    expect(t.usdWithoutFx).toBe(1);
    close(t.totalPen, 750);
    expect(t.withoutFx).toBe(1);
  });

  it("por mes: los pagos en soles ÷ el tipo de cambio de su importación; sin él, fuera de los USD", () => {
    const nov = monthlySpend(IMPORTS, "2026-11-14", 1)[0]!;
    close(nov.boughtUsd, 200);
    expect(nov.boughtUsdWithoutFx).toBe(1);
    close(nov.boughtPen, 750);
    // 100 + 375 ÷ 3,75 + 50 (J2 en USD); los S/ 100 de J2 no tienen con qué convertirse.
    close(nov.paidUsd, 250);
    expect(nov.paidUsdWithoutFx).toBe(1);
    // 100 × 3,75 + 375 + S/ 100 de J2 tal cual (sus 50 USD no tienen con qué convertirse).
    close(nov.paidPen, 850);
  });

  it("costo por unidad: en soles exacto; sin tipo de cambio, sin cifra ni cambio", () => {
    const [p] = unitCostHistory(IMPORTS);
    expect(p!.points.map((pt) => pt.code)).toEqual(["IMP-2026-101", "IMP-2026-102"]);
    close(p!.points[0]!.unitCostUsd, 20);
    expect(p!.points[0]!.unitCostPen).toBe(75);
    expect(p!.last.unitCostUsd).toBeNull();
    expect(p!.last.unitCostPen).toBeNull();
    expect(p!.change).toBeNull();
  });

  it("cuántas importaciones no entran en los USD por falta del tipo de cambio", () => {
    expect(needsFxForUsd(IMPORTS[0]!)).toBe(false);
    expect(needsFxForUsd(IMPORTS[1]!)).toBe(true);
    expect(importsMissingFxForUsd(IMPORTS)).toBe(1);
    // Una cancelada no cuenta.
    expect(importsMissingFxForUsd([{ ...IMPORTS[1]!, status: "cancelado" }])).toBe(0);
  });
});
